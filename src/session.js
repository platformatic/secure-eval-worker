import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { deserialize as v8Deserialize, serialize as v8Serialize } from 'node:v8'
import {
  isKeyObject as hostIsKeyObject,
  isPromise as hostIsPromise,
  isProxy as hostIsProxy
} from 'node:util/types'
import { MessagePort, Worker } from 'node:worker_threads'

import {
  abortError,
  assertNoSharedMemory,
  assertSafePromiseEnvironment,
  assertSupportedProtocolValue,
  cloneWithoutSharedMemory,
  DEFAULT_MAX_SOURCE_BYTES,
  remoteError,
  sanitizeEnvironment,
  settleProtocolValue,
  UntrustedCodeError,
  validateResourceLimits,
  validateSource,
  validatePositiveInteger,
  validateTimeout
} from './internal.js'
import {
  acquireWorkerSlot,
  createFileDescriptorQuota,
  getFileDescriptorQuotaWorkerData,
  releaseFileDescriptorQuota
} from './admission.js'
import { attemptLocalModuleCleanup } from './local-files.js'
import {
  invokeHostFunction,
  isHostFunctionContextActiveForSession,
  isPublicHostFunctionError,
  validateHostFunctions
} from './host-functions.js'

// Snapshot builtin ESM bindings before caller-controlled option processing can
// synchronize poisoned CommonJS builtin exports.
const safeHostIsKeyObject = hostIsKeyObject
const safeHostIsPromise = hostIsPromise
const safeHostIsProxy = hostIsProxy
const safeHostCreateHmac = createHmac
const safeHostRandomUUID = randomUUID
const safeHostTimingSafeEqual = timingSafeEqual
const safeHostV8Deserialize = v8Deserialize
const safeHostV8Serialize = v8Serialize
const SafeMessagePort = MessagePort
const Error = globalThis.Error
const TypeError = globalThis.TypeError
const RangeError = globalThis.RangeError
const hostRangeErrorPrototype = RangeError.prototype
const AggregateError = globalThis.AggregateError
const DEFAULT_STARTUP_TIMEOUT_MS = 1_000
const DEFAULT_MESSAGE_TIMEOUT_MS = 1_000
const DEFAULT_LIFETIME_TIMEOUT_MS = 30_000
const DEFAULT_MAX_HOST_FUNCTION_CALLS = 256
const DEFAULT_MAX_IN_FLIGHT_HOST_FUNCTIONS = 32
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
const MIN_MAX_MESSAGE_BYTES = 128
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_OUTPUT_MESSAGES = 1024
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_LOCAL_OPEN_FILE_DESCRIPTORS = 64
const DEFAULT_MAX_DIAGNOSTIC_RECORDS = 100
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024
const DEFAULT_MAX_DIAGNOSTIC_RECORD_BYTES = 4 * 1024
const SafeAbortController = AbortController
const SafeMap = Map
const SafePromise = Promise
const safeArrayBufferIsView = ArrayBuffer.isView
const hostArrayIsArray = Array.isArray
const hostArrayPrototype = Array.prototype
const hostArrayPush = Array.prototype.push
const hostArrayShift = Array.prototype.shift
const hostArraySplice = Array.prototype.splice
const hostClearTimeout = globalThis.clearTimeout
const hostDateNow = Date.now
const hostHmacPrototype = Object.getPrototypeOf(safeHostCreateHmac('sha256', 'capture'))
const hostHmacDigest = hostHmacPrototype.digest
const hostHmacUpdate = hostHmacPrototype.update
const hostObjectCreate = Object.create
const hostObjectDefineProperty = Object.defineProperty
const hostObjectFreeze = Object.freeze
const hostObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const hostObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const hostObjectGetPrototypeOf = Object.getPrototypeOf
const hostObjectHasOwn = Object.hasOwn
const hostPromiseReject = Promise.reject
const hostPromiseResolve = Promise.resolve
const hostPromiseThen = Promise.prototype.then
const hostSetTimeout = globalThis.setTimeout
const hostTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const hostReflectApply = Reflect.apply
const hostReflectOwnKeys = Reflect.ownKeys
const hostMapClear = Map.prototype.clear
const hostMapDelete = Map.prototype.delete
const hostMapGet = Map.prototype.get
const hostMapHas = Map.prototype.has
const hostMapSet = Map.prototype.set
const hostMapValues = Map.prototype.values
const hostMapIteratorNext = Object.getPrototypeOf(new SafeMap().values()).next
const hostSetHas = Set.prototype.has
const hostEventEmitterEmit = EventEmitter.prototype.emit
const hostEventEmitterListenerCount = EventEmitter.prototype.listenerCount
const hostEventEmitterOn = EventEmitter.prototype.on
const hostEventEmitterOnce = EventEmitter.prototype.once
const hostEventEmitterRemoveAllListeners = EventEmitter.prototype.removeAllListeners
const hostMessagePortClose = SafeMessagePort.prototype.close
const hostMessagePortHasRef = SafeMessagePort.prototype.hasRef
const hostMessagePortPostMessage = SafeMessagePort.prototype.postMessage
const hostMessagePortStart = SafeMessagePort.prototype.start
const hostMessagePortOn = Object.getPrototypeOf(SafeMessagePort.prototype).on
const hostReadableResume = Readable.prototype.resume
const hostWorkerStderr = Object.getOwnPropertyDescriptor(Worker.prototype, 'stderr').get
const hostWorkerStdout = Object.getOwnPropertyDescriptor(Worker.prototype, 'stdout').get
const hostWorkerTerminate = Worker.prototype.terminate
const hostWeakMapGet = WeakMap.prototype.get
const hostWeakMapSet = WeakMap.prototype.set
const hostEventTargetAddEventListener = EventTarget.prototype.addEventListener
const hostEventTargetRemoveEventListener = EventTarget.prototype.removeEventListener
const hostAbortControllerAbort = AbortController.prototype.abort
const hostAbortControllerSignal = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  'signal'
).get
const hostAbortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const hostAbortSignalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
const hostAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const hostAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const hostBufferFrom = Buffer.from
const hostNumberIsSafeInteger = Number.isSafeInteger
const hostProcessNextTick = process.nextTick
const hostStringSlice = String.prototype.slice

function hostOwnDataDescriptor (value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') ||
      safeHostIsProxy(value)) {
    return undefined
  }
  const descriptor = hostReflectApply(hostObjectGetOwnPropertyDescriptor, undefined, [value, key])
  if (!descriptor || !hostReflectApply(hostObjectHasOwn, undefined, [descriptor, 'value'])) {
    return undefined
  }
  return descriptor
}

function hostOwnDataValue (value, key) {
  const descriptor = hostOwnDataDescriptor(value, key)
  return descriptor?.value
}

function createDeferredProtocolEnvelope (envelope, type, diagnosticSequence) {
  const deferred = hostObjectCreate(null)
  hostReflectApply(hostObjectDefineProperty, undefined, [deferred, 'envelope', {
    enumerable: true,
    value: envelope
  }])
  hostReflectApply(hostObjectDefineProperty, undefined, [deferred, 'type', {
    enumerable: true,
    value: type
  }])
  hostReflectApply(hostObjectDefineProperty, undefined, [deferred, 'diagnosticSequence', {
    enumerable: true,
    value: diagnosticSequence
  }])
  return hostObjectFreeze(deferred)
}

const sessionSecrets = new WeakMap()
const sessionData = new WeakMap()
const internalSessionOptions = new WeakMap()
const diagnosticContextStorage = new AsyncLocalStorage()
const hostPromisePrototype = SafePromise.prototype
const hostPromisePrototypeConstructorDescriptor = hostObjectFreeze(
  hostObjectGetOwnPropertyDescriptor(hostPromisePrototype, 'constructor')
)
const hostPromiseSpeciesDescriptor = hostObjectFreeze(
  hostObjectGetOwnPropertyDescriptor(SafePromise, Symbol.species)
)
const HOST_PROMISE_DESCRIPTOR_FIELDS = hostObjectFreeze([
  'configurable', 'enumerable', 'writable', 'value', 'get', 'set'
])
const HOST_PROMISE_CONSTRUCTOR_DESCRIPTOR = hostObjectFreeze({
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false
})
const HOST_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR = hostObjectFreeze({
  configurable: false,
  enumerable: false,
  value: SafePromise,
  writable: false
})

function hardenHostPromise (promise) {
  const descriptor = hostReflectApply(hostObjectGetOwnPropertyDescriptor, undefined, [
    promise,
    'constructor'
  ])
  if (!descriptor || !hostReflectApply(hostObjectHasOwn, undefined, [descriptor, 'value']) ||
      descriptor.value !== undefined || descriptor.writable !== false ||
      descriptor.enumerable !== false || descriptor.configurable !== false) {
    hostReflectApply(hostObjectDefineProperty, undefined, [
      promise,
      'constructor',
      HOST_PROMISE_CONSTRUCTOR_DESCRIPTOR
    ])
  }
  return promise
}

