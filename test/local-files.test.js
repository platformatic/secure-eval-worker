import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { Dir } from 'node:fs'
import { cp, link, mkdtemp, mkdir, open, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { platform, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'

import {
  configureWorkerAdmission,
  createUntrustedWorker,
  createUntrustedWorkerFromFile,
  runUntrustedCode,
  runUntrustedFile,
  UntrustedCodeError
} from '../src/index.js'
import { getFileDescriptorQuotaWorkerData } from '../src/admission.js'
import { resolveLocalModule } from '../src/local-files.js'
import { createUntrustedFileSession } from '../src/session.js'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const packageUrl = new URL('../src/index.js', import.meta.url).href
const admissionUrl = new URL('../src/admission.js', import.meta.url).href
const legacyDescriptorStateUrl = new URL(
  '../fixtures/security/legacy-descriptor-state-v1.mjs',
  import.meta.url
).href
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

const TIMEOUTS = {
  startupTimeoutMs: 5_000,
  messageTimeoutMs: 5_000,
  lifetimeTimeoutMs: 5_000
}

async function waitForFilePreparation (entryPath, rootDirectory) {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await runUntrustedFile(entryPath, { rootDirectory, timeoutMs: 5_000 })
      return
    } catch (error) {
      if (error.code !== 'ERR_UNTRUSTED_CODE_CAPACITY' || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function fixture (files) {
  const directory = await mkdtemp(join(tmpdir(), 'secure-eval-worker-files-'))
  for (const [name, source] of Object.entries(files)) {
    const path = join(directory, name)
    await mkdir(new URL('.', pathToFileURL(path)), { recursive: true })
    await writeFile(path, source)
  }
  return {
    directory,
    path: (name) => join(directory, name),
    async cleanup () { await rm(directory, { force: true, recursive: true }) }
  }
}

test('runs a local module with static and dynamic relative imports', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      import { add } from './lib/add.mjs'
      export default async function (input) {
        const { multiply } = await import('./lib/multiply.mjs')
        return multiply(add(input.left, input.right), 2)
      }
    `,
    'lib/add.mjs': 'export const add = (left, right) => left + right',
    'lib/multiply.mjs': 'export const multiply = (left, right) => left * right'
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    input: { left: 10, right: 11 },
    timeoutMs: 5_000
  }), 42)
})

test('local file URLs preserve encoded path bytes and trailing root separators', async (t) => {
  const files = await fixture({
    'entry # % (value).mjs': 'export default () => 42'
  })
  t.after(() => files.cleanup())
  assert.equal(await runUntrustedFile(files.path('entry # % (value).mjs'), {
    rootDirectory: files.directory + sep,
    timeoutMs: 5_000
  }), 42)
})

test('staging file URLs remain canonical under special-character temporary roots', async (t) => {
  const files = await fixture({
    'entry.mjs': "import './nested/failure.mjs'; export default () => 1",
    'missing.mjs': "import './nested/absent.mjs'; export default () => 1",
    'nested/failure.mjs': "throw new Error('failure')"
  })
  const specialSegment = platform() === 'win32'
    ? "secure-eval-worker $&'+,;=@[]^{}~#%-"
    : "secure-eval-worker $&'+,:;=@[]^{}~#?%-"
  const temporaryParent = await mkdtemp(join(tmpdir(), 'secure-eval-worker-special-root-'))
  const stagingBasePath = join(temporaryParent, specialSegment)
  t.after(async () => {
    await files.cleanup()
    await rm(temporaryParent, { force: true, recursive: true })
  })
  await mkdir(stagingBasePath, { recursive: true })
  // macOS exposes /var through a /private/var symlink. Node's temporary-file
  // APIs may return the canonical spelling even when TMPDIR uses the alias.
  const stagingBase = platform() === 'darwin'
    ? await realpath(stagingBasePath)
    : stagingBasePath
  const localFilesUrl = new URL('../src/local-files.js', import.meta.url).href
  const packageUrl = new URL('../src/index.js', import.meta.url).href
  const childSource = `
    import assert from 'node:assert/strict'
    import { fileURLToPath, pathToFileURL } from 'node:url'
    import { resolveLocalModule } from ${JSON.stringify(localFilesUrl)}
    import { runUntrustedFile } from ${JSON.stringify(packageUrl)}
    const stagingBase = ${JSON.stringify(stagingBase)}
    const entry = ${JSON.stringify(files.path('entry.mjs'))}
    const missing = ${JSON.stringify(files.path('missing.mjs'))}
    const root = ${JSON.stringify(files.directory)}
    const localModule = (await resolveLocalModule(entry, root, {
      maxRootEntries: 16,
      maxFileBytes: 1024,
      maxTotalFileBytes: 4096
    })).value
    try {
      assert.equal(localModule.rootPath.startsWith(stagingBase), true)
      assert.equal(localModule.entryUrl, pathToFileURL(fileURLToPath(localModule.entryUrl)).href)
      assert.equal(localModule.rootUrlPrefix, pathToFileURL(fileURLToPath(localModule.rootUrlPrefix)).href)
    } finally {
      await localModule.cleanup()
    }
    await assert.rejects(
      runUntrustedFile(entry, { rootDirectory: root, timeoutMs: 5_000 }),
      (error) => {
        assert.match(error.remoteStack, /secure-eval-worker-files[\\\\/]nested[\\\\/]failure\\.mjs:1/)
        assert.equal(error.message.includes(stagingBase), false)
        assert.equal(error.remoteStack.includes(stagingBase), false)
        assert.equal(error.remoteStack.includes('secure-eval-worker-modules-'), false)
        return true
      }
    )
    await assert.rejects(
      runUntrustedFile(missing, { rootDirectory: root, timeoutMs: 5_000 }),
      (error) => {
        assert.match(error.message, /secure-eval-worker-files[\\\\/]nested[\\\\/]absent\\.mjs/)
        assert.equal(error.message.includes(stagingBase), false)
        assert.equal(error.remoteStack.includes(stagingBase), false)
        assert.equal(error.remoteStack.includes('secure-eval-worker-modules-'), false)
        return true
      }
    )
    console.log('ok')
  `
  const environment = { ...process.env }
  if (platform() === 'win32') {
    environment.TEMP = stagingBasePath
    environment.TMP = stagingBasePath
  } else {
    environment.TMPDIR = stagingBasePath
  }
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', childSource],
    { encoding: 'utf8', env: environment, timeout: 30_000 }
  )
  assert.equal(stderr, '')
  assert.equal(stdout.trim(), 'ok')
})

test('local file URLs preserve literal backslashes in any POSIX entry segment', async (t) => {
  if (platform() === 'win32') {
    t.skip('Backslash is a path separator on Windows')
    return
  }
  const files = await fixture({
    'a\\b/entry.mjs': "import value from './relative.mjs'; export default () => value",
    'a\\b/relative.mjs': "export default 'literal-backslash'",
    'a\\b/failure.mjs': "export default () => { throw new Error('literal failure') }",
    'a/b/entry.mjs': "export default () => 'nested-path'"
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('a\\b/entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 'literal-backslash')

  await assert.rejects(
    runUntrustedFile(files.path('a\\b/failure.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => {
      assert.match(error.remoteStack, /secure-eval-worker-files\//)
      assert.doesNotMatch(error.remoteStack, /secure-eval-worker-entry-[0-9a-f-]{36}/i)
      return true
    }
  )
})

test('POSIX backslash aliases fail closed on deterministic source collisions', async (t) => {
  if (platform() === 'win32') {
    t.skip('Backslash is a path separator on Windows')
    return
  }
  const files = await fixture({
    'a\\b/entry.mjs': "import value from './sibling.mjs'; export default () => value",
    '.secure-eval-worker-segment-615c62/sibling.mjs': 'export default 99'
  })
  t.after(() => files.cleanup())
  await assert.rejects(
    runUntrustedFile(files.path('a\\b/entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_CHANGED' ||
      error.cause?.code === 'ERR_UNTRUSTED_MODULE_CHANGED'
  )
})

test('local staging uses snapshotted builtin exports after option poisoning', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default input => input' })
  t.after(() => files.cleanup())
  const builtins = [
    [require('node:crypto'), ['randomUUID']],
    [require('node:fs'), ['realpath', 'open', 'read', 'write', 'fstat', 'close', 'link', 'opendir', 'lstat', 'stat', 'mkdir', 'mkdtemp', 'unlink', 'rmdir']],
    [require('node:path'), ['extname', 'join', 'relative', 'dirname', 'isAbsolute']],
    [require('node:os'), ['tmpdir', 'platform']],
    [require('node:url'), ['fileURLToPath', 'pathToFileURL']]
  ]
  const originals = []
  let poisoned = false
  const restore = () => {
    if (!poisoned) return
    poisoned = false
    for (const [target, name, descriptor] of originals) {
      Object.defineProperty(target, name, descriptor)
    }
    syncBuiltinESMExports()
  }
  t.after(restore)
  const poison = () => {
    if (poisoned) return
    poisoned = true
    for (const [target, names] of builtins) {
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(target, name)
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') continue
        originals.push([target, name, descriptor])
        Object.defineProperty(target, name, {
          ...descriptor,
          value () { throw new Error(`poisoned builtin ${name}`) }
        })
      }
    }
    syncBuiltinESMExports()
  }
  const options = new Proxy({
    rootDirectory: files.directory,
    input: 42,
    timeoutMs: 5_000
  }, {
    ownKeys (target) {
      poison()
      return Reflect.ownKeys(target)
    }
  })
  try {
    assert.equal(await runUntrustedFile(files.path('entry.mjs'), options), 42)
  } finally {
    restore()
  }
  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    input: 43,
    timeoutMs: 5_000
  }), 43)
})

test('file URL conversion never consults a non-returning live path resolver', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  const source = `
    import { createRequire, syncBuiltinESMExports } from 'node:module'
    import { runUntrustedFile } from ${JSON.stringify(packageUrl)}
    const require = createRequire(import.meta.url)
    const pathBuiltin = require('node:path')
    const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    Object.defineProperty(pathBuiltin, 'resolve', {
      ...Object.getOwnPropertyDescriptor(pathBuiltin, 'resolve'),
      value: block
    })
    if (pathBuiltin.posix !== pathBuiltin) {
      Object.defineProperty(pathBuiltin.posix, 'resolve', {
        ...Object.getOwnPropertyDescriptor(pathBuiltin.posix, 'resolve'),
        value: block
      })
    }
    syncBuiltinESMExports()
    const result = await runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
      rootDirectory: ${JSON.stringify(files.directory)},
      timeoutMs: 5000
    })
    process.stdout.write(String(result))
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    timeout: 10_000
  })
  assert.equal(stdout, '42')
})

