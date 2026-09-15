import {
  abortError,
  assertSafePromiseEnvironment,
  assertSupportedProtocolValue,
  cloneWithoutSharedMemory,
  isAbortError,
  isUntrustedCodeError,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_TIMEOUT_MS,
  sanitizeEnvironment,
  settleProtocolValue,
  UntrustedCodeError,
  validatePositiveInteger,
  validateResourceLimits
} from './internal.js'
import { acquireFilePreparationSlot, acquireWorkerSlot } from './admission.js'
import { validateHostFunctions } from './host-functions.js'
import {
  attemptLocalModuleCleanup,
  getLocalModuleCleanupUntilRemoved,
  resolveLocalModule
} from './local-files.js'
import { createUntrustedFileSession, createUntrustedOneShot } from './session.js'

export { configureWorkerAdmission } from './admission.js'
export { getHostFunctionContext, HostFunctionError } from './host-functions.js'
export { sanitizeEnvironment, UntrustedCodeError } from './internal.js'
export { createUntrustedWorker, UntrustedWorkerSession } from './session.js'

const safeIsAbortError = isAbortError
const safeIsUntrustedCodeError = isUntrustedCodeError
const Error = globalThis.Error
const TypeError = globalThis.TypeError
const RangeError = globalThis.RangeError
const AggregateError = globalThis.AggregateError
const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_MAX_ROOT_ENTRIES = 10_000
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024
const SafeAbortController = AbortController
const SafePromise = Promise
const abortControllerAbort = AbortController.prototype.abort
const abortControllerSignal = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  'signal'
).get
const eventTargetAddEventListener = EventTarget.prototype.addEventListener
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const abortSignalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
const safeReflectApply = Reflect.apply
const safeReflectOwnKeys = Reflect.ownKeys
const safeSetHas = Set.prototype.has
const safeArrayIsArray = Array.isArray
const safeObjectAssign = Object.assign
const safeObjectCreate = Object.create
const safeObjectDefineProperty = Object.defineProperty
const safeObjectEntries = Object.entries
const safeObjectFreeze = Object.freeze
const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const safeObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const safeObjectHasOwn = Object.hasOwn
const safeObjectKeys = Object.keys
const safePromiseReject = Promise.reject
const safePromiseThen = Promise.prototype.then
const safeClearTimeout = globalThis.clearTimeout
const safeDateNow = Date.now
const safeSetTimeout = globalThis.setTimeout
const safeWeakMapGet = WeakMap.prototype.get
const safeWeakMapSet = WeakMap.prototype.set
const preparationCleanupUntilRemovedByError = new WeakMap()
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
const ONE_SHOT_OPTION_NAMES = new Set([
  ...RUNNER_DEFAULT_NAMES,
  'input',
  'signal'
])
const FILE_POLICY_OPTION_NAMES = [
  'rootDirectory',
  'maxRootEntries',
  'maxFileBytes',
  'maxTotalFileBytes'
]
const ONE_SHOT_FILE_OPTION_NAMES = new Set([
  ...ONE_SHOT_OPTION_NAMES,
  ...FILE_POLICY_OPTION_NAMES
])
const PERSISTENT_OPTION_NAMES = new Set([
  'type',
  'language',
  'input',
  'environment',
  'resourceLimits',
  'signal',
  'startupTimeoutMs',
  'messageTimeoutMs',
  'lifetimeTimeoutMs',
  'maxSourceBytes',
  'maxMessageBytes',
  'maxInputBytes',
  'maxOutputMessages',
  'maxOutputBytes',
  'hostFunctions',
  'maxHostFunctionCalls',
  'maxInFlightHostFunctions',
  'diagnostics',
  'onDiagnostic'
])
const PERSISTENT_FILE_OPTION_NAMES = new Set([
  ...PERSISTENT_OPTION_NAMES,
  ...FILE_POLICY_OPTION_NAMES
])
const DIAGNOSTIC_OPTION_NAMES = new Set(['maxRecords', 'maxBytes', 'maxRecordBytes'])
const SAFE_PROMISE_CONSTRUCTOR_DESCRIPTOR = safeObjectFreeze({
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false
})
const NATIVE_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR = safeObjectFreeze({
  configurable: false,
  enumerable: false,
  value: SafePromise,
  writable: false
})

