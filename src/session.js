import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { serialize as v8Serialize } from 'node:v8'
import { MessagePort, Worker } from 'node:worker_threads'

import {
  abortError,
  assertNoSharedMemory,
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
import { invokeHostFunction, validateHostFunctions } from './host-functions.js'

const DEFAULT_STARTUP_TIMEOUT_MS = 1_000
const DEFAULT_MESSAGE_TIMEOUT_MS = 1_000
const DEFAULT_LIFETIME_TIMEOUT_MS = 30_000
const DEFAULT_MAX_HOST_FUNCTION_CALLS = 256
const DEFAULT_MAX_IN_FLIGHT_HOST_FUNCTIONS = 32

const SESSION_BOOTSTRAP = String.raw`
'use strict'

const { createHmac, randomBytes } = require('node:crypto')
const { serialize: v8Serialize } = require('node:v8')
const { MessageChannel, parentPort, workerData } = require('node:worker_threads')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const safeStructuredClone = globalThis.structuredClone
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
const sharedByteLength = typeof SharedArrayBuffer === 'undefined'
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
).get
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get
const wasmMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get
const hmacPrototype = Object.getPrototypeOf(createHmac('sha256', 'capture'))
const hmacUpdate = hmacPrototype.update
const hmacDigest = hmacPrototype.digest
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const objectFreeze = Object.freeze
const objectGetPrototypeOf = Object.getPrototypeOf
const objectPrototype = Object.prototype

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

function protocolMac(sequence, body) {
  const hmac = createHmac('sha256', protocolSecret)
  reflectApply(hmacUpdate, hmac, [String(sequence) + '\0'])
  reflectApply(hmacUpdate, hmac, [safeV8Serialize(body)])
  return reflectApply(hmacDigest, hmac, ['base64'])
}

function postToHost(body) {
  const sequence = ++outboundSequence
  rawPostToHost({ sequence, body, mac: protocolMac(sequence, body) })
}

function authenticateHostMessage(envelope) {
  if (envelope === null || typeof envelope !== 'object' ||
      !Number.isSafeInteger(envelope.sequence) || envelope.sequence !== inboundSequence + 1 ||
      envelope.body === null || typeof envelope.body !== 'object' ||
      typeof envelope.mac !== 'string' || envelope.mac !== protocolMac(envelope.sequence, envelope.body)) {
    throw new Error('Unauthenticated host protocol message')
  }
  inboundSequence = envelope.sequence
  return envelope.body
}

function cloneError(error) {
  if (error instanceof Error) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : 'Untrusted component failed',
      stack: typeof error.stack === 'string' ? error.stack : undefined,
      code: typeof error.code === 'string' ? error.code : undefined
    }
  }
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Untrusted component threw a non-Error value'
  }
}

function send(value) {
  const cloned = cloneValue(value, 'message')
  postToHost({ type: 'message', value: cloned })
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
    postToHost({ type: 'host-call', id, name, arguments: args })
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

  port.on('message', (message) => {
    let envelope
    try {
      envelope = authenticateHostMessage(message)
    } catch (error) {
      postToHost({ type: 'fatal', error: cloneError(error) })
      return
    }

    if (envelope.type === 'host-result' || envelope.type === 'host-error') {
      try {
        handleHostFunctionResult(envelope)
      } catch (error) {
        postToHost({ type: 'fatal', error: cloneError(error) })
      }
      return
    }

    const dispatched = reflectApply(promiseThen, processing, [() => dispatch(envelope)])
    processing = reflectApply(promiseCatch, dispatched, [(error) => {
      postToHost({ type: 'fatal', error: cloneError(error) })
    }])
  })
  // A ref'd MessagePort is exposed by process._getActiveHandles(). Keep the
  // worker alive with a lexical timer instead, and hide the protocol endpoint.
  port.unref()
  keepAlive = safeSetInterval(() => {}, 2_147_483_647)
  const host = createHostFunctions()

  if (workerData.type === 'script') {
    const execute = new AsyncFunction(
      'input',
      'send',
      'onMessage',
      'host',
      '"use strict";\n' + workerData.source
    )
    await execute(workerData.input, send, onMessage, host)
  } else {
    const encoded = Buffer.from(
      workerData.source + '\n//# sourceURL=secure-eval-worker-component.mjs\n',
      'utf8'
    ).toString('base64')
    const component = await import('data:text/javascript;base64,' + encoded)
    if (typeof component.default !== 'function') {
      throw new TypeError('The module default export must be a setup function')
    }
    await component.default(Object.freeze({
      input: workerData.input,
      send,
      onMessage,
      host
    }))
  }

  postToHost({ type: 'ready' })
}

reflectApply(promiseCatch, initialize(), [(error) => {
  if (port) {
    postToHost({ type: 'fatal', error: cloneError(error) })
  } else {
    parentPort.postMessage({ type: 'bootstrap-error', error: cloneError(error) })
    parentPort.close()
  }
}])
`

export function createUntrustedWorker (source, options = {}) {
  return new UntrustedWorkerSession(source, options)
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
    validateSource(source, maxSourceBytes)
    validateTimeout(startupTimeoutMs, 'startupTimeoutMs')
    validateTimeout(this.messageTimeoutMs, 'messageTimeoutMs')
    validateTimeout(this.lifetimeTimeoutMs, 'lifetimeTimeoutMs')
    validatePositiveInteger(this.maxHostFunctionCalls, 'maxHostFunctionCalls')
    validatePositiveInteger(this.maxInFlightHostFunctions, 'maxInFlightHostFunctions')

    const signal = options.signal
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal')
    }
    if (signal?.aborted) throw abortError(signal.reason)

    const startedAt = Date.now()
    const input = cloneWithoutSharedMemory(options.input, 'input')
    const environment = sanitizeEnvironment(options.environment)
    const resourceLimits = validateResourceLimits(options.resourceLimits)
    const hostFunctionConfiguration = validateHostFunctions(options.hostFunctions)
    if (signal?.aborted) throw abortError(signal.reason)
    const remainingStartupMs = startupTimeoutMs - (Date.now() - startedAt)
    if (remainingStartupMs <= 0) {
      throw sessionError(`Startup exceeded ${startupTimeoutMs} ms`, 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT')
    }

    this.state = 'starting'
    this.port = undefined
    this.pending = new Map()
    this.outbound = []
    this.nextRequestId = 1
    this.inboundSequence = 0
    this.outboundSequence = 0
    this.protocolSecret = undefined
    this.rawPortPost = undefined
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
      this.worker = new Worker(SESSION_BOOTSTRAP, {
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
          input,
          hostFunctionManifest: hostFunctionConfiguration.manifest
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

    this.worker.stdout.resume()
    this.worker.stderr.resume()
    this.worker.on('message', (message) => this.handleHandshake(message))
    this.worker.once('error', (error) => {
      this.fail(sessionError('The worker failed', 'ERR_UNTRUSTED_WORKER', error))
    })
    this.worker.once('exit', (code) => this.handleExit(code))

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
    assertProtocolSerializable(cloned, 'message')
    const send = () => this.sendProtocol({ type: 'message', value: cloned })
    if (this.state === 'ready') send()
    else this.outbound.push(send)
  }

  request (value, options = {}) {
    this.assertOpen()
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('request options must be an object')
    }
    const timeoutMs = options.timeoutMs ?? this.messageTimeoutMs
    validateTimeout(timeoutMs, 'timeoutMs')
    const cloned = cloneWithoutSharedMemory(value, 'message')
    assertProtocolSerializable(cloned, 'message')
    const id = this.nextRequestId++

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: undefined }
      this.pending.set(id, pending)
      const send = () => {
        if (this.state !== 'ready' || !this.pending.has(id)) return
        pending.timer = setTimeout(() => {
          const error = sessionError(
            `Message handling exceeded ${timeoutMs} ms`,
            'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
          )
          this.pending.delete(id)
          reject(error)
          this.fail(error)
        }, timeoutMs)
        this.sendProtocol({ type: 'request', id, value: cloned })
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
      this.port?.close()
    }
    this.termination = this.worker ? this.worker.terminate() : Promise.resolve(undefined)
    return this.termination
  }

  handleHandshake (message) {
    if (this.port) {
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

    this.port = message.port
    this.protocolSecret = message.protocolSecret
    this.rawPortPost = this.port.postMessage.bind(this.port)
    this.worker.removeAllListeners('message')
    this.port.on('message', (message) => {
      try {
        this.handleMessage(this.authenticateMessage(message))
      } catch (error) {
        this.fail(error)
      }
    })
    this.port.start()
  }

  sendProtocol (body) {
    const sequence = ++this.outboundSequence
    this.rawPortPost({
      sequence,
      body,
      mac: this.protocolMac(sequence, body)
    })
  }

  authenticateMessage (message) {
    if (message === null || typeof message !== 'object' ||
        !Number.isSafeInteger(message.sequence) || message.sequence !== this.inboundSequence + 1 ||
        message.body === null || typeof message.body !== 'object' ||
        typeof message.mac !== 'string') {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }

    const expected = Buffer.from(this.protocolMac(message.sequence, message.body), 'base64')
    const actual = Buffer.from(message.mac, 'base64')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw sessionError('Unauthenticated worker protocol message', 'ERR_UNTRUSTED_WORKER_PROTOCOL')
    }
    this.inboundSequence = message.sequence
    return message.body
  }

  protocolMac (sequence, body) {
    const hmac = createHmac('sha256', this.protocolSecret)
    hmac.update(`${sequence}\0`)
    hmac.update(v8Serialize(body))
    return hmac.digest('base64')
  }

  handleMessage (envelope) {
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
      this.resolveReady()
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
      if (envelope.type === 'response') pending.resolve(envelope.value)
      else pending.reject(remoteError(envelope.error))
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
      this.sendHostFunctionError(envelope.id, sessionError(
        'Host function call limit exceeded',
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
      ))
      return
    }
    if (this.inFlightHostFunctions >= this.maxInFlightHostFunctions) {
      this.sendHostFunctionError(envelope.id, sessionError(
        'Concurrent host function limit exceeded',
        'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
      ))
      return
    }

    this.hostFunctionCalls++
    this.inFlightHostFunctions++
    const requestIndex = this.hostFunctionCalls
    void this.invokeHostFunction(envelope, hostFunction, requestIndex)
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
    if (!this.port || (this.state !== 'starting' && this.state !== 'ready')) return
    this.sendProtocol({
      type: 'host-error',
      id,
      error: serializeHostError(error)
    })
  }

  handleExit (code) {
    clearTimeout(this.startupTimer)
    clearTimeout(this.lifetimeTimer)
    this.signal?.removeEventListener('abort', this.onAbort)
    this.port?.close()

    if (this.state !== 'closing' && this.state !== 'closed') {
      const error = this.failure ?? sessionError(
        `The worker exited unexpectedly (code ${code})`,
        'ERR_UNTRUSTED_WORKER_EXIT'
      )
      this.failure = error
      this.state = 'closing'
      this.hostAbortController.abort(error)
      this.rejectOutstanding(error)
      this.rejectReadyOnce(error)
      this.emitError(error)
    }

    this.state = 'closed'
    this.resolveClosed({ code, error: this.failure })
    this.emit('exit', code)
  }

  fail (error) {
    if (this.state === 'closing' || this.state === 'closed') return
    this.failure = error
    this.state = 'closing'
    this.hostAbortController.abort(error)
    this.rejectReadyOnce(error)
    this.rejectOutstanding(error)
    this.emitError(error)
    void this.terminate()
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

function assertProtocolSerializable (value, label) {
  try {
    v8Serialize(value)
  } catch {
    throw new TypeError(`${label} is not supported by the authenticated protocol`)
  }
}

function serializeHostError (error) {
  try {
    return {
      name: error instanceof Error && typeof error.name === 'string' ? error.name : 'Error',
      message: error instanceof Error && typeof error.message === 'string'
        ? error.message
        : 'Host function failed',
      code: error && typeof error.code === 'string' ? error.code : undefined
    }
  } catch {
    return { name: 'Error', message: 'Host function failed' }
  }
}

function sessionError (message, code, cause) {
  return new UntrustedCodeError(message, { code, cause })
}
