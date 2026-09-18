import { builtinModules } from 'node:module'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { NODE_BUILTIN_POLICY } from '../src/node-capability-policy.js'

// This tool deliberately generates review input; it never rewrites the
// approved manifest. It runs a temporary source copy whose three manifest
// comparisons are disabled while retaining the production hardening order.
const root = mkdtempSync(join(tmpdir(), 'secure-eval-worker-capability-candidate-'))
const sourceRoot = new URL('../src/', import.meta.url)
const copiedSource = join(root, 'src')
const ids = [
  ...NODE_BUILTIN_POLICY.allowed,
  ...NODE_BUILTIN_POLICY.attenuated,
  ...NODE_BUILTIN_POLICY.modeDependent
].sort()

try {
  cpSync(sourceRoot, copiedSource, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  const bootstrapPath = join(copiedSource, 'session-bootstrap.js')
  let bootstrapSource = readFileSync(bootstrapPath, 'utf8').replace(/\r\n?/g, '\n')
  bootstrapSource = replaceExactly(
    bootstrapSource,
    '  await verifyNodeCapabilityPolicy()\n',
    `  // Candidate generation: preload reviewed built-ins but intentionally skip comparisons.\n` +
    `  for (const candidateId of preparedNodeCapabilityPolicy.surfacedIds) {\n` +
    `    const candidateSpecifier = candidateId.startsWith('node:')\n` +
    `      ? candidateId\n` +
    `      : 'node:' + candidateId\n` +
    `    reflectApply(moduleLoad, moduleBuiltin, [candidateSpecifier])\n` +
    `  }\n`
  )
  bootstrapSource = replaceExactly(
    bootstrapSource,
    '  await verifyNodeCapabilityNamespaces()\n  verifyNodeCapabilityGraphs()\n',
    '  // Candidate generation: post-hardening namespace/graph verification is intentionally skipped.\n'
  )
  writeFileSync(bootstrapPath, bootstrapSource)

  const commonjs = await inspectPreHardeningCommonJs(ids)
  const entry = join(root, 'entry.mjs')
  writeFileSync(entry, candidateGuestSource(ids))
  const { runUntrustedFile } = await import(
    pathToFileURL(join(copiedSource, 'index.js')).href
  )
  const postHardening = await runUntrustedFile(entry, {
    rootDirectory: root,
    timeoutMs: 60_000,
    maxMessageBytes: 32 * 1024 * 1024,
    maxOutputBytes: 64 * 1024 * 1024
  })

  process.stdout.write(JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinModules: [...builtinModules].sort(),
    commonjs,
    esm: postHardening.esm,
    graph: postHardening.graph
  }, null, 2) + '\n')
} finally {
  rmSync(root, { force: true, recursive: true })
}

function replaceExactly (source, oldText, newText) {
  const first = source.indexOf(oldText)
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`candidate source marker must occur exactly once: ${JSON.stringify(oldText)}`)
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length)
}

