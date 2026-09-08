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
  if (signal?.aborted) throw abortError(signal.reason)
  try {
    const canonical = await realpath(path)
    if (signal?.aborted) throw abortError(signal.reason)
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
    if (signal?.aborted) throw abortError(signal.reason)
    const remaining = maxFileBytes - total + 1
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining))
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
    handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
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
    await handle?.close().catch(() => {})
  }
}

async function stageRootTree (rootPath, stagePath, limits, signal) {
  const pending = [{ source: rootPath, destination: stagePath }]
  const accounting = { entries: 0, totalFileBytes: 0, stagedFiles: new Set() }

  while (pending.length > 0) {
    if (signal?.aborted) throw abortError(signal.reason)
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
        if (signal?.aborted) throw abortError(signal.reason)
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
    ;[rootStats, entryStats] = await Promise.all([stat(rootPath), stat(entryPath)])
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
    while (!cleaned) {
      try {
        await cleanup()
      } catch {
        if (!warned) {
          warned = true
          process.emitWarning('A private module snapshot could not be removed', {
            code: 'ERR_UNTRUSTED_MODULE_CLEANUP'
          })
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000)
          timer.unref()
        })
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
    if (signal?.aborted) throw abortError(signal.reason)

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
      Object.defineProperty(error, 'cleanupUntilRemoved', {
        value: cleanupUntilRemoved
      })
      throw error
    }
    throw error
  }
}