function createHostValueOutcome (value) {
  const outcome = hostObjectCreate(null)
  hostReflectApply(hostObjectDefineProperty, undefined, [outcome, 'value', {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  }])
  return hostObjectFreeze(outcome)
}

function sameHostDescriptor (actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected
  for (let index = 0; index < HOST_PROMISE_DESCRIPTOR_FIELDS.length; index++) {
    const name = HOST_PROMISE_DESCRIPTOR_FIELDS[index]
    const actualHas = hostReflectApply(hostObjectHasOwn, undefined, [actual, name])
    const expectedHas = hostReflectApply(hostObjectHasOwn, undefined, [expected, name])
    if (actualHas !== expectedHas || (actualHas && actual[name] !== expected[name])) return false
  }
  return true
}

function isCanonicalHostPromise (value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  if (safeHostIsProxy(value) || !safeHostIsPromise(value)) return false
  try {
    return hostReflectApply(hostObjectGetPrototypeOf, undefined, [value]) === hostPromisePrototype &&
      hostReflectApply(hostObjectGetOwnPropertyDescriptor, undefined, [value, 'constructor']) === undefined &&
      sameHostDescriptor(
        hostReflectApply(hostObjectGetOwnPropertyDescriptor, undefined, [hostPromisePrototype, 'constructor']),
        hostPromisePrototypeConstructorDescriptor
      ) &&
      sameHostDescriptor(
        hostReflectApply(hostObjectGetOwnPropertyDescriptor, undefined, [SafePromise, Symbol.species]),
        hostPromiseSpeciesDescriptor
      )
  } catch {
    return false
  }
}

function unsafeHostPromiseRejection () {
  return bridgeHostControlPromise(createHostPromise((resolve, reject) => {
    reject(new TypeError('Promise cannot be observed safely'))
  }))
}

function adoptHostValue (value) {
  const objectLike = (typeof value === 'object' && value !== null) || typeof value === 'function'
  if (objectLike && safeHostIsProxy(value)) return unsafeHostPromiseRejection()
  if (!safeHostIsPromise(value)) {
    return bridgeHostControlPromise(createHostPromise(resolve => {
      resolve(createHostValueOutcome(value))
    }))
  }
  if (!isCanonicalHostPromise(value)) return unsafeHostPromiseRejection()

  const control = createHostPromise((resolve, reject) => {
    try {
      hostReflectApply(hostPromiseThen, value, [
        result => resolve(createHostValueOutcome(result)),
        reject
      ])
    } catch (error) {
      reject(error)
    }
  })
  return bridgeHostControlPromise(control)
}

function hardenHostAwaitPromise (promise) {
  hostReflectApply(hostObjectDefineProperty, undefined, [
    promise,
    'constructor',
    HOST_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR
  ])
  return promise
}

function createHostPromise (executor) {
  return hardenHostPromise(new SafePromise(executor))
}

function bridgeHostControlPromise (promise) {
  const bridge = new SafePromise((resolve, reject) => {
    hostReflectApply(hostPromiseThen, promise, [resolve, reject])
  })
  return hardenHostAwaitPromise(bridge)
}

function getSessionSecrets (session) {
  return hostReflectApply(hostWeakMapGet, sessionSecrets, [session])
}

function getSessionData (session) {
  return hostReflectApply(hostWeakMapGet, sessionData, [session])
}

function resolveHostPromise (value) {
  return hardenHostPromise(hostReflectApply(hostPromiseResolve, SafePromise, [value]))
}

function rejectHostPromise (error) {
  return hardenHostPromise(hostReflectApply(hostPromiseReject, SafePromise, [error]))
}

function thenHostPromise (promise, onFulfilled, onRejected) {
  hardenHostPromise(promise)
  return hardenHostPromise(
    hostReflectApply(hostPromiseThen, promise, [onFulfilled, onRejected])
  )
}

function catchHostPromise (promise, onRejected) {
  return thenHostPromise(promise, undefined, onRejected)
}

function chainHostPromise (promise, onFulfilled) {
  return createHostPromise((resolve, reject) => {
    thenHostPromise(promise, (value) => {
      let next
      try {
        next = onFulfilled(value)
      } catch (error) {
        reject(error)
        return
      }
      thenHostPromise(next, resolve, reject)
    }, reject)
  })
}

function isHostMessagePort (value) {
  if (value === null || typeof value !== 'object') return false
  try {
    hostReflectApply(hostMessagePortHasRef, value, [])
    return true
  } catch {
    return false
  }
}

function isHostProtocolKey (value) {
  if (!safeHostIsKeyObject(value)) return false
  try {
    safeHostCreateHmac('sha256', value)
    return true
  } catch {
    return false
  }
}

function closeHostMessagePort (port) {
  if (port) hostReflectApply(hostMessagePortClose, port, [])
}

function emitHostEvent (emitter, type, value) {
  return hostReflectApply(hostEventEmitterEmit, emitter, [type, value])
}

function trustedWorkerEmit (...arguments_) {
  return hostReflectApply(hostEventEmitterEmit, this, arguments_)
}

function trustedWorkerOn (...arguments_) {
  return hostReflectApply(hostEventEmitterOn, this, arguments_)
}

function trustedWorkerOnce (...arguments_) {
  return hostReflectApply(hostEventEmitterOnce, this, arguments_)
}

function trustedWorkerRemoveAllListeners (...arguments_) {
  return hostReflectApply(hostEventEmitterRemoveAllListeners, this, arguments_)
}

class SafeWorker extends Worker {}

for (const [name, value] of [
  ['emit', trustedWorkerEmit],
  ['on', trustedWorkerOn],
  ['once', trustedWorkerOnce],
  ['removeAllListeners', trustedWorkerRemoveAllListeners]
]) {
  hostObjectDefineProperty(SafeWorker.prototype, name, {
    configurable: false,
    enumerable: false,
    value,
    writable: false
  })
}
hostObjectFreeze(SafeWorker.prototype)

const ONE_SHOT = Symbol('oneShot')
const LOCAL_MODULE = Symbol('localModule')
const PREPARATION_SLOT = Symbol('preparationSlot')
const TERMINATION_SETTLEMENT_TIMEOUT_MS = 1_000
const SESSION_OPTION_NAMES = new Set([
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
const REQUEST_OPTION_NAMES = new Set(['timeoutMs'])
const DIAGNOSTIC_LEVELS = new Set([
  'assert', 'debug', 'dir', 'error', 'info', 'log', 'table', 'trace', 'warn'
])
let trustedSessionMethods

const SESSION_BOOTSTRAP = readFileSync(
  `${import.meta.dirname}/session-bootstrap.js`,
  'utf8'
)

function createInternalSessionOptions (releaseWorkerSlot) {
  const key = hostObjectFreeze({})
  hostReflectApply(hostWeakMapSet, internalSessionOptions, [
    key,
    hostObjectFreeze({ releaseWorkerSlot })
  ])
  return key
}

export function createUntrustedWorker (source, options = {}) {
  return new UntrustedWorkerSession(source, options)
}

export function createUntrustedOneShot (source, options = {}, releaseWorkerSlot) {
  return new UntrustedWorkerSession(
    source,
    { ...options, [ONE_SHOT]: true },
    releaseWorkerSlot === undefined
      ? undefined
      : createInternalSessionOptions(releaseWorkerSlot)
  )
}

export function createUntrustedFileSession (
  localModule,
  options = {},
  oneShot = false,
  releaseWorkerSlot,
  releasePreparationSlot
) {
  try {
    return new UntrustedWorkerSession('', {
      ...options,
      type: 'module',
      language: 'javascript',
      [ONE_SHOT]: oneShot,
      [LOCAL_MODULE]: localModule,
      [PREPARATION_SLOT]: releasePreparationSlot
    }, createInternalSessionOptions(releaseWorkerSlot))
  } catch (error) {
    releaseWorkerSlot()
    throw error
  }
}

function defineSessionData (session, name, value) {
  getSessionData(session)[name] = value
}

function defineSessionPublicPromise (session, name, value) {
  hostObjectDefineProperty(session, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  })
}

function validateLocationReplacements (value) {
  if (value === undefined) return hostObjectFreeze([])
  if (!hostArrayIsArray(value) ||
      hostReflectApply(hostObjectGetPrototypeOf, undefined, [value]) !== hostArrayPrototype) {
    throw new TypeError('Invalid local module location replacements')
  }
  const descriptors = hostReflectApply(hostObjectGetOwnPropertyDescriptors, undefined, [value])
  const keys = hostReflectApply(hostReflectOwnKeys, undefined, [value])
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !hostReflectApply(hostObjectHasOwn, undefined, [lengthDescriptor, 'value']) ||
      !hostReflectApply(hostNumberIsSafeInteger, undefined, [lengthDescriptor.value]) ||
      lengthDescriptor.value < 0 || lengthDescriptor.value > 4 ||
      keys.length !== lengthDescriptor.value + 1) {
    throw new TypeError('Invalid local module location replacements')
  }
  for (let index = 0; index < lengthDescriptor.value; index++) {
    const descriptor = descriptors[index]
    if (!descriptor || !hostReflectApply(hostObjectHasOwn, undefined, [descriptor, 'value'])) {
      throw new TypeError('Invalid local module location replacements')
    }
    const pair = descriptor.value
    if (!hostArrayIsArray(pair) ||
        hostReflectApply(hostObjectGetPrototypeOf, undefined, [pair]) !== hostArrayPrototype) {
      throw new TypeError('Invalid local module location replacement')
    }
    const pairDescriptors = hostReflectApply(hostObjectGetOwnPropertyDescriptors, undefined, [pair])
    const pairKeys = hostReflectApply(hostReflectOwnKeys, undefined, [pair])
    if (pairKeys.length !== 3 || pairDescriptors.length?.value !== 2 ||
        typeof pairDescriptors[0]?.value !== 'string' ||
        typeof pairDescriptors[1]?.value !== 'string') {
      throw new TypeError('Invalid local module location replacement')
    }
  }
  return value
}

