---
id: 63
title: Bound packed dependency graph traversal
blocked-by: []
---

# 63 — Bound packed dependency graph traversal

**Summary.** Keep extreme packed-object graphs and batched reads within bounded
live memory, and make maintenance chain validation linear without adding a
projected-work refusal.

## Problem

Packed dependency traversal retains root and checkpoint state proportional to
graph width and depth. In addition, `packages/git/src/store/pack/read.ts` keeps every
resolved intermediate object in an unbounded per-call memo, including objects
too large for the bounded shared cache. A deep or shared-base delta batch can
therefore exceed the operation's intended live-memory bound.

`packages/git/src/store/maintenance/reachability.ts` also revalidates progressively
shorter packed-delta suffixes, making a deep chain O(n²). These are valid-input
scale problems reachable through ordinary reads and maintenance, not failures
requiring out-of-band database mutation. A production workload regression has
not been measured.

## 2026-09-08 evidence qualification

Independent static verification traced the retaining `resolved` map to
`packages/git/src/store/pack/read/read-resolver.ts`. An 8 MiB base and 16 distinct
8 MiB targets retain 136 MiB of decoded payload while immediate delta working-set
checks can still pass. This is an analytical payload total, not measured RSS or
a reproduced Workers OOM.

The paged reader replaces decoded checkpoint results between pages; it does not
retain every prior decoded checkpoint. Page descriptors and checkpoint metadata
still accumulate during discovery, and each page uses the retaining resolver.
Maintenance's suffix revalidation remains a separate verified quadratic path.

## Approach / acceptance

Keep only a bounded live frontier while preserving cycle, depth, source, and
corruption validation. Bound both ordinary and paged packed-read memos; repeated
inflation of a large shared base is an acceptable trade only when measured.
Process or persist maintenance progress so each dependency edge is validated a
constant number of times. Wide and deep graph reads must have bounded measured
high-water, and deep-chain maintenance work must grow linearly. Do not lower
structural limits or introduce a projected-work refusal.

Exercise public cold reads with format-valid multi-megabyte delta chains and
public maintenance with N/2N depth fixtures. Measure under the benchmark rules;
cache size, returned batch size, and statement count alone are not sufficient.
Coordinate dependency lifetime with
[72](72-preserve-pack-dependencies-during-lifecycle.md).

## Touch points

`packages/git/src/store/pack/read.ts`, `packages/git/src/store/pack/lifecycle.ts`,
`packages/git/src/store/maintenance/reachability.ts`, `tests/pack.test.ts`,
`tests/maintenance-reachability.test.ts`.

<!-- Origin: ../archive/sprint-2026-08-29-budget-targets-and-store-split.md WU6g -->
<!-- Extended by ARCH-10 from the 2026-09-02 Git-in-SQLite architecture review. -->
