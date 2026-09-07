import { performance } from 'node:perf_hooks'

import { configureWorkerAdmission, createUntrustedWorker } from '../src/index.js'

const count = Number.parseInt(process.argv[2] ?? '4', 10)
if (!Number.isSafeInteger(count) || count <= 0 || count > 32) {
  throw new RangeError('worker count must be between 1 and 32')
}
configureWorkerAdmission({ maxConcurrentWorkers: count })

const sessions = []
const samples = []
const memory = () => {
  globalThis.gc?.()
  const usage = process.memoryUsage()
  return {
    rssMiB: Number((usage.rss / 1024 / 1024).toFixed(2)),
    heapUsedMiB: Number((usage.heapUsed / 1024 / 1024).toFixed(2)),
    externalMiB: Number((usage.external / 1024 / 1024).toFixed(2)),
    arrayBuffersMiB: Number((usage.arrayBuffers / 1024 / 1024).toFixed(2))
  }
}

samples.push({ workers: 0, startupMs: 0, ...memory() })
for (let index = 1; index <= count; index++) {
  const startedAt = performance.now()
  const session = createUntrustedWorker('onMessage(value => value)', {
    startupTimeoutMs: 5_000,
    messageTimeoutMs: 5_000,
    lifetimeTimeoutMs: 60_000
  })
  sessions.push(session)
  await session.ready
  await session.request({ sample: index })
  samples.push({
    workers: index,
    startupMs: Number((performance.now() - startedAt).toFixed(2)),
    ...memory()
  })
}

await Promise.all(sessions.map((session) => session.terminate()))
await Promise.all(sessions.map((session) => session.closed))
await new Promise((resolve) => setTimeout(resolve, 100))
samples.push({ workers: 0, phase: 'terminated', startupMs: 0, ...memory() })
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, samples }, null, 2))
