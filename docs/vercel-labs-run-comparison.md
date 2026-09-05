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
| One-shot host functions | Passed directly to `run()` | Available only through persistent sessions | High-impact API gap |
| TypeScript declarations | Published declarations and generic result types | No declarations | High-impact packaging gap |
| Guest TypeScript | Runtime type stripping | JavaScript source only | Important for coding-agent output |
| Controlled module graph | Static, cyclic, and dynamic ESM through a host loader | Self-contained ESM only | Important for multi-file programs |
| Interrupt and resume | Signed or stored replay continuations | No durable continuation mechanism | Important for approval and authentication workflows |
| Aggregate admission control | Process-wide worker cap with immediate backpressure | No process-wide cap | High operational priority |
| One-shot worker reuse | Pooled workers with fresh QuickJS contexts | A new worker for each one-shot execution | Throughput and startup gap |
| Runtime support | Node.js 20.19+ and Bun | Node.js 26.3+ | Significant deployment restriction |
| Synchronous guest bindings | Supported for compatibility APIs | Host functions always return promises | Specialized compatibility gap |
| Guest console | Bounded and sanitized output | Output is discarded | Debugging and diagnostics gap |
| Serialized errors | Supports `Error`, causes, and aggregate errors as data | Errors use dedicated failure channels | Moderate interoperability gap |

### One-shot host functions

The most immediate product gap is the inability to pass host functions to
`runUntrustedCode()`. Calling generated code with a narrow set of tools is the
primary `run` workflow. In `secure-eval-worker`, users must create and terminate
a persistent session even when they need only one result.

This can be added without changing the one-shot source signature: `input` can
remain the only function parameter while capability namespaces remain guest
globals.

### TypeScript support

There are two separate improvements:

1. Publish declarations for the host API, including generic input, output, and
   host-function types.
2. Optionally strip supported TypeScript syntax from guest source while
   preserving useful source coordinates.

Declarations are lower-risk and should land first. Type stripping is not type
checking; applications remain responsible for validating generated code when
type correctness matters.

### Controlled modules

`run` provides a host-controlled module loader supporting static, cyclic, and
dynamic imports. `secure-eval-worker` requires one self-contained ESM source,
so applications must bundle approved dependencies before execution.

A future module graph must not rely on privileged Node.js loader hooks that can
create execution contexts outside the hardened guest runtime. Prefer host-side
bundling or an authenticated, bounded in-memory module graph with explicit
resolution rules.

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

Per-worker limits do not prevent an application from creating too many workers
at once. A process-wide cap with explicit backpressure should precede pooling.
Pooling can then improve one-shot startup cost, but every leased worker must be
returned to a verified clean state or retired. Error listeners must remain
attached for the complete worker lifecycle, including while a worker is idle.

### Synchronous bindings and console output

Synchronous host bindings help emulate APIs whose callers cannot await a
promise, but they require a blocking bridge and substantially increase
complexity. They should be added only for demonstrated compatibility needs.

Bounded console forwarding or a structured diagnostic callback would improve
debugging. Output must remain size-limited, sanitized, and separate from the
private control protocol.

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

1. Add one-shot host-function parity.
2. Publish TypeScript declarations and generic public types.
3. Add process-wide admission control.
4. Add an approved in-memory module graph or documented bundling adapter.
5. Add optional guest TypeScript stripping.
6. Add opt-in bounded diagnostics.
7. Evaluate worker pooling after clean-reset invariants are defined.
8. Implement continuations only if durable approval workflows are in scope.
9. Add synchronous host functions only for demonstrated compatibility needs.

The first three items close the largest general-purpose gaps without committing
the project to a new execution or replay architecture.

## Primary references

- [`run` package README](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/packages/run/README.md)
- [`run` public types](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/packages/run/src/types.ts)
- [`run` module documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/foundations/modules.mdx)
- [`run` continuation documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/advanced/continuations.mdx)
- [`run` concurrency documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/advanced/concurrency.mdx)
- [`run` limit documentation](https://github.com/vercel-labs/run/blob/aeb4ce01a67202343e03807d476eb416d6d18ffa/content/docs/advanced/limits.mdx)
