import { EventEmitter } from 'node:events'

export type ProtocolPrimitive = undefined | null | boolean | number | bigint | string
export type ProtocolValue =
  | ProtocolPrimitive
  | ProtocolValue[]
  | { [key: string]: ProtocolValue }
  | ArrayBuffer
  | ArrayBufferView
  | Date
  | RegExp
  | Map<ProtocolValue, ProtocolValue>
  | Set<ProtocolValue>

export interface WorkerResourceLimits {
  maxOldGenerationSizeMb?: number
  maxYoungGenerationSizeMb?: number
  codeRangeSizeMb?: number
  stackSizeMb?: number
}

export type WorkerEnvironment = Readonly<Record<string, string>>
export type HostFunction<Arguments extends readonly unknown[] = readonly unknown[], Result = unknown> =
  (...argumentsList: Arguments) => Result | Promise<Result>
export type HostFunctionNamespace = Readonly<Record<string, HostFunction<any, any>>>
export type HostFunctionNamespaces = Readonly<Record<string, HostFunctionNamespace>>

export interface HostFunctionContext {
  readonly abortSignal: AbortSignal
  readonly sessionId: string
  readonly requestId: string
  readonly requestIndex: number
  readonly hostFunctionName: string
}

export interface HostFunctionErrorOptions extends ErrorOptions {
  code?: string
}

export class HostFunctionError extends Error {
  constructor(message: string, options?: HostFunctionErrorOptions)
  readonly code: string
}

export function getHostFunctionContext(): HostFunctionContext

export interface UntrustedCodeErrorOptions extends ErrorOptions {
  code?: string
  remoteCode?: string
  remoteStack?: string
}

export class UntrustedCodeError extends Error {
  constructor(message: string, options?: UntrustedCodeErrorOptions)
  readonly code: string
  readonly remoteCode?: string
  readonly remoteStack?: string
}

export type DiagnosticLevel = 'assert' | 'debug' | 'dir' | 'error' | 'info' | 'log' | 'table' | 'trace' | 'warn'

export interface DiagnosticRecord {
  readonly level: DiagnosticLevel
  readonly text: string
}

export interface DiagnosticOptions {
  maxRecords?: number
  maxBytes?: number
  maxRecordBytes?: number
}

export interface CommonWorkerOptions<Input = unknown, Hosts extends HostFunctionNamespaces = HostFunctionNamespaces> {
  input?: Input
  language?: 'javascript' | 'typescript'
  maxSourceBytes?: number
  environment?: WorkerEnvironment
  resourceLimits?: WorkerResourceLimits
  signal?: AbortSignal
  maxInputBytes?: number
  maxMessageBytes?: number
  maxOutputMessages?: number
  maxOutputBytes?: number
  hostFunctions?: Hosts
  maxHostFunctionCalls?: number
  maxInFlightHostFunctions?: number
  diagnostics?: boolean | DiagnosticOptions
  onDiagnostic?: (record: DiagnosticRecord) => void | Promise<void>
}

export interface RunUntrustedCodeOptions<Input = unknown, Hosts extends HostFunctionNamespaces = HostFunctionNamespaces>
  extends CommonWorkerOptions<Input, Hosts> {
  timeoutMs?: number
}

export function runUntrustedCode<
  Output = unknown,
  Input = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
>(source: string, options?: RunUntrustedCodeOptions<Input, Hosts>): Promise<Output>

export interface LocalModuleOptions {
  rootDirectory?: string | URL
  maxRootEntries?: number
  maxFileBytes?: number
  maxTotalFileBytes?: number
}

export type RunUntrustedFileOptions<
  Input = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
> = Omit<RunUntrustedCodeOptions<Input, Hosts>, 'language' | 'maxSourceBytes'> & LocalModuleOptions

export function runUntrustedFile<
  Output = unknown,
  Input = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
>(modulePath: string | URL, options?: RunUntrustedFileOptions<Input, Hosts>): Promise<Output>

export type RunnerDefaultOptions<Hosts extends HostFunctionNamespaces = HostFunctionNamespaces> =
  Omit<RunUntrustedCodeOptions<never, Hosts>, 'input' | 'signal'>

export interface UntrustedRunner<DefaultHosts extends HostFunctionNamespaces = HostFunctionNamespaces> {
  <Output = unknown, Input = unknown, Hosts extends HostFunctionNamespaces = DefaultHosts>(
    source: string,
    options?: RunUntrustedCodeOptions<Input, Hosts>
  ): Promise<Output>
}

export function createRunner<Hosts extends HostFunctionNamespaces = HostFunctionNamespaces>(
  defaultOptions?: RunnerDefaultOptions<Hosts>
): UntrustedRunner<Hosts>

export interface UntrustedWorkerOptions<
  SetupInput = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
> extends CommonWorkerOptions<SetupInput, Hosts> {
  type?: 'script' | 'module'
  startupTimeoutMs?: number
  messageTimeoutMs?: number
  lifetimeTimeoutMs?: number
}

export interface UntrustedWorkerRequestOptions {
  timeoutMs?: number
}

export interface UntrustedWorkerClosedResult {
  code: number | undefined
  error: Error | undefined
}

export type UntrustedWorkerState = 'starting' | 'ready' | 'closing' | 'closed'

/** Security-sensitive final class. Runtime construction of subclasses throws. */
export class UntrustedWorkerSession<
  InboundMessage = unknown,
  Response = unknown,
  OutboundMessage = unknown,
  SetupInput = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
> extends EventEmitter {
  constructor(source: string, options?: UntrustedWorkerOptions<SetupInput, Hosts>)
  readonly ready: Promise<void>
  readonly closed: Promise<UntrustedWorkerClosedResult>
  readonly state: UntrustedWorkerState

  postMessage(value: InboundMessage): void
  request(value: InboundMessage, options?: UntrustedWorkerRequestOptions): Promise<Response>
  terminate(): Promise<number | undefined>

  on(event: 'message', listener: (value: OutboundMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'diagnostic', listener: (record: DiagnosticRecord) => void): this
  once(event: 'message', listener: (value: OutboundMessage) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number) => void): this
  once(event: 'diagnostic', listener: (record: DiagnosticRecord) => void): this
}

export function createUntrustedWorker<
  SetupInput = unknown,
  InboundMessage = unknown,
  Response = unknown,
  OutboundMessage = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
>(
  source: string,
  options?: UntrustedWorkerOptions<SetupInput, Hosts>
): UntrustedWorkerSession<InboundMessage, Response, OutboundMessage, SetupInput, Hosts>

export type UntrustedWorkerFileOptions<
  SetupInput = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
> = Omit<UntrustedWorkerOptions<SetupInput, Hosts>, 'type' | 'language' | 'maxSourceBytes'> &
  LocalModuleOptions

export function createUntrustedWorkerFromFile<
  SetupInput = unknown,
  InboundMessage = unknown,
  Response = unknown,
  OutboundMessage = unknown,
  Hosts extends HostFunctionNamespaces = HostFunctionNamespaces
>(
  modulePath: string | URL,
  options?: UntrustedWorkerFileOptions<SetupInput, Hosts>
): Promise<UntrustedWorkerSession<InboundMessage, Response, OutboundMessage, SetupInput, Hosts>>

export interface WorkerAdmissionOptions {
  maxConcurrentWorkers: number
}

export interface WorkerAdmissionStatus {
  readonly maxConcurrentWorkers: number
  readonly activeWorkers: number
}

export function configureWorkerAdmission(options: WorkerAdmissionOptions): WorkerAdmissionStatus
export function sanitizeEnvironment(environment?: WorkerEnvironment): Record<string, string>
