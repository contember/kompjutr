# Bare Smart HTTP server benchmark

Measured on 2026-10-14. All four Node/workerd × medium/large runs pass native
Git push, clone, incremental push/fetch, strict fsck, cancellation and cleanup.
The qualified environment is the local runtime described below.

**Large production capacity is unqualified.** Workerd GC samples reach
154,172,006 bytes (147.03 MiB) of used heap plus external memory. This exceeds
128 MiB in the local run. It is neither proof of production fit nor a measurement
of the exact retained live set. See [capacity follow-up 123](../backlog/123-qualify-large-git-server-production-capacity.md).

## Reproduction and scope

Use the four exact commands in the [benchmark runbook](../../bench/server/README.md).
Each invocation holds `cpu-lease run -n 2 --no-smt`: one logical CPU with its
SMT sibling reserved. Runs use disjoint leased cores. All cgroups report
`memoryMaxBytes: null`; no explicit memory cap was applied. These are single-run
baselines, not medians or an isolated-machine comparison between runtimes.

- AMD Ryzen 7 PRO 8840HS; Linux 6.17.0-41-generic x64.
- Node v24.4.0; Git 2.54.0; workerd 1.20260820.1;
  Miniflare 5.20260820.0-alpha; compatibility date 2026-08-15.
- Runtime and harness source: `d84864a`, including sparse packed reads at
  `6df678c`. Medium result metadata records `d84864a`; large metadata records
  `9829bbd`, whose only additional changes are a test and sprint log. Runtime
  source stayed unchanged throughout. Uncommitted paths recorded by the runs
  contain only tests or documentation.
- Node serves a file-backed `node:sqlite` database. Workerd serves the actual
  application Worker and SQLite Durable Object through Miniflare's direct
  application socket, with authentication preserved.
- Native Git traffic passes through a streaming counting proxy. Benchmark
  control endpoints are local-only. The benchmark subclass uses explicit
  cleanup after measurement rather than the example's automatic alarm loop.

The deterministic v1 fixtures are complete histories, with no shallow boundaries
or promised objects. Half of their 1 KiB blobs are compressible text; half are
SHA-256 counter bytes. Generation and cache verification happen before timing.

| Fixture | Commits | Unique blobs | Reachable objects | Blob bytes | Pinned HEAD |
| --- | ---: | ---: | ---: | ---: | --- |
| medium | 128 | 4,096 | 6,400 | 4,194,304 | `293ecdef09b63b9c0f5cbfc6eb0cd0343eee64f8` |
| large | 640 | 102,400 | 113,920 | 104,857,600 | `582cf039ac884ab0c52ce92723564243d57cd338` |

The large fixture crosses the existing outbound client's 512-new-commit and
100,000-object caps without raising them. It establishes this synthetic local
history envelope, not arbitrary repository sizes or production capacity.

## Serving cost

SQL counts are executed statements and **returned cursor rows**, not SQLite
rows scanned or billed reads. Every phase misses the 1,000-statement target;
that target is not an admission limit. Workerd can reconstruct a DO between
requests. Counters survive reconstruction, include its SQL, and validate a
host-supplied phase epoch. Cache continuity differs from the Node composition.

Wall time is measured on the host. CPU is whole-process CPU, including native
SQLite/compression, instrumentation and runtime background work. The final
column bounds CPU between acknowledged yield checkpoints, including counter
rounding; it is not a new request budget after each yield.

