# Safe module dependencies

The supported dependency model is **trusted host-side bundling**. The worker
accepts one self-contained ESM string and never resolves guest module requests
through filesystem, package, network, Node loader-hook, or guest callback
paths.

Use an application-owned bundler adapter before creating the worker:

```js
import { createUntrustedWorker } from 'secure-eval-worker'

const bundle = await applicationBundler.bundle({
  entryId: 'component/main.ts',
  // Resolve only canonical IDs from an application-owned allowlist.
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

The bundler is part of the trusted host and is responsible for authorization.
Its adapter should:

1. assign one canonical identity to every input module;
2. reject path traversal, URL schemes, unlisted bare packages, aliases that
   escape the graph, and duplicate normalized identities;
3. cap individual and aggregate source bytes, module count, resolution depth,
   and static/dynamic resolution requests;
4. resolve only application-authorized source already present in memory;
5. emit a single self-contained ESM result and apply `maxSourceBytes` again to
   that result; and
6. stop promptly when the surrounding operation is cancelled.

Cycles, static imports, dynamic imports, and live bindings have the semantics
provided by the selected bundler. Review its transformations and runtime
helpers as executable guest code. Bundling does not make a dependency trusted.

Do not implement this adapter with `module.register()`, `registerHooks()`,
`--experimental-loader`, process-wide loader hooks, guest-provided resolvers,
or another VM/worker execution context. Loader hooks can execute outside this
worker's permission-drop and hardening sequence. Node 26.3.0 and 26.8.1 do not
expose `vm.SourceTextModule` without enabling an experimental execution mode,
so this package deliberately does not enable it or claim a native in-memory
module graph.
