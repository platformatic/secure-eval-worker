import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
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
const safeArrayBufferIsView = ArrayBuffer.isView
const hostTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const hostReflectApply = Reflect.apply
const sessionSecrets = new WeakMap()
const ONE_SHOT = Symbol('oneShot')

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
const { MessageChannel, parentPort, workerData } = workerThreadsBuiltin
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const safeStructuredClone = globalThis.structuredClone
const safeV8Deserialize = v8Deserialize
const safeV8Serialize = v8Serialize
const reflectApply = Reflect.apply
const SafePromise = Promise
const SafeError = Error
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
const mapGet = Map.prototype.get
const mapSet = Map.prototype.set
const mapDelete = Map.prototype.delete
const mapEntries = Map.prototype.entries
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next
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
const objectPrototype = Object.prototype
const stringSlice = String.prototype.slice

let port
let rawPostToHost
let closePort
let protocolSecret
let inboundSequence = 0
let outboundSequence = 0
let keepAlive
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

function denyFunctions(target, prefix) {
  for (const [name, descriptor] of Object.entries(objectGetOwnPropertyDescriptors(target))) {
    // Several security-sensitive builtins expose callable constructors through
    // configurable accessors rather than ordinary value properties.
    if (!('value' in descriptor) || typeof descriptor.value === 'function') {
      replaceProperty(target, name, function deniedBuiltin() {
        return sandboxDenied(prefix + '.' + name)
      })
    }
  }
}

function hardenDangerousBuiltins() {
  // Existing numeric file descriptors bypass Node's Permission Model and are
  // shared by every thread. Disable the complete fs and tty surfaces rather
  // than trying to maintain an error-prone list of descriptor-taking APIs.
  denyFunctions(asyncHooksBuiltin, 'node:async_hooks')
  denyFunctions(fsBuiltin, 'node:fs')
  denyFunctions(fsPromisesBuiltin, 'node:fs/promises')
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
  for (const name of [
    'getHeapSnapshot',
    'setFlagsFromString',
    'setHeapSnapshotNearHeapLimit',
    'startCpuProfile',
    'startHeapProfile',
    'stopCoverage',
    'takeCoverage',
    'writeHeapSnapshot'
  ]) {
    replaceProperty(v8Builtin, name, () => sandboxDenied('node:v8.' + name))
  }
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
    replaceProperty(globalThis.console, name, () => {})
  }

  // Update named ESM exports to the hardened CommonJS export values. Calling
  // syncBuiltinESMExports() again cannot recover the original functions.
  moduleBuiltin.syncBuiltinESMExports()
}

function assertNoSharedMemory(value, label) {
  if (value === null || typeof value !== 'object') return

  const pending = [value]
  const seen = new WeakSet()
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

    for (const key of reflectOwnKeys(current)) {
      reflectApply(arrayPush, pending, [current[key]])
    }
  }
}

function cloneValue(value, label) {
  const cloned = safeStructuredClone(value)
  assertNoSharedMemory(cloned, label)
  return cloned
}

function assertSupportedProtocolValue(value) {
  const pending = [value]
  const seen = new WeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null) continue
    const kind = typeof current
    if (kind === 'string' || kind === 'boolean' || kind === 'number' ||
        kind === 'bigint' || kind === 'undefined') continue
    if (kind !== 'object') throw new TypeError('Unsupported protocol value')
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])

    if (isSharedArrayBuffer(current)) throw new TypeError('Unsupported protocol value')
    try {
      reflectApply(arrayBufferByteLength, current, [])
      continue
    } catch {}
    if (reflectApply(arrayBufferIsView, ArrayBuffer, [current])) continue
    try {
      reflectApply(dateTime, current, [])
      continue
    } catch {}
    try {
      reflectApply(regexpSource, current, [])
      continue
    } catch {}

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

    const prototype = objectGetPrototypeOf(current)
    if (!reflectApply(arrayIsArray, Array, [current]) &&
        prototype !== objectPrototype && prototype !== null) {
      throw new TypeError('Unsupported protocol value')
    }
    for (const key of reflectOwnKeys(current)) {
      if (typeof key === 'symbol') throw new TypeError('Unsupported protocol value')
      reflectApply(arrayPush, pending, [current[key]])
    }
  }
}

