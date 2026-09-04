# secure-eval-worker

Run a JavaScript function body in a fresh Node.js worker with a small, explicitly defined authority set.

The worker starts with Node's Permission Model enabled and only the `worker` permission. Its trusted bootstrap immediately calls `process.permission.drop('worker')` before compiling caller-provided source. The worker also receives an explicit environment instead of inheriting `process.env`, has V8 resource limits, and is terminated after a deadline.

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

### `sanitizeEnvironment(environment)`

Validates an explicit environment and returns a null-prototype copy. Values must be strings. Runtime-control variables such as `NODE_OPTIONS`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` are rejected.

### `UntrustedCodeError`

Errors originating from execution use this class and have a machine-readable `code`. A remote stack, when available, is exposed as `remoteStack` rather than replacing the trusted caller's local stack. Argument validation and structured-clone failures are thrown synchronously; execution failures reject the returned promise.

## Security notes

- Untrusted source is passed via `workerData`; it is never interpolated into the trusted bootstrap source.
- The worker gets `env: {}` unless an explicit environment is supplied. Never place secrets in that environment.
- Do not place secrets in `worker_threads.setEnvironmentData()`: Node clones global worker environment data into new workers, independently of `WorkerOptions.env` and the Permission Model.
- The bootstrap binds its result channel and uses an unguessable per-worker protocol token before source runs. Unexpected direct messages from source fail the job.
- A timed-out worker is terminated, but Worker resource limits and termination cannot prevent every process-wide denial-of-service condition.
- The Permission Model only controls supported Node APIs. It is not protection against Node/V8 vulnerabilities.

## Development

```sh
npm test
npm run test:coverage
```