test('poisoned Error prototype metadata cannot strand local admission', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  const source = `
    import { runUntrustedFile } from ${JSON.stringify(packageUrl)}
    const defineProperty = Object.defineProperty
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
    const nameDescriptor = getOwnPropertyDescriptor(Error.prototype, 'name')
    let setterCalls = 0
    defineProperty(Error.prototype, 'name', {
      configurable: true,
      get: nameDescriptor.get,
      set () { setterCalls++; throw new Error('poisoned Error name setter') }
    })
    const restore = () => defineProperty(Error.prototype, 'name', nameDescriptor)
    try {
      const result = await runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        timeoutMs: 5000
      })
      restore()
      process.stdout.write(JSON.stringify({ result, setterCalls }))
    } catch (error) {
      restore()
      process.stdout.write(JSON.stringify({ error: error.message, setterCalls }))
    }
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    timeout: 10_000
  })
  assert.deepEqual(JSON.parse(stdout), { result: 42, setterCalls: 0 })
})

test('Object.prototype then pollution cannot assimilate settled public results', async (t) => {
  const files = await fixture({
    'one-shot.mjs': 'export default () => ({ answer: 42 })',
    'persistent.mjs': 'export default ({ onMessage }) => onMessage(value => ({ value }))'
  })
  t.after(() => files.cleanup())
  const source = `
    import * as api from ${JSON.stringify(packageUrl)}
    const promiseThen = Promise.prototype.then
    const defineProperty = Object.defineProperty
    const deleteProperty = Reflect.deleteProperty
    const stringify = JSON.stringify
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const session = await api.createUntrustedWorkerFromFile(
      ${JSON.stringify(files.path('persistent.mjs'))},
      {
        rootDirectory: ${JSON.stringify(files.directory)},
        startupTimeoutMs: 5000,
        messageTimeoutMs: 5000,
        lifetimeTimeoutMs: 5000
      }
    )
    const ready = session.ready
    await ready
    const request = session.request('value')
    const response = await request
    const termination = session.terminate()
    await termination
    const closed = session.closed
    const closedResult = await closed

    let thenCalls = 0
    let observations = 0
    defineProperty(Object.prototype, 'then', {
      configurable: true,
      value (resolve) {
        thenCalls++
        if (typeof resolve === 'function') resolve('assimilated')
      },
      writable: true
    })
    for (const promise of [ready, request, closed]) {
      Reflect.apply(promiseThen, promise, [() => { observations++ }])
    }
    queueMicrotask(() => {
      const denied = api.runUntrustedFile(${JSON.stringify(files.path('one-shot.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        timeoutMs: 5000
      })
      Reflect.apply(promiseThen, denied, [
        () => {},
        (error) => {
          const denial = error.message
          deleteProperty(Object.prototype, 'then')
          const reuse = api.runUntrustedFile(${JSON.stringify(files.path('one-shot.mjs'))}, {
            rootDirectory: ${JSON.stringify(files.directory)},
            timeoutMs: 5000
          })
          Reflect.apply(promiseThen, reuse, [
            (reused) => process.stdout.write(stringify({
              response: response.value,
              closed: closedResult.code,
              observations,
              denial,
              reused: reused.answer,
              thenCalls
            })),
            (reuseError) => process.stdout.write(stringify({ error: reuseError.message, thenCalls }))
          ])
        }
      ])
    })
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    timeout: 12_000
  })
  assert.deepEqual(JSON.parse(stdout), {
    response: 'value',
    closed: 1,
    observations: 3,
    denial: 'Object.prototype.then must not be callable or accessor-backed',
    reused: 42,
    thenCalls: 0
  })
})

test('private read-only snapshots can be removed with captured cleanup operations', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  const localModule = (await resolveLocalModule(
    files.path('entry.mjs'),
    files.directory,
    {
      maxRootEntries: 16,
      maxFileBytes: 1024,
      maxTotalFileBytes: 4096
    }
  )).value
  const snapshotRoot = localModule.rootPath
  assert.equal((await stat(join(snapshotRoot, 'entry.mjs'))).isFile(), true)
  await localModule.cleanup()
  await assert.rejects(stat(snapshotRoot), (error) => error.code === 'ENOENT')
})

