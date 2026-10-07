---
id: 120
title: Cut the remaining full-history clone CPU
blocked-by: []
---

# 120 — Cut the remaining full-history clone CPU

**Summary.** The reference clone takes 74.5 s against the ≤ 60 s target and the
≤ 30 s stretch target. Native git takes 17–19 s. Effort: M per lever.

## Problem

Profile at `1347704`, CPU by phase (one leased CDP run, 73.8 s busy):

| Phase | CPU | Breakdown |
|---|---:|---|
| Deferred deltas | 16.1 s | pako inflate for the header probe plus apply; TS SHA-1 |
| Pack object rows | 11.7 s | two `INSERT OR IGNORE` statements per batch, 338k objects, 1.7 M rows written |
| Metadata first pass | 7.5 s | |
| Pack publication | 6.2 s | membership audit 1.6 s, promise insert |
| GC | 4.2 s | |
| Hydration | ~16 s wall | candidate scan, then server pack generation and receive |
| Commit projection | 3.5 s | |

## Approach / acceptance

Measure each lever separately with the WU0 harness and a CDP profile:

1. Let one pack-object table serve both roles at ingest.
2. Native SHA-1: measure `node:crypto` `createHash` under `nodejs_compat`
   against a Wasm kernel.
3. One inflater per deferred delta instead of a header probe plus an apply.
4. Overlap hydration negotiation with the end of metadata ingest.

Done when the clone is ≤ 60 s on the harness with an unchanged HEAD, file
count and clean worktree.

## Touch points

`store/pack/pack-ingest-index.ts`, `store/pack/ingest/*`, `common/sha1.ts`,
`ops/network/network-promisor.ts`.

<!-- Origin: sprint-2026-10-07-fast-fresh-clone WU5. -->
