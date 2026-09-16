import assert from 'node:assert/strict'
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'

import {
  configureWorkerAdmission,
  createUntrustedWorker,
  getHostFunctionContext,
  HostFunctionError,
  runUntrustedCode
} from '../src/index.js'

const require = createRequire(import.meta.url)

test('one-shot source calls synchronous and asynchronous host functions as globals', async () => {
  const calls = []
  const value = await runUntrustedCode(`
    return {
      sum: await math.add(input.left, input.right),
      upper: await text.upper(input.label),
      hostBinding: typeof host
    }
  `, {
    input: { left: 20, right: 22, label: 'hello' },
    hostFunctions: {
      math: {
        add (left, right) {
          calls.push(['add', left, right])
          return left + right
        }
      },
      text: {
        async upper (value) {
          calls.push(['upper', value])
          return value.toUpperCase()
        }
      }
    },
    timeoutMs: 5_000
  })

  assert.deepEqual(value, { sum: 42, upper: 'HELLO', hostBinding: 'undefined' })
  assert.deepEqual(calls, [['add', 20, 22], ['upper', 'hello']])
})

test('one-shot host functions share context, redaction, and public errors', async () => {
  const contexts = []
  const value = await runUntrustedCode(`
    const results = {}
    for (const name of ['context', 'privateFailure', 'publicFailure']) {
      try {
        results[name] = await tools[name]()
      } catch (error) {
        results[name] = { name: error.name, message: error.message, code: error.code }
      }
    }
    return results
  `, {
    hostFunctions: {
      tools: {
        context () {
          const context = getHostFunctionContext()
          contexts.push(context)
          return {
            requestId: context.requestId,
            requestIndex: context.requestIndex,
            hostFunctionName: context.hostFunctionName
          }
        },
        privateFailure () {
          throw new Error('HOST_PRIVATE_SECRET')
        },
        publicFailure () {
          throw new HostFunctionError('Safe detail', { code: 'SAFE_CODE' })
        }
      }
    },
    timeoutMs: 5_000
  })

  assert.equal(contexts.length, 1)
  assert.equal(value.context.requestIndex, 1)
  assert.equal(value.context.hostFunctionName, 'tools.context')
  assert.match(value.context.requestId, /:1$/)
  assert.deepEqual(value.privateFailure, {
    name: 'HostFunctionError',
    message: 'Host function failed',
    code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
  })
  assert.deepEqual(value.publicFailure, {
    name: 'HostFunctionError',
    message: 'Safe detail',
    code: 'SAFE_CODE'
  })
})

