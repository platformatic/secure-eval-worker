import {
  abortError,
  assertSupportedProtocolValue,
  cloneWithoutSharedMemory,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_TIMEOUT_MS,
  sanitizeEnvironment,
  UntrustedCodeError,
  validatePositiveInteger,
  validateResourceLimits
} from './internal.js'
import { acquireFilePreparationSlot, acquireWorkerSlot } from './admission.js'
import { validateHostFunctions } from './host-functions.js'
import { resolveLocalModule } from './local-files.js'
import { createUntrustedFileSession, createUntrustedOneShot } from './session.js'

export { configureWorkerAdmission } from './admission.js'
export { getHostFunctionContext, HostFunctionError } from './host-functions.js'
export { sanitizeEnvironment, UntrustedCodeError } from './internal.js'
export { createUntrustedWorker, UntrustedWorkerSession } from './session.js'

const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_MAX_ROOT_ENTRIES = 10_000
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024
const eventTargetAddEventListener = EventTarget.prototype.addEventListener
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const abortSignalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
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

  return runOneShot(options, timeoutMs, timeoutMs, (sessionOptions) => {
    return createUntrustedOneShot(source, { ...sessionOptions, maxSourceBytes })
  })
}

/**
 * Execute a local ESM entry module and its imports in a fresh worker. The
 * module must default-export a function receiving the one-shot input.
 */
