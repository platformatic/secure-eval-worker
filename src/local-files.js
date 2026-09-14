import {
  close as closeDescriptor,
  constants,
  Dir,
  fstat as statDescriptor,
  open as openDescriptor,
  read as readDescriptor
} from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { abortError, UntrustedCodeError } from './internal.js'

const TypeError = globalThis.TypeError
const READ_CHUNK_BYTES = 64 * 1024
const FILE_TYPE_MASK = constants.S_IFMT
const DIRECTORY_FILE_TYPE = constants.S_IFDIR
const REGULAR_FILE_TYPE = constants.S_IFREG
const SYMBOLIC_LINK_FILE_TYPE = constants.S_IFLNK
const READ_ONLY_SAFE_OPEN_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0)
export const SNAPSHOT_CLEANUP_SETTLE_MS = 250
const SafePromise = Promise
const safeArrayPop = Array.prototype.pop
const safeArrayPush = Array.prototype.push
const safeAbortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const safeAbortSignalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
const safeBufferAllocUnsafe = Buffer.allocUnsafe
const safeBufferConcat = Buffer.concat
const safeBufferSubarray = Buffer.prototype.subarray
const safeClearTimeout = globalThis.clearTimeout
const safeMathMin = Math.min
const safeObjectFreeze = Object.freeze
const safeProcessEmitWarning = process.emitWarning
const safePromiseThen = Promise.prototype.then
const safeReflectApply = Reflect.apply
const safeCloseDescriptor = closeDescriptor
const safeDirClose = Dir.prototype.close
const safeDirRead = Dir.prototype.read
const safeOpenDescriptor = openDescriptor
const safeReadDescriptor = readDescriptor
const safeStatDescriptor = statDescriptor
const safeSetAdd = Set.prototype.add
const safeSetHas = Set.prototype.has
const safeSetTimeout = globalThis.setTimeout
const safeStringEndsWith = String.prototype.endsWith
const safeStringIncludes = String.prototype.includes
const safeStringStartsWith = String.prototype.startsWith
const safeTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const safeWeakMapGet = WeakMap.prototype.get
const safeWeakMapSet = WeakMap.prototype.set
const timeoutPrototypeProbe = safeSetTimeout(() => {}, 0)
const safeTimeoutUnref = timeoutPrototypeProbe.unref
safeClearTimeout(timeoutPrototypeProbe)
const cleanupUntilRemovedByError = new WeakMap()
const hostPlatform = platform()

function thenSafePromise (promise, onFulfilled, onRejected) {
  return safeReflectApply(safePromiseThen, promise, [onFulfilled, onRejected])
}

function raceSafePromises (first, second) {
  return new SafePromise((resolve, reject) => {
    thenSafePromise(first, resolve, reject)
    thenSafePromise(second, resolve, reject)
  })
}

function openFileDescriptor (path, flags) {
  return new SafePromise((resolve, reject) => {
    safeOpenDescriptor(path, flags, (error, descriptor) => {
      if (error) reject(error)
      else resolve(descriptor)
    })
  })
}

function statFileDescriptor (descriptor) {
  return new SafePromise((resolve, reject) => {
    safeStatDescriptor(descriptor, (error, stats) => {
      if (error) reject(error)
      else resolve(stats)
    })
  })
}

function readFileDescriptor (descriptor, buffer) {
  return new SafePromise((resolve, reject) => {
    const byteLength = safeReflectApply(safeTypedArrayByteLength, buffer, [])
    safeReadDescriptor(descriptor, buffer, 0, byteLength, null, (error, bytesRead) => {
      if (error) reject(error)
      else resolve(bytesRead)
    })
  })
}

