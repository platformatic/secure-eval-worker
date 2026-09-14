export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024
export const MAX_TIMEOUT_MS = 2_147_483_647
const MINIMUM_NODE_VERSION = [26, 5, 1]
const MAXIMUM_NODE_MAJOR = 27
const SafeError = globalThis.Error
const TypeError = globalThis.TypeError
const RangeError = globalThis.RangeError
const safeRegExpExec = RegExp.prototype.exec
const safeReflectApply = Reflect.apply

function unsupportedRuntimeError () {
  const error = new SafeError('secure-eval-worker requires Node.js >=26.5.1 <27')
  error.code = 'ERR_SECURE_EVAL_UNSUPPORTED_RUNTIME'
  return error
}

export function assertSupportedRuntime (version) {
  if (typeof version !== 'string') {
    throw unsupportedRuntimeError()
  }
  const match = safeReflectApply(safeRegExpExec, /^(\d+)\.(\d+)\.(\d+)$/, [version])
  if (!match) {
    throw unsupportedRuntimeError()
  }
  const major = +match[1]
  const minor = +match[2]
  const patch = +match[3]
  if (major !== MINIMUM_NODE_VERSION[0] || major >= MAXIMUM_NODE_MAJOR ||
      minor < MINIMUM_NODE_VERSION[1] ||
      (minor === MINIMUM_NODE_VERSION[1] && patch < MINIMUM_NODE_VERSION[2])) {
    throw unsupportedRuntimeError()
  }
}

assertSupportedRuntime(process.versions.node)

export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 16,
  stackSizeMb: 4
})

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_ENVIRONMENT_NAME = /^(?:(?:NODE_(?!ENV$)[A-Z0-9_]*|OPENSSL_CONF|SSLKEYLOGFILE|NPM_CONFIG_USERCONFIG)$|LD_|DYLD_)/i
const safeStructuredClone = globalThis.structuredClone
const SafeWeakSet = WeakSet
const reflectApply = Reflect.apply
const reflectOwnKeys = Reflect.ownKeys
const arrayBufferIsView = ArrayBuffer.isView
const arrayIsArray = Array.isArray
const weakSetHas = WeakSet.prototype.has
const weakSetAdd = WeakSet.prototype.add
const arrayPush = Array.prototype.push
const arrayPop = Array.prototype.pop
const mapEntries = Map.prototype.entries
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next
const setValues = Set.prototype.values
const setHas = Set.prototype.has
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const dateTime = Date.prototype.getTime
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get
const regexpTest = RegExp.prototype.test
const objectCreate = Object.create
const objectGetPrototypeOf = Object.getPrototypeOf
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const objectHasOwn = Object.hasOwn
const objectKeys = Object.keys
const numberIsFinite = Number.isFinite
const numberIsSafeInteger = Number.isSafeInteger
const bufferByteLength = Buffer.byteLength
const stringSlice = String.prototype.slice
const stringCharCodeAt = String.prototype.charCodeAt
const stringPadStart = String.prototype.padStart
const numberToString = Number.prototype.toString
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
const sharedByteLength = typeof SharedArrayBuffer === 'undefined'
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
).get
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get
const wasmMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get

function isSharedArrayBuffer (value) {
  if (!sharedByteLength || value === null || typeof value !== 'object') return false
  try {
    reflectApply(sharedByteLength, value, [])
    return true
  } catch {
    return false
  }
}

function getViewBuffer (value) {
  try {
    return reflectApply(typedArrayBuffer, value, [])
  } catch {
    return reflectApply(dataViewBuffer, value, [])
  }
}

function getWasmMemoryBuffer (value) {
  try {
    return reflectApply(wasmMemoryBuffer, value, [])
  } catch {
    return undefined
  }
}

export class UntrustedCodeError extends SafeError {
  constructor (message, options = {}) {
    super(message, options)
    this.name = 'UntrustedCodeError'
    this.code = options.code ?? 'ERR_UNTRUSTED_CODE'
    if (options.remoteStack) this.remoteStack = options.remoteStack
    if (options.remoteCode) this.remoteCode = options.remoteCode
  }
}

