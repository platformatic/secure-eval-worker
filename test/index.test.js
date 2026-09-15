import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { serialize } from 'node:v8'

import {
  configureWorkerAdmission,
  createRunner,
  runUntrustedCode,
  sanitizeEnvironment,
  UntrustedCodeError
} from '../src/index.js'
import {
  assertSupportedProtocolSource,
  assertSupportedRuntime
} from '../src/internal.js'

const packageUrl = new URL('../src/index.js', import.meta.url).href
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

test('rejects unsupported Node.js runtime versions', () => {
  assert.doesNotThrow(() => assertSupportedRuntime('26.5.1'))
  assert.doesNotThrow(() => assertSupportedRuntime('26.99.0'))
  for (const version of [
    '26.3.0',
    '26.5.0',
    '26.5.1-rc.0',
    '26.5.1garbage',
    '25.99.0',
    '27.0.0',
    'invalid'
  ]) {
    assert.throws(
      () => assertSupportedRuntime(version),
      (error) => error.code === 'ERR_SECURE_EVAL_UNSUPPORTED_RUNTIME' &&
        /requires Node\.js >=26\.5\.1 <27/.test(error.message)
    )
  }
})

test('one-shot settlement uses captured Promise chaining', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const originalThen = Promise.prototype.then
  const originalConstructor = Object.getOwnPropertyDescriptor(
    Promise.prototype,
    'constructor'
  )
  const originalSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species)
  class PoisonPromiseSpecies {
    constructor () { throw new Error('poisoned promise species') }
  }
  Object.defineProperty(PoisonPromiseSpecies, Symbol.species, {
    configurable: true,
    value: PoisonPromiseSpecies
  })
  const never = new Promise(() => {})
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  let result
  try {
    Promise.prototype.then = () => never
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      value: PoisonPromiseSpecies
    })
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      value: PoisonPromiseSpecies
    })
    result = runUntrustedCode('return 42', { timeoutMs: 5_000 })
  } finally {
    Promise.prototype.then = originalThen
    Object.defineProperty(Promise.prototype, 'constructor', originalConstructor)
    Object.defineProperty(Promise, Symbol.species, originalSpecies)
  }
  assert.equal(await result, 42)

  let rejection
  try {
    Promise.prototype.then = () => never
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      value: PoisonPromiseSpecies
    })
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      value: PoisonPromiseSpecies
    })
    rejection = runUntrustedCode('throw new Error("expected startup failure")', {
      timeoutMs: 5_000
    })
  } finally {
    Promise.prototype.then = originalThen
    Object.defineProperty(Promise.prototype, 'constructor', originalConstructor)
    Object.defineProperty(Promise, Symbol.species, originalSpecies)
  }
  await assert.rejects(rejection, /expected startup failure/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  assert.equal(await runUntrustedCode('return 43', { timeoutMs: 5_000 }), 43)
})

test('guest execution preserves native Promise identity and subclass semantics', async () => {
  const result = await runUntrustedCode(`
    class ResultPromise extends Promise {}
    const ordinary = (async () => {})()
    let retained
    retained = Object.freeze(new ResultPromise(resolve => {
      setImmediate(() => resolve({
        ordinaryInstanceOfPromise: ordinary instanceof Promise,
        ordinaryConstructorMatches: ordinary.constructor === Promise,
        ownConstructor: Object.hasOwn(retained, 'constructor'),
        instanceOfPromise: retained instanceof Promise,
        constructorMatches: retained.constructor === ResultPromise
      }))
    }))
    return retained
  `, { timeoutMs: 5_000 })
  assert.deepEqual(result, {
    ordinaryInstanceOfPromise: true,
    ordinaryConstructorMatches: true,
    ownConstructor: false,
    instanceOfPromise: true,
    constructorMatches: true
  })
})

test('signal validation uses the captured AbortSignal brand', async () => {
  const controller = new AbortController()
  const OriginalAbortSignal = globalThis.AbortSignal
  let execution
  try {
    globalThis.AbortSignal = class PoisonedAbortSignal {
      static [Symbol.hasInstance] () { throw new Error('poisoned AbortSignal') }
    }
    execution = runUntrustedCode('return 42', {
      signal: controller.signal,
      timeoutMs: 5_000
    })
  } finally {
    globalThis.AbortSignal = OriginalAbortSignal
  }
  assert.equal(await execution, 42)
})

test('createRunner snapshots reusable defaults and applies per-run overrides', async () => {
  const defaults = {
    timeoutMs: 5_000,
    environment: { PUBLIC_VALUE: 'initial' },
    resourceLimits: { stackSizeMb: 4 },
    hostFunctions: {
      tools: { value: () => 40 }
    }
  }
  const run = createRunner(defaults)
  defaults.environment.PUBLIC_VALUE = 'mutated'
  defaults.hostFunctions.tools.value = () => 0

  assert.equal(await run('return (await tools.value()) + input', { input: 2 }), 42)
  assert.equal(await run('return process.env.PUBLIC_VALUE'), 'initial')
  assert.equal(await run('return process.env.PUBLIC_VALUE', {
    environment: { PUBLIC_VALUE: 'override' }
  }), 'override')
  assert.equal('ready' in run, false)
  assert.equal('request' in run, false)
  assert.equal('terminate' in run, false)
})

