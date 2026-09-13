import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'

import {
  createUntrustedWorker,
  createUntrustedWorkerFromFile,
  runUntrustedCode,
  runUntrustedFile
} from '../src/index.js'

const SECURITY_TIMEOUTS = {
  startupTimeoutMs: 5_000,
  messageTimeoutMs: 5_000,
  lifetimeTimeoutMs: 5_000
}

async function evaluateInGuest (type, source, options = {}) {
  if (type === 'one-shot') {
    return runUntrustedCode(source, { timeoutMs: 5_000, ...options })
  }

  if (type === 'file-one-shot' || type === 'file-module') {
    const root = fs.mkdtempSync(join(tmpdir(), 'secure-eval-security-files-'))
    const entry = join(root, 'entry.mjs')
    const fileSource = type === 'file-one-shot'
      ? `export default async () => { ${source} }`
      : `export default async ({ onMessage }) => {
          const result = await (async () => { ${source} })()
          onMessage(() => result)
        }`
    fs.writeFileSync(entry, fileSource)
    try {
      if (type === 'file-one-shot') {
        return await runUntrustedFile(entry, {
          rootDirectory: root,
          timeoutMs: 5_000,
          ...options
        })
      }
      const session = await createUntrustedWorkerFromFile(entry, {
        rootDirectory: root,
        ...SECURITY_TIMEOUTS,
        ...options
      })
      try {
        await session.ready
        return await session.request(null)
      } finally {
        await session.terminate()
        await session.closed
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  }

  const componentSource = type === 'script'
    ? `
      const __securityResult = await (async () => { ${source} })()
      onMessage(() => __securityResult)
    `
    : `export default async ({ onMessage }) => {
      const result = await (async () => { ${source} })()
      onMessage(() => result)
    }`
  const session = createUntrustedWorker(componentSource, {
    type: type === 'module' ? 'module' : 'script',
    ...SECURITY_TIMEOUTS,
    ...options
  })
  try {
    await session.ready
    return await session.request(null)
  } finally {
    await session.terminate()
  }
}

const EXECUTION_TYPES = ['one-shot', 'script', 'module', 'file-one-shot', 'file-module']

for (const type of EXECUTION_TYPES) {
  test(`${type} cannot read files through node:sqlite`, async (t) => {
    const path = join(tmpdir(), `secure-eval-worker-${randomUUID()}.db`)
    const database = new DatabaseSync(path)
    database.exec("CREATE TABLE secrets (value TEXT); INSERT INTO secrets VALUES ('sqlite-secret')")
    database.close()
    t.after(() => fs.rmSync(path, { force: true }))

    const code = await evaluateInGuest(type, `
      try {
        const { DatabaseSync } = await import('node:sqlite')
        const database = new DatabaseSync(${JSON.stringify(path)}, { readOnly: true })
        return database.prepare('SELECT value FROM secrets').get().value
      } catch (error) {
        return error.code
      }
    `)
    assert.equal(code, 'ERR_ACCESS_DENIED')
  })

  test(`${type} cannot use host file descriptors`, async (t) => {
    const path = join(tmpdir(), `secure-eval-worker-${randomUUID()}.txt`)
    fs.writeFileSync(path, 'file-descriptor-secret')
    const descriptor = fs.openSync(path, 'r')
    t.after(() => {
      fs.closeSync(descriptor)
      fs.rmSync(path, { force: true })
    })

    const loaderSource = `
      export async function resolve (specifier, context, nextResolve) {
        if (specifier !== 'escape:fd') return nextResolve(specifier, context)
        const fs = await import('node:fs')
        const value = fs.readFileSync(${descriptor}, 'utf8')
        return {
          shortCircuit: true,
          url: 'data:text/javascript,' + encodeURIComponent(
            'export default ' + JSON.stringify(value)
          )
        }
      }
    `
    const codes = await evaluateInGuest(type, `
      const attempts = [
        async () => (await import('node:fs')).readFileSync(${descriptor}, 'utf8'),
        async () => new (await import('node:fs')).ReadStream(null, {
          fd: ${descriptor}, autoClose: false
        }),
        async () => new (await import('node:fs')).WriteStream(null, {
          fd: ${descriptor}, autoClose: false
        }),
        async () => process.binding('fs'),
        async () => process._linkedBinding('fs'),
        async () => process.dlopen({}, process.execPath),
        async () => {
          const { register } = await import('node:module')
          register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loaderSource)}))
          return (await import('escape:fd')).default
        },
        async () => {
          const { Module } = await import('node:module')
          Module.register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loaderSource)}))
          return (await import('escape:fd')).default
        },
        async () => {
          const module = await import('node:module')
          module.default.register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loaderSource)}))
          return (await import('escape:fd')).default
        }
      ]
      return Promise.all(attempts.map(async attempt => {
        try {
          await attempt()
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      }))
    `)
    assert.deepEqual(codes, [
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED'
    ])
  })

  test(`${type} cannot read host secrets from diagnostic reports`, async () => {
    const secretName = `SECURE_EVAL_REPORT_${randomUUID().replaceAll('-', '_')}`
    process.env[secretName] = 'diagnostic-report-secret'
    try {
      const code = await evaluateInGuest(type, `
        try {
          return process.report.getReport().environmentVariables[${JSON.stringify(secretName)}]
        } catch (error) {
          return error.code
        }
      `)
      assert.equal(code, 'ERR_ACCESS_DENIED')
    } finally {
      delete process.env[secretName]
    }
  })

  test(`${type} cannot inspect worker environment data through V8 aliases`, async () => {
    const key = `secure-eval-worker-query-${randomUUID()}`
    const secret = `query-secret-${randomUUID()}`
    setEnvironmentData(key, secret)
    try {
      const codes = await evaluateInGuest(type, `
        const namespace = await import('node:v8')
        const { queryObjects: named } = await import('node:v8')
        const bareNamespace = await import('v8')
        const { queryObjects: bareNamed } = await import('v8')
        const module = await import('node:module')
        const require = module.createRequire(process.execPath)
        const aliases = [
          namespace,
          namespace.default,
          bareNamespace,
          bareNamespace.default,
          require('node:v8'),
          require('v8'),
          module.Module._load('node:v8'),
          module.Module._load('v8'),
          process.getBuiltinModule('node:v8'),
          process.getBuiltinModule('v8')
        ]
        const calls = [
          named,
          namespace.queryObjects,
          namespace.default.queryObjects,
          bareNamed,
          bareNamespace.queryObjects,
          bareNamespace.default.queryObjects,
          ...aliases.slice(4).map((alias) => alias.queryObjects)
        ]
        const results = calls.map((call) => {
          try {
            return call(Map, { format: 'summary' }).some((value) => value.includes(${JSON.stringify(secret)}))
          } catch (error) {
            return error.code
          }
        })
        for (const alias of aliases) {
          for (const call of [
            () => alias.promiseHooks.onInit(() => {}),
            () => alias.startupSnapshot.addDeserializeCallback(() => {})
          ]) {
            try {
              call()
              results.push('ALLOWED')
            } catch (error) {
              results.push(error.code)
            }
          }
        }
        return results
      `)
      assert.deepEqual(codes, Array(32).fill('ERR_ACCESS_DENIED'))
    } finally {
      setEnvironmentData(key, undefined)
    }
  })

  test(`${type} cannot connect to the inspector through module aliases`, async () => {
    const codes = await evaluateInGuest(type, `
      const namespace = await import('node:inspector')
      const bareNamespace = await import('inspector')
      const promisesNamespace = await import('node:inspector/promises')
      const module = await import('node:module')
      const require = module.createRequire(process.execPath)
      const constructors = [
        namespace.Session,
        namespace.default.Session,
        bareNamespace.Session,
        promisesNamespace.Session,
        require('node:inspector').Session,
        require('inspector/promises').Session,
        module.Module._load('node:inspector').Session,
        module.Module._load('inspector/promises').Session,
        process.getBuiltinModule('node:inspector').Session,
        process.getBuiltinModule('inspector/promises').Session
      ]
      const results = []
      for (const Session of constructors) {
        for (const method of ['connect', 'connectToMainThread']) {
          const session = new Session()
          try {
            session[method]()
            results.push('ALLOWED')
          } catch (error) {
            results.push(error.code)
          }
          try { session.disconnect() } catch {}
        }
      }
      const openers = [
        namespace.open,
        namespace.default.open,
        bareNamespace.open,
        require('node:inspector').open,
        module.Module._load('inspector').open,
        process.getBuiltinModule('node:inspector').open
      ]
      for (const open of openers) {
        try {
          open(0)
          results.push('ALLOWED')
        } catch (error) {
          results.push(error.code)
        }
      }
      return results
    `)
    assert.deepEqual(codes, Array(26).fill('ERR_ACCESS_DENIED'))
  })

  test(`${type} cannot read worker environment data`, async () => {
    const key = `secure-eval-worker-${randomUUID()}`
    setEnvironmentData(key, 'worker-environment-secret')
    try {
      assert.equal(getEnvironmentData(key), 'worker-environment-secret')
      const code = await evaluateInGuest(type, `
        try {
          const { getEnvironmentData } = await import('node:worker_threads')
          return getEnvironmentData(${JSON.stringify(key)})
        } catch (error) {
          return error.code
        }
      `)
      assert.equal(code, 'ERR_ACCESS_DENIED')
    } finally {
      setEnvironmentData(key, undefined)
    }
  })
}

for (const type of ['file-one-shot', 'file-module']) {
  test(`${type} denies outside reads, writes, child processes, network, and inspector`, async (t) => {
    const outside = join(tmpdir(), `secure-eval-outside-${randomUUID()}.txt`)
    fs.writeFileSync(outside, 'outside-secret')
    t.after(() => fs.rmSync(outside, { force: true }))
    const codes = await evaluateInGuest(type, `
      const attempts = [
        async () => (await import('node:fs')).readFileSync(${JSON.stringify(outside)}, 'utf8'),
        async () => (await import('node:fs')).writeFileSync(${JSON.stringify(outside)}, 'changed'),
        async () => (await import('node:child_process')).execFileSync(process.execPath),
        async () => (await import('node:net')).connect({ port: 9 }),
        async () => (await import('node:inspector')).open(0)
      ]
      return Promise.all(attempts.map(async (attempt) => {
        try {
          await attempt()
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      }))
    `)
    assert.deepEqual(codes, Array(5).fill('ERR_ACCESS_DENIED'))
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-secret')
  })
}

test('sanitizes host process metadata in every execution mode', async () => {
  for (const type of EXECUTION_TYPES) {
    const result = await evaluateInGuest(type, `
      const namespace = await import('node:process')
      const builtin = process.getBuiltinModule('node:process')
      const moduleNamespace = await import('node:module')
      const bareModuleNamespace = await import('module')
      const require = moduleNamespace.createRequire(process.execPath)
      const calls = {}
      for (const name of [
        'availableMemory', 'constrainedMemory', 'cpuUsage', 'getegid', 'geteuid',
        'getgid', 'getgroups', 'getuid', 'memoryUsage', 'resourceUsage', 'umask', 'uptime'
      ]) {
        calls[name] = [
          process[name],
          namespace[name],
          namespace.default[name],
          builtin[name]
        ].map((call) => {
          if (typeof call !== 'function') return 'ABSENT'
          try {
            call()
            return 'ALLOWED'
          } catch (error) {
            return error.code
          }
        })
      }
      return {
        calls,
        globalPaths: [
          moduleNamespace.globalPaths,
          moduleNamespace.default.globalPaths,
          moduleNamespace.Module.globalPaths,
          bareModuleNamespace.globalPaths,
          bareModuleNamespace.default.globalPaths,
          require('node:module').globalPaths,
          require('module').globalPaths,
          moduleNamespace.Module._load('node:module').globalPaths,
          moduleNamespace.Module._load('module').globalPaths,
          process.getBuiltinModule('node:module').globalPaths,
          process.getBuiltinModule('module').globalPaths
        ],
        argv0: [process.argv0, namespace.argv0, namespace.default.argv0, builtin.argv0],
        cwd: [process.cwd(), namespace.cwd(), namespace.default.cwd(), builtin.cwd()],
        execArgv: [process.execArgv, namespace.execArgv, namespace.default.execArgv, builtin.execArgv],
        execPath: [process.execPath, namespace.execPath, namespace.default.execPath, builtin.execPath]
      }
    `)
    assert.deepEqual(result.argv0, Array(4).fill(process.argv0), type)
    assert.deepEqual(result.globalPaths, Array.from({ length: 11 }, () => []), type)
    assert.equal(result.cwd.some((value) => value.includes(process.cwd())), false, type)
    assert.deepEqual(result.execArgv[0], [], type)
    assert.deepEqual(result.execArgv[2], [], type)
    assert.deepEqual(result.execArgv[3], [], type)
    assert.equal(result.execArgv[1] === undefined || result.execArgv[1].length === 0, true, type)
    assert.equal(result.execPath.some((value) => value.includes(process.execPath)), false, type)
    for (const codes of Object.values(result.calls)) {
      assert.equal(codes[0], 'ERR_ACCESS_DENIED', type)
      assert.equal(codes[2], 'ERR_ACCESS_DENIED', type)
      assert.equal(codes[3], 'ERR_ACCESS_DENIED', type)
      assert.equal(
        codes[1] === 'ERR_ACCESS_DENIED' || codes[1] === 'ABSENT',
        true,
        type
      )
    }
  }
})

test('does not inherit host command-line arguments', () => {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href
  const marker = `CLI_SECRET_${randomUUID()}`
  const childSource = `
    import { runUntrustedCode } from ${JSON.stringify(moduleUrl)}
    const argv = await runUntrustedCode('return process.argv', { timeoutMs: 5_000 })
    if (argv.includes(${JSON.stringify(marker)})) throw new Error('CLI argument leaked')
  `
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', childSource, marker],
    { encoding: 'utf8', timeout: 30_000 }
  )
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
})

test('cannot wrap an existing host socket descriptor', async (t) => {
  const server = createServer(() => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const socket = connect(server.address().port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  t.after(() => {
    socket.destroy()
    server.close()
  })

  const descriptor = socket._handle.fd
  const results = await runUntrustedCode(`
    const attempts = [
      async () => {
        const { Socket } = await import('node:net')
        const recovered = new Socket({
          fd: ${descriptor}, readable: true, writable: true
        })
        return typeof recovered.write === 'function' ? 'ALLOWED' : 'BLOCKED'
      },
      async () => {
        const { TLSSocket } = await import('node:_tls_wrap')
        const Socket = Object.getPrototypeOf(TLSSocket.prototype).constructor
        const recovered = new Socket({
          fd: ${descriptor}, readable: true, writable: true
        })
        return typeof recovered.write === 'function' ? 'ALLOWED' : 'BLOCKED'
      },
      async () => {
        const { Server: HttpServer } = await import('node:http')
        const NetServer = Object.getPrototypeOf(HttpServer.prototype).constructor
        const recovered = new NetServer()
        return typeof recovered.listen === 'function' ? 'ALLOWED' : 'BLOCKED'
      }
    ]
    return Promise.all(attempts.map(async attempt => {
      try {
        return await attempt()
      } catch (error) {
        return error.code ?? 'BLOCKED'
      }
    }))
  `, { timeoutMs: 5_000 })
  assert.deepEqual(results, ['ERR_ACCESS_DENIED', 'BLOCKED', 'BLOCKED'])
  assert.equal(socket.destroyed, false)
})

test('blocks process-wide and cross-thread escape APIs in an isolated process', () => {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href
  const attacks = [
    "process.kill(process.pid, 'SIGKILL')",
    "process._kill(process.pid, 0)",
    "process._debugProcess(process.pid)",
    "process.report.getReport()",
    "(await import('node:os')).setPriority(process.pid, 19)",
    "(await import('node:v8')).setFlagsFromString('--jitless')",
    "(await import('node:v8')).writeHeapSnapshot()",
    "(await import('node:v8')).getHeapSnapshot()",
    "new (await import('node:worker_threads')).BroadcastChannel('escape')",
    "await (await import('node:worker_threads')).postMessageToThread(0, new SharedArrayBuffer(8))",
    "await (await import('node:worker_threads')).locks.query()",
    "await navigator.locks.query()"
  ]
  const childSource = `
    import { runUntrustedCode } from ${JSON.stringify(moduleUrl)}
    const attacks = ${JSON.stringify(attacks)}
    for (const attack of attacks) {
      const source = \`try { await (async () => { \${attack} })(); return 'ALLOWED' } catch (error) { return error.code }\`
      const result = await runUntrustedCode(source, { timeoutMs: 5_000 })
      if (result !== 'ERR_ACCESS_DENIED') throw new Error(attack + ': ' + result)
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
    timeout: 30_000
  })

  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
})

test('throwing lifecycle listeners cannot prevent terminal cleanup', () => {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href
  const childSource = `
    import { createUntrustedWorker } from ${JSON.stringify(moduleUrl)}
    const uncaught = new Promise(resolve => process.once('uncaughtException', resolve))
    const session = createUntrustedWorker('process.exit(0)', {
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    session.on('error', () => { throw new Error('listener boom') })
    const exited = new Promise(resolve => session.once('exit', resolve))
    session.ready.catch(() => {})
    const [error, closed, exitCode] = await Promise.all([uncaught, session.closed, exited])
    if (error.message !== 'listener boom' || session.state !== 'closed' ||
        closed.code !== 0 || exitCode !== 0) {
      throw new Error('cleanup did not complete')
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
})

test('throwing error listeners cannot create unhandled host-function rejections', () => {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href
  const childSource = `
    import { createUntrustedWorker, HostFunctionError } from ${JSON.stringify(moduleUrl)}
    let leaked = false
    process.on('unhandledRejection', () => { leaked = true })
    process.on('uncaughtException', () => { leaked = true })
    const session = createUntrustedWorker('onMessage(() => tools.fail())', {
      hostFunctions: { tools: { fail: () => {
        throw new HostFunctionError('x'.repeat(10_000))
      } } },
      maxMessageBytes: 200,
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    session.on('error', () => { throw new Error('listener boom') })
    await session.ready
    await session.request(null).catch(() => {})
    await session.closed
    await new Promise(resolve => setImmediate(resolve))
    if (leaked) process.exitCode = 1
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
})

test('throwing diagnostic and error listeners do not create unhandled rejections', () => {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href
  const childSource = `
    import { createUntrustedWorker } from ${JSON.stringify(moduleUrl)}
    let leaked = false
    process.on('unhandledRejection', () => { leaked = true })
    process.on('uncaughtException', () => { leaked = true })
    const session = createUntrustedWorker(\`
      console.log('trigger')
      await new Promise(() => {})
    \`, {
      diagnostics: true,
      onDiagnostic () { throw new Error('callback boom') },
      startupTimeoutMs: 5_000,
      messageTimeoutMs: 5_000,
      lifetimeTimeoutMs: 5_000
    })
    session.on('error', () => { throw new Error('listener boom') })
    session.ready.catch(() => {})
    await session.closed
    await new Promise(resolve => setImmediate(resolve))
    if (leaked) process.exitCode = 1
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
})

test('host intrinsic poisoning cannot bypass shared-memory checks', async () => {
  const originalIsView = ArrayBuffer.isView
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  const originalTypedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')
  const originalDataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')
  const shared = new SharedArrayBuffer(8)
  const values = [new Uint8Array(shared), new DataView(shared)]

  const poisonIntrinsics = () => {
    ArrayBuffer.isView = () => false
    Object.defineProperty(typedArrayPrototype, 'buffer', {
      configurable: true,
      get: () => new ArrayBuffer(0)
    })
    Object.defineProperty(DataView.prototype, 'buffer', {
      configurable: true,
      get: () => new ArrayBuffer(0)
    })
  }
  const restoreIntrinsics = () => {
    ArrayBuffer.isView = originalIsView
    Object.defineProperty(typedArrayPrototype, 'buffer', originalTypedBuffer)
    Object.defineProperty(DataView.prototype, 'buffer', originalDataViewBuffer)
  }

  poisonIntrinsics()
  try {
    for (const value of values) {
      assert.throws(
        () => runUntrustedCode('return input', { input: value }),
        /shared memory/
      )
      assert.throws(
        () => createUntrustedWorker('', { input: value }),
        /shared memory/
      )
    }
  } finally {
    restoreIntrinsics()
  }

  const session = createUntrustedWorker('onMessage(value => value)', SECURITY_TIMEOUTS)
  await session.ready
  poisonIntrinsics()
  try {
    for (const value of values) {
      assert.throws(() => session.postMessage(value), /shared memory/)
      assert.throws(() => session.request(value), /shared memory/)
    }
  } finally {
    restoreIntrinsics()
  }
  await session.terminate()
})

test('suppresses ordinary output and hides private protocol credentials', async () => {
  const session = createUntrustedWorker(`
    const { Writable } = await import('node:stream')
    const result = {
      stdout: process.stdout.write('not forwarded'),
      stderr: process.stderr.write('not forwarded'),
      inherited: Writable.prototype.write.call(process.stdout, 'also not forwarded')
    }
    onMessage(() => result)
  `, SECURITY_TIMEOUTS)

  await session.ready
  assert.deepEqual(await session.request(null), {
    stdout: false,
    stderr: false,
    inherited: true
  })
  for (const name of ['worker', 'port', 'protocolSecret', 'rawPortPost', 'protocolMac']) {
    assert.equal(name in session, false)
  }
  await session.terminate()
})

test('limits guest output count before messages cross the boundary', async () => {
  const received = []
  const session = createUntrustedWorker(`
    send('first')
    send('second')
    let result
    try {
      send('third')
      result = 'unexpected'
    } catch (error) {
      result = error.message
    }
    onMessage(() => result)
  `, {
    ...SECURITY_TIMEOUTS,
    maxOutputMessages: 2
  })
  session.on('message', (value) => received.push(value))

  await session.ready
  assert.match(await session.request(null), /Output limit exceeded/)
  assert.deepEqual(received, ['first', 'second'])
  await session.terminate()
})

test('rejects lossy platform objects at every public message boundary', async () => {
  assert.throws(
    () => runUntrustedCode('return input', { input: new Blob(['secret']) }),
    /unsupported/i
  )
  assert.throws(
    () => createUntrustedWorker('', { input: new Blob(['secret']) }),
    /unsupported/i
  )
  await assert.rejects(
    runUntrustedCode("return new Blob(['secret'])", { timeoutMs: 5_000 }),
    /unsupported/i
  )

  const session = createUntrustedWorker(`
    onMessage((kind) => {
      if (kind === 'send') send(new Blob(['secret']))
      if (kind === 'response') return new Blob(['secret'])
      return 'ok'
    })
  `, SECURITY_TIMEOUTS)
  await session.ready
  assert.throws(() => session.postMessage(new Blob(['secret'])), /(?:not supported|unsupported)/i)
  assert.throws(() => session.request(new Blob(['secret'])), /(?:not supported|unsupported)/i)
  const runtimeError = new Promise((resolve) => session.once('error', resolve))
  session.postMessage('send')
  assert.match((await runtimeError).message, /unsupported/i)
  await assert.rejects(session.request('response'), /unsupported/i)
  assert.equal(await session.request('ok'), 'ok')
  await session.terminate()
})

test('rejects cloneable cryptographic key capabilities at every host boundary', async () => {
  const key = await webcrypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    true,
    ['sign', 'verify']
  )
  assert.throws(
    () => runUntrustedCode('return input', { input: key }),
    /unsupported/i
  )
  assert.throws(
    () => createUntrustedWorker('', { input: key }),
    /unsupported/i
  )

  const session = createUntrustedWorker('onMessage(value => value)', SECURITY_TIMEOUTS)
  await session.ready
  assert.throws(
    () => session.postMessage(key),
    /(?:unsupported|not supported|unserializable)/i
  )
  assert.throws(
    () => session.request(key),
    /(?:unsupported|not supported|unserializable)/i
  )
  await session.terminate()
})

test('round-trips every documented protocol value type', async () => {
  const value = {
    date: new Date('2026-01-02T03:04:05.000Z'),
    regexp: /secure/giu,
    map: new Map([['answer', 42]]),
    set: new Set(['a', 'b']),
    buffer: Uint8Array.from([1, 2, 3]).buffer,
    typed: new Uint16Array([10, 20]),
    view: new DataView(Uint8Array.from([7, 8]).buffer)
  }
  let hostArgument
  const session = createUntrustedWorker(`
    onMessage(async message => {
      if (message === 'input') return input
      return tools.echo(message)
    })
  `, {
    ...SECURITY_TIMEOUTS,
    input: value,
    hostFunctions: {
      tools: {
        echo: (argument) => {
          hostArgument = argument
          return argument
        }
      }
    }
  })

  await session.ready
  const inputResult = await session.request('input')
  assert.deepEqual(inputResult, value)
  const hostResult = await session.request(value)
  assert.deepEqual(hostArgument, value)
  assert.deepEqual(hostResult, value)
  assert.ok(inputResult.date instanceof Date)
  assert.ok(inputResult.regexp instanceof RegExp)
  assert.ok(inputResult.map instanceof Map)
  assert.ok(inputResult.set instanceof Set)
  assert.ok(inputResult.buffer instanceof ArrayBuffer)
  assert.ok(inputResult.typed instanceof Uint16Array)
  assert.ok(inputResult.view instanceof DataView)
  await session.terminate()
})

test('limits cumulative guest output bytes', async () => {
  const received = []
  const session = createUntrustedWorker(`
    let result
    try {
      send('x'.repeat(1_000))
      result = 'unexpected'
    } catch (error) {
      result = error.message
    }
    onMessage(() => result)
  `, {
    ...SECURITY_TIMEOUTS,
    maxMessageBytes: 2_000,
    maxOutputBytes: 100
  })
  session.on('message', (value) => received.push(value))
  await session.ready
  assert.match(await session.request(null), /Output limit exceeded/)
  assert.deepEqual(received, [])
  await session.terminate()
})

test('limits setup input size before worker construction', () => {
  assert.throws(
    () => runUntrustedCode('return input', {
      input: 'x'.repeat(10_000),
      maxInputBytes: 100
    }),
    /maxInputBytes/
  )
  assert.throws(
    () => createUntrustedWorker('', {
      input: 'x'.repeat(10_000),
      maxInputBytes: 100
    }),
    /maxInputBytes/
  )
})

test('limits serialized values in both protocol directions', async () => {
  await assert.rejects(
    runUntrustedCode("return 'x'.repeat(10_000)", {
      timeoutMs: 5_000,
      maxMessageBytes: 1_000
    }),
    /maxMessageBytes/
  )

  const session = createUntrustedWorker(`
    onMessage(value => {
      if (value === 'large-response') return 'x'.repeat(10_000)
      if (value === 'large-send') send('x'.repeat(10_000))
      return value
    })
  `, {
    ...SECURITY_TIMEOUTS,
    maxMessageBytes: 1_000
  })
  await session.ready
  assert.throws(
    () => session.postMessage('x'.repeat(10_000)),
    /maxMessageBytes/
  )
  assert.throws(
    () => session.request('x'.repeat(10_000)),
    /maxMessageBytes/
  )
  await assert.rejects(session.request('large-response'), /maxMessageBytes/)
  const runtimeError = new Promise((resolve) => session.once('error', resolve))
  session.postMessage('large-send')
  assert.match((await runtimeError).message, /maxMessageBytes/)
  await session.terminate()
})
