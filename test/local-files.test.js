import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, open, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'

import {
  configureWorkerAdmission,
  createUntrustedWorker,
  createUntrustedWorkerFromFile,
  runUntrustedCode,
  runUntrustedFile
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const packageUrl = new URL('../src/index.js', import.meta.url).href
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

test('surfaces snapshot cleanup failures under host permissions', {
  skip: process.platform === 'win32'
}, async (t) => {
  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  const stagingBase = await mkdtemp(join(tmpdir(), 'secure-eval-worker-staging-test-'))
  t.after(async () => {
    await Promise.all([
      files.cleanup(),
      rm(stagingBase, { force: true, recursive: true })
    ])
  })

  const childSource = `
    import { runUntrustedFile } from ${JSON.stringify(packageUrl)}
    try {
      await runUntrustedFile(${JSON.stringify(files.path('entry.mjs'))}, {
        rootDirectory: ${JSON.stringify(files.directory)},
        timeoutMs: 5000
      })
    } catch (error) {
      console.log(error.code)
    }
  `
  const { stdout } = await execFileAsync(process.execPath, [
    '--permission',
    '--allow-worker',
    `--allow-fs-read=${repositoryRoot}`,
    `--allow-fs-read=${files.directory}`,
    `--allow-fs-write=${stagingBase}`,
    '--input-type=module',
    '--eval',
    childSource
  ], {
    env: { ...process.env, TMPDIR: stagingBase },
    timeout: 10_000
  })
  assert.equal(stdout.trim(), 'ERR_UNTRUSTED_CODE_CLEANUP')
  assert.equal((await readdir(stagingBase)).length, 1)
})

test('acquires admission before touching the module root', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const active = createUntrustedWorker('await new Promise(() => {})', TIMEOUTS)
  const ready = active.ready.catch(() => {})

  const files = await fixture({ 'entry.mjs': 'export default () => 42' })
  t.after(() => files.cleanup())
  await symlink('../outside', files.path('invalid-link'))

  await assert.rejects(
    runUntrustedFile(files.path('entry.mjs'), {
      rootDirectory: files.directory,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  await assert.rejects(
    createUntrustedWorkerFromFile(files.path('entry.mjs'), {
      ...TIMEOUTS,
      rootDirectory: files.directory
    }),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )

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
