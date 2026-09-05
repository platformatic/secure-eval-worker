# secure-eval-worker

Run JavaScript scripts or self-contained ES modules in Node.js workers with a small, explicitly defined authority set. Use one-shot evaluation or create a persistent session that exchanges messages with the component.

Each worker starts with Node's Permission Model enabled and only the `worker` permission. Its trusted bootstrap immediately calls `process.permission.drop('worker')` before compiling, importing, or invoking caller-provided source. The worker also receives an explicit environment instead of inheriting `process.env`, has V8 resource limits, and is terminated after a deadline.

> [!WARNING]
> Node's Permission Model and `node:worker_threads` are defense-in-depth controls, **not a complete security boundary against malicious code**. Workers share a process, and resource limits do not constrain every kind of allocation. For adversarial multi-tenant workloads, put this module inside a separately sandboxed process or container with OS-level CPU, memory, filesystem, network, and syscall restrictions.

## Requirements

- Node.js 26.3.0 or newer (`process.permission.drop()` is required)
- No permission flags are required when the host uses Node's default mode. If the host itself runs with `--permission`, it must include `--allow-worker`. Each sandbox worker is started with its own reviewed `execArgv`.

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

The source is the body of an async function with one argument named `input`. Both `input` and the returned value cross the worker boundary using Node's structured-clone algorithm. Shared memory is rejected in both directions.

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

Module source must be self-contained ESM with a default setup-function export. It is imported from an in-memory `data:` URL after permissions are dropped. Built-in imports are permitted subject to the Permission Model, but relative files, package imports, and filesystem module paths are not resolved.

### Host functions

Host functions provide narrow, explicit capabilities without granting ambient filesystem, network, database, or secret access to the worker. Groups are installed as read-only globals in both script and module source. Module setup also receives the same null-prototype object as `host`.

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

Functions may be synchronous or asynchronous from the host's perspective and always return promises to guest source. Calls can run concurrently. Host errors are copied without their host stack, while guest code may catch the resulting error and continue.

Use `getHostFunctionContext()` inside a host function to access:

- `abortSignal`, aborted when the session is cancelled, times out, fails, or terminates;
- `sessionId`;
- `requestId` and one-based `requestIndex`; and
- `hostFunctionName`, such as `records.find`.

The context is available only while that host function is active. Pass its signal to database, HTTP, or other cancellable operations. Cancellation cannot undo a side effect that already completed, so writes still need application-level authorization and idempotency.

## API

### `runUntrustedCode(source[, options])`

Returns a promise for the result.

Options:

- `input`: structured-cloneable input exposed as `input`.
- `timeoutMs`: positive integer deadline, including input cloning and worker startup, up to `2147483647`. Default: `1000`. Synchronous structured cloning cannot be interrupted; an overrun is reported immediately afterward.
- `maxSourceBytes`: maximum UTF-8 source size. Default: 64 KiB.
- `environment`: explicit string-to-string environment. Nothing from the host environment is inherited by default. Node loader/options, npm user-config, dynamic-loader, OpenSSL config, and TLS key-log variables are rejected.
- `resourceLimits`: overrides for Worker V8 limits (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `codeRangeSizeMb`, and `stackSizeMb`).
- `signal`: an `AbortSignal` that terminates the worker.

Every execution uses a new worker. Source cannot obtain filesystem, network, child-process, native-addon, inspector, WASI, or nested-worker access through supported Node APIs because none of those permissions remain when source starts. Worker stdout and stderr are drained and discarded rather than forwarded into host logs.

### `createUntrustedWorker(source[, options])`

Returns an `UntrustedWorkerSession` immediately so listeners can be attached before startup finishes. `options.type` is `script` by default or `module` for the ESM setup contract above.

Options:

- `input`: structured-cloneable setup input.
- `type`: `script` or `module`. Default: `script`.
- `startupTimeoutMs`: deadline for cloning, worker startup, module evaluation, and setup. Default: `1000`.
- `messageTimeoutMs`: default deadline for each `request()`. A timed-out request terminates the whole session because a CPU-bound handler cannot be interrupted independently. Default: `1000`.
- `lifetimeTimeoutMs`: maximum session lifetime after startup. Default: `30000`.
- `hostFunctions`: namespaced host functions exposed as explicit guest capabilities. Default: none.
- `maxHostFunctionCalls`: maximum accepted host calls during the session. Default: `256`.
- `maxInFlightHostFunctions`: maximum host calls executing concurrently. Default: `32`.
- `maxSourceBytes`, `environment`, `resourceLimits`, and `signal`: equivalent to the one-shot options.

Session interface:

- `ready`: promise resolved after script setup or the module's default setup function completes.
- `postMessage(value)`: delivers a message without waiting for its return value.
- `request(value[, { timeoutMs }])`: delivers a message and resolves with the handler's return value.
- `terminate()`: idempotently terminates the worker.
- `closed`: promise resolved with `{ code, error }` after worker exit.
- Events: `message` for values passed to `send()`, `error` for runtime/session errors, and `exit` for worker exit. Attach an `error` listener when runtime notifications need to be observed.

`onMessage()` registers one handler, and messages are processed serially. Input, posts, requests, replies, unsolicited messages, and host-function arguments/results are copied. Transfer lists and all shared-memory representations—including `SharedArrayBuffer`, shared typed-array/DataView backing stores, and shared `WebAssembly.Memory`—are rejected. Persistent protocol values must be accepted by both structured cloning and Node's `v8.serialize`; unsupported platform objects fail before crossing the boundary.

### `getHostFunctionContext()`

Returns metadata and an `AbortSignal` for the active host-function call. Throws outside a host function or from detached work after the function settles.

### `sanitizeEnvironment(environment)`

Validates an explicit environment and returns a null-prototype copy. Values must be strings. Runtime-control variables such as `NODE_OPTIONS`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` are rejected.

### `UntrustedCodeError`

Errors originating from execution use this class and have a machine-readable `code`. A remote stack, when available, is exposed as `remoteStack` rather than replacing the trusted caller's local stack. Argument validation and structured-clone failures are thrown synchronously; execution failures reject the returned promise.

## Security notes

- Untrusted source is passed via `workerData`; it is never interpolated into the trusted bootstrap source.
- The worker gets `env: {}` unless an explicit environment is supplied. Never place secrets in that environment.
- Do not place secrets in `worker_threads.setEnvironmentData()`: Node clones global worker environment data into new workers, independently of `WorkerOptions.env` and the Permission Model.
- One-shot execution binds its result channel and uses an unguessable protocol token. Persistent sessions create a private `MessageChannel` inside the trusted bootstrap, close `parentPort`, and authenticate every private-channel envelope with a per-session HMAC and monotonic sequence number. Capturing or replaying the port cannot forge control traffic.
- Host functions are authority grants. They must validate and authorize every argument, constrain outputs, and avoid exposing generic filesystem or network primitives when a narrower business operation is possible.
- A timed-out worker is terminated, but Worker resource limits and termination cannot prevent every process-wide denial-of-service condition. Host functions that ignore their abort signal may continue host-side work after termination.
- The Permission Model only controls supported Node APIs. It is not protection against Node/V8 vulnerabilities.

## Development

```sh
npm test
npm run test:coverage
```
