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
| `c3b670c` (WU4, 898 statements) | 5 | 195.1–315.2 | 225.6–363.3 | 203.0–272.7 |

All runs: `cpu-lease run -n 2`, cgroup `memory.max` = `max` (no limit),
`workerd` 1.20260820.1. The V8 values come from V8's GC trace, so their peaks
are lower bounds ([ADR-0026](../decisions/0026-gate-the-workerd-clone-on-a-v8-regression-limit.md)).

The non-V8 residue is process RSS after a forced GC minus V8 committed and
external memory at that GC. It is SQLite, allocator and runtime memory that the
clone leaves behind. File-backed memory stays near 47 MiB, so it is not the
SQLite page cache of the database file.

The harness gates this number only as a regression limit at today's level. No
measurement says whether the clone fits the production isolate.

## Approach / acceptance

1. Attribute the ArrayBuffer owners per phase before changing code: pack ingest,
   delta resolution, and checkout. The GC trace shows totals only; a phase marker
   or a heap snapshot at the peak names the owners.
2. Reduce the owners that the attribution names.
3. Decide whether a production Durable Object probe is needed to answer the
   128 MB question. Local workerd has no isolate limiter.

Witness: the maximum peak V8 used + external of at least three leased
`cpu-lease run -n 2 -- npm run bench:workerd:nextjs` runs is below 225 MiB,
today's minimum. The oracle is unchanged, and `memory.max` and the commit are
recorded. Lower
`V8_USED_PLUS_EXTERNAL_LIMIT_BYTES` in `bench/workerd/run.ts` to the new level.

## Touch points

`packages/git/src/store/pack/ingest/`, `packages/git/src/ops/checkout/`,
`packages/do/src/fs/store/initial-write/`, `bench/workerd/`.

<!-- Origin: sprint-2026-09-28-memory-and-cost WU3 attribution and the WU4 escalation. -->