function closeFileDescriptor (descriptor) {
  return new SafePromise((resolve, reject) => {
    safeCloseDescriptor(descriptor, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function readDirectory (directory) {
  return new SafePromise((resolve, reject) => {
    safeReflectApply(safeDirRead, directory, [(error, entry) => {
      if (error) reject(error)
      else resolve(entry)
    }])
  })
}

function closeDirectory (directory) {
  return new SafePromise((resolve, reject) => {
    safeReflectApply(safeDirClose, directory, [(error) => {
      if (error) reject(error)
      else resolve()
    }])
  })
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
    return resolve(value)
  }
  if (value instanceof URL) {
    try {
      return fileURLToPath(value)
    } catch {
      throw new TypeError(`${name} URL must use the file: protocol`)
    }
  }
  throw new TypeError(`${name} must be a path string or file URL`)
}

function isWithin (root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
     !safeReflectApply(safeStringStartsWith, pathFromRoot, [`..${sep}`]) &&
     !isAbsolute(pathFromRoot))
}

async function canonicalPath (path, label, signal) {
  throwIfAborted(signal)
  try {
    const canonical = await realpath(path)
    throwIfAborted(signal)
    return canonical
  } catch (error) {
    if (error?.name === 'AbortError') throw error
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
    const bytesRead = await readFileDescriptor(descriptor, buffer)
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
  return safeReflectApply(safeBufferConcat, Buffer, [chunks, total])
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
    descriptor = await openFileDescriptor(sourcePath, READ_ONLY_SAFE_OPEN_FLAGS)
    const before = await statFileDescriptor(descriptor)
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
    const canonical = await canonicalPath(sourcePath, 'A root file', signal)
    if (!isWithin(rootPath, canonical)) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    const current = await stat(canonical)
    if (before.dev !== current.dev || before.ino !== current.ino) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }

    const data = await readBoundedFile(descriptor, limits.maxFileBytes, signal)
    const after = await statFileDescriptor(descriptor)
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
    await writeFile(destinationPath, data, { flag: 'wx', mode: 0o400 })
  } catch (error) {
    if (error instanceof UntrustedCodeError || error?.name === 'AbortError') throw error
    throw modulePathError('rootDirectory changed while it was being staged', 'ERR_UNTRUSTED_MODULE_CHANGED')
  } finally {
    if (descriptor !== undefined) {
      try {
        await closeFileDescriptor(descriptor)
      } catch {}
    }
  }
}

async function stageRootTree (rootPath, stagePath, limits, signal) {
  const pending = [{ source: rootPath, destination: stagePath }]
  const accounting = { entries: 0, totalFileBytes: 0, stagedFiles: new Set() }

  while (pending.length > 0) {
    throwIfAborted(signal)
    const directory = safeReflectApply(safeArrayPop, pending, [])
    const canonicalDirectory = await canonicalPath(directory.source, 'A root directory', signal)
    if (!isWithin(rootPath, canonicalDirectory)) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }

    try {
      const directoryHandle = await opendir(directory.source)
      try {
        while (true) {
          const entry = await readDirectory(directoryHandle)
          if (entry === null) break
          throwIfAborted(signal)
          if (++accounting.entries > limits.maxRootEntries) {
            throw modulePathError(
              `rootDirectory exceeds maxRootEntries (${limits.maxRootEntries})`,
              'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
            )
          }
          const sourcePath = join(directory.source, entry.name)
          const destinationPath = join(directory.destination, entry.name)
          const entryStats = await lstat(sourcePath)
          if (isSymbolicLinkMode(entryStats.mode)) {
            throw modulePathError(
              'rootDirectory must not contain symbolic links',
              'ERR_UNTRUSTED_MODULE_ROOT'
            )
          }
          if (isDirectoryMode(entryStats.mode)) {
            await mkdir(destinationPath, { mode: 0o700 })
            safeReflectApply(safeArrayPush, pending, [{
              source: sourcePath,
              destination: destinationPath
            }])
          } else if (isFileMode(entryStats.mode)) {
            await copyRegularFile(
              sourcePath,
              destinationPath,
              rootPath,
              limits,
              accounting,
              signal
            )
            safeReflectApply(
              safeSetAdd,
              accounting.stagedFiles,
              [relative(rootPath, sourcePath)]
            )
          } else {
            throw modulePathError(
              'rootDirectory may contain only regular files and directories',
              'ERR_UNTRUSTED_MODULE_ROOT'
            )
          }
        }
      } finally {
        await closeDirectory(directoryHandle)
      }
    } catch (error) {
      if (error instanceof UntrustedCodeError || error?.name === 'AbortError') throw error
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
  }
  return accounting.stagedFiles
}

export async function attemptLocalModuleCleanup (
  localModule,
  timeoutMs = SNAPSHOT_CLEANUP_SETTLE_MS
) {
  let timer
  const timeout = new SafePromise((resolve) => {
    timer = safeSetTimeout(() => resolve(safeObjectFreeze({ status: 'pending' })), timeoutMs)
  })
  const attempt = new SafePromise((resolve, reject) => {
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
    () => safeObjectFreeze({ status: 'removed' }),
    (error) => safeObjectFreeze({ status: 'failed', error })
  )
  try {
    return await raceSafePromises(outcome, timeout)
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
    ? dirname(requestedEntry)
    : toPath(rootDirectory, 'rootDirectory')

  const rootPath = await canonicalPath(requestedRoot, 'rootDirectory', signal)
  const entryPath = await canonicalPath(requestedEntry, 'modulePath', signal)
  if (!isWithin(rootPath, entryPath)) {
    throw modulePathError(
      'modulePath must resolve within rootDirectory',
      'ERR_UNTRUSTED_MODULE_OUTSIDE_ROOT'
    )
  }

  let rootStats
  let entryStats
  try {
    rootStats = await stat(rootPath)
    entryStats = await stat(entryPath)
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
      await rm(stagePath, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 20
      })
      cleaned = true
    })()
    try {
      await cleanupPromise
    } finally {
      cleanupPromise = undefined
    }
  }
  const cleanupUntilRemoved = async () => {
    let warned = false
    let retryDelayMs = 1_000
    while (!cleaned) {
      try {
        await cleanup()
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
        await new SafePromise((resolve) => {
          const timer = safeSetTimeout(resolve, retryDelayMs)
          safeReflectApply(safeTimeoutUnref, timer, [])
        })
        retryDelayMs = safeMathMin(retryDelayMs * 2, 60_000)
      }
    }
  }

  try {
    stagePath = await mkdtemp(join(tmpdir(), 'secure-eval-worker-modules-'))
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
    const stagedFiles = await stageRootTree(rootPath, stagePath, limits, signal)
    throwIfAborted(signal)

    const entryRelativePath = relative(rootPath, entryPath)
    if (!safeReflectApply(safeSetHas, stagedFiles, [entryRelativePath])) {
      throw modulePathError(
        'modulePath changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    const stagedEntryPath = join(stagePath, entryRelativePath)

    const rootPathPrefix = safeReflectApply(safeStringEndsWith, stagePath, [sep])
      ? stagePath
      : stagePath + sep
    return safeObjectFreeze({
      entryUrl: pathToFileURL(stagedEntryPath).href,
      rootPath: stagePath,
      rootPathPrefix,
      rootUrlPrefix: pathToFileURL(rootPathPrefix).href,
      cleanup,
      cleanupUntilRemoved
    })
  } catch (error) {
    try {
      await cleanup()
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