test('createRunner validates defaults and keeps input and signals per-run', async () => {
  assert.throws(() => createRunner(null), /must be an object/)
  assert.throws(() => createRunner({ input: 1 }), /supplied per run/)
  assert.throws(() => createRunner({ signal: new AbortController().signal }), /supplied per run/)
  assert.throws(() => createRunner({ timeoutMs: 0 }), /positive integer/)
  assert.throws(() => createRunner({ maxMessageBytes: 127 }), /at least 128/)
  assert.throws(() => createRunner({ unknown: true }), /Unknown runner default/)
  assert.throws(
    () => createRunner({ hostFunctions: { process: { value: () => 1 } } }),
    /Reserved host function namespace/
  )

  let reads = 0
  const defaults = {}
  Object.defineProperty(defaults, 'timeoutMs', {
    enumerable: true,
    get () {
      reads++
      return 5_000
    }
  })
  assert.throws(() => createRunner(defaults), /data property/)
  assert.equal(reads, 0)

  const run = createRunner({ timeoutMs: 5_000 })
  const controller = new AbortController()
  controller.abort('test')
  Object.defineProperties(controller.signal, {
    aborted: { value: false },
    reason: { value: 'shadowed' }
  })
  await assert.rejects(
    run('return input', { input: 42, signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.cause === 'test'
  )
})

test('rejects decorated branded protocol values without invoking accessors', async () => {
  const factories = [
    () => new ArrayBuffer(8),
    () => new DataView(new ArrayBuffer(8)),
    () => new Uint8Array(2),
    () => Buffer.from([1, 2]),
    () => new Date(0),
    () => /value/gu,
    () => new Map([['value', 1]]),
    () => new Set([1])
  ]
  for (const factory of factories) {
    let reads = 0
    const value = factory()
    Object.defineProperty(value, 'authority', {
      enumerable: true,
      get () {
        reads++
        return new SharedArrayBuffer(8)
      }
    })
    await assert.rejects(
      Promise.resolve().then(() => runUntrustedCode('return input', {
        input: value,
        timeoutMs: 5_000
      })),
      /unsupported value/
    )
    assert.equal(reads, 0)
  }

  const decoratedRegExp = /value/g
  decoratedRegExp.lastIndex = new SharedArrayBuffer(8)
  await assert.rejects(
    Promise.resolve().then(() => runUntrustedCode('return input', {
      input: decoratedRegExp,
      timeoutMs: 5_000
    })),
    /unsupported value/
  )

  const constructors = [
    'new ArrayBuffer(8)',
    'new DataView(new ArrayBuffer(8))',
    'new Uint8Array(2)',
    'Buffer.from([1, 2])',
    'new Date(0)',
    '/value/gu',
    "new Map([['value', 1]])",
    'new Set([1])'
  ]
  for (const expression of constructors) {
    await assert.rejects(
      runUntrustedCode(`
        const value = ${expression}
        Object.defineProperty(value, 'authority', {
          enumerable: true,
          value: new SharedArrayBuffer(8)
        })
        return value
      `, { timeoutMs: 5_000 }),
      /(?:unsupported|not supported)/i
    )
  }
})

test('accepts genuine stateful RegExp values in both directions', async () => {
  const input = /value/gy
  input.lastIndex = 3
  const result = await runUntrustedCode(`
    const output = /answer/gy
    output.lastIndex = 4
    return {
      input: { source: input.source, flags: input.flags, lastIndex: input.lastIndex },
      output
    }
  `, { input, timeoutMs: 5_000 })
  assert.equal(input.lastIndex, 3)
  assert.deepEqual(result.input, { source: 'value', flags: 'gy', lastIndex: 0 })
  assert.equal(result.output.source, 'answer')
  assert.equal(result.output.flags, 'gy')
  assert.equal(result.output.lastIndex, 0)
})

test('rejects protocol proxies before reflective traps run', async () => {
  let prototypeReads = 0
  let ownKeyReads = 0
  const input = new Proxy({}, {
    getPrototypeOf () { prototypeReads++; throw new Error('prototype trap') },
    ownKeys () { ownKeyReads++; throw new Error('ownKeys trap') }
  })
  await assert.rejects(
    Promise.resolve().then(() => runUntrustedCode('return input', {
      input,
      timeoutMs: 5_000
    })),
    /unsupported value/
  )
  assert.equal(prototypeReads, 0)
  assert.equal(ownKeyReads, 0)
  const workerResult = await runUntrustedCode(`
    let prototypeReads = 0
    let ownKeyReads = 0
    const value = new Proxy({}, {
      getPrototypeOf () { prototypeReads++; throw new Error('prototype trap') },
      ownKeys () { ownKeyReads++; throw new Error('ownKeys trap') }
    })
    try { return value } catch {}
  `, { timeoutMs: 5_000 }).then(
    () => ({ accepted: true }),
    error => ({ message: error.message })
  )
  assert.match(workerResult.message, /unsupported/i)
})

test('proxy rejection uses the captured util.types detector', async () => {
  const utilTypes = require('node:util/types')
  const original = Object.getOwnPropertyDescriptor(utilTypes, 'isProxy')
  let prototypeReads = 0
  let ownKeyReads = 0
  const input = new Proxy({}, {
    getPrototypeOf () { prototypeReads++; throw new Error('prototype trap') },
    ownKeys () { ownKeyReads++; throw new Error('ownKeys trap') }
  })
  try {
    Object.defineProperty(utilTypes, 'isProxy', {
      ...original,
      value: () => false
    })
    syncBuiltinESMExports()
    await assert.rejects(
      Promise.resolve().then(() => runUntrustedCode('return input', {
        input,
        timeoutMs: 5_000
      })),
      /unsupported value/
    )
  } finally {
    Object.defineProperty(utilTypes, 'isProxy', original)
    syncBuiltinESMExports()
  }
  assert.equal(prototypeReads, 0)
  assert.equal(ownKeyReads, 0)
})

test('DataView validation uses captured host and worker prototypes', async () => {
  const NativeDataView = globalThis.DataView
  const input = new NativeDataView(Uint8Array.from([42]).buffer)
  let execution
  try {
    globalThis.DataView = class PoisonedDataView {}
    execution = runUntrustedCode('return input.getUint8(0)', {
      input,
      timeoutMs: 5_000
    })
  } finally {
    globalThis.DataView = NativeDataView
  }
  assert.equal(await execution, 42)

  const output = await runUntrustedCode(`
    const NativeDataView = DataView
    const value = new NativeDataView(Uint8Array.from([43]).buffer)
    globalThis.DataView = class PoisonedDataView {}
    return value
  `, { timeoutMs: 5_000 })
  assert.equal(output instanceof NativeDataView, true)
  assert.equal(output.getUint8(0), 43)
})

test('rejects oversized views before enumerating indexed descriptors', async () => {
  const value = new Uint8Array(1024 * 1024)
  let getterReads = 0
  Object.defineProperty(value, 'authority', {
    enumerable: true,
    get () { getterReads++; throw new Error('authority getter') }
  })
  await assert.rejects(
    Promise.resolve().then(() => runUntrustedCode('return input', {
      input: value,
      maxInputBytes: 128,
      timeoutMs: 5_000
    })),
    /maxInputBytes/
  )
  assert.equal(getterReads, 0)

  await assert.rejects(
    runUntrustedCode('return new Uint8Array(1024 * 1024)', {
      maxMessageBytes: 1_000,
      timeoutMs: 5_000
    }),
    /maxMessageBytes/
  )
})

test('protocol traversal budgets bound every structural category before cloning', () => {
  const expectBudget = (value, maxBytes = 128) => {
    assert.throws(
      () => assertSupportedProtocolSource(value, 'input', maxBytes, 'maxInputBytes'),
      /input exceeds maxInputBytes/
    )
  }

  expectBudget('x'.repeat(129))

  let getterReads = 0
  const manyProperties = {}
  for (let index = 0; index < 129; index++) manyProperties[`property${index}`] = index
  Object.defineProperty(manyProperties, 'authority', {
    enumerable: true,
    get () { getterReads++; return new SharedArrayBuffer(8) }
  })
  expectBudget(manyProperties)
  assert.equal(getterReads, 0)

  const forbidden = new SharedArrayBuffer(8)
  expectBudget(new Map(Array.from({ length: 65 }, (_, index) => [index, forbidden])))
  expectBudget(new Set(Array.from({ length: 129 }, (_, index) => index)))

  const shared = {}
  expectBudget(Array.from({ length: 129 }, () => shared))

  let deep = {}
  for (let index = 0; index < 128; index++) deep = { next: deep }
  expectBudget(deep)

  expectBudget(new Uint8Array(129))
})

test('protocol budgets cumulatively charge unique backing ArrayBuffers', async () => {
  const first = new ArrayBuffer(160)
  const second = new ArrayBuffer(160)
  assert.throws(
    () => assertSupportedProtocolSource([first, second], 'input', 256, 'maxInputBytes'),
    /input exceeds maxInputBytes/
  )
  await assert.rejects(
    async () => runUntrustedCode('return input', {
      input: [first, second],
      maxInputBytes: 256,
      timeoutMs: 5_000
    }),
    /maxInputBytes/
  )

  const shared = new ArrayBuffer(160)
  const sharedViews = [
    new Uint8Array(shared, 0, 80),
    new Uint8Array(shared, 80, 80)
  ]
  assert.doesNotThrow(() => {
    assertSupportedProtocolSource(sharedViews, 'input', 256, 'maxInputBytes')
  })
  assert.deepEqual(
    await runUntrustedCode('return input.map(view => view.byteLength)', {
      input: sharedViews,
      maxInputBytes: 256,
      timeoutMs: 5_000
    }),
    [80, 80]
  )

  await assert.rejects(
    runUntrustedCode('return [new ArrayBuffer(160), new ArrayBuffer(160)]', {
      maxMessageBytes: 256,
      timeoutMs: 5_000
    }),
    /(?:maxMessageBytes|Worker protocol failure)/
  )
  assert.deepEqual(
    await runUntrustedCode(`
      const backing = new ArrayBuffer(160)
      return [new Uint8Array(backing, 0, 80), new Uint8Array(backing, 80, 80)]
    `, {
      maxMessageBytes: 256,
      timeoutMs: 5_000
    }).then(views => views.map(view => view.byteLength)),
    [80, 80]
  )
})

test('protocol traversal budgets preserve fitting sparse, cyclic, and branded values', () => {
  const sparse = []
  sparse[100_000] = 'value'
  const cycle = { empty: '', unicode: 'π🙂', sparse }
  cycle.self = cycle
  cycle.sharedA = sparse
  cycle.sharedB = sparse
  cycle.map = new Map([['answer', 42]])
  cycle.set = new Set(['value'])
  cycle.regexp = /value/gy
  cycle.regexp.lastIndex = 3
  for (const value of [
    '',
    'π🙂',
    sparse,
    cycle,
    new Map([['answer', 42]]),
    new Set(['value']),
    cycle.regexp
  ]) {
    const maxBytes = serialize(value).byteLength
    assert.doesNotThrow(() => {
      assertSupportedProtocolSource(value, 'input', maxBytes, 'maxInputBytes')
    })
  }
})

test('protocol traversal uses captured size and reflection intrinsics', (t) => {
  const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')
  const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')
  const ownKeys = Reflect.ownKeys
  const descriptors = Object.getOwnPropertyDescriptors
  t.after(() => {
    Object.defineProperty(Map.prototype, 'size', mapSize)
    Object.defineProperty(Set.prototype, 'size', setSize)
    Reflect.ownKeys = ownKeys
    Object.getOwnPropertyDescriptors = descriptors
  })
  const value = { map: new Map([['answer', 42]]), set: new Set([43]) }
  const maxBytes = serialize(value).byteLength
  try {
    Object.defineProperty(Map.prototype, 'size', {
      configurable: true,
      get () { throw new Error('poisoned Map size') }
    })
    Object.defineProperty(Set.prototype, 'size', {
      configurable: true,
      get () { throw new Error('poisoned Set size') }
    })
    Reflect.ownKeys = () => { throw new Error('poisoned Reflect.ownKeys') }
    Object.getOwnPropertyDescriptors = () => {
      throw new Error('poisoned Object.getOwnPropertyDescriptors')
    }
    assert.doesNotThrow(() => {
      assertSupportedProtocolSource(value, 'input', maxBytes, 'maxInputBytes')
    })
  } finally {
    Object.defineProperty(Map.prototype, 'size', mapSize)
    Object.defineProperty(Set.prototype, 'size', setSize)
    Reflect.ownKeys = ownKeys
    Object.getOwnPropertyDescriptors = descriptors
  }
})

test('caller option poisoning cannot redirect captured global receivers', async () => {
  const source = `
    import { runUntrustedCode } from ${JSON.stringify(packageUrl)}
    const defineProperty = Object.defineProperty
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
    const ownKeys = Reflect.ownKeys
    const promiseThen = Promise.prototype.then
    const stringify = JSON.stringify
    const names = ['Date', 'Buffer', 'Object', 'Array', 'ArrayBuffer', 'Number', 'JSON']
    const originals = names.map(name => [name, getOwnPropertyDescriptor(globalThis, name)])
    let reads = 0
    const restore = () => {
      for (const [name, descriptor] of originals) defineProperty(globalThis, name, descriptor)
    }
    const optionsTarget = { timeoutMs: 5000 }
    const options = new Proxy(optionsTarget, {
      ownKeys () {
        for (const [name, descriptor] of originals) {
          defineProperty(globalThis, name, {
            configurable: true,
            enumerable: descriptor.enumerable,
            get () { reads++; throw new Error('read poisoned global ' + name) }
          })
        }
        return ownKeys(optionsTarget)
      }
    })
    let execution
    try {
      execution = runUntrustedCode('return 42', options)
    } catch (error) {
      restore()
      process.stdout.write(stringify({ error: error.message, reads }))
      process.exit(0)
    }
    Reflect.apply(promiseThen, execution, [
      (value) => {
        restore()
        process.stdout.write(stringify({ value, reads }))
      },
      (error) => {
        restore()
        process.stdout.write(stringify({ error: error.message, reads }))
      }
    ])
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    timeout: 10_000
  })
  assert.deepEqual(JSON.parse(stdout), { value: 42, reads: 0 })
})

test('prototype-specific then pollution cannot assimilate branded results', async () => {
  const source = `
    import { runUntrustedCode } from ${JSON.stringify(packageUrl)}
    const promiseThen = Promise.prototype.then
    const defineProperty = Object.defineProperty
    const deleteProperty = Reflect.deleteProperty
    const stringify = JSON.stringify
    let calls = 0
    defineProperty(Map.prototype, 'then', {
      configurable: true,
      value (resolve) { calls++; if (typeof resolve === 'function') resolve('assimilated') }
    })
    const execution = runUntrustedCode("return new Map([['answer', 42]])", { timeoutMs: 5000 })
    Reflect.apply(promiseThen, execution, [
      (value) => {
        deleteProperty(Map.prototype, 'then')
        process.stdout.write(stringify({ answer: value.get('answer'), calls }))
      },
      (error) => {
        deleteProperty(Map.prototype, 'then')
        process.stdout.write(stringify({ error: error.message, calls }))
      }
    ])
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    timeout: 10_000
  })
  assert.deepEqual(JSON.parse(stdout), { answer: 42, calls: 0 })
})

