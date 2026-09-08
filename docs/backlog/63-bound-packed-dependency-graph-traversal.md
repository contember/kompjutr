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
shorter packed-delta suffixes, making a deep chain O(n²). None of these shapes is
a regression for a current supported workload, but all violate the structural
cost model at adversarial format-valid scale.

## Approach / acceptance

Keep only a bounded live frontier while preserving cycle, depth, source, and
corruption validation. Bound both ordinary and paged packed-read memos; repeated
inflation of a large shared base is an acceptable trade only when measured.
Process or persist maintenance progress so each dependency edge is validated a
constant number of times. Wide and deep graph reads must have bounded measured
high-water, and deep-chain maintenance work must grow linearly. Do not lower
structural limits or introduce a projected-work refusal.

## Touch points

`packages/git/src/store/pack/read.ts`, `packages/git/src/store/pack/lifecycle.ts`,
`packages/git/src/store/maintenance/reachability.ts`, `tests/pack.test.ts`,
`tests/maintenance-reachability.test.ts`.

<!-- Origin: ../archive/sprint-2026-08-29-budget-targets-and-store-split.md WU6g -->
<!-- Extended by ARCH-10 from the 2026-09-02 Git-in-SQLite architecture review. -->