test('resolves packages contained within the trusted root', async (t) => {
  const files = await fixture({
    'entry.mjs': "import answer from 'local-answer'; export default () => answer",
    'node_modules/local-answer/package.json': JSON.stringify({
      name: 'local-answer',
      type: 'module',
      exports: './index.mjs'
    }),
    'node_modules/local-answer/index.mjs': 'export default 42'
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('local CommonJS resolver paths hide host search locations', async (t) => {
  const files = await fixture({
    'entry.mjs': "import value from './resolver.cjs'; export default () => value",
    'resolver.cjs': `module.exports = {
      answer: require('local-answer'),
      directory: __dirname,
      modulePaths: module.paths,
      resolvePaths: require.resolve.paths('secure-eval-worker-probe')
    }`,
    'node_modules/local-answer/package.json': JSON.stringify({
      name: 'local-answer',
      main: './index.cjs'
    }),
    'node_modules/local-answer/index.cjs': 'module.exports = 42'
  })
  t.after(() => files.cleanup())

  const result = await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  })
  assert.equal(result.answer, 42)
  assert.equal(result.modulePaths.length > 0, true)
  assert.equal(result.resolvePaths.length > 0, true)
  for (const paths of [result.modulePaths, result.resolvePaths]) {
    for (const path of paths ?? []) {
      const fromRoot = relative(result.directory, path)
      assert.equal(
        fromRoot === '' ||
          (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)),
        true
      )
    }
  }
})

test('creates a persistent session from a local module', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      import { prefix } from './prefix.mjs'
      export default async function ({ input, send, onMessage, host }) {
        send(prefix + input.name)
        onMessage(value => host.math.double(value))
      }
    `,
    'prefix.mjs': "export const prefix = 'ready:'"
  })
  t.after(() => files.cleanup())

  const session = await createUntrustedWorkerFromFile(files.path('entry.mjs'), {
    ...TIMEOUTS,
    rootDirectory: files.directory,
    input: { name: 'module' },
    hostFunctions: { math: { double: (value) => value * 2 } }
  })
  const message = new Promise((resolve) => session.once('message', resolve))
  await session.ready
  assert.equal(await message, 'ready:module')
  assert.equal(await session.request(21), 42)
  await session.terminate()
})

test('uses the entry directory as the default trusted root', async (t) => {
  const files = await fixture({
    'entry.mjs': "import value from './value.mjs'; export default () => value",
    'value.mjs': 'export default 42'
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), { timeoutMs: 5_000 }), 42)
  assert.equal(await runUntrustedFile(pathToFileURL(files.path('entry.mjs')), {
    rootDirectory: pathToFileURL(files.directory + '/'),
    timeoutMs: 5_000
  }), 42)
})

test('confines filesystem reads and blocks inherited descriptors', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      import fs from 'node:fs'
      import fsPromises from 'node:fs/promises'
      import Module, { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      export default (input) => {
        const local = fs.readFileSync(new URL('./value.txt', import.meta.url), 'utf8')
        const aliases = [fs, require('fs'), Module._load('fs')]
        const inherited = []
        for (const alias of aliases) {
          for (const name of ['readFileSync', 'fstatSync', 'readSync', 'readvSync', 'closeSync']) {
            try {
              if (name === 'readSync') alias[name](input.inheritedFd, Buffer.alloc(1), 0, 1, 0)
              else if (name === 'readvSync') alias[name](input.inheritedFd, [Buffer.alloc(1)], 0)
              else alias[name](input.inheritedFd)
              inherited.push('allowed:' + name)
            } catch (error) {
              inherited.push(error.code)
            }
          }
        }
        try {
          fsPromises.readFile(new URL('./value.txt', import.meta.url))
          inherited.push('allowed:promise')
        } catch (error) {
          inherited.push(error.code)
        }
        return { local, inherited }
      }
    `,
    'value.txt': 'trusted root value'
  })
  t.after(() => files.cleanup())
  const inherited = await open(files.path('value.txt'), 'r')
  t.after(() => inherited.close())

  const result = await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    input: { inheritedFd: inherited.fd },
    timeoutMs: 5_000
  })
  assert.equal(result.local, 'trusted root value')
  assert.equal(result.inherited.length, 16)
  assert.equal(result.inherited.every((code) => code === 'ERR_ACCESS_DENIED'), true)
  await inherited.stat()
})

test('bounds guest-opened descriptors across every filesystem alias', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      import fs, { closeSync, openSync } from 'node:fs'
      import Module, { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      export default () => {
        const path = new URL('./value.txt', import.meta.url)
        const aliases = [
          fs,
          { openSync, closeSync },
          require('fs'),
          Module._load('fs'),
          process.getBuiltinModule('fs')
        ]
        const descriptors = []
        for (let index = 0; index < 64; index++) {
          descriptors.push(aliases[index % aliases.length].openSync(path, 'r'))
        }
        let limitCode
        try {
          fs.openSync(path, 'r')
        } catch (error) {
          limitCode = error.code
        }
        for (let index = 0; index < descriptors.length; index++) {
          aliases[index % aliases.length].closeSync(descriptors[index])
        }
        const reopened = fs.openSync(path, 'r')
        fs.closeSync(reopened)
        return limitCode
      }
    `,
    'value.txt': 'bounded'
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 'ERR_UNTRUSTED_FILE_DESCRIPTOR_LIMIT')
})

test('descriptor accounting uses the captured typed-array length getter', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      import fs from 'node:fs'
      export default () => {
        let reads = 0
        const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
        const descriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')
        Object.defineProperty(typedArrayPrototype, 'length', {
          ...descriptor,
          get () {
            reads++
            throw new Error('poisoned typed-array length')
          }
        })
        const descriptorNumber = fs.openSync(new URL('./value.txt', import.meta.url), 'r')
        fs.closeSync(descriptorNumber)
        return reads
      }
    `,
    'value.txt': 'captured length'
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 0)
})

test('physical package copies share the descriptor quota and release it on exit', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 5 })
  const temporary = await mkdtemp(join(tmpdir(), 'secure-eval-worker-descriptor-copy-'))
  const copyRoot = join(temporary, 'copy')
  await mkdir(copyRoot)
  await cp(new URL('../src', import.meta.url), join(copyRoot, 'src'), { recursive: true })
  await writeFile(join(copyRoot, 'package.json'), '{"type":"module"}')
  const copy = await import(pathToFileURL(join(copyRoot, 'src/index.js')).href)
  const files = await fixture({
    'entry.mjs': `
      import fs from 'node:fs'
      const retained = []
      export default ({ onMessage }) => onMessage((count) => {
        let opened = 0
        try {
          for (; opened < count; opened++) {
            retained.push(fs.openSync(new URL('./value.txt', import.meta.url), 'r'))
          }
          return { opened }
        } catch (error) {
          return { code: error.code, opened }
        }
      })
    `,
    'value.txt': 'bounded globally'
  })
  const sessions = []
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.terminate().catch(() => {})))
    configureWorkerAdmission({ maxConcurrentWorkers: 4 })
    await Promise.all([
      files.cleanup(),
      rm(temporary, { force: true, recursive: true })
    ])
  })

  for (let index = 0; index < 5; index++) {
    const createSession = index === 4
      ? copy.createUntrustedWorkerFromFile
      : createUntrustedWorkerFromFile
    const session = await createSession(files.path('entry.mjs'), {
      ...TIMEOUTS,
      lifetimeTimeoutMs: 15_000,
      rootDirectory: files.directory
    })
    sessions.push(session)
    await session.ready
  }
  for (const session of sessions.slice(0, 4)) {
    assert.deepEqual(await session.request(64), { opened: 64 })
  }
  assert.deepEqual(await sessions[4].request(1), {
    code: 'ERR_UNTRUSTED_FILE_DESCRIPTOR_CAPACITY',
    opened: 0
  })

  const first = sessions.shift()
  await first.terminate()
  await first.closed
  assert.deepEqual(await sessions[3].request(1), { opened: 1 })
})