function prepareSessionConfiguration (session, source, rawOptions) {
  const data = getSessionData(session)
  const options = snapshotSessionOptions(rawOptions, SESSION_OPTION_NAMES, true)
  const localModule = options[LOCAL_MODULE]
  const preparationSlot = options[PREPARATION_SLOT]
  if (preparationSlot !== undefined && typeof preparationSlot !== 'function') {
    throw new TypeError('Invalid file preparation slot')
  }
  const type = options.type ?? 'script'
  if (type !== 'script' && type !== 'module') {
    throw new TypeError("type must be 'script' or 'module'")
  }
  const language = options.language ?? 'javascript'
  if (language !== 'javascript' && language !== 'typescript') {
    throw new TypeError("language must be 'javascript' or 'typescript'")
  }

  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  defineSessionData(session, 'messageTimeoutMs', options.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS)
  defineSessionData(session, 'lifetimeTimeoutMs', options.lifetimeTimeoutMs ?? DEFAULT_LIFETIME_TIMEOUT_MS)
  defineSessionData(session, 'maxHostFunctionCalls', options.maxHostFunctionCalls ?? DEFAULT_MAX_HOST_FUNCTION_CALLS)
  defineSessionData(session, 'maxInFlightHostFunctions', options.maxInFlightHostFunctions ?? DEFAULT_MAX_IN_FLIGHT_HOST_FUNCTIONS)
  defineSessionData(session, 'maxMessageBytes', options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)
  defineSessionData(session, 'maxInputBytes', options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES)
  defineSessionData(session, 'maxOutputMessages', options.maxOutputMessages ?? DEFAULT_MAX_OUTPUT_MESSAGES)
  defineSessionData(session, 'maxOutputBytes', options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  const onDiagnostic = options.onDiagnostic
  defineSessionData(session, 'diagnostics', validateDiagnostics(options.diagnostics, onDiagnostic))
  defineSessionData(session, 'onDiagnostic', onDiagnostic)
  defineSessionData(session, 'diagnosticRecords', 0)
  defineSessionData(session, 'diagnosticBytes', 0)
  defineSessionData(session, 'diagnosticSequence', 0)
  defineSessionData(session, 'diagnosticsHandledSequence', 0)
  defineSessionData(session, 'deferredDiagnosticEnvelopes', [])
  defineSessionData(session, 'diagnosticProcessing', resolveHostPromise())
  validateSource(source, maxSourceBytes)
  if (localModule !== undefined &&
      (localModule === null || typeof localModule !== 'object' ||
       typeof localModule.entryUrl !== 'string' || typeof localModule.rootPath !== 'string' ||
       typeof localModule.rootPathPrefix !== 'string' || typeof localModule.rootUrlPrefix !== 'string' ||
       typeof localModule.cleanup !== 'function' ||
       typeof localModule.cleanupUntilRemoved !== 'function')) {
    throw new TypeError('Invalid local module configuration')
  }
  const locationReplacements = localModule === undefined
    ? undefined
    : validateLocationReplacements(localModule.locationReplacements)
  validateTimeout(startupTimeoutMs, 'startupTimeoutMs')
  validateTimeout(data.messageTimeoutMs, 'messageTimeoutMs')
  validateTimeout(data.lifetimeTimeoutMs, 'lifetimeTimeoutMs')
  validatePositiveInteger(data.maxHostFunctionCalls, 'maxHostFunctionCalls')
  validatePositiveInteger(data.maxInFlightHostFunctions, 'maxInFlightHostFunctions')
  validatePositiveInteger(data.maxMessageBytes, 'maxMessageBytes')
  if (data.maxMessageBytes < MIN_MAX_MESSAGE_BYTES) {
    throw new RangeError(`maxMessageBytes must be at least ${MIN_MAX_MESSAGE_BYTES}`)
  }
  validatePositiveInteger(data.maxInputBytes, 'maxInputBytes')
  validatePositiveInteger(data.maxOutputMessages, 'maxOutputMessages')
  validatePositiveInteger(data.maxOutputBytes, 'maxOutputBytes')

  const signal = options.signal
  if (signal !== undefined) {
    try {
      hostReflectApply(hostAbortSignalAborted, signal, [])
    } catch {
      throw new TypeError('signal must be an AbortSignal')
    }
  }
  if (signal && hostReflectApply(hostAbortSignalAborted, signal, [])) {
    throw abortError(hostReflectApply(hostAbortSignalReason, signal, []))
  }

  const startedAt = hostReflectApply(hostDateNow, undefined, [])
  const input = cloneWithoutSharedMemory(
    options.input,
    'input',
    data.maxInputBytes,
    'maxInputBytes'
  )
  assertSupportedProtocolValue(input, 'input', data.maxInputBytes, 'maxInputBytes')
  const serializedInput = safeHostV8Serialize(input)
  if (hostReflectApply(hostTypedArrayByteLength, serializedInput, []) > data.maxInputBytes) {
    throw new RangeError(`input exceeds maxInputBytes (${data.maxInputBytes})`)
  }
  const environment = sanitizeEnvironment(options.environment)
  const resourceLimits = validateResourceLimits(options.resourceLimits)
  const hostFunctionConfiguration = validateHostFunctions(options.hostFunctions)
  if (signal && hostReflectApply(hostAbortSignalAborted, signal, [])) {
    throw abortError(hostReflectApply(hostAbortSignalReason, signal, []))
  }
  const remainingStartupMs = startupTimeoutMs - (hostReflectApply(hostDateNow, undefined, []) - startedAt)
  if (remainingStartupMs <= 0) {
    throw sessionError(`Startup exceeded ${startupTimeoutMs} ms`, 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT')
  }

  return {
    environment,
    hostFunctionConfiguration,
    input,
    language,
    localModule,
    locationReplacements,
    maxSourceBytes,
    options,
    preparationSlot,
    resourceLimits,
    signal,
    startupTimeoutMs,
    startedAt,
    type
  }
}

export class UntrustedWorkerSession extends EventEmitter {
  get state () {
    return getSessionData(this).state
  }

  constructor (source, options = {}, internalOptions) {
    const internal = hostReflectApply(hostWeakMapGet, internalSessionOptions, [internalOptions])
    const releaseWorkerSlot = internal
      ? internal.releaseWorkerSlot
      : acquireWorkerSlot()
    if (new.target !== UntrustedWorkerSession) {
      releaseWorkerSlot()
      throw new TypeError('UntrustedWorkerSession cannot be subclassed')
    }
    try {
      assertSafePromiseEnvironment()
      super()
      for (let index = 0; index < trustedSessionMethods.length; index++) {
        const name = trustedSessionMethods[index][0]
        const method = trustedSessionMethods[index][1]
        hostObjectDefineProperty(this, name, {
          configurable: false,
          enumerable: false,
          value: method,
          writable: false
        })
      }
      hostReflectApply(hostWeakMapSet, sessionData, [this, hostObjectCreate(null)])
    } catch (error) {
      releaseWorkerSlot()
      throw error
    }
    let configuration
    try {
      if (options === null || typeof options !== 'object' || hostArrayIsArray(options)) {
        throw new TypeError('options must be an object')
      }
      configuration = prepareSessionConfiguration(this, source, options)
    } catch (error) {
      releaseWorkerSlot()
      throw error
    }
    const {
      environment,
      hostFunctionConfiguration,
      input,
      language,
      localModule,
      locationReplacements,
      maxSourceBytes,
      options: sessionOptions,
      preparationSlot,
      resourceLimits,
      signal,
      startupTimeoutMs,
      startedAt,
      type
    } = configuration
    options = sessionOptions

    try {
      getSessionData(this).state = 'starting'
      hostReflectApply(hostWeakMapSet, sessionSecrets, [this, {
        worker: undefined,
        port: undefined,
        protocolSecret: undefined,
        rawPortPost: undefined,
        diagnosticPort: undefined,
        diagnosticSecret: undefined,
        releaseWorkerSlot: undefined
      }])
      defineSessionData(this, 'pending', new SafeMap())
      defineSessionData(this, 'outbound', [])
      defineSessionData(this, 'nextRequestId', 1)
      defineSessionData(this, 'inboundSequence', 0)
      defineSessionData(this, 'outboundSequence', 0)
      defineSessionData(this, 'hostFunctionCalls', 0)
      defineSessionData(this, 'inFlightHostFunctions', 0)
      defineSessionData(this, 'hostFunctions', hostFunctionConfiguration.functions)
      defineSessionData(this, 'hostAbortController', new SafeAbortController())
      defineSessionData(this, 'sessionId', safeHostRandomUUID())
      getSessionData(this).readySettled = false
      getSessionData(this).closedSettled = false
      getSessionData(this).failure = undefined
      defineSessionData(this, 'signal', signal)
      getSessionData(this).termination = undefined
      getSessionData(this).startupTimer = undefined
      getSessionData(this).lifetimeTimer = undefined
      defineSessionData(this, 'onAbort', () => this.#fail(abortError(
        hostReflectApply(hostAbortSignalReason, signal, [])
      )))

      defineSessionPublicPromise(this, 'ready', createHostPromise((resolve, reject) => {
        defineSessionData(this, 'resolveReady', (value) => {
          settleProtocolValue(resolve, reject, value)
        })
        defineSessionData(this, 'rejectReady', reject)
      }))
      defineSessionPublicPromise(this, 'closed', createHostPromise((resolve, reject) => {
        defineSessionData(this, 'resolveClosed', (value) => {
          settleProtocolValue(resolve, reject, value)
        })
      }))

      getSessionSecrets(this).releaseWorkerSlot = releaseWorkerSlot
    } catch (error) {
      releaseWorkerSlot()
      throw error
    }

    let descriptorQuota
    let descriptorQuotaWorkerData
    try {
      descriptorQuota = localModule ? createFileDescriptorQuota() : undefined
      descriptorQuotaWorkerData = descriptorQuota
        ? getFileDescriptorQuotaWorkerData(descriptorQuota)
        : undefined
    } catch (error) {
      try {
        if (descriptorQuota) releaseFileDescriptorQuota(descriptorQuota)
      } finally {
        releaseWorkerSlot()
      }
      throw error
    }
    const workerLocalModule = localModule
      ? {
          entryUrl: localModule.entryUrl,
          rootPath: localModule.rootPath,
          rootPathPrefix: localModule.rootPathPrefix,
          rootUrlPrefix: localModule.rootUrlPrefix,
          locationReplacements,
          maxOpenFileDescriptors: MAX_LOCAL_OPEN_FILE_DESCRIPTORS,
          descriptorOwner: descriptorQuotaWorkerData.owner,
          globalDescriptorSlots: descriptorQuotaWorkerData.slotsBuffer
        }
      : undefined
    const workerExecArgv = ['--permission', '--allow-worker']
    if (localModule) {
      workerExecArgv[workerExecArgv.length] = `--allow-fs-read=${localModule.rootPath}`
    }
    workerExecArgv[workerExecArgv.length] = '--disable-warning=PERM0006'
    workerExecArgv[workerExecArgv.length] = '--disable-warning=DEP0192'
    workerExecArgv[workerExecArgv.length] = '--disable-warning=ExperimentalWarning'
    try {
      getSessionSecrets(this).worker = new SafeWorker(SESSION_BOOTSTRAP, {
        eval: true,
        env: environment,
        execArgv: workerExecArgv,
        resourceLimits,
        trackUnmanagedFds: true,
        workerData: {
          source,
          type,
          language,
          oneShot: options[ONE_SHOT] === true,
          input,
          maxSourceBytes,
          hostFunctionManifest: hostFunctionConfiguration.manifest,
          maxMessageBytes: getSessionData(this).maxMessageBytes,
          maxOutputMessages: getSessionData(this).maxOutputMessages,
          maxOutputBytes: getSessionData(this).maxOutputBytes,
          diagnostics: getSessionData(this).diagnostics,
          localModule: workerLocalModule
        },
        name: 'secure-eval-worker-session',
        stdout: true,
        stderr: true
      })
    } catch (error) {
      try {
        if (descriptorQuota) releaseFileDescriptorQuota(descriptorQuota)
      } finally {
        releaseWorkerSlot()
      }
      getSessionData(this).closedSettled = true
      getSessionData(this).resolveClosed({ code: undefined, error })
      getSessionData(this).state = 'closed'
      throw error
    }

    const worker = getSessionSecrets(this).worker
    let actualExitHandled = false
    const handleActualExit = (code) => {
      if (actualExitHandled) return
      actualExitHandled = true
      try {
        if (descriptorQuota) releaseFileDescriptorQuota(descriptorQuota)
      } finally {
        releaseWorkerSlot()
      }
      if (!localModule) {
        this.#handleExit(code)
        return
      }
      try {
        const cleanup = thenHostPromise(attemptLocalModuleCleanup(localModule), (cleanupOutcome) => {
          const outcome = cleanupOutcome.value
          if (outcome.status === 'removed') {
            preparationSlot?.()
            this.#handleExit(code)
            return
          }

          const cleanupError = outcome.status === 'failed'
            ? outcome.error
            : new Error('Snapshot cleanup did not settle before its deadline')
          const primaryError = getSessionData(this).failure
          getSessionData(this).failure = sessionError(
            'The private module snapshot could not be removed promptly',
            'ERR_UNTRUSTED_WORKER_CLEANUP',
            primaryError
              ? new AggregateError([primaryError, cleanupError], 'Worker and cleanup failures')
              : cleanupError
          )
          void thenHostPromise(
            localModule.cleanupUntilRemoved(),
            () => preparationSlot?.(),
            () => {}
          )
          this.#handleExit(code)
        })
        void catchHostPromise(cleanup, (error) => {
          hostReflectApply(hostProcessNextTick, process, [() => { throw error }])
        })
      } catch (error) {
        getSessionData(this).failure = sessionError(
          'The private module snapshot could not be removed promptly',
          'ERR_UNTRUSTED_WORKER_CLEANUP',
          error
        )
        try {
          const cleanupUntilRemoved = localModule.cleanupUntilRemoved()
          void thenHostPromise(cleanupUntilRemoved, () => preparationSlot?.(), () => {})
        } catch {}
        this.#handleExit(code)
      }
    }
    try {
      hostReflectApply(hostEventEmitterOn, worker, ['exit', handleActualExit])
    } catch (error) {
      this.#failWithoutExitListener(sessionError(
        'The worker exit lifecycle could not be observed',
        'ERR_UNTRUSTED_WORKER',
        error
      ), handleActualExit)
      return
    }

    try {
      const stdout = hostReflectApply(hostWorkerStdout, worker, [])
      const stderr = hostReflectApply(hostWorkerStderr, worker, [])
      hostReflectApply(hostReadableResume, stdout, [])
      hostReflectApply(hostReadableResume, stderr, [])
      hostReflectApply(hostEventEmitterOn, worker, [
        'message',
        (message) => {
          try {
            this.#handleHandshake(message)
          } catch (error) {
            this.#failSafely(sessionError(
              'The worker handshake could not be handled safely',
              'ERR_UNTRUSTED_WORKER_PROTOCOL',
              error
            ))
          }
        }
      ])
      hostReflectApply(hostEventEmitterOn, worker, ['messageerror', () => {
        this.#failSafely(sessionError(
          'The worker handshake could not be deserialized',
          'ERR_UNTRUSTED_WORKER_PROTOCOL'
        ))
      }])
      hostReflectApply(hostEventEmitterOn, worker, ['error', (error) => {
        this.#failSafely(sessionError('The worker failed', 'ERR_UNTRUSTED_WORKER', error))
      }])

      const startupDelay = startupTimeoutMs - (hostReflectApply(hostDateNow, undefined, []) - startedAt)
      if (startupDelay <= 0) {
        this.#fail(sessionError(
          `Startup exceeded ${startupTimeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
        ))
      } else {
        getSessionData(this).startupTimer = hostSetTimeout(() => {
          this.#fail(sessionError(
            `Startup exceeded ${startupTimeoutMs} ms`,
            'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
          ))
        }, startupDelay)
      }

      if (signal) {
        try {
          hostReflectApply(hostEventTargetAddEventListener, signal, [
            'abort',
            getSessionData(this).onAbort,
            { once: true }
          ])
          if (hostReflectApply(hostAbortSignalAborted, signal, [])) {
            this.#fail(abortError(hostReflectApply(hostAbortSignalReason, signal, [])))
          }
        } catch (error) {
          this.#fail(sessionError(
            'The cancellation signal could not be observed',
            'ERR_UNTRUSTED_WORKER_ABORT_SIGNAL',
            error
          ))
        }
      }
    } catch (error) {
      this.#fail(sessionError(
        'The worker could not be initialized safely',
        'ERR_UNTRUSTED_WORKER',
        error
      ))
    }
  }

  postMessage (value) {
    this.#assertOpen()
    const cloned = cloneWithoutSharedMemory(
      value,
      'message',
      getSessionData(this).maxMessageBytes,
      'maxMessageBytes'
    )
    this.#assertOpen()
    const body = { type: 'message', value: cloned }
    const serialized = assertProtocolBody(body, 'message', getSessionData(this).maxMessageBytes)
    const send = () => this.#sendProtocol(body, serialized)
    if (getSessionData(this).state === 'ready') send()
    else hostReflectApply(hostArrayPush, getSessionData(this).outbound, [send])
  }

  request (value, options = {}) {
    this.#assertOpen()
    if (isHostFunctionContextActiveForSession(getSessionData(this).sessionId)) {
      throw sessionError(
        'Host functions cannot make reentrant requests to their own session',
        'ERR_UNTRUSTED_WORKER_REENTRANT_REQUEST'
      )
    }
    const diagnosticStore = hostReflectApply(
      hostAsyncLocalStorageGetStore,
      diagnosticContextStorage,
      []
    )
    if (diagnosticStore?.active && diagnosticStore.session === this) {
      throw sessionError(
        'Diagnostic callbacks cannot make reentrant requests to their own session',
        'ERR_UNTRUSTED_WORKER_REENTRANT_DIAGNOSTIC'
      )
    }
    if (options === null || typeof options !== 'object' || hostArrayIsArray(options)) {
      throw new TypeError('request options must be an object')
    }
    options = snapshotSessionOptions(options, REQUEST_OPTION_NAMES)
    this.#assertOpen()
    const timeoutMs = options.timeoutMs ?? getSessionData(this).messageTimeoutMs
    validateTimeout(timeoutMs, 'timeoutMs')
    const deadline = hostReflectApply(hostDateNow, undefined, []) + timeoutMs
    const cloned = cloneWithoutSharedMemory(
      value,
      'message',
      getSessionData(this).maxMessageBytes,
      'maxMessageBytes'
    )
    this.#assertOpen()
    const id = getSessionData(this).nextRequestId++
    const body = { type: 'request', id, value: cloned }
    const serialized = assertProtocolBody(body, 'message', getSessionData(this).maxMessageBytes)
    const remainingMs = deadline - hostReflectApply(hostDateNow, undefined, [])
    if (remainingMs <= 0) {
      const error = sessionError(
        `Message handling exceeded ${timeoutMs} ms`,
        'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
      )
      this.#fail(error)
      return rejectHostPromise(error)
    }

    return createHostPromise((resolve, reject) => {
      const pending = {
        resolve: (result) => settleProtocolValue(resolve, reject, result),
        reject,
        timer: undefined,
        deadline,
        timeoutMs
      }
      const expire = () => {
        if (!hostReflectApply(hostMapDelete, getSessionData(this).pending, [id])) return
        const error = sessionError(
          `Message handling exceeded ${timeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
        )
        reject(error)
        this.#fail(error)
      }
      pending.timer = hostSetTimeout(expire, remainingMs)
      hostReflectApply(hostMapSet, getSessionData(this).pending, [id, pending])
      const send = () => {
        if (getSessionData(this).state !== 'ready' ||
            !hostReflectApply(hostMapHas, getSessionData(this).pending, [id])) return
        this.#sendProtocol(body, serialized)
        if (hostReflectApply(hostDateNow, undefined, []) >= deadline) expire()
      }

      if (getSessionData(this).state === 'ready') send()
      else hostReflectApply(hostArrayPush, getSessionData(this).outbound, [send])
    })
  }

  #failWithoutExitListener (error, handleActualExit) {
    getSessionData(this).failure = error
    getSessionData(this).state = 'closing'
    hostReflectApply(
      hostAbortControllerAbort,
      getSessionData(this).hostAbortController,
      [error]
    )
    this.#rejectReadyOnce(error)
    this.#rejectOutstanding(error)
    let workerTermination
    try {
      workerTermination = hostReflectApply(
        hostWorkerTerminate,
        getSessionSecrets(this).worker,
        []
      )
    } catch (cause) {
      this.#settleWithoutWorkerExit(sessionError(
        'The worker could not be terminated',
        'ERR_UNTRUSTED_WORKER_TERMINATION',
        cause
      ))
      this.#emitError(error)
      return
    }
    getSessionData(this).termination = createHostPromise((resolve, reject) => {
      const timer = hostSetTimeout(() => {
        const timeoutError = sessionError(
          'The worker did not exit after termination was requested',
          'ERR_UNTRUSTED_WORKER_TERMINATION_TIMEOUT',
          error
        )
        this.#settleWithoutWorkerExit(timeoutError)
        reject(timeoutError)
      }, TERMINATION_SETTLEMENT_TIMEOUT_MS)
      try {
        const observation = thenHostPromise(
          workerTermination,
          (code) => {
            hostClearTimeout(timer)
            try {
              handleActualExit(code)
            } finally {
              resolve(code)
            }
          },
          (cause) => {
            hostClearTimeout(timer)
            const terminationError = sessionError(
              'The worker could not be terminated',
              'ERR_UNTRUSTED_WORKER_TERMINATION',
              cause
            )
            this.#settleWithoutWorkerExit(terminationError)
            reject(terminationError)
          }
        )
        catchHostPromise(observation, () => {})
      } catch (cause) {
        hostClearTimeout(timer)
        const terminationError = sessionError(
          'The worker termination could not be observed',
          'ERR_UNTRUSTED_WORKER_TERMINATION',
          cause
        )
        this.#settleWithoutWorkerExit(terminationError)
        reject(terminationError)
      }
    })
    catchHostPromise(getSessionData(this).termination, () => {})
    this.#emitError(error)
  }

  terminate () {
    if (getSessionData(this).termination) return getSessionData(this).termination
    if (getSessionData(this).state !== 'closed') {
      const error = sessionError('The session was terminated', 'ERR_UNTRUSTED_WORKER_TERMINATED')
      this.#rejectReadyOnce(error)
      this.#rejectOutstanding(error)
      getSessionData(this).state = 'closing'
      hostReflectApply(
        hostAbortControllerAbort,
        getSessionData(this).hostAbortController,
        [error]
      )
      hostClearTimeout(getSessionData(this).startupTimer)
      hostClearTimeout(getSessionData(this).lifetimeTimer)
      closeHostMessagePort(getSessionSecrets(this).port)
      closeHostMessagePort(getSessionSecrets(this).diagnosticPort)
    }
    const worker = getSessionSecrets(this).worker
    if (!worker) {
      getSessionData(this).termination = resolveHostPromise(undefined)
      return getSessionData(this).termination
    }

    const workerTermination = hostReflectApply(hostWorkerTerminate, worker, [])
    getSessionData(this).termination = createHostPromise((resolve, reject) => {
      const timer = hostSetTimeout(() => {
        const error = sessionError(
          'The worker did not exit after termination was requested',
          'ERR_UNTRUSTED_WORKER_TERMINATION_TIMEOUT',
          getSessionData(this).failure
        )
        this.#settleWithoutWorkerExit(error)
        reject(error)
      }, TERMINATION_SETTLEMENT_TIMEOUT_MS)
      thenHostPromise(
        workerTermination,
        (code) => {
          hostClearTimeout(timer)
          resolve(code)
        },
        (cause) => {
          hostClearTimeout(timer)
          const error = sessionError(
            'The worker could not be terminated',
            'ERR_UNTRUSTED_WORKER_TERMINATION',
            cause
          )
          this.#settleWithoutWorkerExit(error)
          reject(error)
        }
      )
    })
    return getSessionData(this).termination
  }

  #failSafely (error) {
    try {
      this.#fail(error)
    } catch {}
  }

  #settleWithoutWorkerExit (error) {
    if (getSessionData(this).closedSettled) return
    getSessionData(this).failure = error
    getSessionData(this).state = 'closed'
    getSessionData(this).closedSettled = true
    getSessionData(this).resolveClosed({ code: undefined, error })
  }

  #handleHandshake (message) {
    const secrets = getSessionSecrets(this)
    if (secrets.port) {
      this.#fail(sessionError('Unexpected parent-port message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }
    const type = hostOwnDataValue(message, 'type')
    if (type === 'bootstrap-error') {
      this.#fail(remoteError(
        hostOwnDataValue(message, 'error'),
        'ERR_UNTRUSTED_WORKER_BOOTSTRAP'
      ))
      return
    }
    const port = hostOwnDataValue(message, 'port')
    const protocolSecret = hostOwnDataValue(message, 'protocolSecret')
    const diagnosticPortDescriptor = hostOwnDataDescriptor(message, 'diagnosticPort')
    const diagnosticSecretDescriptor = hostOwnDataDescriptor(message, 'diagnosticSecret')
    const diagnosticPort = diagnosticPortDescriptor?.value
    const diagnosticSecret = diagnosticSecretDescriptor?.value
    const validDiagnosticHandshake = diagnosticPortDescriptor !== undefined &&
      diagnosticSecretDescriptor !== undefined &&
      (getSessionData(this).diagnostics.enabled
        ? isHostMessagePort(diagnosticPort) && isHostProtocolKey(diagnosticSecret)
        : diagnosticPort === undefined && diagnosticSecret === undefined)
    if (type !== 'session-port' || !isHostMessagePort(port) ||
        !isHostProtocolKey(protocolSecret) || !validDiagnosticHandshake) {
      this.#fail(sessionError('Invalid worker handshake', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    secrets.port = port
    secrets.protocolSecret = protocolSecret
    secrets.rawPortPost = (value) => hostReflectApply(
      hostMessagePortPostMessage,
      secrets.port,
      [value]
    )
    if (getSessionData(this).diagnostics.enabled) {
      secrets.diagnosticPort = diagnosticPort
      secrets.diagnosticSecret = diagnosticSecret
      hostReflectApply(hostMessagePortOn, secrets.diagnosticPort, ['message', (message) => {
        try {
          const record = this.#authenticateDiagnostic(message)
          const sequence = getSessionData(this).diagnosticSequence
          const processing = chainHostPromise(
            getSessionData(this).diagnosticProcessing,
            () => this.#handleDiagnostic(record, sequence)
          )
          getSessionData(this).diagnosticProcessing = catchHostPromise(processing, (error) => {
            this.#failSafely(error)
          })
        } catch (error) {
          this.#failSafely(error)
        }
      }])
      hostReflectApply(hostMessagePortOn, secrets.diagnosticPort, ['messageerror', () => {
        this.#failSafely(sessionError(
          'The worker diagnostic message could not be deserialized',
          'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
        ))
      }])
      hostReflectApply(hostMessagePortStart, secrets.diagnosticPort, [])
    }
    hostReflectApply(hostEventEmitterRemoveAllListeners, secrets.worker, ['message'])
    hostReflectApply(hostMessagePortOn, secrets.port, ['message', (message) => {
      try {
        this.#handleMessage(this.#authenticateMessage(message))
      } catch (error) {
        this.#failSafely(error)
      }
    }])
    hostReflectApply(hostMessagePortOn, secrets.port, ['messageerror', () => {
      this.#failSafely(sessionError(
        'The worker protocol message could not be deserialized',
        'ERR_UNTRUSTED_WORKER_PROTOCOL'
      ))
    }])
    hostReflectApply(hostMessagePortStart, secrets.port, [])
  }

  #sendProtocol (body, serialized = serializeProtocolBody(body, getSessionData(this).maxMessageBytes)) {
    const sequence = ++getSessionData(this).outboundSequence
    const secrets = getSessionSecrets(this)
    secrets.rawPortPost({
      sequence,
      payload: serialized,
      mac: protocolMac(secrets.protocolSecret, 'host-to-worker', sequence, serialized)
    })
  }

  #authenticateMessage (message) {
    const sequence = hostOwnDataValue(message, 'sequence')
    const payload = hostOwnDataValue(message, 'payload')
    const mac = hostOwnDataValue(message, 'mac')
    if (!hostReflectApply(hostNumberIsSafeInteger, undefined, [sequence]) ||
        sequence !== getSessionData(this).inboundSequence + 1 ||
        payload === null || typeof payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, undefined, [payload]) ||
        typeof mac !== 'string') {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }

    assertNoSharedMemory(
      payload,
      'protocol payload',
      getSessionData(this).maxMessageBytes,
      'maxMessageBytes'
    )
    const byteLength = hostReflectApply(hostTypedArrayByteLength, payload, [])
    if (byteLength > getSessionData(this).maxMessageBytes) {
      throw sessionError('Worker protocol message is too large', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    const expected = hostReflectApply(hostBufferFrom, undefined, [protocolMac(
      getSessionSecrets(this).protocolSecret,
      'worker-to-host',
      sequence,
      payload
    ), 'base64'])
    const actual = hostReflectApply(hostBufferFrom, undefined, [mac, 'base64'])
    if (expected.length !== actual.length || !safeHostTimingSafeEqual(expected, actual)) {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    let body
    try {
      body = safeHostV8Deserialize(payload)
      assertSupportedProtocolValue(
        body,
        'message',
        getSessionData(this).maxMessageBytes,
        'maxMessageBytes'
      )
    } catch {
      throw sessionError('Invalid worker protocol payload', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    getSessionData(this).inboundSequence = sequence
    return body
  }

  #authenticateDiagnostic (message) {
    const sequence = hostOwnDataValue(message, 'sequence')
    const payload = hostOwnDataValue(message, 'payload')
    const mac = hostOwnDataValue(message, 'mac')
    if (!hostReflectApply(hostNumberIsSafeInteger, undefined, [sequence]) ||
        sequence !== getSessionData(this).diagnosticSequence + 1 ||
        payload === null || typeof payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, undefined, [payload]) ||
        typeof mac !== 'string') {
      throw sessionError(
        'Unauthenticated worker diagnostic message',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    assertNoSharedMemory(
      payload,
      'diagnostic payload',
      getSessionData(this).diagnostics.maxRecordBytes,
      'maxMessageBytes'
    )
    const byteLength = hostReflectApply(hostTypedArrayByteLength, payload, [])
    if (byteLength > getSessionData(this).diagnostics.maxRecordBytes ||
        getSessionData(this).diagnosticRecords >= getSessionData(this).diagnostics.maxRecords ||
        getSessionData(this).diagnosticBytes + byteLength > getSessionData(this).diagnostics.maxBytes) {
      throw sessionError(
        'Worker diagnostic limit exceeded',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    const expected = hostReflectApply(hostBufferFrom, undefined, [protocolMac(
      getSessionSecrets(this).diagnosticSecret,
      'worker-diagnostic-to-host',
      sequence,
      payload
    ), 'base64'])
    const actual = hostReflectApply(hostBufferFrom, undefined, [mac, 'base64'])
    if (expected.length !== actual.length || !safeHostTimingSafeEqual(expected, actual)) {
      throw sessionError(
        'Unauthenticated worker diagnostic message',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    let record
    try {
      record = safeHostV8Deserialize(payload)
      assertSupportedProtocolValue(
        record,
        'diagnostic payload',
        getSessionData(this).diagnostics.maxRecordBytes,
        'maxMessageBytes'
      )
    } catch {
      throw sessionError(
        'Invalid worker diagnostic payload',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    const level = hostOwnDataValue(record, 'level')
    const text = hostOwnDataValue(record, 'text')
    if (!hostReflectApply(hostSetHas, DIAGNOSTIC_LEVELS, [level]) ||
        typeof text !== 'string' || hostReflectOwnKeys(record).length !== 2) {
      throw sessionError(
        'Invalid worker diagnostic payload',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    getSessionData(this).diagnosticSequence = sequence
    getSessionData(this).diagnosticRecords++
    getSessionData(this).diagnosticBytes += byteLength
    return hostObjectFreeze({ level, text })
  }

  async #handleDiagnostic (record, sequence) {
    if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') return
    const store = { active: true, session: this }
    try {
      const callback = hostReflectApply(
        hostAsyncLocalStorageRun,
        diagnosticContextStorage,
        [store, () => getSessionData(this).onDiagnostic
          ? getSessionData(this).onDiagnostic(record)
          : undefined]
      )
      await adoptHostValue(callback)
      emitHostEvent(this, 'diagnostic', record)
    } catch (error) {
      throw sessionError(
        'The diagnostic callback failed',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_CALLBACK',
        error
      )
    } finally {
      store.active = false
    }
    getSessionData(this).diagnosticsHandledSequence = sequence
    while (getSessionData(this).deferredDiagnosticEnvelopes.length > 0 &&
           getSessionData(this).deferredDiagnosticEnvelopes[0].diagnosticSequence <= sequence) {
      const deferred = hostReflectApply(
        hostArrayShift,
        getSessionData(this).deferredDiagnosticEnvelopes,
        []
      )
      this.#handleMessage(
        deferred.envelope,
        true,
        deferred.type,
        deferred.diagnosticSequence
      )
      if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') return
    }
  }

  #handleMessage (
    envelope,
    diagnosticsReady = false,
    inspectedType,
    inspectedDiagnosticSequence
  ) {
    if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') return
    const type = inspectedType === undefined
      ? hostOwnDataValue(envelope, 'type')
      : inspectedType
    const diagnosticSequence = inspectedDiagnosticSequence === undefined
      ? hostOwnDataValue(envelope, 'diagnosticSequence')
      : inspectedDiagnosticSequence
    if (typeof type !== 'string' ||
        !hostReflectApply(hostNumberIsSafeInteger, undefined, [diagnosticSequence]) ||
        diagnosticSequence < 0) {
      this.#fail(sessionError('Invalid worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }
    if (!diagnosticsReady &&
        (getSessionData(this).deferredDiagnosticEnvelopes.length > 0 ||
         diagnosticSequence > getSessionData(this).diagnosticsHandledSequence)) {
      if (!getSessionData(this).diagnostics.enabled && diagnosticSequence !== 0) {
        this.#fail(sessionError('Invalid worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      } else {
        hostReflectApply(hostArrayPush, getSessionData(this).deferredDiagnosticEnvelopes, [
          createDeferredProtocolEnvelope(envelope, type, diagnosticSequence)
        ])
      }
      return
    }

    if (type === 'host-call') {
      this.#handleHostCall(envelope)
      return
    }

    const valueDescriptor = hostOwnDataDescriptor(envelope, 'value')
    const value = valueDescriptor?.value
    try {
      if (valueDescriptor !== undefined) {
        assertNoSharedMemory(
          value,
          'message',
          getSessionData(this).maxMessageBytes,
          'maxMessageBytes'
        )
      }
    } catch (error) {
      this.#fail(error)
      return
    }

    if (type === 'ready') {
      if (getSessionData(this).state !== 'starting') {
        this.#fail(sessionError('Unexpected ready message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
        return
      }
      hostClearTimeout(getSessionData(this).startupTimer)
      getSessionData(this).state = 'ready'
      getSessionData(this).readySettled = true
      getSessionData(this).resolveReady(value)
      getSessionData(this).lifetimeTimer = hostSetTimeout(() => {
        this.#fail(sessionError(
          `Session lifetime exceeded ${getSessionData(this).lifetimeTimeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_LIFETIME_TIMEOUT'
        ))
      }, getSessionData(this).lifetimeTimeoutMs)
      const outbound = hostReflectApply(hostArraySplice, getSessionData(this).outbound, [0])
      for (let index = 0; index < outbound.length; index++) outbound[index]()
      return
    }

    if (type === 'message') {
      emitHostEvent(this, 'message', value)
      return
    }
    if (type === 'runtime-error') {
      this.#emitError(remoteError(hostOwnDataValue(envelope, 'error')))
      return
    }
    if (type === 'fatal') {
      this.#fail(remoteError(
        hostOwnDataValue(envelope, 'error'),
        'ERR_UNTRUSTED_WORKER_BOOTSTRAP'
      ))
      return
    }
    if (type === 'response' || type === 'request-error') {
      const id = hostOwnDataValue(envelope, 'id')
      const pending = hostReflectApply(hostMapGet, getSessionData(this).pending, [id])
      if (!pending) {
        this.#fail(sessionError('Unknown request response', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
        return
      }
      hostReflectApply(hostMapDelete, getSessionData(this).pending, [id])
      hostClearTimeout(pending.timer)
      if (hostReflectApply(hostDateNow, undefined, []) >= pending.deadline) {
        const error = sessionError(
          `Message handling exceeded ${pending.timeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
        )
        pending.reject(error)
        this.#fail(error)
      } else if (type === 'response') {
        pending.resolve(value)
      } else {
        pending.reject(remoteError(hostOwnDataValue(envelope, 'error')))
      }
      return
    }

    this.#fail(sessionError('Unknown worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
  }

  #handleHostCall (envelope) {
    if (getSessionData(this).state !== 'starting' && getSessionData(this).state !== 'ready') return
    const id = hostOwnDataValue(envelope, 'id')
    const name = hostOwnDataValue(envelope, 'name')
    const argumentsList = hostOwnDataValue(envelope, 'arguments')
    if (!hostReflectApply(hostNumberIsSafeInteger, undefined, [id]) || id <= 0 ||
        typeof name !== 'string' || !hostArrayIsArray(argumentsList)) {
      this.#fail(sessionError('Invalid host function request', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    try {
      assertNoSharedMemory(
        argumentsList,
        'host function arguments',
        getSessionData(this).maxMessageBytes,
        'maxMessageBytes'
      )
    } catch (error) {
      this.#sendHostFunctionError(id, error)
      return
    }

    const hostFunction = hostReflectApply(
      hostMapGet,
      getSessionData(this).hostFunctions,
      [name]
    )
    if (!hostFunction) {
      this.#sendHostFunctionError(id, sessionError(
        `Unknown host function: ${name}`,
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
      ))
      return
    }
    if (getSessionData(this).hostFunctionCalls >= getSessionData(this).maxHostFunctionCalls) {
      this.#fail(sessionError(
        'Host function call limit exceeded',
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
      ))
      return
    }
    if (getSessionData(this).inFlightHostFunctions >= getSessionData(this).maxInFlightHostFunctions) {
      this.#fail(sessionError(
        'Concurrent host function limit exceeded',
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
      ))
      return
    }

    getSessionData(this).hostFunctionCalls++
    getSessionData(this).inFlightHostFunctions++
    const requestIndex = getSessionData(this).hostFunctionCalls
    void catchHostPromise(
      this.#invokeHostFunction(id, name, argumentsList, hostFunction, requestIndex),
      () => {}
    )
  }

  async #invokeHostFunction (id, name, argumentsList, hostFunction, requestIndex) {
    try {
      const outcome = await invokeHostFunction(
        hostFunction,
        argumentsList,
        {
          abortSignal: hostReflectApply(
            hostAbortControllerSignal,
            getSessionData(this).hostAbortController,
            []
          ),
          sessionId: getSessionData(this).sessionId,
          requestId: `${getSessionData(this).sessionId}:${id}`,
          requestIndex,
          hostFunctionName: name
        }
      )
      const value = outcome.value
      const hostAbortSignal = hostReflectApply(
        hostAbortControllerSignal,
        getSessionData(this).hostAbortController,
        []
      )
      if (hostReflectApply(hostAbortSignalAborted, hostAbortSignal, []) ||
          (getSessionData(this).state !== 'starting' && getSessionData(this).state !== 'ready')) return
      const cloned = cloneWithoutSharedMemory(
        value,
        'host function result',
        getSessionData(this).maxMessageBytes,
        'maxMessageBytes'
      )
      assertProtocolSerializable(cloned, 'host function result')
      if (getSessionData(this).state === 'starting' || getSessionData(this).state === 'ready') {
        this.#sendProtocol({ type: 'host-result', id, value: cloned })
      }
    } catch (error) {
      if (getSessionData(this).state === 'starting' || getSessionData(this).state === 'ready') {
        this.#sendHostFunctionError(id, error)
      }
    } finally {
      getSessionData(this).inFlightHostFunctions--
    }
  }

  #sendHostFunctionError (id, error) {
    if (!getSessionSecrets(this).port ||
        (getSessionData(this).state !== 'starting' && getSessionData(this).state !== 'ready')) return
    try {
      this.#sendProtocol({
        type: 'host-error',
        id,
        error: serializeHostError(error)
      })
    } catch (protocolError) {
      this.#fail(sessionError(
        'Host function error exceeded protocol limits',
        'ERR_UNTRUSTED_WORKER_PROTOCOL',
        protocolError
      ))
    }
  }

  #handleExit (code) {
    hostClearTimeout(getSessionData(this).startupTimer)
    hostClearTimeout(getSessionData(this).lifetimeTimer)
    if (getSessionData(this).signal) {
      try {
        hostReflectApply(hostEventTargetRemoveEventListener, getSessionData(this).signal, ['abort', getSessionData(this).onAbort])
      } catch {}
    }
    closeHostMessagePort(getSessionSecrets(this).port)
    closeHostMessagePort(getSessionSecrets(this).diagnosticPort)

    let errorToEmit
    if (getSessionData(this).state !== 'closing' && getSessionData(this).state !== 'closed') {
      errorToEmit = getSessionData(this).failure ?? sessionError(
        `The worker exited unexpectedly (code ${code})`,
        'ERR_UNTRUSTED_WORKER_EXIT'
      )
      getSessionData(this).failure = errorToEmit
      getSessionData(this).state = 'closing'
      hostReflectApply(
        hostAbortControllerAbort,
        getSessionData(this).hostAbortController,
        [errorToEmit]
      )
      this.#rejectOutstanding(errorToEmit)
      this.#rejectReadyOnce(errorToEmit)
    }

    getSessionData(this).state = 'closed'
    if (!getSessionData(this).closedSettled) {
      getSessionData(this).closedSettled = true
      getSessionData(this).resolveClosed({ code, error: getSessionData(this).failure })
    }
    try {
      if (errorToEmit) this.#emitError(errorToEmit)
    } finally {
      emitHostEvent(this, 'exit', code)
    }
  }

  #fail (error) {
    if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') return
    getSessionData(this).failure = error
    getSessionData(this).state = 'closing'
    hostReflectApply(
      hostAbortControllerAbort,
      getSessionData(this).hostAbortController,
      [error]
    )
    this.#rejectReadyOnce(error)
    this.#rejectOutstanding(error)
    const termination = this.terminate()
    catchHostPromise(termination, () => {})
    this.#emitError(error)
  }

  #rejectReadyOnce (error) {
    if (getSessionData(this).readySettled) return
    getSessionData(this).readySettled = true
    getSessionData(this).rejectReady(error)
  }

  #rejectOutstanding (error) {
    const pendingMap = getSessionData(this).pending
    const iterator = hostReflectApply(hostMapValues, pendingMap, [])
    while (true) {
      const item = hostReflectApply(hostMapIteratorNext, iterator, [])
      if (item.done) break
      hostClearTimeout(item.value.timer)
      item.value.reject(error)
    }
    hostReflectApply(hostMapClear, pendingMap, [])
    getSessionData(this).outbound.length = 0
  }

  #emitError (error) {
    if (hostReflectApply(hostEventEmitterListenerCount, this, ['error']) > 0) {
      emitHostEvent(this, 'error', error)
    }
  }

  #assertOpen () {
    if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') {
      throw getSessionData(this).failure ?? sessionError('The session is closed', 'ERR_UNTRUSTED_WORKER_CLOSED')
    }
  }
}

