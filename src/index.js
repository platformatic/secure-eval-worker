import { Worker } from 'node:worker_threads'

import {
  abortError,
  assertNoSharedMemory,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_TIMEOUT_MS,
  remoteError,
  sanitizeEnvironment,
  UntrustedCodeError,
  validatePositiveInteger,
  validateResourceLimits
} from './internal.js'

export { getHostFunctionContext } from './host-functions.js'
export { sanitizeEnvironment, UntrustedCodeError } from './internal.js'
export { createUntrustedWorker, UntrustedWorkerSession } from './session.js'

const DEFAULT_TIMEOUT_MS = 1_000

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

function protocolError () {
  return new UntrustedCodeError('The worker sent an invalid protocol message', {
    code: 'ERR_UNTRUSTED_CODE_PROTOCOL'
  })
}

function timeoutError (timeoutMs) {
  return new UntrustedCodeError(`Execution exceeded ${timeoutMs} ms`, {
    code: 'ERR_UNTRUSTED_CODE_TIMEOUT'
  })
}
