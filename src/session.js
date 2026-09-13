import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { deserialize as v8Deserialize, serialize as v8Serialize } from 'node:v8'
import { MessagePort, Worker } from 'node:worker_threads'

import {
  abortError,
  assertNoSharedMemory,
  assertSupportedProtocolValue,
  cloneWithoutSharedMemory,
  DEFAULT_MAX_SOURCE_BYTES,
  remoteError,
  sanitizeEnvironment,
  UntrustedCodeError,
  validateResourceLimits,
  validateSource,
  validatePositiveInteger,
  validateTimeout
} from './internal.js'
import { acquireWorkerSlot, createFileDescriptorQuota } from './admission.js'
import { attemptLocalModuleCleanup } from './local-files.js'
import {
  HostFunctionError,
  invokeHostFunction,
  isHostFunctionContextActiveForSession,
  validateHostFunctions
} from './host-functions.js'

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
const hostArrayPush = Array.prototype.push
const hostArrayShift = Array.prototype.shift
const hostArraySplice = Array.prototype.splice
const hostClearTimeout = globalThis.clearTimeout
const hostDateNow = Date.now
const hostHmacPrototype = Object.getPrototypeOf(createHmac('sha256', 'capture'))
const hostHmacDigest = hostHmacPrototype.digest
const hostHmacUpdate = hostHmacPrototype.update
const hostObjectCreate = Object.create
const hostObjectDefineProperty = Object.defineProperty
const hostObjectFreeze = Object.freeze
const hostObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const hostObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const hostObjectHasOwn = Object.hasOwn
const hostPromiseCatch = Promise.prototype.catch
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
const hostMessagePortClose = MessagePort.prototype.close
const hostMessagePortPostMessage = MessagePort.prototype.postMessage
const hostMessagePortStart = MessagePort.prototype.start
const hostMessagePortOn = Object.getPrototypeOf(MessagePort.prototype).on
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

function getSessionSecrets (session) {
  return hostReflectApply(hostWeakMapGet, sessionSecrets, [session])
}

function getSessionData (session) {
  return hostReflectApply(hostWeakMapGet, sessionData, [session])
}

function resolveHostPromise (value) {
  return hostReflectApply(hostPromiseResolve, SafePromise, [value])
}

function rejectHostPromise (error) {
  return hostReflectApply(hostPromiseReject, SafePromise, [error])
}

function thenHostPromise (promise, onFulfilled, onRejected) {
  return hostReflectApply(hostPromiseThen, promise, [onFulfilled, onRejected])
}