function protocolMac (secret, direction, sequence, serialized) {
  const hmac = safeHostCreateHmac('sha256', secret)
  hostReflectApply(hostHmacUpdate, hmac, [`${direction}\0${sequence}\0`])
  hostReflectApply(hostHmacUpdate, hmac, [serialized])
  return hostReflectApply(hostHmacDigest, hmac, ['base64'])
}

function serializeProtocolBody (body, maxMessageBytes) {
  let serialized
  try {
    assertSupportedProtocolValue(body, 'message', maxMessageBytes, 'maxMessageBytes')
    serialized = safeHostV8Serialize(body)
  } catch {
    throw new TypeError('Message is not supported by the authenticated protocol')
  }
  if (hostReflectApply(hostTypedArrayByteLength, serialized, []) > maxMessageBytes) {
    throw new RangeError(`Message exceeds maxMessageBytes (${maxMessageBytes})`)
  }
  return serialized
}

function assertProtocolBody (body, label, maxMessageBytes) {
  try {
    return serializeProtocolBody(body, maxMessageBytes)
  } catch (error) {
    try {
      if (hostReflectApply(hostObjectGetPrototypeOf, undefined, [error]) === hostRangeErrorPrototype) {
        throw error
      }
    } catch (classificationError) {
      if (classificationError === error) throw error
    }
    throw new TypeError(`${label} is not supported by the authenticated protocol`)
  }
}

