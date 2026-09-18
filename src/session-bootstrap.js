'use strict'
;(function trustedBootstrap() {

const cryptoBuiltin = require('node:crypto')
const { createHmac, generateKeySync } = cryptoBuiltin
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
const inspectorBuiltin = require('node:inspector')
const inspectorPromisesBuiltin = require('node:inspector/promises')
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
const wasiBuiltin = require('node:wasi')
const utilTypesBuiltin = require('node:util/types')
const workerThreadsBuiltin = require('node:worker_threads')
let ffiBuiltin
let traceEventsBuiltin
let quicBuiltin
try { ffiBuiltin = require('node:ffi') } catch {}
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
const SafeAggregateError = globalThis.AggregateError
const SafeEvalError = globalThis.EvalError
const SafeReferenceError = globalThis.ReferenceError
const SafeTypeError = globalThis.TypeError
const SafeRangeError = globalThis.RangeError
const SafeSyntaxError = globalThis.SyntaxError
const SafeURIError = globalThis.URIError
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
const nativeErrorStackDescriptor = objectGetOwnPropertyDescriptor(new SafeError(), 'stack')
if (!nativeErrorStackDescriptor ||
    typeof nativeErrorStackDescriptor.get !== 'function' ||
    typeof nativeErrorStackDescriptor.set !== 'function' ||
    nativeErrorStackDescriptor.enumerable !== false ||
    nativeErrorStackDescriptor.configurable !== true) {
  throw new SafeError('Failed to capture native Error stack accessors')
}
const nativeErrorStackGet = nativeErrorStackDescriptor.get
const nativeErrorStackSet = nativeErrorStackDescriptor.set
const nativePrepareStackTraceDescriptor = objectGetOwnPropertyDescriptor(
  SafeError,
  'prepareStackTrace'
)
if (nativePrepareStackTraceDescriptor) objectFreeze(nativePrepareStackTraceDescriptor)
const ERROR_DESCRIPTOR_FIELDS = objectFreeze([
  'configurable', 'enumerable', 'writable', 'value', 'get', 'set'
])
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
for (let index = 0; index < workerData.hostFunctionManifest.length; index++) {
  const entry = workerData.hostFunctionManifest[index]
  objectFreeze(entry.names)
  objectFreeze(entry)
}
objectFreeze(workerData.hostFunctionManifest)
objectFreeze(workerData.diagnostics)
objectFreeze(workerData)
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
const errorPrototype = SafeError.prototype
const syntaxErrorPrototype = SafeSyntaxError.prototype
const nativeErrorPrototypeNames = new Map([
  [errorPrototype, 'Error'],
  [SafeAggregateError.prototype, 'AggregateError'],
  [SafeEvalError.prototype, 'EvalError'],
  [SafeReferenceError.prototype, 'ReferenceError'],
  [SafeTypeError.prototype, 'TypeError'],
  [SafeRangeError.prototype, 'RangeError'],
  [SafeSyntaxError.prototype, 'SyntaxError'],
  [SafeURIError.prototype, 'URIError'],
  [WebAssembly.CompileError.prototype, 'CompileError'],
  [WebAssembly.LinkError.prototype, 'LinkError'],
  [WebAssembly.RuntimeError.prototype, 'RuntimeError']
])
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
const processFileDescriptorSlotCount = processFileDescriptorSlots === undefined
  ? 0
  : reflectApply(typedArrayLength, processFileDescriptorSlots, [])

function ownPropertyDescriptor(value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') ||
      reflectApply(isProxy, utilTypesBuiltin, [value])) {
    return undefined
  }
  return reflectApply(objectGetOwnPropertyDescriptor, undefined, [value, key])
}

function ownDataDescriptor(value, key) {
  const descriptor = ownPropertyDescriptor(value, key)
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
    return undefined
  }
  return descriptor
}

function ownDataValue(value, key) {
  const descriptor = ownDataDescriptor(value, key)
  return descriptor?.value
}

