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
  configureWorkerAdmission,
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

  test(`${type} denies unapproved builtins through every loading path`, async () => {
    const result = await evaluateInGuest(type, `
      const Module = await import('node:module')
      const processModule = await import('node:process')
      const vm = await import('node:vm')
      const require = Module.createRequire(process.execPath)
      const commonNodeModule = require('node:module')
      const commonBareModule = require('module')
      const loadedModule = Module.Module._load('node:module')
      const builtinModule = process.getBuiltinModule('node:module')
      const mutationResults = []
      for (const [target, name] of [
        [Module, '_load'],
        [Module.default, '_load'],
        [Module, 'registerHooks'],
        [Module.default, 'registerHooks'],
        [process, 'getBuiltinModule'],
        [processModule.default, 'getBuiltinModule']
      ]) {
        mutationResults.push([
          Reflect.set(target, name, () => 'ALLOWED'),
          Reflect.deleteProperty(target, name),
          Reflect.defineProperty(target, name, {
            configurable: true,
            value: () => 'ALLOWED'
          })
        ])
      }
      Module.syncBuiltinESMExports()
      Module.default.syncBuiltinESMExports()
      Module.syncBuiltinESMExports()

      const loaderCodes = [
        Module.registerHooks,
        Module.default.registerHooks,
        Module.Module.registerHooks,
        commonNodeModule.registerHooks,
        commonBareModule.registerHooks,
        loadedModule.registerHooks,
        builtinModule.registerHooks
      ].map(registerHooks => {
        try {
          Reflect.apply(registerHooks, undefined, [{ resolve () { return 'ALLOWED' } }])
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      })

      const attempts = [
        () => import('node:diagnostics_channel'),
        () => import('diagnostics_channel'),
        () => require('node:diagnostics_channel'),
        () => require('diagnostics_channel'),
        () => Module._load('node:diagnostics_channel'),
        () => Module.Module._load('diagnostics_channel'),
        () => Module.default._load('node:diagnostics_channel'),
        () => process.getBuiltinModule('node:diagnostics_channel'),
        () => processModule.getBuiltinModule('node:diagnostics_channel'),
        () => processModule.default.getBuiltinModule('diagnostics_channel'),
        () => process.getBuiltinModule('node:module')._load('node:diagnostics_channel'),
        () => process.getBuiltinModule('module')._load('diagnostics_channel'),
        () => new vm.Script("import('node:diagnostics_channel')", {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
        }).runInThisContext(),
        () => vm.compileFunction("return import('diagnostics_channel')", [], {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
        })()
      ]
      const codes = []
      for (const attempt of attempts) {
        try {
          await attempt()
          codes.push('ALLOWED')
        } catch (error) {
          codes.push(error.code)
        }
      }
      return {
        codes,
        loaderCodes,
        mutationResults,
        approved: (await import('node:path')).join('a', 'b')
      }
    `)
    assert.deepEqual(result.codes, Array(14).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.loaderCodes, Array(7).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.mutationResults, Array.from({ length: 6 }, () =>
      [false, false, false]))
    assert.equal(result.approved, join('a', 'b'))
  })

  test(`${type} denies WASI, FFI, and unavailable native capability modules`, async () => {
    const result = await evaluateInGuest(type, `
      const Module = await import('node:module')
      const require = Module.createRequire(process.execPath)
      const mutationResult = (module, name) => ({
        set: Reflect.set(module, name, () => 'ALLOWED'),
        delete: Reflect.deleteProperty(module, name),
        define: Reflect.defineProperty(module, name, {
          configurable: true,
          value: () => 'ALLOWED'
        })
      })
      const invoke = (module, name, construct = false) => {
        try {
          if (construct) Reflect.construct(module[name], [])
          else Reflect.apply(module[name], undefined, [])
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      }

      const nodeWasi = await import('node:wasi')
      const bareWasi = await import('wasi')
      const wasiModules = [
        nodeWasi,
        nodeWasi.default,
        bareWasi,
        bareWasi.default,
        process.getBuiltinModule('node:wasi'),
        process.getBuiltinModule('wasi'),
        require('node:wasi'),
        require('wasi'),
        Module._load('node:wasi'),
        Module._load('wasi'),
        Module.default._load('node:wasi'),
        Module.default._load('wasi')
      ]
      const wasiMutations = wasiModules.map(module => mutationResult(module, 'WASI'))
      Module.syncBuiltinESMExports()
      Module.default.syncBuiltinESMExports()
      Module.syncBuiltinESMExports()
      const wasi = wasiModules.map(module => invoke(module, 'WASI', true))

      const ffi = []
      for (const load of [
        () => import('node:ffi'),
        () => process.getBuiltinModule('node:ffi'),
        () => require('node:ffi'),
        () => Module._load('node:ffi'),
        () => Module.Module._load('node:ffi'),
        () => Module.default._load('node:ffi')
      ]) {
        try {
          await load()
          ffi.push('ALLOWED')
        } catch (error) {
          ffi.push(error.code)
        }
      }

      let bareFfiImported = false
      let bareFfiRequired = false
      let bareFfiLoaded = false
      try { await import('ffi'); bareFfiImported = true } catch {}
      try { require('ffi'); bareFfiRequired = true } catch {}
      try { Module._load('ffi'); bareFfiLoaded = true } catch {}
      const ffiBare = {
        imported: bareFfiImported,
        required: bareFfiRequired,
        loaded: bareFfiLoaded,
        defaultLoaded: (() => {
          try { Module.default._load('ffi'); return true } catch { return false }
        })(),
        builtin: process.getBuiltinModule('ffi') !== undefined
      }

      let vfsImported = false
      let vfsRequired = false
      let vfsLoaded = false
      try { await import('node:vfs'); vfsImported = true } catch {}
      try { require('node:vfs'); vfsRequired = true } catch {}
      try { Module._load('node:vfs'); vfsLoaded = true } catch {}
      const unavailable = {
        imported: vfsImported,
        required: vfsRequired,
        loaded: vfsLoaded,
        defaultLoaded: (() => {
          try { Module.default._load('node:vfs'); return true } catch { return false }
        })(),
        builtin: process.getBuiltinModule('node:vfs') !== undefined
      }
      return {
        wasi,
        wasiMutations,
        ffi,
        ffiBare,
        unavailable
      }
    `)
    assert.deepEqual(result.wasi, Array(12).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.wasiMutations, Array.from({ length: 12 }, () => ({
      set: false,
      delete: false,
      define: false
    })))
    assert.deepEqual(result.ffi, Array(6).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.ffiBare, {
      imported: false,
      required: false,
      loaded: false,
      defaultLoaded: false,
      builtin: false
    })
    assert.deepEqual(result.unavailable, {
      imported: false,
      required: false,
      loaded: false,
      defaultLoaded: false,
      builtin: false
    })
  })

  test(`${type} denies Node 26.8 ZIP filesystem APIs through every alias`, async () => {
    const result = await evaluateInGuest(type, `
      const Module = await import('node:module')
      const require = Module.createRequire(process.execPath)
      const nodeNamespace = await import('node:zlib')
      const bareNamespace = await import('zlib')
      const aliases = [
        nodeNamespace,
        nodeNamespace.default,
        bareNamespace,
        bareNamespace.default,
        require('node:zlib'),
        require('zlib'),
        Module._load('node:zlib'),
        Module.default._load('zlib'),
        process.getBuiltinModule('node:zlib'),
        process.getBuiltinModule('zlib')
      ]
      const names = [
        'ZipBuffer',
        'ZipEntry',
        'ZipFile',
        'createZipArchive',
        'createZipArchiveSync',
        'getMaxZipContentSize',
        'setMaxZipContentSize',
        'zipFiles'
      ].filter(name => typeof aliases[0][name] === 'function')
      const mutations = aliases.map(alias => names.map(name => [
        Reflect.set(alias, name, () => 'ALLOWED'),
        Reflect.deleteProperty(alias, name),
        Reflect.defineProperty(alias, name, {
          configurable: true,
          value: () => 'ALLOWED'
        })
      ]))
      Module.syncBuiltinESMExports()
      Module.default.syncBuiltinESMExports()
      Module.syncBuiltinESMExports()
      const codes = aliases.map(alias => names.map(name => {
        try {
          Reflect.apply(alias[name], undefined, [])
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      }))
      return { names, mutations, codes }
    `)
    const expectedNames = Number(process.versions.node.split('.')[1]) >= 8 ? 8 : 0
    assert.equal(result.names.length, expectedNames)
    assert.deepEqual(result.codes, Array.from({ length: 10 }, () =>
      Array(expectedNames).fill('ERR_ACCESS_DENIED')))
    assert.deepEqual(result.mutations, Array.from({ length: 10 }, () =>
      Array.from({ length: expectedNames }, () => [false, false, false])))
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

  test(`${type} denies child-process descriptor adoption through every alias`, async () => {
    const result = await evaluateInGuest(type, `
      const nodeNamespace = await import('node:child_process')
      const nodeNamed = nodeNamespace._forkChild
      const bareNamespace = await import('child_process')
      const bareNamed = bareNamespace._forkChild
      const module = await import('node:module')
      const require = module.createRequire(process.execPath)
      const commonJs = require('node:child_process')
      const original = commonJs._forkChild
      const replacement = () => 'REPLACED'
      try { commonJs._forkChild = replacement } catch {}
      const assignmentRejected = commonJs._forkChild === original
      const deletionRejected = !Reflect.deleteProperty(commonJs, '_forkChild') &&
        commonJs._forkChild === original
      const definitionRejected = !Reflect.defineProperty(commonJs, '_forkChild', {
        configurable: true,
        value: replacement,
        writable: true
      }) && commonJs._forkChild === original
      module.syncBuiltinESMExports()
      const calls = [
        nodeNamed,
        nodeNamespace._forkChild,
        nodeNamespace.default._forkChild,
        bareNamed,
        bareNamespace._forkChild,
        bareNamespace.default._forkChild,
        require('node:child_process')._forkChild,
        require('child_process')._forkChild,
        module.Module._load('node:child_process')._forkChild,
        module.Module._load('child_process')._forkChild,
        module.default._load('node:child_process')._forkChild,
        module.default._load('child_process')._forkChild,
        process.getBuiltinModule('node:child_process')._forkChild,
        process.getBuiltinModule('child_process')._forkChild
      ]
      const before = [typeof process.send, typeof process.channel, typeof process.disconnect]
      const codes = calls.map((call) => {
        try {
          call(0, 'advanced')
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      })
      const descriptor = Object.getOwnPropertyDescriptor(commonJs, '_forkChild')
      return {
        before,
        after: [typeof process.send, typeof process.channel, typeof process.disconnect],
        codes,
        immutable: assignmentRejected && deletionRejected && definitionRejected &&
          descriptor.value === original && !descriptor.writable && !descriptor.configurable
      }
    `)
    assert.deepEqual(result.before, Array(3).fill('undefined'))
    assert.deepEqual(result.after, result.before)
    assert.equal(result.immutable, true)
    assert.deepEqual(result.codes, Array(14).fill('ERR_ACCESS_DENIED'))
  })

  test(`${type} exposes only a worker-relative virtual clock and denies performance constructors`, async () => {
    const result = await evaluateInGuest(type, `
      const perfNode = await import('node:perf_hooks')
      const perfBare = await import('perf_hooks')
      const cryptoNode = await import('node:crypto')
      const cryptoBare = await import('crypto')
      const processNode = await import('node:process')
      const module = await import('node:module')
      const require = module.createRequire(process.execPath)
      const commonJsPerformance = require('node:perf_hooks')
      const constructorNames = [
        'Performance',
        'PerformanceEntry',
        'PerformanceMark',
        'PerformanceMeasure',
        'PerformanceObserver',
        'PerformanceObserverEntryList',
        'PerformanceResourceTiming'
      ]
      const replacement = function replacementPerformanceConstructor () {}
      const constructorImmutability = []
      for (const name of constructorNames) {
        for (const target of [globalThis, commonJsPerformance]) {
          const original = target[name]
          try { target[name] = replacement } catch {}
          const assignmentRejected = target[name] === original
          const deletionRejected = !Reflect.deleteProperty(target, name) && target[name] === original
          const definitionRejected = !Reflect.defineProperty(target, name, {
            configurable: true,
            value: replacement,
            writable: true
          }) && target[name] === original
          const descriptor = Object.getOwnPropertyDescriptor(target, name)
          constructorImmutability.push(
            assignmentRejected && deletionRejected && definitionRejected &&
            descriptor.value === original && !descriptor.writable && !descriptor.configurable
          )
        }
      }
      module.syncBuiltinESMExports()
      const performanceAliases = [
        perfNode,
        perfNode.default,
        perfBare,
        perfBare.default,
        require('node:perf_hooks'),
        require('perf_hooks'),
        module.Module._load('node:perf_hooks'),
        module.Module._load('perf_hooks'),
        module.default._load('node:perf_hooks'),
        module.default._load('perf_hooks'),
        process.getBuiltinModule('node:perf_hooks'),
        process.getBuiltinModule('perf_hooks')
      ]
      const performanceObjects = [
        globalThis.performance,
        ...performanceAliases.map((alias) => alias.performance)
      ]
      const clocks = performanceObjects.map((clock) => ({
        now: clock.now(),
        timeOrigin: clock.timeOrigin,
        nodeTiming: clock.nodeTiming
      }))
      const clock = globalThis.performance
      const originalNow = clock.now
      try { clock.now = replacement } catch {}
      const clockAssignmentRejected = clock.now === originalNow
      const clockDeletionRejected = !Reflect.deleteProperty(clock, 'now') && clock.now === originalNow
      const clockDefinitionRejected = !Reflect.defineProperty(clock, 'now', {
        configurable: true,
        value: replacement,
        writable: true
      }) && clock.now === originalNow
      const constructorCodes = []
      const aliasesShareDeniedConstructors = []
      const prototypesAreDetached = []
      const dangerousPrototypeNames = [
        'now', 'timeOrigin', 'nodeTiming', 'startTime', 'duration', 'detail',
        'observe', 'disconnect', 'takeRecords', 'getEntries', 'getEntriesByName',
        'getEntriesByType'
      ]
      for (const name of constructorNames) {
        const constructors = [globalThis[name], ...performanceAliases.map((alias) => alias[name])]
        aliasesShareDeniedConstructors.push(constructors.every((value) => value === constructors[0]))
        prototypesAreDetached.push(constructors.every((Constructor) =>
          Object.isFrozen(Constructor) && Object.isFrozen(Constructor.prototype) &&
          Object.getPrototypeOf(Constructor.prototype) === Object.prototype &&
          dangerousPrototypeNames.every((property) => !(property in Constructor.prototype))
        ))
        for (const Constructor of constructors) {
          try {
            Reflect.construct(Constructor, name === 'PerformanceObserver' ? [() => {}] : ['entry'])
            constructorCodes.push('ALLOWED')
          } catch (error) {
            constructorCodes.push(error.code)
          }
        }
      }
      const calls = [
        perfNode.monitorEventLoopDelay,
        perfNode.default.monitorEventLoopDelay,
        perfBare.monitorEventLoopDelay,
        perfBare.default.monitorEventLoopDelay,
        require('node:perf_hooks').monitorEventLoopDelay,
        require('perf_hooks').monitorEventLoopDelay,
        module.Module._load('node:perf_hooks').monitorEventLoopDelay,
        module.Module._load('perf_hooks').monitorEventLoopDelay,
        module.default._load('node:perf_hooks').monitorEventLoopDelay,
        module.default._load('perf_hooks').monitorEventLoopDelay,
        process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay,
        process.getBuiltinModule('perf_hooks').monitorEventLoopDelay,
        cryptoNode.secureHeapUsed,
        cryptoNode.default.secureHeapUsed,
        cryptoBare.secureHeapUsed,
        cryptoBare.default.secureHeapUsed,
        require('node:crypto').secureHeapUsed,
        require('crypto').secureHeapUsed,
        module.Module._load('node:crypto').secureHeapUsed,
        module.Module._load('crypto').secureHeapUsed,
        process.getBuiltinModule('node:crypto').secureHeapUsed,
        process.getBuiltinModule('crypto').secureHeapUsed,
        process.hrtime,
        processNode.hrtime,
        processNode.default.hrtime,
        require('node:process').hrtime,
        module.Module._load('process').hrtime,
        process.getBuiltinModule('node:process').hrtime
      ]
      const codes = calls.map((call) => {
        try {
          call()
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      })
      const setFipsCodes = [
        cryptoNode.setFips,
        cryptoNode.default.setFips,
        require('node:crypto').setFips,
        module.Module._load('crypto').setFips,
        process.getBuiltinModule('node:crypto').setFips
      ].map((call) => {
        try { call(1); return 'ALLOWED' } catch (error) { return error.code }
      })
      const eventPrototype = Event.prototype
      const eventTimeStampDescriptor = Object.getOwnPropertyDescriptor(
        eventPrototype,
        'timeStamp'
      )
      const relativeEventTimeStampGet = eventTimeStampDescriptor.get
      try {
        Object.defineProperty(eventPrototype, 'timeStamp', {
          configurable: true,
          get: () => 123,
          enumerable: true
        })
      } catch {}
      const eventDefinitionRejected = Object.getOwnPropertyDescriptor(
        eventPrototype,
        'timeStamp'
      ).get === relativeEventTimeStampGet
      const eventDeletionRejected = !Reflect.deleteProperty(eventPrototype, 'timeStamp') &&
        Object.getOwnPropertyDescriptor(eventPrototype, 'timeStamp').get ===
          relativeEventTimeStampGet
      try { eventPrototype.timeStamp = 123 } catch {}
      const eventAssignmentRejected = Object.getOwnPropertyDescriptor(
        eventPrototype,
        'timeStamp'
      ).get === relativeEventTimeStampGet
      const eventConstructorNames = [
        'Event',
        'CustomEvent',
        'MessageEvent',
        'ErrorEvent',
        'CloseEvent',
        'ProgressEvent'
      ].filter((name) => typeof globalThis[name] === 'function')
      const eventTimeStamps = eventConstructorNames.map((name) => {
        const event = new globalThis[name]('secure-eval-worker-event')
        return {
          direct: Reflect.apply(relativeEventTimeStampGet, event, []),
          inherited: event.timeStamp,
          name
        }
      })
      return {
        aliasesShareDeniedConstructors,
        clockImmutable: Object.isFrozen(clock) && Object.getPrototypeOf(clock) === null &&
          clockAssignmentRejected && clockDeletionRejected && clockDefinitionRejected,
        clocks,
        codes,
        constructorCodes,
        constructorImmutability,
        eventTimeStampImmutable: eventAssignmentRejected && eventDeletionRejected &&
          eventDefinitionRejected && eventTimeStampDescriptor.configurable === false &&
          eventTimeStampDescriptor.enumerable === true &&
          eventTimeStampDescriptor.set === undefined,
        eventTimeStamps,
        observerPathsAbsent: globalThis.PerformanceObserver.supportedEntryTypes === undefined &&
          !('observe' in globalThis.PerformanceObserver.prototype),
        performanceObjectsAreShared: performanceObjects.every((value) => value === clock),
        prototypesAreDetached,
        setFipsCodes
      }
    `)
    assert.equal(result.performanceObjectsAreShared, true)
    assert.equal(result.clockImmutable, true)
    assert.equal(result.clocks.length, 13)
    for (const clock of result.clocks) {
      assert.equal(clock.timeOrigin, 0)
      assert.equal(clock.nodeTiming, null)
      assert.equal(Number.isFinite(clock.now), true)
      assert.equal(clock.now >= 0 && clock.now < 5_000, true)
    }
    assert.deepEqual(result.aliasesShareDeniedConstructors, Array(7).fill(true))
    assert.deepEqual(result.prototypesAreDetached, Array(7).fill(true))
    assert.deepEqual(result.constructorImmutability, Array(14).fill(true))
    assert.equal(result.eventTimeStampImmutable, true)
    assert.deepEqual(
      result.eventTimeStamps.slice(0, 3).map(({ name }) => name),
      ['Event', 'CustomEvent', 'MessageEvent']
    )
    for (const { direct, inherited } of result.eventTimeStamps) {
      assert.equal(direct, inherited)
      assert.equal(Number.isFinite(inherited), true)
      assert.equal(inherited >= 0 && inherited < 5_000, true)
    }
    assert.equal(result.observerPathsAbsent, true)
    assert.deepEqual(result.constructorCodes, Array(91).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.codes, Array(28).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.setFipsCodes, Array(5).fill('ERR_ACCESS_DENIED'))
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

  test(`${type} blocks Heapjack-style heap snapshots through every V8 alias`, async () => {
    const result = await evaluateInGuest(type, `
      const namespace = await import('node:v8')
      const bareNamespace = await import('v8')
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
      const names = ['getHeapSnapshot', 'writeHeapSnapshot']
      const immutable = names.map((name) => {
        const target = require('node:v8')
        const original = target[name]
        try { target[name] = () => 'REPLACED' } catch {}
        const assignmentRejected = target[name] === original
        const deletionRejected = !Reflect.deleteProperty(target, name) && target[name] === original
        const definitionRejected = !Reflect.defineProperty(target, name, {
          configurable: true,
          value: () => 'REPLACED',
          writable: true
        }) && target[name] === original
        const descriptor = Object.getOwnPropertyDescriptor(target, name)
        return assignmentRejected && deletionRejected && definitionRejected &&
          descriptor.value === original && !descriptor.writable && !descriptor.configurable
      })
      const codes = []
      let allowed = null
      outer: for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
        for (const name of names) {
          const call = aliases[aliasIndex][name]
          try {
            const snapshot = Reflect.apply(call, aliases[aliasIndex], [])
            try { snapshot?.destroy?.() } catch {}
            allowed = aliasIndex + ':' + name
            break outer
          } catch (error) {
            codes.push(error.code)
          }
        }
      }
      return { allowed, codes, immutable }
    `)
    assert.equal(result.allowed, null)
    assert.deepEqual(result.codes, Array(20).fill('ERR_ACCESS_DENIED'))
    assert.deepEqual(result.immutable, [true, true])
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
          let session
          try {
            session = new Session()
            session[method]()
            results.push('ALLOWED')
          } catch (error) {
            results.push(error.code)
          }
          try { session?.disconnect() } catch {}
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

  test(`${type} denies DNS, fetch, WebSocket, trace events, crypto engines, and QUIC`, async () => {
    const result = await evaluateInGuest(type, `
      const Module = await import('node:module')
      const require = Module.createRequire(process.execPath)
      const dnsNode = await import('node:dns')
      const dnsBare = await import('dns')
      const dnsPromises = await import('node:dns/promises')
      const cryptoNode = await import('node:crypto')
      const cryptoBare = await import('crypto')
      const attempts = [
        () => dnsNode.lookup('localhost', () => {}),
        () => dnsNode.default.lookup('localhost', () => {}),
        () => dnsBare.lookup('localhost', () => {}),
        () => dnsPromises.lookup('localhost'),
        () => require('node:dns').lookup('localhost', () => {}),
        () => require('dns').lookup('localhost', () => {}),
        () => require('node:dns/promises').lookup('localhost'),
        () => Module.default._load('node:dns').resolve('localhost', () => {}),
        () => process.getBuiltinModule('node:dns').lookup('localhost', () => {}),
        () => cryptoNode.setEngine('missing'),
        () => cryptoNode.default.setEngine('missing'),
        () => cryptoBare.setEngine('missing'),
        () => require('node:crypto').setEngine('missing'),
        () => process.getBuiltinModule('crypto').setEngine('missing'),
        () => fetch('http://127.0.0.1:9/'),
        () => new WebSocket('ws://127.0.0.1:9/')
      ]
      const codes = []
      for (const attempt of attempts) {
        try {
          await attempt()
          codes.push('ALLOWED')
        } catch (error) {
          codes.push(error.code)
        }
      }
      const trace = []
      for (const load of [
        () => import('node:trace_events'),
        () => import('trace_events'),
        () => require('node:trace_events'),
        () => require('trace_events'),
        () => Module.default._load('node:trace_events'),
        () => Module.default._load('trace_events'),
        () => process.getBuiltinModule('node:trace_events'),
        () => process.getBuiltinModule('trace_events')
      ]) {
        try {
          const value = await load()
          const create = value.createTracing ?? value.default?.createTracing
          try { create({ categories: ['node'] }); trace.push('ALLOWED') } catch (error) { trace.push(error.code) }
        } catch (error) {
          trace.push(error.code)
        }
      }
      const quic = []
      for (const load of [
        () => import('node:quic'),
        () => import('quic'),
        () => require('node:quic'),
        () => require('quic'),
        () => Module.default._load('node:quic'),
        () => Module.default._load('quic'),
        () => process.getBuiltinModule('node:quic'),
        () => process.getBuiltinModule('quic')
      ]) {
        let value
        try { value = await load() } catch { quic.push('UNAVAILABLE'); continue }
        if (value === undefined) { quic.push('UNAVAILABLE'); continue }
        const invocationCodes = []
        for (const candidate of [value, value.default]) {
          if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) continue
          for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
            if (!('value' in descriptor) || typeof descriptor.value !== 'function') continue
            try { Reflect.apply(descriptor.value, candidate, []); invocationCodes.push('ALLOWED') } catch (error) {
              invocationCodes.push(error.code)
            }
          }
        }
        quic.push(invocationCodes)
      }
      return { codes, trace, quic }
    `)
    assert.deepEqual(result.codes, Array(16).fill('ERR_ACCESS_DENIED'))
    assert.equal(result.trace.every(code => code === 'ERR_ACCESS_DENIED' || code === 'ERR_TRACE_EVENTS_UNAVAILABLE'), true)
    assert.equal(result.quic.every(outcome => outcome === 'UNAVAILABLE' ||
      (outcome.length > 0 && outcome.every(code => code === 'ERR_ACCESS_DENIED'))), true)
  })
}

test('denied child-process adoption leaves a known host descriptor intact', () => {
  const moduleUrl = new URL('../src/index.js', import.meta.url).href
  const childSource = `
    import fs from 'node:fs'
    import { runUntrustedCode } from ${JSON.stringify(moduleUrl)}
    const before = [typeof process.send, typeof process.channel, typeof process.disconnect]
    const result = await runUntrustedCode(\`
      const nodeNamespace = await import('node:child_process')
      const bareNamespace = await import('child_process')
      const module = await import('node:module')
      const require = module.createRequire(process.execPath)
      const commonJs = require('node:child_process')
      const original = commonJs._forkChild
      const replacement = () => 'REPLACED'
      try { commonJs._forkChild = replacement } catch {}
      const assignmentRejected = commonJs._forkChild === original
      const deletionRejected = !Reflect.deleteProperty(commonJs, '_forkChild') &&
        commonJs._forkChild === original
      const definitionRejected = !Reflect.defineProperty(commonJs, '_forkChild', {
        configurable: true,
        value: replacement,
        writable: true
      }) && commonJs._forkChild === original
      module.syncBuiltinESMExports()
      const calls = [
        nodeNamespace._forkChild,
        nodeNamespace.default._forkChild,
        bareNamespace._forkChild,
        bareNamespace.default._forkChild,
        require('node:child_process')._forkChild,
        require('child_process')._forkChild,
        module.Module._load('node:child_process')._forkChild,
        module.Module._load('child_process')._forkChild,
        module.default._load('node:child_process')._forkChild,
        module.default._load('child_process')._forkChild,
        process.getBuiltinModule('node:child_process')._forkChild,
        process.getBuiltinModule('child_process')._forkChild
      ]
      const codes = calls.map((call) => {
        try { call(3, 'advanced'); return 'ALLOWED' }
        catch (error) { return error.code }
      })
      return {
        codes,
        immutable: assignmentRejected && deletionRejected && definitionRejected
      }
    \`, { timeoutMs: 5_000 })
    const after = [typeof process.send, typeof process.channel, typeof process.disconnect]
    if (!result.immutable || result.codes.length !== 12 ||
        result.codes.some(code => code !== 'ERR_ACCESS_DENIED') ||
        before.some(value => value !== 'undefined') ||
        after.some(value => value !== 'undefined')) process.exitCode = 2
    fs.writeSync(3, 'descriptor-intact')
  `
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', childSource],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      timeout: 30_000
    }
  )
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output[3], 'descriptor-intact')
})

test('pre-existing HTTP agents cannot open loopback connections in any execution mode', async (t) => {
  let accepted = 0
  const sockets = []
  const server = createServer(socket => {
    accepted++
    sockets.push(socket)
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  const port = server.address().port

  for (const type of EXECUTION_TYPES) {
    const codes = await evaluateInGuest(type, `
      const Module = await import('node:module')
      const require = Module.createRequire(process.execPath)
      const httpNode = await import('node:http')
      const httpBare = await import('http')
      const httpsNode = await import('node:https')
      const httpsBare = await import('https')
      const modules = [
        httpNode, httpNode.default, httpBare, httpBare.default,
        httpsNode, httpsNode.default, httpsBare, httpsBare.default,
        require('node:http'), require('http'), require('node:https'), require('https'),
        Module.default._load('node:http'), Module.default._load('node:https'),
        process.getBuiltinModule('node:http'), process.getBuiltinModule('node:https')
      ]
      const results = []
      const attempt = (label, call, receiver, argumentsList) => {
        try {
          Reflect.apply(call, receiver, argumentsList)
          results.push([label, 'ALLOWED'])
        } catch (error) {
          results.push([label, error.code])
        }
      }
      for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
        const builtin = modules[moduleIndex]
        for (const name of ['request', 'get']) {
          if (typeof builtin[name] === 'function') {
            attempt(moduleIndex + ':' + name, builtin[name], builtin, [{ host: '127.0.0.1', port: ${port} }])
          }
        }
        const agent = builtin.globalAgent
        if (!agent) continue
        if (typeof agent === 'function') {
          attempt(moduleIndex + ':globalAgent', agent, builtin, [])
          continue
        }
        for (const name of ['createConnection', 'addRequest', 'createSocket']) {
          if (typeof agent[name] === 'function') {
            attempt(moduleIndex + ':agent.' + name, agent[name], agent, [{ host: '127.0.0.1', port: ${port} }, {}])
          }
        }
        let current = agent
        for (let depth = 0; current && depth < 4; depth++) {
          const descriptors = Object.getOwnPropertyDescriptors(current)
          const networkNames = ['createConnection', 'addRequest', 'createSocket']
          const hasNetworkMethod = networkNames.some(name => typeof descriptors[name]?.value === 'function')
          if (depth > 0 && !hasNetworkMethod) break
          for (const name of ['constructor', ...networkNames]) {
            const descriptor = descriptors[name]
            if (descriptor && typeof descriptor.value === 'function') {
              attempt(moduleIndex + ':prototype[' + depth + '].' + name,
                descriptor.value, agent, [{ host: '127.0.0.1', port: ${port} }, {}])
            }
          }
          current = Object.getPrototypeOf(current)
        }
      }
      return results
    `)
    assert.equal(codes.length > 0, true, type)
    assert.deepEqual(codes.filter(([, code]) => code !== 'ERR_ACCESS_DENIED'), [], type)
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(accepted, 0)
})

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
      const initPaths = [
        moduleNamespace._initPaths,
        moduleNamespace.default._initPaths,
        moduleNamespace.Module._initPaths,
        require('node:module')._initPaths,
        require('module')._initPaths,
        moduleNamespace.Module._load('node:module')._initPaths,
        process.getBuiltinModule('node:module')._initPaths
      ].map((call) => {
        if (typeof call !== 'function') return 'ABSENT'
        try {
          call()
          return 'ALLOWED'
        } catch (error) {
          return error.code
        }
      })
      return {
        calls,
        globals: [
          typeof globalThis.require,
          typeof globalThis.module,
          typeof globalThis.exports,
          typeof globalThis.__filename,
          typeof globalThis.__dirname
        ],
        initPaths,
        resolverPaths: require.resolve.paths('secure-eval-worker-probe'),
        nodeModulePaths: [
          moduleNamespace._nodeModulePaths,
          moduleNamespace.default._nodeModulePaths,
          moduleNamespace.Module._nodeModulePaths,
          bareModuleNamespace._nodeModulePaths,
          bareModuleNamespace.default._nodeModulePaths,
          require('node:module')._nodeModulePaths,
          require('module')._nodeModulePaths,
          moduleNamespace.Module._load('node:module')._nodeModulePaths,
          process.getBuiltinModule('node:module')._nodeModulePaths
        ].map((call) => typeof call === 'function' ? call(process.execPath) : []),
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
        identity: [process, namespace, namespace.default, builtin].map(value => ({
          pid: value.pid,
          ppid: value.ppid,
          title: value.title
        })),
        cwd: [process.cwd(), namespace.cwd(), namespace.default.cwd(), builtin.cwd()],
        execArgv: [process.execArgv, namespace.execArgv, namespace.default.execArgv, builtin.execArgv],
        execPath: [process.execPath, namespace.execPath, namespace.default.execPath, builtin.execPath]
      }
    `)
    assert.deepEqual(result.argv0, Array(4).fill(process.argv0), type)
    assert.deepEqual(result.identity, Array.from({ length: 4 }, () => ({
      pid: 0,
      ppid: 0,
      title: 'secure-eval-worker'
    })), type)
    assert.deepEqual(result.globals, Array(5).fill('undefined'), type)
    assert.equal(
      result.initPaths.every((code) => code === 'ERR_ACCESS_DENIED' || code === 'ABSENT'),
      true,
      type
    )
    assert.deepEqual(result.globalPaths, Array.from({ length: 11 }, () => []), type)
    assert.deepEqual(result.nodeModulePaths, Array.from({ length: 9 }, () => []), type)
    assert.deepEqual(result.resolverPaths, [], type)
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

test('static ESM policy failures are bounded and release admission', async (t) => {
  configureWorkerAdmission({ maxConcurrentWorkers: 1 })
  t.after(() => configureWorkerAdmission({ maxConcurrentWorkers: 8 }))
  const startedAt = Date.now()
  const sourceSession = createUntrustedWorker(`
    import 'node:diagnostics_channel'
    export default () => {}
  `, {
    type: 'module',
    startupTimeoutMs: 5_000,
    lifetimeTimeoutMs: 5_000
  })
  await assert.rejects(sourceSession.ready, (error) => {
    assert.equal(error.remoteCode, 'ERR_ACCESS_DENIED')
    return true
  })
  await sourceSession.closed
  assert.equal(await runUntrustedCode('return 41', { timeoutMs: 5_000 }), 41)

  const root = fs.mkdtempSync(join(tmpdir(), 'secure-eval-static-policy-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const entry = join(root, 'entry.mjs')
  fs.writeFileSync(entry, `
    import 'node:diagnostics_channel'
    export default () => 'ALLOWED'
  `)
  await assert.rejects(runUntrustedFile(entry, {
    rootDirectory: root,
    timeoutMs: 5_000
  }), (error) => {
    assert.equal(error.remoteCode, 'ERR_ACCESS_DENIED')
    return true
  })
  assert.equal(await runUntrustedCode('return 42', { timeoutMs: 5_000 }), 42)
  assert.equal(Date.now() - startedAt < 5_000, true)
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
  assert.deepEqual(results, ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'BLOCKED'])
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

test('enforces structural traversal budgets across persistent and host-function boundaries', async (t) => {
  let hostCalls = 0
  const session = createUntrustedWorker(`
    onMessage(async value => {
      if (value === 'large-result') {
        const result = {}
        for (let index = 0; index < 257; index++) result['property' + index] = index
        return result
      }
      if (value === 'large-host-argument') {
        const argument = new Map()
        for (let index = 0; index < 129; index++) argument.set(index, new SharedArrayBuffer(8))
        try { await tools.consume(argument) } catch (error) { return error.message }
      }
      if (value === 'large-host-result') {
        try { return await tools.largeResult() } catch (error) { return error.code }
      }
      return value
    })
  `, {
    ...SECURITY_TIMEOUTS,
    maxMessageBytes: 256,
    hostFunctions: {
      tools: {
        consume () { hostCalls++ },
        largeResult () {
          const result = new Set()
          for (let index = 0; index < 257; index++) result.add(index)
          return result
        }
      }
    }
  })
  session.on('error', () => {})
  t.after(() => session.terminate().catch(() => {}))
  await session.ready

  const broad = {}
  for (let index = 0; index < 257; index++) broad[`property${index}`] = index
  assert.throws(() => session.request(broad), /maxMessageBytes/)
  assert.match(await session.request('large-host-argument'), /maxMessageBytes/)
  assert.equal(hostCalls, 0)
  assert.equal(
    await session.request('large-host-result'),
    'ERR_UNTRUSTED_WORKER_HOST_FUNCTION'
  )
  await assert.rejects(
    session.request('large-result'),
    /(?:maxMessageBytes|Worker protocol failure)/
  )
  await session.closed
})

test('worker traversal uses captured size and reflection intrinsics', async () => {
  const result = await runUntrustedCode(`
    const map = new Map([['answer', 42]])
    const set = new Set([43])
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
    return { map, set }
  `, { timeoutMs: 5_000, maxMessageBytes: 256 })
  assert.deepEqual([...result.map], [['answer', 42]])
  assert.deepEqual([...result.set], [43])
})

test('enforces one-shot output string and graph budgets', async () => {
  for (const source of [
    "return 'x'.repeat(129)",
    `const shared = {}; return Array.from({ length: 129 }, () => shared)`,
    `let value = {}; for (let index = 0; index < 128; index++) value = { next: value }; return value`
  ]) {
    await assert.rejects(
      runUntrustedCode(source, { timeoutMs: 5_000, maxMessageBytes: 128 }),
      /(?:maxMessageBytes|Worker protocol failure)/
    )
  }
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
