# Node capability policy

## Decision

`secure-eval-worker` uses a reviewed, fail-closed policy for Node built-in modules in addition to Node's Permission Model and the existing API attenuation.

The policy is machine-readable in `src/node-capability-policy.js`. Every built-in reported by the supported Node runtimes has one disposition:

- **Allowed**: intentionally available as a general computation library.
- **Attenuated**: importable for compatibility, but authority-bearing exports are replaced, virtualized, or constrained before guest execution.
- **Mode-dependent**: unavailable to source-string workers and attenuated to staged-root reads for local-file workers.
- **Denied**: resolution fails with `ERR_ACCESS_DENIED` through every mediated loading path.

An additional module ID reported by `module.builtinModules`, a new top-level export, an unexpected descriptor kind, or a change to reviewed direct nested objects and exported constructor/prototype surfaces causes worker startup to fail before guest source is compiled or imported. A recognized but unclassified identity that is not reported by that inventory is denied when requested by the resolver, `_load()`, or `process.getBuiltinModule()` guards.

This policy governs Node built-ins. It does not create a new ECMAScript lexical global scope; explicit global-scope control remains a separate design question.

## Why this design

Four approaches were considered.

### Per-API denylist only

The earlier implementation preloaded and disabled known dangerous exports. It preserved compatibility, but a newly shipped module or export was available until reviewed. Node 26.8 added new ZIP APIs and Node 26.9 added `node:ffi`, demonstrating the problem.

This remains useful as the attenuation layer, but it is not sufficient as the upgrade boundary.

### CommonJS interception only

Replacing `Module._load()`, hiding wrapper globals, or controlling `createRequire()` cannot mediate native ESM imports or `process.getBuiltinModule()`. Those controls remain defense in depth, not the primary policy boundary.

### Asynchronous custom loader or separate compartment

`module.register()` executes asynchronous hooks in a separate internal worker. That would introduce another realm whose permissions, intrinsics, protocol, lifetime, and failure behavior would require a separate security analysis. A SES or compartment module system would also change native ESM and staged-package compatibility substantially. Those approaches were not adopted here.

### Reviewed manifest plus a trusted synchronous hook

The selected design combines:

1. an exact built-in identity profile for the supported Node 26 runtime ranges;
2. descriptor-only manifests for pre-hardening CommonJS exports, post-hardening ESM namespaces, direct object-valued exports, exported functions, and constructor prototype chains;
3. the existing module-specific attenuation;
4. a trusted synchronous `module.registerHooks()` resolve hook installed after permission drop and hardening, but before guest compilation or import;
5. independent immutable policy checks in `Module._load()` and `process.getBuiltinModule()`; and
6. a CI gate across the floor, the Node 26.8 API boundary, current 26.x, and Linux, macOS, and Windows.

The JavaScript policy can only remove or attenuate visible capabilities; it cannot restore a permission omitted from the worker or dropped by `process.permission.drop()`. Synchronous hooks run in the sandbox worker realm and close over primitives captured before guest execution. Guest-facing `module.register()`, `module.registerHooks()`, resolver mutation, and compile-cache APIs remain disabled. The returned hook registration is retained privately for the worker lifetime.

## Loading paths

The same disposition is enforced for the applicable forms below.

| Loading path | Enforcement |
| --- | --- |
| Static and dynamic native ESM, including staged modules | Trusted synchronous resolve hook |
| Bare and `node:` built-in spellings | Exact raw-ID policy plus canonical alias lookup |
| ESM named exports and namespace default exports | Pre-guest namespace-name check, attenuation, and `syncBuiltinESMExports()` |
| CommonJS `require()` and `module.createRequire()` | Resolve hook and immutable `_load()` wrapper |
| `Module._load()`, `Module.Module._load()`, and ESM default aliases | Immutable `_load()` wrapper using the same policy |
| `process.getBuiltinModule()` and imported `node:process` aliases | Immutable wrapper using the same policy |
| `vm.Script` and `vm.compileFunction` with the main-context default loader | Native loader reaches the synchronous resolve hook |
| Guest loader registration and compile-cache mutation | Denied |

The manifest preserves the raw spellings returned by `module.builtinModules`. This matters because prefix-only IDs such as `node:ffi` are not equivalent to packages named `ffi`.

