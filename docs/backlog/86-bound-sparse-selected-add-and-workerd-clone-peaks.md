---
id: 86
title: Bound the sparse-selected-add and workerd clone memory peaks
blocked-by: []
---

# 86 — Bound the sparse-selected-add and workerd clone memory peaks

**Summary.** Two memory gates were already missed before the 2026-09-10 sprint
started and are still missed at `62ffbf0`.

## Problem

**`core.sparse-selected-add`** adds 128.2, 149.0 and 158.5 MiB of process peak
in three runs at `62ffbf0` (2026-09-24) against the harness's 100 MiB target,
and hard-fails the protocol. It was 154.17 MiB at the 2026-09-10 closure and
154.11 MiB at `acf7289`. The spread across runs is wider than any change since.

**The workerd Next.js clone** adds 377.4, 453.1 and 445.0 MiB of process RSS in
three runs at `62ffbf0` against the harness's 100 MiB gate. The clone itself is
correct: 1,012 statements, 145,777 rows, 24,252 verified files. Earlier single
runs recorded 391.08 MiB at `acf7289`, 398.00 MiB at the 2026-09-10 closure,
and 412.8 and 420.6 MiB during the simplification sprint (`9ed0659` and WU21).
Local workerd has no isolate memory limiter, so this RSS is a regression signal
and not evidence about the production 128 MB isolate limit; it also includes
the SQLite page cache of a 218 MiB database.

**The same clone in Node** is not a regression. The 2026-09-10 figures
(126.06 and 140.23 MiB) were taken under a 1 GiB, no-swap cgroup cap; later
figures (222–250 MiB) were not. On 2026-09-24, in the network scenario and
under the same cap, `acf7289` added 154.2 and 124.4 MiB and `866843e` added
140.3 and 111.2 MiB. Without the cap, they added 243.7 and 249.0 MiB. The
approved <160 MiB gate holds under the conditions it was approved for.

The clone's 1,012 statements miss the ADR-0005 target by 12; `bench:statements
--check` reports it, and it has no dedicated item.

Measurements: [`benchmark-current`](../reference/benchmark-current.md) and
ignored `bench/results/nextjs-workflow.json`, `nextjs-network-*.json`,
`wu8-memory-2026-09-22-notes/` and `wu8-workerd-2026-09-22/`.

## Approach / acceptance

Attribute each peak to its retained structures before changing code — neither
number has been decomposed, and the harnesses cannot separate V8
heap from SQLite page cache and fragmentation. Start from the sparse selection
and initial-write paths for the first, and from the clone's pack ingest,
checkout and index population for the workerd clone. Record the cgroup `memory.max`
with every memory number; a peak taken without a cap is not comparable with one
taken under it.

Witness: both scenarios meet their declared gate with unchanged semantics
and native oracles, measured under an enforcing lease over at least three runs.
If a gate turns out to be wrong rather than the code, say so with evidence and
change the gate deliberately — do not widen it to pass.

## Touch points

`packages/git/src/do-fs/sparse/`, `packages/git/src/ops/staging/`,
`packages/do/src/fs/store/initial-write.ts`, `packages/git/src/ops/checkout/`,
`packages/git/src/store/pack/ingest/`, `bench/memory.ts`, `bench/workerd/`,
`bench/nextjs-run.ts`.

<!-- Origin: sprint-2026-09-10 WU8 measurement, 2026-09-22 run-log entry; remeasured at the 2026-09-23 simplification closure. -->
