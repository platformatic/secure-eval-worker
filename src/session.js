import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { deserialize as v8Deserialize, serialize as v8Serialize } from 'node:v8'
import { isPromise as hostIsPromise, isProxy as hostIsProxy } from 'node:util/types'
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

const SESSION_BOOTSTRAP = String.raw`
'use strict'
;(function trustedBootstrap() {

const cryptoBuiltin = require('node:crypto')
const { createHmac, randomBytes } = cryptoBuiltin
const asyncHooksBuiltin = require('node:async_hooks')
const childProcessBuiltin = require('node:child_process')
const eventEmitterPrototype = require('node:events').EventEmitter.prototype
const fsBuiltin = require('node:fs')
const fsPromisesBuiltin = require('node:fs/promises')
const dgramBuiltin = require('node:dgram')
const dnsBuiltin = require('node:dns')
const dnsPromisesBuiltin = require('node:dns/promises')
const httpBuiltin = require('node:http')
const http2Builtin = require('node:http2')
const httpsBuiltin = require('node:https')
const httpGlobalAgent = httpBuiltin.globalAgent
const httpsGlobalAgent = httpsBuiltin.globalAgent
const moduleBuiltin = require('node:module')
const netBuiltin = require('node:net')
const osBuiltin = require('node:os')
const perfHooksBuiltin = require('node:perf_hooks')
const performanceBuiltin = perfHooksBuiltin.performance
const processBuiltin = require('node:process')
const seaBuiltin = require('node:sea')
const sqliteBuiltin = require('node:sqlite')
const tlsBuiltin = require('node:tls')
const ttyBuiltin = require('node:tty')
const v8Builtin = require('node:v8')
const utilTypesBuiltin = require('node:util/types')
const workerThreadsBuiltin = require('node:worker_threads')
let traceEventsBuiltin
let quicBuiltin
try { traceEventsBuiltin = require('node:trace_events') } catch {}
try { quicBuiltin = require('node:quic') } catch {}
const networkAliasBuiltins = [
  require('_http_agent'),
  require('_http_client'),
  require('_http_common'),
  require('_http_incoming'),
  require('_http_outgoing'),
  require('_http_server'),
  require('_tls_common'),
  require('_tls_wrap')
]
const { deserialize: v8Deserialize, serialize: v8Serialize } = v8Builtin
const moduleLoad = moduleBuiltin._load
const moduleNodeModulePaths = moduleBuiltin._nodeModulePaths
const moduleResolveLookupPaths = moduleBuiltin._resolveLookupPaths
const processGetBuiltinModule = processBuiltin.getBuiltinModule
const { stripTypeScriptTypes } = moduleBuiltin
const { MessageChannel, parentPort, workerData } = workerThreadsBuiltin
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const safeStructuredClone = globalThis.structuredClone
const safeV8Deserialize = v8Deserialize
const safeV8Serialize = v8Serialize
const reflectApply = Reflect.apply
const reflectDeleteProperty = Reflect.deleteProperty
const performanceNow = performanceBuiltin.now
const performanceBaseline = reflectApply(performanceNow, performanceBuiltin, [])
const safeAtomics = Atomics
const hostAtomicsCompareExchange = Atomics.compareExchange
const SafePromise = Promise
const SafeError = globalThis.Error
const SafeTypeError = globalThis.TypeError
const SafeRangeError = globalThis.RangeError
const SafeSyntaxError = globalThis.SyntaxError
const Error = SafeError
const TypeError = SafeTypeError
const RangeError = SafeRangeError
const SafeString = String
const SafeNumber = Number
const SafeWeakSet = WeakSet
const numberIsSafeInteger = Number.isSafeInteger
const maxSafeInteger = Number.MAX_SAFE_INTEGER
const mathFloor = Math.floor
const isNativeError = utilTypesBuiltin.isNativeError
const isPromise = utilTypesBuiltin.isPromise
const isProxy = utilTypesBuiltin.isProxy
const promiseThen = Promise.prototype.then
const safeSetInterval = globalThis.setInterval
const safeClearInterval = globalThis.clearInterval
const reflectOwnKeys = Reflect.ownKeys
const arrayBufferIsView = ArrayBuffer.isView
const arrayIsArray = Array.isArray
const weakSetHas = WeakSet.prototype.has
const weakSetAdd = WeakSet.prototype.add
const weakSetDelete = WeakSet.prototype.delete
const arrayPush = Array.prototype.push
const arrayPop = Array.prototype.pop
const arrayJoin = Array.prototype.join
const arraySplice = Array.prototype.splice
const mapGet = Map.prototype.get
const mapSet = Map.prototype.set
const mapDelete = Map.prototype.delete
const mapEntries = Map.prototype.entries
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get
const setHas = Set.prototype.has
const setValues = Set.prototype.values
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const dateTime = Date.prototype.getTime
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get
const sharedByteLength = typeof SharedArrayBuffer === 'undefined'
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
).get
const dataViewPrototype = DataView.prototype
const dataViewBuffer = Object.getOwnPropertyDescriptor(dataViewPrototype, 'buffer').get
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'length'
).get
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const wasmMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get
const hmacPrototype = Object.getPrototypeOf(createHmac('sha256', 'capture'))
const hmacUpdate = hmacPrototype.update
const hmacDigest = hmacPrototype.digest
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const objectFreeze = Object.freeze
const objectGetPrototypeOf = Object.getPrototypeOf
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const objectHasOwn = Object.hasOwn
const objectIsExtensible = Object.isExtensible
const objectPrototype = Object.prototype
const eventConstructorDescriptor = objectGetOwnPropertyDescriptor(globalThis, 'Event')
if (!eventConstructorDescriptor ||
    !reflectApply(objectHasOwn, undefined, [eventConstructorDescriptor, 'value']) ||
    typeof eventConstructorDescriptor.value !== 'function') {
  throw new SafeError('Failed to capture global Event constructor')
}
const eventConstructor = eventConstructorDescriptor.value
const eventPrototypeDescriptor = objectGetOwnPropertyDescriptor(eventConstructor, 'prototype')
if (!eventPrototypeDescriptor ||
    !reflectApply(objectHasOwn, undefined, [eventPrototypeDescriptor, 'value']) ||
    eventPrototypeDescriptor.value === null ||
    typeof eventPrototypeDescriptor.value !== 'object' ||
    eventPrototypeDescriptor.writable !== false ||
    eventPrototypeDescriptor.configurable !== false ||
    objectGetPrototypeOf(eventPrototypeDescriptor.value) !== objectPrototype) {
  throw new SafeError('Failed to capture canonical Event prototype')
}
const eventPrototype = eventPrototypeDescriptor.value
const eventTimeStampDescriptor = objectGetOwnPropertyDescriptor(eventPrototype, 'timeStamp')
if (!eventTimeStampDescriptor ||
    !reflectApply(objectHasOwn, undefined, [eventTimeStampDescriptor, 'get']) ||
    typeof eventTimeStampDescriptor.get !== 'function' ||
    eventTimeStampDescriptor.set !== undefined ||
    eventTimeStampDescriptor.configurable !== true ||
    eventTimeStampDescriptor.enumerable !== true) {
  throw new SafeError('Failed to capture canonical Event timestamp getter')
}
const eventTimeStampGet = eventTimeStampDescriptor.get
const performanceConstructorNames = objectFreeze([
  'Performance',
  'PerformanceEntry',
  'PerformanceMark',
  'PerformanceMeasure',
  'PerformanceObserver',
  'PerformanceObserverEntryList',
  'PerformanceResourceTiming'
])
const originalPerformanceConstructors = objectCreate(null)
for (let index = 0; index < performanceConstructorNames.length; index++) {
  const name = performanceConstructorNames[index]
  const descriptor = objectGetOwnPropertyDescriptor(globalThis, name)
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
      typeof descriptor.value !== 'function' || descriptor.value !== perfHooksBuiltin[name]) {
    throw new SafeError('Failed to capture global performance constructor ' + name)
  }
  objectDefineProperty(originalPerformanceConstructors, name, {
    configurable: false,
    enumerable: true,
    value: descriptor.value,
    writable: false
  })
}
objectFreeze(originalPerformanceConstructors)
const moduleLocationReplacements = workerData.localModule
  ? workerData.localModule.locationReplacements
  : undefined
if (moduleLocationReplacements) {
  reflectApply(arrayPush, moduleLocationReplacements, [objectFreeze([
    workerData.localModule.rootUrlPrefix,
    'secure-eval-worker-files/'
  ])])
  reflectApply(arrayPush, moduleLocationReplacements, [objectFreeze([
    workerData.localModule.rootPathPrefix,
    'secure-eval-worker-files/'
  ])])
  for (let index = 0; index < moduleLocationReplacements.length; index++) {
    objectFreeze(moduleLocationReplacements[index])
  }
  objectFreeze(moduleLocationReplacements)
  objectFreeze(workerData.localModule)
}
const promisePrototype = SafePromise.prototype
const promisePrototypeConstructorDescriptor = objectFreeze(
  objectGetOwnPropertyDescriptor(promisePrototype, 'constructor')
)
const promiseSpeciesDescriptor = objectFreeze(
  objectGetOwnPropertyDescriptor(SafePromise, Symbol.species)
)
const PROMISE_DESCRIPTOR_FIELDS = objectFreeze([
  'configurable', 'enumerable', 'writable', 'value', 'get', 'set'
])
const PROMISE_CONSTRUCTOR_DESCRIPTOR = objectFreeze({
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false
})
const AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR = objectFreeze({
  configurable: false,
  enumerable: false,
  value: SafePromise,
  writable: false
})
const arrayPrototype = Array.prototype
const arrayBufferPrototype = ArrayBuffer.prototype
const datePrototype = Date.prototype
const regexpPrototype = RegExp.prototype
const syntaxErrorPrototype = SafeSyntaxError.prototype
const mapPrototype = Map.prototype
const setPrototype = Set.prototype
const allowedViewPrototypes = new Set([
  dataViewPrototype,
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
  Buffer.prototype
])
const stringSlice = String.prototype.slice
const stringSplit = String.prototype.split
const stringIndexOf = String.prototype.indexOf
const stringCharCodeAt = String.prototype.charCodeAt
const stringPadStart = String.prototype.padStart
const numberToString = Number.prototype.toString
const bufferByteLength = Buffer.byteLength
const bufferFrom = Buffer.from
const moduleFileReaders = objectFreeze(Object.fromEntries(
  [
    'accessSync', 'closeSync', 'existsSync', 'fstatSync', 'lstatSync', 'openSync',
    'readFileSync', 'readSync', 'readvSync', 'realpathSync', 'statSync'
  ].map((name) => [name, fsBuiltin[name]])
))
const moduleFileDescriptors = objectCreate(null)
moduleFileDescriptors.count = 0
const processFileDescriptorSlots = workerData.localModule
  ? new Int32Array(workerData.localModule.globalDescriptorSlots)
  : undefined

let port
let rawPostToHost
let closePort
let protocolSecret
let inboundSequence = 0
let outboundSequence = 0
let keepAlive
let diagnosticPort
let rawPostDiagnostic
let closeDiagnosticPort
let diagnosticSecret
let diagnosticSequence = 0
let diagnosticRecords = 0
let diagnosticBytes = 0
let handler
const controlPromises = new SafeWeakSet()
const promiseSettlementGuardedValues = new SafeWeakSet()
let processing = SafePromise.resolve()
let nextHostCallId = 1
let outputMessages = 0
let outputBytes = 0
const pendingHostCalls = new Map()

function hardenPromise(promise) {
  const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [
    promise,
    'constructor'
  ])
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
      descriptor.value !== undefined || descriptor.writable !== false ||
      descriptor.enumerable !== false || descriptor.configurable !== false) {
    reflectApply(objectDefineProperty, undefined, [
      promise,
      'constructor',
      PROMISE_CONSTRUCTOR_DESCRIPTOR
    ])
  }
  reflectApply(weakSetAdd, controlPromises, [promise])
  return promise
}

function createValueOutcome(value) {
  const outcome = objectCreate(null)
  reflectApply(objectDefineProperty, undefined, [outcome, 'value', {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  }])
  return objectFreeze(outcome)
}

function settleOwnedValue(resolve, reject, value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    resolve(value)
    return
  }
  try {
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [value, 'then'])
    if (descriptor !== undefined) {
      if (!reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
          typeof descriptor.value === 'function') {
        reject(new TypeError('Protocol value cannot be settled safely'))
        return
      }
      resolve(value)
      return
    }
    if (!reflectApply(objectIsExtensible, undefined, [value])) {
      reject(new TypeError('Protocol value cannot be settled safely'))
      return
    }
    reflectApply(objectDefineProperty, undefined, [value, 'then', {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: false
    }])
    reflectApply(weakSetAdd, promiseSettlementGuardedValues, [value])
    resolve(value)
  } catch (error) {
    reject(error)
  }
}

function removePromiseSettlementGuard(value) {
  if (!reflectApply(weakSetHas, promiseSettlementGuardedValues, [value])) return
  const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [value, 'then'])
  if (descriptor && reflectApply(objectHasOwn, undefined, [descriptor, 'value']) &&
      descriptor.value === undefined && descriptor.configurable === true &&
      descriptor.enumerable === false && descriptor.writable === false) {
    reflectApply(reflectDeleteProperty, undefined, [value, 'then'])
  }
  reflectApply(weakSetDelete, promiseSettlementGuardedValues, [value])
}

function sameDescriptor(actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected
  for (let index = 0; index < PROMISE_DESCRIPTOR_FIELDS.length; index++) {
    const name = PROMISE_DESCRIPTOR_FIELDS[index]
    const actualHas = reflectApply(objectHasOwn, undefined, [actual, name])
    const expectedHas = reflectApply(objectHasOwn, undefined, [expected, name])
    if (actualHas !== expectedHas || (actualHas && actual[name] !== expected[name])) return false
  }
  return true
}

function isCanonicalPromise(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  if (reflectApply(isProxy, utilTypesBuiltin, [value]) ||
      !reflectApply(isPromise, utilTypesBuiltin, [value])) return false
  try {
    return objectGetPrototypeOf(value) === promisePrototype &&
      objectGetOwnPropertyDescriptor(value, 'constructor') === undefined &&
      sameDescriptor(
        objectGetOwnPropertyDescriptor(promisePrototype, 'constructor'),
        promisePrototypeConstructorDescriptor
      ) &&
      sameDescriptor(
        objectGetOwnPropertyDescriptor(SafePromise, Symbol.species),
        promiseSpeciesDescriptor
      )
  } catch {
    return false
  }
}

function unsafePromiseRejection() {
  return bridgeControlPromise(createPromise((resolve, reject) => {
    reject(new TypeError('Promise cannot be observed safely'))
  }))
}

function adoptValue(value) {
  const objectLike = (typeof value === 'object' && value !== null) || typeof value === 'function'
  if (objectLike && reflectApply(isProxy, utilTypesBuiltin, [value])) {
    return unsafePromiseRejection()
  }
  if (!reflectApply(isPromise, utilTypesBuiltin, [value])) {
    return bridgeControlPromise(createPromise(resolve => {
      resolve(createValueOutcome(value))
    }))
  }
  if (objectLike && reflectApply(weakSetHas, controlPromises, [value])) {
    const control = createPromise((resolve, reject) => {
      reflectApply(promiseThen, value, [
        result => resolve(createValueOutcome(result)),
        reject
      ])
    })
    return bridgeControlPromise(control)
  }
  if (!isCanonicalPromise(value)) return unsafePromiseRejection()

  const control = createPromise((resolve, reject) => {
    try {
      reflectApply(promiseThen, value, [
        result => resolve(createValueOutcome(result)),
        reject
      ])
    } catch (error) {
      reject(error)
    }
  })
  return bridgeControlPromise(control)
}

function hardenAwaitPromise(promise) {
  reflectApply(objectDefineProperty, undefined, [
    promise,
    'constructor',
    AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR
  ])
  return promise
}

function createPromise(executor) {
  return hardenPromise(new SafePromise(executor))
}

function bridgeControlPromise(promise) {
  const bridge = new SafePromise((resolve, reject) => {
    reflectApply(promiseThen, promise, [resolve, reject])
  })
  return hardenAwaitPromise(bridge)
}

function thenPromise(promise, onFulfilled, onRejected) {
  hardenPromise(promise)
  return hardenPromise(reflectApply(promiseThen, promise, [onFulfilled, onRejected]))
}

function isSharedArrayBuffer(value) {
  if (!sharedByteLength || value === null || typeof value !== 'object') return false
  try {
    reflectApply(sharedByteLength, value, [])
    return true
  } catch {
    return false
  }
}

function getWasmMemoryBuffer(value) {
  try {
    return reflectApply(wasmMemoryBuffer, value, [])
  } catch {
    return undefined
  }
}

function getViewBuffer(value) {
  try {
    return reflectApply(typedArrayBuffer, value, [])
  } catch {
    return reflectApply(dataViewBuffer, value, [])
  }
}

function unsupportedProtocolValue() {
  throw new TypeError('Unsupported protocol value')
}

function traversalLimitError(maxBytes) {
  throw new RangeError('Protocol message exceeds maxMessageBytes (' + maxBytes + ')')
}

function createTraversalBudget(maxBytes) {
  return {
    maxBytes,
    objectNodes: 0,
    graphEdges: 0,
    properties: 0,
    collectionEntries: 0,
    stringCodeUnits: 0,
    backingBufferBytes: 0,
    backingBuffers: new SafeWeakSet()
  }
}

function chargeTraversalBudget(budget, field, amount) {
  if (budget.maxBytes === undefined || amount === 0) return
  if (!reflectApply(numberIsSafeInteger, SafeNumber, [amount]) || amount < 0 ||
      budget[field] > budget.maxBytes - amount) {
    traversalLimitError(budget.maxBytes)
  }
  budget[field] += amount
}

function chargeString(budget, value) {
  chargeTraversalBudget(budget, 'stringCodeUnits', value.length === 0 ? 1 : value.length)
}

function isCanonicalArrayIndex(key) {
  const numeric = +key
  return reflectApply(numberIsSafeInteger, SafeNumber, [numeric]) && numeric >= 0 &&
    numeric < 0xffffffff && SafeString(numeric) === key
}

function reservePending(budget, pending, amount) {
  if (budget.maxBytes === undefined) return
  const limit = budget.maxBytes === maxSafeInteger
    ? maxSafeInteger
    : budget.maxBytes + 1
  if (!reflectApply(numberIsSafeInteger, SafeNumber, [amount]) || amount < 0 ||
      pending.length > limit - amount) {
    traversalLimitError(budget.maxBytes)
  }
}

function assertNoOwnProperties(value, budget) {
  const keys = reflectOwnKeys(value)
  chargeTraversalBudget(budget, 'properties', keys.length)
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] === 'string') chargeString(budget, keys[index])
  }
  if (keys.length !== 0) unsupportedProtocolValue()
}

function assertCanonicalRegExpProperties(value, budget) {
  const keys = reflectOwnKeys(value)
  if (keys.length !== 1 || keys[0] !== 'lastIndex') unsupportedProtocolValue()
  chargeTraversalBudget(budget, 'properties', 1)
  const descriptors = objectGetOwnPropertyDescriptors(value)
  const descriptor = descriptors.lastIndex
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
      typeof descriptor.value !== 'number' ||
      !reflectApply(numberIsSafeInteger, SafeNumber, [descriptor.value]) ||
      descriptor.value < 0 || descriptor.enumerable || descriptor.configurable ||
      descriptor.writable !== true) {
    unsupportedProtocolValue()
  }
}

function chargeArrayBuffer(buffer, budget) {
  if (reflectApply(weakSetHas, budget.backingBuffers, [buffer])) return
  reflectApply(weakSetAdd, budget.backingBuffers, [buffer])
  chargeTraversalBudget(
    budget,
    'backingBufferBytes',
    reflectApply(arrayBufferByteLength, buffer, [])
  )
}

function assertViewWithinBudget(value, budget) {
  const buffer = getViewBuffer(value)
  if (!isSharedArrayBuffer(buffer)) chargeArrayBuffer(buffer, budget)
}

function assertCanonicalViewProperties(value, budget) {
  const prototype = objectGetPrototypeOf(value)
  if (prototype === dataViewPrototype) {
    assertNoOwnProperties(value, budget)
    return
  }
  const length = reflectApply(typedArrayLength, value, [])
  chargeTraversalBudget(budget, 'properties', length)
  const keys = reflectOwnKeys(value)
  if (keys.length !== length) unsupportedProtocolValue()
  const descriptors = objectGetOwnPropertyDescriptors(value)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key !== 'string') unsupportedProtocolValue()
    const numeric = +key
    const descriptor = descriptors[key]
    if (!reflectApply(numberIsSafeInteger, SafeNumber, [numeric]) || numeric < 0 ||
        numeric >= length || SafeString(numeric) !== key || !descriptor ||
        !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
        descriptor.writable !== true ||
        descriptor.enumerable !== true || descriptor.configurable !== true) {
      unsupportedProtocolValue()
    }
  }
}

function sandboxDenied(api) {
  const error = new SafeError(api + ' is disabled for untrusted code')
  objectDefineProperty(error, 'code', {
    configurable: true,
    enumerable: true,
    value: 'ERR_ACCESS_DENIED',
    writable: true
  })
  objectDefineProperty(error, 'permission', {
    configurable: true,
    enumerable: true,
    value: 'SandboxEscape',
    writable: true
  })
  throw error
}

function replaceProperty(target, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)
  const dataDescriptor = descriptor &&
    reflectApply(objectHasOwn, undefined, [descriptor, 'value'])
  if (!descriptor || descriptor.configurable || (dataDescriptor && descriptor.writable)) {
    objectDefineProperty(target, name, {
      value,
      enumerable: descriptor ? descriptor.enumerable : true,
      configurable: false,
      writable: false
    })
  }
}

function replaceAndVerifyDataProperty(target, name, value) {
  replaceProperty(target, name, value)
  const descriptor = objectGetOwnPropertyDescriptor(target, name)
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
      descriptor.value !== value || descriptor.writable || descriptor.configurable) {
    throw new SafeError('Failed to virtualize ' + name)
  }
}

function denyFunctions(target, prefix, allowedNames) {
  for (const [name, descriptor] of Object.entries(objectGetOwnPropertyDescriptors(target))) {
    // Several security-sensitive builtins expose callable constructors through
    // configurable accessors rather than ordinary value properties.
    if ((!allowedNames || !reflectApply(setHas, allowedNames, [name])) &&
        (!reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
         typeof descriptor.value === 'function')) {
      replaceProperty(target, name, function deniedBuiltin() {
        return sandboxDenied(prefix + '.' + name)
      })
    }
  }
}

const deniedNetworkAgentObjects = new SafeWeakSet()

function denyNetworkAgentPrototypeChain(target, prefix) {
  let current = target
  while (current && current !== objectPrototype && current !== eventEmitterPrototype &&
         !reflectApply(weakSetHas, deniedNetworkAgentObjects, [current])) {
    reflectApply(weakSetAdd, deniedNetworkAgentObjects, [current])
    const descriptors = objectGetOwnPropertyDescriptors(current)
    const keys = reflectOwnKeys(current)
    const next = objectGetPrototypeOf(current)
    for (let index = 0; index < keys.length; index++) {
      const name = keys[index]
      const descriptor = descriptors[name]
      if (reflectApply(objectHasOwn, undefined, [descriptor, 'value']) &&
          typeof descriptor.value !== 'function') continue
      const denied = function deniedNetworkAgentOperation() {
        return sandboxDenied(prefix + '.' + SafeString(name))
      }
      replaceProperty(current, name, denied)
      const replacement = objectGetOwnPropertyDescriptor(current, name)
      if (!replacement ||
          !reflectApply(objectHasOwn, undefined, [replacement, 'value']) ||
          replacement.value !== denied || replacement.writable || replacement.configurable) {
        throw new SafeError('Failed to disable ' + prefix + '.' + SafeString(name))
      }
    }
    current = next
  }
}

function sanitizeDiagnosticText(value) {
  const source = reflectApply(stringSlice, SafeString(value), [0, 2_048])
  let result = ''
  for (let index = 0; index < source.length; index++) {
    const code = reflectApply(stringCharCodeAt, source, [index])
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 ||
        code === 0x2029 || (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)) {
      const hexadecimal = reflectApply(numberToString, code, [16])
      result += '\\u' + reflectApply(stringPadStart, hexadecimal, [4, '0'])
    } else {
      result += source[index]
    }
  }
  return result
}

function formatDiagnosticValue(value) {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'string') return sanitizeDiagnosticText(value)
  if (kind === 'undefined' || kind === 'boolean' || kind === 'number' || kind === 'bigint') {
    return sanitizeDiagnosticText(value)
  }
  if (kind === 'symbol') return '[Symbol]'
  if (kind === 'function') return '[Function]'
  try {
    if (reflectApply(arrayIsArray, undefined, [value])) return '[Array]'
    if (reflectApply(arrayBufferIsView, undefined, [value])) return '[ArrayBufferView]'
  } catch {
    return '[Uninspectable]'
  }
  try {
    reflectApply(dateTime, value, [])
    return '[Date]'
  } catch {}
  try {
    reflectApply(regexpSource, value, [])
    return '[RegExp]'
  } catch {}
  return '[Object]'
}

function postDiagnostic(level, values) {
  if (!rawPostDiagnostic || diagnosticRecords >= workerData.diagnostics.maxRecords) return
  let text = ''
  for (let index = 0; index < values.length; index++) {
    if (index > 0) text += ' '
    text += formatDiagnosticValue(values[index])
    if (text.length > 2_048) {
      text = reflectApply(stringSlice, text, [0, 2_048])
      break
    }
  }
  const record = { level, text }
  const serialized = safeV8Serialize(record)
  const byteLength = reflectApply(typedArrayByteLength, serialized, [])
  if (byteLength > workerData.diagnostics.maxRecordBytes ||
      diagnosticBytes + byteLength > workerData.diagnostics.maxBytes) return
  diagnosticRecords++
  diagnosticBytes += byteLength
  const sequence = ++diagnosticSequence
  rawPostDiagnostic({
    sequence,
    payload: serialized,
    mac: protocolMac('worker-diagnostic-to-host', sequence, serialized, diagnosticSecret)
  })
}

function reserveProcessFileDescriptor() {
  const owner = workerData.localModule.descriptorOwner
  const start = owner % processFileDescriptorSlots.length
  for (let offset = 0; offset < processFileDescriptorSlots.length; offset++) {
    const index = (start + offset) % processFileDescriptorSlots.length
    if (reflectApply(hostAtomicsCompareExchange, safeAtomics, [
      processFileDescriptorSlots,
      index,
      0,
      owner
    ]) === 0) return index
  }
  return -1
}

function releaseProcessFileDescriptor(slot) {
  reflectApply(hostAtomicsCompareExchange, safeAtomics, [
    processFileDescriptorSlots,
    slot,
    workerData.localModule.descriptorOwner,
    0
  ])
}

function hardenFileSystemForModuleLoading() {
  const descriptorReaders = new Set(['closeSync', 'fstatSync', 'readSync', 'readvSync'])
  for (const [name, descriptor] of Object.entries(objectGetOwnPropertyDescriptors(fsBuiltin))) {
    const reader = moduleFileReaders[name]
    if (typeof reader === 'function') {
      replaceProperty(fsBuiltin, name, function permittedModuleRead(...args) {
        // Node's Permission Model does not re-check already-open descriptors.
        // Track descriptors opened through this root-confined facade and reject
        // inherited process descriptors even when their numeric values are
        // guessed by guest code.
        if (name === 'openSync') {
          if (moduleFileDescriptors.count >= workerData.localModule.maxOpenFileDescriptors) {
            const error = new RangeError('Worker file descriptor limit exceeded')
            objectDefineProperty(error, 'code', {
              configurable: true,
              enumerable: true,
              value: 'ERR_UNTRUSTED_FILE_DESCRIPTOR_LIMIT',
              writable: true
            })
            throw error
          }
          const descriptorSlot = reserveProcessFileDescriptor()
          if (descriptorSlot < 0) {
            const error = new RangeError('Process file descriptor limit exceeded')
            objectDefineProperty(error, 'code', {
              configurable: true,
              enumerable: true,
              value: 'ERR_UNTRUSTED_FILE_DESCRIPTOR_CAPACITY',
              writable: true
            })
            throw error
          }
          try {
            const fd = reflectApply(reader, fsBuiltin, args)
            moduleFileDescriptors[fd] = descriptorSlot
            moduleFileDescriptors.count++
            return fd
          } catch (error) {
            releaseProcessFileDescriptor(descriptorSlot)
            throw error
          }
        }
        if (reflectApply(setHas, descriptorReaders, [name])) {
          const fd = args[0]
          if (typeof fd !== 'number' || !objectHasOwn(moduleFileDescriptors, fd)) {
            return sandboxDenied('node:fs.' + name)
          }
          if (name === 'closeSync') {
            const result = reflectApply(reader, fsBuiltin, args)
            const descriptorSlot = moduleFileDescriptors[fd]
            delete moduleFileDescriptors[fd]
            moduleFileDescriptors.count--
            releaseProcessFileDescriptor(descriptorSlot)
            return result
          }
          return reflectApply(reader, fsBuiltin, args)
        }
        if (typeof args[0] === 'number') return sandboxDenied('node:fs.' + name)
        return reflectApply(reader, fsBuiltin, args)
      })
    } else if (!reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
               typeof descriptor.value === 'function') {
      replaceProperty(fsBuiltin, name, function deniedFileSystemApi() {
        return sandboxDenied('node:fs.' + name)
      })
    }
  }
  denyFunctions(fsPromisesBuiltin, 'node:fs/promises')
}

function hardenDangerousBuiltins() {
  // Existing numeric file descriptors bypass Node's Permission Model and are
  // shared by every thread. Source-string workers disable the complete fs
  // surface. File-module workers retain only path-based synchronous readers
  // needed by Node's loader; the permission root confines those reads.
  denyFunctions(asyncHooksBuiltin, 'node:async_hooks')
  denyFunctions(childProcessBuiltin, 'node:child_process')
  if (workerData.localModule) hardenFileSystemForModuleLoading()
  else {
    denyFunctions(fsBuiltin, 'node:fs')
    denyFunctions(fsPromisesBuiltin, 'node:fs/promises')
  }
  denyFunctions(ttyBuiltin, 'node:tty')
  denyFunctions(netBuiltin, 'node:net')
  denyFunctions(tlsBuiltin, 'node:tls')
  denyFunctions(dgramBuiltin, 'node:dgram')
  denyFunctions(dnsBuiltin, 'node:dns')
  denyFunctions(dnsPromisesBuiltin, 'node:dns/promises')
  denyNetworkAgentPrototypeChain(httpGlobalAgent, 'node:http.globalAgent')
  denyNetworkAgentPrototypeChain(httpsGlobalAgent, 'node:https.globalAgent')
  denyFunctions(httpBuiltin, 'node:http')
  denyFunctions(http2Builtin, 'node:http2')
  denyFunctions(httpsBuiltin, 'node:https')
  if (traceEventsBuiltin) denyFunctions(traceEventsBuiltin, 'node:trace_events')
  if (quicBuiltin) denyFunctions(quicBuiltin, 'node:quic')
  replaceProperty(cryptoBuiltin, 'setEngine', () => sandboxDenied('node:crypto.setEngine'))
  replaceProperty(cryptoBuiltin, 'setFips', () => sandboxDenied('node:crypto.setFips'))
  replaceProperty(cryptoBuiltin, 'secureHeapUsed', () => sandboxDenied('node:crypto.secureHeapUsed'))
  for (const builtin of networkAliasBuiltins) {
    denyFunctions(builtin, 'internal network builtin')
  }

  // Asynchronous customization hooks execute in an InternalWorker, which does
  // not inherit this realm's permission drop or builtin hardening.
  const originalGlobalPaths = moduleBuiltin.globalPaths
  if (reflectApply(arrayIsArray, undefined, [originalGlobalPaths])) {
    reflectApply(arraySplice, originalGlobalPaths, [0, originalGlobalPaths.length])
  }
  const hiddenGlobalPaths = objectFreeze([])
  replaceProperty(moduleBuiltin, 'globalPaths', hiddenGlobalPaths)
  replaceProperty(moduleBuiltin.Module, 'globalPaths', hiddenGlobalPaths)
  replaceProperty(moduleBuiltin, '_cache', objectCreate(null))
  replaceProperty(moduleBuiltin, '_pathCache', objectCreate(null))
  const restrictModulePaths = (paths) => {
    if (!reflectApply(arrayIsArray, undefined, [paths])) return paths
    const filtered = []
    if (!workerData.localModule) return filtered
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]
      if (path === workerData.localModule.rootPath ||
          reflectApply(stringIndexOf, path, [workerData.localModule.rootPathPrefix]) === 0) {
        reflectApply(arrayPush, filtered, [path])
      }
    }
    return filtered
  }
  replaceProperty(moduleBuiltin, '_nodeModulePaths', function restrictedNodeModulePaths(from) {
    return restrictModulePaths(
      reflectApply(moduleNodeModulePaths, moduleBuiltin, [from])
    )
  })
  replaceProperty(moduleBuiltin, '_resolveLookupPaths', function restrictedLookupPaths(request, parent) {
    return restrictModulePaths(
      reflectApply(moduleResolveLookupPaths, moduleBuiltin, [request, parent])
    )
  })
  replaceProperty(moduleBuiltin, '_load', function restrictedModuleLoad(request, parent, isMain) {
    if (request === 'trace_events' || request === 'node:trace_events' ||
        request === 'quic' || request === 'node:quic') {
      return sandboxDenied(request)
    }
    return reflectApply(moduleLoad, moduleBuiltin, [request, parent, isMain])
  })
  replaceProperty(processBuiltin, 'getBuiltinModule', function restrictedGetBuiltinModule(request) {
    if (request === 'trace_events' || request === 'node:trace_events' ||
        request === 'quic' || request === 'node:quic') {
      return sandboxDenied(request)
    }
    return reflectApply(processGetBuiltinModule, processBuiltin, [request])
  })
  for (const name of [
    '_initPaths',
    'register',
    'registerHooks',
    'enableCompileCache',
    'flushCompileCache',
    'getCompileCacheDir'
  ]) {
    replaceProperty(moduleBuiltin, name, () => sandboxDenied('node:module.' + name))
  }

  // node:sqlite performs filesystem access outside the fs permission scope.
  denyFunctions(sqliteBuiltin, 'node:sqlite')

  replaceProperty(processBuiltin, 'argv', objectFreeze(['node', '[secure-eval-worker]']))
  replaceProperty(processBuiltin, 'execArgv', objectFreeze([]))
  replaceAndVerifyDataProperty(processBuiltin, 'pid', 0)
  replaceAndVerifyDataProperty(processBuiltin, 'ppid', 0)
  replaceAndVerifyDataProperty(processBuiltin, 'title', 'secure-eval-worker')
  replaceProperty(
    processBuiltin,
    'execPath',
    processBuiltin.platform === 'win32'
      ? 'C:\\secure-eval-worker\\node.exe'
      : '/secure-eval-worker/node'
  )
  replaceProperty(processBuiltin, 'cwd', () => {
    return processBuiltin.platform === 'win32'
      ? 'C:\\secure-eval-worker'
      : '/secure-eval-worker'
  })
  for (const name of [
    'availableMemory',
    'constrainedMemory',
    'cpuUsage',
    'getegid',
    'geteuid',
    'getgid',
    'getgroups',
    'getuid',
    'memoryUsage',
    'resourceUsage',
    'umask',
    'uptime'
  ]) {
    replaceProperty(processBuiltin, name, () => sandboxDenied('process.' + name))
  }
  // Undocumented native bindings bypass public-module taming and can operate
  // directly on the process-wide descriptor table.
  for (const name of ['binding', '_linkedBinding', 'dlopen']) {
    replaceProperty(processBuiltin, name, () => sandboxDenied('process.' + name))
  }
  replaceProperty(processBuiltin, 'hrtime', () => sandboxDenied('process.hrtime'))
  replaceProperty(processBuiltin, 'kill', () => sandboxDenied('process.kill'))
  replaceProperty(processBuiltin, '_kill', () => sandboxDenied('process._kill'))
  replaceProperty(processBuiltin, '_debugProcess', () => sandboxDenied('process._debugProcess'))
  const deniedReport = objectCreate(null)
  for (const name of ['getReport', 'writeReport']) {
    objectDefineProperty(deniedReport, name, {
      value: () => sandboxDenied('process.report.' + name),
      enumerable: true
    })
  }
  replaceProperty(processBuiltin, 'report', objectFreeze(deniedReport))

  denyFunctions(osBuiltin, 'node:os')

  const virtualPerformance = objectCreate(null)
  objectDefineProperty(virtualPerformance, 'now', {
    configurable: false,
    enumerable: true,
    value: () => reflectApply(performanceNow, performanceBuiltin, []) - performanceBaseline,
    writable: false
  })
  objectDefineProperty(virtualPerformance, 'timeOrigin', {
    configurable: false,
    enumerable: true,
    value: 0,
    writable: false
  })
  objectDefineProperty(virtualPerformance, 'nodeTiming', {
    configurable: false,
    enumerable: true,
    value: null,
    writable: false
  })
  objectFreeze(virtualPerformance)
  replaceAndVerifyDataProperty(perfHooksBuiltin, 'performance', virtualPerformance)
  replaceAndVerifyDataProperty(globalThis, 'performance', virtualPerformance)

  const workerRelativeEventTimeStamp = function workerRelativeEventTimeStamp () {
    const originalTimeStamp = reflectApply(eventTimeStampGet, this, [])
    const relativeTimeStamp = originalTimeStamp - performanceBaseline
    return relativeTimeStamp >= 0 ? relativeTimeStamp : 0
  }
  objectDefineProperty(eventPrototype, 'timeStamp', {
    configurable: false,
    enumerable: true,
    get: workerRelativeEventTimeStamp,
    set: undefined
  })
  const hardenedEventTimeStampDescriptor = objectGetOwnPropertyDescriptor(
    eventPrototype,
    'timeStamp'
  )
  if (!hardenedEventTimeStampDescriptor ||
      hardenedEventTimeStampDescriptor.get !== workerRelativeEventTimeStamp ||
      hardenedEventTimeStampDescriptor.set !== undefined ||
      hardenedEventTimeStampDescriptor.configurable !== false ||
      hardenedEventTimeStampDescriptor.enumerable !== true) {
    throw new SafeError('Failed to virtualize Event timestamps')
  }

  denyFunctions(perfHooksBuiltin, 'node:perf_hooks')
  for (let index = 0; index < performanceConstructorNames.length; index++) {
    const name = performanceConstructorNames[index]
    const replacement = perfHooksBuiltin[name]
    if (typeof replacement !== 'function' ||
        replacement === originalPerformanceConstructors[name]) {
      throw new SafeError('Failed to deny performance constructor ' + name)
    }
    const prototypeDescriptor = objectGetOwnPropertyDescriptor(replacement, 'prototype')
    if (!prototypeDescriptor ||
        !reflectApply(objectHasOwn, undefined, [prototypeDescriptor, 'value']) ||
        prototypeDescriptor.value === null || typeof prototypeDescriptor.value !== 'object') {
      throw new SafeError('Failed to isolate performance constructor ' + name)
    }
    objectFreeze(prototypeDescriptor.value)
    objectFreeze(replacement)
    replaceAndVerifyDataProperty(globalThis, name, replacement)
  }

  // Keep the protocol's previously captured serializer functions private and
  // deny the complete guest-facing V8 module so new profiling, snapshot, or
  // object-query APIs cannot bypass an incomplete name list. V8 also exposes
  // callable APIs through nested namespaces such as promiseHooks and
  // startupSnapshot, so deny every object-valued namespace generically.
  const v8Descriptors = objectGetOwnPropertyDescriptors(v8Builtin)
  const v8Names = reflectOwnKeys(v8Descriptors)
  const startupSnapshotCompatibility = new Set(['isBuildingSnapshot'])
  for (let index = 0; index < v8Names.length; index++) {
    const name = v8Names[index]
    const descriptor = v8Descriptors[name]
    if (reflectApply(objectHasOwn, undefined, [descriptor, 'value']) &&
        descriptor.value !== null && typeof descriptor.value === 'object') {
      denyFunctions(
        descriptor.value,
        'node:v8.' + name,
        name === 'startupSnapshot' ? startupSnapshotCompatibility : undefined
      )
    }
  }
  denyFunctions(v8Builtin, 'node:v8')
  denyFunctions(seaBuiltin, 'node:sea')

  replaceProperty(workerThreadsBuiltin, 'BroadcastChannel', function DeniedBroadcastChannel() {
    return sandboxDenied('node:worker_threads.BroadcastChannel')
  })
  replaceProperty(globalThis, 'BroadcastChannel', function DeniedBroadcastChannel() {
    return sandboxDenied('BroadcastChannel')
  })
  replaceProperty(globalThis, 'fetch', function deniedFetch() {
    return sandboxDenied('fetch')
  })
  replaceProperty(globalThis, 'WebSocket', function DeniedWebSocket() {
    return sandboxDenied('WebSocket')
  })
  replaceProperty(workerThreadsBuiltin, 'postMessageToThread', () => {
    return sandboxDenied('node:worker_threads.postMessageToThread')
  })
  replaceProperty(workerThreadsBuiltin, 'getEnvironmentData', () => {
    return sandboxDenied('node:worker_threads.getEnvironmentData')
  })
  replaceProperty(workerThreadsBuiltin, 'setEnvironmentData', () => {
    return sandboxDenied('node:worker_threads.setEnvironmentData')
  })
  const deniedLocks = objectFreeze({
    query: () => sandboxDenied('node:worker_threads.locks.query'),
    request: () => sandboxDenied('node:worker_threads.locks.request')
  })
  replaceProperty(workerThreadsBuiltin, 'locks', deniedLocks)
  if (globalThis.navigator) replaceProperty(globalThis.navigator, 'locks', deniedLocks)
  replaceProperty(workerThreadsBuiltin, 'parentPort', null)
  replaceProperty(workerThreadsBuiltin, 'workerData', undefined)

  // Eval workers expose their bootstrap CommonJS wrapper through globals.
  // Guest source uses AsyncFunction/data URLs and does not need these objects;
  // local CommonJS modules receive their own lexical require/module bindings.
  replaceProperty(globalThis, 'require', undefined)
  replaceProperty(globalThis, 'module', undefined)
  replaceProperty(globalThis, 'exports', undefined)
  replaceProperty(globalThis, '__filename', undefined)
  replaceProperty(globalThis, '__dirname', undefined)
  replaceProperty(processBuiltin, 'mainModule', undefined)

  const discardOutput = (...args) => {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') callback()
    return false
  }
  for (const stream of [processBuiltin.stdout, processBuiltin.stderr]) {
    if (!stream) continue
    for (const name of ['write', '_write', '_writev', 'end']) {
      replaceProperty(stream, name, discardOutput)
    }
    const prototype = objectGetPrototypeOf(stream)
    for (const name of ['write', '_write', '_writev', 'end']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      if (descriptor && reflectApply(objectHasOwn, undefined, [descriptor, 'value']) &&
          typeof descriptor.value === 'function') {
        replaceProperty(prototype, name, discardOutput)
      }
    }
  }
  replaceProperty(processBuiltin, '_rawDebug', () => {})
  for (const name of ['assert', 'debug', 'dir', 'error', 'info', 'log', 'table', 'trace', 'warn']) {
    const replacement = workerData.diagnostics.enabled
      ? (...values) => postDiagnostic(name, values)
      : () => {}
    replaceProperty(globalThis.console, name, replacement)
  }

  // Update named ESM exports to the hardened CommonJS export values. Calling
  // syncBuiltinESMExports() again cannot recover the original functions.
  moduleBuiltin.syncBuiltinESMExports()
}

function assertNoSharedMemory(value, label, maxBytes) {
  assertSupportedProtocolValue(value, label, maxBytes)
}

function cloneValue(value, label) {
  assertSupportedProtocolValue(value, label, workerData.maxMessageBytes)
  const cloned = safeStructuredClone(value)
  assertSupportedProtocolValue(cloned, label, workerData.maxMessageBytes)
  return cloned
}

function assertSupportedProtocolValue(value, label, maxBytes = workerData.maxMessageBytes) {
  const budget = createTraversalBudget(maxBytes)
  const pending = [value]
  const seen = new SafeWeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null) continue
    const kind = typeof current
    if (kind === 'string') {
      chargeString(budget, current)
      continue
    }
    if (kind === 'boolean' || kind === 'number' || kind === 'bigint' ||
        kind === 'undefined') continue
    if (kind !== 'object' || reflectApply(isProxy, utilTypesBuiltin, [current])) {
      throw new TypeError('Unsupported protocol value')
    }
    removePromiseSettlementGuard(current)
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])
    chargeTraversalBudget(budget, 'objectNodes', 1)

    if (isSharedArrayBuffer(current)) {
      throw new TypeError(label + ' must not contain shared memory')
    }
    const memoryBuffer = getWasmMemoryBuffer(current)
    if (memoryBuffer !== undefined) {
      if (isSharedArrayBuffer(memoryBuffer)) {
        throw new TypeError(label + ' must not contain shared memory')
      }
      throw new TypeError('Unsupported protocol value')
    }
    let branded = false
    try {
      reflectApply(arrayBufferByteLength, current, [])
      branded = true
    } catch {}
    if (branded) {
      if (objectGetPrototypeOf(current) !== arrayBufferPrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      chargeArrayBuffer(current, budget)
      assertNoOwnProperties(current, budget)
      continue
    }
    if (reflectApply(arrayBufferIsView, undefined, [current])) {
      if (isSharedArrayBuffer(getViewBuffer(current))) {
        throw new TypeError(label + ' must not contain shared memory')
      }
      if (!reflectApply(setHas, allowedViewPrototypes, [objectGetPrototypeOf(current)])) {
        throw new TypeError('Unsupported protocol value')
      }
      assertViewWithinBudget(current, budget)
      assertCanonicalViewProperties(current, budget)
      continue
    }
    try {
      reflectApply(dateTime, current, [])
      branded = true
    } catch {
      branded = false
    }
    if (branded) {
      if (objectGetPrototypeOf(current) !== datePrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      assertNoOwnProperties(current, budget)
      continue
    }
    try {
      reflectApply(regexpSource, current, [])
      branded = true
    } catch {
      branded = false
    }
    if (branded) {
      if (objectGetPrototypeOf(current) !== regexpPrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      assertCanonicalRegExpProperties(current, budget)
      continue
    }

    let collectionSize
    try {
      collectionSize = reflectApply(mapSize, current, [])
    } catch {}
    if (collectionSize !== undefined) {
      if (objectGetPrototypeOf(current) !== mapPrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      assertNoOwnProperties(current, budget)
      chargeTraversalBudget(budget, 'collectionEntries', collectionSize)
      if (maxBytes !== undefined &&
          collectionSize > reflectApply(mathFloor, undefined, [maxBytes / 2])) {
        traversalLimitError(maxBytes)
      }
      const edgeCount = collectionSize * 2
      chargeTraversalBudget(budget, 'graphEdges', edgeCount)
      reservePending(budget, pending, edgeCount)
      const iterator = reflectApply(mapEntries, current, [])
      for (let index = 0; index < collectionSize; index++) {
        const item = reflectApply(mapIteratorNext, iterator, [])
        if (item.done) unsupportedProtocolValue()
        reflectApply(arrayPush, pending, [item.value[0], item.value[1]])
      }
      if (!reflectApply(mapIteratorNext, iterator, []).done) unsupportedProtocolValue()
      continue
    }
    try {
      collectionSize = reflectApply(setSize, current, [])
    } catch {
      collectionSize = undefined
    }
    if (collectionSize !== undefined) {
      if (objectGetPrototypeOf(current) !== setPrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      assertNoOwnProperties(current, budget)
      chargeTraversalBudget(budget, 'collectionEntries', collectionSize)
      chargeTraversalBudget(budget, 'graphEdges', collectionSize)
      reservePending(budget, pending, collectionSize)
      const iterator = reflectApply(setValues, current, [])
      for (let index = 0; index < collectionSize; index++) {
        const item = reflectApply(setIteratorNext, iterator, [])
        if (item.done) unsupportedProtocolValue()
        reflectApply(arrayPush, pending, [item.value])
      }
      if (!reflectApply(setIteratorNext, iterator, []).done) unsupportedProtocolValue()
      continue
    }

    const isArray = reflectApply(arrayIsArray, undefined, [current])
    const prototype = objectGetPrototypeOf(current)
    if ((isArray && prototype !== arrayPrototype) ||
        (!isArray && prototype !== objectPrototype && prototype !== null)) {
      throw new TypeError('Unsupported protocol value')
    }
    const keys = reflectOwnKeys(current)
    let propertyCount = keys.length
    if (isArray) propertyCount--
    chargeTraversalBudget(budget, 'properties', propertyCount)
    chargeTraversalBudget(budget, 'graphEdges', propertyCount)
    reservePending(budget, pending, propertyCount)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (isArray && key === 'length') continue
      if (typeof key === 'symbol') throw new TypeError('Unsupported protocol value')
      if (!isArray || !isCanonicalArrayIndex(key)) chargeString(budget, key)
    }
    const descriptors = objectGetOwnPropertyDescriptors(current)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (isArray && key === 'length') continue
      const descriptor = descriptors[key]
      if (!descriptor.enumerable ||
          !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
        throw new TypeError('Unsupported protocol value')
      }
      reflectApply(arrayPush, pending, [descriptor.value])
    }
  }
}

function serializeProtocolBody(body) {
  assertSupportedProtocolValue(body, 'message')
  const serialized = safeV8Serialize(body)
  const byteLength = reflectApply(typedArrayByteLength, serialized, [])
  if (byteLength > workerData.maxMessageBytes) {
    throw new RangeError('Protocol message exceeds maxMessageBytes (' + workerData.maxMessageBytes + ')')
  }
  return serialized
}

function reportFatal(error) {
  try {
    postToHost({ type: 'fatal', error: cloneError(error) })
  } catch {
    try {
      postToHost({
        type: 'fatal',
        error: { name: 'Error', message: 'Worker protocol failure' }
      })
    } catch {
      closePort()
      if (closeDiagnosticPort) closeDiagnosticPort()
    }
  }
}

function protocolMac(direction, sequence, serialized, secret = protocolSecret) {
  const hmac = createHmac('sha256', secret)
  reflectApply(hmacUpdate, hmac, [direction + '\0' + String(sequence) + '\0'])
  reflectApply(hmacUpdate, hmac, [serialized])
  return reflectApply(hmacDigest, hmac, ['base64'])
}

function postToHost(body, countAgainstOutput = false) {
  if (!reflectApply(objectHasOwn, undefined, [body, 'diagnosticSequence'])) {
    objectDefineProperty(body, 'diagnosticSequence', {
      value: diagnosticSequence,
      enumerable: true
    })
  }
  const serialized = serializeProtocolBody(body)
  const byteLength = reflectApply(typedArrayByteLength, serialized, [])
  if (countAgainstOutput) {
    if (outputMessages >= workerData.maxOutputMessages ||
        outputBytes + byteLength > workerData.maxOutputBytes) {
      throw new RangeError('Output limit exceeded')
    }
    outputMessages++
    outputBytes += byteLength
  }
  const sequence = ++outboundSequence
  rawPostToHost({
    sequence,
    payload: serialized,
    mac: protocolMac('worker-to-host', sequence, serialized)
  })
}

function authenticateHostMessage(envelope) {
  let authenticated = false
  let serialized
  if (envelope !== null && typeof envelope === 'object' &&
      reflectApply(numberIsSafeInteger, SafeNumber, [envelope.sequence]) &&
      envelope.sequence === inboundSequence + 1 &&
      envelope.payload !== null && typeof envelope.payload === 'object' &&
      reflectApply(arrayBufferIsView, undefined, [envelope.payload]) &&
      typeof envelope.mac === 'string') {
    serialized = envelope.payload
    const byteLength = reflectApply(typedArrayByteLength, serialized, [])
    authenticated = byteLength <= workerData.maxMessageBytes &&
      envelope.mac === protocolMac('host-to-worker', envelope.sequence, serialized)
  }
  if (!authenticated) throw new Error('Unauthenticated host protocol message')
  const body = safeV8Deserialize(serialized)
  assertSupportedProtocolValue(body, 'message')
  inboundSequence = envelope.sequence
  return body
}

function limitedString(value, fallback) {
  if (typeof value !== 'string') return fallback
  return reflectApply(stringSlice, value, [0, 8_192])
}

function virtualizeModuleLocations(value) {
  if (!workerData.localModule || typeof value !== 'string') return value
  let result = value
  for (let index = 0; index < moduleLocationReplacements.length; index++) {
    const replacements = moduleLocationReplacements
    const location = replacements[index][0]
    const replacement = replacements[index][1]
    result = reflectApply(arrayJoin, reflectApply(stringSplit, result, [location]), [replacement])
  }
  return result
}

function normalizedGuestStack(stack) {
  if (typeof stack !== 'string') return undefined
  let boundedStack = reflectApply(stringSlice, stack, [0, 8_192])
  if (workerData.localModule && stack.length > boundedStack.length) {
    // Never cut through a private staging location before replacing it. A
    // partial prefix would not match virtualizeModuleLocations() and could
    // disclose the randomized snapshot path at the diagnostic size boundary.
    for (let index = 0; index < moduleLocationReplacements.length; index++) {
      const location = moduleLocationReplacements[index][0]
      const maximumOverlap = location.length - 1 < boundedStack.length
        ? location.length - 1
        : boundedStack.length
      for (let overlap = maximumOverlap; overlap > 0; overlap--) {
        if (reflectApply(stringSlice, boundedStack, [-overlap]) ===
            reflectApply(stringSlice, location, [0, overlap])) {
          boundedStack = reflectApply(stringSlice, boundedStack, [0, -overlap])
          break
        }
      }
    }
  }
  const lines = reflectApply(stringSplit, boundedStack, ['\n'])
  const markers = [
    ['secure-eval-worker-one-shot.js:', 3],
    ['secure-eval-worker-component.js:', 3],
    ['secure-eval-worker-component.mjs:', 0],
    ['secure-eval-worker-one-shot.ts:', 1],
    ['secure-eval-worker-component.ts:', 1],
    ['secure-eval-worker-component.mts:', 0],
    ['secure-eval-worker-one-shot.syntax.js:', 1],
    ['secure-eval-worker-component.syntax.js:', 1],
    ['secure-eval-worker-component.syntax.mjs:', 0]
  ]
  let result = ''
  for (let index = 0; index < lines.length; index++) {
    let line = virtualizeModuleLocations(lines[index])
    let selectedMarker
    let markerIndex = -1
    const fileMarkerIndex = reflectApply(stringIndexOf, line, ['secure-eval-worker-files/'])
    if (fileMarkerIndex >= 0) {
      selectedMarker = ['secure-eval-worker-files/', 0]
      markerIndex = fileMarkerIndex
    }
    for (let markerOffset = 0; !selectedMarker && markerOffset < markers.length; markerOffset++) {
      const candidate = markers[markerOffset]
      const candidateIndex = reflectApply(stringIndexOf, line, [candidate[0]])
      if (candidateIndex >= 0) {
        selectedMarker = candidate
        markerIndex = candidateIndex
        break
      }
    }
    if (selectedMarker) {
      const lineStart = markerIndex + selectedMarker[0].length
      const separatorIndex = reflectApply(stringIndexOf, line, [':', lineStart])
      const lineEnd = separatorIndex < 0 ? line.length : separatorIndex
      if (selectedMarker[1] > 0 && lineEnd > lineStart) {
        const sourceLine = SafeNumber(reflectApply(stringSlice, line, [lineStart, lineEnd]))
        if (reflectApply(numberIsSafeInteger, SafeNumber, [sourceLine]) &&
            sourceLine > selectedMarker[1]) {
          line = reflectApply(stringSlice, line, [0, lineStart]) +
            SafeString(sourceLine - selectedMarker[1]) +
            reflectApply(stringSlice, line, [lineEnd])
        }
      }
    }
    if (index > 0) result += '\n'
    result += sanitizeDiagnosticText(line)
  }
  return result
}

function isSyntaxError(value) {
  if (value === null || typeof value !== 'object') return false
  try {
    return reflectApply(isNativeError, utilTypesBuiltin, [value]) &&
      objectGetPrototypeOf(value) === syntaxErrorPrototype
  } catch {
    return false
  }
}

function cloneError(error) {
  try {
    if (error !== null && typeof error === 'object' &&
        reflectApply(isNativeError, utilTypesBuiltin, [error])) {
      const name = sanitizeDiagnosticText(limitedString(error.name, 'Error'))
      const message = sanitizeDiagnosticText(virtualizeModuleLocations(
        limitedString(error.message, 'Untrusted component failed')
      ))
      const code = limitedString(error.code, undefined)
      return {
        name,
        message,
        stack: normalizedGuestStack(error.stack),
        code: code === undefined ? undefined : sanitizeDiagnosticText(code)
      }
    }
    return {
      name: 'Error',
      message: sanitizeDiagnosticText(
        limitedString(error, 'Untrusted component threw a non-Error value')
      )
    }
  } catch {
    return { name: 'Error', message: 'Untrusted component failed' }
  }
}

function stripGuestTypeScript(source, sourceUrl) {
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' })
  } catch {
    // Reparse only failing input with a trusted virtual name so Node includes
    // useful source coordinates in the thrown parser error.
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl })
  }
}

function locateJavaScriptSyntaxError(source, originalError) {
  let candidate = source
  let sourceUrl = 'secure-eval-worker-component.syntax.mjs'
  if (workerData.type === 'script') {
    const prefix = workerData.oneShot
      ? 'async function __secureEval(input) {\n'
      : 'async function __secureEval(input, send, onMessage, host) {\n'
    candidate = prefix + source + '\n}'
    sourceUrl = workerData.oneShot
      ? 'secure-eval-worker-one-shot.syntax.js'
      : 'secure-eval-worker-component.syntax.js'
  }
  let transformed
  try {
    transformed = stripTypeScriptTypes(candidate, { mode: 'strip' })
  } catch {
    // Reparse only failing input with a trusted virtual name so Node includes
    // useful source coordinates in the thrown parser error.
    stripTypeScriptTypes(candidate, { mode: 'strip', sourceUrl })
  }

  let difference = -1
  const length = candidate.length < transformed.length ? candidate.length : transformed.length
  for (let index = 0; index < length; index++) {
    if (candidate[index] !== transformed[index]) {
      difference = index
      break
    }
  }
  if (difference < 0 && candidate.length !== transformed.length) difference = length
  if (difference < 0) return

  let line = 1
  let column = 1
  for (let index = 0; index < difference; index++) {
    if (reflectApply(stringCharCodeAt, candidate, [index]) === 10) {
      line++
      column = 1
    } else {
      column++
    }
  }
  objectDefineProperty(originalError, 'stack', {
    value: limitedString(originalError.name, 'SyntaxError') + ': ' +
      limitedString(originalError.message, 'Invalid JavaScript syntax') + '\n' +
      '    at ' + sourceUrl + ':' + line + ':' + column,
    configurable: true
  })
}

function prepareGuestSource() {
  if (workerData.language === 'javascript') return workerData.source

  let transformed
  if (workerData.type === 'script') {
    const prefix = workerData.oneShot
      ? 'async function __secureEval(input) {\n'
      : 'async function __secureEval(input, send, onMessage, host) {\n'
    const suffix = '\n}'
    const sourceUrl = workerData.oneShot
      ? 'secure-eval-worker-one-shot.ts'
      : 'secure-eval-worker-component.ts'
    const wrapped = stripGuestTypeScript(prefix + workerData.source + suffix, sourceUrl)
    transformed = reflectApply(stringSlice, wrapped, [prefix.length, wrapped.length - suffix.length])
  } else {
    transformed = stripGuestTypeScript(
      workerData.source,
      'secure-eval-worker-component.mts'
    )
  }
  if (bufferByteLength(transformed, 'utf8') > workerData.maxSourceBytes) {
    throw new RangeError('Transformed source exceeds maxSourceBytes (' + workerData.maxSourceBytes + ')')
  }
  return transformed
}

function send(value) {
  const cloned = cloneValue(value, 'message')
  postToHost({ type: 'message', value: cloned }, true)
}

function onMessage(callback) {
  if (typeof callback !== 'function') throw new TypeError('onMessage callback must be a function')
  if (handler) throw new Error('onMessage may only be registered once')
  handler = callback
}

function callHostFunction(name, argumentsList) {
  const id = nextHostCallId++
  const args = cloneValue(argumentsList, 'host function arguments')
  safeV8Serialize(args)
  return createPromise((resolve, reject) => {
    reflectApply(mapSet, pendingHostCalls, [id, { resolve, reject }])
    try {
      postToHost({ type: 'host-call', id, name, arguments: args }, true)
    } catch (error) {
      reflectApply(mapDelete, pendingHostCalls, [id])
      reject(error)
    }
  })
}

function createHostFunctions() {
  const host = objectCreate(null)
  for (const entry of workerData.hostFunctionManifest) {
    const group = objectCreate(null)
    for (const name of entry.names) {
      const qualifiedName = entry.namespace + '.' + name
      objectDefineProperty(group, name, {
        value: (...args) => callHostFunction(qualifiedName, args),
        enumerable: true
      })
    }
    objectFreeze(group)
    objectDefineProperty(host, entry.namespace, {
      value: group,
      enumerable: true
    })
    objectDefineProperty(globalThis, entry.namespace, {
      value: group,
      enumerable: true
    })
  }
  return objectFreeze(host)
}

function handleHostFunctionResult(envelope) {
  const pending = reflectApply(mapGet, pendingHostCalls, [envelope.id])
  if (!pending) throw new Error('Unknown host function response')
  reflectApply(mapDelete, pendingHostCalls, [envelope.id])

  if (envelope.type === 'host-result') {
    settleOwnedValue(
      pending.resolve,
      pending.reject,
      cloneValue(envelope.value, 'host function result')
    )
  } else {
    const detail = envelope.error
    const error = new SafeError(
      detail && typeof detail.message === 'string' ? detail.message : 'Host function failed'
    )
    if (detail && typeof detail.name === 'string') {
      objectDefineProperty(error, 'name', {
        configurable: true,
        enumerable: false,
        value: detail.name,
        writable: true
      })
    }
    if (detail && typeof detail.code === 'string') {
      objectDefineProperty(error, 'code', {
        configurable: true,
        enumerable: true,
        value: detail.code,
        writable: true
      })
    }
    pending.reject(error)
  }
}

async function dispatch(envelope) {
  if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
    throw new Error('Invalid host protocol message')
  }
  if (envelope.type === 'terminate') {
    safeClearInterval(keepAlive)
    closePort()
    if (closeDiagnosticPort) closeDiagnosticPort()
    return
  }
  if (envelope.type !== 'message' && envelope.type !== 'request') {
    throw new Error('Unknown host protocol message')
  }
  if (!handler) {
    const error = { name: 'Error', message: 'The component did not register an onMessage handler' }
    if (envelope.type === 'request') {
      postToHost({ type: 'request-error', id: envelope.id, error })
    } else {
      postToHost({ type: 'runtime-error', error })
    }
    return
  }

  const value = cloneValue(envelope.value, 'message')
  try {
    const outcome = await adoptValue(handler(value))
    const result = outcome.value
    if (envelope.type === 'request') {
      postToHost({
        type: 'response',
        id: envelope.id,
        value: cloneValue(result, 'response')
      })
    }
  } catch (error) {
    if (envelope.type === 'request') {
      postToHost({ type: 'request-error', id: envelope.id, error: cloneError(error) })
    } else {
      postToHost({ type: 'runtime-error', error: cloneError(error) })
    }
  }
}

async function initialize() {
  if (typeof process.permission?.drop !== 'function') {
    throw new Error('process.permission.drop() is unavailable')
  }
  if (!process.permission.has('worker')) {
    throw new Error('The worker permission was not granted to the bootstrap')
  }
  process.permission.drop('worker')
  if (process.permission.has('worker')) throw new Error('Failed to drop the worker permission')

  const channel = new MessageChannel()
  port = channel.port1
  rawPostToHost = port.postMessage.bind(port)
  closePort = port.close.bind(port)
  let portPrototype = objectGetPrototypeOf(port)
  while (portPrototype && portPrototype !== objectPrototype) {
    objectFreeze(portPrototype)
    portPrototype = objectGetPrototypeOf(portPrototype)
  }
  protocolSecret = randomBytes(32).toString('base64')
  const handshake = {
    type: 'session-port',
    port: channel.port2,
    protocolSecret
  }
  const transferList = [channel.port2]
  if (workerData.diagnostics.enabled) {
    const diagnosticChannel = new MessageChannel()
    diagnosticPort = diagnosticChannel.port1
    rawPostDiagnostic = diagnosticPort.postMessage.bind(diagnosticPort)
    closeDiagnosticPort = diagnosticPort.close.bind(diagnosticPort)
    diagnosticSecret = randomBytes(32).toString('base64')
    diagnosticPort.unref()
    handshake.diagnosticPort = diagnosticChannel.port2
    handshake.diagnosticSecret = diagnosticSecret
    transferList.push(diagnosticChannel.port2)
  }
  parentPort.postMessage(handshake, transferList)
  parentPort.close()
  hardenDangerousBuiltins()

  port.on('messageerror', () => {
    reportFatal(new Error('The protocol message could not be deserialized'))
  })
  port.on('message', (message) => {
    let envelope
    try {
      envelope = authenticateHostMessage(message)
    } catch (error) {
      reportFatal(error)
      return
    }

    if (envelope.type === 'host-result' || envelope.type === 'host-error') {
      try {
        handleHostFunctionResult(envelope)
      } catch (error) {
        reportFatal(error)
      }
      return
    }

    const dispatched = thenPromise(processing, () => dispatch(envelope))
    processing = thenPromise(dispatched, undefined, (error) => {
      reportFatal(error)
    })
  })
  // A ref'd MessagePort is exposed by process._getActiveHandles(). Keep the
  // worker alive with a lexical timer instead, and hide the protocol endpoint.
  port.unref()
  keepAlive = safeSetInterval(() => {}, 2_147_483_647)
  const host = createHostFunctions()

  const guestSource = workerData.localModule ? undefined : prepareGuestSource()
  let setupResult
  if (workerData.type === 'script') {
    const sourceName = workerData.oneShot
      ? 'secure-eval-worker-one-shot.js'
      : 'secure-eval-worker-component.js'
    const executableSource = '"use strict";\n' + guestSource + '\n//# sourceURL=' + sourceName
    let execute
    try {
      execute = workerData.oneShot
        ? new AsyncFunction('input', executableSource)
        : new AsyncFunction(
            'input',
            'send',
            'onMessage',
            'host',
            executableSource
          )
    } catch (error) {
      if (workerData.language === 'javascript' && isSyntaxError(error)) {
        locateJavaScriptSyntaxError(guestSource, error)
      }
      throw error
    }
    const execution = workerData.oneShot
      ? execute(workerData.input)
      : execute(workerData.input, send, onMessage, host)
    setupResult = (await adoptValue(execution)).value
  } else {
    let component
    try {
      if (workerData.localModule) {
        component = await import(workerData.localModule.entryUrl)
      } else {
        const encoded = reflectApply(
          bufferFrom,
          undefined,
          [guestSource + '\n//# sourceURL=secure-eval-worker-component.mjs\n', 'utf8']
        ).toString('base64')
        component = await import('data:text/javascript;base64,' + encoded)
      }
    } catch (error) {
      if (!workerData.localModule && workerData.language === 'javascript' &&
          isSyntaxError(error)) {
        locateJavaScriptSyntaxError(guestSource, error)
      }
      throw error
    }
    if (typeof component.default !== 'function') {
      throw new TypeError(workerData.oneShot
        ? 'The module default export must be a function'
        : 'The module default export must be a setup function')
    }
    const execution = workerData.oneShot
      ? component.default(workerData.input)
      : component.default(objectFreeze({
          input: workerData.input,
          send,
          onMessage,
          host
        }))
    setupResult = (await adoptValue(execution)).value
  }

  const readyValue = workerData.oneShot
    ? cloneValue(setupResult, 'result')
    : undefined
  postToHost({ type: 'ready', value: readyValue })
}

thenPromise(initialize(), undefined, (error) => {
  if (port) {
    reportFatal(error)
  } else {
    parentPort.postMessage({ type: 'bootstrap-error', error: cloneError(error) })
    parentPort.close()
  }
})
})()
`

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
    if (message?.type === 'bootstrap-error') {
      this.#fail(remoteError(message.error, 'ERR_UNTRUSTED_WORKER_BOOTSTRAP'))
      return
    }
    const validDiagnosticHandshake = getSessionData(this).diagnostics.enabled
      ? isHostMessagePort(message?.diagnosticPort) &&
        typeof message.diagnosticSecret === 'string' && message.diagnosticSecret.length >= 32
      : message?.diagnosticPort === undefined && message?.diagnosticSecret === undefined
    if (message?.type !== 'session-port' || !isHostMessagePort(message.port) ||
        typeof message.protocolSecret !== 'string' || message.protocolSecret.length < 32 ||
        !validDiagnosticHandshake) {
      this.#fail(sessionError('Invalid worker handshake', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    secrets.port = message.port
    secrets.protocolSecret = message.protocolSecret
    secrets.rawPortPost = (value) => hostReflectApply(
      hostMessagePortPostMessage,
      secrets.port,
      [value]
    )
    if (getSessionData(this).diagnostics.enabled) {
      secrets.diagnosticPort = message.diagnosticPort
      secrets.diagnosticSecret = message.diagnosticSecret
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
    if (message === null || typeof message !== 'object' ||
        !hostReflectApply(hostNumberIsSafeInteger, undefined, [message.sequence]) || message.sequence !== getSessionData(this).inboundSequence + 1 ||
        message.payload === null || typeof message.payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, undefined, [message.payload]) ||
        typeof message.mac !== 'string') {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }

    assertNoSharedMemory(
      message.payload,
      'protocol payload',
      getSessionData(this).maxMessageBytes,
      'maxMessageBytes'
    )
    const byteLength = hostReflectApply(hostTypedArrayByteLength, message.payload, [])
    if (byteLength > getSessionData(this).maxMessageBytes) {
      throw sessionError('Worker protocol message is too large', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    const expected = hostReflectApply(hostBufferFrom, undefined, [protocolMac(
      getSessionSecrets(this).protocolSecret,
      'worker-to-host',
      message.sequence,
      message.payload
    ), 'base64'])
    const actual = hostReflectApply(hostBufferFrom, undefined, [message.mac, 'base64'])
    if (expected.length !== actual.length || !safeHostTimingSafeEqual(expected, actual)) {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    let body
    try {
      body = safeHostV8Deserialize(message.payload)
      assertSupportedProtocolValue(
        body,
        'message',
        getSessionData(this).maxMessageBytes,
        'maxMessageBytes'
      )
    } catch {
      throw sessionError('Invalid worker protocol payload', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    getSessionData(this).inboundSequence = message.sequence
    return body
  }

  #authenticateDiagnostic (message) {
    if (message === null || typeof message !== 'object' ||
        !hostReflectApply(hostNumberIsSafeInteger, undefined, [message.sequence]) ||
        message.sequence !== getSessionData(this).diagnosticSequence + 1 ||
        message.payload === null || typeof message.payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, undefined, [message.payload]) ||
        typeof message.mac !== 'string') {
      throw sessionError(
        'Unauthenticated worker diagnostic message',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    assertNoSharedMemory(
      message.payload,
      'diagnostic payload',
      getSessionData(this).diagnostics.maxRecordBytes,
      'maxMessageBytes'
    )
    const byteLength = hostReflectApply(hostTypedArrayByteLength, message.payload, [])
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
      message.sequence,
      message.payload
    ), 'base64'])
    const actual = hostReflectApply(hostBufferFrom, undefined, [message.mac, 'base64'])
    if (expected.length !== actual.length || !safeHostTimingSafeEqual(expected, actual)) {
      throw sessionError(
        'Unauthenticated worker diagnostic message',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    let record
    try {
      record = safeHostV8Deserialize(message.payload)
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
    if (record === null || typeof record !== 'object' ||
        !hostReflectApply(hostSetHas, DIAGNOSTIC_LEVELS, [record.level]) ||
        typeof record.text !== 'string' || hostReflectOwnKeys(record).length !== 2) {
      throw sessionError(
        'Invalid worker diagnostic payload',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    getSessionData(this).diagnosticSequence = message.sequence
    getSessionData(this).diagnosticRecords++
    getSessionData(this).diagnosticBytes += byteLength
    return hostObjectFreeze({ level: record.level, text: record.text })
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
      this.#handleMessage(
        hostReflectApply(hostArrayShift, getSessionData(this).deferredDiagnosticEnvelopes, []),
        true
      )
      if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') return
    }
  }

  #handleMessage (envelope, diagnosticsReady = false) {
    if (getSessionData(this).state === 'closing' || getSessionData(this).state === 'closed') return
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string' ||
        !hostReflectApply(hostNumberIsSafeInteger, undefined, [envelope.diagnosticSequence]) ||
        envelope.diagnosticSequence < 0) {
      this.#fail(sessionError('Invalid worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }
    if (!diagnosticsReady &&
        (getSessionData(this).deferredDiagnosticEnvelopes.length > 0 ||
         envelope.diagnosticSequence > getSessionData(this).diagnosticsHandledSequence)) {
      if (!getSessionData(this).diagnostics.enabled && envelope.diagnosticSequence !== 0) {
        this.#fail(sessionError('Invalid worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      } else {
        hostReflectApply(hostArrayPush, getSessionData(this).deferredDiagnosticEnvelopes, [envelope])
      }
      return
    }

    if (envelope.type === 'host-call') {
      this.#handleHostCall(envelope)
      return
    }

    try {
      if (hostReflectApply(hostObjectHasOwn, undefined, [envelope, 'value'])) {
        assertNoSharedMemory(
          envelope.value,
          'message',
          getSessionData(this).maxMessageBytes,
          'maxMessageBytes'
        )
      }
    } catch (error) {
      this.#fail(error)
      return
    }

    if (envelope.type === 'ready') {
      if (getSessionData(this).state !== 'starting') {
        this.#fail(sessionError('Unexpected ready message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
        return
      }
      hostClearTimeout(getSessionData(this).startupTimer)
      getSessionData(this).state = 'ready'
      getSessionData(this).readySettled = true
      getSessionData(this).resolveReady(envelope.value)
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

    if (envelope.type === 'message') {
      emitHostEvent(this, 'message', envelope.value)
      return
    }
    if (envelope.type === 'runtime-error') {
      this.#emitError(remoteError(envelope.error))
      return
    }
    if (envelope.type === 'fatal') {
      this.#fail(remoteError(envelope.error, 'ERR_UNTRUSTED_WORKER_BOOTSTRAP'))
      return
    }
    if (envelope.type === 'response' || envelope.type === 'request-error') {
      const pending = hostReflectApply(hostMapGet, getSessionData(this).pending, [envelope.id])
      if (!pending) {
        this.#fail(sessionError('Unknown request response', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
        return
      }
      hostReflectApply(hostMapDelete, getSessionData(this).pending, [envelope.id])
      hostClearTimeout(pending.timer)
      if (hostReflectApply(hostDateNow, undefined, []) >= pending.deadline) {
        const error = sessionError(
          `Message handling exceeded ${pending.timeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
        )
        pending.reject(error)
        this.#fail(error)
      } else if (envelope.type === 'response') {
        pending.resolve(envelope.value)
      } else {
        pending.reject(remoteError(envelope.error))
      }
      return
    }

    this.#fail(sessionError('Unknown worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
  }

  #handleHostCall (envelope) {
    if (getSessionData(this).state !== 'starting' && getSessionData(this).state !== 'ready') return
    if (!hostReflectApply(hostNumberIsSafeInteger, undefined, [envelope.id]) || envelope.id <= 0 ||
        typeof envelope.name !== 'string' || !hostArrayIsArray(envelope.arguments)) {
      this.#fail(sessionError('Invalid host function request', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    try {
      assertNoSharedMemory(
        envelope.arguments,
        'host function arguments',
        getSessionData(this).maxMessageBytes,
        'maxMessageBytes'
      )
    } catch (error) {
      this.#sendHostFunctionError(envelope.id, error)
      return
    }

    const hostFunction = hostReflectApply(
      hostMapGet,
      getSessionData(this).hostFunctions,
      [envelope.name]
    )
    if (!hostFunction) {
      this.#sendHostFunctionError(envelope.id, sessionError(
        `Unknown host function: ${envelope.name}`,
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
      this.#invokeHostFunction(envelope, hostFunction, requestIndex),
      () => {}
    )
  }

  async #invokeHostFunction (envelope, hostFunction, requestIndex) {
    try {
      const outcome = await invokeHostFunction(
        hostFunction,
        envelope.arguments,
        {
          abortSignal: hostReflectApply(
            hostAbortControllerSignal,
            getSessionData(this).hostAbortController,
            []
          ),
          sessionId: getSessionData(this).sessionId,
          requestId: `${getSessionData(this).sessionId}:${envelope.id}`,
          requestIndex,
          hostFunctionName: envelope.name
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
        this.#sendProtocol({ type: 'host-result', id: envelope.id, value: cloned })
      }
    } catch (error) {
      if (getSessionData(this).state === 'starting' || getSessionData(this).state === 'ready') {
        this.#sendHostFunctionError(envelope.id, error)
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