test('protocol validation never resolves mutable global constructor bindings', async () => {
  const names = ['ArrayBuffer', 'Array', 'Object', 'Number']
  const defineProperty = Object.defineProperty
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  const originals = names.map(name => [name, getOwnPropertyDescriptor(globalThis, name)])
  let hostReads = 0
  try {
    for (const [name] of originals) {
      defineProperty(globalThis, name, {
        configurable: true,
        get () { hostReads++; throw new Error(`read global ${name}`) }
      })
    }
    assert.doesNotThrow(() => {
      assertSupportedProtocolSource([{ value: 42 }], 'input', 128, 'maxInputBytes')
    })
  } finally {
    for (const [name, descriptor] of originals) defineProperty(globalThis, name, descriptor)
  }
  assert.equal(hostReads, 0)

  const result = await runUntrustedCode(`
    const defineProperty = Object.defineProperty
    const create = Object.create
    let reads = 0
    for (const name of ['ArrayBuffer', 'Array', 'Object', 'Number']) {
      defineProperty(globalThis, name, {
        configurable: true,
        get () { reads++; throw new Error('read global ' + name) }
      })
    }
    const output = create(null)
    output.reads = reads
    output.value = 42
    return output
  `, { timeoutMs: 5_000, maxMessageBytes: 128 })
  assert.deepEqual({ ...result }, { reads: 0, value: 42 })
})

