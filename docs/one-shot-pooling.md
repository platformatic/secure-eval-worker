# One-shot worker pooling decision

Decision: **do not pool native worker realms**.

Admission control now bounds live workers, but it does not make a used worker
safe to lease again. The current bootstrap is intentionally one-use:

- `workerData`, environment, V8 resource limits, and permission grants are
  construction-time state;
- permission dropping and built-in taming are irreversible;
- guest mutations to globals, prototypes, module caches, listeners, timers,
  microtasks, and native asynchronous work survive in the realm;
- guest closures can retain source, input, capabilities, and results;
- protocol secrets, sequence numbers, request maps, and output budgets belong
  to one execution; and
- host operations that ignore cancellation can outlive worker termination.

A reusable worker would need a demonstrably fresh, equivalently hardened realm
for every lease, fresh private channels and credentials, complete timer and
async-resource cleanup, no prior module/global references, and atomic states
for idle, leased, retiring, and terminated workers. Node's readily available
fresh-realm mechanisms would expose alternate execution contexts that this
package intentionally disables, while best-effort cleanup cannot prove the
reset invariant.

Accordingly, every one-shot invocation continues to create a new worker. Any
worker affected by timeout, cancellation, protocol failure, host-function work,
or uncertain cleanup is terminated. There is no idle pool and therefore no
pool benchmark to justify against a security invariant that cannot currently
be met. This decision should be revisited only if Node provides an enforceable,
fully disposable realm with equivalent permission-drop and hardening behavior.
