export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024
export const MAX_TIMEOUT_MS = 2_147_483_647
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 16,
  stackSizeMb: 4
})

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_ENVIRONMENT_NAME = /^(?:(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|OPENSSL_CONF|SSLKEYLOGFILE|NPM_CONFIG_USERCONFIG)$|LD_|DYLD_)/i

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
  const cloned = structuredClone(value)
  assertNoSharedMemory(cloned, label)
  return cloned
}

export function assertNoSharedMemory (value, label) {
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} must not contain shared memory`)
  }
  if (value === null || typeof value !== 'object') return

  const pending = [value]
  const seen = new WeakSet()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)

    if (typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer) {
      throw new TypeError(`${label} must not contain shared memory`)
    }
    if (current instanceof WebAssembly.Memory) {
      pending.push(current.buffer)
    } else if (ArrayBuffer.isView(current)) {
      pending.push(current.buffer)
    } else if (current instanceof Map) {
      for (const [key, entry] of current) pending.push(key, entry)
    } else if (current instanceof Set) {
      for (const entry of current) pending.push(entry)
    } else {
      for (const key of Reflect.ownKeys(current)) pending.push(current[key])
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
    if (limits[name] !== undefined) {
      if (typeof limits[name] !== 'number' || !Number.isFinite(limits[name]) || limits[name] <= 0) {
        throw new RangeError(`resourceLimits.${name} must be a positive number`)
      }
      result[name] = limits[name]
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