test('a legacy v1 consumer can use descriptor quota state initialized by the new copy', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))

  const descriptorState = globalThis[
    Symbol.for('secure-eval-worker.admission.descriptors.main.v1')
  ]
  const quota = descriptorState.createWorkerQuota()
  const workerData = getFileDescriptorQuotaWorkerData(quota)
  assert.equal(Object.isFrozen(quota), true)
  assert.equal(quota.owner, workerData.owner)
  assert.equal(quota.slotsBuffer, workerData.slotsBuffer)
  assert.equal(typeof quota.release, 'function')

  const slots = new Int32Array(quota.slotsBuffer)
  assert.equal(Atomics.compareExchange(slots, 0, 0, quota.owner), 0)
  quota.release()
  assert.equal(Atomics.load(slots, 0), 0)

  const files = await fixture({
    'entry.mjs': 'export default ({ onMessage }) => onMessage(value => value)'
  })
  t.after(() => files.cleanup())
  const session = await createUntrustedWorkerFromFile(files.path('entry.mjs'), {
    ...TIMEOUTS,
    rootDirectory: files.directory
  })
  await session.ready
  assert.equal(await session.request(42), 42)
  await session.terminate()
  await session.closed
})

test('a new copy adapts descriptor quota state initialized by a legacy v1 copy', async (t) => {
  const files = await fixture({
    'entry.mjs': `export default input => {
      process.getBuiltinModule('node:fs').openSync(new URL(import.meta.url))
      return input
    }`,
    'session.mjs': `export default ({ onMessage }) => onMessage(value => {
      process.getBuiltinModule('node:fs').openSync(new URL(import.meta.url))
      return value
    })`
  })
  const stagingBase = await mkdtemp(join(tmpdir(), 'secure-eval-worker-old-descriptor-state-'))
  const canonicalStagingBase = await realpath(stagingBase)
  t.after(async () => Promise.all([
    files.cleanup(),
    rm(stagingBase, { force: true, recursive: true })
  ]))

  const childSource = `
    const { installLegacyDescriptorStateV1 } = await import(
      ${JSON.stringify(legacyDescriptorStateUrl)}
    )
    const { slotsBuffer } = installLegacyDescriptorStateV1(['noop', 'throw', 'normal'])
    const slots = new Int32Array(slotsBuffer)
    const api = await import(${JSON.stringify(packageUrl)})
    const admission = await import(${JSON.stringify(admissionUrl)})
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const uncaught = []
    process.on('uncaughtException', error => uncaught.push(String(error)))
    process.on('unhandledRejection', error => uncaught.push(String(error)))
    const typedArrayPrototype = Object.getPrototypeOf(Int32Array.prototype)
    const originalLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')
    Object.defineProperty(typedArrayPrototype, 'length', {
      configurable: true,
      get () { return 0 }
    })
    const runFile = input => api.runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
      rootDirectory: ${JSON.stringify(files.directory)},
      input,
      timeoutMs: 5000
    })
    const fileResults = [await runFile(40), await runFile(41)]
    const session = await api.createUntrustedWorkerFromFile(
      ${JSON.stringify(files.path('session.mjs'))},
      {
        rootDirectory: ${JSON.stringify(files.directory)},
        startupTimeoutMs: 5000,
        messageTimeoutMs: 5000,
        lifetimeTimeoutMs: 5000
      }
    )
    await session.ready
    const response = await session.request(42)
    await session.terminate()
    const closed = await session.closed
    Object.defineProperty(typedArrayPrototype, 'length', originalLength)
    const sourceResult = await api.runUntrustedCode('return 43', { timeoutMs: 5000 })
    const snapshots = await (await import('node:fs/promises')).readdir(
      ${JSON.stringify(canonicalStagingBase)}
    )
    let descriptorSlotsInUse = 0
    for (let index = 0; index < slots.length; index++) {
      if (Atomics.load(slots, index) !== 0) descriptorSlotsInUse++
    }
    console.log(JSON.stringify({
      fileResults,
      sourceResult,
      response,
      closedError: closed.error?.code ?? null,
      activeWorkers: admission.getWorkerAdmissionStatus().activeWorkers,
      descriptorSlotsInUse,
      snapshots,
      uncaught
    }))
  `
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource
  ], {
    env: {
      ...process.env,
      TEMP: canonicalStagingBase,
      TMP: canonicalStagingBase,
      TMPDIR: canonicalStagingBase
    },
    timeout: 20_000
  })
  assert.deepEqual(JSON.parse(stdout), {
    fileResults: [40, 41],
    sourceResult: 43,
    response: 42,
    closedError: null,
    activeWorkers: 0,
    descriptorSlotsInUse: 0,
    snapshots: [],
    uncaught: []
  })
})

test('a malformed legacy descriptor state fails closed without leaking admission or snapshots', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  const stagingBase = await mkdtemp(join(tmpdir(), 'secure-eval-worker-bad-descriptor-state-'))
  const canonicalStagingBase = await realpath(stagingBase)
  t.after(async () => Promise.all([
    files.cleanup(),
    rm(stagingBase, { force: true, recursive: true })
  ]))

  const childSource = `
    Object.defineProperty(
      globalThis,
      Symbol.for('secure-eval-worker.admission.descriptors.main.v1'),
      {
        value: Object.freeze({
          createWorkerQuota () {
            return Object.freeze({
              owner: 0,
              slotsBuffer: new SharedArrayBuffer(1024),
              release () {}
            })
          }
        })
      }
    )
    const api = await import(${JSON.stringify(packageUrl)})
    const admission = await import(${JSON.stringify(admissionUrl)})
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const runFile = () => api.runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
      rootDirectory: ${JSON.stringify(files.directory)},
      timeoutMs: 5000
    })
    const codes = []
    for (let index = 0; index < 2; index++) {
      try {
        await runFile()
      } catch (error) {
        codes.push(error.code)
      }
    }
    const sourceResult = await api.runUntrustedCode('return 42', { timeoutMs: 5000 })
    const snapshots = await (await import('node:fs/promises')).readdir(
      ${JSON.stringify(canonicalStagingBase)}
    )
    console.log(JSON.stringify({
      codes,
      sourceResult,
      activeWorkers: admission.getWorkerAdmissionStatus().activeWorkers,
      snapshots
    }))
  `
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource
  ], {
    env: {
      ...process.env,
      TEMP: canonicalStagingBase,
      TMP: canonicalStagingBase,
      TMPDIR: canonicalStagingBase
    },
    timeout: 20_000
  })
  assert.deepEqual(JSON.parse(stdout), {
    codes: [
      'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE',
      'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE'
    ],
    sourceResult: 42,
    activeWorkers: 0,
    snapshots: []
  })
})