function inspectPreHardeningCommonJs (moduleIds) {
  const workerSource = String.raw`
    'use strict'
    const codes = {
      bigint: 'i', boolean: 'b', function: 'f', number: 'n', object: 'o',
      string: 's', symbol: 'y', undefined: 'u'
    }
    const signature = (value, omitNumericConstants) => {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const result = []
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key]
        if (omitNumericConstants && Object.hasOwn(descriptor, 'value') &&
            typeof descriptor.value === 'number') continue
        const name = typeof key === 'symbol'
          ? '@@' + (Symbol.keyFor(key) ?? key.description ?? '')
          : key
        const kind = Object.hasOwn(descriptor, 'value')
          ? (descriptor.value === null ? 'l' : codes[typeof descriptor.value])
          : 'a'
        result.push(name + ':' + kind)
      }
      return result.sort()
    }
    for (const id of [
      'node:crypto', 'node:async_hooks', 'node:child_process', 'node:events',
      'node:fs', 'node:fs/promises', 'node:dgram', 'node:dns',
      'node:dns/promises', 'node:http', 'node:http2', 'node:https',
      'node:module', 'node:net', 'node:os', 'node:perf_hooks', 'node:process',
      'node:sea', 'node:sqlite', 'node:tls', 'node:tty', 'node:v8',
      'node:wasi', 'node:zlib', 'node:util/types', 'node:worker_threads',
      'node:ffi', 'node:trace_events', 'node:quic'
    ]) {
      try { require(id) } catch {}
    }
    for (const id of [
      '_http_agent', '_http_client', '_http_common', '_http_incoming',
      '_http_outgoing', '_http_server', '_tls_common', '_tls_wrap'
    ]) require(id)

    const { parentPort, workerData } = require('node:worker_threads')
    const result = {}
    for (const id of workerData) {
      const specifier = id.startsWith('node:') ? id : 'node:' + id
      result[id] = signature(require(specifier), id === 'constants')
    }
    parentPort.postMessage(result)
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      env: {},
      eval: true,
      execArgv: [
        '--permission',
        '--allow-worker',
        '--disable-warning=PERM0006',
        '--disable-warning=DEP0192',
        '--disable-warning=ExperimentalWarning'
      ],
      stderr: true,
      stdin: false,
      stdout: false,
      workerData: moduleIds
    })
    worker.once('message', resolve)
    worker.once('error', reject)
  })
}

function candidateGuestSource (moduleIds) {
  return `
export default async () => {
const ids = ${JSON.stringify(moduleIds)}
const codes = {
  bigint: 'i', boolean: 'b', function: 'f', number: 'n', object: 'o',
  string: 's', symbol: 'y', undefined: 'u'
}
const keyName = key => typeof key === 'symbol'
  ? '@@' + (Symbol.keyFor(key) ?? key.description ?? '')
  : key
const signature = (value, omitNumericConstants = false) => {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result = []
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (omitNumericConstants && Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'number') continue
    const kind = Object.hasOwn(descriptor, 'value')
      ? (descriptor.value === null ? 'l' : codes[typeof descriptor.value])
      : 'a'
    result.push(keyName(key) + ':' + kind)
  }
  return result.sort()
}
const stops = new Set([
  Object.prototype, Function.prototype, Array.prototype, Map.prototype,
  Set.prototype, WeakMap.prototype, WeakSet.prototype, Promise.prototype,
  Date.prototype, RegExp.prototype, Error.prototype, ArrayBuffer.prototype,
  DataView.prototype, Int8Array.prototype, Uint8Array.prototype,
  Uint8ClampedArray.prototype, Int16Array.prototype, Uint16Array.prototype,
  Int32Array.prototype, Uint32Array.prototype, Float32Array.prototype,
  Float64Array.prototype, BigInt64Array.prototype, BigUint64Array.prototype
])
const excludedObject = value => Array.isArray(value) || ArrayBuffer.isView(value) ||
  value instanceof Map || value instanceof Set || value instanceof WeakMap ||
  value instanceof WeakSet || value instanceof Date || value instanceof RegExp ||
  value instanceof ArrayBuffer || value instanceof SharedArrayBuffer
const inspectObject = (value, path, graph) => {
  if (path === 'process.env' || value === null || typeof value !== 'object' ||
      excludedObject(value)) return
  graph[path] = signature(value, path.endsWith('.constants'))
  let prototype = Object.getPrototypeOf(value)
  for (let level = 0; prototype && !stops.has(prototype) && level < 12; level++) {
    graph[path + '[[Prototype]]' + level] = signature(prototype)
    prototype = Object.getPrototypeOf(prototype)
  }
}
const inspectFunction = (value, path, graph) => {
  if (typeof value !== 'function') return
  graph[path + '[[Function]]'] = signature(value)
  const descriptor = Object.getOwnPropertyDescriptor(value, 'prototype')
  if (descriptor && Object.hasOwn(descriptor, 'value')) {
    inspectObject(descriptor.value, path + '.prototype', graph)
  }
}
const esm = {}
const graph = {}
for (const id of ids) {
  const specifier = id.startsWith('node:') ? id : 'node:' + id
  const namespace = await import(specifier)
  esm[id] = signature(namespace, id === 'constants')
  const rootValue = namespace.default ?? namespace
  const moduleGraph = {}
  const descriptors = Object.getOwnPropertyDescriptors(rootValue)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || descriptor.value === null) continue
    const path = id + '.' + keyName(key)
    if (typeof descriptor.value === 'object') {
      inspectObject(descriptor.value, path, moduleGraph)
    } else if (typeof descriptor.value === 'function') {
      inspectFunction(descriptor.value, path, moduleGraph)
    }
  }
  graph[id] = moduleGraph
}
return { esm, graph }
}
`
}