export function sanitizeEnvironment (environment = {}) {
  if (environment === null || typeof environment !== 'object' ||
      reflectApply(arrayIsArray, Array, [environment])) {
    throw new TypeError('environment must be an object')
  }

  const sanitized = objectCreate(null)
  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, Object, [environment])
  const names = reflectOwnKeys(environment)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (typeof name === 'symbol') {
      throw new TypeError('environment must not contain symbol properties')
    }
    const descriptor = descriptors[name]
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Environment variable ${name} must be an enumerable data property`)
    }
    const value = descriptor.value
    if (!reflectApply(regexpTest, ENVIRONMENT_NAME, [name])) {
      throw new TypeError(`Invalid environment variable name: ${name}`)
    }
    if (reflectApply(regexpTest, BLOCKED_ENVIRONMENT_NAME, [name])) {
      throw new TypeError(`Environment variable is not allowed: ${name}`)
    }
    if (typeof value !== 'string') {
      throw new TypeError(`Environment variable ${name} must be a string`)
    }
    sanitized[name] = value
  }
  return sanitized
}

export function cloneWithoutSharedMemory (value, label) {
  assertSupportedProtocolSource(value, label)
  const cloned = safeStructuredClone(value)
  assertNoSharedMemory(cloned, label)
  return cloned
}

export function assertSupportedProtocolSource (value, label) {
  const pending = [value]
  const seen = new SafeWeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null) continue
    const kind = typeof current
    if (kind === 'string' || kind === 'boolean' || kind === 'number' ||
        kind === 'bigint' || kind === 'undefined') continue
    if (kind !== 'object') throw new TypeError(`${label} contains an unsupported value`)
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])

    if (isSharedArrayBuffer(current)) {
      throw new TypeError(`${label} must not contain shared memory`)
    }
    const memoryBuffer = getWasmMemoryBuffer(current)
    if (memoryBuffer !== undefined) {
      if (isSharedArrayBuffer(memoryBuffer)) {
        throw new TypeError(`${label} must not contain shared memory`)
      }
      throw new TypeError(`${label} contains an unsupported value`)
    }
    let branded = false
    try {
      reflectApply(arrayBufferByteLength, current, [])
      branded = true
    } catch {}
    if (branded) {
      if (objectGetPrototypeOf(current) !== arrayBufferPrototype) {
        throw new TypeError(`${label} contains an unsupported value`)
      }
      continue
    }
    if (reflectApply(arrayBufferIsView, ArrayBuffer, [current])) {
      if (isSharedArrayBuffer(getViewBuffer(current))) {
        throw new TypeError(`${label} must not contain shared memory`)
      }
      if (!reflectApply(setHas, allowedViewPrototypes, [objectGetPrototypeOf(current)])) {
        throw new TypeError(`${label} contains an unsupported value`)
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
        throw new TypeError(`${label} contains an unsupported value`)
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
        throw new TypeError(`${label} contains an unsupported value`)
      }
      continue
    }

    let iterator
    try {
      iterator = reflectApply(mapEntries, current, [])
    } catch {}
    if (iterator) {
      if (objectGetPrototypeOf(current) !== mapPrototype) {
        throw new TypeError(`${label} contains an unsupported value`)
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
        throw new TypeError(`${label} contains an unsupported value`)
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
      throw new TypeError(`${label} contains an unsupported value`)
    }
    const descriptors = reflectApply(objectGetOwnPropertyDescriptors, Object, [current])
    const keys = reflectOwnKeys(current)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (isArray && key === 'length') continue
      if (typeof key === 'symbol') throw new TypeError(`${label} contains an unsupported value`)
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${label} must contain only enumerable data properties`)
      }
      reflectApply(arrayPush, pending, [descriptor.value])
    }
  }
}