test('descriptor validation ignores polluted Object.prototype.value for host options', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 4 }))
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value')
  const restore = () => {
    if (original) Object.defineProperty(Object.prototype, 'value', original)
    else delete Object.prototype.value
  }
  t.after(restore)

  for (const pollution of ['data', 'accessor']) {
    let optionReads = 0
    let prototypeReads = 0
    if (pollution === 'data') {
      Object.defineProperty(Object.prototype, 'value', {
        configurable: true,
        value: 5_000,
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
    const optionDescriptor = Object.create(null)
    optionDescriptor.enumerable = true
    optionDescriptor.get = () => {
      optionReads++
      return 5_000
    }
    const options = Object.defineProperty({}, 'timeoutMs', optionDescriptor)
    assert.throws(
      () => runUntrustedCode('return 42', options),
      /timeoutMs must be an enumerable data property/
    )
    assert.equal(optionReads, 0)
    assert.equal(prototypeReads, 0)

    let inputReads = 0
    const inputDescriptor = Object.create(null)
    inputDescriptor.enumerable = true
    inputDescriptor.get = () => {
      inputReads++
      return new SharedArrayBuffer(8)
    }
    const input = Object.defineProperty({}, 'authority', inputDescriptor)
    assert.throws(
      () => runUntrustedCode('return input', {
        input,
        timeoutMs: 5_000
      }),
      /input must contain only enumerable data properties/
    )
    assert.equal(inputReads, 0)
    assert.equal(prototypeReads, 0)

    restore()
    assert.equal(await runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
  }
})

test('returns a structured-cloneable result', async () => {
  const result = await runUntrustedCode('return { total: input.left + input.right }', {
    input: { left: 20, right: 22 },
    timeoutMs: 5_000
  })
  assert.deepEqual(result, { total: 42 })
})

test('validates protocol object semantics before structured cloning', async () => {
  class AuthorityBearingValue {
    constructor () {
      this.value = 42
    }
  }
  assert.throws(
    () => runUntrustedCode('return input', { input: new AuthorityBearingValue() }),
    /unsupported value/
  )
  class AuthorityMap extends Map {}
  assert.throws(
    () => runUntrustedCode('return input', { input: new AuthorityMap([['value', 42]]) }),
    /unsupported value/
  )
  await assert.rejects(
    runUntrustedCode(`
      class AuthorityBearingValue {
        constructor () { this.value = 42 }
      }
      return new AuthorityBearingValue()
    `, { timeoutMs: 5_000 }),
    /unsupported/i
  )
  await assert.rejects(
    runUntrustedCode(`
      class AuthorityBearingValue {
        constructor () { this.value = 42 }
      }
      const value = new AuthorityBearingValue()
      const NativeWeakSet = WeakSet
      globalThis.WeakSet = class extends NativeWeakSet {
        constructor () { super([value]) }
      }
      return value
    `, { timeoutMs: 5_000 }),
    /unsupported/i
  )
  await assert.rejects(
    runUntrustedCode(`
      class AuthorityBearingValue {
        constructor () { this.value = 42 }
      }
      const value = { nested: new AuthorityBearingValue() }
      Array.prototype[Symbol.iterator] = function * () {}
      return value
    `, { timeoutMs: 5_000 }),
    /unsupported/i
  )

  const nativeWeakSet = globalThis.WeakSet
  const value = new AuthorityBearingValue()
  globalThis.WeakSet = class extends nativeWeakSet {
    constructor () { super([value]) }
  }
  try {
    assert.throws(
      () => runUntrustedCode('return input', { input: value }),
      /unsupported value/
    )
  } finally {
    globalThis.WeakSet = nativeWeakSet
  }

  let reads = 0
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get () {
      reads++
      return 42
    }
  })
  assert.throws(
    () => runUntrustedCode('return input', { input: accessor }),
    /enumerable data properties/
  )
  assert.equal(reads, 0)

  const nullPrototype = Object.create(null)
  nullPrototype.value = 42
  assert.deepEqual(
    await runUntrustedCode('return { value: input.value, ordinary: Object.getPrototypeOf(input) === Object.prototype }', {
      input: nullPrototype,
      timeoutMs: 5_000
    }),
    { value: 42, ordinary: true }
  )
})

