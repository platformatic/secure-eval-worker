import {
  abortError,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_TIMEOUT_MS,
  sanitizeEnvironment,
  UntrustedCodeError,
  validatePositiveInteger,
  validateResourceLimits
} from './internal.js'
import { validateHostFunctions } from './host-functions.js'
import { createUntrustedOneShot } from './session.js'

export { configureWorkerAdmission } from './admission.js'
export { getHostFunctionContext, HostFunctionError } from './host-functions.js'
export { sanitizeEnvironment, UntrustedCodeError } from './internal.js'
export { createUntrustedWorker, UntrustedWorkerSession } from './session.js'

const DEFAULT_TIMEOUT_MS = 1_000
const RUNNER_DEFAULT_NAMES = new Set([
  'timeoutMs',
  'maxSourceBytes',
  'environment',
  'resourceLimits',
  'maxMessageBytes',
  'maxInputBytes',
  'maxOutputMessages',
  'maxOutputBytes',
  'hostFunctions',
  'maxHostFunctionCalls',
  'maxInFlightHostFunctions',
  'language',
  'diagnostics',
  'onDiagnostic'
])

/**
 * Create a callable with snapshotted defaults for one-shot execution.
 */
export function createRunner (defaultOptions = {}) {
  const defaults = snapshotRunnerDefaults(defaultOptions)
  return function runWithDefaults (source, options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object')
    }
    const overrides = snapshotPublicOptions(options, 'options')
    return runUntrustedCode(source, { ...defaults, ...overrides })
  }
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
  options = snapshotPublicOptions(options, 'options')

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
      language: options.language,
      environment,
      resourceLimits,
      signal,
      maxSourceBytes,
      maxMessageBytes: options.maxMessageBytes,
      maxInputBytes: options.maxInputBytes,
      maxOutputMessages: options.maxOutputMessages,
      maxOutputBytes: options.maxOutputBytes,
      hostFunctions: options.hostFunctions,
      maxHostFunctionCalls: options.maxHostFunctionCalls,
      maxInFlightHostFunctions: options.maxInFlightHostFunctions,
      diagnostics: options.diagnostics,
      onDiagnostic: options.onDiagnostic,
      startupTimeoutMs: timeoutMs,
      messageTimeoutMs: timeoutMs,
      lifetimeTimeoutMs: timeoutMs
    })
  } catch (error) {
    if (error?.name === 'AbortError' ||
        error?.code === 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT' ||
        error?.code === 'ERR_UNTRUSTED_WORKER_CAPACITY' ||
        error?.code === 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE') {
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

function snapshotPublicOptions (options, label) {
  const keys = Reflect.ownKeys(options)
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${label} must not contain symbol properties`)
  }
  const snapshot = Object.create(null)
  const descriptors = Object.getOwnPropertyDescriptors(options)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`)
    }
    snapshot[key] = descriptor.value
  }
  return snapshot
}

function snapshotRunnerDefaults (options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('runner defaults must be an object')
  }
  const keys = Reflect.ownKeys(options)
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError('runner defaults must not contain symbol properties')
  }

  const snapshot = Object.create(null)
  const descriptors = Object.getOwnPropertyDescriptors(options)
  for (const key of keys) {
    if (key === 'input' || key === 'signal') {
      throw new TypeError(`${key} must be supplied per run`)
    }
    if (!RUNNER_DEFAULT_NAMES.has(key)) {
      throw new TypeError(`Unknown runner default: ${key}`)
    }
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Runner default ${key} must be an enumerable data property`)
    }
    snapshot[key] = descriptor.value
  }

  if ('language' in snapshot &&
      snapshot.language !== 'javascript' && snapshot.language !== 'typescript') {
    throw new TypeError("language must be 'javascript' or 'typescript'")
  }
  if ('timeoutMs' in snapshot) {
    validatePositiveInteger(snapshot.timeoutMs, 'timeoutMs')
    if (snapshot.timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
    }
  }
  for (const name of [
    'maxSourceBytes',
    'maxMessageBytes',
    'maxInputBytes',
    'maxOutputMessages',
    'maxOutputBytes',
    'maxHostFunctionCalls',
    'maxInFlightHostFunctions'
  ]) {
    if (name in snapshot) validatePositiveInteger(snapshot[name], name)
  }
  if ('maxMessageBytes' in snapshot && snapshot.maxMessageBytes < 128) {
    throw new RangeError('maxMessageBytes must be at least 128')
  }
  if ('environment' in snapshot) snapshot.environment = sanitizeEnvironment(snapshot.environment)
  if ('resourceLimits' in snapshot) snapshot.resourceLimits = validateResourceLimits(snapshot.resourceLimits)
  if ('hostFunctions' in snapshot) {
    validateHostFunctions(snapshot.hostFunctions)
    snapshot.hostFunctions = snapshotHostFunctions(snapshot.hostFunctions)
  }
  if ('onDiagnostic' in snapshot && typeof snapshot.onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function')
  }
  if ('diagnostics' in snapshot && snapshot.diagnostics !== true && snapshot.diagnostics !== false) {
    if (snapshot.diagnostics === null || typeof snapshot.diagnostics !== 'object' ||
        Array.isArray(snapshot.diagnostics)) {
      throw new TypeError('diagnostics must be a boolean or an options object')
    }
    const diagnostics = Object.create(null)
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(snapshot.diagnostics)
    )) {
      if (!['maxRecords', 'maxBytes', 'maxRecordBytes'].includes(name)) {
        throw new TypeError(`Unknown diagnostics option: ${name}`)
      }
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`diagnostics.${name} must be an enumerable data property`)
      }
      validatePositiveInteger(descriptor.value, `diagnostics.${name}`)
      diagnostics[name] = descriptor.value
    }
    if (Reflect.ownKeys(snapshot.diagnostics).some((key) => typeof key === 'symbol')) {
      throw new TypeError('diagnostics must not contain symbol properties')
    }
    const maxBytes = diagnostics.maxBytes ?? 64 * 1024
    const maxRecordBytes = diagnostics.maxRecordBytes ?? 4 * 1024
    if (maxRecordBytes > maxBytes) {
      throw new RangeError('diagnostics.maxRecordBytes must not exceed diagnostics.maxBytes')
    }
    snapshot.diagnostics = Object.freeze(diagnostics)
  }
  if (snapshot.diagnostics === false && 'onDiagnostic' in snapshot) {
    throw new TypeError('onDiagnostic cannot be used when diagnostics is false')
  }

  return Object.freeze(snapshot)
}

function snapshotHostFunctions (hostFunctions) {
  const snapshot = Object.create(null)
  for (const [namespace, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(hostFunctions))) {
    const group = Object.create(null)
    for (const [name, functionDescriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(descriptor.value)
    )) {
      Object.defineProperty(group, name, {
        value: functionDescriptor.value,
        enumerable: true
      })
    }
    Object.freeze(group)
    Object.defineProperty(snapshot, namespace, {
      value: group,
      enumerable: true
    })
  }
  return Object.freeze(snapshot)
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
    ERR_UNTRUSTED_WORKER_CAPACITY: [
      error.message,
      'ERR_UNTRUSTED_CODE_CAPACITY'
    ],
    ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE: [
      error.message,
      'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE'
    ],
    ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT: [
      error.message,
      'ERR_UNTRUSTED_CODE_HOST_FUNCTION_LIMIT'
    ],
    ERR_UNTRUSTED_WORKER_DIAGNOSTIC_CALLBACK: [
      error.message,
      'ERR_UNTRUSTED_CODE_DIAGNOSTIC_CALLBACK'
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
