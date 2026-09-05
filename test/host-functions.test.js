import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createUntrustedWorker,
  getHostFunctionContext
} from '../src/index.js'

for (const type of ['script', 'module']) {
  test(`${type} components call asynchronous host functions as globals`, async () => {
    const calls = []
    const body = `
      const initial = await math.add(20, 22)
      send(initial)
      onMessage(async (values) => math.add(...values))
    `
    const source = type === 'script'
      ? body
      : `${body}\nexport default ({ send, onMessage }) => { send(initial); onMessage(async values => math.add(...values)) }`
    const effectiveSource = type === 'module'
      ? `const initial = await math.add(20, 22); export default ({ send, onMessage }) => { send(initial); onMessage(async values => math.add(...values)) }`
      : source
    const session = createUntrustedWorker(effectiveSource, {
      type,
      hostFunctions: {
        math: {
          async add (...values) {
            calls.push(values)
            return values.reduce((total, value) => total + value, 0)
          }
        }
      },
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })

    const messages = []
    session.on('message', (message) => messages.push(message))
    await session.ready
    assert.deepEqual(messages, [42])
    assert.equal(await session.request([10, 20, 12]), 42)
    assert.deepEqual(calls, [[20, 22], [10, 20, 12]])
    await session.terminate()
  })
}

