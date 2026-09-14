import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'

const Error = globalThis.Error
const TypeError = globalThis.TypeError
const contextStorage = new AsyncLocalStorage()
const SafeMap = Map
const arrayIsArray = Array.isArray
const arrayPush = Array.prototype.push
const asyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const asyncLocalStorageRun = AsyncLocalStorage.prototype.run
const bufferByteLength = Buffer.byteLength
const eventTargetAddEventListener = EventTarget.prototype.addEventListener
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener
const mapSet = Map.prototype.set
const objectEntries = Object.entries
const objectFreeze = Object.freeze
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const reflectApply = Reflect.apply
const reflectOwnKeys = Reflect.ownKeys
const regexpTest = RegExp.prototype.test
const setHas = Set.prototype.has
const stringStartsWith = String.prototype.startsWith
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

export class HostFunctionError extends Error {
  constructor (message, options = {}) {
    super(message, options)
    this.name = 'HostFunctionError'
    this.code = options.code ?? 'ERR_HOST_FUNCTION'
  }
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
      reflectApply(arrayIsArray, Array, [hostFunctions])) {
    throw new TypeError('hostFunctions must be an object')
  }

  rejectSymbolProperties(hostFunctions, 'hostFunctions')
  const functions = new SafeMap()
  const manifest = []
  const namespaceEntries = objectEntries(objectGetOwnPropertyDescriptors(hostFunctions))
  for (let namespaceIndex = 0; namespaceIndex < namespaceEntries.length; namespaceIndex++) {
    const namespace = namespaceEntries[namespaceIndex][0]
    const descriptor = namespaceEntries[namespaceIndex][1]
    validateDataProperty(descriptor, `Host function namespace ${JSON.stringify(namespace)}`)
    validateName(namespace, 'namespace')
    if (namespace in globalThis || reflectApply(setHas, RESERVED_NAMESPACES, [namespace]) ||
        reflectApply(stringStartsWith, namespace, [RESERVED_NAMESPACE_PREFIX])) {
      throw new TypeError(`Reserved host function namespace: ${namespace}`)
    }

    const group = descriptor.value
    if (group === null || typeof group !== 'object' ||
        reflectApply(arrayIsArray, Array, [group])) {
      throw new TypeError(`Host function namespace ${JSON.stringify(namespace)} must be an object`)
    }

    rejectSymbolProperties(group, `Host function namespace ${JSON.stringify(namespace)}`)
    const names = []
    const functionEntries = objectEntries(objectGetOwnPropertyDescriptors(group))
    for (let functionIndex = 0; functionIndex < functionEntries.length; functionIndex++) {
      const name = functionEntries[functionIndex][0]
      const functionDescriptor = functionEntries[functionIndex][1]
      validateDataProperty(functionDescriptor, `Host function ${JSON.stringify(`${namespace}.${name}`)}`)
      validateName(name, 'function')
      if (typeof functionDescriptor.value !== 'function') {
        throw new TypeError(`Host function ${JSON.stringify(`${namespace}.${name}`)} must be a function`)
      }
      const qualifiedName = `${namespace}.${name}`
      if (reflectApply(bufferByteLength, Buffer, [qualifiedName, 'utf8']) > 1_024) {
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

export async function invokeHostFunction (hostFunction, argumentsList, context) {
  const store = { active: true, context: objectFreeze(context) }
  const deactivate = () => { store.active = false }
  reflectApply(eventTargetAddEventListener, context.abortSignal, ['abort', deactivate, { once: true }])
  try {
    return await reflectApply(asyncLocalStorageRun, contextStorage, [
      store,
      () => reflectApply(hostFunction, undefined, argumentsList)
    ])
  } finally {
    deactivate()
    reflectApply(eventTargetRemoveEventListener, context.abortSignal, ['abort', deactivate])
  }
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
  if (!('value' in descriptor)) throw new TypeError(`${label} must be a data property`)
}

function validateName (name, kind) {
  if (!reflectApply(regexpTest, IDENTIFIER, [name]) ||
      reflectApply(setHas, RESERVED_NAMES, [name]) ||
      reflectApply(stringStartsWith, name, [RESERVED_NAMESPACE_PREFIX])) {
    throw new TypeError(`Invalid host function ${kind}: ${name}`)
  }
  if (reflectApply(bufferByteLength, Buffer, [name, 'utf8']) > 512) {
    throw new TypeError(`Host function ${kind} is too long: ${name}`)
  }
}
