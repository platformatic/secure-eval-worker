import { randomUUID } from 'node:crypto'
import {
  chmod as chmodPath,
  close as closeDescriptor,
  constants,
  Dir,
  fstat as statDescriptor,
  link as linkPath,
  lstat as lstatPath,
  mkdir as mkdirPath,
  mkdtemp as makeTemporaryDirectory,
  open as openDescriptor,
  opendir as openDirectory,
  read as readDescriptor,
  realpath as realPath,
  rmdir as removeDirectoryPath,
  stat as statPath,
  unlink as unlinkPath,
  write as writeDescriptor
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { domainToASCII, fileURLToPath } from 'node:url'

import { abortError, isAbortError, isUntrustedCodeError, UntrustedCodeError } from './internal.js'

const safeIsAbortError = isAbortError
const safeIsUntrustedCodeError = isUntrustedCodeError
const SafeError = globalThis.Error
const TypeError = globalThis.TypeError
const READ_CHUNK_BYTES = 64 * 1024
// Snapshot every security-sensitive builtin binding before caller-controlled
// option processing can synchronize poisoned CommonJS builtin exports.
const safeRandomUUID = randomUUID
const safeChmodPath = chmodPath
const safeCloseDescriptor = closeDescriptor
const safeStatDescriptor = statDescriptor
const safeLinkPath = linkPath
const safeLstatPath = lstatPath
const safeMkdirPath = mkdirPath
const safeMakeTemporaryDirectory = makeTemporaryDirectory
const safeOpenDescriptor = openDescriptor
const safeOpenDirectory = openDirectory
const safeReadDescriptor = readDescriptor
const safeRemoveDirectoryPath = removeDirectoryPath
const safeStatPath = statPath
const safeUnlinkPath = unlinkPath
const safeWriteDescriptor = writeDescriptor
const safePlatform = platform
const safeTmpdir = tmpdir
const safeDir = Dir
const safeDirname = dirname
const safeJoin = join
const safeResolve = resolve
const pathSeparator = sep
const safeDomainToASCII = domainToASCII
const safeFileURLToPath = fileURLToPath
const FILE_TYPE_MASK = constants.S_IFMT
const DIRECTORY_FILE_TYPE = constants.S_IFDIR
const REGULAR_FILE_TYPE = constants.S_IFREG
const SYMBOLIC_LINK_FILE_TYPE = constants.S_IFLNK
const READ_ONLY_SAFE_OPEN_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0)
const WRITE_NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
export const SNAPSHOT_CLEANUP_SETTLE_MS = 250
const SafePromise = Promise
const SafeMap = Map
const safeMapGet = Map.prototype.get
const safeMapHas = Map.prototype.has
const safeMapSet = Map.prototype.set
const safeArrayPop = Array.prototype.pop
const safeArrayPush = Array.prototype.push
const safeArrayJoin = Array.prototype.join
const safeArraySlice = Array.prototype.slice
const safeAbortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const safeAbortSignalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
const safeBufferAllocUnsafe = Buffer.allocUnsafe
const safeBufferConcat = Buffer.concat
const safeBufferFrom = Buffer.from
const safeBufferSubarray = Buffer.prototype.subarray
const safeClearTimeout = globalThis.clearTimeout
const safeMathMin = Math.min
const safeObjectCreate = Object.create
const safeObjectDefineProperty = Object.defineProperty
const safeObjectFreeze = Object.freeze
const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const safeObjectHasOwn = Object.hasOwn
const safeProcessEmitWarning = process.emitWarning
const safePromiseThen = Promise.prototype.then
const safeReflectApply = Reflect.apply
const safeReflectOwnKeys = Reflect.ownKeys
const safeDirClose = safeDir.prototype.close
const safeDirRead = safeDir.prototype.read
const safeRealPath = realPath.native
const safeSetAdd = Set.prototype.add
const safeSetHas = Set.prototype.has
const safeSetTimeout = globalThis.setTimeout
const safeStringEndsWith = String.prototype.endsWith
const safeStringIncludes = String.prototype.includes
const safeStringStartsWith = String.prototype.startsWith
const safeStringSlice = String.prototype.slice
const safeStringSplit = String.prototype.split
const safeStringPadStart = String.prototype.padStart
const safeStringCharCodeAt = String.prototype.charCodeAt
const safeNumberToString = Number.prototype.toString
const safeEncodeURIComponent = globalThis.encodeURIComponent
const safeTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const safeWeakMapGet = WeakMap.prototype.get
const safeWeakMapSet = WeakMap.prototype.set
const SafeSet = Set
const safeSetValues = Set.prototype.values
const safeSetIteratorNext = Object.getPrototypeOf(new SafeSet().values()).next
const safeUrlHref = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get
const timeoutPrototypeProbe = safeSetTimeout(() => {}, 0)
const safeTimeoutUnref = timeoutPrototypeProbe.unref
safeClearTimeout(timeoutPrototypeProbe)
const cleanupUntilRemovedByError = new WeakMap()
const hostPlatform = safePlatform()