function hasOriginalOwnDescriptor(value, key, originalDescriptor) {
  const descriptor = ownPropertyDescriptor(value, key)
  if (descriptor === undefined || originalDescriptor === undefined) {
    return descriptor === originalDescriptor
  }
  for (let index = 0; index < ERROR_DESCRIPTOR_FIELDS.length; index++) {
    const field = ERROR_DESCRIPTOR_FIELDS[index]
    const hasField = reflectApply(objectHasOwn, undefined, [descriptor, field])
    if (hasField !== reflectApply(objectHasOwn, undefined, [originalDescriptor, field]) ||
        (hasField && descriptor[field] !== originalDescriptor[field])) {
      return false
    }
  }
  return true
}

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

function denyFunctions(target, prefix, allowedNames, verify = false) {
  for (const [name, descriptor] of Object.entries(objectGetOwnPropertyDescriptors(target))) {
    // Several security-sensitive builtins expose callable constructors through
    // configurable accessors rather than ordinary value properties.
    if ((!allowedNames || !reflectApply(setHas, allowedNames, [name])) &&
        (!reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
         typeof descriptor.value === 'function')) {
      const denied = function deniedBuiltin() {
        return sandboxDenied(prefix + '.' + name)
      }
      replaceProperty(target, name, denied)
      if (verify) {
        const replacement = objectGetOwnPropertyDescriptor(target, name)
        if (!replacement ||
            !reflectApply(objectHasOwn, undefined, [replacement, 'value']) ||
            replacement.value !== denied || replacement.writable || replacement.configurable) {
          throw new SafeError('Failed to disable ' + prefix + '.' + name)
        }
      }
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
  const start = owner % processFileDescriptorSlotCount
  for (let offset = 0; offset < processFileDescriptorSlotCount; offset++) {
    const index = (start + offset) % processFileDescriptorSlotCount
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
  denyFunctions(wasiBuiltin, 'node:wasi')
  if (ffiBuiltin) denyFunctions(ffiBuiltin, 'node:ffi')
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

  // Inspector sessions can take heap snapshots without filesystem access.
  // Deny both APIs independently of the Permission Model, including callable
  // nested namespaces, and fail closed if a supported runtime makes one of
  // those properties impossible to replace.
  const deniedInspectorNamespaces = new SafeWeakSet()
  for (const [builtin, prefix] of [
    [inspectorBuiltin, 'node:inspector'],
    [inspectorPromisesBuiltin, 'node:inspector/promises']
  ]) {
    const descriptors = objectGetOwnPropertyDescriptors(builtin)
    const names = reflectOwnKeys(descriptors)
    for (let index = 0; index < names.length; index++) {
      const name = names[index]
      const descriptor = descriptors[name]
      if (reflectApply(objectHasOwn, undefined, [descriptor, 'value']) &&
          descriptor.value !== null && typeof descriptor.value === 'object' &&
          !reflectApply(weakSetHas, deniedInspectorNamespaces, [descriptor.value])) {
        reflectApply(weakSetAdd, deniedInspectorNamespaces, [descriptor.value])
        denyFunctions(
          descriptor.value,
          prefix + '.' + SafeString(name),
          undefined,
          true
        )
      }
    }
    denyFunctions(builtin, prefix, undefined, true)
  }

  // Keep the protocol's previously captured serializer functions private and
  // deny the complete guest-facing V8 module so new profiling, snapshot, or
  // object-query APIs cannot bypass an incomplete name list. V8 also exposes
  // callable APIs through nested namespaces such as promiseHooks and
  // startupSnapshot, so deny every object-valued namespace generically and
  // fail closed if a supported runtime makes one impossible to replace.
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
        name === 'startupSnapshot' ? startupSnapshotCompatibility : undefined,
        true
      )
    }
  }
  denyFunctions(v8Builtin, 'node:v8', undefined, true)
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
  reflectApply(hmacUpdate, hmac, [direction + '\0' + SafeString(sequence) + '\0'])
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
  const sequence = ownDataValue(envelope, 'sequence')
  const payload = ownDataValue(envelope, 'payload')
  const mac = ownDataValue(envelope, 'mac')
  if (reflectApply(numberIsSafeInteger, SafeNumber, [sequence]) &&
      sequence === inboundSequence + 1 &&
      payload !== null && typeof payload === 'object' &&
      reflectApply(arrayBufferIsView, undefined, [payload]) &&
      typeof mac === 'string') {
    serialized = payload
    const byteLength = reflectApply(typedArrayByteLength, serialized, [])
    authenticated = byteLength <= workerData.maxMessageBytes &&
      mac === protocolMac('host-to-worker', sequence, serialized)
  }
  if (!authenticated) throw new Error('Unauthenticated host protocol message')
  const body = safeV8Deserialize(serialized)
  assertSupportedProtocolValue(body, 'message')
  inboundSequence = sequence
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

function dataDescriptorValue(descriptor) {
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
    return undefined
  }
  return descriptor.value
}

