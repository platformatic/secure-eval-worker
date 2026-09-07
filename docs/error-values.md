# Error values decision

`Error` and `AggregateError` remain unsupported as ordinary protocol values.
Thrown guest errors and host-function failures continue to use their dedicated,
bounded error channels.

Node's native structured clone and V8 serializer copy implementation-dependent
error state, including stacks and causes. On the supported Node 26 endpoints,
`AggregateError` does not retain its aggregate brand or `errors` collection
through V8 serialization. Passing native errors would therefore risk host stack
leakage and inconsistent semantics. A custom tagged codec would also need
unforgeable provenance, graph-wide cycle and alias preservation, hostile
property handling, and independent depth/member work limits.

The safer contract is explicit application data:

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

Applications must construct such plain data intentionally and must not copy
host stacks, secrets, endpoints, queries, or arbitrary custom error properties.
This decision can be revisited only with a separately reviewed authenticated
codec that preserves cycles and aliases without accepting forgeable tags.
