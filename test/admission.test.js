import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'

import {
  configureWorkerAdmission,
  createRunner,
  createUntrustedWorker,
  runUntrustedCode,
  UntrustedWorkerSession
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const packageUrl = new URL('../src/index.js', import.meta.url).href
const legacyAdmissionStateUrl = new URL(
  '../fixtures/security/legacy-admission-state-v1.mjs',
  import.meta.url
).href

const SESSION_OPTIONS = {
  startupTimeoutMs: 5_000,
  messageTimeoutMs: 5_000,
  lifetimeTimeoutMs: 5_000
}

test('worker admission validates process-wide configuration', () => {
  assert.throws(() => configureWorkerAdmission(), /must be an object/)
  assert.throws(
    () => configureWorkerAdmission({ maxConcurrentWorkers: 0 }),
    /positive integer/
  )
  assert.throws(
    () => configureWorkerAdmission({ maxConcurrentWorkers: 1, extra: true }),
    /Unknown admission option/
  )
  const options = {}
  Object.defineProperty(options, 'maxConcurrentWorkers', {
    enumerable: true,
    get () { return 1 }
  })
  assert.throws(() => configureWorkerAdmission(options), /data property/)

  assert.deepEqual(
    configureWorkerAdmission({ maxConcurrentWorkers: 1 }),
    { maxConcurrentWorkers: 1, activeWorkers: 0 }
  )
})

test('admission rejects rather than queues and releases only after worker exit', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  const first = createUntrustedWorker('await new Promise(() => {})', SESSION_OPTIONS)

  assert.throws(
    () => createUntrustedWorker('', SESSION_OPTIONS),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  await assert.rejects(
    runUntrustedCode('return 42', { timeoutMs: 5_000 }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY' &&
      error.cause?.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )

  const readyRejection = assert.rejects(
    first.ready,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_TERMINATED'
  )
  const termination = first.terminate()
  assert.throws(
    () => createUntrustedWorker('', SESSION_OPTIONS),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  await termination
  await Promise.all([readyRejection, first.closed])

  const next = createUntrustedWorker('onMessage(value => value)', SESSION_OPTIONS)
  await next.ready
  assert.equal(await next.request(42), 42)
  await next.terminate()
})

test('capacity rejection occurs before inspecting input', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  const holder = createUntrustedWorker('onMessage(() => 1)', SESSION_OPTIONS)
  t.after(() => holder.terminate())
  await holder.ready

  let reads = 0
  const input = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get () {
      reads++
      return 42
    }
  })
  await assert.rejects(
    runUntrustedCode('return input', { input, timeoutMs: 5_000 }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  assert.throws(
    () => createUntrustedWorker('', { ...SESSION_OPTIONS, input }),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  assert.throws(
    () => new UntrustedWorkerSession('', { ...SESSION_OPTIONS, input }),
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
    runUntrustedCode('return 42', uninspectableOptions),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  const runner = createRunner({ timeoutMs: 5_000 })
  await assert.rejects(
    runner('return 42', uninspectableOptions),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  assert.throws(
    () => createUntrustedWorker('', uninspectableOptions),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  assert.throws(
    () => new UntrustedWorkerSession('', uninspectableOptions),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  let internalReads = 0
  const hostileInternalOptions = new Proxy({}, {
    get () {
      internalReads++
      return undefined
    }
  })
  assert.throws(
    () => new UntrustedWorkerSession('', SESSION_OPTIONS, hostileInternalOptions),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  assert.equal(optionInspections, 0)
  assert.equal(internalReads, 0)
  assert.equal(reads, 0)
  await holder.terminate()
})

test('subclass construction is rejected after admission without invoking accessors', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  let intercepted = 0
  class AccessorSession extends UntrustedWorkerSession {
    set _events (value) { intercepted++ }
    set _eventsCount (value) { intercepted++ }
    set _maxListeners (value) { intercepted++ }
    fail () { intercepted++ }
  }

  const holder = createUntrustedWorker('', SESSION_OPTIONS)
  await holder.ready
  assert.throws(
    () => new AccessorSession('', SESSION_OPTIONS),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  assert.equal(intercepted, 0)
  await holder.terminate()

  assert.throws(
    () => new AccessorSession('', SESSION_OPTIONS),
    /cannot be subclassed/
  )
  assert.equal(intercepted, 0)

  const next = createUntrustedWorker('', SESSION_OPTIONS)
  assert.throws(
    () => Object.defineProperty(next, 'terminate', { value: () => {} }),
    /Cannot redefine property/
  )
  await next.ready
  await next.terminate()
})

test('post-spawn setup resists poisoned worker lifecycle methods', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  const lifecycleNames = ['emit', 'once', 'removeAllListeners']
  const originalDescriptors = lifecycleNames.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(Worker.prototype, name)
  ])
  let session
  try {
    const options = new Proxy(SESSION_OPTIONS, {
      ownKeys (target) {
        Worker.prototype.emit = () => false
        Worker.prototype.once = () => { throw new Error('poisoned Worker.once') }
        Worker.prototype.removeAllListeners = () => {
          throw new Error('poisoned Worker.removeAllListeners')
        }
        return Reflect.ownKeys(target)
      }
    })
    session = createUntrustedWorker('onMessage(value => value)', options)
    await session.ready
    assert.equal(await session.request(42), 42)
    await session.terminate()
    await session.closed
  } finally {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(Worker.prototype, name, descriptor)
      else delete Worker.prototype[name]
    }
    await session?.terminate().catch(() => {})
  }

  const replacement = createUntrustedWorker('', SESSION_OPTIONS)
  await replacement.ready
  await replacement.terminate()
  await replacement.closed
})

test('first post-spawn listener failure is bounded and failure-atomic', async () => {
  const childSource = `
    const fs = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await fs.mkdtemp(join(tmpdir(), 'secure-eval-listener-root-'))
    const staging = await fs.mkdtemp(join(tmpdir(), 'secure-eval-listener-stage-'))
    process.env.TEMP = staging
    process.env.TMP = staging
    process.env.TMPDIR = staging
    await fs.writeFile(join(root, 'entry.mjs'), 'export default () => 42')
    const unhandled = []
    process.on('uncaughtException', error => unhandled.push(String(error)))
    process.on('unhandledRejection', error => unhandled.push(String(error)))
    const { EventEmitter } = await import('node:events')
    const originalOn = EventEmitter.prototype.on
    EventEmitter.prototype.on = function (...args) {
      const stack = new Error().stack ?? ''
      if (args[0] === 'exit' && !stack.includes('trustedWorkerOn')) {
        throw new Error('listener setup failure')
      }
      return Reflect.apply(originalOn, this, args)
    }
    const api = await import(${JSON.stringify(packageUrl)})
    const admission = await import(${JSON.stringify(new URL('../src/admission.js', import.meta.url).href)})
    EventEmitter.prototype.on = originalOn
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const codes = []
    let lifecycleMessage
    let lifecycleCause
    const session = api.createUntrustedWorker('', {
      startupTimeoutMs: 5000,
      messageTimeoutMs: 5000,
      lifetimeTimeoutMs: 5000
    })
    session.on('exit', () => { throw new Error('throwing fallback exit listener') })
    try {
      await session.ready
    } catch (error) {
      codes.push(error.code ?? error.name)
      lifecycleMessage = error.message
      lifecycleCause = error.cause?.message
    }
    const termination = await session.terminate().then(
      () => 'resolved',
      error => error.code ?? error.name
    )
    const closedCode = (await session.closed).error?.code ?? null
    try {
      await api.runUntrustedCode('return 42', { timeoutMs: 5000 })
    } catch (error) { codes.push(error.code ?? error.name) }
    try {
      await api.runUntrustedFile(join(root, 'entry.mjs'), {
        rootDirectory: root,
        timeoutMs: 5000
      })
    } catch (error) { codes.push(error.code ?? error.name) }
    await new Promise(resolve => setTimeout(resolve, 100))
    const snapshots = await fs.readdir(staging)
    console.log(JSON.stringify({
      codes,
      termination,
      closedCode,
      lifecycleMessage,
      lifecycleCause,
      activeWorkers: admission.getWorkerAdmissionStatus().activeWorkers,
      snapshots,
      unhandled
    }))
    await fs.rm(root, { force: true, recursive: true })
    await fs.rm(staging, { force: true, recursive: true })
  `
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource
  ], { timeout: 20_000 })
  const result = JSON.parse(stdout)
  assert.deepEqual(result.codes, [
    'ERR_UNTRUSTED_WORKER',
    'ERR_UNTRUSTED_CODE_WORKER',
    'ERR_UNTRUSTED_CODE_WORKER'
  ])
  assert.equal(result.termination, 'resolved')
  assert.equal(result.closedCode, 'ERR_UNTRUSTED_WORKER')
  assert.equal(result.lifecycleMessage, 'The worker exit lifecycle could not be observed')
  assert.equal(result.lifecycleCause, 'listener setup failure')
  assert.equal(result.activeWorkers, 0)
  assert.deepEqual(result.snapshots, [])
  assert.deepEqual(result.unhandled, [])
})

test('worker constructor failures release admission', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  let hook
  try {
    const options = new Proxy(SESSION_OPTIONS, {
      ownKeys (target) {
        if (!hook) {
          hook = createHook({
            init (asyncId, type, triggerAsyncId, resource) {
              if (type === 'WORKER') Object.preventExtensions(resource)
            }
          })
          hook.enable()
        }
        return Reflect.ownKeys(target)
      }
    })
    assert.throws(
      () => createUntrustedWorker('onMessage(value => value)', options),
      /object is not extensible/
    )
    hook.disable()
  } finally {
    hook?.disable()
  }

  const replacement = createUntrustedWorker('', SESSION_OPTIONS)
  await replacement.ready
  await replacement.terminate()
  await replacement.closed
})

test('physical package copies share process-wide admission', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  const temporary = await mkdtemp(join(tmpdir(), 'secure-eval-worker-copy-'))
  const copyRoot = join(temporary, 'copy')
  await mkdir(copyRoot)
  await cp(new URL('../src', import.meta.url), join(copyRoot, 'src'), { recursive: true })
  await writeFile(join(copyRoot, 'package.json'), '{"type":"module"}')
  t.after(() => rm(temporary, { force: true, recursive: true }))
  const copy = await import(pathToFileURL(join(copyRoot, 'src/index.js')).href)

  const holder = createUntrustedWorker('onMessage(() => 1)', SESSION_OPTIONS)
  t.after(() => holder.terminate())
  await holder.ready
  await assert.rejects(
    copy.runUntrustedCode('return 42', { timeoutMs: 5_000 }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_CAPACITY'
  )
  await holder.terminate()
  assert.equal(await copy.runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
})

test('legacy-first worker and preparation controllers preserve repeated lifecycle settlement', async () => {
  const childSource = `
    const { installLegacyAdmissionStateV1 } = await import(
      ${JSON.stringify(legacyAdmissionStateUrl)}
    )
    installLegacyAdmissionStateV1()
    const fs = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await fs.mkdtemp(join(tmpdir(), 'secure-eval-legacy-controller-root-'))
    const staging = await fs.mkdtemp(join(tmpdir(), 'secure-eval-legacy-controller-stage-'))
    process.env.TEMP = staging
    process.env.TMP = staging
    process.env.TMPDIR = staging
    await fs.writeFile(join(root, 'entry.mjs'), 'export default input => input')
    const api = await import(${JSON.stringify(packageUrl)})
    const admission = await import(${JSON.stringify(new URL('../src/admission.js', import.meta.url).href)})
    api.configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const source = [
      await api.runUntrustedCode('return input', { input: 40, timeoutMs: 5000 }),
      await api.runUntrustedCode('return input', { input: 41, timeoutMs: 5000 })
    ]
    const local = [
      await api.runUntrustedFile(join(root, 'entry.mjs'), {
        rootDirectory: root,
        input: 42,
        timeoutMs: 5000
      }),
      await api.runUntrustedFile(join(root, 'entry.mjs'), {
        rootDirectory: root,
        input: 43,
        timeoutMs: 5000
      })
    ]
    const snapshots = await fs.readdir(staging)
    console.log(JSON.stringify({
      source,
      local,
      status: admission.getWorkerAdmissionStatus(),
      snapshots
    }))
    await fs.rm(root, { force: true, recursive: true })
    await fs.rm(staging, { force: true, recursive: true })
  `
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource
  ], { timeout: 20_000 })
  assert.deepEqual(JSON.parse(stdout), {
    source: [40, 41],
    local: [42, 43],
    status: { maxConcurrentWorkers: 1, activeWorkers: 0 },
    snapshots: []
  })
})

