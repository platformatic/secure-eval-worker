import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  configureWorkerAdmission,
  createRunner,
  createUntrustedWorker,
  runUntrustedCode,
  UntrustedWorkerSession
} from '../src/index.js'

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