export function assertNoSharedMemory (value, label) {
  if (value === null || typeof value !== 'object') return

  const pending = [value]
  const seen = new SafeWeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null || typeof current !== 'object') continue
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])

    if (isSharedArrayBuffer(current)) {
      throw new TypeError(`${label} must not contain shared memory`)
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

export function assertSupportedProtocolValue (value, label) {
  const pending = [value]
  const seen = new SafeWeakSet()
  while (pending.length > 0) {
    const current = reflectApply(arrayPop, pending, [])
    if (current === null) continue
    const kind = typeof current
    if (kind === 'string' || kind === 'boolean' || kind === 'number' ||
        kind === 'bigint' || kind === 'undefined') continue
    if (kind !== 'object') throw new TypeError(`${label} contains an unsupported value`)
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])

    if (isSharedArrayBuffer(current)) throw new TypeError(`${label} contains an unsupported value`)
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
      throw new TypeError(`${label} contains an unsupported value`)
    }
    const keys = reflectOwnKeys(current)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (typeof key === 'symbol') throw new TypeError(`${label} contains an unsupported value`)
      reflectApply(arrayPush, pending, [current[key]])
    }
  }
}

export function validatePositiveInteger (value, name) {
  if (!reflectApply(numberIsSafeInteger, Number, [value]) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

export function validateTimeout (value, name) {
  validatePositiveInteger(value, name)
  if (value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must not exceed ${MAX_TIMEOUT_MS}`)
  }
}

export function validateSource (source, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  validatePositiveInteger(maxSourceBytes, 'maxSourceBytes')
  if (reflectApply(bufferByteLength, Buffer, [source, 'utf8']) > maxSourceBytes) {
    throw new RangeError(`source exceeds maxSourceBytes (${maxSourceBytes})`)
  }
}

export function validateResourceLimits (limits) {
  if (limits === undefined) return { ...DEFAULT_RESOURCE_LIMITS }
  if (limits === null || typeof limits !== 'object' ||
      reflectApply(arrayIsArray, Array, [limits])) {
    throw new TypeError('resourceLimits must be an object')
  }

  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, Object, [limits])
  const names = reflectOwnKeys(limits)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (typeof name === 'symbol') {
      throw new TypeError('resourceLimits must not contain symbol properties')
    }
    if (!reflectApply(objectHasOwn, Object, [DEFAULT_RESOURCE_LIMITS, name])) {
      throw new TypeError(`Unknown resource limit: ${name}`)
    }
    const descriptor = descriptors[name]
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`resourceLimits.${name} must be an enumerable data property`)
    }
  }

  const result = { ...DEFAULT_RESOURCE_LIMITS }
  const defaultNames = objectKeys(DEFAULT_RESOURCE_LIMITS)
  for (let index = 0; index < defaultNames.length; index++) {
    const name = defaultNames[index]
    if (!reflectApply(objectHasOwn, Object, [descriptors, name])) continue
    const value = descriptors[name].value
    if (typeof value !== 'number' || !reflectApply(numberIsFinite, Number, [value]) || value <= 0) {
      throw new RangeError(`resourceLimits.${name} must be a positive number`)
    }
    result[name] = value
  }
  return result
}

export function abortError (reason) {
  const error = new SafeError('Execution was aborted', { cause: reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function sanitizeRemoteText (value, fallback, maxLength = 8_192) {
  if (typeof value !== 'string') return fallback
  const source = reflectApply(stringSlice, value, [0, maxLength])
  let result = ''
  for (let index = 0; index < source.length; index++) {
    const characterCode = reflectApply(stringCharCodeAt, source, [index])
    if (characterCode < 0x20 || (characterCode >= 0x7f && characterCode <= 0x9f) ||
        characterCode === 0x2028 || characterCode === 0x2029 ||
        (characterCode >= 0x202a && characterCode <= 0x202e) ||
        (characterCode >= 0x2066 && characterCode <= 0x2069)) {
      const hexadecimal = reflectApply(numberToString, characterCode, [16])
      result += `\\u${reflectApply(stringPadStart, hexadecimal, [4, '0'])}`
    } else {
      result += source[index]
    }
  }
  return result
}

export function remoteError (detail, code = 'ERR_UNTRUSTED_CODE') {
  const name = sanitizeRemoteText(detail?.name, 'Error', 256)
  const message = sanitizeRemoteText(detail?.message, 'Untrusted code failed')
  return new UntrustedCodeError(`${name}: ${message}`, {
    code,
    remoteStack: detail && typeof detail.stack === 'string' ? detail.stack : undefined,
    remoteCode: sanitizeRemoteText(detail?.code, undefined, 256)
  })
}
