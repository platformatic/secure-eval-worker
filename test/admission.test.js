import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

import {
  configureWorkerAdmission,
  createUntrustedWorker,
  runUntrustedCode
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
