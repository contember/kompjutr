---
id: 86
title: Bound the sparse-selected-add and workerd clone memory peaks
blocked-by: []
---

# 86 — Bound the sparse-selected-add and workerd clone memory peaks

**Summary.** Two memory gates were already missed before the 2026-09-10 sprint
started and are still missed. Both are now measured, so the numbers are real
rather than assumed.

## Problem

**`core.sparse-selected-add`** adds 154.17 MiB of process peak against the
harness's 100 MiB target, and hard-fails the protocol. At `acf7289`, the
sprint's starting commit, it was 154.11 MiB — the sprint moved it by 61,440
bytes, 0.04%.

**The workerd Next.js clone** adds 398.00 MiB of process RSS against the
harness's 100 MiB gate. At `acf7289` it was 391.08 MiB. Note that local
workerd has no isolate memory limiter, so this RSS is a regression signal and
not evidence about the production 128 MB isolate limit; it also includes the
SQLite page cache of a 233 MB database.

The same workerd clone crossed the statement target during the sprint, 996 to
1,068, with rows read 145,795 to 214,486. The +72 statements are spread across
WU1, WU3, WU5 and WU6 rather than attributable to one change.

Measurements and attribution logs: ignored
`bench/results/wu8-memory-2026-09-22-notes/` and
`bench/results/wu8-workerd-2026-09-22/`.

## Approach / acceptance

Attribute each peak to its retained structures before changing code — neither
number has been decomposed, and the harness cannot separate V8 heap from
SQLite page cache and fragmentation. Start from the sparse selection and
initial-write paths for the first, and from the clone's checkout and index
population for the second.

Witness: both scenarios meet their declared gate with unchanged semantics and
native oracles, measured under an enforcing lease. If a gate turns out to be
wrong rather than the code, say so with evidence and change the gate
deliberately — do not widen it to pass.

## Touch points

`packages/git/src/do-fs/sparse/`, `packages/git/src/ops/staging/`,
`packages/do/src/fs/store/initial-write.ts`, `packages/git/src/ops/checkout/`,
`bench/memory.ts`, `bench/workerd/`.

<!-- Origin: sprint-2026-09-10 WU8 measurement, 2026-09-22 run-log entry. -->
