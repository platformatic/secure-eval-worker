# Worker admission control

`secure-eval-worker` limits the number of live workers in a process. The limit
covers one-shot runs and persistent sessions together. Admission is fail-fast:
there is no internal queue and rejected work is never started later.

The default is four live workers. Sandbox workers must be created from the
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

A slot is acquired immediately before `new Worker()` and remains occupied until
the worker's `exit` event. Calling `terminate()` does not release it early.
This prevents termination races from temporarily exceeding the configured cap.

## Default measurement

The default was checked on Linux x86-64 with four CPUs and approximately
3.9 GiB RAM. The command was:

```sh
npm run measure:workers -- 4
```

The benchmark starts initialized workers one at a time, performs one request,
and samples whole-process memory after an explicit host GC. Results on the
supported runtime endpoints were:

| Node.js | Baseline RSS | 1 worker | 2 workers | 3 workers | 4 workers |
| --- | ---: | ---: | ---: | ---: | ---: |
| 26.3.0 | 51.63 MiB | 70.13 MiB | 82.13 MiB | 94.13 MiB | 107.13 MiB |
| 26.8.1 | 51.91 MiB | 71.79 MiB | 84.91 MiB | 98.16 MiB | 111.16 MiB |

The observed incremental RSS was approximately 12–20 MiB per initialized
worker. Four was selected as a conservative CPU-safe default rather than as a
claim about universal memory capacity. Deployments must measure their real
source and host-function workloads and configure a lower limit when required.

Admission control limits worker count only. It does not bound a single
worker's `ArrayBuffer`, WebAssembly, native or libuv allocation, aggregate CPU,
or memory allocated by host functions. It is operational backpressure, not an
isolation or memory-safety boundary.