test('preserves the one-shot source binding contract', async () => {
  assert.deepEqual(await runUntrustedCode(`
    if (typeof postToHost === 'function') {
      postToHost({ type: 'ready', value: 'spoofed' })
    }
    const send = 1
    const onMessage = 2
    const host = 3
    return {
      send,
      onMessage,
      host,
      port: typeof port,
      postToHost: typeof postToHost,
      protocolSecret: typeof protocolSecret
    }
  `, { timeoutMs: 5_000 }), {
    send: 1,
    onMessage: 2,
    host: 3,
    port: 'undefined',
    postToHost: 'undefined',
    protocolSecret: 'undefined'
  })
})

test('supports asynchronous source', async () => {
  const result = await runUntrustedCode(`
    await new Promise((resolve) => setTimeout(resolve, 10))
    return input * 2
  `, { input: 21, timeoutMs: 5_000 })
  assert.equal(result, 42)
})

test('starts with a minimal explicit environment', async () => {
  process.env.SECURE_EVAL_WORKER_SECRET = 'do-not-copy'
  try {
    const result = await runUntrustedCode(`
      return {
        inherited: process.env.SECURE_EVAL_WORKER_SECRET,
        allowed: process.env.PUBLIC_VALUE,
        names: Object.keys(process.env).sort()
      }
    `, {
      environment: { PUBLIC_VALUE: 'visible' },
      timeoutMs: 5_000
    })
    assert.deepEqual(result, {
      inherited: undefined,
      allowed: 'visible',
      names: ['PUBLIC_VALUE']
    })
  } finally {
    delete process.env.SECURE_EVAL_WORKER_SECRET
  }
})

