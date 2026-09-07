import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getWorkerAdmissionStatus } from './admission.js'
import { abortError, UntrustedCodeError } from './internal.js'

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

async function assertSafeRootTree (
  rootPath,
  { maxRootEntries, maxFileBytes, maxTotalFileBytes },
  signal
) {
  const pending = [rootPath]
  let entries = 0
  let totalFileBytes = 0
  try {
    while (pending.length > 0) {
      if (signal?.aborted) throw abortError(signal.reason)
      const directory = pending.pop()
      for await (const entry of await opendir(directory)) {
        if (signal?.aborted) throw abortError(signal.reason)
        if (++entries > maxRootEntries) {
          throw modulePathError(
            `rootDirectory exceeds maxRootEntries (${maxRootEntries})`,
            'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
          )
        }
        const entryPath = resolve(directory, entry.name)
        const entryStats = await lstat(entryPath)
        if (entryStats.isSymbolicLink()) {
          throw modulePathError(
            'rootDirectory must not contain symbolic links',
            'ERR_UNTRUSTED_MODULE_ROOT'
          )
        }
        if (entryStats.isDirectory()) {
          pending.push(entryPath)
        } else if (entryStats.isFile()) {
          if (entryStats.size > maxFileBytes) {
            throw modulePathError(
              `A root file exceeds maxFileBytes (${maxFileBytes})`,
              'ERR_UNTRUSTED_MODULE_FILE_LIMIT'
            )
          }
          totalFileBytes += entryStats.size
          if (totalFileBytes > maxTotalFileBytes) {
            throw modulePathError(
              `rootDirectory exceeds maxTotalFileBytes (${maxTotalFileBytes})`,
              'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
            )
          }
        } else {
          throw modulePathError(
            'rootDirectory may contain only regular files and directories',
            'ERR_UNTRUSTED_MODULE_ROOT'
          )
        }
      }
    }
  } catch (error) {
    if (error instanceof UntrustedCodeError || error?.name === 'AbortError') throw error
    throw modulePathError('rootDirectory could not be inspected', 'ERR_UNTRUSTED_MODULE_ROOT')
  }
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

/**
 * Resolve a module entry and its explicitly trusted loader root on the host.
 * The returned paths are canonical and safe to place in Worker execArgv.
 */
export async function resolveLocalModule (
  modulePath,
  rootDirectory,
  limits,
  signal
) {
  // Fail before touching the filesystem when sandbox creation is unavailable.
  getWorkerAdmissionStatus()

  const requestedEntry = toPath(modulePath, 'modulePath')
  const requestedRoot = rootDirectory === undefined
    ? dirname(requestedEntry)
    : toPath(rootDirectory, 'rootDirectory')

  const rootPath = await canonicalPath(requestedRoot, 'rootDirectory', signal)
  if (rootPath.includes('*')) {
    throw modulePathError(
      'rootDirectory must not contain wildcard characters',
      'ERR_UNTRUSTED_MODULE_ROOT'
    )
  }

  let rootStats
  try {
    rootStats = await stat(rootPath)
  } catch {
    throw modulePathError('rootDirectory could not be inspected', 'ERR_UNTRUSTED_MODULE_ROOT')
  }
  if (!rootStats.isDirectory()) {
    throw modulePathError('rootDirectory must be a directory', 'ERR_UNTRUSTED_MODULE_ROOT')
  }
  await assertSafeRootTree(rootPath, limits, signal)

  const entryPath = await canonicalPath(requestedEntry, 'modulePath', signal)
  if (!isWithin(rootPath, entryPath)) {
    throw modulePathError(
      'modulePath must resolve within rootDirectory',
      'ERR_UNTRUSTED_MODULE_OUTSIDE_ROOT'
    )
  }

  let entryStats
  try {
    entryStats = await stat(entryPath)
  } catch {
    throw modulePathError('modulePath could not be inspected', 'ERR_UNTRUSTED_MODULE_PATH')
  }
  if (!entryStats.isFile()) {
    throw modulePathError('modulePath must be a regular file', 'ERR_UNTRUSTED_MODULE_PATH')
  }
  if (signal?.aborted) throw abortError(signal.reason)

  const rootPathPrefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep
  return Object.freeze({
    entryUrl: pathToFileURL(entryPath).href,
    rootPath,
    rootPathPrefix,
    rootUrlPrefix: pathToFileURL(rootPathPrefix).href
  })
}