test('rejects entries and symlinks outside the trusted root', async (t) => {
  const root = await fixture({ 'inside.mjs': 'export default () => 1' })
  const outside = await fixture({ 'outside.mjs': 'export default () => 2' })
  t.after(async () => {
    await Promise.all([root.cleanup(), outside.cleanup()])
  })

  await assert.rejects(
    runUntrustedFile(outside.path('outside.mjs'), {
      rootDirectory: root.directory,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_OUTSIDE_ROOT'
  )

  await symlink(outside.path('outside.mjs'), root.path('escape.mjs'))
  await assert.rejects(
    runUntrustedFile(root.path('escape.mjs'), {
      rootDirectory: root.directory,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_OUTSIDE_ROOT'
  )
})

test('rejects relative symlinks before granting the trusted root', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'secure-eval-worker-links-'))
  const root = join(parent, 'root')
  await mkdir(root)
  await writeFile(join(parent, 'outside.mjs'), 'export default () => 42')
  await writeFile(join(root, 'entry.mjs'), "import value from './escape.mjs'; export default value")
  await symlink('../outside.mjs', join(root, 'escape.mjs'))
  t.after(() => rm(parent, { force: true, recursive: true }))

  await assert.rejects(
    runUntrustedFile(join(root, 'entry.mjs'), {
      rootDirectory: root,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_ROOT'
  )
})

test('rejects special files promptly and leaves admission reusable', {
  skip: platform() === 'win32'
}, async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  const fifoPath = files.path('named-pipe')
  try {
    await execFileAsync('mkfifo', [fifoPath])
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('mkfifo is unavailable')
      return
    }
    throw error
  }

  const startedAt = Date.now()
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 500
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_ROOT'
  )
  assert.equal(Date.now() - startedAt < 2_000, true)

  await rm(fifoPath, { force: true })
  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('copies hard-linked regular files as trusted root contents', async (t) => {
  const root = await fixture({
    'entry.mjs': `
      import linked from './linked.mjs'
      export default () => linked
    `
  })
  const outside = await fixture({
    'outside.mjs': 'export default { answer: 42, url: import.meta.url }'
  })
  t.after(async () => Promise.all([root.cleanup(), outside.cleanup()]))
  try {
    await link(outside.path('outside.mjs'), root.path('linked.mjs'))
  } catch (error) {
    if (['EACCES', 'EPERM', 'EXDEV', 'ENOTSUP'].includes(error.code)) {
      t.skip(`hard links are unavailable: ${error.code}`)
      return
    }
    throw error
  }

  const result = await runUntrustedFile(root.path('entry.mjs'), {
    rootDirectory: root.directory,
    timeoutMs: 5_000
  })
  assert.equal(result.answer, 42)
  await assert.rejects(
    stat(fileURLToPath(result.url)),
    (error) => error.code === 'ENOENT'
  )
})

test('rejects Windows junctions and accepts canonical case aliases', {
  skip: platform() !== 'win32'
}, async (t) => {
  const root = await fixture({ 'entry.mjs': 'export default () => 42' })
  const outside = await fixture({ 'outside.txt': 'secret' })
  t.after(async () => Promise.all([root.cleanup(), outside.cleanup()]))

  assert.equal(await runUntrustedFile(
    root.path('entry.mjs').toUpperCase(),
    {
      rootDirectory: root.directory.toUpperCase(),
      timeoutMs: 5_000
    }
  ), 42)

  await symlink(outside.directory, root.path('junction'), 'junction')
  await assert.rejects(
    runUntrustedFile(root.path('entry.mjs'), {
      rootDirectory: root.directory,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_ROOT'
  )
})

test('bounds trusted-root scanning and file bytes', async (t) => {
  const files = await fixture({
    'entry.mjs': 'export default () => 42',
    'other.mjs': 'export default 1'
  })
  t.after(() => files.cleanup())

  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      maxRootEntries: 1,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
  )
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      maxFileBytes: 10,
      maxTotalFileBytes: 100,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_FILE_LIMIT'
  )
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      maxFileBytes: 25,
      maxTotalFileBytes: 25,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_ROOT_LIMIT'
  )
})

test('the native loader denies imports that escape the trusted root', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'secure-eval-worker-root-'))
  const root = join(parent, 'root')
  await mkdir(root)
  await writeFile(join(parent, 'outside.mjs'), 'export default 42')
  await writeFile(join(root, 'entry.mjs'), `
    import value from '../outside.mjs'
    export default () => value
  `)
  t.after(() => rm(parent, { force: true, recursive: true }))

  await assert.rejects(
    runUntrustedFile(join(root, 'entry.mjs'), {
      rootDirectory: root,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE' && error.remoteCode === 'ERR_MODULE_NOT_FOUND'
  )
})

test('validates local-file options without invoking accessors', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())

  let reads = 0
  const options = {}
  Object.defineProperty(options, 'rootDirectory', {
    enumerable: true,
    get () {
      reads++
      return files.directory
    }
  })
  await assert.rejects(runUntrustedFile(files.path('entry.mjs'), options), /data property/)
  assert.equal(reads, 0)

  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), { language: 'javascript' }),
    /not supported for local module files/
  )
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), { maxRootEntry: 1 }),
    /Unknown option: maxRootEntry/
  )
  await assert.rejects(
    createUntrustedWorkerFromFile(files.path('entry.mjs'), { messageTimeoutMS: 1 }),
    /Unknown option: messageTimeoutMS/
  )
  await assert.rejects(runUntrustedFile('https://example.com/entry.mjs'), /path string or file URL/)
  await assert.rejects(
    runUntrustedFile(new URL('https://example.com/entry.mjs')),
    /file: protocol/
  )

  const controller = new AbortController()
  controller.signal.addEventListener = () => { throw new Error('poisoned addEventListener') }
  controller.signal.removeEventListener = () => { throw new Error('poisoned removeEventListener') }
  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    signal: controller.signal,
    timeoutMs: 5_000
  }), 42)

  const aborted = new AbortController()
  aborted.abort(new Error('expected abort'))
  Object.defineProperties(aborted.signal, {
    aborted: { value: false },
    reason: { value: new Error('shadowed reason') }
  })
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      signal: aborted.signal,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ABORT_ERR' &&
      error.cause?.message === 'expected abort'
  )
})