function hardenSafePromise (promise) {
  const descriptor = safeReflectApply(
    safeObjectGetOwnPropertyDescriptor,
    undefined,
    [promise, 'constructor']
  )
  if (!descriptor || !safeReflectApply(safeObjectHasOwn, undefined, [descriptor, 'value']) ||
      descriptor.value !== undefined || descriptor.writable !== false ||
      descriptor.enumerable !== false || descriptor.configurable !== false) {
    safeReflectApply(safeObjectDefineProperty, undefined, [
      promise,
      'constructor',
      SAFE_PROMISE_CONSTRUCTOR_DESCRIPTOR
    ])
  }
  return promise
}

function thenSafePromise (promise, onFulfilled, onRejected) {
  hardenSafePromise(promise)
  return hardenSafePromise(
    safeReflectApply(safePromiseThen, promise, [onFulfilled, onRejected])
  )
}

function createSafePromise (executor) {
  return hardenSafePromise(new SafePromise(executor))
}

function createValueOutcome (value) {
  const outcome = safeObjectCreate(null)
  safeReflectApply(safeObjectDefineProperty, undefined, [outcome, 'value', {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  }])
  return safeObjectFreeze(outcome)
}

function publicPromiseFromOutcome (promise) {
  return createSafePromise((resolve, reject) => {
    thenSafePromise(
      promise,
      (outcome) => settleProtocolValue(resolve, reject, outcome.value),
      reject
    )
  })
}

function awaitPublicValuePromise (promise) {
  const control = createSafePromise((resolve, reject) => {
    safeReflectApply(safePromiseThen, promise, [
      (value) => resolve(createValueOutcome(value)),
      reject
    ])
  })
  return awaitSafePromise(control)
}

function awaitSafePromise (promise) {
  hardenSafePromise(promise)
  const bridge = new SafePromise((resolve, reject) => {
    safeReflectApply(safePromiseThen, promise, [resolve, reject])
  })
  safeReflectApply(safeObjectDefineProperty, undefined, [
    bridge,
    'constructor',
    NATIVE_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR
  ])
  return bridge
}

function catchSafePromise (promise, onRejected) {
  return thenSafePromise(promise, undefined, onRejected)
}

function finallySafePromise (promise, onFinally) {
  return hardenSafePromise(new SafePromise((resolve, reject) => {
    const settle = (fulfilled, value) => {
      let finalization
      try {
        finalization = onFinally()
      } catch (error) {
        reject(error)
        return
      }
      thenSafePromise(
        finalization,
        () => fulfilled ? resolve(value) : reject(value),
        reject
      )
    }
    thenSafePromise(
      promise,
      (value) => settle(true, value),
      (error) => settle(false, error)
    )
  }))
}

function raceSafePromises (first, second) {
  return createSafePromise((resolve, reject) => {
    thenSafePromise(first, resolve, reject)
    thenSafePromise(second, resolve, reject)
  })
}

function rejectSafePromise (error) {
  return hardenSafePromise(safeReflectApply(safePromiseReject, SafePromise, [error]))
}

/**
 * Create a callable with snapshotted defaults for one-shot execution.
 */
export function createRunner (defaultOptions = {}) {
  const defaults = snapshotRunnerDefaults(defaultOptions)
  return function runWithDefaults (source, options = {}) {
    let releaseWorkerSlot
    try {
      releaseWorkerSlot = acquireWorkerSlot()
    } catch (error) {
      return rejectSafePromise(translateSessionError(error, DEFAULT_TIMEOUT_MS))
    }
    try {
      if (options === null || typeof options !== 'object' || safeArrayIsArray(options)) {
        throw new TypeError('options must be an object')
      }
      const overrides = snapshotPublicOptions(options, 'options', ONE_SHOT_OPTION_NAMES)
      return runUntrustedCodeAdmitted(
        source,
        { ...defaults, ...overrides },
        releaseWorkerSlot
      )
    } catch (error) {
      releaseWorkerSlot()
      throw error
    }
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
  let releaseWorkerSlot
  try {
    releaseWorkerSlot = acquireWorkerSlot()
  } catch (error) {
    return rejectSafePromise(translateSessionError(error, DEFAULT_TIMEOUT_MS))
  }
  try {
    return runUntrustedCodeAdmitted(source, options, releaseWorkerSlot)
  } catch (error) {
    releaseWorkerSlot()
    throw error
  }
}

function runUntrustedCodeAdmitted (source, options, releaseWorkerSlot) {
  assertSafePromiseEnvironment()
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  if (options === null || typeof options !== 'object' || safeArrayIsArray(options)) {
    throw new TypeError('options must be an object')
  }
  options = snapshotPublicOptions(options, 'options', ONE_SHOT_OPTION_NAMES)

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  validatePositiveInteger(timeoutMs, 'timeoutMs')
  validatePositiveInteger(maxSourceBytes, 'maxSourceBytes')
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
  }
  return runOneShot(options, timeoutMs, timeoutMs, (sessionOptions, workerSlot) => {
    return createUntrustedOneShot(
      source,
      { ...sessionOptions, maxSourceBytes },
      workerSlot
    )
  }, releaseWorkerSlot)
}