function assertProtocolSerializable (value, label) {
  try {
    safeHostV8Serialize(value)
  } catch {
    throw new TypeError(`${label} is not supported by the authenticated protocol`)
  }
}

function serializeHostError (error) {
  try {
    if (isPublicHostFunctionError(error)) {
      const messageDescriptor = hostReflectApply(
        hostObjectGetOwnPropertyDescriptor,
        undefined,
        [error, 'message']
      )
      const codeDescriptor = hostReflectApply(
        hostObjectGetOwnPropertyDescriptor,
        undefined,
        [error, 'code']
      )
      if (messageDescriptor && codeDescriptor &&
          hostReflectApply(hostObjectHasOwn, undefined, [messageDescriptor, 'value']) &&
          hostReflectApply(hostObjectHasOwn, undefined, [codeDescriptor, 'value']) &&
          typeof messageDescriptor.value === 'string' &&
          typeof codeDescriptor.value === 'string') {
        return {
          name: 'HostFunctionError',
          message: hostReflectApply(hostStringSlice, messageDescriptor.value, [0, 8_192]),
          code: hostReflectApply(hostStringSlice, codeDescriptor.value, [0, 8_192])
        }
      }
    }
  } catch {}
  return {
    name: 'HostFunctionError',
    message: 'Host function failed',
    code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
  }
}

