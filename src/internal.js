import { isProxy } from 'node:util/types'

const safeIsProxy = isProxy

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
const weakSetDelete = WeakSet.prototype.delete
const arrayPush = Array.prototype.push
const arrayPop = Array.prototype.pop
const mapEntries = Map.prototype.entries
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get
const setValues = Set.prototype.values
const setHas = Set.prototype.has
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const dateTime = Date.prototype.getTime
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get
const regexpTest = RegExp.prototype.test
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const objectGetPrototypeOf = Object.getPrototypeOf
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const objectHasOwn = Object.hasOwn
const objectIsExtensible = Object.isExtensible
const objectKeys = Object.keys
const numberIsFinite = Number.isFinite
const numberIsSafeInteger = Number.isSafeInteger
const maxSafeInteger = Number.MAX_SAFE_INTEGER
const mathFloor = Math.floor
const bufferByteLength = Buffer.byteLength
const stringSlice = String.prototype.slice
const stringCharCodeAt = String.prototype.charCodeAt
const stringPadStart = String.prototype.padStart
const numberToString = Number.prototype.toString
const objectPrototype = Object.prototype
const arrayPrototype = Array.prototype
const arrayBufferPrototype = ArrayBuffer.prototype
const dataViewPrototype = DataView.prototype
const datePrototype = Date.prototype
const regexpPrototype = RegExp.prototype
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
const sharedByteLength = typeof SharedArrayBuffer === 'undefined'
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
).get
const dataViewBuffer = Object.getOwnPropertyDescriptor(dataViewPrototype, 'buffer').get
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'length'
).get
const wasmMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get
const SafeString = String
const untrustedCodeErrors = new SafeWeakSet()
const abortErrors = new SafeWeakSet()
const promiseSettlementGuardedValues = new SafeWeakSet()
const reflectDeleteProperty = Reflect.deleteProperty

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

export function assertSafePromiseEnvironment () {
  const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [objectPrototype, 'then'])
  if (descriptor &&
      (!reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
       typeof descriptor.value === 'function')) {
    throw new TypeError('Object.prototype.then must not be callable or accessor-backed')
  }
}

export function settleProtocolValue (resolve, reject, value) {
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

function removePromiseSettlementGuard (value) {
  if (!reflectApply(weakSetHas, promiseSettlementGuardedValues, [value])) return
  const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [value, 'then'])
  if (descriptor && reflectApply(objectHasOwn, undefined, [descriptor, 'value']) &&
      descriptor.value === undefined && descriptor.configurable === true &&
      descriptor.enumerable === false && descriptor.writable === false) {
    reflectApply(reflectDeleteProperty, undefined, [value, 'then'])
  }
  reflectApply(weakSetDelete, promiseSettlementGuardedValues, [value])
}

function unsupportedProtocolValue (label) {
  throw new TypeError(`${label} contains an unsupported value`)
}

function traversalLimitError (label, maxBytes, budgetName) {
  throw new RangeError(`${label} exceeds ${budgetName} (${maxBytes})`)
}

function createTraversalBudget (label, maxBytes, budgetName) {
  return {
    label,
    maxBytes,
    budgetName,
    objectNodes: 0,
    graphEdges: 0,
    properties: 0,
    collectionEntries: 0,
    stringCodeUnits: 0,
    backingBufferBytes: 0,
    backingBuffers: new SafeWeakSet()
  }
}

function chargeTraversalBudget (budget, field, amount) {
  if (budget.maxBytes === undefined || amount === 0) return
  if (!reflectApply(numberIsSafeInteger, undefined, [amount]) || amount < 0 ||
      budget[field] > budget.maxBytes - amount) {
    traversalLimitError(budget.label, budget.maxBytes, budget.budgetName)
  }
  budget[field] += amount
}

function chargeString (budget, value) {
  chargeTraversalBudget(budget, 'stringCodeUnits', value.length === 0 ? 1 : value.length)
}

function isCanonicalArrayIndex (key) {
  const numeric = +key
  return reflectApply(numberIsSafeInteger, undefined, [numeric]) && numeric >= 0 &&
    numeric < 0xffffffff && SafeString(numeric) === key
}

function reservePending (budget, pending, amount) {
  if (budget.maxBytes === undefined) return
  const limit = budget.maxBytes === maxSafeInteger
    ? maxSafeInteger
    : budget.maxBytes + 1
  if (!reflectApply(numberIsSafeInteger, undefined, [amount]) || amount < 0 ||
      pending.length > limit - amount) {
    traversalLimitError(budget.label, budget.maxBytes, budget.budgetName)
  }
}