test('malformed process-global admission controllers fail closed before caller metadata', async () => {
  const validWorkerState = `Object.freeze({
    acquire () { return () => {} },
    configure (maxConcurrentWorkers) {
      return Object.freeze({ maxConcurrentWorkers, activeWorkers: 0 })
    },
    status () { return Object.freeze({ maxConcurrentWorkers: 1, activeWorkers: 0 }) }
  })`
  const validPreparationState = `Object.freeze({
    acquire () { return () => {} },
    configure () {}
  })`
  const cases = [
    {
      worker: `Object.freeze({
        acquire () { return undefined },
        configure (maxConcurrentWorkers) {
          return Object.freeze({ maxConcurrentWorkers, activeWorkers: 0 })
        },
        status () { return Object.freeze({ maxConcurrentWorkers: 1, activeWorkers: 0 }) }
      })`,
      preparation: validPreparationState
    },
    {
      worker: `({
        acquire () { return () => {} },
        configure () {},
        status () { return { maxConcurrentWorkers: 1, activeWorkers: 0 } }
      })`,
      preparation: validPreparationState
    },
    {
      worker: validWorkerState,
      preparation: `({ acquire () { return () => {} }, configure () {} })`
    }
  ]

  for (const entry of cases) {
    const childSource = `
      Object.defineProperty(
        globalThis,
        Symbol.for('secure-eval-worker.admission.main.v1'),
        { value: ${entry.worker} }
      )
      Object.defineProperty(
        globalThis,
        Symbol.for('secure-eval-worker.admission.preparation.main.v1'),
        { value: ${entry.preparation} }
      )
      const api = await import(${JSON.stringify(packageUrl)})
      let sourceCode
      let fileCode
      let reads = 0
      try {
        await api.runUntrustedCode('return 42', { timeoutMs: 100 })
      } catch (error) { sourceCode = error.code }
      const options = { timeoutMs: 100 }
      Object.defineProperty(options, 'rootDirectory', {
        enumerable: true,
        get () { reads++; return '/unreachable' }
      })
      try {
        await api.runUntrustedFile('/unreachable/entry.mjs', options)
      } catch (error) { fileCode = error.code }
      console.log(JSON.stringify({ sourceCode, fileCode, reads }))
    `
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      childSource
    ], { timeout: 10_000 })
    assert.deepEqual(JSON.parse(stdout), {
      sourceCode: 'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE',
      fileCode: 'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE',
      reads: 0
    })
  }
})

