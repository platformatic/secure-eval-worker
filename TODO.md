# Roadmap

This roadmap tracks the functionality gaps identified in
[`docs/vercel-labs-run-comparison.md`](docs/vercel-labs-run-comparison.md).
Security fixes and compatibility regressions remain higher priority than new
features.

## P0 — Product and operational foundations

- [ ] **Add host functions to `runUntrustedCode()`**
  - Accept and validate `hostFunctions` using the session manifest rules.
  - Keep `input` as the only one-shot function parameter; expose capabilities
    through namespace globals.
  - Apply the same call-count, concurrency, serialization, error-redaction, and
    cancellation rules used by persistent sessions.
  - Add one-shot parity tests for synchronous and asynchronous host
    implementations, cancellation, limits, errors, and rejected values.
  - Document the one-shot capability model and examples.

- [ ] **Publish TypeScript declarations**
  - Type every public export and option.
  - Provide generic input/output types for one-shot execution and persistent
    sessions.
  - Type host-function namespaces, argument tuples, outputs, context, public
    errors, lifecycle events, and closed-state results.
  - Add a package-level type-check fixture that imports the published artifact.
  - Verify declaration paths in `npm pack --dry-run` output.

- [ ] **Add process-wide admission control**
  - Cap simultaneous worker creation across one-shot calls and persistent
    sessions.
  - Reject immediately with a stable error code instead of retaining an
    unbounded internal queue.
  - Define a conservative default from measured process overhead rather than
    V8 heap limits alone.
  - Add contention, cancellation, release, and failure-path tests.
  - Document how applications should implement backpressure or external
    queuing.

## P1 — Source and developer experience

- [ ] **Define a safe module-dependency model**
  - Start with a documented host-side bundling adapter or a bounded in-memory
    module graph.
  - Support explicit canonical module identities and authorized resolution.
  - Bound aggregate and per-module source sizes, module count, resolution depth,
    and loader requests.
  - Preserve static, cyclic, and dynamic ESM semantics where practical.
  - Never use privileged Node.js loader hooks or alternate execution contexts
    that bypass guest hardening.
  - Add traversal, alias, cycle, oversized graph, cancellation, and malicious
    resolver tests.

- [ ] **Add optional guest TypeScript stripping**
  - Support only syntax that can be safely erased; do not imply type checking.
  - Preserve source filenames and useful line/column coordinates in failures.
  - Apply source limits before and after transformation.
  - Keep JavaScript execution dependency-free when TypeScript support is not
    requested.
  - Test function-body and module source on every supported Node.js version.

- [ ] **Add opt-in bounded diagnostics**
  - Provide a structured host callback or event for guest console records.
  - Keep diagnostics separate from the authenticated control protocol.
  - Enforce cumulative byte and record-count limits before forwarding.
  - Sanitize control characters and safely format hostile objects.
  - Continue discarding output by default.

- [ ] **Improve serializable error data**
  - Decide whether `Error` and `AggregateError` should be supported as ordinary
    values independently of thrown-error channels.
  - Preserve safe `name`, `message`, `cause`, and aggregate members without
    transferring host stacks or custom prototypes.
  - Add cyclic-cause, oversized, hostile-property, and cross-boundary tests.

## P2 — Throughput and reusable configuration

- [ ] **Add reusable runner defaults**
  - Provide a small `createRunner()`-style API for shared limits and policies.
  - Keep per-run overrides explicit and validated.
  - Avoid duplicating the persistent-session lifecycle API.

- [ ] **Evaluate one-shot worker pooling**
  - Implement only after process-wide admission control is stable.
  - Define and verify a clean-reset invariant for environment, built-ins,
    listeners, timers, async work, protocol state, and guest references.
  - Retire workers after timeout, cancellation, protocol failure, or uncertain
    cleanup.
  - Keep an error listener attached while workers are active and idle.
  - Benchmark cold execution, pooled execution, memory overhead, and retirement
    rates on the minimum and latest supported Node.js versions.

- [ ] **Improve source-oriented errors**
  - Give guest code a stable virtual filename.
  - Preserve exact source line and column information through wrappers and
    optional type stripping.
  - Remove trusted bootstrap frames without accepting guest-forged stacks.

## P3 — Product-dependent capabilities

- [ ] **Evaluate durable interruption and continuation**
  - Confirm that approval, authentication, or cross-process resume is a product
    requirement before implementation.
  - Design an authenticated, versioned replay ledger covering every host-side
    operation.
  - Bind continuations to source, capability manifests, module identity,
    audience, and application context.
  - Support expiry, key rotation, bounded token sizes, and storage-backed
    at-most-once claims.
  - Make deterministic time/randomness and side-effect replay semantics
    explicit.
  - Treat this as a separate subsystem with an independent threat model.

- [ ] **Evaluate synchronous host functions**
  - Require a concrete compatibility use case before adding a blocking bridge.
  - Keep synchronous and asynchronous namespaces non-overlapping.
  - Apply the same authentication, serialization, call-count, cancellation, and
    error-redaction guarantees as asynchronous calls.
  - Include bridge memory in admission calculations.

- [ ] **Reassess runtime compatibility**
  - Keep Node.js 26.3 as the floor while `process.permission.drop()` is a core
    invariant.
  - Do not weaken permission-drop ordering merely to support older Node.js or
    Bun versions.
  - Revisit only when another runtime offers equivalent enforceable primitives.

## Ongoing requirements

- [ ] Run the complete test suite on Node.js 26.3.0 and current 26.x for every
  security-sensitive change.
- [ ] Add exploit-focused regression coverage for callable accessors, aliases,
  prototype-reachable constructors, inherited descriptors, native bindings,
  runtime introspection, and alternate execution contexts.
- [ ] Keep protocol channels and credentials unreachable from guest code and
  authenticate exact serialized payloads.
- [ ] Preserve strict shared-memory and authority-bearing-object rejection at
  every public boundary.
- [ ] Keep README security claims explicit that worker threads and JavaScript
  hardening are defense in depth, not process isolation.
- [ ] Confirm disclosure clearance before publishing security-relevant fixes.