function catchHostPromise (promise, onRejected) {
  return hostReflectApply(hostPromiseCatch, promise, [onRejected])
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

const { createHmac, randomBytes } = require('node:crypto')
const asyncHooksBuiltin = require('node:async_hooks')
const fsBuiltin = require('node:fs')
const fsPromisesBuiltin = require('node:fs/promises')
const dgramBuiltin = require('node:dgram')
const httpBuiltin = require('node:http')
const http2Builtin = require('node:http2')
const httpsBuiltin = require('node:https')
const moduleBuiltin = require('node:module')
const netBuiltin = require('node:net')
const osBuiltin = require('node:os')
const processBuiltin = require('node:process')
const seaBuiltin = require('node:sea')
const sqliteBuiltin = require('node:sqlite')
const tlsBuiltin = require('node:tls')
const ttyBuiltin = require('node:tty')
const v8Builtin = require('node:v8')
const workerThreadsBuiltin = require('node:worker_threads')
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
const { stripTypeScriptTypes } = moduleBuiltin
const { MessageChannel, parentPort, workerData } = workerThreadsBuiltin
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const safeStructuredClone = globalThis.structuredClone
const safeV8Deserialize = v8Deserialize
const safeV8Serialize = v8Serialize
const reflectApply = Reflect.apply
const safeAtomics = Atomics
const hostAtomicsCompareExchange = Atomics.compareExchange
const SafePromise = Promise
const SafeError = Error
const SafeSyntaxError = SyntaxError
const SafeString = String
const SafeNumber = Number
const SafeWeakSet = WeakSet
const numberIsSafeInteger = Number.isSafeInteger
const promiseThen = Promise.prototype.then
const promiseCatch = Promise.prototype.catch
const safeSetInterval = globalThis.setInterval
const safeClearInterval = globalThis.clearInterval
const reflectOwnKeys = Reflect.ownKeys
const arrayBufferIsView = ArrayBuffer.isView
const arrayIsArray = Array.isArray
const weakSetHas = WeakSet.prototype.has
const weakSetAdd = WeakSet.prototype.add
const arrayPush = Array.prototype.push
const arrayPop = Array.prototype.pop
const arrayJoin = Array.prototype.join
const mapGet = Map.prototype.get
const mapSet = Map.prototype.set
const mapDelete = Map.prototype.delete
const mapEntries = Map.prototype.entries
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next
const setHas = Set.prototype.has
const setValues = Set.prototype.values
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next
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
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get
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
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const objectHasOwn = Object.hasOwn
const objectPrototype = Object.prototype
const arrayPrototype = Array.prototype
const arrayBufferPrototype = ArrayBuffer.prototype
const datePrototype = Date.prototype
const regexpPrototype = RegExp.prototype
const mapPrototype = Map.prototype
const setPrototype = Set.prototype
const allowedViewPrototypes = new Set([
  DataView.prototype,
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
let processing = SafePromise.resolve()
let nextHostCallId = 1
let outputMessages = 0
let outputBytes = 0
const pendingHostCalls = new Map()

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

function sandboxDenied(api) {
  const error = new SafeError(api + ' is disabled for untrusted code')
  error.code = 'ERR_ACCESS_DENIED'
  error.permission = 'SandboxEscape'
  throw error
}

function replaceProperty(target, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)
  if (!descriptor || descriptor.configurable || ('value' in descriptor && descriptor.writable)) {
    objectDefineProperty(target, name, {
      value,
      enumerable: descriptor ? descriptor.enumerable : true,
      configurable: false,
      writable: false
    })
  }
}

function denyFunctions(target, prefix, allowedNames) {
  for (const [name, descriptor] of Object.entries(objectGetOwnPropertyDescriptors(target))) {
    // Several security-sensitive builtins expose callable constructors through
    // configurable accessors rather than ordinary value properties.
    if ((!allowedNames || !reflectApply(setHas, allowedNames, [name])) &&
        (!('value' in descriptor) || typeof descriptor.value === 'function')) {
      replaceProperty(target, name, function deniedBuiltin() {
        return sandboxDenied(prefix + '.' + name)
      })
    }
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
    if (reflectApply(arrayIsArray, Array, [value])) return '[Array]'
    if (reflectApply(arrayBufferIsView, ArrayBuffer, [value])) return '[ArrayBufferView]'
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
            error.code = 'ERR_UNTRUSTED_FILE_DESCRIPTOR_LIMIT'
            throw error
          }
          const descriptorSlot = reserveProcessFileDescriptor()
          if (descriptorSlot < 0) {
            const error = new RangeError('Process file descriptor limit exceeded')
            error.code = 'ERR_UNTRUSTED_FILE_DESCRIPTOR_CAPACITY'
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
    } else if (!('value' in descriptor) || typeof descriptor.value === 'function') {
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
  if (workerData.localModule) hardenFileSystemForModuleLoading()
  else {
    denyFunctions(fsBuiltin, 'node:fs')
    denyFunctions(fsPromisesBuiltin, 'node:fs/promises')
  }
  denyFunctions(ttyBuiltin, 'node:tty')
  denyFunctions(netBuiltin, 'node:net')
  denyFunctions(tlsBuiltin, 'node:tls')
  denyFunctions(dgramBuiltin, 'node:dgram')
  denyFunctions(httpBuiltin, 'node:http')
  denyFunctions(http2Builtin, 'node:http2')
  denyFunctions(httpsBuiltin, 'node:https')
  for (const builtin of networkAliasBuiltins) {
    denyFunctions(builtin, 'internal network builtin')
  }

  // Asynchronous customization hooks execute in an InternalWorker, which does
  // not inherit this realm's permission drop or builtin hardening.
  const hiddenGlobalPaths = objectFreeze([])
  replaceProperty(moduleBuiltin, 'globalPaths', hiddenGlobalPaths)
  replaceProperty(moduleBuiltin.Module, 'globalPaths', hiddenGlobalPaths)
  for (const name of [
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
    if ('value' in descriptor && descriptor.value !== null &&
        typeof descriptor.value === 'object') {
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
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
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

function assertNoSharedMemory(value, label) {
  if (value === null || typeof value !== 'object') return

  const pending = [value]
  const seen = new SafeWeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null || typeof current !== 'object') continue
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])

    if (isSharedArrayBuffer(current)) {
      throw new TypeError(label + ' must not contain shared memory')
    }

    const memoryBuffer = getWasmMemoryBuffer(current)
    if (memoryBuffer !== undefined) {
      reflectApply(arrayPush, pending, [memoryBuffer])
      continue
    }
    if (reflectApply(arrayBufferIsView, ArrayBuffer, [current])) {
      reflectApply(arrayPush, pending, [getViewBuffer(current)])
      continue
    }

    let iterator
    try {
      iterator = reflectApply(mapEntries, current, [])
    } catch {}
    if (iterator) {
      while (true) {
        const item = reflectApply(mapIteratorNext, iterator, [])
        if (item.done) break
        reflectApply(arrayPush, pending, [item.value[0], item.value[1]])
      }
      continue
    }

    try {
      iterator = reflectApply(setValues, current, [])
    } catch {
      iterator = undefined
    }
    if (iterator) {
      while (true) {
        const item = reflectApply(setIteratorNext, iterator, [])
        if (item.done) break
        reflectApply(arrayPush, pending, [item.value])
      }
      continue
    }

    const keys = reflectOwnKeys(current)
    for (let index = 0; index < keys.length; index++) {
      reflectApply(arrayPush, pending, [current[keys[index]]])
    }
  }
}

function cloneValue(value, label) {
  assertSupportedProtocolValue(value, label)
  const cloned = safeStructuredClone(value)
  assertNoSharedMemory(cloned, label)
  return cloned
}

function assertSupportedProtocolValue(value, label) {
  const pending = [value]
  const seen = new SafeWeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null) continue
    const kind = typeof current
    if (kind === 'string' || kind === 'boolean' || kind === 'number' ||
        kind === 'bigint' || kind === 'undefined') continue
    if (kind !== 'object') throw new TypeError('Unsupported protocol value')
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])

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
      continue
    }
    if (reflectApply(arrayBufferIsView, ArrayBuffer, [current])) {
      if (isSharedArrayBuffer(getViewBuffer(current))) {
        throw new TypeError(label + ' must not contain shared memory')
      }
      if (!reflectApply(setHas, allowedViewPrototypes, [objectGetPrototypeOf(current)])) {
        throw new TypeError('Unsupported protocol value')
      }
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
      continue
    }

    let iterator
    try {
      iterator = reflectApply(mapEntries, current, [])
    } catch {}
    if (iterator) {
      if (objectGetPrototypeOf(current) !== mapPrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      while (true) {
        const item = reflectApply(mapIteratorNext, iterator, [])
        if (item.done) break
        reflectApply(arrayPush, pending, [item.value[0], item.value[1]])
      }
      continue
    }
    try {
      iterator = reflectApply(setValues, current, [])
    } catch {
      iterator = undefined
    }
    if (iterator) {
      if (objectGetPrototypeOf(current) !== setPrototype) {
        throw new TypeError('Unsupported protocol value')
      }
      while (true) {
        const item = reflectApply(setIteratorNext, iterator, [])
        if (item.done) break
        reflectApply(arrayPush, pending, [item.value])
      }
      continue
    }

    const isArray = reflectApply(arrayIsArray, Array, [current])
    const prototype = objectGetPrototypeOf(current)
    if ((isArray && prototype !== arrayPrototype) ||
        (!isArray && prototype !== objectPrototype && prototype !== null)) {
      throw new TypeError('Unsupported protocol value')
    }
    const descriptors = objectGetOwnPropertyDescriptors(current)
    const keys = reflectOwnKeys(current)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (isArray && key === 'length') continue
      if (typeof key === 'symbol') throw new TypeError('Unsupported protocol value')
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !('value' in descriptor)) {
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
  if (!reflectApply(objectHasOwn, Object, [body, 'diagnosticSequence'])) {
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
      Number.isSafeInteger(envelope.sequence) && envelope.sequence === inboundSequence + 1 &&
      envelope.payload !== null && typeof envelope.payload === 'object' &&
      reflectApply(arrayBufferIsView, ArrayBuffer, [envelope.payload]) &&
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
  const replacements = [
    [workerData.localModule.rootUrlPrefix, 'secure-eval-worker-files/'],
    [workerData.localModule.rootPathPrefix, 'secure-eval-worker-files/']
  ]
  for (let index = 0; index < replacements.length; index++) {
    const location = replacements[index][0]
    const replacement = replacements[index][1]
    result = reflectApply(arrayJoin, reflectApply(stringSplit, result, [location]), [replacement])
  }
  return result
}

function normalizedGuestStack(stack, name, message) {
  if (typeof stack !== 'string') return undefined
  const lines = reflectApply(stringSplit, reflectApply(stringSlice, stack, [0, 8_192]), ['\n'])
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
  let result = sanitizeDiagnosticText(name) + ': ' + sanitizeDiagnosticText(message)
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
    if (!selectedMarker) continue
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
    result += '\n' + sanitizeDiagnosticText(line)
  }
  return result
}

