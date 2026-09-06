import {
  abortError,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_TIMEOUT_MS,
  sanitizeEnvironment,
  UntrustedCodeError,
  validatePositiveInteger,
  validateResourceLimits
} from './internal.js'
import { createUntrustedOneShot } from './session.js'

export { getHostFunctionContext, HostFunctionError } from './host-functions.js'
export { sanitizeEnvironment, UntrustedCodeError } from './internal.js'
export { createUntrustedWorker, UntrustedWorkerSession } from './session.js'

const DEFAULT_TIMEOUT_MS = 1_000

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
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
  }
  if (Buffer.byteLength(source, 'utf8') > maxSourceBytes) {
    throw new RangeError(`source exceeds maxSourceBytes (${maxSourceBytes})`)
  }

  // Normalize these here to preserve synchronous option errors without
  // evaluating caller-controlled properties twice.
  const environment = sanitizeEnvironment(options.environment)
  const resourceLimits = validateResourceLimits(options.resourceLimits)
  const signal = options.signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal')
  }
  if (signal?.aborted) return Promise.reject(abortError(signal.reason))

  let session
  try {
    session = createUntrustedOneShot(source, {
      input: options.input,
      environment,
      resourceLimits,
      signal,
      maxSourceBytes,
      maxMessageBytes: options.maxMessageBytes,
      maxInputBytes: options.maxInputBytes,
      maxOutputMessages: options.maxOutputMessages,
      maxOutputBytes: options.maxOutputBytes,
      startupTimeoutMs: timeoutMs,
      messageTimeoutMs: timeoutMs,
      lifetimeTimeoutMs: timeoutMs
    })
  } catch (error) {
    if (error?.name === 'AbortError' ||
        error?.code === 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT') {
      return Promise.reject(translateSessionError(error, timeoutMs))
    }
    throw error
  }

  return session.ready
    .catch((error) => {
      throw translateSessionError(error, timeoutMs)
    })
    .finally(async () => {
      try {
        await session.terminate()
      } catch {}
    })
}

function translateSessionError (error, timeoutMs) {
  if (error?.name === 'AbortError') return error

  const codes = {
    ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT: [
      `Execution exceeded ${timeoutMs} ms`,
      'ERR_UNTRUSTED_CODE_TIMEOUT'
    ],
    ERR_UNTRUSTED_WORKER_LIFETIME_TIMEOUT: [
      `Execution exceeded ${timeoutMs} ms`,
      'ERR_UNTRUSTED_CODE_TIMEOUT'
    ],
    ERR_UNTRUSTED_WORKER_PROTOCOL: [
      'The worker sent an invalid protocol message',
      'ERR_UNTRUSTED_CODE_PROTOCOL'
    ],
    ERR_UNTRUSTED_WORKER_EXIT: [
      error.message.replace('The worker exited unexpectedly', 'The worker exited before returning a result'),
      'ERR_UNTRUSTED_CODE_EXIT'
    ],
    ERR_UNTRUSTED_WORKER: ['The worker failed', 'ERR_UNTRUSTED_CODE_WORKER']
  }
  const translated = codes[error?.code]
  if (translated) {
    return new UntrustedCodeError(translated[0], {
      cause: error,
      code: translated[1],
      remoteCode: error.remoteCode,
      remoteStack: error.remoteStack
    })
  }
  if (error instanceof UntrustedCodeError) {
    return new UntrustedCodeError(error.message, {
      cause: error,
      code: 'ERR_UNTRUSTED_CODE',
      remoteCode: error.remoteCode,
      remoteStack: error.remoteStack
    })
  }
  return error
}