const SAFE_PROMISE_CONSTRUCTOR_DESCRIPTOR = safeObjectFreeze({
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false
})
const NATIVE_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR = safeObjectFreeze({
  configurable: false,
  enumerable: false,
  value: SafePromise,
  writable: false
})

function hardenSafePromise (promise) {
  const descriptor = safeReflectApply(
    safeObjectGetOwnPropertyDescriptor,
    undefined,
    [promise, 'constructor']
  )
  if (!descriptor || !safeReflectApply(safeObjectHasOwn, undefined, [descriptor, 'value']) ||
      descriptor.value !== undefined || descriptor.writable !== false ||
      descriptor.enumerable !== false || descriptor.configurable !== false) {
    safeReflectApply(safeObjectDefineProperty, undefined, [
      promise,
      'constructor',
      SAFE_PROMISE_CONSTRUCTOR_DESCRIPTOR
    ])
  }
  return promise
}

function createSafePromise (executor) {
  return hardenSafePromise(new SafePromise(executor))
}

function createValueOutcome (value) {
  const outcome = safeObjectCreate(null)
  safeReflectApply(safeObjectDefineProperty, undefined, [outcome, 'value', {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  }])
  return safeObjectFreeze(outcome)
}

function createRecord (properties) {
  const record = safeObjectCreate(null)
  const keys = safeReflectApply(safeReflectOwnKeys, undefined, [properties])
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    safeReflectApply(safeObjectDefineProperty, undefined, [record, key, {
      configurable: false,
      enumerable: true,
      value: properties[key],
      writable: false
    }])
  }
  return safeObjectFreeze(record)
}

function awaitSafePromise (promise) {
  hardenSafePromise(promise)
  const bridge = new SafePromise((resolve, reject) => {
    safeReflectApply(safePromiseThen, promise, [resolve, reject])
  })
  safeReflectApply(safeObjectDefineProperty, undefined, [
    bridge,
    'constructor',
    NATIVE_AWAIT_PROMISE_CONSTRUCTOR_DESCRIPTOR
  ])
  return bridge
}

function thenSafePromise (promise, onFulfilled, onRejected) {
  hardenSafePromise(promise)
  return hardenSafePromise(
    safeReflectApply(safePromiseThen, promise, [onFulfilled, onRejected])
  )
}

function raceSafePromises (first, second) {
  return createSafePromise((resolve, reject) => {
    thenSafePromise(first, resolve, reject)
    thenSafePromise(second, resolve, reject)
  })
}

