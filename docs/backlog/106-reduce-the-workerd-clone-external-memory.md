---
id: 106
title: Reduce the workerd clone's external memory
blocked-by: []
---

# 106 — Reduce the workerd clone's external memory

**Summary.** The Next.js clone on workerd holds 4.5–7.7× its pack in V8 external
memory. That memory counts against the isolate, so it decides whether the clone
can fit the production 128 MB limit. Effort: M to attribute, unknown to fix.

## Problem

The Next.js fixture's pack is 42 MiB. During the workerd clone, the peak V8
external memory (ArrayBuffer backing stores and external strings) is far larger:

| Measured at | Runs | Peak V8 external, MiB | Peak V8 used + external, MiB | Non-V8 residue added, MiB |
| --- | ---: | --- | --- | --- |
| `2b2002c` harness (WU3, 1,012 statements) | 3 + 1 review | 187.5–227.2; review run 325.0 | 219.1–279.2; review run 355.9 | 191.1–243.7; review run 245.7 |
| `555ee0d` (WU4, 898 statements) | 5 | 195.1–315.2 | 225.6–363.3 | 203.0–272.7 |
| `b7a5118` (closure, 898 statements) | 3 | 204.7–276.5 | 231.9–315.0 | 188.3–246.9 |

All runs: `cpu-lease run -n 2`, cgroup `memory.max` = `max` (no limit),
`workerd` 1.20260820.1. The V8 values come from V8's GC trace, so their peaks
are lower bounds ([ADR-0026](../decisions/0026-gate-the-workerd-clone-on-a-v8-regression-limit.md)).

The non-V8 residue is process RSS after a forced GC minus V8 committed and
external memory at that GC. It is SQLite, allocator and runtime memory that the
clone leaves behind. File-backed memory stays near 47 MiB, so it is not the
SQLite page cache of the database file.

The harness gates this number only as a regression limit at today's level. No
measurement says whether the clone fits the production isolate.

## Attributed so far

- **Native zlib state from `inflateSync({ info: true })`.** workerd serves the
  `info` path through a stream object whose native zlib state is freed only by
  a major GC, and reports that state as external memory.
  - A workerd microbenchmark of 200k 300-byte streams left 1.8 GB external
    after GC. The same calls without `info` left 1.8 MB.
  - Pack ingest now decodes through one reused decoder
    (`PrefixInflater`, `2768f53`). The full-history clone's peak V8 used +
    external fell from 731 MB to 376–549 MB. The depth-1 peak is 247–304 MB.
- **Remaining.** The read path (`read-data.ts`, `inflatePrefix`) still uses
  `info`. Its tests require a native decoder that consumes the whole input,
  so changing it is a contract decision. The live-set probe below finds no
  retained non-ArrayBuffer external memory, so this is garbage, not live.

## Live set (heap probe, `25d6c6e`)

The gate's peak adds heap used *before* a GC, so it counts garbage. A probe
measured the live set instead.

- **Method.** `bench:workerd:nextjs -- --live-set` forces three `gc()` calls
  every N SQL statements and logs a marker (ADR-0026). The GC trace after the third call
  gives live used + external. One `gc()` is not enough: it leaves ArrayBuffers
  that wait for concurrent sweeping in the backing-store counter. At one
  depth-1 point, one call reported 54 MiB and three calls 22 MiB. A heap
  snapshot at the same point found 23.6 MiB.
- **Snapshots** came from a scratch probe. workerd dispatches CDP only while
  the isolate is idle, and `HeapProfiler.collectGarbage` never answers. A
  `debugger;` statement before chosen statements pauses the isolate, and the
  probe takes the snapshot from the paused loop.

| Clone | Live peak, MiB | Where | Rest of the clone, MiB |
| --- | ---: | --- | ---: |
| depth 1 (GC every statement) | 28.3 | checkout `fs_chunks` writes | 20–28 |
| full history `blob:none` (GC every 2 statements) | 99.4 | delta resolution, statements ~750–1200 | 21–51 |

Owners at the full-history peak (snapshot at statement 896, 100.5 MiB):

| Owner | Retained, MiB |
| --- | ---: |
| `ChunkPool.#free` (pack ingest) | 46.9 |
| `PackReferenceCollector.#keys` | 20.0 |
| `ByteLru` (object and pack-row caches) | 14.4 |
| Worker bundle source string | 4.1 |
| `ExpectedPackMembership`, `PackDeltaDepths` | 4.2 |

- **Fixed: chunk footprint of retained delta bases.** Delta resolution
  budgets retained bases by logical length (`PACK_BLOB_BATCH_TARGET_BYTES`,
  4 MiB), but a chunked base holds whole 64 KiB chunks. At the chunk
  high-water mark, 863 small bases held 1.5 MiB of data in 54 MiB of chunks.
  `ChunkPool` keeps its free list until `dispose()`, so the mark stayed live.
  Bases below one chunk are now kept as exact copies. The chunk high-water
  mark fell from 54 to 1.9 MiB, and the full-history live peak fell from 99.4
  to 55.0 MiB. Statements are unchanged.
- The probe is a lower bound between markers. Memory that lives only inside
  one statement-free stretch is not sampled.

## Approach / acceptance

1. ~~Attribute the owners per phase.~~ Done for the live set; see above.
2. Reduce the owners that the attribution names. The chunk footprint is
   fixed; `PackReferenceCollector` power-of-two growth (about 6 MiB) and the
   cache budgets (a CPU and SQL tradeoff) remain.
3. Decide whether a production Durable Object probe is needed to answer the
   128 MB question. Local workerd has no isolate limiter.

Witness: the maximum live-set peak of three leased
`cpu-lease run -n 2 --no-smt -- npm run bench:workerd:nextjs -- --live-set`
runs falls below today's level (28.4 MiB at depth 1, 55.1 MiB in full
history at `a42ffaa`) for the history the change targets. The oracle is
unchanged, and `memory.max` and the commit are recorded. Lower
`LIVE_SET_LIMIT_BYTES` in `bench/workerd/run.ts` to the new level in the same
change.

## Touch points

`packages/git/src/store/pack/ingest/`, `packages/git/src/ops/checkout/`,
`packages/do/src/fs/store/initial-write/`, `bench/workerd/`.

<!-- Origin: sprint-2026-09-28-memory-and-cost WU3 attribution and the WU4 escalation. -->
