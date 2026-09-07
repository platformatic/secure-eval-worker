import assert from 'node:assert/strict'
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  createUntrustedWorkerFromFile,
  runUntrustedFile
} from '../src/index.js'

const TIMEOUTS = {
  startupTimeoutMs: 5_000,
  messageTimeoutMs: 5_000,
  lifetimeTimeoutMs: 5_000
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
      import { readFileSync } from 'node:fs'
      export default (input) => {
        const local = readFileSync(new URL('./value.txt', import.meta.url), 'utf8')
        try {
          readFileSync(input.inheritedFd, 'utf8')
          return { local, inherited: 'read' }
        } catch (error) {
          return { local, inherited: { code: error.code, permission: error.permission } }
        }
      }
    `,
    'value.txt': 'trusted root value'
  })
  t.after(() => files.cleanup())
  const inherited = await open(files.path('value.txt'), 'r')
  t.after(() => inherited.close())

  assert.deepEqual(await runUntrustedFile(files.path('entry.mjs'), {
    rootDirectory: files.directory,
    input: { inheritedFd: inherited.fd },
    timeoutMs: 5_000
  }), {
    local: 'trusted root value',
    inherited: { code: 'ERR_ACCESS_DENIED', permission: 'SandboxEscape' }
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
    (error) => error.code === 'ERR_UNTRUSTED_MODULE_ROOT'
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
    (error) => error.code === 'ERR_UNTRUSTED_CODE' && error.remoteCode === 'ERR_ACCESS_DENIED'
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

test('host worker threads fail before resolving local module paths', async () => {
  const packageUrl = new URL('../src/index.js', import.meta.url).href
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
  assert.deepEqual(result, { code: 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE' })
  await child.terminate()
})
