import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

import {
  createUntrustedWorker,
  UntrustedCodeError,
  UntrustedWorkerSession
} from '../src/index.js'

const SCRIPT_COMPONENT = `
  send({ type: 'started', input })
  onMessage(async (message) => {
    send({ type: 'observed', message })
    return { echo: message }
  })
`

const MODULE_COMPONENT = `
  export default async function setup ({ input, send, onMessage }) {
    send({ type: 'started', input })
    onMessage(async (message) => {
      send({ type: 'observed', message })
      return { echo: message }
    })
  }
`

for (const [type, source] of [
  ['script', SCRIPT_COMPONENT],
  ['module', MODULE_COMPONENT]
]) {
  test(`${type} components support bidirectional messaging`, async () => {
    const session = createUntrustedWorker(source, {
      type,
      input: 42,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    assert.ok(session instanceof UntrustedWorkerSession)

    const started = once(session, 'message')
    await session.ready
    assert.deepEqual((await started)[0], { type: 'started', input: 42 })

    const observedRequest = once(session, 'message')
    assert.deepEqual(await session.request('request'), { echo: 'request' })
    assert.deepEqual((await observedRequest)[0], {
      type: 'observed',
      message: 'request'
    })

    const observedPost = once(session, 'message')
    session.postMessage('post')
    assert.deepEqual((await observedPost)[0], {
      type: 'observed',
      message: 'post'
    })

    await session.terminate()
    assert.equal(session.state, 'closed')
  })
}

test('persistent setup return values are ignored', async () => {
  for (const [type, source] of [
    ['script', 'return () => {}'],
    ['module', 'export default () => () => {}']
  ]) {
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    assert.equal(await session.ready, undefined)
    await session.terminate()
  }
})

test('module evaluation and handlers run after permissions are dropped', async () => {
  const session = createUntrustedWorker(`
    const initialPermissions = {
      worker: process.permission.has('worker'),
      read: process.permission.has('fs.read'),
      write: process.permission.has('fs.write'),
      child: process.permission.has('child'),
      network: process.permission.has('net')
    }

    export default ({ onMessage }) => {
      onMessage(() => ({
        initialPermissions,
        handlerWorkerPermission: process.permission.has('worker')
      }))
    }
  `, {
    type: 'module',
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.deepEqual(await session.request('permissions'), {
    initialPermissions: {
      worker: false,
      read: false,
      write: false,
      child: false,
      network: false
    },
    handlerWorkerPermission: false
  })
  await session.terminate()
})

test('sessions use an explicit sanitized environment', async () => {
  process.env.SECURE_EVAL_WORKER_SESSION_SECRET = 'hidden'
  try {
    const session = createUntrustedWorker(`
      onMessage(() => ({
        secret: process.env.SECURE_EVAL_WORKER_SESSION_SECRET,
        publicValue: process.env.PUBLIC_VALUE,
        names: Object.keys(process.env).sort()
      }))
    `, {
      environment: { PUBLIC_VALUE: 'visible' },
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.deepEqual(await session.request(null), {
      secret: undefined,
      publicValue: 'visible',
      names: ['PUBLIC_VALUE']
    })
    await session.terminate()
  } finally {
    delete process.env.SECURE_EVAL_WORKER_SESSION_SECRET
  }
})

test('does not expose the private session protocol through parentPort', async () => {
  const session = createUntrustedWorker(`
    const { parentPort } = await import('node:worker_threads')
    if (parentPort !== null) throw new Error('parentPort is exposed')
    onMessage((message) => 'real:' + message)
  `, {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.equal(await session.request('value'), 'real:value')
  await session.terminate()
})

for (const type of ['script', 'module']) {
  test(`${type} source cannot resolve trusted bootstrap bindings`, async () => {
    const probe = `({
      port: typeof port,
      postToHost: typeof postToHost,
      protocolSecret: typeof protocolSecret,
      workerData: typeof workerData,
      processBuiltin: typeof processBuiltin,
      workerThreadsBuiltin: typeof workerThreadsBuiltin,
      hardenDangerousBuiltins: typeof hardenDangerousBuiltins
    })`
    const source = type === 'script'
      ? `if (typeof postToHost === 'function') postToHost({ type: 'ready', value: 'spoofed' }); onMessage(() => ${probe})`
      : `export default ({ onMessage }) => { if (typeof postToHost === 'function') postToHost({ type: 'ready', value: 'spoofed' }); onMessage(() => ${probe}) }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.deepEqual(await session.request(null), {
      port: 'undefined',
      postToHost: 'undefined',
      protocolSecret: 'undefined',
      workerData: 'undefined',
      processBuiltin: 'undefined',
      workerThreadsBuiltin: 'undefined',
      hardenDangerousBuiltins: 'undefined'
    })
    await session.terminate()
  })

  test(`${type} source cannot discover the private port through async hooks`, async () => {
    const probe = `
      let result
      try {
        const asyncHooks = await import('node:async_hooks')
        asyncHooks.createHook({ before () {
          asyncHooks.executionAsyncResource()
        } }).enable()
        result = 'exposed'
      } catch (error) {
        result = error.code
      }
      onMessage(() => result)
    `
    const source = type === 'script'
      ? probe
      : `export default async ({ onMessage }) => { ${probe} }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.equal(await session.request(null), 'ERR_ACCESS_DENIED')
    await session.terminate()
  })

  test(`${type} source cannot find the private port through active handles`, async () => {
    const attack = `
      for (const handle of process._getActiveHandles()) {
        if (handle?.constructor?.name === 'MessagePort') {
          handle.postMessage({ type: 'response', id: 1, value: 'spoofed' })
        }
      }
    `
    const source = type === 'script'
      ? `${attack}\nonMessage(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return 'real' })`
      : `${attack}\nexport default ({ onMessage }) => { onMessage(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return 'real' }) }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.equal(await session.request('value'), 'real')
    await session.terminate()
  })

  test(`${type} source cannot capture the private protocol port`, async () => {
    const setup = `
      const { MessagePort } = await import('node:worker_threads')
      const originalPostMessage = MessagePort.prototype.postMessage
      let capturedPort
      try {
        MessagePort.prototype.postMessage = function (...args) {
          capturedPort = this
          return originalPostMessage.apply(this, args)
        }
      } catch {}
      setInterval(() => {
        if (capturedPort) {
          originalPostMessage.call(capturedPort, {
            type: 'response',
            id: 1,
            value: 'spoofed'
          })
        }
      }, 1)
    `
    const source = type === 'script'
      ? `${setup}\nonMessage(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return 'real' })`
      : `${setup}\nexport default ({ onMessage }) => { onMessage(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return 'real' }) }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.equal(await session.request('value'), 'real')
    await session.terminate()
  })
}

for (const type of ['script', 'module']) {
  test(`${type} source cannot intercept or authenticate the protocol port`, async () => {
    const attack = `
      const { MessagePort } = await import('node:worker_threads')
      const originalPostMessage = MessagePort.prototype.postMessage
      let capturedPort
      let prototype = MessagePort.prototype
      while (prototype) {
        for (const symbol of Object.getOwnPropertySymbols(prototype)) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, symbol)
          if (typeof descriptor?.value === 'function' && descriptor.writable) {
            const original = descriptor.value
            prototype[symbol] = function (...args) {
              capturedPort = this
              return original.apply(this, args)
            }
          }
        }
        prototype = Object.getPrototypeOf(prototype)
      }
      setInterval(() => {
        if (capturedPort) {
          originalPostMessage.call(capturedPort, {
            type: 'response', id: 1, value: 'spoofed'
          })
        }
      }, 1)
    `
    const source = type === 'script'
      ? `${attack}\nonMessage(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return 'real' })`
      : `${attack}\nexport default ({ onMessage }) => { onMessage(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return 'real' }) }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.equal(await session.request('value'), 'real')
    await session.terminate()
  })

  test(`${type} source cannot poison bootstrap promise handling`, async () => {
    const poison = `
      Promise.prototype.then = function () { return new Promise(() => {}) }
      Promise.prototype.catch = function () { return this }
    `
    const source = type === 'script'
      ? `${poison}\nonMessage(() => 'real')`
      : `${poison}\nexport default ({ onMessage }) => { onMessage(() => 'real') }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await session.ready
    assert.equal(await session.request('value'), 'real')
    await session.terminate()
  })

  test(`${type} startup errors survive Promise.prototype poisoning`, async () => {
    const poisonAndThrow = `
      Promise.prototype.catch = function () { return this }
      throw new TypeError('poisoned startup')
    `
    const source = type === 'script'
      ? poisonAndThrow
      : `export default () => { ${poisonAndThrow} }`
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    await assert.rejects(session.ready, /TypeError: poisoned startup/)
    await session.closed
  })
}

test('persistent runtime errors use stable guest filenames without bootstrap frames', async () => {
  for (const [type, source, expected] of [
    ['script', `const value = 1
throw new Error('script location')`, /secure-eval-worker-component\.js:2:7/],
    ['module', `const value = 1
throw new Error('module location')`, /secure-eval-worker-component\.mjs:2:7/]
  ]) {
    const session = createUntrustedWorker(source, {
      type,
      startupTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    await assert.rejects(session.ready, (error) => {
      assert.match(error.remoteStack, expected)
      assert.doesNotMatch(error.remoteStack, /worker eval|trustedBootstrap|data:text/)
      return true
    })
    await session.closed
  }
})

test('module and script startup errors reject ready', async (t) => {
  const cases = [
    ['script syntax', 'const value = ;', 'script', /SyntaxError/, /secure-eval-worker-component\.syntax\.js:1/],
    ['module syntax', 'export default {', 'module', /SyntaxError/, /secure-eval-worker-component\.syntax\.mjs:1/],
    ['module contract', 'export default 42', 'module', /default export must be a setup function/, undefined]
  ]

  for (const [name, source, type, expected, expectedStack] of cases) {
    await t.test(name, async () => {
      const session = createUntrustedWorker(source, {
        type,
        startupTimeoutMs: 5_000,
        lifetimeTimeoutMs: 5_000
      })
      await assert.rejects(session.ready, (error) => {
        assert.match(error.message, expected)
        if (expectedStack) assert.match(error.remoteStack, expectedStack)
        return true
      })
      await session.closed
    })
  }
})

test('unexpected exit closes before invoking error listeners', async () => {
  const session = createUntrustedWorker('process.exit(0)', {
    startupTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  let reentrantError
  session.on('error', () => {
    try {
      session.request('too late')
    } catch (error) {
      reentrantError = error
    }
  })

  await assert.rejects(
    session.ready,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_EXIT'
  )
  const closed = await session.closed
  assert.equal(reentrantError.code, 'ERR_UNTRUSTED_WORKER_EXIT')
  assert.equal(closed.error.code, 'ERR_UNTRUSTED_WORKER_EXIT')
})

test('small protocol budgets retain a bounded fatal error path', async () => {
  const session = createUntrustedWorker("throw new Error('x'.repeat(10_000))", {
    maxMessageBytes: 128,
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await assert.rejects(session.ready, /Worker protocol failure/)
  await session.closed
})

test('hostile thrown proxies cannot break trusted error serialization', async () => {
  const session = createUntrustedWorker(`
    onMessage((message) => {
      if (message === 'throw') {
        const proxy = new Proxy({}, {
          get () { throw proxy },
          getPrototypeOf () { throw proxy }
        })
        throw proxy
      }
      return 'still running'
    })
  `, {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  await assert.rejects(session.request('throw'), /Untrusted component/)
  assert.equal(await session.request('continue'), 'still running')
  await session.terminate()
})

test('request handler errors only reject the corresponding request', async () => {
  const session = createUntrustedWorker(`
    onMessage((message) => {
      if (message === 'bad') throw new TypeError('bad message')
      return message
    })
  `, {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  await assert.rejects(session.request('bad'), /TypeError: bad message/)
  assert.equal(await session.request('good'), 'good')
  await session.terminate()
})

test('startup timeout terminates hanging scripts and modules', async (t) => {
  const cases = [
    ['script', 'await new Promise(() => {})'],
    ['module', 'await new Promise(() => {}); export default () => {}']
  ]

  for (const [type, source] of cases) {
    await t.test(type, async () => {
      const session = createUntrustedWorker(source, {
        type,
        startupTimeoutMs: 100,
        lifetimeTimeoutMs: 5_000
      })
      await assert.rejects(
        session.ready,
        (error) => error.code === 'ERR_UNTRUSTED_WORKER_STARTUP_TIMEOUT'
      )
      await session.closed
    })
  }
})

test('request options ignore inherited deadlines and reject accessors', async () => {
  const session = createUntrustedWorker(`
    onMessage(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return 42
    })
  `, {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 20,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready

  const inherited = Object.create({ timeoutMs: 5_000 })
  await assert.rejects(
    session.request(null, inherited),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
  )
  await session.closed

  const next = createUntrustedWorker('onMessage(value => value)', {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await next.ready
  let reads = 0
  const accessor = {}
  Object.defineProperty(accessor, 'timeoutMs', {
    enumerable: true,
    get () {
      reads++
      return 5_000
    }
  })
  assert.throws(() => next.request(null, accessor), /enumerable data property/)
  assert.equal(reads, 0)
  await next.terminate()
})

test('request deadlines include synchronous cloning and serialization', async () => {
  const session = createUntrustedWorker('onMessage(value => value)', {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  const value = {
    get slow () {
      const end = Date.now() + 50
      while (Date.now() < end) {}
      return 42
    }
  }

  await assert.rejects(
    session.request(value, { timeoutMs: 10 }),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
  )
  await session.closed
})

test('postMessage rechecks session state after cloning', async () => {
  const session = createUntrustedWorker('onMessage(() => null)', {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready

  assert.throws(
    () => session.postMessage({
      get value () {
        void session.terminate()
        return 42
      }
    }),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_CLOSED'
  )
  await session.closed
})

test('message timeout terminates a hanging handler and rejects pending requests', async () => {
  const session = createUntrustedWorker(`
    onMessage((message) => {
      if (message === 'hang') while (true) {}
      return message
    })
  `, {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 100,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  const hanging = session.request('hang')
  const pending = session.request('queued')
  await assert.rejects(
    hanging,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
  )
  await assert.rejects(
    pending,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_MESSAGE_TIMEOUT'
  )
  await session.closed
})

test('lifetime timeout terminates an otherwise idle session', async () => {
  const session = createUntrustedWorker('onMessage((message) => message)', {
    startupTimeoutMs: 5_000,
    lifetimeTimeoutMs: 100
  })
  await session.ready
  const [error] = await Promise.all([
    new Promise((resolve) => session.once('error', resolve)),
    session.closed
  ])
  assert.equal(error.code, 'ERR_UNTRUSTED_WORKER_LIFETIME_TIMEOUT')
})

test('an AbortSignal terminates a session', async () => {
  const controller = new AbortController()
  const session = createUntrustedWorker('await new Promise(() => {})', {
    signal: controller.signal,
    startupTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  controller.abort('test')
  await assert.rejects(session.ready, (error) => error.name === 'AbortError')
  await session.closed
})

test('termination rejects ready and queued requests', async () => {
  const session = createUntrustedWorker('await new Promise(() => {})', {
    startupTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  const request = session.request('queued')
  const readyRejection = assert.rejects(
    session.ready,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_TERMINATED'
  )
  const requestRejection = assert.rejects(
    request,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_TERMINATED'
  )
  await session.terminate()
  await Promise.all([readyRejection, requestRejection])
  assert.throws(
    () => session.postMessage('late'),
    /session was terminated|session is closed/
  )
})

test('rejects all shared-memory representations at every session boundary', async (t) => {
  const sharedBuffer = new SharedArrayBuffer(8)
  const sharedWasmMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
  const sharedValues = [
    sharedBuffer,
    sharedWasmMemory,
    new Uint8Array(sharedBuffer),
    new DataView(sharedBuffer)
  ]

  for (const value of sharedValues) {
    assert.throws(
      () => createUntrustedWorker('onMessage(() => null)', { input: value }),
      /input must not contain shared memory/
    )
  }

  const session = createUntrustedWorker(`
    onMessage((message) => {
      if (message === 'response-buffer') return new SharedArrayBuffer(8)
      if (message === 'response-wasm') {
        return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
      }
      if (message === 'response-view') return new Uint8Array(new SharedArrayBuffer(8))
      if (message === 'response-data-view') return new DataView(new SharedArrayBuffer(8))
      if (message === 'send-buffer') send(new SharedArrayBuffer(8))
      if (message === 'send-wasm') {
        send(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }))
      }
      if (message === 'send-view') send(new Uint8Array(new SharedArrayBuffer(8)))
      if (message === 'send-data-view') send(new DataView(new SharedArrayBuffer(8)))
      return message
    })
  `, {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready

  for (const value of sharedValues) {
    assert.throws(() => session.postMessage(value), /message must not contain shared memory/)
    assert.throws(() => session.request(value), /message must not contain shared memory/)
  }

  for (const message of [
    'response-buffer',
    'response-wasm',
    'response-view',
    'response-data-view'
  ]) {
    await t.test(message, async () => {
      await assert.rejects(session.request(message), /response must not contain shared memory/)
    })
  }

  for (const message of [
    'send-buffer',
    'send-wasm',
    'send-view',
    'send-data-view'
  ]) {
    await t.test(message, async () => {
      const runtimeError = once(session, 'error')
      session.postMessage(message)
      assert.match((await runtimeError)[0].message, /message must not contain shared memory/)
    })
  }

  const ordinary = new ArrayBuffer(8)
  assert.equal(await session.request(ordinary) instanceof ArrayBuffer, true)
  await session.terminate()
})

test('ignores inherited persistent capabilities and limits', async () => {
  let calls = 0
  const options = Object.create({
    hostFunctions: {
      secrets: {
        read () {
          calls++
          return 'secret'
        }
      }
    },
    maxHostFunctionCalls: Number.MAX_SAFE_INTEGER,
    lifetimeTimeoutMs: 1
  })
  options.startupTimeoutMs = 5_000
  options.messageTimeoutMs = 5_000
  options.lifetimeTimeoutMs = 5_000

  const session = createUntrustedWorker('onMessage(() => typeof secrets)', options)
  await session.ready
  assert.equal(await session.request(null), 'undefined')
  assert.equal(calls, 0)
  await session.terminate()
})

test('validates session options', () => {
  assert.throws(() => createUntrustedWorker(null), /source must be a string/)
  assert.throws(() => createUntrustedWorker('', { type: 'file' }), /type must be/)
  assert.throws(
    () => createUntrustedWorker('', { startupTimeoutMs: 2_147_483_648 }),
    /must not exceed/
  )
  assert.throws(
    () => createUntrustedWorker('', { resourceLimits: { typo: 1 } }),
    /Unknown resource limit/
  )
  assert.throws(
    () => createUntrustedWorker('', { maxMessageBytes: 127 }),
    /must be at least 128/
  )
  for (const option of [
    'maxInputBytes',
    'maxMessageBytes',
    'maxOutputMessages',
    'maxOutputBytes'
  ]) {
    assert.throws(
      () => createUntrustedWorker('', { [option]: 0 }),
      /positive integer/
    )
  }
  const controller = new AbortController()
  controller.abort()
  assert.throws(
    () => createUntrustedWorker('', { signal: controller.signal }),
    (error) => error.name === 'AbortError'
  )
  assert.ok(UntrustedCodeError)
})
