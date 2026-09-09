# Local modules and dependency loading

There are two supported dependency models: a trusted local module root and a
self-contained bundle produced by the host.

## Native local module loading

`runUntrustedFile()` and `createUntrustedWorkerFromFile()` accept a path string
or `file:` URL. The entry must be inside `rootDirectory`, which defaults to its
containing directory.

```js
import {
  createUntrustedWorkerFromFile,
  runUntrustedFile
} from 'secure-eval-worker'

const value = await runUntrustedFile('./components/task.mjs', {
  rootDirectory: './components',
  input: { value: 42 }
})

const session = await createUntrustedWorkerFromFile(
  './components/service.mjs',
  { rootDirectory: './components' }
)
```

The host canonicalizes the root and entry, then copies the complete authorized
tree into a private temporary snapshot before worker startup. Each source file
is opened without following its final symlink where the platform supports it;
the held handle is checked against the canonical pathname and read under
per-file and aggregate limits. Symbolic links and non-file/non-directory entries
are rejected. `maxRootEntries` defaults to 10,000; `maxFileBytes` and
`maxTotalFileBytes` default to 1 MiB and 16 MiB.

The sandbox receives `--allow-fs-read` only for the private snapshot, not the
caller's pathname. Changes made after staging therefore cannot redirect imports
outside the captured contents. The worker drops its
nested-worker permission, applies normal hardening, and imports the staged entry
with Node's native loader. Snapshot cleanup gets a bounded public wait; an
unresolved removal remains owned by a separately admitted janitor so `closed`
and one-shot promises still settle. Completed failures are retried with
exponential backoff; a stalled operating-system removal remains in flight. Cleanup
failures are surfaced as `ERR_UNTRUSTED_MODULE_CLEANUP`,
`ERR_UNTRUSTED_WORKER_CLEANUP`, or `ERR_UNTRUSTED_CODE_CLEANUP`.

The one-shot entry must default-export a function receiving `input`. The
persistent entry must default-export the normal setup function receiving
`{ input, send, onMessage, host }`. Static imports, dynamic imports, package
resolution, and native erase-only TypeScript behavior follow Node's rules, but
every filesystem resource needed by resolution must have been copied into the
snapshot. Built-in modules remain subject to the package's existing hardening.

The root is an explicit authority grant, not merely a module-search hint.
Guest code retains a constrained synchronous `node:fs` read facade because
Node's loader uses those shared exports. Path reads are confined to the staged
snapshot; descriptor-taking operations accept only descriptors opened through
that facade, preventing access to parent-open descriptors. Each local worker
may hold at most 64 guest-opened descriptors, with a fixed process-wide cap of
256 independent of worker admission. Node's worker descriptor tracking closes
retained descriptors on actual worker exit, when their process quota is also
released. Writes,
`node:fs/promises`, reads outside the snapshot, nested workers, and native
addons remain unavailable.

Use a dedicated source directory containing no secrets, special files, native
binaries, or unrelated files. The source filesystem and every process able to
mutate it must remain trusted during staging. Held handles and identity checks
reduce ordinary races, but
portable Node APIs cannot prove containment against an actively adversarial
parent-directory rename/symlink sequence. Concurrent changes may also make
staging reject or produce a graph whose files were captured at different
instants. The private directory's owner permissions do not protect it from
another process running under the same OS identity, so the temporary namespace
and same-identity processes must remain trusted for the snapshot's lifetime.
Use an application-owned immutable tree or an outer OS sandbox with a separate
identity when either race is in scope.

When the host uses `--permission`, it needs `--allow-worker`, read permission
for the source root, and read/write permission for the operating-system
temporary directory used for staging and cleanup.

Path containment follows the host platform's `realpath()` and `path.relative()`
semantics. Windows CI covers case-insensitive local-drive containment and
junction rejection. UNC/network-share roots are not part of the tested local-root
profile; use a dedicated local root and an outer sandbox when network shares or
other reparse-point behavior is part of the threat model.

## Trusted host-side bundling

A self-contained source string remains preferable when the guest should have
no filesystem-read authority. Bundle the graph before creating the worker:

```js
import { createUntrustedWorker } from 'secure-eval-worker'

const bundle = await applicationBundler.bundle({
  entryId: 'component/main.ts',
  modules: authorizedModuleGraph,
  format: 'esm',
  platform: 'node',
  external: ['node:crypto']
})

if (Buffer.byteLength(bundle.code, 'utf8') > 64 * 1024) {
  throw new RangeError('Bundled component is too large')
}

const component = createUntrustedWorker(bundle.code, {
  type: 'module',
  language: 'javascript',
  maxSourceBytes: 64 * 1024
})
```

The application-owned bundler remains responsible for canonical identities,
path and package authorization, graph limits, cancellation, and final output
limits. Review bundler transformations and runtime helpers as executable guest
code. Bundling does not make a dependency trusted.

Do not implement either model with `module.register()`, `registerHooks()`,
`--experimental-loader`, process-wide loader hooks, guest-provided resolvers,
or another VM/worker execution context. Loader hooks can execute outside this
worker's permission-drop and hardening sequence.
