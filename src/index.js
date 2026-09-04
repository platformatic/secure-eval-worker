import { Worker } from 'node:worker_threads'

const DEFAULT_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 2_147_483_647
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024
const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 16,
  stackSizeMb: 4
})

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_ENVIRONMENT_NAME = /^(?:(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|OPENSSL_CONF|SSLKEYLOGFILE|NPM_CONFIG_USERCONFIG)$|LD_|DYLD_)/i

// This source is intentionally static. Untrusted values enter through the
// structured-clone algorithm in workerData, never through string interpolation.
const WORKER_BOOTSTRAP = String.raw`
'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { randomUUID } = require('node:crypto')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const postMessage = parentPort.postMessage.bind(parentPort)
const token = randomUUID()

function send(type, value) {
  postMessage({ token, type, value })
}

async function main() {
  if (typeof process.permission?.drop !== 'function') {
    throw new Error('process.permission.drop() is unavailable')
  }
  if (!process.permission.has('worker')) {
    throw new Error('The worker permission was not granted to the bootstrap')
  }

  // Drop before compiling or invoking any caller-controlled source. The drop is
  // irreversible and local to this worker, so the parent can create more jobs.
  process.permission.drop('worker')
  if (process.permission.has('worker')) {
    throw new Error('Failed to drop the worker permission')
  }

  send('ready')

  let execute
  try {
    execute = new AsyncFunction('input', '"use strict";\n' + workerData.source)
  } catch (error) {
    send('error', cloneError(error))
    return
  }

  try {
    const result = await execute(workerData.input)
    try {
      send('result', result)
    } catch {
      send('error', {
        name: 'DataCloneError',
        message: 'The result could not be cloned'
      })
    }
  } catch (error) {
    send('error', cloneError(error))
  }
}

function cloneError(error) {
  if (error instanceof Error) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : 'Untrusted code threw an error',
      stack: typeof error.stack === 'string' ? error.stack : undefined,
      code: typeof error.code === 'string' ? error.code : undefined
    }
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error }
  }

  return { name: 'Error', message: 'Untrusted code threw a non-Error value' }
}

main().catch((error) => {
  send('bootstrap-error', cloneError(error))
})
`

export class UntrustedCodeError extends Error {
  constructor (message, options = {}) {
    super(message, options)
    this.name = 'UntrustedCodeError'
    this.code = options.code ?? 'ERR_UNTRUSTED_CODE'
    if (options.remoteStack) this.remoteStack = options.remoteStack
    if (options.remoteCode) this.remoteCode = options.remoteCode
  }
}

/**
 * Return a null-prototype copy suitable for WorkerOptions.env.
 * Runtime-control variables are rejected rather than silently passed through.
 */
export function sanitizeEnvironment (environment = {}) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('environment must be an object')
  }

  const sanitized = Object.create(null)
  for (const [name, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new TypeError(`Invalid environment variable name: ${name}`)
    }
    if (BLOCKED_ENVIRONMENT_NAME.test(name)) {
      throw new TypeError(`Environment variable is not allowed: ${name}`)
    }
    if (typeof value !== 'string') {
      throw new TypeError(`Environment variable ${name} must be a string`)
    }
    sanitized[name] = value
  }
  return sanitized
}

/**
 * Execute an async function body in a fresh, least-privilege worker.
 *
 * The source receives one argument named `input`; its return value must be
 * structured-cloneable. Node's Permission Model is defense in depth, not a
 * complete security boundary for hostile code.
 */