function safeErrorTextDescriptor(descriptor) {
  if (descriptor === undefined) return true
  if (!reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) return false
  return descriptor.value === undefined || typeof descriptor.value === 'string'
}

function safeNativeErrorStack(
  error,
  prototype,
  nameDescriptor,
  messageDescriptor,
  codeDescriptor,
  prototypeNameDescriptor,
  prototypeMessageDescriptor,
  prototypeCodeDescriptor,
  stackDescriptor
) {
  if (!stackDescriptor) return undefined
  if (reflectApply(objectHasOwn, undefined, [stackDescriptor, 'value'])) {
    return typeof stackDescriptor.value === 'string' ? stackDescriptor.value : undefined
  }
  if (!reflectApply(objectHasOwn, undefined, [stackDescriptor, 'get']) ||
      !reflectApply(objectHasOwn, undefined, [stackDescriptor, 'set']) ||
      stackDescriptor.get !== nativeErrorStackGet ||
      stackDescriptor.set !== nativeErrorStackSet ||
      stackDescriptor.enumerable !== false || stackDescriptor.configurable !== true ||
      !safeErrorTextDescriptor(nameDescriptor) ||
      !safeErrorTextDescriptor(messageDescriptor) ||
      !safeErrorTextDescriptor(codeDescriptor) ||
      dataDescriptorValue(ownPropertyDescriptor(globalThis, 'Error')) !== SafeError ||
      !hasOriginalOwnDescriptor(
        SafeError,
        'prepareStackTrace',
        nativePrepareStackTraceDescriptor
      ) ||
      reflectApply(isProxy, utilTypesBuiltin, [prototype])) {
    return undefined
  }
  const prototypeParent = objectGetPrototypeOf(prototype)
  let intrinsicPrototype = prototype
  const directIntrinsic = reflectApply(mapGet, nativeErrorPrototypeNames, [intrinsicPrototype])
  if (!directIntrinsic) intrinsicPrototype = prototypeParent
  if (!reflectApply(mapGet, nativeErrorPrototypeNames, [intrinsicPrototype])) return undefined
  const intrinsicNameDescriptor = directIntrinsic
    ? prototypeNameDescriptor
    : ownPropertyDescriptor(intrinsicPrototype, 'name')
  const intrinsicMessageDescriptor = directIntrinsic
    ? prototypeMessageDescriptor
    : ownPropertyDescriptor(intrinsicPrototype, 'message')
  const intrinsicCodeDescriptor = directIntrinsic
    ? prototypeCodeDescriptor
    : ownPropertyDescriptor(intrinsicPrototype, 'code')
  const errorNameDescriptor = intrinsicPrototype === errorPrototype
    ? intrinsicNameDescriptor
    : ownPropertyDescriptor(errorPrototype, 'name')
  const errorMessageDescriptor = intrinsicPrototype === errorPrototype
    ? intrinsicMessageDescriptor
    : ownPropertyDescriptor(errorPrototype, 'message')
  const errorCodeDescriptor = intrinsicPrototype === errorPrototype
    ? intrinsicCodeDescriptor
    : ownPropertyDescriptor(errorPrototype, 'code')
  const intrinsicParent = directIntrinsic
    ? prototypeParent
    : objectGetPrototypeOf(intrinsicPrototype)
  const errorParent = intrinsicPrototype === errorPrototype
    ? intrinsicParent
    : objectGetPrototypeOf(errorPrototype)
  const objectNameDescriptor = ownPropertyDescriptor(objectPrototype, 'name')
  const objectMessageDescriptor = ownPropertyDescriptor(objectPrototype, 'message')
  const objectCodeDescriptor = ownPropertyDescriptor(objectPrototype, 'code')
  if (!safeErrorTextDescriptor(prototypeNameDescriptor) ||
      !safeErrorTextDescriptor(prototypeMessageDescriptor) ||
      !safeErrorTextDescriptor(prototypeCodeDescriptor) ||
      !safeErrorTextDescriptor(intrinsicNameDescriptor) ||
      !safeErrorTextDescriptor(intrinsicMessageDescriptor) ||
      !safeErrorTextDescriptor(intrinsicCodeDescriptor) ||
      !safeErrorTextDescriptor(errorNameDescriptor) ||
      !safeErrorTextDescriptor(errorMessageDescriptor) ||
      !safeErrorTextDescriptor(errorCodeDescriptor) ||
      !safeErrorTextDescriptor(objectNameDescriptor) ||
      !safeErrorTextDescriptor(objectMessageDescriptor) ||
      !safeErrorTextDescriptor(objectCodeDescriptor) ||
      errorParent !== objectPrototype || objectGetPrototypeOf(objectPrototype) !== null ||
      (intrinsicPrototype !== errorPrototype && intrinsicParent !== errorPrototype)) {
    return undefined
  }
  return reflectApply(nativeErrorStackGet, error, [])
}

