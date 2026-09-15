import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { isPromise, isProxy } from 'node:util/types'

const safeIsPromise = isPromise
const safeIsProxy = isProxy
const Error = globalThis.Error
const TypeError = globalThis.TypeError
const contextStorage = new AsyncLocalStorage()
const SafeMap = Map
const SafePromise = Promise
const SafeWeakSet = WeakSet
const arrayIsArray = Array.isArray
const objectPrototype = Object.prototype
const arrayPush = Array.prototype.push
const asyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const asyncLocalStorageRun = AsyncLocalStorage.prototype.run
const bufferByteLength = Buffer.byteLength
const eventTargetAddEventListener = EventTarget.prototype.addEventListener
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener
const mapSet = Map.prototype.set
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const objectEntries = Object.entries
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetPrototypeOf = Object.getPrototypeOf
const objectHasOwn = Object.hasOwn
const promiseThen = Promise.prototype.then
const jsonStringify = JSON.stringify
const objectFreeze = Object.freeze
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const reflectApply = Reflect.apply
const reflectOwnKeys = Reflect.ownKeys
const regexpTest = RegExp.prototype.test
const setHas = Set.prototype.has
const stringStartsWith = String.prototype.startsWith
const weakSetAdd = WeakSet.prototype.add
const weakSetHas = WeakSet.prototype.has
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'then'])
const RESERVED_NAMESPACES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'host', 'if', 'implements', 'import', 'in',
  'input', 'instanceof', 'interface', 'let', 'new', 'null', 'onMessage',
  'package', 'private', 'protected', 'public', 'return', 'send', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield'
])
const RESERVED_NAMESPACE_PREFIX = '__secureEval'
const publicHostFunctionErrors = new SafeWeakSet()
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
const CONTROL_PROMISE_CONSTRUCTOR_DESCRIPTOR = objectFreeze({
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false
})
const NATIVE_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR = objectFreeze({
  configurable: false,
  enumerable: false,
  value: SafePromise,
  writable: false
})

function hardenControlPromise (promise) {
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
      CONTROL_PROMISE_CONSTRUCTOR_DESCRIPTOR
    ])
  }
  return promise
}

function hardenAwaitPromise (promise) {
  reflectApply(objectDefineProperty, undefined, [
    promise,
    'constructor',
    NATIVE_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR
  ])
  return promise
}

function createControlPromise (executor) {
  return hardenControlPromise(new SafePromise(executor))
}

function bridgeControlPromise (promise) {
  const bridge = new SafePromise((resolve, reject) => {
    reflectApply(promiseThen, promise, [resolve, reject])
  })
  return hardenAwaitPromise(bridge)
}

function createValueOutcome (value) {
  const outcome = objectCreate(null)
  reflectApply(objectDefineProperty, undefined, [outcome, 'value', {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  }])
  return objectFreeze(outcome)
}

function sameDescriptor (actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected
  for (let index = 0; index < PROMISE_DESCRIPTOR_FIELDS.length; index++) {
    const name = PROMISE_DESCRIPTOR_FIELDS[index]
    const actualHas = reflectApply(objectHasOwn, undefined, [actual, name])
    const expectedHas = reflectApply(objectHasOwn, undefined, [expected, name])
    if (actualHas !== expectedHas || (actualHas && actual[name] !== expected[name])) return false
  }
  return true
}

function isCanonicalPromise (value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  if (safeIsProxy(value) || !safeIsPromise(value)) return false
  try {
    return reflectApply(objectGetPrototypeOf, undefined, [value]) === promisePrototype &&
      reflectApply(objectGetOwnPropertyDescriptor, undefined, [value, 'constructor']) === undefined &&
      sameDescriptor(
        reflectApply(objectGetOwnPropertyDescriptor, undefined, [promisePrototype, 'constructor']),
        promisePrototypeConstructorDescriptor
      ) &&
      sameDescriptor(
        reflectApply(objectGetOwnPropertyDescriptor, undefined, [SafePromise, Symbol.species]),
        promiseSpeciesDescriptor
      )
  } catch {
    return false
  }
}

function unsafePromiseRejection () {
  return createControlPromise((resolve, reject) => {
    reject(new TypeError('Promise cannot be observed safely'))
  })
}