/**
 * Execute a local ESM entry module and its imports in a fresh worker. The
 * module must default-export a function receiving the one-shot input.
 */
export function runUntrustedFile (modulePath, options = {}) {
  return publicPromiseFromOutcome(runUntrustedFileAdmitted(modulePath, options))
}

async function runUntrustedFileAdmitted (modulePath, options) {
  const startedAt = safeReflectApply(safeDateNow, undefined, [])
  let releaseWorkerSlot
  try {
    releaseWorkerSlot = acquireWorkerSlot()
  } catch (error) {
    throw translateSessionError(error, DEFAULT_TIMEOUT_MS)
  }

  let timeoutMs
  try {
    assertSafePromiseEnvironment()
    options = snapshotFileOptions(options, 'options', ONE_SHOT_FILE_OPTION_NAMES)
    timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    validatePositiveInteger(timeoutMs, 'timeoutMs')
    if (timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
    }
    const signal = validateSignal(options.signal)
    if (signal && safeReflectApply(abortSignalAborted, signal, [])) {
      throw abortError(safeReflectApply(abortSignalReason, signal, []))
    }
  } catch (error) {
    releaseWorkerSlot()
    throw error
  }

  let releasePreparationSlot
  try {
    releasePreparationSlot = acquireFilePreparationSlot()
  } catch (error) {
    releaseWorkerSlot()
    throw translateSessionError(error, timeoutMs)
  }

  try {
    snapshotFilePolicies(options)
  } catch (error) {
    releaseWorkerSlot()
    releasePreparationSlot()
    throw error
  }

  const localModule = (await awaitSafePromise(prepareLocalModule(
    modulePath,
    options,
    timeoutMs - (safeReflectApply(safeDateNow, undefined, []) - startedAt),
    new UntrustedCodeError(`Execution exceeded ${timeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_CODE_TIMEOUT'
    }),
    releaseWorkerSlot,
    releasePreparationSlot
  ))).value

  const remainingTimeoutMs = timeoutMs - (safeReflectApply(safeDateNow, undefined, []) - startedAt)
  if (remainingTimeoutMs <= 0) {
    releaseWorkerSlot()
    const timeoutError = new UntrustedCodeError(`Execution exceeded ${timeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_CODE_TIMEOUT'
    })
    await awaitSafePromise(cleanupLocalModule(localModule, releasePreparationSlot, timeoutError))
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
    return await awaitPublicValuePromise(runOneShot(options, remainingTimeoutMs, timeoutMs, (sessionOptions) => {
      const session = createUntrustedFileSession(
        localModule,
        sessionOptions,
        true,
        releaseWorkerSlot,
        releasePreparationSlot
      )
      transferred = true
      return session
    }, releaseWorkerSlot))
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (!transferred) {
      releaseWorkerSlot()
      await awaitSafePromise(cleanupLocalModule(localModule, releasePreparationSlot, primaryError))
    }
  }
}

/**
 * Create a persistent session from a local ESM entry module. The trusted root
 * is granted to Node's module loader and the constrained synchronous read
 * facade. File preparation is asynchronous, so this factory returns a promise
 * for the session.
 */
export function createUntrustedWorkerFromFile (modulePath, options = {}) {
  return publicPromiseFromOutcome(createUntrustedWorkerFromFileAdmitted(modulePath, options))
}

async function createUntrustedWorkerFromFileAdmitted (modulePath, options) {
  const startedAt = safeReflectApply(safeDateNow, undefined, [])
  const releaseWorkerSlot = acquireWorkerSlot()
  let startupTimeoutMs
  try {
    assertSafePromiseEnvironment()
    options = snapshotFileOptions(options, 'options', PERSISTENT_FILE_OPTION_NAMES)
    startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS
    validatePositiveInteger(startupTimeoutMs, 'startupTimeoutMs')
    if (startupTimeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`startupTimeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
    }
    const signal = validateSignal(options.signal)
    if (signal && safeReflectApply(abortSignalAborted, signal, [])) {
      throw abortError(safeReflectApply(abortSignalReason, signal, []))
    }
  } catch (error) {
    releaseWorkerSlot()
    throw error
  }

  let releasePreparationSlot
  try {
    releasePreparationSlot = acquireFilePreparationSlot()
  } catch (error) {
    releaseWorkerSlot()
    throw error
  }
  try {
    snapshotFilePolicies(options)
  } catch (error) {
    releaseWorkerSlot()
    releasePreparationSlot()
    throw error
  }
  const localModule = (await awaitSafePromise(prepareLocalModule(
    modulePath,
    options,
    startupTimeoutMs - (safeReflectApply(safeDateNow, undefined, []) - startedAt),
    new UntrustedCodeError(`Startup exceeded ${startupTimeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
    }),
    releaseWorkerSlot,
    releasePreparationSlot
  ))).value

  const remainingStartupMs = startupTimeoutMs - (safeReflectApply(safeDateNow, undefined, []) - startedAt)
  if (remainingStartupMs <= 0) {
    releaseWorkerSlot()
    const timeoutError = new UntrustedCodeError(`Startup exceeded ${startupTimeoutMs} ms`, {
      code: 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
    })
    await awaitSafePromise(cleanupLocalModule(localModule, releasePreparationSlot, timeoutError))
    throw timeoutError
  }
  delete options.rootDirectory
  delete options.maxRootEntries
  delete options.maxFileBytes
  delete options.maxTotalFileBytes
  options.startupTimeoutMs = remainingStartupMs
  try {
    return createValueOutcome(createUntrustedFileSession(
      localModule,
      options,
      false,
      releaseWorkerSlot,
      releasePreparationSlot
    ))
  } catch (error) {
    releaseWorkerSlot()
    await awaitSafePromise(cleanupLocalModule(localModule, releasePreparationSlot, error))
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

  const controller = new SafeAbortController()
  const controllerSignal = safeReflectApply(abortControllerSignal, controller, [])
  const callerSignal = options.signal
  let rejectInterruption
  const interruption = createSafePromise((resolve, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (error) => {
    if (safeReflectApply(abortSignalAborted, controllerSignal, [])) return
    safeReflectApply(abortControllerAbort, controller, [error])
    rejectInterruption(error)
  }
  const onAbort = () => interrupt(abortError(
    safeReflectApply(abortSignalReason, callerSignal, [])
  ))
  if (callerSignal) {
    try {
      safeReflectApply(eventTargetAddEventListener, callerSignal, [
        'abort',
        onAbort,
        { once: true }
      ])
      if (safeReflectApply(abortSignalAborted, callerSignal, [])) onAbort()
    } catch (error) {
      releaseWorkerSlot()
      releasePreparationSlot()
      throw error
    }
  }
  const timer = safeSetTimeout(() => interrupt(timeoutError), timeoutMs)

  const preparationRequest = resolveLocalModule(
    modulePath,
    options.rootDirectory,
    {
      maxRootEntries: options.maxRootEntries,
      maxFileBytes: options.maxFileBytes,
      maxTotalFileBytes: options.maxTotalFileBytes
    },
    controllerSignal
  )
  const preparation = createSafePromise((resolve, reject) => {
    thenSafePromise(
      preparationRequest,
      (localModuleOutcome) => {
        const localModule = localModuleOutcome.value
        if (!safeReflectApply(abortSignalAborted, controllerSignal, [])) {
          resolve(createValueOutcome(localModule))
          return
        }
        let cleanup
        try {
          cleanup = localModule.cleanup()
        } catch (cleanupError) {
          rejectPreparationCleanup(cleanupError, localModule, reject)
          return
        }
        thenSafePromise(
          cleanup,
          () => reject(safeReflectApply(abortSignalReason, controllerSignal, [])),
          (cleanupError) => rejectPreparationCleanup(cleanupError, localModule, reject)
        )
      },
      reject
    )
  })
  // A filesystem request may settle after the public deadline. Preparation
  // can never continue into worker creation.
  void catchSafePromise(preparation, () => {})

  try {
    return await awaitSafePromise(raceSafePromises(preparation, interruption))
  } catch (error) {
    releaseWorkerSlot()
    if (safeReflectApply(abortSignalAborted, controllerSignal, [])) {
      // Keep abandoned filesystem work independently bounded without starving
      // ordinary worker admission if an operating-system request never settles.
      void thenSafePromise(
        preparation,
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
    safeClearTimeout(timer)
    if (callerSignal) {
      try {
        safeReflectApply(eventTargetRemoveEventListener, callerSignal, ['abort', onAbort])
      } catch {}
    }
  }
}

function rejectPreparationCleanup (cleanupError, localModule, reject) {
  const error = new UntrustedCodeError(
    'The private module snapshot could not be removed',
    { code: 'ERR_UNTRUSTED_MODULE_CLEANUP', cause: cleanupError }
  )
  safeReflectApply(safeWeakMapSet, preparationCleanupUntilRemovedByError, [
    error,
    localModule.cleanupUntilRemoved
  ])
  reject(error)
}

function releaseAfterPreparationError (error, releasePreparationSlot) {
  let cleanupUntilRemoved
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    cleanupUntilRemoved = safeReflectApply(
      safeWeakMapGet,
      preparationCleanupUntilRemovedByError,
      [error]
    ) ?? getLocalModuleCleanupUntilRemoved(error)
  }
  if (cleanupUntilRemoved === undefined) {
    releasePreparationSlot()
    return
  }
  let cleanup
  try {
    cleanup = cleanupUntilRemoved()
  } catch {
    return
  }
  void thenSafePromise(cleanup, releasePreparationSlot, () => {})
}

async function cleanupLocalModule (localModule, releasePreparationSlot, primaryError) {
  const outcome = (await awaitSafePromise(attemptLocalModuleCleanup(localModule))).value
  if (outcome.status === 'removed') {
    releasePreparationSlot()
    return
  }

  void thenSafePromise(
    localModule.cleanupUntilRemoved(),
    releasePreparationSlot,
    () => {}
  )
  const cleanupError = outcome.status === 'failed'
    ? outcome.error
    : new Error('Snapshot cleanup did not settle before its deadline')
  throw new UntrustedCodeError(
    'The private module snapshot could not be removed promptly',
    {
      code: 'ERR_UNTRUSTED_MODULE_CLEANUP',
      cause: primaryError
        ? new AggregateError([primaryError, cleanupError], 'Operation and cleanup failures')
        : cleanupError
    }
  )
}

function runOneShot (
  options,
  timeoutMs,
  reportedTimeoutMs,
  createSession,
  preacquiredWorkerSlot
) {
  let releaseWorkerSlot = preacquiredWorkerSlot
  if (releaseWorkerSlot === undefined) {
    try {
      releaseWorkerSlot = acquireWorkerSlot()
    } catch (error) {
      return rejectSafePromise(translateSessionError(error, reportedTimeoutMs))
    }
  }
  let transferred = false
  let session
  try {
    // Admission precedes nested policy validation and input cloning in the
    // session constructor, so rejected calls cannot amplify host-side work.
    const environment = sanitizeEnvironment(options.environment)
    const resourceLimits = validateResourceLimits(options.resourceLimits)
    const signal = validateSignal(options.signal)
    if (signal && safeReflectApply(abortSignalAborted, signal, [])) {
      throw abortError(safeReflectApply(abortSignalReason, signal, []))
    }

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
    }, releaseWorkerSlot)
    transferred = true
  } catch (error) {
    if (!transferred) releaseWorkerSlot()
    if (safeIsAbortError(error) ||
        error?.code === 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT' ||
        error?.code === 'ERR_UNTRUSTED_WORKER_CAPACITY' ||
        error?.code === 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE') {
      return rejectSafePromise(translateSessionError(error, reportedTimeoutMs))
    }
    throw error
  }

  const translatedReady = createSafePromise((resolve, reject) => {
    safeReflectApply(safePromiseThen, session.ready, [
      (value) => resolve(createValueOutcome(value)),
      (error) => reject(translateSessionError(error, reportedTimeoutMs))
    ])
  })
  const finalized = finallySafePromise(translatedReady, async () => {
    try {
      await awaitSafePromise(session.terminate())
    } catch {}
    const closed = (await awaitPublicValuePromise(session.closed)).value
    if (closed.error?.code === 'ERR_UNTRUSTED_WORKER_CLEANUP' ||
        closed.error?.code === 'ERR_UNTRUSTED_WORKER_TERMINATION_TIMEOUT' ||
        closed.error?.code === 'ERR_UNTRUSTED_WORKER_TERMINATION') {
      throw translateSessionError(closed.error, reportedTimeoutMs)
    }
  })
  return publicPromiseFromOutcome(finalized)
}

function snapshotFilePolicies (options) {
  const policyInput = safeObjectCreate(null)
  const policyNames = [
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
  ]
  for (let index = 0; index < policyNames.length; index++) {
    const name = policyNames[index]
    if (name in options) policyInput[name] = options[name]
  }
  safeObjectAssign(options, snapshotRunnerDefaults(policyInput))

  const input = cloneWithoutSharedMemory(
    options.input,
    'input',
    options.maxInputBytes,
    'maxInputBytes'
  )
  assertSupportedProtocolValue(input, 'input', options.maxInputBytes, 'maxInputBytes')
  options.input = input

  const fileLimits = [
    ['maxRootEntries', DEFAULT_MAX_ROOT_ENTRIES],
    ['maxFileBytes', DEFAULT_MAX_FILE_BYTES],
    ['maxTotalFileBytes', DEFAULT_MAX_TOTAL_FILE_BYTES]
  ]
  for (let index = 0; index < fileLimits.length; index++) {
    const name = fileLimits[index][0]
    const defaultValue = fileLimits[index][1]
    const value = options[name] ?? defaultValue
    validatePositiveInteger(value, name)
    options[name] = value
  }
  if (options.maxFileBytes > options.maxTotalFileBytes) {
    throw new RangeError('maxFileBytes must not exceed maxTotalFileBytes')
  }
}

function validateSignal (signal) {
  if (signal === undefined) return signal
  try {
    safeReflectApply(abortSignalAborted, signal, [])
  } catch {
    throw new TypeError('signal must be an AbortSignal')
  }
  return signal
}

function snapshotFileOptions (options, label, allowedNames) {
  if (options === null || typeof options !== 'object' || safeArrayIsArray(options)) {
    throw new TypeError(`${label} must be an object`)
  }
  const snapshot = snapshotPublicOptions(options, label)
  const unsupportedNames = ['language', 'maxSourceBytes', 'type']
  for (let index = 0; index < unsupportedNames.length; index++) {
    const unsupported = unsupportedNames[index]
    if (unsupported in snapshot) {
      throw new TypeError(`${unsupported} is not supported for local module files`)
    }
  }
  const keys = safeObjectKeys(snapshot)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (!safeReflectApply(safeSetHas, allowedNames, [key])) {
      throw new TypeError(`Unknown option: ${key}`)
    }
  }
  return snapshot
}

function snapshotPublicOptions (options, label, allowedNames) {
  const keys = safeReflectOwnKeys(options)
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] === 'symbol') {
      throw new TypeError(`${label} must not contain symbol properties`)
    }
  }
  const snapshot = safeObjectCreate(null)
  const descriptors = safeObjectGetOwnPropertyDescriptors(options)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (allowedNames && !safeReflectApply(safeSetHas, allowedNames, [key])) {
      throw new TypeError(`Unknown option: ${key}`)
    }
    const descriptor = descriptors[key]
    if (!descriptor.enumerable ||
        !safeReflectApply(safeObjectHasOwn, undefined, [descriptor, 'value'])) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`)
    }
    snapshot[key] = descriptor.value
  }
  return snapshot
}

function snapshotRunnerDefaults (options) {
  if (options === null || typeof options !== 'object' || safeArrayIsArray(options)) {
    throw new TypeError('runner defaults must be an object')
  }
  const keys = safeReflectOwnKeys(options)
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] === 'symbol') {
      throw new TypeError('runner defaults must not contain symbol properties')
    }
  }

  const snapshot = safeObjectCreate(null)
  const descriptors = safeObjectGetOwnPropertyDescriptors(options)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (key === 'input' || key === 'signal') {
      throw new TypeError(`${key} must be supplied per run`)
    }
    if (!safeReflectApply(safeSetHas, RUNNER_DEFAULT_NAMES, [key])) {
      throw new TypeError(`Unknown runner default: ${key}`)
    }
    const descriptor = descriptors[key]
    if (!descriptor.enumerable ||
        !safeReflectApply(safeObjectHasOwn, undefined, [descriptor, 'value'])) {
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
  const limitNames = [
    'maxSourceBytes',
    'maxMessageBytes',
    'maxInputBytes',
    'maxOutputMessages',
    'maxOutputBytes',
    'maxHostFunctionCalls',
    'maxInFlightHostFunctions'
  ]
  for (let index = 0; index < limitNames.length; index++) {
    const name = limitNames[index]
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
        safeArrayIsArray(snapshot.diagnostics)) {
      throw new TypeError('diagnostics must be a boolean or an options object')
    }
    const diagnostics = safeObjectCreate(null)
    const diagnosticEntries = safeObjectEntries(
      safeObjectGetOwnPropertyDescriptors(snapshot.diagnostics)
    )
    for (let index = 0; index < diagnosticEntries.length; index++) {
      const name = diagnosticEntries[index][0]
      const descriptor = diagnosticEntries[index][1]
      if (!safeReflectApply(safeSetHas, DIAGNOSTIC_OPTION_NAMES, [name])) {
        throw new TypeError(`Unknown diagnostics option: ${name}`)
      }
      if (!descriptor.enumerable ||
          !safeReflectApply(safeObjectHasOwn, undefined, [descriptor, 'value'])) {
        throw new TypeError(`diagnostics.${name} must be an enumerable data property`)
      }
      validatePositiveInteger(descriptor.value, `diagnostics.${name}`)
      diagnostics[name] = descriptor.value
    }
    const diagnosticKeys = safeReflectOwnKeys(snapshot.diagnostics)
    for (let index = 0; index < diagnosticKeys.length; index++) {
      if (typeof diagnosticKeys[index] === 'symbol') {
        throw new TypeError('diagnostics must not contain symbol properties')
      }
    }
    const maxBytes = diagnostics.maxBytes ?? 64 * 1024
    const maxRecordBytes = diagnostics.maxRecordBytes ?? 4 * 1024
    if (maxRecordBytes > maxBytes) {
      throw new RangeError('diagnostics.maxRecordBytes must not exceed diagnostics.maxBytes')
    }
    snapshot.diagnostics = safeObjectFreeze(diagnostics)
  }
  if (snapshot.diagnostics === false && 'onDiagnostic' in snapshot) {
    throw new TypeError('onDiagnostic cannot be used when diagnostics is false')
  }

  return safeObjectFreeze(snapshot)
}

function snapshotHostFunctions (hostFunctions) {
  const snapshot = safeObjectCreate(null)
  const namespaceEntries = safeObjectEntries(
    safeObjectGetOwnPropertyDescriptors(hostFunctions)
  )
  for (let namespaceIndex = 0; namespaceIndex < namespaceEntries.length; namespaceIndex++) {
    const namespace = namespaceEntries[namespaceIndex][0]
    const descriptor = namespaceEntries[namespaceIndex][1]
    const group = safeObjectCreate(null)
    const functionEntries = safeObjectEntries(
      safeObjectGetOwnPropertyDescriptors(descriptor.value)
    )
    for (let functionIndex = 0; functionIndex < functionEntries.length; functionIndex++) {
      const name = functionEntries[functionIndex][0]
      const functionDescriptor = functionEntries[functionIndex][1]
      safeObjectDefineProperty(group, name, {
        value: functionDescriptor.value,
        enumerable: true
      })
    }
    safeObjectFreeze(group)
    safeObjectDefineProperty(snapshot, namespace, {
      value: group,
      enumerable: true
    })
  }
  return safeObjectFreeze(snapshot)
}

function translateSessionError (error, timeoutMs) {
  if (safeIsAbortError(error)) return error

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
    ERR_UNTRUSTED_WORKER_TERMINATION_TIMEOUT: [
      error.message,
      'ERR_UNTRUSTED_CODE_TERMINATION_TIMEOUT'
    ],
    ERR_UNTRUSTED_WORKER_TERMINATION: [
      error.message,
      'ERR_UNTRUSTED_CODE_TERMINATION'
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
  if (safeIsUntrustedCodeError(error)) {
    return new UntrustedCodeError(error.message, {
      cause: error,
      code: 'ERR_UNTRUSTED_CODE',
      remoteCode: error.remoteCode,
      remoteStack: error.remoteStack
    })
  }
  return error
}