function cloneError(error) {
  try {
    if (error instanceof Error) {
      const name = sanitizeDiagnosticText(limitedString(error.name, 'Error'))
      const message = sanitizeDiagnosticText(virtualizeModuleLocations(
        limitedString(error.message, 'Untrusted component failed')
      ))
      const code = limitedString(error.code, undefined)
      return {
        name,
        message,
        stack: normalizedGuestStack(error.stack, name, message),
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
  return new SafePromise((resolve, reject) => {
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
    pending.resolve(cloneValue(envelope.value, 'host function result'))
  } else {
    const detail = envelope.error
    const error = new SafeError(
      detail && typeof detail.message === 'string' ? detail.message : 'Host function failed'
    )
    if (detail && typeof detail.name === 'string') error.name = detail.name
    if (detail && typeof detail.code === 'string') error.code = detail.code
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
    const result = await handler(value)
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

    const dispatched = reflectApply(promiseThen, processing, [() => dispatch(envelope)])
    processing = reflectApply(promiseCatch, dispatched, [(error) => {
      reportFatal(error)
    }])
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
      if (workerData.language === 'javascript' && error instanceof SafeSyntaxError) {
        locateJavaScriptSyntaxError(guestSource, error)
      }
      throw error
    }
    setupResult = workerData.oneShot
      ? await execute(workerData.input)
      : await execute(workerData.input, send, onMessage, host)
  } else {
    let component
    try {
      if (workerData.localModule) {
        component = await import(workerData.localModule.entryUrl)
      } else {
        const encoded = Buffer.from(
          guestSource + '\n//# sourceURL=secure-eval-worker-component.mjs\n',
          'utf8'
        ).toString('base64')
        component = await import('data:text/javascript;base64,' + encoded)
      }
    } catch (error) {
      if (!workerData.localModule && workerData.language === 'javascript' &&
          error instanceof SafeSyntaxError) {
        locateJavaScriptSyntaxError(guestSource, error)
      }
      throw error
    }
    if (typeof component.default !== 'function') {
      throw new TypeError(workerData.oneShot
        ? 'The module default export must be a function'
        : 'The module default export must be a setup function')
    }
    setupResult = workerData.oneShot
      ? await component.default(workerData.input)
      : await component.default(Object.freeze({
          input: workerData.input,
          send,
          onMessage,
          host
        }))
  }

  const readyValue = workerData.oneShot
    ? cloneValue(setupResult, 'result')
    : undefined
  postToHost({ type: 'ready', value: readyValue })
}

reflectApply(promiseCatch, initialize(), [(error) => {
  if (port) {
    reportFatal(error)
  } else {
    parentPort.postMessage({ type: 'bootstrap-error', error: cloneError(error) })
    parentPort.close()
  }
}])
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
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal')
  }
  if (signal && hostReflectApply(hostAbortSignalAborted, signal, [])) {
    throw abortError(hostReflectApply(hostAbortSignalReason, signal, []))
  }

  const startedAt = hostReflectApply(hostDateNow, Date, [])
  const input = cloneWithoutSharedMemory(options.input, 'input')
  assertSupportedProtocolValue(input, 'input')
  const serializedInput = v8Serialize(input)
  if (hostReflectApply(hostTypedArrayByteLength, serializedInput, []) > data.maxInputBytes) {
    throw new RangeError(`input exceeds maxInputBytes (${data.maxInputBytes})`)
  }
  const environment = sanitizeEnvironment(options.environment)
  const resourceLimits = validateResourceLimits(options.resourceLimits)
  const hostFunctionConfiguration = validateHostFunctions(options.hostFunctions)
  if (signal && hostReflectApply(hostAbortSignalAborted, signal, [])) {
    throw abortError(hostReflectApply(hostAbortSignalReason, signal, []))
  }
  const remainingStartupMs = startupTimeoutMs - (hostReflectApply(hostDateNow, Date, []) - startedAt)
  if (remainingStartupMs <= 0) {
    throw sessionError(`Startup exceeded ${startupTimeoutMs} ms`, 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT')
  }

  return {
    environment,
    hostFunctionConfiguration,
    input,
    language,
    localModule,
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
      defineSessionData(this, 'sessionId', randomUUID())
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

      defineSessionPublicPromise(this, 'ready', new SafePromise((resolve, reject) => {
        defineSessionData(this, 'resolveReady', resolve)
        defineSessionData(this, 'rejectReady', reject)
      }))
      defineSessionPublicPromise(this, 'closed', new SafePromise((resolve) => {
        defineSessionData(this, 'resolveClosed', resolve)
      }))

      getSessionSecrets(this).releaseWorkerSlot = releaseWorkerSlot
    } catch (error) {
      releaseWorkerSlot()
      throw error
    }

    let descriptorQuota
    try {
      descriptorQuota = localModule ? createFileDescriptorQuota() : undefined
    } catch (error) {
      releaseWorkerSlot()
      throw error
    }
    const workerLocalModule = localModule
      ? {
          entryUrl: localModule.entryUrl,
          rootPath: localModule.rootPath,
          rootPathPrefix: localModule.rootPathPrefix,
          rootUrlPrefix: localModule.rootUrlPrefix,
          maxOpenFileDescriptors: MAX_LOCAL_OPEN_FILE_DESCRIPTORS,
          descriptorOwner: descriptorQuota.owner,
          globalDescriptorSlots: descriptorQuota.slotsBuffer
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
      descriptorQuota?.release()
      releaseWorkerSlot()
      getSessionData(this).closedSettled = true
      getSessionData(this).resolveClosed({ code: undefined, error })
      getSessionData(this).state = 'closed'
      throw error
    }

    const worker = getSessionSecrets(this).worker
    hostReflectApply(hostEventEmitterOn, worker, ['exit', (code) => {
      descriptorQuota?.release()
      releaseWorkerSlot()
      if (!localModule) {
        this.#handleExit(code)
        return
      }
      const cleanup = thenHostPromise(attemptLocalModuleCleanup(localModule), (outcome) => {
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
    }])

    try {
      const stdout = hostReflectApply(hostWorkerStdout, worker, [])
      const stderr = hostReflectApply(hostWorkerStderr, worker, [])
      hostReflectApply(hostReadableResume, stdout, [])
      hostReflectApply(hostReadableResume, stderr, [])
      hostReflectApply(hostEventEmitterOn, worker, [
        'message',
        (message) => this.#handleHandshake(message)
      ])
      hostReflectApply(hostEventEmitterOn, worker, ['messageerror', () => {
        this.#fail(sessionError(
          'The worker handshake could not be deserialized',
          'ERR_UNTRUSTED_WORKER_PROTOCOL'
        ))
      }])
      hostReflectApply(hostEventEmitterOn, worker, ['error', (error) => {
        this.#fail(sessionError('The worker failed', 'ERR_UNTRUSTED_WORKER', error))
      }])

      const startupDelay = startupTimeoutMs - (hostReflectApply(hostDateNow, Date, []) - startedAt)
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
    const cloned = cloneWithoutSharedMemory(value, 'message')
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
    const deadline = hostReflectApply(hostDateNow, Date, []) + timeoutMs
    const cloned = cloneWithoutSharedMemory(value, 'message')
    this.#assertOpen()
    const id = getSessionData(this).nextRequestId++
    const body = { type: 'request', id, value: cloned }
    const serialized = assertProtocolBody(body, 'message', getSessionData(this).maxMessageBytes)
    const remainingMs = deadline - hostReflectApply(hostDateNow, Date, [])
    if (remainingMs <= 0) {
      const error = sessionError(
        `Message handling exceeded ${timeoutMs} ms`,
        'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
      )
      this.#fail(error)
      return rejectHostPromise(error)
    }

    return new SafePromise((resolve, reject) => {
      const pending = { resolve, reject, timer: undefined, deadline, timeoutMs }
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
        if (hostReflectApply(hostDateNow, Date, []) >= deadline) expire()
      }

      if (getSessionData(this).state === 'ready') send()
      else hostReflectApply(hostArrayPush, getSessionData(this).outbound, [send])
    })
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
    getSessionData(this).termination = new SafePromise((resolve, reject) => {
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
      ? message?.diagnosticPort instanceof MessagePort &&
        typeof message.diagnosticSecret === 'string' && message.diagnosticSecret.length >= 32
      : message?.diagnosticPort === undefined && message?.diagnosticSecret === undefined
    if (message?.type !== 'session-port' || !(message.port instanceof MessagePort) ||
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
        let record
        let sequence
        try {
          record = this.#authenticateDiagnostic(message)
          sequence = getSessionData(this).diagnosticSequence
        } catch (error) {
          this.#fail(error)
          return
        }
        const processing = thenHostPromise(
          getSessionData(this).diagnosticProcessing,
          () => this.#handleDiagnostic(record, sequence)
        )
        getSessionData(this).diagnosticProcessing = catchHostPromise(processing, (error) => {
          try {
            this.#fail(error)
          } catch {}
        })
      }])
      hostReflectApply(hostMessagePortOn, secrets.diagnosticPort, ['messageerror', () => {
        this.#fail(sessionError(
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
        this.#fail(error)
      }
    }])
    hostReflectApply(hostMessagePortOn, secrets.port, ['messageerror', () => {
      this.#fail(sessionError(
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
        !hostReflectApply(hostNumberIsSafeInteger, Number, [message.sequence]) || message.sequence !== getSessionData(this).inboundSequence + 1 ||
        message.payload === null || typeof message.payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, ArrayBuffer, [message.payload]) ||
        typeof message.mac !== 'string') {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }

    assertNoSharedMemory(message.payload, 'protocol payload')
    const byteLength = hostReflectApply(hostTypedArrayByteLength, message.payload, [])
    if (byteLength > getSessionData(this).maxMessageBytes) {
      throw sessionError('Worker protocol message is too large', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    const expected = hostReflectApply(hostBufferFrom, Buffer, [protocolMac(
      getSessionSecrets(this).protocolSecret,
      'worker-to-host',
      message.sequence,
      message.payload
    ), 'base64'])
    const actual = hostReflectApply(hostBufferFrom, Buffer, [message.mac, 'base64'])
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    let body
    try {
      body = v8Deserialize(message.payload)
      assertSupportedProtocolValue(body, 'message')
    } catch {
      throw sessionError('Invalid worker protocol payload', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    getSessionData(this).inboundSequence = message.sequence
    return body
  }

  #authenticateDiagnostic (message) {
    if (message === null || typeof message !== 'object' ||
        !hostReflectApply(hostNumberIsSafeInteger, Number, [message.sequence]) ||
        message.sequence !== getSessionData(this).diagnosticSequence + 1 ||
        message.payload === null || typeof message.payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, ArrayBuffer, [message.payload]) ||
        typeof message.mac !== 'string') {
      throw sessionError(
        'Unauthenticated worker diagnostic message',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    assertNoSharedMemory(message.payload, 'diagnostic payload')
    const byteLength = hostReflectApply(hostTypedArrayByteLength, message.payload, [])
    if (byteLength > getSessionData(this).diagnostics.maxRecordBytes ||
        getSessionData(this).diagnosticRecords >= getSessionData(this).diagnostics.maxRecords ||
        getSessionData(this).diagnosticBytes + byteLength > getSessionData(this).diagnostics.maxBytes) {
      throw sessionError(
        'Worker diagnostic limit exceeded',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    const expected = hostReflectApply(hostBufferFrom, Buffer, [protocolMac(
      getSessionSecrets(this).diagnosticSecret,
      'worker-diagnostic-to-host',
      message.sequence,
      message.payload
    ), 'base64'])
    const actual = hostReflectApply(hostBufferFrom, Buffer, [message.mac, 'base64'])
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw sessionError(
        'Unauthenticated worker diagnostic message',
        'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_PROTOCOL'
      )
    }
    let record
    try {
      record = v8Deserialize(message.payload)
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
      await hostReflectApply(hostAsyncLocalStorageRun, diagnosticContextStorage, [store, async () => {
        if (getSessionData(this).onDiagnostic) await getSessionData(this).onDiagnostic(record)
        emitHostEvent(this, 'diagnostic', record)
      }])
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
        !hostReflectApply(hostNumberIsSafeInteger, Number, [envelope.diagnosticSequence]) ||
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
      if ('value' in envelope) assertNoSharedMemory(envelope.value, 'message')
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
      if (hostReflectApply(hostDateNow, Date, []) >= pending.deadline) {
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
    if (!hostReflectApply(hostNumberIsSafeInteger, Number, [envelope.id]) || envelope.id <= 0 ||
        typeof envelope.name !== 'string' || !hostArrayIsArray(envelope.arguments)) {
      this.#fail(sessionError('Invalid host function request', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    try {
      assertNoSharedMemory(envelope.arguments, 'host function arguments')
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
      const value = await invokeHostFunction(hostFunction, envelope.arguments, {
        abortSignal: hostReflectApply(
          hostAbortControllerSignal,
          getSessionData(this).hostAbortController,
          []
        ),
        sessionId: getSessionData(this).sessionId,
        requestId: `${getSessionData(this).sessionId}:${envelope.id}`,
        requestIndex,
        hostFunctionName: envelope.name
      })
      const hostAbortSignal = hostReflectApply(
        hostAbortControllerSignal,
        getSessionData(this).hostAbortController,
        []
      )
      if (hostReflectApply(hostAbortSignalAborted, hostAbortSignal, []) ||
          (getSessionData(this).state !== 'starting' && getSessionData(this).state !== 'ready')) return
      const cloned = cloneWithoutSharedMemory(value, 'host function result')
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
    hostReflectApply(hostPromiseCatch, termination, [() => {}])
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
  const hmac = createHmac('sha256', secret)
  hostReflectApply(hostHmacUpdate, hmac, [`${direction}\0${sequence}\0`])
  hostReflectApply(hostHmacUpdate, hmac, [serialized])
  return hostReflectApply(hostHmacDigest, hmac, ['base64'])
}

function serializeProtocolBody (body, maxMessageBytes) {
  let serialized
  try {
    assertSupportedProtocolValue(body, 'message')
    serialized = v8Serialize(body)
  } catch {
    throw new TypeError('Message is not supported by the authenticated protocol')
  }
  if (serialized.byteLength > maxMessageBytes) {
    throw new RangeError(`Message exceeds maxMessageBytes (${maxMessageBytes})`)
  }
  return serialized
}

function assertProtocolBody (body, label, maxMessageBytes) {
  try {
    return serializeProtocolBody(body, maxMessageBytes)
  } catch (error) {
    if (error instanceof RangeError) throw error
    throw new TypeError(`${label} is not supported by the authenticated protocol`)
  }
}

function assertProtocolSerializable (value, label) {
  try {
    v8Serialize(value)
  } catch {
    throw new TypeError(`${label} is not supported by the authenticated protocol`)
  }
}

function serializeHostError (error) {
  try {
    if (error instanceof HostFunctionError) {
      return {
        name: 'HostFunctionError',
        message: typeof error.message === 'string'
          ? hostReflectApply(hostStringSlice, error.message, [0, 8_192])
          : 'Host function failed',
        code: typeof error.code === 'string'
          ? hostReflectApply(hostStringSlice, error.code, [0, 8_192])
          : 'ERR_HOST_FUNCTION'
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
  return name !== 'constructor' && 'value' in descriptor && typeof descriptor.value === 'function'
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
    if (!descriptor.enumerable || !('value' in descriptor)) {
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
      if (!hostReflectApply(hostObjectHasOwn, Object, [values, key])) {
        throw new TypeError(`Unknown diagnostics option: ${key}`)
      }
      const descriptor = hostReflectApply(hostObjectGetOwnPropertyDescriptor, Object, [diagnostics, key])
      if (!descriptor.enumerable || !('value' in descriptor)) {
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
