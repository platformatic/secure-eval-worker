import assert from 'node:assert/strict'
import { builtinModules } from 'node:module'
import { Worker } from 'node:worker_threads'

import { runUntrustedCode } from '../src/index.js'
import {
  diffExactLists,
  diffSurfaceSignatures
} from './node-capability-signatures.js'
import {
  NODE_BUILTIN_POLICY,
  NODE_BUILTIN_PROFILES
} from '../src/node-capability-policy.js'
import {
  NODE_BUILTIN_SURFACE_BASE,
  NODE_BUILTIN_SURFACE_FROM_26_8,
  NODE_BUILTIN_SURFACE_FROM_26_9,
  NODE_BUILTIN_SURFACE_PLATFORM
} from '../src/node-capability-surfaces.js'

const dispositions = ['allowed', 'attenuated', 'modeDependent', 'denied']
const classified = new Map()

for (const disposition of dispositions) {
  const ids = NODE_BUILTIN_POLICY[disposition]
  assert.deepEqual(ids, [...ids].sort(), `${disposition} policy entries must be sorted`)
  for (const id of ids) {
    assert.equal(classified.has(id), false, `${id} has multiple capability dispositions`)
    classified.set(id, disposition)
  }
}

for (const [profileName, profile] of Object.entries(NODE_BUILTIN_PROFILES)) {
  assert.deepEqual(profile, [...profile].sort(), `${profileName} profile must be sorted`)
  for (const id of profile) {
    assert.ok(classified.has(id), `${profileName} contains unclassified builtin ${id}`)
  }
}

for (const id of classified.keys()) {
  const inProfile = Object.values(NODE_BUILTIN_PROFILES).some(profile => profile.includes(id))
  assert.ok(inProfile, `classified builtin ${id} is absent from every runtime profile`)
}

const [, minor] = process.versions.node.split('.').map(Number)
const profileName = minor >= 9 ? 'from26_9' : 'before26_9'
const expectedModules = NODE_BUILTIN_PROFILES[profileName]
const actualModules = [...builtinModules].sort()
reportDifference('builtin module IDs', expectedModules, actualModules)

const surfacedIds = [
  ...NODE_BUILTIN_POLICY.allowed,
  ...NODE_BUILTIN_POLICY.attenuated,
  ...NODE_BUILTIN_POLICY.modeDependent
].sort()
assert.deepEqual(
  Object.keys(NODE_BUILTIN_SURFACE_BASE).sort(),
  surfacedIds,
  'surface manifest must cover every guest-reachable builtin'
)
for (const additions of [NODE_BUILTIN_SURFACE_FROM_26_8, NODE_BUILTIN_SURFACE_FROM_26_9]) {
  for (const id of Object.keys(additions)) {
    assert.ok(Object.hasOwn(NODE_BUILTIN_SURFACE_BASE, id), `surface addition has unknown builtin ${id}`)
  }
}
for (const [platform, overrides] of Object.entries(NODE_BUILTIN_SURFACE_PLATFORM)) {
  for (const id of Object.keys(overrides)) {
    assert.ok(
      Object.hasOwn(NODE_BUILTIN_SURFACE_BASE, id),
      `${platform} surface override has unknown builtin ${id}`
    )
  }
}

const platformSurfaces = NODE_BUILTIN_SURFACE_PLATFORM[process.platform]
assert.ok(platformSurfaces, `unsupported capability platform ${process.platform}`)
const observedSurfaces = await inspectWorkerSurfaces(surfacedIds)
for (const id of surfacedIds) {
  const base = platformSurfaces[id] ?? NODE_BUILTIN_SURFACE_BASE[id]
  const additions26_8 = minor >= 8 ? NODE_BUILTIN_SURFACE_FROM_26_8[id] : undefined
  const additions26_9 = minor >= 9 ? NODE_BUILTIN_SURFACE_FROM_26_9[id] : undefined
  reportSurfaceDifference(
    `${id} CommonJS exports`,
    [...base[0], ...(additions26_8?.[0] ?? []), ...(additions26_9?.[0] ?? [])].sort(),
    observedSurfaces[id][0],
    false
  )
  reportSurfaceDifference(
    `${id} ESM namespace exports`,
    [...base[1], ...(additions26_8?.[1] ?? []), ...(additions26_9?.[1] ?? [])].sort(),
    observedSurfaces[id][1],
    true
  )
}

// The worker performs descriptor-only checks against the committed CommonJS
// and ESM surface manifest before compiling or importing this source. Keeping
// this probe in the explicit gate prevents CI from relying only on unrelated
// test coverage to exercise the runtime check.
assert.equal(await runUntrustedCode('return true'), true)

console.log(`Node capability policy matches ${process.version} on ${process.platform}/${process.arch}`)

async function inspectWorkerSurfaces (ids) {
  const source = String.raw`
    'use strict'
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

    ;(async () => {
      const { parentPort, workerData } = require('node:worker_threads')
      const result = {}
      for (const id of workerData) {
        const specifier = id.startsWith('node:') ? id : 'node:' + id
        const omitNumericConstants = id === 'constants'
        result[id] = [
          signature(require(specifier), omitNumericConstants),
          signature(await import(specifier), omitNumericConstants)
        ]
      }
      parentPort.postMessage(result)
    })().catch(error => { throw error })
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
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
      stdout: true,
      workerData: ids
    })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`capability inspection worker exited with code ${code}`))
    })
  })
}

function reportSurfaceDifference (label, expected, actual, namesOnly) {
  const { added, removed } = diffSurfaceSignatures(expected, actual, { namesOnly })

  if (!namesOnly && label === 'process CommonJS exports') {
    const lazyIndex = removed.findIndex(value => value === 'allowedNodeEnvironmentFlags:a|o')
    const actualLazy = added.findIndex(value => value === 'allowedNodeEnvironmentFlags:a' ||
      value === 'allowedNodeEnvironmentFlags:o')
    if (lazyIndex !== -1 && actualLazy !== -1) {
      removed.splice(lazyIndex, 1)
      added.splice(actualLazy, 1)
    }
  }
  reportChanges(label, added, removed)
}

function reportDifference (label, expected, actual) {
  const { added, removed } = diffExactLists(expected, actual)
  reportChanges(label, added, removed)
}

function reportChanges (label, added, removed) {
  if (added.length === 0 && removed.length === 0) return

  const details = [
    `Unreviewed Node capability surface change: ${label}`,
    `runtime: ${process.version} ${process.platform}/${process.arch}`
  ]
  if (added.length > 0) details.push(`added: ${JSON.stringify(added)}`)
  if (removed.length > 0) details.push(`removed: ${JSON.stringify(removed)}`)
  details.push(
    'Review Node release notes and source, classify the change, add hardening and regressions where needed, then update the policy in the same reviewed change.'
  )
  throw new Error(details.join('\n'))
}