function serializeProtocolBody(body) {
  assertSupportedProtocolValue(body)
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
    }
  }
}

function protocolMac(direction, sequence, serialized) {
  const hmac = createHmac('sha256', protocolSecret)
  reflectApply(hmacUpdate, hmac, [direction + '\0' + String(sequence) + '\0'])
  reflectApply(hmacUpdate, hmac, [serialized])
  return reflectApply(hmacDigest, hmac, ['base64'])
}

function postToHost(body, countAgainstOutput = false) {
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
  assertSupportedProtocolValue(body)
  inboundSequence = envelope.sequence
  return body
}

function limitedString(value, fallback) {
  if (typeof value !== 'string') return fallback
  return reflectApply(stringSlice, value, [0, 8_192])
}

function cloneError(error) {
  try {
    if (error instanceof Error) {
      return {
        name: limitedString(error.name, 'Error'),
        message: limitedString(error.message, 'Untrusted component failed'),
        stack: limitedString(error.stack, undefined),
        code: limitedString(error.code, undefined)
      }
    }
    return {
      name: 'Error',
      message: limitedString(error, 'Untrusted component threw a non-Error value')
    }
  } catch {
    return { name: 'Error', message: 'Untrusted component failed' }
  }
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
  parentPort.postMessage({
    type: 'session-port',
    port: channel.port2,
    protocolSecret
  }, [channel.port2])
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

  let setupResult
  if (workerData.type === 'script') {
    const execute = workerData.oneShot
      ? new AsyncFunction('input', '"use strict";\n' + workerData.source)
      : new AsyncFunction(
          'input',
          'send',
          'onMessage',
          'host',
          '"use strict";\n' + workerData.source
        )
    setupResult = workerData.oneShot
      ? await execute(workerData.input)
      : await execute(workerData.input, send, onMessage, host)
  } else {
    const encoded = Buffer.from(
      workerData.source + '\n//# sourceURL=secure-eval-worker-component.mjs\n',
      'utf8'
    ).toString('base64')
    const component = await import('data:text/javascript;base64,' + encoded)
    if (typeof component.default !== 'function') {
      throw new TypeError('The module default export must be a setup function')
    }
    setupResult = await component.default(Object.freeze({
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

export function createUntrustedWorker (source, options = {}) {
  return new UntrustedWorkerSession(source, options)
}

export function createUntrustedOneShot (source, options = {}) {
  return new UntrustedWorkerSession(source, { ...options, [ONE_SHOT]: true })
}

export class UntrustedWorkerSession extends EventEmitter {
  constructor (source, options = {}) {
    super()
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object')
    }

    const type = options.type ?? 'script'
    if (type !== 'script' && type !== 'module') {
      throw new TypeError("type must be 'script' or 'module'")
    }

    const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.messageTimeoutMs = options.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS
    this.lifetimeTimeoutMs = options.lifetimeTimeoutMs ?? DEFAULT_LIFETIME_TIMEOUT_MS
    this.maxHostFunctionCalls = options.maxHostFunctionCalls ?? DEFAULT_MAX_HOST_FUNCTION_CALLS
    this.maxInFlightHostFunctions = options.maxInFlightHostFunctions ?? DEFAULT_MAX_IN_FLIGHT_HOST_FUNCTIONS
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
    this.maxOutputMessages = options.maxOutputMessages ?? DEFAULT_MAX_OUTPUT_MESSAGES
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    validateSource(source, maxSourceBytes)
    validateTimeout(startupTimeoutMs, 'startupTimeoutMs')
    validateTimeout(this.messageTimeoutMs, 'messageTimeoutMs')
    validateTimeout(this.lifetimeTimeoutMs, 'lifetimeTimeoutMs')
    validatePositiveInteger(this.maxHostFunctionCalls, 'maxHostFunctionCalls')
    validatePositiveInteger(this.maxInFlightHostFunctions, 'maxInFlightHostFunctions')
    validatePositiveInteger(this.maxMessageBytes, 'maxMessageBytes')
    if (this.maxMessageBytes < MIN_MAX_MESSAGE_BYTES) {
      throw new RangeError(`maxMessageBytes must be at least ${MIN_MAX_MESSAGE_BYTES}`)
    }
    validatePositiveInteger(this.maxInputBytes, 'maxInputBytes')
    validatePositiveInteger(this.maxOutputMessages, 'maxOutputMessages')
    validatePositiveInteger(this.maxOutputBytes, 'maxOutputBytes')

    const signal = options.signal
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal')
    }
    if (signal?.aborted) throw abortError(signal.reason)

    const startedAt = Date.now()
    const input = cloneWithoutSharedMemory(options.input, 'input')
    assertSupportedProtocolValue(input, 'input')
    const serializedInput = v8Serialize(input)
    if (hostReflectApply(hostTypedArrayByteLength, serializedInput, []) > this.maxInputBytes) {
      throw new RangeError(`input exceeds maxInputBytes (${this.maxInputBytes})`)
    }
    const environment = sanitizeEnvironment(options.environment)
    const resourceLimits = validateResourceLimits(options.resourceLimits)
    const hostFunctionConfiguration = validateHostFunctions(options.hostFunctions)
    if (signal?.aborted) throw abortError(signal.reason)
    const remainingStartupMs = startupTimeoutMs - (Date.now() - startedAt)
    if (remainingStartupMs <= 0) {
      throw sessionError(`Startup exceeded ${startupTimeoutMs} ms`, 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT')
    }

    this.state = 'starting'
    sessionSecrets.set(this, {
      worker: undefined,
      port: undefined,
      protocolSecret: undefined,
      rawPortPost: undefined
    })
    this.pending = new Map()
    this.outbound = []
    this.nextRequestId = 1
    this.inboundSequence = 0
    this.outboundSequence = 0
    this.hostFunctionCalls = 0
    this.inFlightHostFunctions = 0
    this.hostFunctions = hostFunctionConfiguration.functions
    this.hostAbortController = new AbortController()
    this.sessionId = randomUUID()
    this.readySettled = false
    this.failure = undefined
    this.signal = signal
    this.onAbort = () => this.fail(abortError(signal.reason))

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })

    if (signal) signal.addEventListener('abort', this.onAbort, { once: true })

    try {
      sessionSecrets.get(this).worker = new Worker(SESSION_BOOTSTRAP, {
        eval: true,
        env: environment,
        execArgv: [
          '--permission',
          '--allow-worker',
          '--disable-warning=PERM0006'
        ],
        resourceLimits,
        workerData: {
          source,
          type,
          oneShot: options[ONE_SHOT] === true,
          input,
          hostFunctionManifest: hostFunctionConfiguration.manifest,
          maxMessageBytes: this.maxMessageBytes,
          maxOutputMessages: this.maxOutputMessages,
          maxOutputBytes: this.maxOutputBytes
        },
        name: 'secure-eval-worker-session',
        stdout: true,
        stderr: true
      })
    } catch (error) {
      if (signal) signal.removeEventListener('abort', this.onAbort)
      this.resolveClosed({ code: undefined, error })
      this.state = 'closed'
      throw error
    }

    const worker = sessionSecrets.get(this).worker
    worker.stdout.resume()
    worker.stderr.resume()
    worker.on('message', (message) => this.handleHandshake(message))
    worker.on('messageerror', () => {
      this.fail(sessionError(
        'The worker handshake could not be deserialized',
        'ERR_UNTRUSTED_WORKER_PROTOCOL'
      ))
    })
    worker.once('error', (error) => {
      this.fail(sessionError('The worker failed', 'ERR_UNTRUSTED_WORKER', error))
    })
    worker.once('exit', (code) => this.handleExit(code))

    const startupDelay = startupTimeoutMs - (Date.now() - startedAt)
    if (startupDelay <= 0) {
      this.fail(sessionError(
        `Startup exceeded ${startupTimeoutMs} ms`,
        'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
      ))
    } else {
      this.startupTimer = setTimeout(() => {
        this.fail(sessionError(
          `Startup exceeded ${startupTimeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
        ))
      }, startupDelay)
    }

    if (signal?.aborted) this.fail(abortError(signal.reason))
  }

  postMessage (value) {
    this.assertOpen()
    const cloned = cloneWithoutSharedMemory(value, 'message')
    this.assertOpen()
    const body = { type: 'message', value: cloned }
    const serialized = assertProtocolBody(body, 'message', this.maxMessageBytes)
    const send = () => this.sendProtocol(body, serialized)
    if (this.state === 'ready') send()
    else this.outbound.push(send)
  }

  request (value, options = {}) {
    this.assertOpen()
    if (isHostFunctionContextActiveForSession(this.sessionId)) {
      throw sessionError(
        'Host functions cannot make reentrant requests to their own session',
        'ERR_UNTRUSTED_WORKER_REENTRANT_REQUEST'
      )
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('request options must be an object')
    }
    const timeoutMs = options.timeoutMs ?? this.messageTimeoutMs
    validateTimeout(timeoutMs, 'timeoutMs')
    const deadline = Date.now() + timeoutMs
    const cloned = cloneWithoutSharedMemory(value, 'message')
    this.assertOpen()
    const id = this.nextRequestId++
    const body = { type: 'request', id, value: cloned }
    const serialized = assertProtocolBody(body, 'message', this.maxMessageBytes)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      const error = sessionError(
        `Message handling exceeded ${timeoutMs} ms`,
        'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
      )
      this.fail(error)
      return Promise.reject(error)
    }

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: undefined, deadline, timeoutMs }
      const expire = () => {
        if (!this.pending.delete(id)) return
        const error = sessionError(
          `Message handling exceeded ${timeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
        )
        reject(error)
        this.fail(error)
      }
      pending.timer = setTimeout(expire, remainingMs)
      this.pending.set(id, pending)
      const send = () => {
        if (this.state !== 'ready' || !this.pending.has(id)) return
        this.sendProtocol(body, serialized)
        if (Date.now() >= deadline) expire()
      }

      if (this.state === 'ready') send()
      else this.outbound.push(send)
    })
  }

  terminate () {
    if (this.termination) return this.termination
    if (this.state !== 'closed') {
      const error = sessionError('The session was terminated', 'ERR_UNTRUSTED_WORKER_TERMINATED')
      this.rejectReadyOnce(error)
      this.rejectOutstanding(error)
      this.state = 'closing'
      this.hostAbortController.abort(error)
      clearTimeout(this.startupTimer)
      clearTimeout(this.lifetimeTimer)
      sessionSecrets.get(this).port?.close()
    }
    const worker = sessionSecrets.get(this).worker
    this.termination = worker ? worker.terminate() : Promise.resolve(undefined)
    return this.termination
  }

  handleHandshake (message) {
    const secrets = sessionSecrets.get(this)
    if (secrets.port) {
      this.fail(sessionError('Unexpected parent-port message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }
    if (message?.type === 'bootstrap-error') {
      this.fail(remoteError(message.error, 'ERR_UNTRUSTED_WORKER_BOOTSTRAP'))
      return
    }
    if (message?.type !== 'session-port' || !(message.port instanceof MessagePort) ||
        typeof message.protocolSecret !== 'string' || message.protocolSecret.length < 32) {
      this.fail(sessionError('Invalid worker handshake', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    secrets.port = message.port
    secrets.protocolSecret = message.protocolSecret
    secrets.rawPortPost = secrets.port.postMessage.bind(secrets.port)
    secrets.worker.removeAllListeners('message')
    secrets.port.on('message', (message) => {
      try {
        this.handleMessage(this.authenticateMessage(message))
      } catch (error) {
        this.fail(error)
      }
    })
    secrets.port.on('messageerror', () => {
      this.fail(sessionError(
        'The worker protocol message could not be deserialized',
        'ERR_UNTRUSTED_WORKER_PROTOCOL'
      ))
    })
    secrets.port.start()
  }

  sendProtocol (body, serialized = serializeProtocolBody(body, this.maxMessageBytes)) {
    const sequence = ++this.outboundSequence
    const secrets = sessionSecrets.get(this)
    secrets.rawPortPost({
      sequence,
      payload: serialized,
      mac: protocolMac(secrets.protocolSecret, 'host-to-worker', sequence, serialized)
    })
  }

  authenticateMessage (message) {
    if (message === null || typeof message !== 'object' ||
        !Number.isSafeInteger(message.sequence) || message.sequence !== this.inboundSequence + 1 ||
        message.payload === null || typeof message.payload !== 'object' ||
        !hostReflectApply(safeArrayBufferIsView, ArrayBuffer, [message.payload]) ||
        typeof message.mac !== 'string') {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }

    assertNoSharedMemory(message.payload, 'protocol payload')
    const byteLength = hostReflectApply(hostTypedArrayByteLength, message.payload, [])
    if (byteLength > this.maxMessageBytes) {
      throw sessionError('Worker protocol message is too large', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    const expected = Buffer.from(protocolMac(
      sessionSecrets.get(this).protocolSecret,
      'worker-to-host',
      message.sequence,
      message.payload
    ), 'base64')
    const actual = Buffer.from(message.mac, 'base64')
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
    this.inboundSequence = message.sequence
    return body
  }

  handleMessage (envelope) {
    if (this.state === 'closing' || this.state === 'closed') return
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      this.fail(sessionError('Invalid worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    if (envelope.type === 'host-call') {
      this.handleHostCall(envelope)
      return
    }

    try {
      if ('value' in envelope) assertNoSharedMemory(envelope.value, 'message')
    } catch (error) {
      this.fail(error)
      return
    }

    if (envelope.type === 'ready') {
      if (this.state !== 'starting') {
        this.fail(sessionError('Unexpected ready message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
        return
      }
      clearTimeout(this.startupTimer)
      this.state = 'ready'
      this.readySettled = true
      this.resolveReady(envelope.value)
      this.lifetimeTimer = setTimeout(() => {
        this.fail(sessionError(
          `Session lifetime exceeded ${this.lifetimeTimeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_LIFETIME_TIMEOUT'
        ))
      }, this.lifetimeTimeoutMs)
      const outbound = this.outbound.splice(0)
      for (const send of outbound) send()
      return
    }

    if (envelope.type === 'message') {
      this.emit('message', envelope.value)
      return
    }
    if (envelope.type === 'runtime-error') {
      this.emitError(remoteError(envelope.error))
      return
    }
    if (envelope.type === 'fatal') {
      this.fail(remoteError(envelope.error, 'ERR_UNTRUSTED_WORKER_BOOTSTRAP'))
      return
    }
    if (envelope.type === 'response' || envelope.type === 'request-error') {
      const pending = this.pending.get(envelope.id)
      if (!pending) {
        this.fail(sessionError('Unknown request response', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
        return
      }
      this.pending.delete(envelope.id)
      clearTimeout(pending.timer)
      if (Date.now() >= pending.deadline) {
        const error = sessionError(
          `Message handling exceeded ${pending.timeoutMs} ms`,
          'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
        )
        pending.reject(error)
        this.fail(error)
      } else if (envelope.type === 'response') {
        pending.resolve(envelope.value)
      } else {
        pending.reject(remoteError(envelope.error))
      }
      return
    }

    this.fail(sessionError('Unknown worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
  }

  handleHostCall (envelope) {
    if (this.state !== 'starting' && this.state !== 'ready') return
    if (!Number.isSafeInteger(envelope.id) || envelope.id <= 0 ||
        typeof envelope.name !== 'string' || !Array.isArray(envelope.arguments)) {
      this.fail(sessionError('Invalid host function request', 'ERR_UNTRUSTED_WORKER_PROTOCOL'))
      return
    }

    try {
      assertNoSharedMemory(envelope.arguments, 'host function arguments')
    } catch (error) {
      this.sendHostFunctionError(envelope.id, error)
      return
    }

    const hostFunction = this.hostFunctions.get(envelope.name)
    if (!hostFunction) {
      this.sendHostFunctionError(envelope.id, sessionError(
        `Unknown host function: ${envelope.name}`,
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
      ))
      return
    }
    if (this.hostFunctionCalls >= this.maxHostFunctionCalls) {
      this.fail(sessionError(
        'Host function call limit exceeded',
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
      ))
      return
    }
    if (this.inFlightHostFunctions >= this.maxInFlightHostFunctions) {
      this.fail(sessionError(
        'Concurrent host function limit exceeded',
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
      ))
      return
    }

    this.hostFunctionCalls++
    this.inFlightHostFunctions++
    const requestIndex = this.hostFunctionCalls
    void this.invokeHostFunction(envelope, hostFunction, requestIndex).catch(() => {})
  }

  async invokeHostFunction (envelope, hostFunction, requestIndex) {
    try {
      const value = await invokeHostFunction(hostFunction, envelope.arguments, {
        abortSignal: this.hostAbortController.signal,
        sessionId: this.sessionId,
        requestId: `${this.sessionId}:${envelope.id}`,
        requestIndex,
        hostFunctionName: envelope.name
      })
      if (this.hostAbortController.signal.aborted ||
          (this.state !== 'starting' && this.state !== 'ready')) return
      const cloned = cloneWithoutSharedMemory(value, 'host function result')
      assertProtocolSerializable(cloned, 'host function result')
      if (this.state === 'starting' || this.state === 'ready') {
        this.sendProtocol({ type: 'host-result', id: envelope.id, value: cloned })
      }
    } catch (error) {
      if (this.state === 'starting' || this.state === 'ready') {
        this.sendHostFunctionError(envelope.id, error)
      }
    } finally {
      this.inFlightHostFunctions--
    }
  }

  sendHostFunctionError (id, error) {
    if (!sessionSecrets.get(this).port ||
        (this.state !== 'starting' && this.state !== 'ready')) return
    try {
      this.sendProtocol({
        type: 'host-error',
        id,
        error: serializeHostError(error)
      })
    } catch (protocolError) {
      this.fail(sessionError(
        'Host function error exceeded protocol limits',
        'ERR_UNTRUSTED_WORKER_PROTOCOL',
        protocolError
      ))
    }
  }

  handleExit (code) {
    clearTimeout(this.startupTimer)
    clearTimeout(this.lifetimeTimer)
    this.signal?.removeEventListener('abort', this.onAbort)
    sessionSecrets.get(this).port?.close()

    let errorToEmit
    if (this.state !== 'closing' && this.state !== 'closed') {
      errorToEmit = this.failure ?? sessionError(
        `The worker exited unexpectedly (code ${code})`,
        'ERR_UNTRUSTED_WORKER_EXIT'
      )
      this.failure = errorToEmit
      this.state = 'closing'
      this.hostAbortController.abort(errorToEmit)
      this.rejectOutstanding(errorToEmit)
      this.rejectReadyOnce(errorToEmit)
    }

    this.state = 'closed'
    this.resolveClosed({ code, error: this.failure })
    try {
      if (errorToEmit) this.emitError(errorToEmit)
    } finally {
      this.emit('exit', code)
    }
  }

  fail (error) {
    if (this.state === 'closing' || this.state === 'closed') return
    this.failure = error
    this.state = 'closing'
    this.hostAbortController.abort(error)
    this.rejectReadyOnce(error)
    this.rejectOutstanding(error)
    void this.terminate()
    this.emitError(error)
  }

  rejectReadyOnce (error) {
    if (this.readySettled) return
    this.readySettled = true
    this.rejectReady(error)
  }

  rejectOutstanding (error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.outbound.length = 0
  }

  emitError (error) {
    if (this.listenerCount('error') > 0) this.emit('error', error)
  }

  assertOpen () {
    if (this.state === 'closing' || this.state === 'closed') {
      throw this.failure ?? sessionError('The session is closed', 'ERR_UNTRUSTED_WORKER_CLOSED')
    }
  }
}

function protocolMac (secret, direction, sequence, serialized) {
  const hmac = createHmac('sha256', secret)
  hmac.update(`${direction}\0${sequence}\0`)
  hmac.update(serialized)
  return hmac.digest('base64')
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
          ? error.message.slice(0, 8_192)
          : 'Host function failed',
        code: typeof error.code === 'string' ? error.code.slice(0, 8_192) : 'ERR_HOST_FUNCTION'
      }
    }
  } catch {}
  return {
    name: 'HostFunctionError',
    message: 'Host function failed',
    code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
  }
}

function sessionError (message, code, cause) {
  return new UntrustedCodeError(message, { code, cause })
}