test('ignores inherited one-shot capabilities and limits', async () => {
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
    maxOutputMessages: Number.MAX_SAFE_INTEGER,
    timeoutMs: 0
  })
  options.timeoutMs = 5_000

  assert.equal(await runUntrustedCode('return typeof secrets', options), 'undefined')
  assert.equal(calls, 0)
})

test('does not invoke accessors in nested one-shot worker options', () => {
  let environmentReads = 0
  let resourceLimitReads = 0
  const environment = {}
  Object.defineProperty(environment, 'PUBLIC_VALUE', {
    enumerable: true,
    get () {
      environmentReads++
      return 'visible'
    }
  })
  const resourceLimits = {}
  Object.defineProperty(resourceLimits, 'stackSizeMb', {
    enumerable: true,
    get () {
      resourceLimitReads++
      return 4
    }
  })

  assert.throws(
    () => runUntrustedCode('return 42', { environment }),
    /enumerable data property/
  )
  assert.throws(
    () => runUntrustedCode('return 42', { resourceLimits }),
    /enumerable data property/
  )
  assert.equal(environmentReads, 0)
  assert.equal(resourceLimitReads, 0)
})

test('rejects environment variables that can alter the runtime', () => {
  assert.throws(
    () => sanitizeEnvironment({ NODE_OPTIONS: '--import=./hostile.js' }),
    /not allowed/
  )
  assert.throws(
    () => sanitizeEnvironment({ LD_PRELOAD: '/tmp/hostile.so' }),
    /not allowed/
  )
  for (const name of ['NODE_CHANNEL_FD', 'NODE_ICU_DATA', 'NODE_V8_COVERAGE']) {
    assert.throws(
      () => sanitizeEnvironment({ [name]: 'hostile' }),
      /not allowed/
    )
  }
  assert.equal(sanitizeEnvironment({ NODE_ENV: 'production' }).NODE_ENV, 'production')
})

test('drops the worker permission before running source', async () => {
  const permissions = await runUntrustedCode(`
    return {
      modelEnabled: typeof process.permission?.has === 'function',
      worker: process.permission.has('worker'),
      read: process.permission.has('fs.read'),
      write: process.permission.has('fs.write'),
      child: process.permission.has('child'),
      network: process.permission.has('net')
    }
  `, { timeoutMs: 5_000 })

  assert.deepEqual(permissions, {
    modelEnabled: true,
    worker: false,
    read: false,
    write: false,
    child: false,
    network: false
  })
})

test('denies filesystem access', async () => {
  await assert.rejects(
    runUntrustedCode(`
      const fs = await import('node:fs/promises')
      return fs.readFile(${JSON.stringify(process.execPath)}, 'utf8')
    `, { timeoutMs: 5_000 }),
    (error) => error instanceof UntrustedCodeError && error.remoteCode === 'ERR_ACCESS_DENIED'
  )
})