function cloneError(error) {
  try {
    if (error !== null && typeof error === 'object' &&
        !reflectApply(isProxy, utilTypesBuiltin, [error]) &&
        reflectApply(isNativeError, utilTypesBuiltin, [error])) {
      const prototype = objectGetPrototypeOf(error)
      const nameDescriptor = ownPropertyDescriptor(error, 'name')
      const messageDescriptor = ownPropertyDescriptor(error, 'message')
      const codeDescriptor = ownPropertyDescriptor(error, 'code')
      const stackDescriptor = ownPropertyDescriptor(error, 'stack')
      const intrinsicName = reflectApply(mapGet, nativeErrorPrototypeNames, [prototype])
      const prototypeNameDescriptor = ownPropertyDescriptor(prototype, 'name')
      const prototypeMessageDescriptor = ownPropertyDescriptor(prototype, 'message')
      const prototypeCodeDescriptor = ownPropertyDescriptor(prototype, 'code')
      const prototypeName = dataDescriptorValue(prototypeNameDescriptor)
      const code = limitedString(dataDescriptorValue(codeDescriptor), undefined)
      const classifiedName = code === 'ERR_INVALID_TYPESCRIPT_SYNTAX'
        ? 'SyntaxError'
        : (intrinsicName === undefined ? 'Error' : intrinsicName)
      const name = sanitizeDiagnosticText(limitedString(
        dataDescriptorValue(nameDescriptor),
        typeof prototypeName === 'string' ? prototypeName : classifiedName
      ))
      const message = sanitizeDiagnosticText(virtualizeModuleLocations(
        limitedString(dataDescriptorValue(messageDescriptor), 'Untrusted component failed')
      ))
      return {
        name,
        message,
        stack: normalizedGuestStack(safeNativeErrorStack(
          error,
          prototype,
          nameDescriptor,
          messageDescriptor,
          codeDescriptor,
          prototypeNameDescriptor,
          prototypeMessageDescriptor,
          prototypeCodeDescriptor,
          stackDescriptor
        )),
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

function snapshotTrustedSyntaxError(error) {
  const message = limitedString(
    dataDescriptorValue(ownPropertyDescriptor(error, 'message')),
    'Invalid JavaScript syntax'
  )
  const stackDescriptor = ownPropertyDescriptor(error, 'stack')
  let stack = dataDescriptorValue(stackDescriptor)
  if (stack === undefined && stackDescriptor &&
      reflectApply(objectHasOwn, undefined, [stackDescriptor, 'get']) &&
      typeof stackDescriptor.get === 'function') {
    // This helper is called only for parser errors created synchronously by
    // captured Node APIs before any guest code can execute.
    stack = reflectApply(stackDescriptor.get, error, [])
  }
  const replacement = new SafeSyntaxError(message)
  if (typeof stack === 'string') {
    objectDefineProperty(replacement, 'stack', {
      configurable: true,
      value: limitedString(stack, undefined)
    })
  }
  const code = dataDescriptorValue(ownPropertyDescriptor(error, 'code'))
  if (typeof code === 'string') {
    objectDefineProperty(replacement, 'code', {
      configurable: true,
      enumerable: true,
      value: code,
      writable: true
    })
  }
  return replacement
}

function stripGuestTypeScript(source, sourceUrl) {
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' })
  } catch {
    // Reparse only failing input with a trusted virtual name so Node includes
    // useful source coordinates in the thrown parser error.
    try {
      return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl })
    } catch (error) {
      throw snapshotTrustedSyntaxError(error)
    }
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
    try {
      stripTypeScriptTypes(candidate, { mode: 'strip', sourceUrl })
    } catch (error) {
      throw snapshotTrustedSyntaxError(error)
    }
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
    value: 'SyntaxError: ' + limitedString(
      dataDescriptorValue(ownPropertyDescriptor(originalError, 'message')),
      'Invalid JavaScript syntax'
    ) + '\n' + '    at ' + sourceUrl + ':' + line + ':' + column,
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

function handleHostFunctionResult(envelope, type) {
  const id = ownDataValue(envelope, 'id')
  const pending = reflectApply(mapGet, pendingHostCalls, [id])
  if (!pending) throw new Error('Unknown host function response')
  reflectApply(mapDelete, pendingHostCalls, [id])

  if (type === 'host-result') {
    settleOwnedValue(
      pending.resolve,
      pending.reject,
      cloneValue(ownDataValue(envelope, 'value'), 'host function result')
    )
  } else {
    const detail = ownDataValue(envelope, 'error')
    const message = ownDataValue(detail, 'message')
    const name = ownDataValue(detail, 'name')
    const code = ownDataValue(detail, 'code')
    const error = new SafeError(
      typeof message === 'string' ? message : 'Host function failed'
    )
    if (typeof name === 'string') {
      objectDefineProperty(error, 'name', {
        configurable: true,
        enumerable: false,
        value: name,
        writable: true
      })
    }
    if (typeof code === 'string') {
      objectDefineProperty(error, 'code', {
        configurable: true,
        enumerable: true,
        value: code,
        writable: true
      })
    }
    pending.reject(error)
  }
}

async function dispatch(envelope, type) {
  if (typeof type !== 'string') throw new Error('Invalid host protocol message')
  if (type === 'terminate') {
    safeClearInterval(keepAlive)
    closePort()
    if (closeDiagnosticPort) closeDiagnosticPort()
    return
  }
  if (type !== 'message' && type !== 'request') {
    throw new Error('Unknown host protocol message')
  }
  const id = ownDataValue(envelope, 'id')
  if (!handler) {
    const error = { name: 'Error', message: 'The component did not register an onMessage handler' }
    if (type === 'request') {
      postToHost({ type: 'request-error', id, error })
    } else {
      postToHost({ type: 'runtime-error', error })
    }
    return
  }

  const value = cloneValue(ownDataValue(envelope, 'value'), 'message')
  try {
    const outcome = await adoptValue(handler(value))
    const result = outcome.value
    if (type === 'request') {
      postToHost({
        type: 'response',
        id,
        value: cloneValue(result, 'response')
      })
    }
  } catch (error) {
    if (type === 'request') {
      postToHost({ type: 'request-error', id, error: cloneError(error) })
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
  // Keep authentication material in a native-backed KeyObject rather than a
  // JavaScript bearer-token string that would be recoverable from a V8 heap
  // snapshot. Guest code receives neither this key nor the private port.
  protocolSecret = generateKeySync('hmac', { length: 256 })
  const handshake = {
    type: 'session-port',
    port: channel.port2,
    protocolSecret,
    diagnosticPort: undefined,
    diagnosticSecret: undefined
  }
  const transferList = [channel.port2]
  if (workerData.diagnostics.enabled) {
    const diagnosticChannel = new MessageChannel()
    diagnosticPort = diagnosticChannel.port1
    rawPostDiagnostic = diagnosticPort.postMessage.bind(diagnosticPort)
    closeDiagnosticPort = diagnosticPort.close.bind(diagnosticPort)
    diagnosticSecret = generateKeySync('hmac', { length: 256 })
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

    const type = ownDataValue(envelope, 'type')
    if (type === 'host-result' || type === 'host-error') {
      try {
        handleHostFunctionResult(envelope, type)
      } catch (error) {
        reportFatal(error)
      }
      return
    }

    const dispatched = thenPromise(processing, () => dispatch(envelope, type))
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
