# secure-eval-worker

Run JavaScript scripts, self-contained ES modules, or trusted-root local module trees in Node.js workers with a small, explicitly defined authority set. Use one-shot evaluation or create a persistent session that exchanges messages with the component.

Each worker starts with Node's Permission Model enabled. Source-string workers receive only the `worker` permission; local-file workers additionally receive read permission for a private staged snapshot of their trusted root. The trusted bootstrap immediately calls `process.permission.drop('worker')` before compiling, importing, or invoking caller-provided source. The worker also receives an explicit environment instead of inheriting `process.env`, has V8 resource limits, and is terminated after a deadline.

> [!WARNING]
> Node's Permission Model and `node:worker_threads` are defense-in-depth controls, **not a complete security boundary against malicious code**. Workers share a process, and resource limits do not constrain every kind of allocation. For adversarial multi-tenant workloads, put this module inside a separately sandboxed process or container with OS-level CPU, memory, filesystem, network, and syscall restrictions.

## Requirements

- Node.js 26.5.1 through the current Node.js 26.x release (`process.permission.drop()` and security fixes in 26.5.1 are required). Unsupported runtimes fail closed during module initialization with `ERR_SECURE_EVAL_UNSUPPORTED_RUNTIME`. Future major releases require a new hardening review before support is declared.
- No permission flags are required when the host uses Node's default mode. If the host itself runs with `--permission`, it must include `--allow-worker`. Path-based execution additionally requires host read permission for the entry/root and read/write permission for the operating-system temporary directory used to create and remove the private snapshot. Each sandbox worker is started with its own reviewed `execArgv`.

## Installation

```sh
npm install secure-eval-worker
```

## Usage

```js
import { runUntrustedCode } from 'secure-eval-worker'

const value = await runUntrustedCode(
  'return input.values.reduce((sum, value) => sum + value, 0)',
  {
    input: { values: [10, 20, 12] },
    timeoutMs: 500,
    environment: { LANG: 'C' }
  }
)

console.log(value) // 42
```

The source is the body of an async function with one argument named `input`. Setup input is copied through `workerData`; the result uses the authenticated private channel. Shared memory and unsupported platform objects are rejected in both directions.

One-shot source can use the same explicit host-function capabilities as a persistent component without changing that function signature:

```js
const record = await runUntrustedCode(
  'return records.find(input.id)',
  {
    input: { id: 'record-42' },
    hostFunctions: {
      records: {
        find: async (id) => database.records.find(id)
      }
    }
  }
)
```

### Persistent script component

```js
import { createUntrustedWorker } from 'secure-eval-worker'

const component = createUntrustedWorker(`
  const profile = await users.find(input.userId)
  send({ status: 'started', profile })

  onMessage(async (message) => {
    send({ observed: message })
    return audit.record(message)
  })
`, {
  input: { userId: 'user-123' },
  hostFunctions: {
    users: {
      find: async (id) => database.users.find(id)
    },
    audit: {
      record: async (message) => ({ recorded: true, message })
    }
  },
  lifetimeTimeoutMs: 60_000
})

component.on('message', (message) => {
  console.log('component message:', message)
})
component.on('error', (error) => {
  console.error('component error:', error)
})

await component.ready
component.postMessage({ kind: 'notification' })
const reply = await component.request({ kind: 'question' })
await component.terminate()
```

Script source is an async function body with `input`, `send(value)`, and `onMessage(handler)` arguments.

### Persistent ES module component

```js
const component = createUntrustedWorker(`
  export default async function setup ({ input, send, onMessage }) {
    send({ status: 'started', input })
    onMessage(async (message) => ({ echo: message }))
  }
`, {
  type: 'module',
  input: { tenant: 'example' },
  lifetimeTimeoutMs: 60_000
})

await component.ready
console.log(await component.request('hello')) // { echo: 'hello' }
await component.terminate()
```