| Runtime / fixture | Phase | SQL | Returned rows | Wall (s) | Process CPU (s) | Max checkpoint CPU bound (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| node-medium | initial-push | 35,020 | 34,572 | 1.143 | 1.079 | 749.205 |
| node-medium | full-clone | 80,418 | 79,725 | 21.969 | 14.217 | 35.985 |
| node-medium | incremental-push | 34,863 | 21,668 | 0.623 | 0.593 | 572.196 |
| node-medium | incremental-fetch | 99,070 | 65,617 | 2.242 | 1.751 | 40.875 |
| node-large | initial-push | 516,712 | 594,483 | 32.053 | 31.176 | 24197.691 |
| node-large | full-clone | 1,315,500 | 1,431,059 | 363.523 | 285.761 | 109.399 |
| node-large | incremental-push | 513,232 | 365,382 | 19.135 | 19.048 | 19013.645 |
| node-large | incremental-fetch | 1,411,006 | 1,076,065 | 67.097 | 41.316 | 69.115 |
| workerd-medium | initial-push | 35,020 | 34,572 | 2.110 | 1.400 | 770.000 |
| workerd-medium | full-clone | 80,418 | 79,725 | 24.150 | 9.320 | 60.000 |
| workerd-medium | incremental-push | 34,863 | 21,668 | 0.691 | 0.630 | 650.000 |
| workerd-medium | incremental-fetch | 99,070 | 65,617 | 2.967 | 2.400 | 50.000 |
| workerd-large | initial-push | 516,722 | 594,559 | 46.218 | 38.080 | 26860.000 |
| workerd-large | full-clone | 1,327,020 | 1,445,096 | 395.413 | 197.690 | 190.000 |
| workerd-large | incremental-push | 513,827 | 366,043 | 23.691 | 22.880 | 22890.000 |
| workerd-large | incremental-fetch | 1,422,529 | 1,087,589 | 82.138 | 59.290 | 140.000 |

Large workerd initial and incremental pushes each span two DO generations;
its other phases and all medium phases span one. Cold reconstruction changes
cache hits and adds constructor queries, so cross-runtime SQL differences are
not a count of protocol requests.

The large full clone uses 197.690 seconds of workerd process CPU, and initial
push uses 38.080 seconds. The example sets a 300,000 ms CPU ceiling per request;
these process totals do not measure Cloudflare's per-request charge. The
[platform limit](https://developers.cloudflare.com/durable-objects/platform/limits/)
and configured ceiling must still be respected. Yielding does not reset CPU
accounting.

## Memory

MiB means 1,048,576 bytes. RSS is the whole local process, including SQLite,
allocator and runtime memory. Added RSS uses the post-reset HWM baseline; the
paired current RSS is also retained in raw results. A failed kernel reset is
fatal. Sampling can differ slightly from kernel HWM because kernel RSS
accounting is asynchronous.

Node heap plus external samples include the host loader and harness and are
not an isolate equivalent. Workerd GC samples combine pre-GC used heap with
post-GC external memory from the same collection. They are pressure
samples, not exact retained-live-set measurements or a continuous peak trace.
Local workerd has no production isolate memory limiter. Closing forced-GC
boundaries are included; no retained-live-set gate is claimed.

| Runtime / fixture | Phase | Absolute peak RSS (MiB) | Added peak RSS (MiB) | Sampled heap + external (MiB) |
| --- | --- | ---: | ---: | ---: |
| node-medium | initial-push | 454.30 | 140.29 | 168.79 |
| node-medium | full-clone | 503.27 | 48.96 | 192.00 |
| node-medium | incremental-push | 460.77 | 0.02 | 137.35 |
| node-medium | incremental-fetch | 468.28 | 7.51 | 156.18 |
| node-large | initial-push | 562.59 | 249.24 | 205.76 |
| node-large | full-clone | 577.05 | 14.68 | 163.63 |
| node-large | incremental-push | 564.59 | 0.13 | 160.26 |
| node-large | incremental-fetch | 564.76 | 0.17 | 167.73 |
| workerd-medium | initial-push | 136.66 | 66.07 | 24.62 |
| workerd-medium | full-clone | 272.69 | 136.84 | 95.11 |
| workerd-medium | incremental-push | 275.06 | 7.46 | 31.12 |
| workerd-medium | incremental-fetch | 301.54 | 27.73 | 42.32 |
| workerd-large | initial-push | 442.52 | 372.46 | 137.06 |
| workerd-large | full-clone | 462.36 | 31.83 | 147.03 |
| workerd-large | incremental-push | 447.80 | 5.85 | 80.17 |
| workerd-large | incremental-fetch | 459.92 | 23.57 | 71.79 |

The large initial-push maximum combines 44.3 MiB pre-major-GC heap with
92.76 MiB external memory. Post-GC heap is 8.9 MiB, giving 101.66 MiB with
that external sample; external memory falls again at the next collection.
This demonstrates a reclaimable component without erasing the original peak.
Full clone also reaches about 143.73 MiB after a minor GC, which can leave old
garbage. Neither observation proves the production memory verdict. The
[capacity follow-up](../backlog/123-qualify-large-git-server-production-capacity.md)
requires attribution and a separate production decision.

## Bytes and cancellation

Bytes count HTTP request/response bodies at the proxy, including discovery and
protocol framing. The values are identical across runtimes for each fixture.

| Fixture | Phase | Received bytes | Sent bytes |
| --- | --- | ---: | ---: |
| medium | initial-push | 2,405,090 | 175 |
| medium | full-clone | 96 | 2,469,198 |
| medium | incremental-push | 821 | 175 |
| medium | incremental-fetch | 1,037 | 2,019 |
| large | initial-push | 57,731,313 | 175 |
| large | full-clone | 96 | 58,870,621 |
| large | incremental-push | 823 | 175 |
| large | incremental-fetch | 1,037 | 2,021 |

All four runs verify one active upload owner before interruption and zero active
owners afterward, at the current clock. Node cancels Fetch through the measured
proxy; workerd sends a TCP reset directly to the application HTTP entry. The
actual-workerd test additionally holds a yield blocked until ownership releases.
Graceful TCP close may become observable only after stream progress; immediate
notification for every transport is not claimed.

Only after release does cleanup advance its clock by ten minutes. Both runtimes
use 356 maintenance steps for medium and 6,236 for large, ending with zero
transfer owners and zero scratch objects. Medium starts that cleanup with
44,832 scratch rows; large starts with 797,472. Release and bounded scratch
cleanup are distinct checks.

Raw successful results are ignored files
`bench/results/server-{node,workerd}-{medium,large}.json`. Workerd runtime logs
are retained beside them. Failure artifacts from older diagnostic runs are not
successful qualification results; match the revision and run described here.