test('hostile path errors cannot forge snapshot cleanup ownership', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())

  let prototypeReads = 0
  const modulePath = new Proxy({}, {
    getPrototypeOf () {
      prototypeReads++
      throw new Error('forged cleanup metadata')
    }
  })
  await assert.rejects(
    runUntrustedFile(modulePath, { timeoutMs: 5_000 }),
    (error) => error instanceof TypeError && /path string or file URL/.test(error.message)
  )
  assert.equal(prototypeReads, 0)
  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('local cleanup classification ignores poisoned UntrustedCodeError instanceof', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  const descriptor = Object.getOwnPropertyDescriptor(UntrustedCodeError, Symbol.hasInstance)
  t.after(() => {
    if (descriptor) Object.defineProperty(UntrustedCodeError, Symbol.hasInstance, descriptor)
    else delete UntrustedCodeError[Symbol.hasInstance]
  })
  Object.defineProperty(UntrustedCodeError, Symbol.hasInstance, {
    configurable: true,
    value () { throw new Error('poisoned UntrustedCodeError.hasInstance') }
  })
  await assert.rejects(
    runUntrustedFile(files.path('missing.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_PATH'
  )
  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('snapshot cleanup uses captured promise operations', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({
    'entry.mjs': 'export default ({ onMessage }) => onMessage(() => 42)',
    'one-shot.mjs': 'export default () => 42'
  })
  t.after(() => files.cleanup())

  const originalAll = Promise.all
  const originalRace = Promise.race
  let session
  try {
    const options = new Proxy({ ...TIMEOUTS, rootDirectory: files.directory }, {
      ownKeys (target) {
        Promise.all = () => new Promise(() => {})
        Promise.race = () => new Promise(() => {})
        return Reflect.ownKeys(target)
      }
    })
    session = await createUntrustedWorkerFromFile(files.path('entry.mjs'), options)
    await session.ready
    assert.equal(await session.request(null), 42)
    await session.terminate()
  } finally {
    Promise.all = originalAll
    Promise.race = originalRace
  }

  await session.closed
  assert.equal(await runUntrustedFile(files.path('one-shot.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('promise species poisoning cannot strand local preparation or admission', async (t) => {
  const files = await fixture({
    'entry.mjs': 'export default input => input',
    'extra.txt': 'x'.repeat(1024)
  })
  const stagingBase = await mkdtemp(join(tmpdir(), 'secure-eval-worker-species-'))
  const canonicalStagingBase = await realpath(stagingBase)
  t.after(async () => Promise.all([
    files.cleanup(),
    rm(stagingBase, { force: true, recursive: true })
  ]))
  const childSource = `
    const api = await import(${JSON.stringify(packageUrl)})
    const admission = await import(${JSON.stringify(admissionUrl)})
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const unhandled = []
    process.on('unhandledRejection', error => {
      console.error(error?.stack ?? String(error))
      process.exit(70)
    })
    process.on('uncaughtException', error => {
      console.error(error?.stack ?? String(error))
      process.exit(71)
    })
    const originalConstructor = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      'constructor'
    )
    const originalSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species)
    const originalThen = Promise.prototype.then
    class PoisonPromiseSpecies {
      constructor () { throw new Error('poisoned promise species') }
    }
    const poison = () => {
      Object.defineProperty(PoisonPromiseSpecies, Symbol.species, {
        configurable: true,
        value: PoisonPromiseSpecies
      })
      Object.defineProperty(Promise.prototype, 'constructor', {
        configurable: true,
        value: PoisonPromiseSpecies
      })
      Object.defineProperty(Promise, Symbol.species, {
        configurable: true,
        value: PoisonPromiseSpecies
      })
      Promise.prototype.then = () => new Promise(() => {})
    }
    const restore = () => {
      Object.defineProperty(Promise.prototype, 'constructor', originalConstructor)
      Object.defineProperty(Promise, Symbol.species, originalSpecies)
      Promise.prototype.then = originalThen
    }
    let success
    let successHardened
    let persistentHardened
    let failure
    let cancellation
    try {
      poison()
      success = api.runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        input: 42,
        timeoutMs: 5000
      })
      const constructorDescriptor = Object.getOwnPropertyDescriptor(success, 'constructor')
      successHardened = constructorDescriptor?.value === undefined &&
        constructorDescriptor?.writable === false &&
        constructorDescriptor?.configurable === false
    } finally { restore() }
    success = await success
    let persistent
    try {
      poison()
      persistent = api.createUntrustedWorkerFromFile(${JSON.stringify(files.path('entry.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        startupTimeoutMs: 5000,
        lifetimeTimeoutMs: 5000
      })
      const constructorDescriptor = Object.getOwnPropertyDescriptor(persistent, 'constructor')
      persistentHardened = constructorDescriptor?.value === undefined &&
        constructorDescriptor?.writable === false &&
        constructorDescriptor?.configurable === false
    } finally { restore() }
    const session = await persistent
    await session.ready
    await session.terminate()
    await session.closed
    try {
      poison()
      failure = api.runUntrustedFile(${JSON.stringify(files.path('missing.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        timeoutMs: 5000
      })
    } finally { restore() }
    try { await failure } catch (error) { failure = error.code }
    const controller = new AbortController()
    try {
      poison()
      cancellation = api.runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        signal: controller.signal,
        timeoutMs: 5000
      })
    } finally { restore() }
    controller.abort('test')
    try { await cancellation } catch (error) { cancellation = error.name }
    await new Promise(resolve => setTimeout(resolve, 100))
    const sourceResult = await api.runUntrustedCode('return 43', { timeoutMs: 5000 })
    const snapshots = await (await import('node:fs/promises')).readdir(
      ${JSON.stringify(canonicalStagingBase)}
    )
    console.log(JSON.stringify({
      success,
      successHardened,
      persistentHardened,
      failure,
      cancellation,
      sourceResult,
      activeWorkers: admission.getWorkerAdmissionStatus().activeWorkers,
      snapshots,
      unhandled
    }))
  `
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource
  ], {
    env: {
      ...process.env,
      TEMP: canonicalStagingBase,
      TMP: canonicalStagingBase,
      TMPDIR: canonicalStagingBase
    },
    timeout: 20_000
  })
  assert.notEqual(stdout.trim(), '', stderr)
  assert.deepEqual(JSON.parse(stdout), {
    success: 42,
    successHardened: true,
    persistentHardened: true,
    failure: 'ERR_UNTRUSTED_MODULE_PATH',
    cancellation: 'AbortError',
    sourceResult: 43,
    activeWorkers: 0,
    snapshots: [],
    unhandled: []
  })
})

test('local-file preparation ignores poisoned array iteration', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())

  const originalIterator = Array.prototype[Symbol.iterator]
  let result
  try {
    Array.prototype[Symbol.iterator] = function * () {}
    result = runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    })
  } finally {
    Array.prototype[Symbol.iterator] = originalIterator
  }
  assert.equal(await result, 42)
  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('local path staging uses captured URL and Set intrinsics', async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  const OriginalURL = globalThis.URL
  const OriginalSet = globalThis.Set
  let execution
  try {
    globalThis.URL = class PoisonedURL {
      static [Symbol.hasInstance] () { throw new Error('poisoned URL') }
    }
    globalThis.Set = class PoisonedSet {
      constructor () { throw new Error('poisoned Set') }
    }
    execution = runUntrustedFile(pathToFileURL(files.path('entry.mjs')), {
      rootDirectory: pathToFileURL(files.directory + '/'),
      timeoutMs: 5_000
    })
    assert.equal(await execution, 42)
  } finally {
    globalThis.URL = OriginalURL
    globalThis.Set = OriginalSet
  }
})

test('staging uses captured descriptor operations', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())

  const probe = await open(files.path('entry.mjs'), 'r')
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const originalRead = prototype.read
  const originalStat = prototype.stat
  const originalClose = prototype.close
  try {
    prototype.read = () => new Promise(() => {})
    prototype.stat = () => new Promise(() => {})
    prototype.close = () => new Promise(() => {})
    assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }), 42)
  } finally {
    prototype.read = originalRead
    prototype.stat = originalStat
    prototype.close = originalClose
  }

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('staging uses captured directory operations', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())

  const names = ['read', 'close', Symbol.asyncIterator]
  const originalDescriptors = names.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(Dir.prototype, name)
  ])
  try {
    Object.defineProperty(Dir.prototype, 'read', {
      configurable: true,
      value: () => new Promise(() => {}),
      writable: true
    })
    Object.defineProperty(Dir.prototype, 'close', {
      configurable: true,
      value: () => new Promise(() => {}),
      writable: true
    })
    Object.defineProperty(Dir.prototype, Symbol.asyncIterator, {
      configurable: true,
      value: () => { throw new Error('poisoned directory iterator') },
      writable: true
    })
    assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }), 42)
  } finally {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(Dir.prototype, name, descriptor)
      else delete Dir.prototype[name]
    }
  }

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('local-file deadlines use a captured clock', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())

  const originalNow = Date.now
  try {
    const options = new Proxy({ rootDirectory: files.directory, timeoutMs: 5_000 }, {
      ownKeys (target) {
        Date.now = () => { throw new Error('poisoned Date.now') }
        return Reflect.ownKeys(target)
      }
    })
    assert.equal(await runUntrustedFile(files.path('entry.mjs'), options), 42)
  } finally {
    Date.now = originalNow
  }

  assert.equal(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  }), 42)
})

