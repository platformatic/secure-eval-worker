# Error and stack-trace policy

Errors cross different trust boundaries in different directions. This project does
not apply one stack policy to every boundary: the recipient and the source of the
error determine what is safe and useful to disclose.

## Policy by channel

| Channel | Recipient | Policy |
| --- | --- | --- |
| Guest-created errors inside the worker | Untrusted guest code | Node's normal guest-realm error behavior applies. The guest can inspect errors and stacks it creates. |
| Guest execution failures | Trusted host application | The local `UntrustedCodeError.stack` remains the host caller's stack. A separate `remoteStack` preserves every guest stack frame that fits within the diagnostic limits. Control characters are escaped, wrapper coordinates are adjusted, and package-owned staging paths are replaced with stable virtual paths. Frames are not filtered by function or module name. |
| Host-function failures | Untrusted guest code | Host stacks, causes, paths, endpoints, and arbitrary properties are never disclosed. Failures are generic unless the host throws a privately branded `HostFunctionError`; even then, only once-inspected own string-valued data properties for `message` and `code` are exposed. |
| Guest console diagnostics | Trusted host application | Diagnostics are disabled by default. When enabled, records are authenticated, count- and byte-bounded, control-character escaped, and formatted without invoking guest accessors or inspection hooks. Error objects do not implicitly contribute a stack. |

`remoteStack` is guest-controlled diagnostic text. Preserving it does not make it
trusted evidence: applications must not use it for authorization, provenance,
source identity, or security decisions.

## Why guest stacks are preserved

Removing worker bootstrap or Node internal frames from a guest failure does not
protect the guest: code in the worker can already inspect the errors and stacks
it creates. The recipient of `remoteStack` is the trusted host application, where
complete call context is useful for debugging asynchronous setup, module loading,
and runtime failures.

The boundary therefore applies transformations with concrete safety or stability
benefits only:

- bound the amount of guest-controlled text;
- escape terminal and bidirectional control characters;
- adjust generated wrapper line offsets back to guest source coordinates; and
- replace randomized package-owned staging locations with stable virtual source
  locations, including when truncation occurs at a path boundary.

It does not remove frames merely because they refer to worker infrastructure.
The trusted caller's own stack remains separate so guest text cannot replace or
forge it.

## Comparison with SES error taming

SES distinguishes information available to an unprivileged compartment from
information available to a privileged debugging console. With the default
`errorTaming: 'safe'`, SES attempts to prevent a compartment from obtaining a
stack from an error instance, while its tamed console can still reveal privileged
diagnostic information. SES separately exposes `stackFiltering` choices such as
`'concise'` and `'verbose'`; that filtering controls presentation to the trusted
console rather than making filtered text authoritative.

`secure-eval-worker` uses the same trust distinction but has a different boundary:

- the guest runs in a separate worker realm and can already observe its own Node
  errors;
- `remoteStack` is delivered over the private authenticated worker protocol only
  to the trusted host; and
- host-originated failures travel in the opposite direction and remain redacted
  before the guest receives them.

Consequently, filtering guest frames on the guest-to-host channel would discard
trusted-debugger context without adding the confidentiality protection that SES
gets by hiding host or caller stacks from an unprivileged compartment. Redacting
host-function failures remains necessary and corresponds to SES's principle that
privileged error details must not become properties visible to untrusted code.

References:

- [Endo `lockdown()` options: `errorTaming` and `stackFiltering`](https://docs.endojs.org/documents/lockdown.html)
- [README: `UntrustedCodeError`](../README.md#untrustedcodeerror)

## Ordinary protocol values

`Error` and `AggregateError` remain unsupported as ordinary protocol values.
Node's structured clone and V8 serializer copy implementation-dependent error
state, including stacks and causes. On the supported Node 26 endpoints,
`AggregateError` does not retain its aggregate brand or `errors` collection
through V8 serialization. Passing native errors as ordinary values would risk
host-stack disclosure and inconsistent semantics.

Protocol objects are validated before cloning. Custom class instances are
rejected. Plain objects and arrays may contain only enumerable data properties,
so accessors, symbols, and non-enumerable properties are rejected rather than
silently normalized. Null-prototype objects are accepted as explicit data, but
Node's structured-clone boundary normalizes them to ordinary objects.

Applications should return explicit data for expected failures:

```js
return {
  ok: false,
  error: {
    name: 'ValidationError',
    message: 'The submitted value is invalid',
    cause: null
  }
}
```

Applications must construct such data intentionally and must not copy host
stacks, secrets, endpoints, queries, or arbitrary custom error properties.