Module source must be self-contained ESM with a default setup-function export. It is imported from an in-memory `data:` URL after permissions are dropped. Built-in imports are permitted subject to the Permission Model, but relative files, package imports, and filesystem module paths are not resolved from source strings. Use the path APIs below or bundle authorized dependencies on the trusted host as described in [`docs/module-dependencies.md`](docs/module-dependencies.md).

### Local module files

Use `runUntrustedFile()` to execute an ESM entry file. The module must default-export a function receiving `input`:

```js
import { runUntrustedFile } from 'secure-eval-worker'

const result = await runUntrustedFile('./components/calculate.mjs', {
  rootDirectory: './components',
  input: { values: [10, 20, 12] },
  timeoutMs: 500
})
```

Static and dynamic imports are resolved by Node's native module loader. `rootDirectory` defaults to the entry file's directory and is treated as the source authorization boundary. Before worker startup, the host copies its regular files into a private temporary snapshot using no-follow file handles where supported, canonical containment and file-identity checks. Symbolic links and special files are rejected. The worker receives `--allow-fs-read` only for that snapshot, so changes made after staging cannot redirect guest reads or imports. `maxRootEntries` bounds staging and defaults to 10,000. `maxFileBytes` and `maxTotalFileBytes` default to 1 MiB and 16 MiB.

Use the asynchronous `createUntrustedWorkerFromFile()` factory for a persistent component:

```js
import { createUntrustedWorkerFromFile } from 'secure-eval-worker'

const component = await createUntrustedWorkerFromFile(
  './components/service.mjs',
  {
    rootDirectory: './components',
    input: { tenant: 'example' },
    lifetimeTimeoutMs: 60_000
  }
)

await component.ready
console.log(await component.request('hello'))
await component.terminate()
```

Its default export uses the same `{ input, send, onMessage, host }` setup contract as an in-memory module. JavaScript and Node's native erase-only TypeScript module formats are supported according to the selected file extension.

The trusted root is an explicit authority grant. Guest code can use the retained synchronous `node:fs` read facade to read files in its staged snapshot, and imported code can load any Node-supported module or data copied from the root. Hard-linked regular files are treated as root contents and their bytes are copied even when the same inode also has names outside the root. Never include secrets, native addons, sockets, or unrelated application files in that directory. Filesystem writes, promise-based filesystem APIs, inherited descriptors, and reads outside the snapshot remain disabled. Guest-opened descriptors are capped at 64 per local worker and 256 process-wide, independent of the configured worker limit. Node's worker descriptor tracking closes retained descriptors on actual worker exit, when their process-wide quota is also released. The source filesystem and any process able to mutate it must remain trusted during staging: portable Node APIs cannot prove path containment against an actively adversarial parent-directory rename/symlink race. Concurrent changes can also make staging fail or produce files captured at different instants. The temporary-directory namespace and every same-identity process must remain trusted for the snapshot's lifetime because owner permissions do not isolate processes running as the same OS user. Use an application-owned immutable source tree—or an outer OS sandbox with a separate identity—when either race is in scope. Snapshot cleanup gets a bounded public wait; unresolved removal remains owned by a separately admitted janitor without delaying terminal session settlement, and completed failures are retried with exponential backoff. Cleanup failures are reported with `ERR_UNTRUSTED_MODULE_CLEANUP`, `ERR_UNTRUSTED_WORKER_CLEANUP`, or `ERR_UNTRUSTED_CODE_CLEANUP`.

### Host functions

Host functions provide narrow, explicit capabilities without adding ambient filesystem, network, database, or secret access to the worker. Local-file workers separately retain their configured read root. Groups are installed as read-only globals in both script and module source. Module setup also receives the same null-prototype object as `host`.

```js
const component = createUntrustedWorker(`
  onMessage(async (id) => records.find(id))
`, {
  hostFunctions: {
    records: {
      find: async (id) => {
        // Validate and authorize untrusted arguments here.
        return database.records.find(id)
      }
    }
  }
})
```