export function runUntrustedCode (source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  validatePositiveInteger(timeoutMs, 'timeoutMs')
  validatePositiveInteger(maxSourceBytes, 'maxSourceBytes')

  if (Buffer.byteLength(source, 'utf8') > maxSourceBytes) {
    throw new RangeError(`source exceeds maxSourceBytes (${maxSourceBytes})`)
  }

  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
  }

  const env = sanitizeEnvironment(options.environment)
  const resourceLimits = validateResourceLimits(options.resourceLimits)
  const signal = options.signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal')
  }
  if (signal?.aborted) {
    return Promise.reject(abortError(signal.reason))
  }

  // Clone once in the trusted thread so shared memory can be rejected before
  // the worker receives it. This synchronous operation cannot be preempted.
  const deadline = Date.now() + timeoutMs
  const input = structuredClone(options.input)
  assertNoSharedMemory(input, 'input')
  if (signal?.aborted) return Promise.reject(abortError(signal.reason))
  if (Date.now() >= deadline) return Promise.reject(timeoutError(timeoutMs))

  return new Promise((resolve, reject) => {
    let settled = false
    let handshakeToken
    let ready = false
    let worker
    let timer
    let abortRequested = false

    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      worker?.removeAllListeners()
      if (worker) void worker.terminate()
      callback(value)
    }

    const fail = (error) => settle(reject, error)
    const onAbort = () => {
      if (!worker) {
        abortRequested = true
        return
      }
      fail(abortError(signal.reason))
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        env,
        execArgv: [
          '--permission',
          '--allow-worker',
          '--disable-warning=PERM0006'
        ],
        resourceLimits,
        workerData: { source, input },
        name: 'secure-eval-worker',
        stdout: true,
        stderr: true
      })
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
      return
    }

    // Never forward attacker-controlled output into host logs. Draining avoids
    // allowing the worker to block on a full stdio pipe.
    worker.stdout.resume()
    worker.stderr.resume()

    if (abortRequested || signal?.aborted) {
      fail(abortError(signal?.reason))
      return
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      fail(timeoutError(timeoutMs))
      return
    }
    timer = setTimeout(() => fail(timeoutError(timeoutMs)), remainingMs)

    worker.on('message', (message) => {
      if (!ready) {
        if (isProtocolMessage(message) && message.type === 'bootstrap-error') {
          fail(remoteError(message.value, 'ERR_UNTRUSTED_CODE_BOOTSTRAP'))
          return
        }
        if (!isProtocolMessage(message) || message.type !== 'ready') {
          fail(protocolError())
          return
        }
        handshakeToken = message.token
        ready = true
        return
      }

      if (!isProtocolMessage(message) || message.token !== handshakeToken) {
        fail(protocolError())
        return
      }

      if (message.type === 'result') {
        try {
          assertNoSharedMemory(message.value, 'result')
        } catch (error) {
          fail(error)
          return
        }
        settle(resolve, message.value)
      } else if (message.type === 'error') {
        fail(remoteError(message.value))
      } else if (message.type === 'bootstrap-error') {
        fail(remoteError(message.value, 'ERR_UNTRUSTED_CODE_BOOTSTRAP'))
      } else {
        fail(protocolError())
      }
    })

    worker.once('error', (error) => {
      fail(new UntrustedCodeError('The worker failed', {
        cause: error,
        code: 'ERR_UNTRUSTED_CODE_WORKER'
      }))
    })

    worker.once('exit', (code) => {
      if (!settled) {
        fail(new UntrustedCodeError(`The worker exited before returning a result (code ${code})`, {
          code: 'ERR_UNTRUSTED_CODE_EXIT'
        }))
      }
    })
  })
}

function isProtocolMessage (message) {
  return message !== null &&
    typeof message === 'object' &&
    typeof message.token === 'string' &&
    typeof message.type === 'string'
}

function remoteError (detail, code = 'ERR_UNTRUSTED_CODE') {
  const name = detail && typeof detail.name === 'string' ? detail.name : 'Error'
  const message = detail && typeof detail.message === 'string'
    ? detail.message
    : 'Untrusted code failed'
  return new UntrustedCodeError(`${name}: ${message}`, {
    code,
    remoteStack: detail && typeof detail.stack === 'string' ? detail.stack : undefined,
    remoteCode: detail && typeof detail.code === 'string' ? detail.code : undefined
  })
}

function protocolError () {
  return new UntrustedCodeError('The worker sent an invalid protocol message', {
    code: 'ERR_UNTRUSTED_CODE_PROTOCOL'
  })
}

function abortError (reason) {
  const error = new Error('Execution was aborted', { cause: reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function timeoutError (timeoutMs) {
  return new UntrustedCodeError(`Execution exceeded ${timeoutMs} ms`, {
    code: 'ERR_UNTRUSTED_CODE_TIMEOUT'
  })
}

function assertNoSharedMemory (value, label) {
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} must not contain shared memory`)
  }
  if (value === null || typeof value !== 'object') return

  const pending = [value]
  const seen = new WeakSet()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)

    if (typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer) {
      throw new TypeError(`${label} must not contain shared memory`)
    }
    if (current instanceof WebAssembly.Memory) {
      pending.push(current.buffer)
    } else if (ArrayBuffer.isView(current)) {
      pending.push(current.buffer)
    } else if (current instanceof Map) {
      for (const [key, entry] of current) pending.push(key, entry)
    } else if (current instanceof Set) {
      for (const entry of current) pending.push(entry)
    } else {
      for (const key of Reflect.ownKeys(current)) pending.push(current[key])
    }
  }
}

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function validateResourceLimits (limits) {
  if (limits === undefined) return { ...DEFAULT_RESOURCE_LIMITS }
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('resourceLimits must be an object')
  }

  const result = { ...DEFAULT_RESOURCE_LIMITS }
  for (const name of Object.keys(DEFAULT_RESOURCE_LIMITS)) {
    if (limits[name] !== undefined) {
      if (typeof limits[name] !== 'number' || !Number.isFinite(limits[name]) || limits[name] <= 0) {
        throw new RangeError(`resourceLimits.${name} must be a positive number`)
      }
      result[name] = limits[name]
    }
  }
  return result
}
