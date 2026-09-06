export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024
export const MAX_TIMEOUT_MS = 2_147_483_647
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 16,
  stackSizeMb: 4
})

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_ENVIRONMENT_NAME = /^(?:(?:NODE_(?!ENV$)[A-Z0-9_]*|OPENSSL_CONF|SSLKEYLOGFILE|NPM_CONFIG_USERCONFIG)$|LD_|DYLD_)/i
const safeStructuredClone = globalThis.structuredClone
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
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const dateTime = Date.prototype.getTime
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get
const objectGetPrototypeOf = Object.getPrototypeOf
const objectPrototype = Object.prototype
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

export class UntrustedCodeError extends Error {
  constructor (message, options = {}) {
    super(message, options)
    this.name = 'UntrustedCodeError'
    this.code = options.code ?? 'ERR_UNTRUSTED_CODE'
    if (options.remoteStack) this.remoteStack = options.remoteStack
    if (options.remoteCode) this.remoteCode = options.remoteCode
  }
}

export function sanitizeEnvironment (environment = {}) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('environment must be an object')
  }

  const sanitized = Object.create(null)
  for (const [name, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new TypeError(`Invalid environment variable name: ${name}`)
    }
    if (BLOCKED_ENVIRONMENT_NAME.test(name)) {
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
  const cloned = safeStructuredClone(value)
  assertNoSharedMemory(cloned, label)
  return cloned
}

export function assertNoSharedMemory (value, label) {
  if (value === null || typeof value !== 'object') return

  const pending = [value]
  const seen = new WeakSet()
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

    for (const key of reflectOwnKeys(current)) {
      reflectApply(arrayPush, pending, [current[key]])
    }
  }
}

export function assertSupportedProtocolValue (value, label) {
  const pending = [value]
  const seen = new WeakSet()
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
    for (const key of reflectOwnKeys(current)) {
      if (typeof key === 'symbol') throw new TypeError(`${label} contains an unsupported value`)
      reflectApply(arrayPush, pending, [current[key]])
    }
  }
}

export function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
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
  if (Buffer.byteLength(source, 'utf8') > maxSourceBytes) {
    throw new RangeError(`source exceeds maxSourceBytes (${maxSourceBytes})`)
  }
}

export function validateResourceLimits (limits) {
  if (limits === undefined) return { ...DEFAULT_RESOURCE_LIMITS }
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('resourceLimits must be an object')
  }

  const unknown = Object.keys(limits).filter((name) => !(name in DEFAULT_RESOURCE_LIMITS))
  if (unknown.length > 0) {
    throw new TypeError(`Unknown resource limit: ${unknown[0]}`)
  }

  const result = { ...DEFAULT_RESOURCE_LIMITS }
  for (const name of Object.keys(DEFAULT_RESOURCE_LIMITS)) {
    const value = limits[name]
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new RangeError(`resourceLimits.${name} must be a positive number`)
      }
      result[name] = value
    }
  }
  return result
}

export function abortError (reason) {
  const error = new Error('Execution was aborted', { cause: reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

export function remoteError (detail, code = 'ERR_UNTRUSTED_CODE') {
  const name = detail && typeof detail.name === 'string' ? detail.name : 'Error'
  const message = detail && typeof detail.message === 'string'
    ? detail.message
    : 'Untrusted code failed'
  return new UntrustedCodeError(`${name}: ${message}`, {
    code,
    remoteStack: detail && typeof detail.stack === 'string' ? detail.stack : undefined,
    remoteCode: detail && typeof detail.code === 'string' ? detail.code : undefined
  })
}