Functions may be synchronous or asynchronous from the host's perspective and always return promises to guest source. Synchronous results are treated as data without reading or calling a `then` property; return a canonical native `Promise` when asynchronous settlement is required. Promise subclasses, proxies, custom promise prototypes, and own `constructor` overrides are rejected rather than assimilated. Frozen canonical native promises remain supported. Calls can run concurrently. Unexpected host errors are redacted to avoid leaking paths, queries, endpoints, or credentials. Throw `HostFunctionError` when a message and code are intentionally safe to disclose to guest code.

Use `getHostFunctionContext()` inside a host function to access:

- `abortSignal`, aborted when the session is cancelled, times out, fails, or terminates;
- `sessionId`;
- `requestId` and one-based `requestIndex`; and
- `hostFunctionName`, such as `records.find`.

The context is available only while that host function is active. Its identifiers are guest-influenced tracing metadata, not authorization identities. Bind tenant/principal authority into trusted host-function closures. Pass the signal to database, HTTP, or other cancellable operations. Cancellation cannot undo a side effect that already completed, so writes still need application-level authorization and idempotency. A host function cannot make a request to the same session because serialized guest dispatch would deadlock; such calls throw `ERR_UNTRUSTED_WORKER_REENTRANT_REQUEST`.

## API

The package includes TypeScript declarations. `runUntrustedCode<Output, Input>()`, `runUntrustedFile<Output, Input>()`, and the corresponding persistent factories can type host-side inputs and outputs; runtime protocol validation remains authoritative.

### `runUntrustedCode(source[, options])`

Returns a promise for the result. Every unrecognized option is rejected rather
than ignored, so misspelled security limits cannot silently fall back to a
different value.

Options:

- `input`: copied input exposed as `input`, restricted to the protocol value types documented below.
- `timeoutMs`: positive integer deadline, including input cloning and worker startup, up to `2147483647`. Default: `1000`. Synchronous structured cloning cannot be interrupted; an overrun is reported immediately afterward.
- `maxSourceBytes`: maximum UTF-8 source size. Default: 64 KiB.
- `environment`: explicit string-to-string environment. Nothing from the host environment is inherited by default. Runtime-control `NODE_*` variables other than `NODE_ENV`, npm user-config, dynamic-loader, OpenSSL config, and TLS key-log variables are rejected.
- `resourceLimits`: overrides for Worker V8 limits (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `codeRangeSizeMb`, and `stackSizeMb`).
- `signal`: an `AbortSignal` that terminates the worker.
- `language`: `javascript` (default) or `typescript`. TypeScript mode erases supported type-only syntax; it does not type-check source and rejects syntax requiring transformation.
- `hostFunctions`, `maxHostFunctionCalls`, and `maxInFlightHostFunctions`: equivalent to the persistent options below.
- `maxInputBytes`, `maxMessageBytes`, `maxOutputMessages`, and `maxOutputBytes`: equivalent to the persistent options below.
- `diagnostics` and `onDiagnostic`: opt into bounded, sanitized console records as described below.

Every execution uses a new worker. If Node cannot interrupt synchronous native work, the execution promise rejects after an additional bounded termination-settlement window with `ERR_UNTRUSTED_CODE_TERMINATION_TIMEOUT`; admission remains occupied until actual exit. Source-string execution cannot obtain filesystem, network, child-process, native-addon, inspector, WASI, or nested-worker access through supported Node APIs because none of those permissions remain when source starts. Local-file execution retains read access only to its private staged snapshot for native module loading and path-based reads. Known Permission Model gaps and process-wide APIs are additionally disabled before source is loaded. Ordinary guest stdout and stderr writes are discarded rather than forwarded into host logs.

### `runUntrustedFile(modulePath[, options])`

Asynchronously stages a path string or `file:` URL and executes its default-exported function in a fresh worker. Options match `runUntrustedCode()` except `language` and `maxSourceBytes`, plus `rootDirectory`, `maxRootEntries`, `maxFileBytes`, and `maxTotalFileBytes`. `timeoutMs` actively bounds staging, worker startup, and execution. The file extension selects Node's module format and optional native TypeScript stripping. Local drive roots and junction rejection are covered on Windows CI; UNC/network-share roots remain outside the tested local-root profile.