trustedSessionMethods = Object.freeze(Object.entries(
  Object.getOwnPropertyDescriptors(UntrustedWorkerSession.prototype)
).filter(([name, descriptor]) => {
  return name !== 'constructor' &&
    hostReflectApply(hostObjectHasOwn, undefined, [descriptor, 'value']) &&
    typeof descriptor.value === 'function'
}).map(([name, descriptor]) => Object.freeze([name, descriptor.value])))

function snapshotSessionOptions (options, allowedNames, allowInternalSymbols = false) {
  const snapshot = hostObjectCreate(null)
  const descriptors = hostObjectGetOwnPropertyDescriptors(options)
  const keys = hostReflectOwnKeys(options)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key === 'symbol') {
      if (!allowInternalSymbols || (key !== ONE_SHOT && key !== LOCAL_MODULE &&
          key !== PREPARATION_SLOT)) {
        throw new TypeError('options must not contain symbol properties')
      }
    } else if (!hostReflectApply(hostSetHas, allowedNames, [key])) {
      throw new TypeError(`Unknown option: ${key}`)
    }
    const descriptor = descriptors[key]
    if (!descriptor.enumerable ||
        !hostReflectApply(hostObjectHasOwn, undefined, [descriptor, 'value'])) {
      throw new TypeError(`options.${String(key)} must be an enumerable data property`)
    }
    snapshot[key] = descriptor.value
  }
  return snapshot
}

