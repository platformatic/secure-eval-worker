# Comparing secure-eval-worker with vercel-labs/run

This maintainer-facing analysis compares `secure-eval-worker` with
[`vercel-labs/run`](https://github.com/vercel-labs/run) as functionality
products. It is not a security certification of either project.

The comparison was checked against `vercel-labs/run` commit
[`aeb4ce01a67202343e03807d476eb416d6d18ffa`](https://github.com/vercel-labs/run/tree/aeb4ce01a67202343e03807d476eb416d6d18ffa)
(release 2.1.2) on 2026-09-05.

## Different execution models

The projects overlap, but neither is a strict superset of the other.

`run` executes each invocation in a fresh QuickJS context. Worker threads may
be pooled, but guest state does not persist between invocations. It emphasizes
short-lived computation, explicit host capabilities, controlled module loading,
and replay-based interruption and resumption.

`secure-eval-worker` executes native Node.js JavaScript in a worker thread. It
supports both one-shot evaluation and stateful components with bidirectional
messaging. Persistent component state, timers, explicit setup input, and
restricted Node built-in imports are intentional differentiators.

The native Node.js design also means that JavaScript hardening and the Node.js
Permission Model are defense in depth rather than an operating-system security
boundary. Hostile multi-tenant workloads still require an outer process or
container sandbox.

## Material functionality gaps

| Capability | `run` | `secure-eval-worker` | Assessment |
| --- | --- | --- | --- |
| One-shot host functions | Passed directly to `run()` | Available through one-shot and persistent APIs | Closed |
| TypeScript declarations | Published declarations and generic result types | Published declarations with generic host-side values | Closed |
| Guest TypeScript | Runtime type stripping | Optional erase-only stripping | Closed for erasable syntax |
| Controlled module graph | Static, cyclic, and dynamic ESM through a host loader | Native local modules from a bounded staged snapshot, or self-contained host bundles | Closed with an explicit source-root authority tradeoff |
| Interrupt and resume | Signed or stored replay continuations | No durable continuation mechanism | Important for approval and authentication workflows |
| Aggregate admission control | Process-wide worker cap with immediate backpressure | Main-thread process-wide cap with immediate rejection | Closed with fail-closed host-thread restriction |
| One-shot worker reuse | Pooled workers with fresh QuickJS contexts | A new worker for each one-shot execution | Deliberate no-pool security decision |
| Runtime support | Node.js 20.19+ and Bun | Node.js 26.3+ | Significant deployment restriction |
| Synchronous guest bindings | Supported for compatibility APIs | Host functions always return promises | Specialized compatibility gap |
| Guest console | Bounded and sanitized output | Opt-in bounded sanitized diagnostics; discarded by default | Closed |
| Serialized errors | Supports `Error`, causes, and aggregate errors as data | Errors use dedicated failure channels | Moderate interoperability gap |

### One-shot host functions

`runUntrustedCode()` now accepts the same namespaced host-function manifest and
limits as persistent sessions. The one-shot source signature remains unchanged:
`input` is its only parameter and capability namespaces are frozen guest
globals. Calls reuse the authenticated session bridge, value restrictions,
redaction, cancellation context, and output accounting.

### TypeScript support

The package now publishes declarations for the complete host API and validates
them from the packed artifact. Guest source may opt into Node's erase-only
TypeScript stripping with pre/post source limits and virtual coordinates. Type
stripping is not type checking; applications remain responsible for validating
generated code when type correctness matters.

### Controlled modules

`run` provides a host-controlled in-memory module loader. `secure-eval-worker`
now provides path-based one-shot and persistent factories that copy an
authorized source root into a private bounded snapshot, then use Node's native
loader under `--allow-fs-read` for that snapshot. This preserves native static,
cyclic, package, and dynamic import behavior, but the source root is an explicit
authority grant and must contain no secrets or unrelated files. Self-contained
host bundles remain available when the guest should receive no filesystem
permission.

Neither model uses privileged loader hooks or creates an execution context
outside the hardened worker. The path model additionally wraps descriptor APIs
so the guest cannot use the Permission Model's existing-descriptor exception to
read descriptors inherited from the parent process.

### Durable interruption and continuation

`run` can end an invocation when a host function requires approval, then resume
the logical run by replaying it from an authenticated continuation. Completed
host calls and module operations are recorded so replay does not repeat them.
It also provides signed and storage-backed continuation codecs.

A live `secure-eval-worker` session can wait for a message, but it retains the
worker and cannot survive process restart. Durable continuation would therefore
be a new replay subsystem rather than a small extension of session messaging.
It is worthwhile only if human approval, authentication handoffs, or durable
agent workflows are core use cases.

### Admission control and pooling

A fail-fast process-wide cap now covers one-shot and persistent sandbox workers
created from the main thread. Host-thread creation fails closed so thread
termination cannot orphan leases. Pooling was rejected because a reused native
Node realm cannot satisfy the required clean-reset invariant; every one-shot
run continues to receive a fresh worker.

### Synchronous bindings and console output

Synchronous host bindings help emulate APIs whose callers cannot await a
promise, but they require a blocking bridge and substantially increase
complexity. They should be added only for demonstrated compatibility needs.

Bounded diagnostics are available through a structured callback or session
event. They use an independently authenticated private channel and remain
disabled by default.

## Existing differentiators to preserve

`secure-eval-worker` already provides functionality that is outside `run`'s
invocation-focused model:

- persistent lexical and module state;
- guest-to-host notifications;
- host-to-guest posts and request/reply messaging;
- explicit setup input;
- timers and native Node.js semantics;
- restricted built-in module imports;
- explicit worker environment configuration; and
- separate startup, message, and lifetime controls.

Feature work should preserve these capabilities rather than reshape the package
into a clone of `run`.

## Recommended sequence

Completed work includes one-shot host-function parity, declarations,
admission control, native root-confined local modules, a host-side bundling
model, erase-only TypeScript, bounded diagnostics, reusable runner defaults,
and source-oriented errors.
Worker pooling was evaluated and rejected. Durable continuations and
synchronous guest bindings remain deferred until concrete product requirements
justify separate threat models and protocol designs.

## Primary references

- [`run` package README](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/packages/run/README.md)
- [`run` public types](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/packages/run/src/types.ts)
- [`run` module documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/foundations/modules.mdx)
- [`run` continuation documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/advanced/continuations.mdx)
- [`run` concurrency documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/advanced/concurrency.mdx)
- [`run` limit documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/advanced/limits.mdx)