test('module setup receives the same host function object', async () => {
  const session = createUntrustedWorker(`
    export default ({ host, onMessage }) => {
      onMessage((value) => host.text.upper(value))
    }
  `, {
    type: 'module',
    hostFunctions: {
      text: { upper: (value) => value.toUpperCase() }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.equal(await session.request('hello'), 'HELLO')
  await session.terminate()
})

test('host function context provides request metadata and cancellation', async () => {
  const contexts = []
  let observedAbort
  const controller = new AbortController()
  const session = createUntrustedWorker(`
    await tools.wait()
  `, {
    signal: controller.signal,
    hostFunctions: {
      tools: {
        wait () {
          const context = getHostFunctionContext()
          contexts.push(context)
          observedAbort = new Promise((resolve) => {
            context.abortSignal.addEventListener('abort', resolve, { once: true })
          })
          return new Promise(() => {})
        }
      }
    },
    startupTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  const readyRejection = assert.rejects(session.ready, (error) => error.name === 'AbortError')
  while (contexts.length === 0) await new Promise((resolve) => setImmediate(resolve))
  controller.abort('test')
  await readyRejection
  await observedAbort
  assert.equal(contexts[0].hostFunctionName, 'tools.wait')
  assert.equal(contexts[0].requestIndex, 1)
  assert.match(contexts[0].requestId, new RegExp(`^${contexts[0].sessionId}:1$`))
  assert.equal(contexts[0].abortSignal.aborted, true)
  await session.closed

  assert.throws(() => getHostFunctionContext(), /active host function/)
})

test('guest code receives sanitized host function errors and can continue', async () => {
  const session = createUntrustedWorker(`
    onMessage(async (message) => {
      if (message === 'fail') {
        try {
          await tools.fail()
        } catch (error) {
          return { name: error.name, message: error.message, code: error.code }
        }
      }
      return tools.ok()
    })
  `, {
    hostFunctions: {
      tools: {
        fail () {
          const error = new TypeError('expected failure')
          error.code = 'EXPECTED'
          error.stack += '\nHOST_PRIVATE_STACK_MARKER'
          throw error
        },
        ok: () => 'still running'
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.deepEqual(await session.request('fail'), {
    name: 'TypeError',
    message: 'expected failure',
    code: 'EXPECTED'
  })
  assert.equal(await session.request('ok'), 'still running')
  await session.terminate()
})

test('host function calls enforce total and in-flight limits', async (t) => {
  await t.test('total calls', async () => {
    const session = createUntrustedWorker(`
      onMessage(async () => {
        const first = await tools.value()
        try {
          await tools.value()
        } catch (error) {
          return { first, code: error.code }
        }
      })
    `, {
      hostFunctions: { tools: { value: () => 42 } },
      maxHostFunctionCalls: 1,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    await session.ready
    assert.deepEqual(await session.request(null), {
      first: 42,
      code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
    })
    await session.terminate()
  })

  await t.test('concurrent calls', async () => {
    const session = createUntrustedWorker(`
      onMessage(async () => {
        const results = await Promise.allSettled([tools.slow(), tools.slow()])
        return results.map((result) => result.status === 'fulfilled' ? result.value : result.reason.code)
      })
    `, {
      hostFunctions: {
        tools: {
          slow: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return 'ok'
          }
        }
      },
      maxInFlightHostFunctions: 1,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    await session.ready
    assert.deepEqual(await session.request(null), [
      'ok',
      'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
    ])
    await session.terminate()
  })
})

test('every shared-memory representation is rejected in host arguments and results', async () => {
  const sharedBuffer = new SharedArrayBuffer(8)
  const sharedWasmMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
  const session = createUntrustedWorker(`
    onMessage(async (message) => {
      try {
        if (message === 'argument-buffer') await tools.echo(new SharedArrayBuffer(8))
        if (message === 'argument-wasm') {
          await tools.echo(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }))
        }
        if (message === 'argument-view') await tools.echo(new Uint8Array(new SharedArrayBuffer(8)))
        if (message === 'argument-data-view') await tools.echo(new DataView(new SharedArrayBuffer(8)))
        if (message === 'result-buffer') await tools.sharedBuffer()
        if (message === 'result-wasm') await tools.sharedWasm()
        if (message === 'result-view') await tools.sharedView()
        if (message === 'result-data-view') await tools.sharedDataView()
      } catch (error) {
        return error.message
      }
      return 'unexpected'
    })
  `, {
    hostFunctions: {
      tools: {
        echo: (value) => value,
        sharedBuffer: () => sharedBuffer,
        sharedWasm: () => sharedWasmMemory,
        sharedView: () => new Uint8Array(sharedBuffer),
        sharedDataView: () => new DataView(sharedBuffer)
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  for (const boundary of [
    'argument-buffer',
    'argument-wasm',
    'argument-view',
    'argument-data-view',
    'result-buffer',
    'result-wasm',
    'result-view',
    'result-data-view'
  ]) {
    assert.match(await session.request(boundary), /must not contain shared memory/)
  }
  await session.terminate()
})

test('prototype poisoning cannot hide shared typed-array memory from the guest boundary', async () => {
  let hostCalls = 0
  const session = createUntrustedWorker(`
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    Object.defineProperty(typedArrayPrototype, 'buffer', {
      configurable: true,
      get: () => new ArrayBuffer(0)
    })
    Object.defineProperty(DataView.prototype, 'buffer', {
      configurable: true,
      get: () => new ArrayBuffer(0)
    })
    onMessage(async (kind) => {
      const value = kind === 'typed-array'
        ? new Uint8Array(new SharedArrayBuffer(8))
        : new DataView(new SharedArrayBuffer(8))
      try {
        await tools.inspect(value)
      } catch (error) {
        return error.message
      }
      return 'unexpected'
    })
  `, {
    hostFunctions: {
      tools: {
        inspect () {
          hostCalls++
          return true
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.match(await session.request('typed-array'), /must not contain shared memory/)
  assert.match(await session.request('data-view'), /must not contain shared memory/)
  assert.equal(hostCalls, 0)
  await session.terminate()
})

test('validates host function manifests without invoking accessors', () => {
  assert.throws(
    () => createUntrustedWorker('', { hostFunctions: { process: { read: () => null } } }),
    /Reserved host function namespace/
  )
  assert.throws(
    () => createUntrustedWorker('', { hostFunctions: { tools: { then: () => null } } }),
    /Invalid host function function/
  )

  let accessed = false
  const hostFunctions = {}
  Object.defineProperty(hostFunctions, 'tools', {
    enumerable: true,
    get () {
      accessed = true
      return { read: () => null }
    }
  })
  assert.throws(
    () => createUntrustedWorker('', { hostFunctions }),
    /must be a data property/
  )
  assert.equal(accessed, false)
})