### `createUntrustedWorkerFromFile(modulePath[, options])`

Asynchronously returns an `UntrustedWorkerSession` for a staged local module. Options match `createUntrustedWorker()` except `type`, `language`, and `maxSourceBytes`, plus `rootDirectory`, `maxRootEntries`, `maxFileBytes`, and `maxTotalFileBytes`. `startupTimeoutMs` actively bounds staging and worker startup. The entry must default-export the persistent setup function.

### `createRunner([defaultOptions])`

Returns a callable wrapper around `runUntrustedCode()` with validated, snapshotted defaults. `input` and `signal` remain invocation-specific. Nested policies such as `environment`, `resourceLimits`, and `hostFunctions` are replaced—not deep-merged—by per-run overrides. Every invocation still creates a fresh worker.

### `configureWorkerAdmission({ maxConcurrentWorkers })`

Sets the fail-fast process-wide admission limit shared by one-shot runs and persistent sessions. Local-file staging holds the same slot that is later transferred to its worker. The measured conservative default is `4`. There is no internal queue. Persistent creation throws `ERR_UNTRUSTED_WORKER_CAPACITY`; one-shot execution rejects with `ERR_UNTRUSTED_CODE_CAPACITY`. Sandbox creation from host worker threads fails closed with `ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE` so terminating a host thread cannot orphan a slot. Slots are released only after sandbox worker exit. See [`docs/worker-admission.md`](docs/worker-admission.md) for backpressure guidance and limitations.

### `createUntrustedWorker(source[, options])`

Returns an `UntrustedWorkerSession` immediately so listeners can be attached before startup finishes. `options.type` is `script` by default or `module` for the ESM setup contract above.

Options:

- `input`: copied setup input, restricted to the protocol value types documented below.
- `type`: `script` or `module`. Default: `script`.
- `language`: `javascript` (default) or erase-only `typescript`.
- `startupTimeoutMs`: deadline for cloning, worker startup, module evaluation, and setup. Default: `1000`.
- `messageTimeoutMs`: default deadline for each `request()`. A timed-out request terminates the whole session because a CPU-bound handler cannot be interrupted independently. Default: `1000`.
- `lifetimeTimeoutMs`: maximum session lifetime after startup. Default: `30000`.
- `hostFunctions`: namespaced host functions exposed as explicit guest capabilities. Default: none.
- `maxHostFunctionCalls`: maximum accepted host calls during the session. Default: `256`.
- `maxInFlightHostFunctions`: maximum host calls executing concurrently. Exceeding either host-call limit terminates the session. Default: `32`.
- `maxInputBytes`: maximum V8-serialized setup input size and the independent incremental limits used while validating its graph. Default: 1 MiB.
- `maxMessageBytes`: maximum V8-serialized protocol body size and the independent incremental limits used while validating each protocol graph; must be at least 128 bytes. Default: 1 MiB.
- `maxOutputMessages`: maximum unsolicited messages and attempted host calls emitted by guest code. Default: `1024`.
- `maxOutputBytes`: cumulative serialized-byte budget for unsolicited messages and attempted host calls. Default: 16 MiB.
- `diagnostics`: `true` or `{ maxRecords, maxBytes, maxRecordBytes }` to enable sanitized console records. Defaults: 100 records, 64 KiB total, and 4 KiB per record. Output remains discarded when disabled.
- `onDiagnostic(record)`: optional callback receiving frozen `{ level, text }` records; providing it enables default diagnostic limits. Asynchronous callbacks must return canonical native `Promise` instances under the same restrictions as host functions.
- `maxSourceBytes`, `environment`, `resourceLimits`, and `signal`: equivalent to the one-shot options.

`UntrustedWorkerSession` is security-sensitive and final: constructing a subclass
throws. Its public lifecycle methods are installed as immutable own methods, while
internal handlers and mutable control state are private, so caller-defined properties
cannot replace trusted termination and cleanup behavior.

Session interface:

