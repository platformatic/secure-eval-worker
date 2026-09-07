import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createRunner,
  runUntrustedCode,
  sanitizeEnvironment,
  UntrustedCodeError
} from '../src/index.js'

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
  await assert.rejects(
    run('return input', { input: 42, signal: controller.signal }),
    (error) => error.name === 'AbortError'
  )
})

test('returns a structured-cloneable result', async () => {
  const result = await runUntrustedCode('return { total: input.left + input.right }', {
    input: { left: 20, right: 22 },
    timeoutMs: 5_000
  })
  assert.deepEqual(result, { total: 42 })
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
      return fs.readFile('/etc/passwd', 'utf8')
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

test('supports cancellation', async () => {
  const controller = new AbortController()
  const result = runUntrustedCode('await new Promise(() => {})', {
    signal: controller.signal,
    timeoutMs: 5_000
  })
  controller.abort('test')
  await assert.rejects(result, (error) => error.name === 'AbortError')
})

test('does not lose an abort triggered while cloning input', async () => {
  const controller = new AbortController()
  const input = {
    get value () {
      controller.abort('during clone')
      return 42
    }
  }

  await assert.rejects(
    runUntrustedCode('return input.value', {
      input,
      signal: controller.signal,
      timeoutMs: 5_000
    }),
    (error) => error.name === 'AbortError'
  )
})

test('includes synchronous input cloning in the deadline', async () => {
  const input = {
    get slow () {
      const end = Date.now() + 50
      while (Date.now() < end) {}
      return true
    }
  }

  await assert.rejects(
    runUntrustedCode('return input.slow', { input, timeoutMs: 10 }),
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

  await t.test('non-cloneable result', async () => {
    await assert.rejects(
      runUntrustedCode('return () => {}', { timeoutMs: 5_000 }),
      /DataCloneError/
    )
  })
})

test('validates source and options', async () => {
  assert.throws(() => runUntrustedCode(null), /source must be a string/)
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