test('one-shot host functions enforce call and output limits', async () => {
  await assert.rejects(
    runUntrustedCode('await tools.value(); return tools.value()', {
      hostFunctions: { tools: { value: () => 42 } },
      maxHostFunctionCalls: 1,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_HOST_FUNCTION_LIMIT'
  )

  let calls = 0
  await assert.rejects(
    runUntrustedCode('return Promise.all([tools.value(), tools.value()])', {
      hostFunctions: {
        tools: {
          async value () {
            calls++
            await new Promise(() => {})
            return 42
          }
        }
      },
      maxInFlightHostFunctions: 1,
      timeoutMs: 5_000
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_HOST_FUNCTION_LIMIT'
  )
  assert.equal(calls, 1)
})

test('one-shot cancellation aborts active host-function context and ignores late results', async () => {
  const controller = new AbortController()
  let context
  let resolveHost
  let resultReads = 0
  const result = runUntrustedCode('return tools.wait()', {
    signal: controller.signal,
    hostFunctions: {
      tools: {
        wait () {
          context = getHostFunctionContext()
          return new Promise((resolve) => { resolveHost = resolve })
        }
      }
    },
    timeoutMs: 5_000
  })

  while (!resolveHost) await new Promise((resolve) => setImmediate(resolve))
  controller.abort('test')
  await assert.rejects(result, (error) => error.name === 'AbortError')
  assert.equal(context.abortSignal.aborted, true)
  resolveHost({
    get value () {
      resultReads++
      return 42
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resultReads, 0)
})

test('one-shot host functions reject unsupported boundary values', async () => {
  let calls = 0
  await assert.rejects(
    runUntrustedCode('return tools.echo(new SharedArrayBuffer(8))', {
      hostFunctions: {
        tools: {
          echo: (value) => {
            calls++
            return value
          }
        }
      },
      timeoutMs: 5_000
    }),
    /shared memory/
  )
  assert.equal(calls, 0)

  await assert.rejects(
    runUntrustedCode('return tools.value()', {
      hostFunctions: { tools: { value: () => new Blob(['secret']) } },
      timeoutMs: 5_000
    }),
    /HostFunctionError|Host function failed/
  )
})

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

test('rejects same-session reentrant requests from host functions', async () => {
  let session
  session = createUntrustedWorker(`onMessage(() => tools.reenter())`, {
    hostFunctions: {
      tools: {
        reenter () {
          assert.throws(
            () => session.request('nested'),
            (error) => error.code === 'ERR_UNTRUSTED_WORKER_REENTRANT_REQUEST'
          )
          return 'rejected safely'
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.equal(await session.request('outer'), 'rejected safely')
  await session.terminate()
})

test('host function context uses captured AsyncLocalStorage operations', async () => {
  let session
  session = createUntrustedWorker(`onMessage(() => tools.reenter())`, {
    hostFunctions: {
      tools: {
        reenter () {
          const context = getHostFunctionContext()
          assert.equal(context.hostFunctionName, 'tools.reenter')
          assert.throws(
            () => session.request('nested'),
            (error) => error.code === 'ERR_UNTRUSTED_WORKER_REENTRANT_REQUEST'
          )
          return 'rejected safely'
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready

  const originalGetStore = AsyncLocalStorage.prototype.getStore
  const originalRun = AsyncLocalStorage.prototype.run
  try {
    AsyncLocalStorage.prototype.getStore = () => undefined
    AsyncLocalStorage.prototype.run = () => { throw new Error('poisoned run') }
    assert.equal(await session.request('outer'), 'rejected safely')
  } finally {
    AsyncLocalStorage.prototype.getStore = originalGetStore
    AsyncLocalStorage.prototype.run = originalRun
    await session.terminate().catch(() => {})
  }
})

test('host-function promise settlement fails closed under poisoned promise species', async (t) => {
  const originalConstructor = Object.getOwnPropertyDescriptor(
    Promise.prototype,
    'constructor'
  )
  const originalSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species)
  const utilTypes = require('node:util/types')
  const originalIsPromise = Object.getOwnPropertyDescriptor(utilTypes, 'isPromise')
  let restored = true
  let utilTypesRestored = true
  const restore = () => {
    if (!restored) {
      restored = true
      Object.defineProperty(Promise.prototype, 'constructor', originalConstructor)
      Object.defineProperty(Promise, Symbol.species, originalSpecies)
    }
    if (!utilTypesRestored) {
      utilTypesRestored = true
      Object.defineProperty(utilTypes, 'isPromise', originalIsPromise)
      syncBuiltinESMExports()
    }
  }
  t.after(restore)
  class PoisonPromiseSpecies {
    constructor () { throw new Error('poisoned promise species') }
  }
  Object.defineProperty(PoisonPromiseSpecies, Symbol.species, {
    configurable: true,
    value: PoisonPromiseSpecies
  })
  let retainedPromise
  const session = createUntrustedWorker('onMessage(() => tools.value())', {
    hostFunctions: {
      tools: {
        value () {
          const result = new Promise(resolve => setImmediate(resolve, 42))
          retainedPromise = result
          restored = false
          Object.defineProperty(Promise.prototype, 'constructor', {
            configurable: true,
            value: PoisonPromiseSpecies
          })
          Object.defineProperty(Promise, Symbol.species, {
            configurable: true,
            value: PoisonPromiseSpecies
          })
          setImmediate(restore)
          return result
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  utilTypesRestored = false
  Object.defineProperty(utilTypes, 'isPromise', {
    ...originalIsPromise,
    value: () => false
  })
  syncBuiltinESMExports()
  await assert.rejects(session.request(null), /Host function failed/)
  assert.equal(Object.hasOwn(retainedPromise, 'constructor'), false)
  restore()
  await session.terminate()
})

test('frozen host promises fail closed under constructor poisoning', async (t) => {
  const originalConstructor = Object.getOwnPropertyDescriptor(
    Promise.prototype,
    'constructor'
  )
  class PoisonPromiseSpecies {
    constructor () { throw new Error('poisoned promise species') }
  }
  Object.defineProperty(PoisonPromiseSpecies, Symbol.species, {
    configurable: true,
    value: PoisonPromiseSpecies
  })
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    Object.defineProperty(Promise.prototype, 'constructor', originalConstructor)
  }
  t.after(restore)
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  const session = createUntrustedWorker('onMessage(() => host.values.value())', {
    hostFunctions: {
      values: {
        value () {
          const result = Object.freeze(Promise.resolve(42))
          Object.defineProperty(Promise.prototype, 'constructor', {
            configurable: true,
            value: PoisonPromiseSpecies
          })
          setImmediate(restore)
          return result
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  await assert.rejects(session.request('value'), /Host function failed/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  await session.terminate()
})

test('host functions preserve canonical promises and reject Promise subclasses', async () => {
  class ResultPromise extends Promise {}
  const promises = []
  const session = createUntrustedWorker('onMessage(value => tools[value]())', {
    hostFunctions: {
      tools: {
        native () {
          const value = Promise.resolve(41)
          promises.push(value)
          return value
        },
        frozenNative () {
          const value = Object.freeze(Promise.resolve(42))
          promises.push(value)
          return value
        },
        subclass () {
          const value = new ResultPromise(resolve => resolve(43))
          promises.push(value)
          return value
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  assert.equal(await session.request('native'), 41)
  assert.equal(await session.request('frozenNative'), 42)
  await assert.rejects(session.request('subclass'), /Host function failed/)
  for (const promise of promises) {
    assert.equal(Object.hasOwn(promise, 'constructor'), false)
  }
  await session.terminate()
})

test('host promise adoption never mutates retained promise descriptors', async (t) => {
  let retainedPromise
  let observedDescriptor
  const hook = createHook({
    init () {
      if (!retainedPromise || observedDescriptor !== undefined) return
      observedDescriptor = Object.getOwnPropertyDescriptor(retainedPromise, 'constructor') ?? null
      hook.disable()
    }
  })
  t.after(() => hook.disable())

  const session = createUntrustedWorker('onMessage(() => tools.value())', {
    hostFunctions: {
      tools: {
        value () {
          retainedPromise = Promise.resolve(46)
          hook.enable()
          return retainedPromise
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  t.after(() => session.terminate().catch(() => {}))
  await session.ready
  assert.equal(await session.request(null), 46)
  assert.equal(observedDescriptor, null)
  assert.equal(Object.getOwnPropertyDescriptor(retainedPromise, 'constructor'), undefined)
  await session.terminate()
})

test('host promise adoption rejects custom proxy prototypes without traps', async (t) => {
  let descriptorReads = 0
  let prototypeReads = 0
  let valueReads = 0
  const session = createUntrustedWorker('onMessage(() => tools.value())', {
    hostFunctions: {
      tools: {
        value () {
          const proxyPrototype = new Proxy(Object.create(Promise.prototype), {
            getOwnPropertyDescriptor () { descriptorReads++; throw new Error('descriptor trap') },
            getPrototypeOf () { prototypeReads++; throw new Error('prototype trap') },
            get () { valueReads++; throw new Error('value trap') }
          })
          const promise = Promise.resolve(47)
          Object.setPrototypeOf(promise, proxyPrototype)
          Object.preventExtensions(promise)
          return promise
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 1_000,
    lifetimeTimeoutMs: 5_000
  })
  t.after(() => session.terminate().catch(() => {}))
  await session.ready
  await assert.rejects(session.request(null), /Host function failed/)
  assert.equal(descriptorReads, 0)
  assert.equal(prototypeReads, 0)
  assert.equal(valueReads, 0)
  await session.terminate()
})

test('synchronous host results never assimilate untrusted then properties', async (t) => {
  let getterReads = 0
  let callableCalls = 0
  const callable = () => { callableCalls++; return new Promise(() => {}) }
  const inherited = Object.create({ then: callable })
  inherited.value = 42
  const accessor = { value: 43 }
  Object.defineProperty(accessor, 'then', {
    enumerable: true,
    get () { getterReads++; return callable }
  })
  const session = createUntrustedWorker(`
    onMessage(async name => {
      try { return await tools[name]() } catch (error) { return error.code }
    })
  `, {
    hostFunctions: {
      tools: {
        data: () => ({ then: 'ordinary-data', value: 41 }),
        inherited: () => inherited,
        accessor: () => accessor,
        callable: () => ({ then: callable, value: 44 }),
        nonreturning: () => ({ then () { callableCalls++; return new Promise(() => {}) } })
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 1_000,
    lifetimeTimeoutMs: 5_000
  })
  t.after(() => session.terminate().catch(() => {}))
  await session.ready
  assert.deepEqual(await session.request('data'), { then: 'ordinary-data', value: 41 })
  for (const name of ['inherited', 'accessor', 'callable', 'nonreturning']) {
    assert.equal(await session.request(name), 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION')
  }
  assert.equal(getterReads, 0)
  assert.equal(callableCalls, 0)
  await session.terminate()
  await session.closed
})

test('frozen Promise subclasses fail closed without invoking host species', async (t) => {
  let speciesReads = 0
  let speciesConstructions = 0
  class FrozenResultPromise extends Promise {}
  Object.defineProperty(FrozenResultPromise, Symbol.species, {
    configurable: true,
    get () {
      speciesReads++
      return class BlockingPromiseSpecies {
        constructor (executor) {
          speciesConstructions++
          executor(() => {}, () => {})
        }
      }
    }
  })

  const unexpected = []
  const onUnhandled = error => unexpected.push(error)
  const onUncaught = error => unexpected.push(error)
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUncaught)
  t.after(() => {
    process.off('unhandledRejection', onUnhandled)
    process.off('uncaughtException', onUncaught)
  })

  const session = createUntrustedWorker('onMessage(() => tools.value())', {
    hostFunctions: {
      tools: {
        value () {
          return Object.freeze(new FrozenResultPromise(resolve => resolve(44)))
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 1_000,
    lifetimeTimeoutMs: 5_000
  })
  t.after(() => session.terminate().catch(() => {}))
  await session.ready
  const startedAt = Date.now()
  await assert.rejects(session.request(null), /Host function failed/)
  assert.equal(Date.now() - startedAt < 4_000, true)
  assert.equal(speciesReads, 0)
  assert.equal(speciesConstructions, 0)
  await session.terminate()
  await session.closed
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unexpected, [])
  assert.equal(await runUntrustedCode('return 45', { timeoutMs: 5_000 }), 45)
})

test('frozen host promises reject constructor accessors without invoking them', async (t) => {
  let constructorReads = 0
  let speciesReads = 0
  let speciesConstructions = 0
  class HostilePromise extends Promise {}
  Object.defineProperty(HostilePromise, Symbol.species, {
    get () {
      speciesReads++
      return class BlockingPromiseSpecies {
        constructor (executor) {
          speciesConstructions++
          executor(() => {}, () => {})
        }
      }
    }
  })

  const unexpected = []
  const onUnhandled = error => unexpected.push(error)
  const onUncaught = error => unexpected.push(error)
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUncaught)
  t.after(() => {
    process.off('unhandledRejection', onUnhandled)
    process.off('uncaughtException', onUncaught)
  })

  const session = createUntrustedWorker('onMessage(() => tools.value())', {
    hostFunctions: {
      tools: {
        value () {
          const result = Promise.resolve(47)
          Object.defineProperty(result, 'constructor', {
            configurable: false,
            get () {
              constructorReads++
              return constructorReads === 1 ? Promise : HostilePromise
            }
          })
          return Object.freeze(result)
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 1_000,
    lifetimeTimeoutMs: 5_000
  })
  t.after(() => session.terminate().catch(() => {}))
  await session.ready
  const startedAt = Date.now()
  await assert.rejects(session.request(null), /Host function failed/)
  assert.equal(Date.now() - startedAt < 4_000, true)
  assert.equal(constructorReads, 0)
  assert.equal(speciesReads, 0)
  assert.equal(speciesConstructions, 0)
  await session.terminate()
  await session.closed
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unexpected, [])
  assert.equal(await runUntrustedCode('return 48', { timeoutMs: 5_000 }), 48)
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

test('host errors are redacted unless explicitly marked public', async () => {
  const session = createUntrustedWorker(`
    onMessage(async (message) => {
      if (message === 'fail' || message === 'public') {
        try {
          await tools[message]()
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
        public: () => {
          throw new HostFunctionError('Safe public explanation', { code: 'NOT_FOUND' })
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
    name: 'HostFunctionError',
    message: 'Host function failed',
    code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
  })
  assert.deepEqual(await session.request('public'), {
    name: 'HostFunctionError',
    message: 'Safe public explanation',
    code: 'NOT_FOUND'
  })
  assert.equal(await session.request('ok'), 'still running')
  await session.terminate()
})

test('HostFunctionError serialization rejects accessor-backed disclosure without invoking it', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const unhandled = []
  const onUnhandled = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  let reads = 0
  let session
  const hostile = new HostFunctionError('Safe text', { code: 'SAFE_CODE' })
  for (const name of ['message', 'code']) {
    Object.defineProperty(hostile, name, {
      configurable: true,
      get () {
        reads++
        void session.request('ok').catch(() => {})
        return `ACCESSOR_${name}`
      }
    })
  }

  session = createUntrustedWorker(`
    onMessage(async value => {
      if (value === 'fail') {
        try { await tools.fail() } catch (error) {
          return { message: error.message, code: error.code }
        }
      }
      return tools.ok()
    })
  `, {
    hostFunctions: {
      tools: {
        fail () { throw hostile },
        ok () { return 'still running' }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  assert.deepEqual(await session.request('fail'), {
    message: 'Host function failed',
    code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
  })
  assert.equal(reads, 0)
  assert.equal(await session.request('ok'), 'still running')
  await session.terminate()
  await session.closed

  const replacement = createUntrustedWorker('onMessage(value => value)', {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await replacement.ready
  assert.equal(await replacement.request(42), 42)
  await replacement.terminate()
  await replacement.closed
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})

test('HostFunctionError validates canonical own options without invoking accessors', () => {
  const cause = new Error('trusted cause')
  const valid = new HostFunctionError('public', { code: 'PUBLIC', cause })
  assert.equal(valid.code, 'PUBLIC')
  assert.equal(valid.cause, cause)

  const inherited = Object.create({ code: 'INHERITED_SECRET', cause: new Error('hidden') })
  assert.throws(() => new HostFunctionError('public', inherited), /plain object/)

  let reads = 0
  for (const name of ['code', 'cause']) {
    const options = Object.defineProperty({}, name, {
      enumerable: true,
      get () { reads++; return 'secret' }
    })
    assert.throws(() => new HostFunctionError('public', options), /data property/)
  }
  assert.equal(reads, 0)

  let traps = 0
  const proxy = new Proxy({}, {
    getPrototypeOf () { traps++; throw new Error('prototype trap') },
    ownKeys () { traps++; throw new Error('ownKeys trap') }
  })
  assert.throws(() => new HostFunctionError('public', proxy), /plain object/)
  assert.equal(traps, 0)
  assert.throws(() => new HostFunctionError('public', []), /plain object/)
  assert.throws(() => new HostFunctionError('public', null), /plain object/)
  assert.throws(() => new HostFunctionError('public', { unknown: true }), /unsupported property/)
  assert.throws(() => new HostFunctionError('public', { code: 42 }), /must be a string/)
  assert.throws(
    () => new HostFunctionError('public', { [Symbol('secret')]: true }),
    /unsupported property/
  )
})

test('host-function descriptors ignore polluted Object.prototype.value', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
  const restore = () => {
    if (original) Object.defineProperty(Object.prototype, 'value', original)
    else delete Object.prototype.value
  }
  t.after(restore)

  for (const pollution of ['data', 'accessor']) {
    let namespaceReads = 0
    let prototypeReads = 0
    if (pollution === 'data') {
      Object.defineProperty(Object.prototype, 'value', {
        configurable: true,
        value: { hidden: () => 42 },
        writable: true
      })
    } else {
      Object.defineProperty(Object.prototype, 'value', {
        configurable: true,
        get () {
          prototypeReads++
          throw new Error('poisoned descriptor value')
        }
      })
    }
    const namespaceDescriptor = Object.create(null)
    namespaceDescriptor.enumerable = true
    namespaceDescriptor.get = () => {
      namespaceReads++
      return { hidden: () => 42 }
    }
    const hostFunctions = Object.defineProperty({}, 'tools', namespaceDescriptor)
    assert.throws(
      () => createUntrustedWorker('onMessage(value => value)', {
        hostFunctions,
        startupTimeoutMs: 5_000,
        messageTimeoutMs: 5_000,
        lifetimeTimeoutMs: 5_000
      }),
      /Host function namespace .* must be a data property/
    )
    assert.equal(namespaceReads, 0)
    assert.equal(prototypeReads, 0)
    restore()

    const session = createUntrustedWorker('onMessage(value => value)', {
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    await session.ready
    assert.equal(await session.request(42), 42)
    await session.terminate()
    await session.closed
  }
})

test('HostFunctionError ignores polluted inherited disclosure fields', async (t) => {
  const codeDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'code')
  const causeDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'cause')
  let causeReads = 0
  t.after(() => {
    if (codeDescriptor) Object.defineProperty(Object.prototype, 'code', codeDescriptor)
    else delete Object.prototype.code
    if (causeDescriptor) Object.defineProperty(Object.prototype, 'cause', causeDescriptor)
    else delete Object.prototype.cause
  })
  Object.defineProperty(Object.prototype, 'code', {
    configurable: true,
    value: 'INHERITED_SECRET',
    writable: true
  })
  Object.defineProperty(Object.prototype, 'cause', {
    configurable: true,
    get () { causeReads++; return new Error('secret cause') }
  })
  const publicError = new HostFunctionError('Safe public text')
  if (codeDescriptor) Object.defineProperty(Object.prototype, 'code', codeDescriptor)
  else delete Object.prototype.code
  if (causeDescriptor) Object.defineProperty(Object.prototype, 'cause', causeDescriptor)
  else delete Object.prototype.cause
  const session = createUntrustedWorker(`
    onMessage(async () => {
      try { await tools.fail() } catch (error) {
        return { message: error.message, code: error.code }
      }
    })
  `, {
    hostFunctions: { tools: { fail: () => { throw publicError } } },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  t.after(() => session.terminate().catch(() => {}))
  await session.ready
  assert.deepEqual(await session.request(null), {
    message: 'Safe public text',
    code: 'ERR_HOST_FUNCTION'
  })
  assert.equal(causeReads, 0)
  await session.terminate()
})

test('HostFunctionError disclosure uses an unforgeable private brand', async (t) => {
  const originalHasInstance = Object.getOwnPropertyDescriptor(
    HostFunctionError,
    Symbol.hasInstance
  )
  t.after(() => {
    if (originalHasInstance) {
      Object.defineProperty(HostFunctionError, Symbol.hasInstance, originalHasInstance)
    } else {
      delete HostFunctionError[Symbol.hasInstance]
    }
  })
  Object.defineProperty(HostFunctionError, Symbol.hasInstance, {
    configurable: true,
    value: () => true
  })

  const session = createUntrustedWorker(`
    onMessage(async value => {
      try { await tools[value]() } catch (error) {
        return { message: error.message, code: error.code }
      }
    })
  `, {
    hostFunctions: {
      tools: {
        forged () {
          const error = new Error('PRIVATE_FORGED_SECRET')
          error.code = 'PRIVATE_FORGED_CODE'
          Object.setPrototypeOf(error, HostFunctionError.prototype)
          throw error
        },
        ordinary () {
          const error = new Error('PRIVATE_HAS_INSTANCE_SECRET')
          error.code = 'PRIVATE_HAS_INSTANCE_CODE'
          throw error
        },
        public () {
          throw new HostFunctionError('Public explanation', { code: 'PUBLIC_CODE' })
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  for (const name of ['forged', 'ordinary']) {
    assert.deepEqual(await session.request(name), {
      message: 'Host function failed',
      code: 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
    })
  }
  assert.deepEqual(await session.request('public'), {
    message: 'Public explanation',
    code: 'PUBLIC_CODE'
  })
  await session.terminate()
})

test('decorated branded host-function values fail closed', async () => {
  let calls = 0
  let reads = 0
  const session = createUntrustedWorker(`
    onMessage(async value => {
      if (value === 'argument') {
        const argument = new Date(0)
        Object.defineProperty(argument, 'authority', {
          enumerable: true,
          value: new SharedArrayBuffer(8)
        })
        try { await tools.consume(argument) } catch (error) { return error.message }
      }
      try { await tools.decorated() } catch (error) { return error.code }
    })
  `, {
    hostFunctions: {
      tools: {
        consume () { calls++ },
        decorated () {
          const value = new Map([['answer', 42]])
          Object.defineProperty(value, 'authority', {
            enumerable: true,
            get () {
              reads++
              return new SharedArrayBuffer(8)
            }
          })
          return value
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await session.ready
  assert.match(await session.request('argument'), /(?:protocol|host function)/i)
  assert.equal(calls, 0)
  assert.equal(await session.request('result'), 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION')
  assert.equal(reads, 0)
  await session.terminate()
})

test('oversized host errors fail the session without an unhandled rejection', async () => {
  const session = createUntrustedWorker(`onMessage(() => tools.fail())`, {
    hostFunctions: {
      tools: {
        fail: () => {
          throw new HostFunctionError('x'.repeat(10_000))
        }
      }
    },
    maxMessageBytes: 200,
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  await assert.rejects(
    session.request(null),
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_PROTOCOL'
  )
  await session.closed
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
    await assert.rejects(
      session.request(null),
      (error) => error.code === 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
    )
    await session.closed
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
    await assert.rejects(
      session.request(null),
      (error) => error.code === 'ERR_UNTRUSTED_WORKER_HOST_FUNCTION_LIMIT'
    )
    await session.closed
  })
})

test('guest output budgets include attempted host calls', async () => {
  let calls = 0
  const session = createUntrustedWorker(`
    onMessage(async () => {
      const results = await Promise.allSettled([tools.value(), tools.value()])
      return results.map((result) => result.status === 'fulfilled'
        ? result.value
        : result.reason.message)
    })
  `, {
    hostFunctions: {
      tools: {
        value: () => {
          calls++
          return 42
        }
      }
    },
    maxOutputMessages: 1,
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.deepEqual(await session.request(null), [42, 'Output limit exceeded'])
  assert.equal(calls, 1)
  await session.terminate()
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
    'argument-data-view'
  ]) {
    assert.match(await session.request(boundary), /must not contain shared memory/)
  }
  for (const boundary of [
    'result-buffer',
    'result-wasm',
    'result-view',
    'result-data-view'
  ]) {
    assert.equal(await session.request(boundary), 'Host function failed')
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

test('cancellation deactivates host context and skips late result cloning', async () => {
  let resolveHostFunction
  let detachedContext
  let resultGetterCalls = 0
  const detached = new Promise((resolve) => { detachedContext = resolve })
  const session = createUntrustedWorker(`await tools.wait()`, {
    hostFunctions: {
      tools: {
        wait () {
          const { abortSignal } = getHostFunctionContext()
          abortSignal.addEventListener('abort', () => {
            setImmediate(() => {
              try {
                getHostFunctionContext()
                detachedContext('active')
              } catch {
                detachedContext('inactive')
              }
            })
          }, { once: true })
          return new Promise((resolve) => { resolveHostFunction = resolve })
        }
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  while (!resolveHostFunction) await new Promise((resolve) => setImmediate(resolve))
  const ready = assert.rejects(
    session.ready,
    (error) => error.code === 'ERR_UNTRUSTED_WORKER_TERMINATED'
  )
  await session.terminate()
  await ready
  resolveHostFunction({
    get value () {
      resultGetterCalls++
      return 42
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await detached, 'inactive')
  assert.equal(resultGetterCalls, 0)
})

test('rejects platform objects whose contents are not authenticated by the codec', async () => {
  const hostKey = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    true,
    ['sign', 'verify']
  )
  const session = createUntrustedWorker(`
    onMessage(async (kind) => {
      try {
        if (kind === 'argument') await tools.echo(new Blob(['secret']))
        if (kind === 'argument-key') {
          const key = await crypto.subtle.generateKey(
            { name: 'HMAC', hash: 'SHA-256', length: 256 },
            true,
            ['sign', 'verify']
          )
          await tools.echo(key)
        }
        if (kind === 'result') await tools.blob()
        if (kind === 'result-key') await tools.key()
      } catch (error) {
        return error.message
      }
    })
  `, {
    hostFunctions: {
      tools: {
        echo: (value) => value,
        blob: () => new Blob(['secret']),
        key: () => hostKey
      }
    },
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })

  await session.ready
  assert.match(await session.request('argument'), /unsupported/i)
  assert.match(
    await session.request('argument-key'),
    /(?:unsupported|not supported|unserializable)/i
  )
  assert.equal(await session.request('result'), 'Host function failed')
  assert.equal(await session.request('result-key'), 'Host function failed')
  await session.terminate()
})

test('host function validation uses captured JSON formatting', async () => {
  const originalStringify = JSON.stringify
  let session
  try {
    JSON.stringify = () => { throw new Error('poisoned JSON.stringify') }
    session = createUntrustedWorker('onMessage(() => tools.value())', {
      hostFunctions: { tools: { value: () => 42 } },
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
  } finally {
    JSON.stringify = originalStringify
  }
  await session.ready
  assert.equal(await session.request(null), 42)
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
  for (const namespace of ['send', 'onMessage', 'input', 'host', 'class', 'await']) {
    assert.throws(
      () => createUntrustedWorker('', { hostFunctions: { [namespace]: { call: () => null } } }),
      /Reserved host function namespace/
    )
  }
  const symbolManifest = { tools: { call: () => null } }
  symbolManifest[Symbol('hidden')] = { call: () => null }
  assert.throws(
    () => createUntrustedWorker('', { hostFunctions: symbolManifest }),
    /symbol properties/
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