- `ready`: promise resolved after script setup or the module's default setup function completes. Setup return values are ignored.
- `postMessage(value)`: delivers a message without waiting for its return value.
- `request(value[, { timeoutMs }])`: delivers a message and resolves with the handler's return value.
- `terminate()`: idempotently requests worker termination. It rejects with `ERR_UNTRUSTED_WORKER_TERMINATION_TIMEOUT` if the worker does not exit within the bounded settlement window.
- `closed`: promise resolved with `{ code, error }` after worker exit, or with a termination error when that bounded window expires. Admission and local-file preparation remain occupied until the worker actually exits and snapshot cleanup finishes.
- Events: `message` for values passed to `send()`, `diagnostic` for opt-in console records, `error` for runtime/session errors, and `exit` for worker exit. Attach an `error` listener when runtime notifications need to be observed.

`onMessage()` registers one handler, and messages are processed serially. Input, posts, requests, replies, unsolicited messages, and host-function arguments/results are copied. Transfer lists and all shared-memory representations—including `SharedArrayBuffer`, shared typed-array/DataView backing stores, and shared `WebAssembly.Memory`—are rejected. Protocol values are restricted to primitives, plain objects and arrays containing only enumerable data properties, `ArrayBuffer` and non-shared views, `Date`, `RegExp`, `Map`, and `Set`. Accepted branded values must have only their canonical intrinsic own properties; unexpected expandos, accessors, and symbols are rejected. Before cloning or serialization, validation independently bounds encountered string and property-key code units, unique object nodes, graph edges, inspected properties, collection entries, cumulative bytes of unique backing `ArrayBuffer` instances, and pending traversal width using the active byte limit. Intrinsic view lengths and Map/Set sizes are charged before descriptor enumeration or iterator advancement. JavaScript provides no bounded own-key iterator, so obtaining the own-key array for one otherwise in-budget plain object remains an unavoidable allocation; descriptor creation and value traversal occur only after the key count is admitted. A genuine `RegExp` may carry a nonnegative safe-integer `lastIndex`; Node's structured clone normalizes that index to zero at the boundary. Custom class instances; accessors, symbols, and non-enumerable properties on plain objects or arrays; and platform objects such as `Blob`, ports, file handles, sockets, cryptographic key objects, and ordinary `Error` values are rejected before cloning. Null-prototype objects are accepted as data but Node's structured clone normalizes them to ordinary objects at the worker boundary. Use explicit plain error data when needed; see [`docs/error-values.md`](docs/error-values.md). The exact serialized bytes—not a second representation of the value—are authenticated before deserialization.

Diagnostics use a separate private channel, key, sequence, and byte/count budgets. Control replies carry a diagnostic watermark, so asynchronous callbacks for earlier records settle first. Formatting never reads object properties or invokes custom inspection. Strings have terminal control characters escaped. A callback cannot request from its own session because waiting would deadlock; this throws `ERR_UNTRUSTED_WORKER_REENTRANT_DIAGNOSTIC`. A callback failure uses `ERR_UNTRUSTED_WORKER_DIAGNOSTIC_CALLBACK` for sessions and `ERR_UNTRUSTED_CODE_DIAGNOSTIC_CALLBACK` for one-shot calls; the default remains complete suppression.

### `getHostFunctionContext()`

Returns metadata and an `AbortSignal` for the active host-function call. Throws outside a host function or from detached work after the function settles.

### `HostFunctionError`

Throw `new HostFunctionError(publicMessage, { code })` from a host function only when both fields are safe for untrusted code. Other host errors become a generic `HostFunctionError` with code `ERR_UNTRUSTED_WORKER_HOST_FUNCTION`.

### `sanitizeEnvironment(environment)`