function assertNoOwnProperties (value, label, budget) {
  const keys = reflectOwnKeys(value)
  chargeTraversalBudget(budget, 'properties', keys.length)
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] === 'string') chargeString(budget, keys[index])
  }
  if (keys.length !== 0) unsupportedProtocolValue(label)
}

function assertCanonicalRegExpProperties (value, label, budget) {
  const keys = reflectOwnKeys(value)
  if (keys.length !== 1 || keys[0] !== 'lastIndex') unsupportedProtocolValue(label)
  chargeTraversalBudget(budget, 'properties', 1)
  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, undefined, [value])
  const descriptor = descriptors.lastIndex
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
      typeof descriptor.value !== 'number' ||
      !reflectApply(numberIsSafeInteger, undefined, [descriptor.value]) ||
      descriptor.value < 0 || descriptor.enumerable || descriptor.configurable ||
      descriptor.writable !== true) {
    unsupportedProtocolValue(label)
  }
}

function chargeArrayBuffer (buffer, budget) {
  if (reflectApply(weakSetHas, budget.backingBuffers, [buffer])) return
  reflectApply(weakSetAdd, budget.backingBuffers, [buffer])
  chargeTraversalBudget(
    budget,
    'backingBufferBytes',
    reflectApply(arrayBufferByteLength, buffer, [])
  )
}

function assertViewWithinBudget (value, budget) {
  const buffer = getViewBuffer(value)
  if (!isSharedArrayBuffer(buffer)) chargeArrayBuffer(buffer, budget)
}

function assertCanonicalViewProperties (value, label, budget) {
  const prototype = objectGetPrototypeOf(value)
  if (prototype === dataViewPrototype) {
    assertNoOwnProperties(value, label, budget)
    return
  }
  const length = reflectApply(typedArrayLength, value, [])
  chargeTraversalBudget(budget, 'properties', length)
  const keys = reflectOwnKeys(value)
  if (keys.length !== length) unsupportedProtocolValue(label)
  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, undefined, [value])
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key !== 'string') unsupportedProtocolValue(label)
    const numeric = +key
    const descriptor = descriptors[key]
    if (!reflectApply(numberIsSafeInteger, undefined, [numeric]) || numeric < 0 ||
        numeric >= length || SafeString(numeric) !== key || !descriptor ||
        !reflectApply(objectHasOwn, undefined, [descriptor, 'value']) ||
        descriptor.writable !== true ||
        descriptor.enumerable !== true || descriptor.configurable !== true) {
      unsupportedProtocolValue(label)
    }
  }
}

function ownErrorOption (options, name) {
  if (options === undefined) return undefined
  if (options === null || (typeof options !== 'object' && typeof options !== 'function') ||
      safeIsProxy(options)) {
    throw new TypeError('Error options must be an object')
  }
  const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [options, name])
  if (descriptor === undefined) return undefined
  if (!reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
    throw new TypeError(`Error option ${name} must be a data property`)
  }
  return descriptor.value
}

function defineErrorProperty (error, name, value, enumerable) {
  reflectApply(objectDefineProperty, undefined, [error, name, {
    configurable: true,
    enumerable,
    value,
    writable: true
  }])
}

export class UntrustedCodeError extends SafeError {
  constructor (message, options) {
    let cause
    const errorOptions = objectCreate(null)
    if ((cause = ownErrorOption(options, 'cause')) !== undefined) {
      defineErrorProperty(errorOptions, 'cause', cause, false)
    }
    super(message, errorOptions)
    defineErrorProperty(this, 'name', 'UntrustedCodeError', false)
    defineErrorProperty(
      this,
      'code',
      ownErrorOption(options, 'code') ?? 'ERR_UNTRUSTED_CODE',
      true
    )
    const remoteStack = ownErrorOption(options, 'remoteStack')
    const remoteCode = ownErrorOption(options, 'remoteCode')
    if (remoteStack) defineErrorProperty(this, 'remoteStack', remoteStack, true)
    if (remoteCode) defineErrorProperty(this, 'remoteCode', remoteCode, true)
    reflectApply(weakSetAdd, untrustedCodeErrors, [this])
  }
}

export function isUntrustedCodeError (error) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return false
  return reflectApply(weakSetHas, untrustedCodeErrors, [error])
}

