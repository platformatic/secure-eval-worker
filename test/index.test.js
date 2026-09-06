import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  runUntrustedCode,
  sanitizeEnvironment,
  UntrustedCodeError
} from '../src/index.js'

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
  `), {
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

test('normalizes one-shot worker options only once', async () => {
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

  assert.equal(await runUntrustedCode('return process.env.PUBLIC_VALUE', {
    environment,
    resourceLimits,
    timeoutMs: 5_000
  }), 'visible')
  assert.equal(environmentReads, 1)
  assert.equal(resourceLimitReads, 1)
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

test('reports syntax, runtime, and clone errors', async (t) => {
  await t.test('syntax error', async () => {
    await assert.rejects(
      runUntrustedCode('return }', { timeoutMs: 5_000 }),
      /SyntaxError/
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