export async function runUntrustedFile (modulePath, options = {}) {
  const startedAt = Date.now()
  options = snapshotFileOptions(options, 'options')
  snapshotFilePolicies(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  validatePositiveInteger(timeoutMs, 'timeoutMs')
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
  }
  const signal = validateSignal(options.signal)
  if (signal && Reflect.apply(abortSignalAborted, signal, [])) {
    throw abortError(Reflect.apply(abortSignalReason, signal, []))
  }

  let releaseWorkerSlot
  try {
    releaseWorkerSlot = acquireWorkerSlot()
  } catch (error) {
    throw translateSessionError(error, timeoutMs)
  }

  let releasePreparationSlot
  try {
    releasePreparationSlot = acquireFilePreparationSlot()
  } catch (error) {
    releaseWorkerSlot()
    throw translateSessionError(error, timeoutMs)
  }

  const localModule = await prepareLocalModule(
    modulePath,
    options,
    timeoutMs - (Date.now() - startedAt),
    new UntrustedCodeError(`Execution exceeded ${timeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_CODE_TIMEOUT'
    }),
    releaseWorkerSlot,
    releasePreparationSlot
  )

  const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt)
  if (remainingTimeoutMs <= 0) {
    releaseWorkerSlot()
    const timeoutError = new UntrustedCodeError(`Execution exceeded ${timeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_CODE_TIMEOUT'
    })
    await cleanupLocalModule(localModule, releasePreparationSlot, timeoutError)
    throw timeoutError
  }
  delete options.rootDirectory
  delete options.maxRootEntries
  delete options.maxFileBytes
  delete options.maxTotalFileBytes
  options.timeoutMs = remainingTimeoutMs

  let transferred = false
  let primaryError
  try {
    return await runOneShot(options, remainingTimeoutMs, timeoutMs, (sessionOptions) => {
      const session = createUntrustedFileSession(
        localModule,
        sessionOptions,
        true,
        releaseWorkerSlot,
        releasePreparationSlot
      )
      transferred = true
      return session
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (!transferred) {
      releaseWorkerSlot()
      await cleanupLocalModule(localModule, releasePreparationSlot, primaryError)
    }
  }
}

/**
 * Create a persistent session from a local ESM entry module. The trusted root
 * is granted to Node's module loader and the constrained synchronous read
 * facade. File preparation is asynchronous, so this factory returns a promise
 * for the session.
 */
export async function createUntrustedWorkerFromFile (modulePath, options = {}) {
  const startedAt = Date.now()
  options = snapshotFileOptions(options, 'options')
  snapshotFilePolicies(options)
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS
  validatePositiveInteger(startupTimeoutMs, 'startupTimeoutMs')
  if (startupTimeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`startupTimeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
  }
  const signal = validateSignal(options.signal)
  if (signal && Reflect.apply(abortSignalAborted, signal, [])) {
    throw abortError(Reflect.apply(abortSignalReason, signal, []))
  }

  const releaseWorkerSlot = acquireWorkerSlot()
  let releasePreparationSlot
  try {
    releasePreparationSlot = acquireFilePreparationSlot()
  } catch (error) {
    releaseWorkerSlot()
    throw error
  }
  const localModule = await prepareLocalModule(
    modulePath,
    options,
    startupTimeoutMs - (Date.now() - startedAt),
    new UntrustedCodeError(`Startup exceeded ${startupTimeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
    }),
    releaseWorkerSlot,
    releasePreparationSlot
  )

  const remainingStartupMs = startupTimeoutMs - (Date.now() - startedAt)
  if (remainingStartupMs <= 0) {
    releaseWorkerSlot()
    const timeoutError = new UntrustedCodeError(`Startup exceeded ${startupTimeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
    })
    await cleanupLocalModule(localModule, releasePreparationSlot, timeoutError)
    throw timeoutError
  }
  delete options.rootDirectory
  delete options.maxRootEntries
  delete options.maxFileBytes
  delete options.maxTotalFileBytes
  options.startupTimeoutMs = remainingStartupMs
  try {
    return createUntrustedFileSession(
      localModule,
      options,
      false,
      releaseWorkerSlot,
      releasePreparationSlot
    )
  } catch (error) {
    releaseWorkerSlot()
    await cleanupLocalModule(localModule, releasePreparationSlot, error)
    throw error
  }
}

async function prepareLocalModule (
  modulePath,
  options,
  timeoutMs,
  timeoutError,
  releaseWorkerSlot,
  releasePreparationSlot
) {
  if (timeoutMs <= 0) {
    releaseWorkerSlot()
    releasePreparationSlot()
    throw timeoutError
  }

  const controller = new AbortController()
  const callerSignal = options.signal
  let rejectInterruption
  const interruption = new Promise((resolve, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (error) => {
    if (controller.signal.aborted) return
    controller.abort(error)
    rejectInterruption(error)
  }
  const onAbort = () => interrupt(abortError(
    Reflect.apply(abortSignalReason, callerSignal, [])
  ))
  if (callerSignal) {
    try {
      Reflect.apply(eventTargetAddEventListener, callerSignal, [
        'abort',
        onAbort,
        { once: true }
      ])
      if (Reflect.apply(abortSignalAborted, callerSignal, [])) onAbort()
    } catch (error) {
      releaseWorkerSlot()
      releasePreparationSlot()
      throw error
    }
  }
  const timer = setTimeout(() => interrupt(timeoutError), timeoutMs)

  const preparation = resolveLocalModule(
    modulePath,
    options.rootDirectory,
    {
      maxRootEntries: options.maxRootEntries,
      maxFileBytes: options.maxFileBytes,
      maxTotalFileBytes: options.maxTotalFileBytes
    },
    controller.signal
  ).then(async (localModule) => {
    if (controller.signal.aborted) {
      try {
        await localModule.cleanup()
      } catch (cleanupError) {
        const error = new UntrustedCodeError(
          'The private module snapshot could not be removed',
          { code: 'ERR_UNTRUSTED_MODULE_CLEANUP', cause: cleanupError }
        )
        Object.defineProperty(error, 'cleanupUntilRemoved', {
          value: localModule.cleanupUntilRemoved
        })
        throw error
      }
      throw controller.signal.reason
    }
    return localModule
  })
  // A filesystem request may settle after the public deadline. Preparation
  // can never continue into worker creation.
  void preparation.catch(() => {})

  try {
    return await Promise.race([preparation, interruption])
  } catch (error) {
    releaseWorkerSlot()
    if (controller.signal.aborted) {
      // Keep abandoned filesystem work independently bounded without starving
      // ordinary worker admission if an operating-system request never settles.
      void preparation.then(
        releasePreparationSlot,
        (preparationError) => releaseAfterPreparationError(
          preparationError,
          releasePreparationSlot
        )
      )
    } else {
      releaseAfterPreparationError(error, releasePreparationSlot)
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (callerSignal) {
      try {
        Reflect.apply(eventTargetRemoveEventListener, callerSignal, ['abort', onAbort])
      } catch {}
    }
  }
}

function releaseAfterPreparationError (error, releasePreparationSlot) {
  if (typeof error?.cleanupUntilRemoved === 'function') {
    void error.cleanupUntilRemoved().then(releasePreparationSlot, releasePreparationSlot)
  } else {
    releasePreparationSlot()
  }
}

async function cleanupLocalModule (localModule, releasePreparationSlot, primaryError) {
  try {
    await localModule.cleanup()
    releasePreparationSlot()
  } catch (cleanupError) {
    void localModule.cleanupUntilRemoved().then(
      releasePreparationSlot,
      releasePreparationSlot
    )
    throw new UntrustedCodeError(
      'The private module snapshot could not be removed',
      {
        code: 'ERR_UNTRUSTED_MODULE_CLEANUP',
        cause: primaryError
          ? new AggregateError([primaryError, cleanupError], 'Operation and cleanup failures')
          : cleanupError
      }
    )
  }
}

function runOneShot (options, timeoutMs, reportedTimeoutMs, createSession) {
  // Normalize these here to preserve synchronous source-API option errors and
  // avoid evaluating caller-controlled properties twice.
  const environment = sanitizeEnvironment(options.environment)
  const resourceLimits = validateResourceLimits(options.resourceLimits)
  const signal = validateSignal(options.signal)
  if (signal && Reflect.apply(abortSignalAborted, signal, [])) {
    return Promise.reject(abortError(Reflect.apply(abortSignalReason, signal, [])))
  }

  let session
  try {
    session = createSession({
      input: options.input,
      language: options.language,
      environment,
      resourceLimits,
      signal,
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
      return Promise.reject(translateSessionError(error, reportedTimeoutMs))
    }
    throw error
  }

  return session.ready
    .catch((error) => {
      throw translateSessionError(error, reportedTimeoutMs)
    })
    .finally(async () => {
      try {
        await session.terminate()
      } catch {}
      const closed = await session.closed
      if (closed.error?.code === 'ERR_UNTRUSTED_WORKER_CLEANUP') {
        throw translateSessionError(closed.error, reportedTimeoutMs)
      }
    })
}

function snapshotFilePolicies (options) {
  const policyInput = Object.create(null)
  for (const name of [
    'environment',
    'resourceLimits',
    'maxMessageBytes',
    'maxInputBytes',
    'maxOutputMessages',
    'maxOutputBytes',
    'hostFunctions',
    'maxHostFunctionCalls',
    'maxInFlightHostFunctions',
    'diagnostics',
    'onDiagnostic'
  ]) {
    if (name in options) policyInput[name] = options[name]
  }
  Object.assign(options, snapshotRunnerDefaults(policyInput))

  const input = cloneWithoutSharedMemory(options.input, 'input')
  assertSupportedProtocolValue(input, 'input')
  options.input = input

  for (const [name, defaultValue] of [
    ['maxRootEntries', DEFAULT_MAX_ROOT_ENTRIES],
    ['maxFileBytes', DEFAULT_MAX_FILE_BYTES],
    ['maxTotalFileBytes', DEFAULT_MAX_TOTAL_FILE_BYTES]
  ]) {
    const value = options[name] ?? defaultValue
    validatePositiveInteger(value, name)
    options[name] = value
  }
  if (options.maxFileBytes > options.maxTotalFileBytes) {
    throw new RangeError('maxFileBytes must not exceed maxTotalFileBytes')
  }
}

function validateSignal (signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal')
  }
  return signal
}

function snapshotFileOptions (options, label) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${label} must be an object`)
  }
  const snapshot = snapshotPublicOptions(options, label)
  for (const unsupported of ['language', 'maxSourceBytes', 'type']) {
    if (unsupported in snapshot) {
      throw new TypeError(`${unsupported} is not supported for local module files`)
    }
  }
  return snapshot
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
    ERR_UNTRUSTED_WORKER_CLEANUP: [
      error.message,
      'ERR_UNTRUSTED_CODE_CLEANUP'
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