function validateDiagnostics (diagnostics, onDiagnostic) {
  if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function')
  }
  if (diagnostics === false && onDiagnostic !== undefined) {
    throw new TypeError('onDiagnostic cannot be used when diagnostics is false')
  }
  if (diagnostics === undefined || diagnostics === false) {
    if (onDiagnostic === undefined) return hostObjectFreeze({ enabled: false })
    diagnostics = true
  }
  if (diagnostics !== true &&
      (diagnostics === null || typeof diagnostics !== 'object' || hostArrayIsArray(diagnostics))) {
    throw new TypeError('diagnostics must be a boolean or an options object')
  }

  const values = {
    maxRecords: DEFAULT_MAX_DIAGNOSTIC_RECORDS,
    maxBytes: DEFAULT_MAX_DIAGNOSTIC_BYTES,
    maxRecordBytes: DEFAULT_MAX_DIAGNOSTIC_RECORD_BYTES
  }
  if (diagnostics !== true) {
    const keys = hostReflectOwnKeys(diagnostics)
    for (let index = 0; index < keys.length; index++) {
      if (typeof keys[index] === 'symbol') {
        throw new TypeError('diagnostics must not contain symbol properties')
      }
    }
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (!hostReflectApply(hostObjectHasOwn, undefined, [values, key])) {
        throw new TypeError(`Unknown diagnostics option: ${key}`)
      }
      const descriptor = hostReflectApply(hostObjectGetOwnPropertyDescriptor, undefined, [diagnostics, key])
      if (!descriptor.enumerable ||
          !hostReflectApply(hostObjectHasOwn, undefined, [descriptor, 'value'])) {
        throw new TypeError(`diagnostics.${key} must be an enumerable data property`)
      }
      validatePositiveInteger(descriptor.value, `diagnostics.${key}`)
      values[key] = descriptor.value
    }
  }
  if (values.maxRecordBytes > values.maxBytes) {
    throw new RangeError('diagnostics.maxRecordBytes must not exceed diagnostics.maxBytes')
  }
  return hostObjectFreeze({ enabled: true, ...values })
}

function sessionError (message, code, cause) {
  return new UntrustedCodeError(message, { code, cause })
}