test('denies child processes, network access, and the inspector', async (t) => {
  const cases = [
    {
      name: 'child process',
      source: `
        const { spawn } = await import('node:child_process')
        spawn(process.execPath, ['--version'])
      `
    },
    {
      name: 'network',
      source: `
        const { connect } = await import('node:net')
        await new Promise((resolve, reject) => {
          const socket = connect(80, 'example.com', resolve)
          socket.once('error', reject)
        })
      `
    },
    {
      name: 'inspector',
      source: `
        const inspector = await import('node:inspector')
        inspector.open(0)
      `
    }
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await assert.rejects(
        runUntrustedCode(entry.source, { timeoutMs: 5_000 }),
        (error) => error.remoteCode === 'ERR_ACCESS_DENIED'
      )
    })
  }
})

test('denies nested workers after permission.drop()', async () => {
  await assert.rejects(
    runUntrustedCode(`
      const { Worker } = await import('node:worker_threads')
      return new Worker('0', { eval: true })
    `, { timeoutMs: 5_000 }),
    (error) => error instanceof UntrustedCodeError && error.remoteCode === 'ERR_ACCESS_DENIED'
  )
})

test('does not expose the one-shot control channel through parentPort', async () => {
  const result = await runUntrustedCode(`
    const { parentPort } = await import('node:worker_threads')
    return { parentPort, value: 'real' }
  `, { timeoutMs: 5_000 })

  assert.deepEqual(result, { parentPort: null, value: 'real' })
})

