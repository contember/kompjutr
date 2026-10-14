# Bare Smart HTTP server qualification

Run each combination from the repository root. The runner verifies an enforced
CPU lease with one logical CPU (`-n 2 --no-smt`) and never acquires a nested lease.

```sh
cpu-lease run -n 2 --no-smt -- npm run bench:server -- --runtime=node --fixture=medium
cpu-lease run -n 2 --no-smt -- npm run bench:server -- --runtime=node --fixture=large
cpu-lease run -n 2 --no-smt -- npm run bench:server -- --runtime=workerd --fixture=medium
cpu-lease run -n 2 --no-smt -- npm run bench:server -- --runtime=workerd --fixture=large
```

Version 1 fixtures are deterministic synthetic histories. Each commit replaces
32 (medium) or 160 (large) nested files. Half the 1 KiB blobs are compressible
text; half contain SHA-256 counter output. There are no shallow boundaries or
promised objects. The generator pins author, timestamps, paths, bytes, messages,
HEAD and reachable object count. Every reuse checks HEAD, count and native Git
`fsck --full --strict`.

| Fixture | Commits | Unique blobs | Reachable objects | Blob bytes | HEAD |
|---|---:|---:|---:|---:|---|
| medium | 128 | 4,096 | 6,400 | 4,194,304 | `293ecdef09b63b9c0f5cbfc6eb0cd0343eee64f8` |
| large | 640 | 102,400 | 113,920 | 104,857,600 | `582cf039ac884ab0c52ce92723564243d57cd338` |

The large fixture crosses the old 512-commit and 100,000-object client caps.
These fixtures qualify a synthetic history envelope, not all real repositories.
Fixture generation and fsck occur before measured phases. Cached fixtures live
in ignored `bench/.fixtures/`; JSON results live in ignored `bench/results/`.

Phases are initial push, full clone, one-commit incremental push and incremental
fetch. Native Git verifies HEAD, reachable closure and strict fsck. A final
interrupted upload must have an active owner before cancellation. The harness
then requires release at the current clock before advancing time. Separately,
maintenance at current time plus ten minutes drains owners and scratch objects. HTTP bodies pass through counting
streams; the harness does not buffer entire packs.

Each phase records SQL statements and returned rows, transmitted bytes, host wall
time, process CPU, process RSS and cgroup memory limits. Workerd counters live in
a benchmark-only map keyed by Durable Object identity. Ordinary DO reconstruction
preserves the phase totals and increments a reported generation count. Constructor
queries after phase reset are included. The host supplies a unique phase epoch and
rejects missing or changed epochs, so isolate loss cannot silently reset counts.
CPU checkpoints bracket
each phase and each explicit server yield. Workerd awaits an HTTP acknowledgement
from the host, which reads `/proc/<pid>/stat` before replying. The maximum process
CPU interval plus two scheduler ticks is a conservative upper bound between
these checkpoints, including native SQL/compression and background runtime work.
Node uses `process.cpuUsage()`. Checkpoint instrumentation changes wall time.
No synchronous Durable Object clock is used as a timer.

Each phase resets the process high-water mark through Linux `clear_refs=5`;
a failed write is fatal. One following `status` snapshot records both `VmHWM`
and `VmRSS`. The reset `VmHWM` is the delta baseline, alongside the absolute
end-of-phase high-water mark. RSS can change after the reset, so the two fields
need not be equal. See the [kernel proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

Workerd GC trace samples report V8 used plus external memory as a lower bound.
Node samples heap used plus external memory on the host event loop, also a lower
bound. RSS belongs to the whole local process, including SQLite and allocator
memory. Local workerd has no production isolate memory limiter. A local pass
cannot prove that Cloudflare's production memory or CPU limits are satisfied.

The benchmark worker exposes unauthenticated control endpoints only for this
local harness. Deploy the separate `examples/git-server/` worker, never this
benchmark worker.

The workerd harness uses Miniflare 5.20260820.0-alpha's direct application socket
(`unsafeDirectSockets` / `unsafeGetDirectURL`). Its normal development entry
worker uses compatibility date 2025-03-17 without `enable_request_signal`.
The direct socket preserves the application's authentication, routing and real
Durable Object while removing that development-only intermediary.

Workerd cancellation qualification sends a TCP reset directly to that application
HTTP entry. It is separate from the proxy used to count normal Git traffic.
The deterministic test pauses a server yield and verifies release before the
yield resumes. Graceful TCP closure from Node Fetch cancellation becomes
observable on subsequent stream progress; no claim of immediate notification
for every transport is made. Node qualification keeps Fetch cancellation through
its measured HTTP proxy. Results name the cancellation transport explicitly.

Control probes use fresh `node:http` connections (`agent: false`), without
retries, to avoid reusing a socket idle during a long Git operation. Raw workerd
logs are retained in ignored `*.runtime.log` files. Failed phases and later
verification/cancellation failures retain `*.failure.json` diagnostics and any
completed phase measurements.
