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

test('rejects environment variables that can alter the runtime', () => {
  assert.throws(
    () => sanitizeEnvironment({ NODE_OPTIONS: '--import=./hostile.js' }),
    /not allowed/
  )
  assert.throws(
    () => sanitizeEnvironment({ LD_PRELOAD: '/tmp/hostile.so' }),
    /not allowed/
  )
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

test('rejects spoofed parent-port messages', async () => {
  await assert.rejects(
    runUntrustedCode(`
      const { parentPort } = await import('node:worker_threads')
      parentPort.postMessage({ type: 'result', value: 'spoofed' })
      return 'real'
    `, { timeoutMs: 5_000 }),
    (error) => error.code === 'ERR_UNTRUSTED_CODE_PROTOCOL'
  )
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

test('rejects shared memory in input and output', async (t) => {
  const sharedMemory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true
  })

  assert.throws(
    () => runUntrustedCode('return input', { input: new SharedArrayBuffer(8) }),
    /must not contain shared memory/
  )
  assert.throws(
    () => runUntrustedCode('return input', { input: sharedMemory }),
    /must not contain shared memory/
  )

  await t.test('SharedArrayBuffer result', async () => {
    await assert.rejects(
      runUntrustedCode('return new SharedArrayBuffer(8)', { timeoutMs: 5_000 }),
      /must not contain shared memory/
    )
  })

  await t.test('shared WebAssembly.Memory result', async () => {
    await assert.rejects(
      runUntrustedCode(`
        return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
      `, { timeoutMs: 5_000 }),
      /must not contain shared memory/
    )
  })
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