function callbackOperation (invoke) {
  return createSafePromise((resolve, reject) => {
    invoke((error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

function callbackValueOperation (invoke) {
  return createSafePromise((resolve, reject) => {
    invoke((error, value) => {
      if (error) reject(error)
      else resolve(createValueOutcome(value))
    })
  })
}

function realpath (path) {
  return callbackOperation(callback => safeRealPath(path, callback))
}

function lstat (path) {
  return callbackValueOperation(callback => safeLstatPath(path, callback))
}

function stat (path) {
  return callbackValueOperation(callback => safeStatPath(path, callback))
}

function link (existingPath, newPath) {
  return callbackOperation(callback => safeLinkPath(existingPath, newPath, callback))
}

function mkdir (path, options) {
  return callbackOperation(callback => safeMkdirPath(path, options, callback))
}

function mkdtemp (prefix) {
  return callbackOperation(callback => safeMakeTemporaryDirectory(prefix, callback))
}

function opendir (path) {
  return callbackValueOperation(callback => safeOpenDirectory(path, callback))
}

function chmod (path, mode) {
  return callbackOperation(callback => safeChmodPath(path, mode, callback))
}

function unlink (path) {
  return callbackOperation(callback => safeUnlinkPath(path, callback))
}

function rmdir (path) {
  return callbackOperation(callback => safeRemoveDirectoryPath(path, callback))
}

function writeFile (path, data, options) {
  return createSafePromise((resolve, reject) => {
    safeOpenDescriptor(path, WRITE_NEW_FILE_FLAGS, options.mode, (openError, descriptor) => {
      if (openError) {
        reject(openError)
        return
      }
      const byteLength = safeReflectApply(safeTypedArrayByteLength, data, [])
      let offset = 0
      const finish = (error) => {
        safeCloseDescriptor(descriptor, (closeError) => {
          if (error || closeError) reject(error ?? closeError)
          else resolve()
        })
      }
      const writeNext = () => {
        if (offset === byteLength) {
          finish()
          return
        }
        safeWriteDescriptor(
          descriptor,
          data,
          offset,
          byteLength - offset,
          null,
          (error, bytesWritten) => {
            if (error) {
              finish(error)
              return
            }
            if (bytesWritten <= 0) {
              finish(new SafeError('A staged file could not be written completely'))
              return
            }
            offset += bytesWritten
            writeNext()
          }
        )
      }
      writeNext()
    })
  })
}

function openFileDescriptor (path, flags) {
  return createSafePromise((resolve, reject) => {
    safeOpenDescriptor(path, flags, (error, descriptor) => {
      if (error) reject(error)
      else resolve(descriptor)
    })
  })
}

function statFileDescriptor (descriptor) {
  return callbackValueOperation(callback => safeStatDescriptor(descriptor, callback))
}

function readFileDescriptor (descriptor, buffer) {
  return createSafePromise((resolve, reject) => {
    const byteLength = safeReflectApply(safeTypedArrayByteLength, buffer, [])
    safeReadDescriptor(descriptor, buffer, 0, byteLength, null, (error, bytesRead) => {
      if (error) reject(error)
      else resolve(bytesRead)
    })
  })
}

function closeFileDescriptor (descriptor) {
  return createSafePromise((resolve, reject) => {
    safeCloseDescriptor(descriptor, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function readDirectory (directory) {
  return callbackValueOperation(callback => {
    safeReflectApply(safeDirRead, directory, [callback])
  })
}

function closeDirectory (directory) {
  return createSafePromise((resolve, reject) => {
    safeReflectApply(safeDirClose, directory, [(error) => {
      if (error) reject(error)
      else resolve()
    }])
  })
}

function ownErrorCode (error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  const descriptor = safeReflectApply(safeObjectGetOwnPropertyDescriptor, undefined, [error, 'code'])
  return descriptor && safeReflectApply(safeObjectHasOwn, undefined, [descriptor, 'value'])
    ? descriptor.value
    : undefined
}

async function removeEntry (path, directory) {
  const operation = directory ? rmdir : unlink
  try {
    await awaitSafePromise(operation(path))
  } catch (error) {
    // Windows rejects removal of read-only files with EPERM. Staged files are
    // deliberately written mode 0400, so make only the package-owned snapshot
    // entry writable and retry through captured callback APIs.
    if (hostPlatform !== 'win32' || ownErrorCode(error) !== 'EPERM') throw error
    await awaitSafePromise(chmod(path, directory ? 0o700 : 0o600))
    await awaitSafePromise(operation(path))
  }
}

async function removeTreeOnce (path) {
  let stats
  try {
    stats = (await awaitSafePromise(lstat(path))).value
  } catch (error) {
    if (ownErrorCode(error) === 'ENOENT') return
    throw error
  }
  if (!isDirectoryMode(stats.mode) || isSymbolicLinkMode(stats.mode)) {
    await removeEntry(path, false)
    return
  }
  const directory = (await awaitSafePromise(opendir(path))).value
  try {
    while (true) {
      const entry = (await awaitSafePromise(readDirectory(directory))).value
      if (entry === null) break
      await awaitSafePromise(removeTreeOnce(safeJoin(path, entry.name)))
    }
  } finally {
    await awaitSafePromise(closeDirectory(directory))
  }
  await removeEntry(path, true)
}

async function rm (path, options) {
  const maximumAttempts = (options?.maxRetries ?? 0) + 1
  let lastError
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    try {
      await awaitSafePromise(removeTreeOnce(path))
      return
    } catch (error) {
      lastError = error
      if (attempt + 1 < maximumAttempts) {
        await awaitSafePromise(createSafePromise(resolve => {
          const timer = safeSetTimeout(resolve, options?.retryDelay ?? 0)
          safeReflectApply(safeTimeoutUnref, timer, [])
        }))
      }
    }
  }
  throw lastError
}

function isFileMode (mode) {
  return (mode & FILE_TYPE_MASK) === REGULAR_FILE_TYPE
}

function isDirectoryMode (mode) {
  return (mode & FILE_TYPE_MASK) === DIRECTORY_FILE_TYPE
}

function isSymbolicLinkMode (mode) {
  return (mode & FILE_TYPE_MASK) === SYMBOLIC_LINK_FILE_TYPE
}

function throwIfAborted (signal) {
  if (signal && safeReflectApply(safeAbortSignalAborted, signal, [])) {
    throw abortError(safeReflectApply(safeAbortSignalReason, signal, []))
  }
}

export function getLocalModuleCleanupUntilRemoved (error) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined
  return safeReflectApply(safeWeakMapGet, cleanupUntilRemovedByError, [error])
}

function modulePathError (message, code) {
  return new UntrustedCodeError(message, { code })
}

function toPath (value, name) {
  if (typeof value === 'string') {
    if (value.length === 0) throw new TypeError(`${name} must not be empty`)
    if (safeReflectApply(safeStringIncludes, value, ['://'])) {
      throw new TypeError(`${name} must be a path string or file URL`)
    }
    return safeResolve(value)
  }
  let isUrl = false
  if (value !== null && typeof value === 'object') {
    try {
      safeReflectApply(safeUrlHref, value, [])
      isUrl = true
    } catch {}
  }
  if (isUrl) {
    try {
      return safeFileURLToPath(value)
    } catch {
      throw new TypeError(`${name} URL must use the file: protocol`)
    }
  }
  throw new TypeError(`${name} must be a path string or file URL`)
}

function encodeFileUrlSegment (segment) {
  const encoded = safeReflectApply(safeEncodeURIComponent, undefined, [segment])
  // Node's pathToFileURL() additionally escapes literal tildes. Matching that
  // canonical spelling keeps loader-generated stack URLs deterministic.
  return safeReflectApply(
    safeArrayJoin,
    safeReflectApply(safeStringSplit, encoded, ['~']),
    ['%7E']
  )
}

function fileUrlHrefForPath (path) {
  const windows = hostPlatform === 'win32'
  let href
  if (!windows) {
    if (!safeReflectApply(safeStringStartsWith, path, ['/']) ||
        safeReflectApply(safeStringIncludes, path, ['\\'])) {
      throw modulePathError(
        'The private module snapshot path cannot be represented as a file URL',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    const segments = safeReflectApply(safeStringSplit, path, ['/'])
    for (let index = 0; index < segments.length; index++) {
      segments[index] = encodeFileUrlSegment(segments[index])
    }
    href = 'file://' + safeReflectApply(safeArrayJoin, segments, ['/'])
  } else if (safeReflectApply(safeStringStartsWith, path, ['\\\\'])) {
    const segments = safeReflectApply(safeStringSplit, path, ['\\'])
    const hostname = safeReflectApply(safeDomainToASCII, undefined, [segments[2]])
    if (hostname.length === 0 || segments.length < 4 || segments[3].length === 0) {
      throw modulePathError(
        'The private module snapshot UNC path cannot be represented as a file URL',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    for (let index = 3; index < segments.length; index++) {
      segments[index] = encodeFileUrlSegment(segments[index])
    }
    href = 'file://' + hostname + '/' +
      safeReflectApply(safeArrayJoin, safeReflectApply(safeArraySlice, segments, [3]), ['/'])
  } else {
    const drive = safeReflectApply(safeStringSlice, path, [0, 2])
    const driveCode = safeReflectApply(safeStringCharCodeAt, drive, [0]) | 0x20
    if (drive.length !== 2 || drive[1] !== ':' || driveCode < 0x61 || driveCode > 0x7a ||
        (path.length > 2 && path[2] !== '\\')) {
      throw modulePathError(
        'The private module snapshot drive path cannot be represented as a file URL',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    const segments = safeReflectApply(
      safeStringSplit,
      safeReflectApply(safeStringSlice, path, [3]),
      ['\\']
    )
    for (let index = 0; index < segments.length; index++) {
      segments[index] = encodeFileUrlSegment(segments[index])
    }
    href = 'file:///' + drive + '/' + safeReflectApply(safeArrayJoin, segments, ['/'])
  }

  const options = { windows }
  if (safeFileURLToPath(href, options) !== path) {
    throw modulePathError(
      'The private module snapshot URL could not be verified',
      'ERR_UNTRUSTED_MODULE_CHANGED'
    )
  }
  return href
}

function relativeWithin (root, candidate) {
  if (candidate === root) return ''
  const prefix = safeReflectApply(safeStringEndsWith, root, [pathSeparator])
    ? root
    : root + pathSeparator
  if (!safeReflectApply(safeStringStartsWith, candidate, [prefix])) return undefined
  return safeReflectApply(safeStringSlice, candidate, [prefix.length])
}

function isWithin (root, candidate) {
  return relativeWithin(root, candidate) !== undefined
}

async function canonicalPath (path, label, signal) {
  throwIfAborted(signal)
  try {
    const canonical = await awaitSafePromise(realpath(path))
    throwIfAborted(signal)
    return canonical
  } catch (error) {
    if (safeIsAbortError(error)) throw error
    throw modulePathError(`${label} could not be resolved`, 'ERR_UNTRUSTED_MODULE_PATH')
  }
}

async function readBoundedFile (descriptor, maxFileBytes, signal) {
  const chunks = []
  let total = 0
  while (true) {
    throwIfAborted(signal)
    const remaining = maxFileBytes - total + 1
    const buffer = safeBufferAllocUnsafe(safeMathMin(READ_CHUNK_BYTES, remaining))
    const bytesRead = await awaitSafePromise(readFileDescriptor(descriptor, buffer))
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxFileBytes) {
      throw modulePathError(
        `A root file exceeds maxFileBytes (${maxFileBytes})`,
        'ERR_UNTRUSTED_MODULE_FILE_LIMIT'
      )
    }
    safeReflectApply(safeArrayPush, chunks, [
      safeReflectApply(safeBufferSubarray, buffer, [0, bytesRead])
    ])
  }
  return createValueOutcome(safeReflectApply(safeBufferConcat, undefined, [chunks, total]))
}

async function copyRegularFile (
  sourcePath,
  destinationPath,
  rootPath,
  limits,
  accounting,
  signal
) {
  let descriptor
  try {
    descriptor = await awaitSafePromise(openFileDescriptor(sourcePath, READ_ONLY_SAFE_OPEN_FLAGS))
    const before = (await awaitSafePromise(statFileDescriptor(descriptor))).value
    if (!isFileMode(before.mode)) {
      throw modulePathError(
        'rootDirectory may contain only regular files and directories',
        'ERR_UNTRUSTED_MODULE_ROOT'
      )
    }
    if (before.size > limits.maxFileBytes) {
      throw modulePathError(
        `A root file exceeds maxFileBytes (${limits.maxFileBytes})`,
        'ERR_UNTRUSTED_MODULE_FILE_LIMIT'
      )
    }

    // Verify the pathname still names the held file and remains in the root.
    // Reading occurs from the handle, so a later pathname replacement cannot
    // redirect this copy to a different file.
    const canonical = await awaitSafePromise(canonicalPath(sourcePath, 'A root file', signal))
    if (!isWithin(rootPath, canonical)) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    const current = (await awaitSafePromise(stat(canonical))).value
    if (before.dev !== current.dev || before.ino !== current.ino) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }

    const data = (await awaitSafePromise(readBoundedFile(descriptor, limits.maxFileBytes, signal))).value
    const after = (await awaitSafePromise(statFileDescriptor(descriptor))).value
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        safeReflectApply(safeTypedArrayByteLength, data, []) !== after.size) {
      throw modulePathError(
        'A root file changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    accounting.totalFileBytes += safeReflectApply(safeTypedArrayByteLength, data, [])
    if (accounting.totalFileBytes > limits.maxTotalFileBytes) {
      throw modulePathError(
        `rootDirectory exceeds maxTotalFileBytes (${limits.maxTotalFileBytes})`,
        'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
      )
    }
    await awaitSafePromise(writeFile(destinationPath, data, { flag: 'wx', mode: 0o400 }))
  } catch (error) {
    if (safeIsUntrustedCodeError(error) || safeIsAbortError(error)) throw error
    throw modulePathError('rootDirectory changed while it was being staged', 'ERR_UNTRUSTED_MODULE_CHANGED')
  } finally {
    if (descriptor !== undefined) {
      try {
        await awaitSafePromise(closeFileDescriptor(descriptor))
      } catch {}
    }
  }
}

async function stageRootTree (rootPath, stagePath, limits, signal) {
  const pending = [{ source: rootPath, destination: stagePath }]
  const accounting = { entries: 0, totalFileBytes: 0, stagedFiles: new SafeSet() }

  while (pending.length > 0) {
    throwIfAborted(signal)
    const directory = safeReflectApply(safeArrayPop, pending, [])
    const canonicalDirectory = await awaitSafePromise(canonicalPath(directory.source, 'A root directory', signal))
    if (!isWithin(rootPath, canonicalDirectory)) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }

    try {
      const directoryHandle = (await awaitSafePromise(opendir(directory.source))).value
      try {
        while (true) {
          const entry = (await awaitSafePromise(readDirectory(directoryHandle))).value
          if (entry === null) break
          throwIfAborted(signal)
          if (++accounting.entries > limits.maxRootEntries) {
            throw modulePathError(
              `rootDirectory exceeds maxRootEntries (${limits.maxRootEntries})`,
              'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
            )
          }
          const sourcePath = safeJoin(directory.source, entry.name)
          const destinationPath = safeJoin(directory.destination, entry.name)
          const entryStats = (await awaitSafePromise(lstat(sourcePath))).value
          if (isSymbolicLinkMode(entryStats.mode)) {
            throw modulePathError(
              'rootDirectory must not contain symbolic links',
              'ERR_UNTRUSTED_MODULE_ROOT'
            )
          }
          if (isDirectoryMode(entryStats.mode)) {
            await awaitSafePromise(mkdir(destinationPath, { mode: 0o700 }))
            safeReflectApply(safeArrayPush, pending, [{
              source: sourcePath,
              destination: destinationPath
            }])
          } else if (isFileMode(entryStats.mode)) {
            await awaitSafePromise(copyRegularFile(
              sourcePath,
              destinationPath,
              rootPath,
              limits,
              accounting,
              signal
            ))
            safeReflectApply(
              safeSetAdd,
              accounting.stagedFiles,
              [relativeWithin(rootPath, sourcePath)]
            )
          } else {
            throw modulePathError(
              'rootDirectory may contain only regular files and directories',
              'ERR_UNTRUSTED_MODULE_ROOT'
            )
          }
        }
      } finally {
        await awaitSafePromise(closeDirectory(directoryHandle))
      }
    } catch (error) {
      if (safeIsUntrustedCodeError(error) || safeIsAbortError(error)) throw error
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
  }
  return createValueOutcome(accounting.stagedFiles)
}

function safeAliasSegment (segment) {
  if (!safeReflectApply(safeStringIncludes, segment, ['\\'])) return segment
  let encoded = ''
  const bytes = safeBufferFrom(segment, 'utf8')
  const byteLength = safeReflectApply(safeTypedArrayByteLength, bytes, [])
  for (let index = 0; index < byteLength; index++) {
    encoded += safeReflectApply(
      safeStringPadStart,
      safeReflectApply(safeNumberToString, bytes[index], [16]),
      [2, '0']
    )
  }
  return '.secure-eval-worker-segment-' + encoded
}

async function createEntryAlias (stagePath, stagedFiles, signal) {
  throwIfAborted(signal)
  const aliasName = '.secure-eval-worker-entry-' + safeRandomUUID()
  const aliasRoot = safeJoin(stagePath, aliasName)
  await awaitSafePromise(mkdir(aliasRoot, { mode: 0o700 }))
  throwIfAborted(signal)
  const destinations = new SafeMap()
  safeReflectApply(safeMapSet, destinations, ['', 'directory\0'])
  const iterator = safeReflectApply(safeSetValues, stagedFiles, [])
  while (true) {
    throwIfAborted(signal)
    const item = safeReflectApply(safeSetIteratorNext, iterator, [])
    if (item.done) break
    const relativePath = item.value
    const segments = safeReflectApply(safeStringSplit, relativePath, [pathSeparator])
    let sourcePath = stagePath
    let destinationPath = aliasRoot
    let sourceRelative = ''
    let destinationRelative = ''
    for (let index = 0; index < segments.length; index++) {
      throwIfAborted(signal)
      const sourceSegment = segments[index]
      const destinationSegment = safeAliasSegment(sourceSegment)
      sourcePath = safeJoin(sourcePath, sourceSegment)
      destinationPath = safeJoin(destinationPath, destinationSegment)
      sourceRelative = sourceRelative === ''
        ? sourceSegment
        : safeJoin(sourceRelative, sourceSegment)
      destinationRelative = destinationRelative === ''
        ? destinationSegment
        : safeJoin(destinationRelative, destinationSegment)
      const last = index === segments.length - 1
      const identity = (last ? 'file\0' : 'directory\0') + sourceRelative
      if (safeReflectApply(safeMapHas, destinations, [destinationRelative])) {
        if (safeReflectApply(safeMapGet, destinations, [destinationRelative]) !== identity) {
          throw modulePathError(
            'A staged entry alias would collide with another root path',
            'ERR_UNTRUSTED_MODULE_CHANGED'
          )
        }
        continue
      }
      safeReflectApply(safeMapSet, destinations, [destinationRelative, identity])
      throwIfAborted(signal)
      if (last) await awaitSafePromise(link(sourcePath, destinationPath))
      else await awaitSafePromise(mkdir(destinationPath, { mode: 0o700 }))
      throwIfAborted(signal)
    }
  }
  return aliasRoot
}

function aliasedRelativePath (relativePath) {
  const segments = safeReflectApply(safeStringSplit, relativePath, [pathSeparator])
  for (let index = 0; index < segments.length; index++) {
    segments[index] = safeAliasSegment(segments[index])
  }
  return safeReflectApply(safeArrayJoin, segments, [pathSeparator])
}

export async function attemptLocalModuleCleanup (
  localModule,
  timeoutMs = SNAPSHOT_CLEANUP_SETTLE_MS
) {
  let timer
  const timeout = createSafePromise((resolve) => {
    timer = safeSetTimeout(() => resolve(createRecord({ status: 'pending' })), timeoutMs)
  })
  const attempt = createSafePromise((resolve, reject) => {
    let cleanup
    try {
      cleanup = localModule.cleanup()
    } catch (error) {
      reject(error)
      return
    }
    thenSafePromise(cleanup, resolve, reject)
  })
  const outcome = thenSafePromise(
    attempt,
    () => createRecord({ status: 'removed' }),
    (error) => createRecord({ status: 'failed', error })
  )
  try {
    return createValueOutcome(await awaitSafePromise(raceSafePromises(outcome, timeout)))
  } finally {
    safeClearTimeout(timer)
  }
}

/**
 * Copy a canonical, bounded module tree into a package-owned staging root.
 * The worker receives access only to this snapshot, never to mutable caller
 * paths validated earlier.
 */
export async function resolveLocalModule (modulePath, rootDirectory, limits, signal) {
  const requestedEntry = toPath(modulePath, 'modulePath')
  const requestedRoot = rootDirectory === undefined
    ? safeDirname(requestedEntry)
    : toPath(rootDirectory, 'rootDirectory')

  const rootPath = await awaitSafePromise(canonicalPath(requestedRoot, 'rootDirectory', signal))
  const entryPath = await awaitSafePromise(canonicalPath(requestedEntry, 'modulePath', signal))
  if (!isWithin(rootPath, entryPath)) {
    throw modulePathError(
      'modulePath must resolve within rootDirectory',
      'ERR_UNTRUSTED_MODULE_OUTSIDE_ROOT'
    )
  }

  let rootStats
  let entryStats
  try {
    rootStats = (await awaitSafePromise(stat(rootPath))).value
    entryStats = (await awaitSafePromise(stat(entryPath))).value
  } catch {
    throw modulePathError('The local module paths could not be inspected', 'ERR_UNTRUSTED_MODULE_PATH')
  }
  if (!isDirectoryMode(rootStats.mode)) {
    throw modulePathError('rootDirectory must be a directory', 'ERR_UNTRUSTED_MODULE_ROOT')
  }
  if (!isFileMode(entryStats.mode)) {
    throw modulePathError('modulePath must be a regular file', 'ERR_UNTRUSTED_MODULE_PATH')
  }

  let stagePath
  let cleaned = false
  let cleanupPromise
  const cleanup = async () => {
    if (cleaned) return
    if (!stagePath) {
      cleaned = true
      return
    }
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      await awaitSafePromise(rm(stagePath, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 20
      }))
      cleaned = true
    })()
    try {
      await awaitSafePromise(cleanupPromise)
    } finally {
      cleanupPromise = undefined
    }
  }
  const cleanupUntilRemoved = async () => {
    let warned = false
    let retryDelayMs = 1_000
    while (!cleaned) {
      try {
        await awaitSafePromise(cleanup())
      } catch {
        if (!warned) {
          warned = true
          try {
            safeReflectApply(safeProcessEmitWarning, process, [
              'A private module snapshot could not be removed',
              { code: 'ERR_UNTRUSTED_MODULE_CLEANUP' }
            ])
          } catch {}
        }
        await awaitSafePromise(createSafePromise((resolve) => {
          const timer = safeSetTimeout(resolve, retryDelayMs)
          safeReflectApply(safeTimeoutUnref, timer, [])
        }))
        retryDelayMs = safeMathMin(retryDelayMs * 2, 60_000)
      }
    }
  }

  try {
    stagePath = await awaitSafePromise(mkdtemp(safeJoin(safeTmpdir(), 'secure-eval-worker-modules-')))
    // macOS exposes /var and /tmp through /private. Node's module loader uses
    // the canonical spelling while its Permission Model compares the granted
    // path literally, so normalize these standard local aliases without an
    // extra filesystem read permission.
    if (hostPlatform === 'darwin' &&
        (stagePath === '/var' || stagePath === '/tmp' ||
         safeReflectApply(safeStringStartsWith, stagePath, ['/var/']) ||
         safeReflectApply(safeStringStartsWith, stagePath, ['/tmp/']))) {
      stagePath = '/private' + stagePath
    }
    if (safeReflectApply(safeStringIncludes, stagePath, ['*'])) {
      throw modulePathError(
        'The staging path contains wildcard characters',
        'ERR_UNTRUSTED_MODULE_ROOT'
      )
    }
    const stagedFiles = (await awaitSafePromise(stageRootTree(rootPath, stagePath, limits, signal))).value
    throwIfAborted(signal)

    const entryRelativePath = relativeWithin(rootPath, entryPath)
    if (!safeReflectApply(safeSetHas, stagedFiles, [entryRelativePath])) {
      throw modulePathError(
        'modulePath changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    let stagedEntryPath = safeJoin(stagePath, entryRelativePath)
    const locationReplacements = []
    // A POSIX backslash is a legal path byte but ESM file URLs reject its
    // percent-encoded form. Clone the immutable snapshot as hard links under a
    // package-owned alias root and deterministically encode only backslash
    // segments. This preserves relative imports and never grants authority
    // beyond the already staged tree.
    if (hostPlatform !== 'win32' &&
        safeReflectApply(safeStringIncludes, entryRelativePath, ['\\'])) {
      const aliasRoot = await awaitSafePromise(createEntryAlias(stagePath, stagedFiles, signal))
      const aliasPathPrefix = aliasRoot + pathSeparator
      stagedEntryPath = safeJoin(aliasRoot, aliasedRelativePath(entryRelativePath))
      safeReflectApply(safeArrayPush, locationReplacements, [safeObjectFreeze([
        fileUrlHrefForPath(aliasPathPrefix),
        'secure-eval-worker-files/'
      ])])
      safeReflectApply(safeArrayPush, locationReplacements, [safeObjectFreeze([
        aliasPathPrefix,
        'secure-eval-worker-files/'
      ])])
    }

    const rootPathPrefix = safeReflectApply(safeStringEndsWith, stagePath, [pathSeparator])
      ? stagePath
      : stagePath + pathSeparator
    return createValueOutcome(createRecord({
      entryUrl: fileUrlHrefForPath(stagedEntryPath),
      rootPath: stagePath,
      rootPathPrefix,
      rootUrlPrefix: fileUrlHrefForPath(rootPathPrefix),
      locationReplacements: safeObjectFreeze(locationReplacements),
      cleanup,
      cleanupUntilRemoved
    }))
  } catch (error) {
    try {
      await awaitSafePromise(cleanup())
    } catch {
      const error = modulePathError(
        'The private module snapshot could not be removed',
        'ERR_UNTRUSTED_MODULE_CLEANUP'
      )
      safeReflectApply(safeWeakMapSet, cleanupUntilRemovedByError, [
        error,
        cleanupUntilRemoved
      ])
      throw error
    }
    throw error
  }
}
