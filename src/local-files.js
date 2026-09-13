import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { abortError, UntrustedCodeError } from './internal.js'

const READ_CHUNK_BYTES = 64 * 1024
export const SNAPSHOT_CLEANUP_SETTLE_MS = 250
const SafePromise = Promise
const safeAbortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const safeAbortSignalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
const safeClearTimeout = globalThis.clearTimeout
const safeMathMin = Math.min
const safeObjectFreeze = Object.freeze
const safeProcessEmitWarning = process.emitWarning
const safePromiseAll = Promise.all
const safePromiseRace = Promise.race
const safePromiseResolve = Promise.resolve
const safePromiseThen = Promise.prototype.then
const safeReflectApply = Reflect.apply
const safeSetTimeout = globalThis.setTimeout
const safeWeakMapGet = WeakMap.prototype.get
const safeWeakMapSet = WeakMap.prototype.set
const timeoutPrototypeProbe = safeSetTimeout(() => {}, 0)
const safeTimeoutUnref = timeoutPrototypeProbe.unref
safeClearTimeout(timeoutPrototypeProbe)
const cleanupUntilRemovedByError = new WeakMap()

function thenSafePromise (promise, onFulfilled, onRejected) {
  return safeReflectApply(safePromiseThen, promise, [onFulfilled, onRejected])
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
    if (value.includes('://')) {
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
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
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

async function readBoundedFile (handle, maxFileBytes, signal) {
  const chunks = []
  let total = 0
  while (true) {
    throwIfAborted(signal)
    const remaining = maxFileBytes - total + 1
    const buffer = Buffer.allocUnsafe(safeMathMin(READ_CHUNK_BYTES, remaining))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxFileBytes) {
      throw modulePathError(
        `A root file exceeds maxFileBytes (${maxFileBytes})`,
        'ERR_UNTRUSTED_MODULE_FILE_LIMIT'
      )
    }
    chunks.push(buffer.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, total)
}

async function copyRegularFile (
  sourcePath,
  destinationPath,
  rootPath,
  limits,
  accounting,
  signal
) {
  let handle
  try {
    handle = await open(
      sourcePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    )
    const before = await handle.stat()
    if (!before.isFile()) {
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

    const data = await readBoundedFile(handle, limits.maxFileBytes, signal)
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || data.byteLength !== after.size) {
      throw modulePathError(
        'A root file changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    accounting.totalFileBytes += data.byteLength
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
    if (handle) {
      try {
        await handle.close()
      } catch {}
    }
  }
}

async function stageRootTree (rootPath, stagePath, limits, signal) {
  const pending = [{ source: rootPath, destination: stagePath }]
  const accounting = { entries: 0, totalFileBytes: 0, stagedFiles: new Set() }

  while (pending.length > 0) {
    throwIfAborted(signal)
    const directory = pending.pop()
    const canonicalDirectory = await canonicalPath(directory.source, 'A root directory', signal)
    if (!isWithin(rootPath, canonicalDirectory)) {
      throw modulePathError(
        'rootDirectory changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }

    try {
      for await (const entry of await opendir(directory.source)) {
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
        if (entryStats.isSymbolicLink()) {
          throw modulePathError(
            'rootDirectory must not contain symbolic links',
            'ERR_UNTRUSTED_MODULE_ROOT'
          )
        }
        if (entryStats.isDirectory()) {
          await mkdir(destinationPath, { mode: 0o700 })
          pending.push({ source: sourcePath, destination: destinationPath })
        } else if (entryStats.isFile()) {
          await copyRegularFile(
            sourcePath,
            destinationPath,
            rootPath,
            limits,
            accounting,
            signal
          )
          accounting.stagedFiles.add(relative(rootPath, sourcePath))
        } else {
          throw modulePathError(
            'rootDirectory may contain only regular files and directories',
            'ERR_UNTRUSTED_MODULE_ROOT'
          )
        }
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
  const resolved = safeReflectApply(safePromiseResolve, SafePromise, [])
  const attempt = thenSafePromise(resolved, () => localModule.cleanup())
  const outcome = thenSafePromise(
    attempt,
    () => safeObjectFreeze({ status: 'removed' }),
    (error) => safeObjectFreeze({ status: 'failed', error })
  )
  try {
    return await safeReflectApply(safePromiseRace, SafePromise, [[outcome, timeout]])
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
    ;[rootStats, entryStats] = await safeReflectApply(safePromiseAll, SafePromise, [
      [stat(rootPath), stat(entryPath)]
    ])
  } catch {
    throw modulePathError('The local module paths could not be inspected', 'ERR_UNTRUSTED_MODULE_PATH')
  }
  if (!rootStats.isDirectory()) {
    throw modulePathError('rootDirectory must be a directory', 'ERR_UNTRUSTED_MODULE_ROOT')
  }
  if (!entryStats.isFile()) {
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
    if (stagePath.includes('*')) {
      throw modulePathError(
        'The staging path contains wildcard characters',
        'ERR_UNTRUSTED_MODULE_ROOT'
      )
    }
    const stagedFiles = await stageRootTree(rootPath, stagePath, limits, signal)
    throwIfAborted(signal)

    const entryRelativePath = relative(rootPath, entryPath)
    if (!stagedFiles.has(entryRelativePath)) {
      throw modulePathError(
        'modulePath changed while it was being staged',
        'ERR_UNTRUSTED_MODULE_CHANGED'
      )
    }
    const stagedEntryPath = join(stagePath, entryRelativePath)

    const rootPathPrefix = stagePath.endsWith(sep) ? stagePath : stagePath + sep
    return Object.freeze({
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
