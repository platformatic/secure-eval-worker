import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createUntrustedWorker, runUntrustedCode } from '../src/index.js'

const SESSION_OPTIONS = {
  startupTimeoutMs: 5_000,
  messageTimeoutMs: 5_000,
  lifetimeTimeoutMs: 5_000
}

test('diagnostics are discarded by default', async () => {
  const result = await runUntrustedCode('console.log("discarded"); return 42', {
    timeoutMs: 5_000
  })
  assert.equal(result, 42)
})

test('one-shot diagnostics are bounded, sanitized records', async () => {
  const records = []
  const value = await runUntrustedCode(`
    console.log('hello', 42, { secret: 'not inspected' })
    console.warn('line\\nnext\\u001b[31m')
    return 'done'
  `, {
    diagnostics: true,
    onDiagnostic: (record) => records.push(record),
    timeoutMs: 5_000
  })

  assert.equal(value, 'done')
  assert.deepEqual(records, [
    { level: 'log', text: 'hello 42 [Object]' },
    { level: 'warn', text: 'line\\u000anext\\u001b[31m' }
  ])
  assert.equal(Object.isFrozen(records[0]), true)
})

test('async one-shot diagnostic callbacks settle before the result', async () => {
  let callbackSettled = false
  const value = await runUntrustedCode('console.log("wait"); return 42', {
    diagnostics: true,
    async onDiagnostic () {
      await new Promise((resolve) => setTimeout(resolve, 20))
      callbackSettled = true
    },
    timeoutMs: 5_000
  })
  assert.equal(value, 42)
  assert.equal(callbackSettled, true)

  await assert.rejects(
    runUntrustedCode('console.log("reject"); return 42', {
      diagnostics: true,
      async onDiagnostic () {
        await Promise.resolve()
        throw new Error('async callback failure')
      },
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_DIAGNOSTIC_CALLBACK' &&
      error.cause?.code === 'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_CALLBACK'
  )
})

test('diagnostic formatting does not invoke object properties', async () => {
  const records = []
  const value = await runUntrustedCode(`
    let reads = 0
    const value = {}
    Object.defineProperty(value, 'secret', {
      get () { reads++; throw new Error('getter executed') }
    })
    console.log(value)
    return reads
  `, {
    diagnostics: true,
    onDiagnostic: (record) => records.push(record),
    timeoutMs: 5_000
  })
  assert.equal(value, 0)
  assert.deepEqual(records, [{ level: 'log', text: '[Object]' }])

  const revokedRecords = []
  assert.equal(await runUntrustedCode(`
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    console.log(proxy)
    return 'alive'
  `, {
    diagnostics: true,
    onDiagnostic: (record) => revokedRecords.push(record),
    timeoutMs: 5_000
  }), 'alive')
  assert.deepEqual(revokedRecords, [{ level: 'log', text: '[Uninspectable]' }])
})

test('persistent diagnostics use a distinct event and stop at worker-side limits', async () => {
  const session = createUntrustedWorker(`
    console.info('startup')
    onMessage((value) => {
      console.log(value)
      console.log('dropped')
      return 'still running'
    })
  `, {
    ...SESSION_OPTIONS,
    diagnostics: { maxRecords: 2, maxBytes: 1024, maxRecordBytes: 256 }
  })
  const records = []
  session.on('diagnostic', (record) => records.push(record))
  await session.ready
  assert.equal(await session.request('message'), 'still running')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(records, [
    { level: 'info', text: 'startup' },
    { level: 'log', text: 'message' }
  ])
  await session.terminate()
})

test('request responses wait for earlier asynchronous diagnostics', async () => {
  let callbackSettled = false
  const session = createUntrustedWorker(`
    onMessage(() => {
      console.log('before response')
      return 42
    })
  `, {
    ...SESSION_OPTIONS,
    diagnostics: true,
    async onDiagnostic () {
      await new Promise((resolve) => setTimeout(resolve, 20))
      callbackSettled = true
    }
  })
  await session.ready
  assert.equal(await session.request(null), 42)
  assert.equal(callbackSettled, true)
  await session.terminate()
})

test('diagnostic callbacks reject same-session reentrant requests', async () => {
  let session
  let observedCode
  session = createUntrustedWorker(`
    onMessage(() => {
      console.log('diagnostic')
      return 42
    })
  `, {
    ...SESSION_OPTIONS,
    diagnostics: true,
    onDiagnostic () {
      assert.throws(
        () => session.request(null),
        (error) => {
          observedCode = error.code
          return error.code === 'ERR_UNTRUSTED_WORKER_REENTRANT_DIAGNOSTIC'
        }
      )
    }
  })
  await session.ready
  assert.equal(await session.request(null), 42)
  assert.equal(observedCode, 'ERR_UNTRUSTED_WORKER_REENTRANT_DIAGNOSTIC')
  await session.terminate()
})

test('a throwing diagnostic callback fails without an unhandled exception', async () => {
  const session = createUntrustedWorker(`
    console.log('trigger')
    await new Promise(() => {})
  `, {
    ...SESSION_OPTIONS,
    diagnostics: true,
    onDiagnostic () {
      throw new Error('callback failure')
    }
  })
  session.on('error', () => {})
  await assert.rejects(
    session.ready,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_CALLBACK'
  )
  const closed = await session.closed
  assert.equal(closed.error.code, 'ERR_UNTRUSTED_WORKER_DIAGNOSTIC_CALLBACK')
})

test('diagnostic options reject accessors and inconsistent limits', () => {
  const diagnostics = {}
  Object.defineProperty(diagnostics, 'maxRecords', {
    enumerable: true,
    get () { throw new Error('accessed') }
  })
  assert.throws(
    () => createUntrustedWorker('', { diagnostics }),
    /data property/
  )
  assert.throws(
    () => createUntrustedWorker('', {
      diagnostics: { maxBytes: 128, maxRecordBytes: 256 }
    }),
    /must not exceed/
  )
  assert.throws(
    () => createUntrustedWorker('', { diagnostics: false, onDiagnostic () {} }),
    /cannot be used/
  )
})