Validates an explicit environment and returns a null-prototype copy. Values must be strings. Runtime-control variables such as `NODE_OPTIONS`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` are rejected.

### `UntrustedCodeError`

Errors originating from execution use this class and have a machine-readable `code`. A complete remote stack, when available, is exposed as `remoteStack` rather than replacing the trusted caller's local stack. The stack is size-bounded, has control characters escaped, and uses stable virtual filenames with wrapper-adjusted coordinates; frames are otherwise preserved. `remoteStack` remains guest-influenced, untrusted diagnostic text and must never be used for authorization or provenance. Argument validation and structured-clone failures are thrown synchronously; execution failures reject the returned promise. See [Error and stack-trace policy](docs/error-values.md) for the guest-to-host, host-to-guest, and diagnostics policies and the comparison with SES error taming.

## Security notes

- Untrusted source is passed via `workerData`; it is never interpolated into the trusted bootstrap source.
- The worker gets `env: {}` unless an explicit environment is supplied. Never place secrets in that environment.
- Do not place secrets in `worker_threads.setEnvironmentData()`: Node clones global worker environment data into new workers independently of `WorkerOptions.env`. This module blocks the public getter, heap-snapshot APIs, and `v8.queryObjects()`, but avoiding the secret entirely is safer against future or internal APIs.
- Both execution modes create a private `MessageChannel` inside the trusted bootstrap, close and hide `parentPort`, freeze the privileged port's prototype chain, and authenticate serialized payloads with a per-session HMAC and monotonic sequence number. Capturing or replaying a port cannot forge control traffic.
- Before guest execution, the bootstrap disables known same-process escape surfaces not covered by permissions: existing-descriptor access through public modules, including undocumented child-process IPC adoption; DNS and legacy network-module aliases; global `fetch`/`WebSocket`; accessor-exported stream constructors; and undocumented native bindings. It also disables asynchronous module-loader registration; `node:sqlite`; OpenSSL engine/FIPS mutation and secure-heap telemetry; trace/QUIC built-ins (explicitly denied when available and otherwise left unavailable without enabling runtime flags); process signaling, reports, and high-resolution host-lifetime clocks; process priority mutation; guest-facing V8 and performance hooks, serializers, profilers, snapshot callbacks, flag mutation, and object queries; async hooks; BroadcastChannel, Web Locks, cross-thread messaging, inherited worker environment data, and host identity/resource metadata APIs. The only guest-visible high-resolution clocks are worker-bootstrap-relative: a frozen null-prototype performance object shared by the global and built-in aliases exposes monotonic `now()`, `timeOrigin: 0`, and `nodeTiming: null`, while `Event.prototype.timeStamp` and inherited event timestamps use the same relative baseline. The original Performance constructors, prototypes, and observer paths are unavailable. Guest `argv`, current-directory reporting, executable arguments, executable path, process IDs, process title, and global module search paths are replaced with fixed or empty virtual values. Eval-wrapper `require`, `module`, `exports`, `__filename`, and `__dirname` globals are removed; CommonJS modules inside a staged local tree retain only root-confined lexical loading and resolver paths. The read-only `v8.startupSnapshot.isBuildingSnapshot()` probe remains available because Node's TypeScript erasure depends on it; callable V8 capabilities are otherwise denied. Node exposes `process.argv0` as a non-configurable worker property, so it remains visible through global, ESM, CommonJS, and `process.getBuiltinModule()` aliases; launch the host with a non-sensitive `argv0` value when this metadata matters.
- Host functions are authority grants. They must validate and authorize every argument, constrain outputs, and avoid exposing generic filesystem or network primitives when a narrower business operation is possible.
- A timed-out worker is sent a termination request, but Worker resource limits do not constrain `ArrayBuffer`, WebAssembly, native allocations, aggregate CPU, all libuv-thread-pool work, or process-wide out-of-memory failure. Uninterruptible native work can continue after the public termination promises settle with a termination error; its admission slot remains occupied until the actual worker exit. Host functions that ignore their abort signal may also continue host-side work after termination.
- JavaScript taming is additional defense in depth, not a substitute for an OS boundary. Future Node APIs, undocumented internals, native/runtime vulnerabilities, or process-wide behavior can invalidate it. Run adversarial multi-tenant code in a separately sandboxed process or container.

## Development

```sh
npm ci
npm test
npm run test:coverage
npm run test:types
npm run test:package
```

## License

[MIT](LICENSE)