## Reviewed inventory

The following groups summarize the machine-readable policy. The source file is authoritative and is checked for sorting, duplicates, missing classifications, and profile drift.

### Allowed computation libraries

- assertions: `assert`, `assert/strict`
- binary and text utilities: `buffer`, `string_decoder`, `util`, `util/types`
- events and streams: `domain`, `events`, `stream`, `stream/consumers`, `stream/promises`, `stream/web`
- paths and URLs: `path`, `path/posix`, `path/win32`, `url`
- data/compatibility utilities: `constants`, `punycode`, `querystring`
- local scheduling and parsing: `timers`, `timers/promises`, `readline`, `readline/promises`
- code evaluation without additional host authority: `vm`
- the deprecated `sys` alias, whose reviewed surface is the `util` compatibility API

`zlib` is classified as attenuated in the machine policy because Node 26.8 added file-oriented ZIP APIs. In-memory compression remains available; ZIP constructors and file/archive operations are immutable denial stubs.

### Attenuated modules

- `async_hooks`, `child_process`
- `crypto`
- `dgram`, `dns`, `dns/promises`, `http`, `http2`, `https`, `net`, `tls`
- `inspector`, `inspector/promises`
- `module`, `process`, `worker_threads`
- `node:sea`, `node:sqlite`, `v8`, `wasi`
- `os`, `perf_hooks`, `tty`
- `zlib`

Attenuation is module-specific. It includes complete callable denial for WASI, SQLite, OS, and async hooks; callable V8 denial except for the documented compatibility probe; network and child-process denial; process identity/resource virtualization; immutable loader restrictions; staged-root filesystem behavior; virtual worker-relative timing; and the documented retained compatibility probe `v8.startupSnapshot.isBuildingSnapshot()`.

`crypto.createMac()` and `crypto.getMacs()` added in Node 26.9 were reviewed as cryptographic algorithm APIs, not network-interface access. They remain available. OpenSSL engine selection, FIPS mutation, and secure-heap telemetry remain denied.

### Mode-dependent filesystem modules

- `fs`
- `fs/promises`

Source-string workers cannot load either module. Local-file workers may load them, but only the synchronous path readers required by Node's native module loader remain callable, and reads are confined to the private staged snapshot. Descriptor-based access remains owner-accounted and bounded.

### Module-level denial

- internal network aliases: `_http_agent`, `_http_client`, `_http_common`, `_http_incoming`, `_http_outgoing`, `_http_server`, `_tls_common`, `_tls_wrap`
- `cluster`
- the `console` module (the separately virtualized global console remains available)
- `diagnostics_channel`
- `node:ffi`
- `node:test`, `node:test/reporters`
- `repl`
- `trace_events`

`node:quic` is an explicitly denied optional identity. The worker does not enable host experimental flags, and an available optional identity never becomes guest-accessible merely because a future supported runtime recognizes it.

## Startup order and failure behavior

For every worker:

1. trusted built-ins and descriptor operations are captured;
2. the policy embedded by the package is validated and recursively frozen;
3. the worker permission is irreversibly dropped;
4. the runtime built-in ID profile and CommonJS export descriptors are checked;
5. authority-bearing exports are attenuated and ESM bindings synchronized;
6. ESM namespace names are checked;
7. the trusted synchronous resolve hook is installed and all guest mutation routes are disabled; and
8. only then is guest source compiled or imported.

The checks inspect own property descriptors and never invoke export accessors. CommonJS entries record top-level names and descriptor categories before attenuation; ESM entries record names and categories after attenuation. A bounded graph additionally records direct object-valued exports, exported function surfaces, and constructor prototype chains, with fixed node, property, and prototype-depth budgets. Platform-specific numeric members of `constants` and direct `.constants` objects are omitted by name because they are inert values that differ across operating systems; an accessor, object, function, symbol, or other non-numeric addition still fails closed. The lazy `process.allowedNodeEnvironmentFlags` object is the only reviewed optional graph path because Node may materialize its accessor at different bootstrap points.

A mismatch rejects startup with a bounded error, terminates the worker through the normal lifecycle, retains admission until actual exit, and does not execute guest source.

## Runtime upgrade procedure

