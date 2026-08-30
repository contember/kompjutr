---
id: 63
title: Bound packed dependency graph traversal
blocked-by: []
---

# 63 — Bound packed dependency graph traversal

**Summary.** Keep extreme packed-object graphs within bounded live memory and
make maintenance chain validation linear without adding a projected-work refusal.

## Problem

`src/sqlite/packs.ts` retains root and checkpoint state proportional to graph
width and depth, so an extreme format-valid graph can exhaust the shared 64 MiB
owner. `src/sqlite/maintenance/reachability.ts` also revalidates progressively
shorter packed-delta suffixes, making a deep chain O(n²). The latter behavior is
inherited; neither issue is a regression for a current supported workload.

## Approach / acceptance

Keep only a bounded live frontier while preserving cycle, depth, source and
corruption validation. Process or persist maintenance progress so each dependency
edge is validated a constant number of times. A wide/deep graph must resolve with
bounded measured high-water, and deep-chain maintenance work must grow linearly.
Do not lower structural limits or introduce a projected-work refusal.

## Touch points

`src/sqlite/packs.ts`, `src/sqlite/maintenance/reachability.ts`,
`tests/pack.test.ts`, `tests/maintenance-reachability.test.ts`.

<!-- Origin: ../archive/sprint-2026-08-29-budget-targets-and-store-split.md WU6g -->
