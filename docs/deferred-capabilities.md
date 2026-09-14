# Deferred capability decisions

## Durable interruption and continuation

No concrete approval, authentication-handoff, or cross-process resume workflow
is defined for this package. Durable continuations are therefore not being
implemented. They would require a separate threat model and an authenticated,
versioned replay ledger bound to source, capability identities, module inputs,
audience, application context, expiry, and atomic at-most-once storage claims.
The current per-session transport HMAC is not a continuation format.

## Synchronous host functions

No non-awaitable compatibility requirement is currently defined. Host
implementations may be synchronous, but guest calls intentionally return
promises. A blocking guest bridge would add trusted shared signaling memory,
deadlock and cancellation behavior, and admission-accounted fixed memory. It
will not be added solely for feature parity.

## Runtime compatibility

Node.js 26.5.1 remains the minimum patched runtime. Earlier Node.js 26 releases
provide `process.permission.drop()`, but lack required runtime and Permission
Model security fixes. Supporting older major releases or Bun would also require
an equivalent verified permission-drop boundary. Compatibility will be
reconsidered only when another runtime provides enforceable per-worker
primitives and passes the full boundary and exploit test suites.