Run `npm run test:node-capabilities` with Node 26.5.1, Node 26.8.1 (the ZIP API boundary), and the current Node 26.x release. CI runs it in all nine operating-system/runtime matrix jobs.

To produce deterministic review input without changing the approved manifest, run the following on Linux, macOS, and Windows under each of those three Node versions:

```sh
npm run generate:node-capability-candidate > capability-candidate.json
```

The candidate records the runtime identity inventory, pre-hardening CommonJS descriptors, post-hardening ESM descriptors, and nested/prototype graph. The tool uses a temporary source copy with only the three manifest comparisons disabled; permission dropping, attenuation, and resolver hardening remain in production order. It deletes the copy afterward and never edits `src/node-capability-surfaces.js`. Candidate JSON is untrusted review input, not an approval artifact.

When the checker fails:

1. Do not accept either the manifest or generated candidate automatically.
2. Read the Node release notes and implementation for every added, removed, or changed identity, top-level descriptor, nested object, function, or prototype entry.
3. Determine whether the Permission Model covers the operation and whether it has same-process effects.
4. Assign a disposition and rationale.
5. Add denial or attenuation before updating the manifest.
6. Test every applicable alias, ESM named/default form, mutation attempt, and repeated `syncBuiltinESMExports()` behavior.
7. Update the identity profile, surface manifest, this document, and compatibility notes in the same reviewed change.
8. Run the full floor/API-boundary/current, Linux/macOS/Windows matrix before changing the supported-runtime claim.

The checker prints the runtime, platform, architecture, and exact identity and top-level export/name diffs, then starts a real sandbox so the embedded runtime verifier independently checks post-attenuation ESM categories and nested/prototype graph drift. Candidate generation is intentionally separate from verification and only writes JSON to standard output, so CI cannot auto-approve a new capability.

## Compatibility and cost

The intended compatibility changes are:

- unapproved built-ins now fail resolution with `ERR_ACCESS_DENIED` instead of becoming available by default;
- a Node 26 update with an unreviewed identity or export change fails worker startup until the package policy is reviewed;
- denied module identities may no longer return an importable namespace of denial stubs;
- ordinary packages whose names resemble prefix-only built-ins remain ordinary package specifiers;
- the inherited `%TypedArray%.prototype.length` descriptor is made non-configurable before guest execution because Node's synchronous resolver hook uses async-context internals that read it. Code that replaces this shared intrinsic descriptor is incompatible.

A single Linux x64 sequential eight-worker benchmark used `npm run measure:workers -- 8` with explicit full-command `PATH` selection and forced GC between samples. The median excludes the first cold worker. Compared with `main` commit `2c49f6e`, which includes the same Heapjack hardening, the final policy changed:

| Runtime | Before | With policy | Startup increase | Approx. active RSS increase per worker |
| --- | ---: | ---: | ---: | ---: |
| Node 26.5.1, Linux x64 | 143.01 ms | 233.68 ms | 90.67 ms (63%) | 8.37 MiB |
| Node 26.9.0, Linux x64 | 107.74 ms | 189.43 ms | 81.69 ms (76%) | 10.09 MiB |

The full identity, export, and graph scan runs once per worker. Ordinary requests without new module resolution do not repeat it; later dynamic module resolution still performs the constant-time policy lookup in the trusted hook. Worker pooling was not introduced because the project does not have a safe realm-reset invariant. Deployments should account for the additional startup cost or use longer-lived sessions.

## Residual risks and boundaries

- The policy covers documented built-in IDs plus the explicitly listed internal aliases; undocumented native internals cannot be exhaustively enumerated.
- Descriptor checks do not prove that the semantics of an existing native function are unchanged. Objects reachable only by invoking native accessors are not traversed because policy verification never executes accessors. Release notes, source review, exploit regressions, the Permission Model, and an outer OS sandbox remain necessary.
- Module policy does not control every global lexical binding. That distinct problem is tracked by [issue #5, “Evaluate explicit global scope capabilities instead of individual global removal”](https://github.com/platformatic/secure-eval-worker/issues/5).
- Native/runtime vulnerabilities, shared-process denial of service, and mutable same-UID filesystem namespaces remain outside the worker-only boundary.
- Worker isolation and the Permission Model remain defense in depth, not an OS security boundary.