test('host worker threads fail closed instead of orphaning admission slots', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  const packageUrl = new URL('../src/index.js', import.meta.url).href
  const childSource = `
    import { parentPort } from 'node:worker_threads'
    import { runUntrustedCode } from ${JSON.stringify(packageUrl)}
    try {
      await runUntrustedCode('return 42', { timeoutMs: 5000 })
      parentPort.postMessage({ result: 'started' })
    } catch (error) {
      parentPort.postMessage({ code: error.code, causeCode: error.cause?.code })
    }
  `
  const child = new Worker(new URL(`data:text/javascript,${encodeURIComponent(childSource)}`), {
    type: 'module'
  })
  const result = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
  })
  assert.deepEqual(result, {
    code: 'ERR_UNTRUSTED_CODE_ADMISSION_UNAVAILABLE',
    causeCode: 'ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE'
  })
  await child.terminate()

  const session = createUntrustedWorker('', SESSION_OPTIONS)
  await session.ready
  await session.terminate()
})

test('lowering admission does not terminate active workers', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 2 })
  const first = createUntrustedWorker('onMessage(() => 1)', SESSION_OPTIONS)
  const second = createUntrustedWorker('onMessage(() => 2)', SESSION_OPTIONS)
  await Promise.all([first.ready, second.ready])

  assert.deepEqual(
    configureWorkerAdmission({ maxConcurrentWorkers: 1 }),
    { maxConcurrentWorkers: 1, activeWorkers: 2 }
  )
  assert.equal(await first.request(null), 1)
  assert.equal(await second.request(null), 2)
  assert.throws(
    () => createUntrustedWorker('', SESSION_OPTIONS),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )

  await first.terminate()
  await first.closed
  assert.throws(
    () => createUntrustedWorker('', SESSION_OPTIONS),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CAPACITY'
  )
  await second.terminate()
  await second.closed

  const replacement = createUntrustedWorker('', SESSION_OPTIONS)
  await replacement.ready
  await replacement.terminate()
})

test('startup failures and cancellation release admission slots', async () => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  const failed = createUntrustedWorker('throw new Error("startup")', SESSION_OPTIONS)
  await assert.rejects(failed.ready, /startup/)
  await failed.closed

  const controller = new AbortController()
  const cancelled = createUntrustedWorker('await new Promise(() => {})', {
    ...SESSION_OPTIONS,
    signal: controller.signal
  })
  controller.abort('test')
  await assert.rejects(cancelled.ready, (error) => error.name === 'AbortError')
  await cancelled.closed

  assert.equal(await runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
})

test.after(() => {
  configureWorkerAdmission({ maxConcurrentWorkers: 4 })
})
