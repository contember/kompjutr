---
id: 64
title: Speed up the exhaustive test suite
blocked-by: []
---

# 64 — Speed up the exhaustive test suite

**Summary.** Reduce `npm run test:full` wall time without weakening its process
isolation, boundary witnesses, or stability on CI runners.

## Problem

The 2026-08-31 closure run took about 16 minutes. Eight sequential root shards
accounted for 12 minutes 29 seconds; they use two workers regardless of available
leased CPU. The root workers were occupied about 90% of their wall time. Pack
slices took 58 seconds, while the E2E slice took 71 seconds with four workers.

The thread pool is load-bearing: the forks pool previously hit Vitest's fixed
60-second `onTaskUpdate` RPC timeout during long synchronous store batches.
Measurements without `cpu-lease` are not evidence.

## Approach / acceptance

- Add per-slice and total wall-time reporting to `scripts/test-full.mjs`.
- Make the worker count configurable while retaining the two-worker default for
  runners whose capacity is unknown.
- Under an 8-vCPU lease, compare the current two-worker runner with four workers
  at the same commit. Record wall time, peak RSS, failures, and slice timings.
- Preserve root process isolation and the threads pool for the first comparison.
  Consider dynamic root scheduling or parallel pack slices only if worker scaling
  does not provide a stable material improvement.
- Accept a faster configuration only after two clean exhaustive runs and no
  increase in skipped tests, RPC failures, or retained-memory failures.

## Touch points

`scripts/test-full.mjs`, `package.json`, `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, `docs/reference/release.md`