function adoptValue (value) {
  const objectLike = (typeof value === 'object' && value !== null) || typeof value === 'function'
  if (objectLike && safeIsProxy(value)) return unsafePromiseRejection()
  if (!safeIsPromise(value)) {
    return createControlPromise(resolve => resolve(createValueOutcome(value)))
  }
  if (!isCanonicalPromise(value)) return unsafePromiseRejection()

  return createControlPromise((resolve, reject) => {
    try {
      reflectApply(promiseThen, value, [
        result => resolve(createValueOutcome(result)),
        reject
      ])
    } catch (error) {
      reject(error)
    }
  })
}

function normalizeHostFunctionErrorOptions (options) {
  if (options === undefined) options = objectCreate(null)
  if (options === null || typeof options !== 'object' ||
      reflectApply(arrayIsArray, undefined, [options]) || safeIsProxy(options)) {
    throw new TypeError('HostFunctionError options must be a plain object')
  }
  const prototype = reflectApply(objectGetPrototypeOf, undefined, [options])
  if (prototype !== objectPrototype && prototype !== null) {
    throw new TypeError('HostFunctionError options must be a plain object')
  }
  const descriptors = reflectApply(objectGetOwnPropertyDescriptors, undefined, [options])
  const names = reflectOwnKeys(options)
  const errorOptions = objectCreate(null)
  let code = 'ERR_HOST_FUNCTION'
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (typeof name !== 'string' || (name !== 'code' && name !== 'cause')) {
      throw new TypeError('HostFunctionError options contain an unsupported property')
    }
    const descriptor = descriptors[name]
    if (!descriptor || !reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
      throw new TypeError(`HostFunctionError option ${name} must be a data property`)
    }
    if (name === 'code') {
      if (typeof descriptor.value !== 'string') {
        throw new TypeError('HostFunctionError option code must be a string')
      }
      code = descriptor.value
    } else {
      reflectApply(objectDefineProperty, undefined, [errorOptions, 'cause', {
        configurable: true,
        enumerable: false,
        value: descriptor.value,
        writable: true
      }])
    }
  }
  return objectFreeze({ code, errorOptions })
}

export class HostFunctionError extends Error {
  constructor (message, options) {
    let normalized
    super(message, (normalized = normalizeHostFunctionErrorOptions(options)).errorOptions)
    reflectApply(objectDefineProperty, undefined, [this, 'name', {
      configurable: true,
      enumerable: false,
      value: 'HostFunctionError',
      writable: true
    }])
    reflectApply(objectDefineProperty, undefined, [this, 'code', {
      configurable: true,
      enumerable: true,
      value: normalized.code,
      writable: true
    }])
    reflectApply(weakSetAdd, publicHostFunctionErrors, [this])
  }
}

export function isPublicHostFunctionError (error) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return false
  return reflectApply(weakSetHas, publicHostFunctionErrors, [error])
}

export function isHostFunctionContextActiveForSession (sessionId) {
  const store = reflectApply(asyncLocalStorageGetStore, contextStorage, [])
  return store?.active === true && store.context.sessionId === sessionId
}

export function getHostFunctionContext () {
  const store = reflectApply(asyncLocalStorageGetStore, contextStorage, [])
  if (!store?.active) {
    throw new Error('getHostFunctionContext() must be called from an active host function')
  }
  return store.context
}

