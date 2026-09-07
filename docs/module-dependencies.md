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

The host canonicalizes the root and entry with `realpath()` and verifies that
the entry is a regular file inside the root. It scans the root before startup,
rejecting symbolic links and non-file/non-directory entries. `maxRootEntries`
bounds this work and defaults to 10,000; `maxFileBytes` and
`maxTotalFileBytes` default to 1 MiB and 16 MiB. This is required because Node's
Permission Model can follow relative symlinks outside an allowed directory.
The sandbox worker then receives `--allow-fs-read=<canonical-root>`, drops its
nested-worker permission, applies its normal hardening, and imports the entry
with Node's native loader.

The one-shot entry must default-export a function receiving `input`. The
persistent entry must default-export the normal setup function receiving
`{ input, send, onMessage, host }`. Static imports, dynamic imports, package
resolution, and native erase-only TypeScript behavior follow Node's rules, but
every filesystem resource needed by resolution must be inside the trusted
root. Built-in modules remain subject to the package's existing hardening.

The root is an explicit authority grant, not merely a module-search hint.
Guest code retains a constrained synchronous `node:fs` read facade because
Node's loader uses those shared exports. Path reads are checked by the
Permission Model; descriptor-taking operations accept only descriptors opened
through that facade, preventing access to parent-open descriptors. Writes,
`node:fs/promises`, reads outside the root, nested workers, and native addons
remain unavailable.

Use a dedicated immutable or application-staged directory containing no
secrets, special files, native binaries, or unrelated files. A process that
adds links or concurrently renames files, directories, or mount points after
the scan can create TOCTOU ambiguity that user-space canonicalization cannot
completely eliminate. Use an outer OS sandbox when a mutable adversarial
filesystem is in scope.

When the host itself uses `--permission`, it needs `--allow-worker` and read
permission for the entry and root so host-side canonicalization can complete.

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
