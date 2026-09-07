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

Node.js 26.3.0 remains the minimum. Supporting older Node.js or Bun would
require weakening the verified `process.permission.drop('worker')` ordering,
which is not acceptable. Compatibility will be reconsidered only when another
runtime provides equivalent enforceable per-worker primitives and passes the
full boundary and exploit test suites.