export function sanitizeEnvironment (environment = {}) {
  if (environment === null || typeof environment !== 'object' ||
      reflectApply(arrayIsArray, undefined, [environment])) {
    throw new TypeError('environment must be an object')
  }

  const sanitized = objectCreate(null)
  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, undefined, [environment])
  const names = reflectOwnKeys(environment)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (typeof name === 'symbol') {
      throw new TypeError('environment must not contain symbol properties')
    }
    const descriptor = descriptors[name]
    if (!descriptor.enumerable ||
        !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
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

export function cloneWithoutSharedMemory (
  value,
  label,
  maxBytes,
  budgetName = 'maxMessageBytes'
) {
  assertSupportedProtocolSource(value, label, maxBytes, budgetName)
  const cloned = safeStructuredClone(value)
  assertSupportedProtocolSource(cloned, label, maxBytes, budgetName)
  return cloned
}

export function assertSupportedProtocolSource (
  value,
  label,
  maxBytes,
  budgetName = 'maxMessageBytes'
) {
  const budget = createTraversalBudget(label, maxBytes, budgetName)
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
    if (kind !== 'object' || safeIsProxy(current)) {
      throw new TypeError(`${label} contains an unsupported value`)
    }
    removePromiseSettlementGuard(current)
    if (reflectApply(weakSetHas, seen, [current])) continue
    reflectApply(weakSetAdd, seen, [current])
    chargeTraversalBudget(budget, 'objectNodes', 1)

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
      chargeArrayBuffer(current, budget)
      assertNoOwnProperties(current, label, budget)
      continue
    }
    if (reflectApply(arrayBufferIsView, undefined, [current])) {
      if (isSharedArrayBuffer(getViewBuffer(current))) {
        throw new TypeError(`${label} must not contain shared memory`)
      }
      if (!reflectApply(setHas, allowedViewPrototypes, [objectGetPrototypeOf(current)])) {
        throw new TypeError(`${label} contains an unsupported value`)
      }
      assertViewWithinBudget(current, budget)
      assertCanonicalViewProperties(current, label, budget)
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
      assertNoOwnProperties(current, label, budget)
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
      assertCanonicalRegExpProperties(current, label, budget)
      continue
    }

    let collectionSize
    try {
      collectionSize = reflectApply(mapSize, current, [])
    } catch {}
    if (collectionSize !== undefined) {
      if (objectGetPrototypeOf(current) !== mapPrototype) {
        throw new TypeError(`${label} contains an unsupported value`)
      }
      assertNoOwnProperties(current, label, budget)
      chargeTraversalBudget(budget, 'collectionEntries', collectionSize)
      if (maxBytes !== undefined && collectionSize > reflectApply(mathFloor, undefined, [maxBytes / 2])) {
        traversalLimitError(label, maxBytes, budgetName)
      }
      const edgeCount = collectionSize * 2
      chargeTraversalBudget(budget, 'graphEdges', edgeCount)
      reservePending(budget, pending, edgeCount)
      const iterator = reflectApply(mapEntries, current, [])
      for (let index = 0; index < collectionSize; index++) {
        const item = reflectApply(mapIteratorNext, iterator, [])
        if (item.done) unsupportedProtocolValue(label)
        reflectApply(arrayPush, pending, [item.value[0], item.value[1]])
      }
      if (!reflectApply(mapIteratorNext, iterator, []).done) unsupportedProtocolValue(label)
      continue
    }
    try {
      collectionSize = reflectApply(setSize, current, [])
    } catch {
      collectionSize = undefined
    }
    if (collectionSize !== undefined) {
      if (objectGetPrototypeOf(current) !== setPrototype) {
        throw new TypeError(`${label} contains an unsupported value`)
      }
      assertNoOwnProperties(current, label, budget)
      chargeTraversalBudget(budget, 'collectionEntries', collectionSize)
      chargeTraversalBudget(budget, 'graphEdges', collectionSize)
      reservePending(budget, pending, collectionSize)
      const iterator = reflectApply(setValues, current, [])
      for (let index = 0; index < collectionSize; index++) {
        const item = reflectApply(setIteratorNext, iterator, [])
        if (item.done) unsupportedProtocolValue(label)
        reflectApply(arrayPush, pending, [item.value])
      }
      if (!reflectApply(setIteratorNext, iterator, []).done) unsupportedProtocolValue(label)
      continue
    }

    const isArray = reflectApply(arrayIsArray, undefined, [current])
    const prototype = objectGetPrototypeOf(current)
    if ((isArray && prototype !== arrayPrototype) ||
        (!isArray && prototype !== objectPrototype && prototype !== null)) {
      throw new TypeError(`${label} contains an unsupported value`)
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
      if (typeof key === 'symbol') throw new TypeError(`${label} contains an unsupported value`)
      if (!isArray || !isCanonicalArrayIndex(key)) chargeString(budget, key)
    }
    const descriptors = reflectApply(objectGetOwnPropertyDescriptors, undefined, [current])
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (isArray && key === 'length') continue
      const descriptor = descriptors[key]
      if (!descriptor.enumerable ||
          !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
        throw new TypeError(`${label} must contain only enumerable data properties`)
      }
      reflectApply(arrayPush, pending, [descriptor.value])
    }
  }
}

