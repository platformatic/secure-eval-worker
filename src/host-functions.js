import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'

const contextStorage = new AsyncLocalStorage()
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
  const store = contextStorage.getStore()
  return store?.active === true && store.context.sessionId === sessionId
}

export function getHostFunctionContext () {
  const store = contextStorage.getStore()
  if (!store?.active) {
    throw new Error('getHostFunctionContext() must be called from an active host function')
  }
  return store.context
}

export function validateHostFunctions (hostFunctions = {}) {
  if (hostFunctions === null || typeof hostFunctions !== 'object' || Array.isArray(hostFunctions)) {
    throw new TypeError('hostFunctions must be an object')
  }

  rejectSymbolProperties(hostFunctions, 'hostFunctions')
  const functions = new Map()
  const manifest = []
  for (const [namespace, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(hostFunctions))) {
    validateDataProperty(descriptor, `Host function namespace ${JSON.stringify(namespace)}`)
    validateName(namespace, 'namespace')
    if (namespace in globalThis || RESERVED_NAMESPACES.has(namespace) ||
        namespace.startsWith(RESERVED_NAMESPACE_PREFIX)) {
      throw new TypeError(`Reserved host function namespace: ${namespace}`)
    }

    const group = descriptor.value
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      throw new TypeError(`Host function namespace ${JSON.stringify(namespace)} must be an object`)
    }

    rejectSymbolProperties(group, `Host function namespace ${JSON.stringify(namespace)}`)
    const names = []
    for (const [name, functionDescriptor] of Object.entries(Object.getOwnPropertyDescriptors(group))) {
      validateDataProperty(functionDescriptor, `Host function ${JSON.stringify(`${namespace}.${name}`)}`)
      validateName(name, 'function')
      if (typeof functionDescriptor.value !== 'function') {
        throw new TypeError(`Host function ${JSON.stringify(`${namespace}.${name}`)} must be a function`)
      }
      const qualifiedName = `${namespace}.${name}`
      if (Buffer.byteLength(qualifiedName, 'utf8') > 1_024) {
        throw new TypeError(`Host function name is too long: ${qualifiedName}`)
      }
      functions.set(qualifiedName, functionDescriptor.value)
      names.push(name)
    }
    manifest.push(Object.freeze({ namespace, names: Object.freeze(names) }))
  }

  return {
    functions,
    manifest: Object.freeze(manifest)
  }
}

export async function invokeHostFunction (hostFunction, argumentsList, context) {
  const store = { active: true, context: Object.freeze(context) }
  const deactivate = () => { store.active = false }
  context.abortSignal.addEventListener('abort', deactivate, { once: true })
  try {
    return await contextStorage.run(store, () => hostFunction(...argumentsList))
  } finally {
    deactivate()
    context.abortSignal.removeEventListener('abort', deactivate)
  }
}

function rejectSymbolProperties (value, label) {
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${label} must not contain symbol properties`)
  }
}

function validateDataProperty (descriptor, label) {
  if (!descriptor.enumerable) throw new TypeError(`${label} must be enumerable`)
  if (!('value' in descriptor)) throw new TypeError(`${label} must be a data property`)
}

function validateName (name, kind) {
  if (!IDENTIFIER.test(name) || RESERVED_NAMES.has(name) || name.startsWith(RESERVED_NAMESPACE_PREFIX)) {
    throw new TypeError(`Invalid host function ${kind}: ${name}`)
  }
  if (Buffer.byteLength(name, 'utf8') > 512) {
    throw new TypeError(`Host function ${kind} is too long: ${name}`)
  }
}