export function validateHostFunctions (hostFunctions = {}) {
  if (hostFunctions === null || typeof hostFunctions !== 'object' ||
      reflectApply(arrayIsArray, undefined, [hostFunctions])) {
    throw new TypeError('hostFunctions must be an object')
  }

  rejectSymbolProperties(hostFunctions, 'hostFunctions')
  const functions = new SafeMap()
  const manifest = []
  const namespaceEntries = objectEntries(objectGetOwnPropertyDescriptors(hostFunctions))
  for (let namespaceIndex = 0; namespaceIndex < namespaceEntries.length; namespaceIndex++) {
    const namespace = namespaceEntries[namespaceIndex][0]
    const descriptor = namespaceEntries[namespaceIndex][1]
    validateDataProperty(descriptor, `Host function namespace ${reflectApply(jsonStringify, undefined, [namespace])}`)
    validateName(namespace, 'namespace')
    if (namespace in globalThis || reflectApply(setHas, RESERVED_NAMESPACES, [namespace]) ||
        reflectApply(stringStartsWith, namespace, [RESERVED_NAMESPACE_PREFIX])) {
      throw new TypeError(`Reserved host function namespace: ${namespace}`)
    }

    const group = descriptor.value
    if (group === null || typeof group !== 'object' ||
        reflectApply(arrayIsArray, undefined, [group])) {
      throw new TypeError(`Host function namespace ${reflectApply(jsonStringify, undefined, [namespace])} must be an object`)
    }

    rejectSymbolProperties(group, `Host function namespace ${reflectApply(jsonStringify, undefined, [namespace])}`)
    const names = []
    const functionEntries = objectEntries(objectGetOwnPropertyDescriptors(group))
    for (let functionIndex = 0; functionIndex < functionEntries.length; functionIndex++) {
      const name = functionEntries[functionIndex][0]
      const functionDescriptor = functionEntries[functionIndex][1]
      validateDataProperty(functionDescriptor, `Host function ${reflectApply(jsonStringify, undefined, [`${namespace}.${name}`])}`)
      validateName(name, 'function')
      if (typeof functionDescriptor.value !== 'function') {
        throw new TypeError(`Host function ${reflectApply(jsonStringify, undefined, [`${namespace}.${name}`])} must be a function`)
      }
      const qualifiedName = `${namespace}.${name}`
      if (reflectApply(bufferByteLength, undefined, [qualifiedName, 'utf8']) > 1_024) {
        throw new TypeError(`Host function name is too long: ${qualifiedName}`)
      }
      reflectApply(mapSet, functions, [qualifiedName, functionDescriptor.value])
      reflectApply(arrayPush, names, [name])
    }
    reflectApply(arrayPush, manifest, [objectFreeze({ namespace, names: objectFreeze(names) })])
  }

  return {
    functions,
    manifest: objectFreeze(manifest)
  }
}

export function invokeHostFunction (hostFunction, argumentsList, context) {
  const store = { active: true, context: objectFreeze(context) }
  const deactivate = () => { store.active = false }
  const finish = () => {
    deactivate()
    reflectApply(eventTargetRemoveEventListener, context.abortSignal, ['abort', deactivate])
  }
  reflectApply(eventTargetAddEventListener, context.abortSignal, ['abort', deactivate, { once: true }])

  let adopted
  try {
    const invocation = reflectApply(asyncLocalStorageRun, contextStorage, [
      store,
      () => reflectApply(hostFunction, undefined, argumentsList)
    ])
    adopted = adoptValue(invocation)
  } catch (error) {
    try {
      finish()
    } catch (cleanupError) {
      error = cleanupError
    }
    return bridgeControlPromise(createControlPromise((resolve, reject) => reject(error)))
  }

  const settled = createControlPromise((resolve, reject) => {
    reflectApply(promiseThen, adopted, [
      (value) => {
        try {
          finish()
          resolve(value)
        } catch (error) {
          reject(error)
        }
      },
      (error) => {
        try {
          finish()
          reject(error)
        } catch (cleanupError) {
          reject(cleanupError)
        }
      }
    ])
  })
  return bridgeControlPromise(settled)
}

function rejectSymbolProperties (value, label) {
  const keys = reflectOwnKeys(value)
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] === 'symbol') {
      throw new TypeError(`${label} must not contain symbol properties`)
    }
  }
}

function validateDataProperty (descriptor, label) {
  if (!descriptor.enumerable) throw new TypeError(`${label} must be enumerable`)
  if (!reflectApply(objectHasOwn, undefined, [descriptor, 'value'])) {
    throw new TypeError(`${label} must be a data property`)
  }
}

function validateName (name, kind) {
  if (!reflectApply(regexpTest, IDENTIFIER, [name]) ||
      reflectApply(setHas, RESERVED_NAMES, [name]) ||
      reflectApply(stringStartsWith, name, [RESERVED_NAMESPACE_PREFIX])) {
    throw new TypeError(`Invalid host function ${kind}: ${name}`)
  }
  if (reflectApply(bufferByteLength, undefined, [name, 'utf8']) > 512) {
    throw new TypeError(`Host function ${kind} is too long: ${name}`)
  }
}
