import {
  configureWorkerAdmission,
  createRunner,
  createUntrustedWorker,
  getHostFunctionContext,
  HostFunctionError,
  runUntrustedCode,
  sanitizeEnvironment,
  UntrustedCodeError,
  UntrustedWorkerSession,
  type HostFunctionNamespaces,
  type ProtocolValue,
  type UntrustedWorkerClosedResult
} from 'secure-eval-worker'

const hosts = {
  math: {
    add (left: number, right: number) {
      const context = getHostFunctionContext()
      context.abortSignal.throwIfAborted()
      const requestIndex: number = context.requestIndex
      return left + right + requestIndex - requestIndex
    }
  },
  text: {
    async upper (value: string) {
      return value.toUpperCase()
    }
  }
} satisfies HostFunctionNamespaces

const result: number = await runUntrustedCode<number, { value: number }, typeof hosts>(
  'return math.add(input.value, 1)',
  {
    input: { value: 41 },
    hostFunctions: hosts,
    timeoutMs: 1_000,
    maxHostFunctionCalls: 10,
    maxInFlightHostFunctions: 2,
    maxInputBytes: 1024,
    maxMessageBytes: 1024,
    maxOutputMessages: 10,
    maxOutputBytes: 4096,
    environment: { NODE_ENV: 'test' },
    resourceLimits: { stackSizeMb: 4 },
    diagnostics: { maxRecords: 10, maxBytes: 4096, maxRecordBytes: 1024 },
    onDiagnostic: (record) => {
      const text: string = record.text
      void text
    }
  }
)
void result

const session = createUntrustedWorker<
  { initial: number },
  { value: number },
  { doubled: number },
  { notice: string },
  typeof hosts
>('onMessage(message => ({ doubled: message.value * 2 }))', {
  input: { initial: 1 },
  hostFunctions: hosts,
  type: 'script'
})

await session.ready
session.postMessage({ value: 21 })
const response: { doubled: number } = await session.request({ value: 21 }, { timeoutMs: 500 })
session.on('message', (message) => {
  const notice: string = message.notice
  void notice
})
session.on('error', (error) => {
  const value: Error = error
  void value
})
session.on('exit', (code) => {
  const value: number = code
  void value
})
session.on('diagnostic', (record) => {
  const value: string = record.text
  void value
})
const closed: UntrustedWorkerClosedResult = await session.closed
void response
void closed
await session.terminate()

const constructed = new UntrustedWorkerSession<
  { value: number },
  number,
  string,
  { initial: boolean },
  typeof hosts
>('onMessage(message => message.value)', {
  input: { initial: true },
  hostFunctions: hosts
})
await constructed.terminate()

const protocolValues: ProtocolValue[] = [
  null,
  1n,
  { nested: ['value'] },
  new ArrayBuffer(8),
  new Uint8Array(8),
  new Date(),
  /value/,
  new Map([[1, 'one']]),
  new Set([true])
]
void protocolValues

const publicError = new HostFunctionError('safe', { code: 'SAFE', cause: new Error('cause') })
const executionError = new UntrustedCodeError('failed', {
  code: 'ERR_TEST',
  remoteCode: 'REMOTE',
  remoteStack: 'stack'
})
void publicError
void executionError
void sanitizeEnvironment({ NODE_ENV: 'test' })
void configureWorkerAdmission({ maxConcurrentWorkers: 4 })
const runner = createRunner<typeof hosts>({ hostFunctions: hosts, timeoutMs: 1_000 })
const runnerResult: string = await runner<string, { value: string }>('return input.value', {
  input: { value: 'typed' }
})
void runnerResult

// @ts-expect-error timeout must be numeric
void runUntrustedCode('return 1', { timeoutMs: 'fast' })
// @ts-expect-error environment values must be strings
void runUntrustedCode('return 1', { environment: { VALUE: 1 } })
// @ts-expect-error request input is typed
session.postMessage({ value: 'wrong' })
// @ts-expect-error request input is typed
void session.request({ other: 1 })
// @ts-expect-error admission limit is required
void configureWorkerAdmission({})
// @ts-expect-error public error codes are strings
void new HostFunctionError('safe', { code: 42 })
