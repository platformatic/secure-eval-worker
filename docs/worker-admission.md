# Worker admission control

`secure-eval-worker` limits the number of admitted sandbox operations in a
process. The limit covers one-shot runs and persistent sessions together,
including local-module staging before worker creation. Admission is fail-fast:
there is no internal queue and rejected work is never started later.

The default is four admitted operations. Sandbox workers must be created from the
process main thread. Calls from host `worker_threads` fail closed with
`ERR_UNTRUSTED_WORKER_ADMISSION_UNAVAILABLE`; otherwise terminating a host
thread could orphan its admission leases. Multiple package copies in the main
realm share one versioned global controller.

Configure the limit before accepting work:

```js
import { configureWorkerAdmission } from 'secure-eval-worker'

configureWorkerAdmission({ maxConcurrentWorkers: 8 })
```

Lowering the limit does not terminate active workers. New workers are rejected
until the active count falls below the new limit. A persistent constructor
throws `ERR_UNTRUSTED_WORKER_CAPACITY`; a one-shot call returns a rejected
promise with `ERR_UNTRUSTED_CODE_CAPACITY`. Applications that need waiting or
fairness should implement an application-owned bounded queue before calling
this package.

Every execution API acquires a slot before inspecting caller-controlled options,
cloning input, or validating nested policy objects. Local-file execution also
acquires a preparation slot before touching the source tree and transfers the
worker lease after staging. Preparation failures release the worker lease after
staging has stopped and temporary files have been removed. Once a worker starts,
the slot remains occupied until its `exit` event; calling `terminate()` or
reaching the bounded public termination-settlement deadline does not release it
early. This prevents preparation and termination races from exceeding the
configured cap. A public staging timeout or cancellation rejects
promptly. Its worker slot is released, while a separate bounded preparation
slot remains occupied until any in-flight filesystem call settles and cleanup
finishes. Cleanup gets only a bounded public wait before the session or one-shot
promise settles; unresolved removal continues in a separately admitted janitor,
and completed failures are retried with exponential backoff. A stalled removal
remains in flight. This prevents abandoned preparation from starving
ordinary workers or allowing unbounded additional scans; avoid source and
temporary roots on filesystems that can stall indefinitely.

A local worker may hold at most 64 descriptors opened through its constrained
filesystem facade, and a separate shared counter caps them at 256 process-wide
regardless of the configured worker limit. Node's worker descriptor tracking
closes retained descriptors on actual worker exit, when the package releases
that worker's contribution to the process-wide counter.

## Default measurement

The default was checked on Linux x86-64 with four CPUs and approximately
3.9 GiB RAM. The command was:

```sh
npm run measure:workers -- 4
```

The benchmark starts initialized workers one at a time, performs one request,
and samples whole-process memory after an explicit host GC. Results on a supported current runtime were:

| Node.js | Baseline RSS | 1 worker | 2 workers | 3 workers | 4 workers |
| --- | ---: | ---: | ---: | ---: | ---: |
| 26.8.1 | 51.91 MiB | 71.79 MiB | 84.91 MiB | 98.16 MiB | 111.16 MiB |

The observed incremental RSS was approximately 12–20 MiB per initialized
worker. Four was selected as a conservative CPU-safe default rather than as a
claim about universal memory capacity. Deployments must measure their real
source and host-function workloads and configure a lower limit when required.

Admission control limits worker count only. It does not bound a single
worker's `ArrayBuffer`, WebAssembly, native or libuv allocation, aggregate CPU,
or memory allocated by host functions. It is operational backpressure, not an
isolation or memory-safety boundary.