test('descriptor cleanup uses captured atomic operations', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({
    'entry.mjs': 'export default ({ onMessage }) => onMessage(() => 42)'
  })
  t.after(() => files.cleanup())

  const originalCompareExchange = Atomics.compareExchange
  let session
  try {
    const options = new Proxy({ ...TIMEOUTS, rootDirectory: files.directory }, {
      ownKeys (target) {
        Atomics.compareExchange = () => { throw new Error('poisoned Atomics.compareExchange') }
        return Reflect.ownKeys(target)
      }
    })
    session = await createUntrustedWorkerFromFile(files.path('entry.mjs'), options)
    await session.ready
    assert.equal(await session.request(null), 42)
    await session.terminate()
    await session.closed
  } finally {
    Atomics.compareExchange = originalCompareExchange
    await session?.terminate().catch(() => {})
  }

  const replacement = await createUntrustedWorkerFromFile(files.path('entry.mjs'), {
    ...TIMEOUTS,
    rootDirectory: files.directory
  })
  await replacement.ready
  await replacement.terminate()
  await replacement.closed
})

test('descriptor quota ownership ignores poisoned Object.freeze', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const files = await fixture({
    'entry.mjs': `
      const descriptors = []
      export default ({ onMessage }) => onMessage(() => {
        const fs = process.getBuiltinModule('node:fs')
        while (descriptors.length < 64) {
          descriptors.push(fs.openSync(new URL(import.meta.url)))
        }
        return descriptors.length
      })
    `
  })
  t.after(() => files.cleanup())

  const originalFreeze = Object.freeze
  const sessions = []
  try {
    Object.freeze = (value) => {
      if (value && value.slotsBuffer instanceof SharedArrayBuffer &&
          typeof value.release === 'function') {
        value.release = () => {}
      }
      return originalFreeze(value)
    }
    for (let index = 0; index < 5; index++) {
      const session = await createUntrustedWorkerFromFile(files.path('entry.mjs'), {
        ...TIMEOUTS,
        rootDirectory: files.directory
      })
      sessions.push(session)
      await session.ready
      assert.equal(await session.request(null), 64)
      await session.terminate()
      await session.closed
    }
  } finally {
    Object.freeze = originalFreeze
    await Promise.all(sessions.map((session) => session.terminate().catch(() => {})))
  }
})

test('snapshots input and nested policies before asynchronous scanning', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      export default async input => ({
        input: input.value,
        environment: process.env.VALUE,
        host: await tools.value()
      })
    `
  })
  t.after(() => files.cleanup())
  const input = { value: 'before' }
  const environment = { VALUE: 'before' }
  const hostFunctions = { tools: { value: () => 'before' } }

  const result = runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    input,
    environment,
    hostFunctions,
    timeoutMs: 5_000
  })
  input.value = 'after'
  environment.VALUE = 'after'
  hostFunctions.tools.value = () => 'after'

  assert.deepEqual(await result, {
    input: 'before',
    environment: 'before',
    host: 'before'
  })
})

test('supports erase-only TypeScript module files', async (t) => {
  const files = await fixture({
    'entry.ts': `
      import { add } from './value.ts'
      export default (input: number): number => add(input, 2)
    `,
    'value.ts': 'export const add = (left: number, right: number): number => left + right'
  })
  t.after(() => files.cleanup())

  assert.equal(await runUntrustedFile(files.path('entry.ts'), {
    rootDirectory: files.directory,
    input: 40,
    timeoutMs: 5_000
  }), 42)
})

test('rejects TypeScript syntax that requires transformation', async (t) => {
  const files = await fixture({
    'entry.ts': 'enum Value { Answer = 42 }; export default () => Value.Answer'
  })
  t.after(() => files.cleanup())

  await assert.rejects(
    runUntrustedFile(files.path('entry.ts'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => error.remoteCode === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
  )
})

test('local module errors use virtual paths', async (t) => {
  const files = await fixture({
    'entry.mjs': "import './nested/failure.mjs'; export default () => 1",
    'nested/failure.mjs': "throw new Error('failure')"
  })
  t.after(() => files.cleanup())

  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => {
      assert.equal(error.remoteStack.includes(files.directory), false)
      assert.match(error.remoteStack, /secure-eval-worker-files\/nested\/failure\.mjs:1/)
      return true
    }
  )
})

test('stack bounds cannot expose a partial private staging path', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      export default () => {
        const privateRoot = new URL('.', import.meta.url).href
        const retainedPrefixLength = Math.max(1, Math.floor(privateRoot.length / 2))
        const fillerLength = 8192 - retainedPrefixLength
        const error = new Error('boundary')
        error.stack = 'x\\n'.repeat(Math.floor(fillerLength / 2)) +
          (fillerLength % 2 === 0 ? '' : 'x') + privateRoot
        throw error
      }
    `
  })
  t.after(() => files.cleanup())

  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => {
      assert.equal(error.remoteStack.includes(files.directory), false)
      assert.equal(error.remoteStack.includes('secure-eval-worker-modules-'), false)
      assert.equal(error.remoteStack.length < 8_192, true)
      return true
    }
  )
})