test('terminates source that exceeds its deadline', async () => {
  await assert.rejects(
    runUntrustedCode('while (true) {}', { timeoutMs: 100 }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_TIMEOUT'
  )
})

test('termination settlement is bounded during uninterruptible native work', async () => {
  const childSource = `
    import {
      configureWorkerAdmission,
      createUntrustedWorker,
      runUntrustedCode
    } from ${JSON.stringify(packageUrl)}
    configureWorkerAdmission({ maxConcurrentWorkers: 1 })
    const session = createUntrustedWorker(\`
      const { pbkdf2Sync } = await import('node:crypto')
      onMessage(() => {
        send('native-started')
        pbkdf2Sync('password', 'salt', 1_000_000_000, 32, 'sha256')
      })
    \`, {
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 30_000
    })
    await session.ready
    const enteredNativeWork = new Promise((resolve) => session.once('message', resolve))
    session.postMessage(null)
    await enteredNativeWork
    // The marker is posted immediately before the native call. Observe enough
    // additional process CPU to prove the worker entered CPU-bound native work;
    // the main thread sleeps between samples and has no other active work.
    const baselineCpu = process.cpuUsage()
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const usage = process.cpuUsage(baselineCpu)
      if (usage.user + usage.system >= 100_000) break
    }
    const startedAt = Date.now()
    let code
    try {
      await session.terminate()
    } catch (error) {
      code = error.code
    }
    let retainedCode
    try {
      await runUntrustedCode('return 42', { timeoutMs: 500 })
    } catch (error) {
      retainedCode = error.code
    }
    console.log(JSON.stringify({
      code,
      elapsedMs: Date.now() - startedAt,
      retainedCode
    }))
  `
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Child did not report bounded settlement: ${stderr}`))
    }, 5_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const newlineIndex = stdout.indexOf('\n')
      if (newlineIndex < 0) return
      const line = stdout.slice(0, newlineIndex).trim()
      if (!line) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(line))
      } catch (error) {
        reject(error)
      }
      child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  assert.equal(result.code, 'ERR_UNTRUSTED_WORKER_TERMINATION_TIMEOUT')
  assert.equal(result.retainedCode, 'ERR_UNTRUSTED_CODE_CAPACITY')
  assert.ok(result.elapsedMs >= 1_000 && result.elapsedMs < 4_000)
})

test('supports cancellation', async () => {
  const controller = new AbortController()
  const result = runUntrustedCode('await new Promise(() => {})', {
    signal: controller.signal,
    timeoutMs: 5_000
  })
  controller.abort('test')
  await assert.rejects(result, (error) => error.name === 'AbortError')
})

test('includes synchronous input validation and cloning in the deadline', async () => {
  const input = Array.from({ length: 200_000 }, (_, index) => index)

  await assert.rejects(
    runUntrustedCode('return input.length', {
      input,
      maxInputBytes: 16 * 1024 * 1024,
      timeoutMs: 1
    }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_TIMEOUT'
  )
})

test('rejects every supported shared-memory representation in input and output', async (t) => {
  const sharedBuffer = new SharedArrayBuffer(8)
  const sharedMemory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true
  })
  for (const input of [
    sharedBuffer,
    sharedMemory,
    new Uint8Array(sharedBuffer),
    new DataView(sharedBuffer)
  ]) {
    assert.throws(
      () => runUntrustedCode('return input', { input }),
      /must not contain shared memory/
    )
  }

  const outputSources = {
    SharedArrayBuffer: 'return new SharedArrayBuffer(8)',
    'shared WebAssembly.Memory': `
      return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
    `,
    'shared typed array': 'return new Uint8Array(new SharedArrayBuffer(8))',
    'shared DataView': 'return new DataView(new SharedArrayBuffer(8))'
  }
  for (const [name, source] of Object.entries(outputSources)) {
    await t.test(`${name} result`, async () => {
      await assert.rejects(
        runUntrustedCode(source, { timeoutMs: 5_000 }),
        /must not contain shared memory/
      )
    })
  }
})

test('one-shot runtime errors use stable source coordinates without bootstrap frames', async () => {
  await assert.rejects(
    runUntrustedCode(`const value = 1
//# sourceURL=hostile.js
throw new Error('located')`, { timeoutMs: 5_000 }),
    (error) => {
      assert.equal(error.remoteStack, [
        'Error: located',
        '    at eval (secure-eval-worker-one-shot.js:3:7)'
      ].join('\n'))
      assert.doesNotMatch(error.remoteStack, /worker eval|trustedBootstrap|hostile\.js/)
      return true
    }
  )
})

test('remote error metadata escapes control characters', async () => {
  await assert.rejects(
    runUntrustedCode(`
      const error = new Error('line one\\n\\u001b[31mline two')
      error.name = 'Bad\\rName'
      error.code = 'BAD\\u0000CODE'
      throw error
    `, { timeoutMs: 5_000 }),
    (error) => {
      assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(error.message), false)
      assert.equal(
        error.message,
        'Bad\\u000dName: line one\\u000a\\u001b[31mline two'
      )
      assert.equal(error.remoteCode, 'BAD\\u0000CODE')
      assert.equal(error.remoteStack.includes('\u001b'), false)
      return true
    }
  )
})

test('remote stacks remain bounded sanitized untrusted diagnostics', async () => {
  await assert.rejects(
    runUntrustedCode(`
      const error = new Error('real')
      error.stack = 'Error: forged\\n    at fake (secure-eval-worker-one-shot.js:100:1)\\u001b[31m'
      throw error
    `, { timeoutMs: 5_000 }),
    (error) => {
      assert.match(error.remoteStack, /secure-eval-worker-one-shot\.js:97:1/)
      assert.equal(error.remoteStack.includes('\\u001b[31m'), true)
      assert.doesNotMatch(error.remoteStack, /\u001b/)
      return true
    }
  )
})

test('JavaScript syntax that is valid TypeScript still receives exact coordinates', async () => {
  await assert.rejects(
    runUntrustedCode('const value: number = 42', { timeoutMs: 5_000 }),
    (error) => {
      assert.match(
        error.remoteStack,
        /secure-eval-worker-one-shot\.syntax\.js:1:12/
      )
      return true
    }
  )
})

test('reports syntax, runtime, and clone errors', async (t) => {
  await t.test('syntax error', async () => {
    await assert.rejects(
      runUntrustedCode('const value = ;', { timeoutMs: 5_000 }),
      (error) => {
        assert.match(error.message, /SyntaxError/)
        assert.match(error.remoteStack, /secure-eval-worker-one-shot\.syntax\.js:1/)
        return true
      }
    )
  })

  await t.test('runtime error', async () => {
    await assert.rejects(
      runUntrustedCode('throw new TypeError("bad input")', { timeoutMs: 5_000 }),
      /TypeError: bad input/
    )
  })

  await t.test('unsupported result', async () => {
    await assert.rejects(
      runUntrustedCode('return () => {}', { timeoutMs: 5_000 }),
      /unsupported/i
    )
  })
})

test('validates source and options', async () => {
  assert.throws(() => runUntrustedCode(null), /source must be a string/)
  assert.throws(
    () => runUntrustedCode('return 1', { timeoutMS: 1 }),
    /Unknown option: timeoutMS/
  )
  const nativeArrayIterator = Array.prototype[Symbol.iterator]
  const nativeSetHas = Set.prototype.has
  const hostileOptions = new Proxy({}, {
    ownKeys () {
      Array.prototype[Symbol.iterator] = function * () {}
      Set.prototype.has = () => true
      return ['timeoutMS']
    },
    getOwnPropertyDescriptor () {
      return { configurable: true, enumerable: true, value: 1, writable: true }
    }
  })
  try {
    assert.throws(
      () => runUntrustedCode('return 1', hostileOptions),
      /Unknown option: timeoutMS/
    )
  } finally {
    Array.prototype[Symbol.iterator] = nativeArrayIterator
    Set.prototype.has = nativeSetHas
  }
  const nativeIsSafeInteger = Number.isSafeInteger
  const hostileLimit = new Proxy({}, {
    ownKeys () {
      Number.isSafeInteger = () => true
      return ['maxMessageBytes']
    },
    getOwnPropertyDescriptor () {
      return { configurable: true, enumerable: true, value: Number.NaN, writable: true }
    }
  })
  try {
    assert.throws(
      () => runUntrustedCode('return 1', hostileLimit),
      /positive integer/
    )
  } finally {
    Number.isSafeInteger = nativeIsSafeInteger
  }
  const runner = createRunner()
  assert.throws(
    () => runner('return 1', { maxInputByte: 1 }),
    /Unknown option: maxInputByte/
  )
  assert.throws(() => runUntrustedCode('return 1', { timeoutMs: 0 }), /positive integer/)
  assert.throws(
    () => runUntrustedCode('return 1', { timeoutMs: 2_147_483_648 }),
    /must not exceed/
  )
  assert.throws(
    () => runUntrustedCode('return 1', { environment: { VALUE: 1 } }),
    /must be a string/
  )
  assert.throws(
    () => runUntrustedCode('return 123', { maxSourceBytes: 2 }),
    /exceeds maxSourceBytes/
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runUntrustedCode('return 1', { signal: controller.signal }),
    (error) => error.name === 'AbortError'
  )
})