export function assertNoSharedMemory (
  value,
  label,
  maxBytes,
  budgetName = 'maxMessageBytes'
) {
  assertSupportedProtocolSource(value, label, maxBytes, budgetName)
}

export function assertSupportedProtocolValue (
  value,
  label,
  maxBytes,
  budgetName = 'maxMessageBytes'
) {
  assertSupportedProtocolSource(value, label, maxBytes, budgetName)
}

export function validatePositiveInteger (value, name) {
  if (!reflectApply(numberIsSafeInteger, undefined, [value]) || value <= 0) {
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
  if (reflectApply(bufferByteLength, undefined, [source, 'utf8']) > maxSourceBytes) {
    throw new RangeError(`source exceeds maxSourceBytes (${maxSourceBytes})`)
  }
}

export function validateResourceLimits (limits) {
  if (limits === undefined) return { ...DEFAULT_RESOURCE_LIMITS }
  if (limits === null || typeof limits !== 'object' ||
      reflectApply(arrayIsArray, undefined, [limits])) {
    throw new TypeError('resourceLimits must be an object')
  }

  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, undefined, [limits])
  const names = reflectOwnKeys(limits)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (typeof name === 'symbol') {
      throw new TypeError('resourceLimits must not contain symbol properties')
    }
    if (!reflectApply(objectHasOwn, undefined, [DEFAULT_RESOURCE_LIMITS, name])) {
      throw new TypeError(`Unknown resource limit: ${name}`)
    }
    const descriptor = descriptors[name]
    if (!descriptor.enumerable ||
        !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
      throw new TypeError(`resourceLimits.${name} must be an enumerable data property`)
    }
  }

  const result = { ...DEFAULT_RESOURCE_LIMITS }
  const defaultNames = objectKeys(DEFAULT_RESOURCE_LIMITS)
  for (let index = 0; index < defaultNames.length; index++) {
    const name = defaultNames[index]
    if (!reflectApply(objectHasOwn, undefined, [descriptors, name])) continue
    const value = descriptors[name].value
    if (typeof value !== 'number' || !reflectApply(numberIsFinite, undefined, [value]) || value <= 0) {
      throw new RangeError(`resourceLimits.${name} must be a positive number`)
    }
    result[name] = value
  }
  return result
}

export function abortError (reason) {
  const options = objectCreate(null)
  defineErrorProperty(options, 'cause', reason, false)
  const error = new SafeError('Execution was aborted', options)
  defineErrorProperty(error, 'name', 'AbortError', false)
  defineErrorProperty(error, 'code', 'ABORT_ERR', true)
  reflectApply(weakSetAdd, abortErrors, [error])
  return error
}

export function isAbortError (error) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return false
  return reflectApply(weakSetHas, abortErrors, [error])
}

function ownDataValue (object, key) {
  if (object === null || (typeof object !== 'object' && typeof object !== 'function') ||
      safeIsProxy(object)) {
    return undefined
  }
  const descriptor = reflectApply(objectGetOwnPropertyDescriptor, undefined, [object, key])
  if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
    return undefined
  }
  return descriptor.value
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
  const name = sanitizeRemoteText(ownDataValue(detail, 'name'), 'Error', 256)
  const message = sanitizeRemoteText(
    ownDataValue(detail, 'message'),
    'Untrusted code failed'
  )
  const stack = ownDataValue(detail, 'stack')
  return new UntrustedCodeError(`${name}: ${message}`, {
    code,
    remoteStack: typeof stack === 'string' ? stack : undefined,
    remoteCode: sanitizeRemoteText(ownDataValue(detail, 'code'), undefined, 256)
  })
}