test('stages an immutable snapshot before guest execution', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      import { readFileSync } from 'node:fs'
      export default ({ onMessage }) => {
        onMessage(() => readFileSync(new URL('./value.txt', import.meta.url), 'utf8'))
      }
    `,
    'value.txt': 'before'
  })
  t.after(() => files.cleanup())

  const session = await createUntrustedWorkerFromFile(files.path('entry.mjs'), {
    ...TIMEOUTS,
    rootDirectory: files.directory
  })
  await session.ready
  await writeFile(files.path('value.txt'), 'after')
  assert.equal(await session.request(null), 'before')
  await session.terminate()
  await session.closed
})

test('removes private snapshots after worker exit', async (t) => {
  const files = await fixture({
    'one-shot.mjs': 'export default () => import.meta.url',
    'persistent.mjs': `
      export default ({ onMessage }) => onMessage(() => import.meta.url)
    `
  })
  t.after(() => files.cleanup())

  const oneShotUrl = await runUntrustedFile(files.path('one-shot.mjs'), {
    rootDirectory: files.directory,
    timeoutMs: 5_000
  })
  await assert.rejects(stat(fileURLToPath(oneShotUrl)), (error) => error.code === 'ENOENT')

  const session = await createUntrustedWorkerFromFile(files.path('persistent.mjs'), {
    ...TIMEOUTS,
    rootDirectory: files.directory
  })
  await session.ready
  const persistentUrl = await session.request(null)
  await session.terminate()
  await session.closed
  await assert.rejects(stat(fileURLToPath(persistentUrl)), (error) => error.code === 'ENOENT')
})

test('persistent cleanup settles while a stalled janitor retains preparation', async (t) => {
  const files = await fixture({
    'entry.mjs': `
      export default ({ onMessage }) => onMessage(() => 42)
    `
  })
  t.after(() => files.cleanup())
  let releaseWorkerCalls = 0
  let releasePreparationCalls = 0
  let resolveJanitor
  const janitor = new Promise((resolve) => { resolveJanitor = resolve })
  const rootPath = await realpath(files.directory)
  const rootPathPrefix = rootPath.endsWith(sep)
    ? rootPath
    : rootPath + sep
  const localModule = {
    entryUrl: pathToFileURL(join(rootPath, 'entry.mjs')).href,
    rootPath,
    rootPathPrefix,
    rootUrlPrefix: pathToFileURL(rootPathPrefix).href,
    cleanup: () => new Promise(() => {}),
    cleanupUntilRemoved: () => janitor
  }
  const session = createUntrustedFileSession(
    localModule,
    TIMEOUTS,
    false,
    () => { releaseWorkerCalls++ },
    () => { releasePreparationCalls++ }
  )
  await session.ready
  await session.terminate()
  const closed = await Promise.race([
    session.closed,
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 1_000))
  ])
  assert.notEqual(closed, 'stalled')
  assert.equal(closed.error.code, 'ERR_UNTRUSTED_WORKER_CLEANUP')
  assert.equal(releaseWorkerCalls, 1)
  assert.equal(releasePreparationCalls, 0)
  resolveJanitor()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(releasePreparationCalls, 1)
})

test('janitor rejection retains unresolved preparation ownership', async (t) => {
  const files = await fixture({
    'entry.mjs': 'export default ({ onMessage }) => onMessage(() => 42)'
  })
  t.after(() => files.cleanup())
  let releasePreparationCalls = 0
  const rootPath = await realpath(files.directory)
  const rootPathPrefix = rootPath.endsWith(sep)
    ? rootPath
    : rootPath + sep
  const localModule = {
    entryUrl: pathToFileURL(join(rootPath, 'entry.mjs')).href,
    rootPath,
    rootPathPrefix,
    rootUrlPrefix: pathToFileURL(rootPathPrefix).href,
    cleanup: () => new Promise(() => {}),
    cleanupUntilRemoved: () => Promise.reject(new Error('janitor failed'))
  }
  const session = createUntrustedFileSession(
    localModule,
    TIMEOUTS,
    false,
    () => {},
    () => { releasePreparationCalls++ }
  )
  await session.ready
  await session.terminate()
  await session.closed
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(releasePreparationCalls, 0)
})

test('surfaces snapshot cleanup failures under host permissions', {
  skip: process.platform === 'win32'
}, async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  const invalid = await fixture({ 'entry.mjs': 'export default () => 42' })
  await symlink('../outside', invalid.path('invalid-link'))
  const stagingBase = await mkdtemp(join(tmpdir(), 'secure-eval-worker-staging-test-'))
  const canonicalFiles = await realpath(files.directory)
  const canonicalInvalid = await realpath(invalid.directory)
  const canonicalStagingBase = await realpath(stagingBase)
  t.after(async () => {
    await Promise.all([
      files.cleanup(),
      invalid.cleanup(),
      rm(stagingBase, { force: true, recursive: true })
    ])
  })

  const childSource = `
    import { runUntrustedFile } from ${JSON.stringify(packageUrl)}
    const codes = []
    for (const [entry, root] of ${JSON.stringify([
      [join(canonicalFiles, 'entry.mjs'), canonicalFiles],
      [join(canonicalInvalid, 'entry.mjs'), canonicalInvalid]
    ])}) {
      try {
        await runUntrustedFile(entry, { rootDirectory: root, timeoutMs: 5000 })
      } catch (error) {
        codes.push(error.code)
      }
    }
    console.log(JSON.stringify(codes))
  `
  const { stdout } = await execFileAsync(process.execPath, [
    '--permission',
    '--allow-worker',
    `--allow-fs-read=${repositoryRoot}`,
    `--allow-fs-read=${canonicalFiles}`,
    `--allow-fs-read=${canonicalInvalid}`,
    `--allow-fs-write=${canonicalStagingBase}`,
    '--input-type=module',
    '--eval',
    childSource
  ], {
    env: { ...process.env, TMPDIR: canonicalStagingBase },
    timeout: 10_000
  })
  assert.deepEqual(JSON.parse(stdout), [
    'ERR_UNTRUSTED_CODE_CLEANUP',
    'ERR_UNTRUSTED_MODULE_CLEANUP'
  ])
  assert.equal((await readdir(stagingBase)).length, 2)
})

test('acquires admission before touching the module root or input', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const active = createUntrustedWorker('await new Promise(() => {})', TIMEOUTS)
  const ready = active.ready.catch(() => {})

  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  await symlink('../outside', files.path('invalid-link'))
  let inputReads = 0
  const input = Object.defineProperty({}, 'value', {
    enumerable: true,
    get () {
      inputReads++
      return 42
    }
  })

  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      input,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  await assert.rejects(
    createUntrustedWorkerFromFile(files.path('entry.mjs'), {
      ...TIMEOUTS,
      input,
      rootDirectory: files.directory
    }),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  let optionInspections = 0
  const uninspectableOptions = new Proxy({}, {
    ownKeys () {
      optionInspections++
      return []
    }
  })
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), uninspectableOptions),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  await assert.rejects(
    createUntrustedWorkerFromFile(files.path('entry.mjs'), uninspectableOptions),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  assert.equal(optionInspections, 0)
  assert.equal(inputReads, 0)

  await active.terminate()
  await ready
  await active.closed
})

test('preparation deadlines reject promptly without starving worker admission', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const sources = { 'entry.mjs': 'export default () => 42' }
  for (let index = 0; index < 100; index++) {
    sources[`modules/${index}.mjs`] = `export default ${index}`
  }
  const files = await fixture(sources)
  t.after(() => files.cleanup())

  const startedAt = Date.now()
  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 1
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_TIMEOUT'
  )
  assert.ok(Date.now() - startedAt < 1_000)
  assert.equal(await runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
  await waitForFilePreparation(files.path('entry.mjs'), files.directory)
})

test('cancellation stops preparation without starving worker admission', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const sources = { 'entry.mjs': 'export default () => 42' }
  for (let index = 0; index < 100; index++) {
    sources[`modules/${index}.mjs`] = `export default ${index}`
  }
  const files = await fixture(sources)
  t.after(() => files.cleanup())
  const controller = new AbortController()

  const execution = runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    signal: controller.signal,
    timeoutMs: 5_000
  })
  setImmediate(() => controller.abort('review-test'))
  await assert.rejects(execution, (error) => error.name === 'AbortError')
  assert.equal(await runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
  await waitForFilePreparation(files.path('entry.mjs'), files.directory)
})

test('cancellation is observed during POSIX backslash alias construction', {
  skip: process.platform === 'win32'
}, async (t) => {
  const files = await fixture({
    'nested\\entry.mjs': 'export default () => 42'
  })
  t.after(() => files.cleanup())
  const childSource = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const realLink = fs.link
    let controller
    fs.link = (...args) => {
      controller?.abort('alias-cancelled')
      return Reflect.apply(realLink, undefined, args)
    }
    syncBuiltinESMExports()
    const api = await import(${JSON.stringify(packageUrl)})
    fs.link = realLink
    syncBuiltinESMExports()
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    controller = new AbortController()
    let cancellation
    try {
      await api.runUntrustedFile(${JSON.stringify(files.path('nested\\entry.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        signal: controller.signal,
        timeoutMs: 5000
      })
      cancellation = 'resolved'
    } catch (error) {
      cancellation = error.name
    }
    controller = undefined
    const deadline = Date.now() + 5000
    let reused
    while (Date.now() < deadline) {
      try {
        reused = await api.runUntrustedFile(${JSON.stringify(files.path('nested\\entry.mjs'))}, {
          rootDirectory: ${JSON.stringify(files.directory)},
          timeoutMs: 5000
        })
        break
      } catch (error) {
        if (error.code !== 'ERR_UNTRUSTED_CODE_CAPACITY') throw error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    process.stdout.write(JSON.stringify({ cancellation, reused }))
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', childSource], {
    timeout: 12_000
  })
  assert.deepEqual(JSON.parse(stdout), { cancellation: 'AbortError', reused: 42 })
})

test('host worker threads fail before resolving local module paths', async () => {
  const childSource = `
    import { parentPort } from 'node:worker_threads'
    import { runUntrustedFile } from ${JSON.stringify(packageUrl)}
    try {
      await runUntrustedFile('/path/that/must/not/be-read.mjs')
      parentPort.postMessage({ result: 'started' })
    } catch (error) {
      parentPort.postMessage({ code: error.code })
    }
  `
  const child = new Worker(new URL(`data:text/javascript,${encodeURIComponent(childSource)}`), {
    type: 'module'
  })
  const result = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
  })
  assert.deepEqual(result, { code: 'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE' })
  await child.terminate()
})
