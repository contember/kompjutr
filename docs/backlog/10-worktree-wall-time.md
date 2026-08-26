---
id: 10
title: Close worktree wall-time gaps
blocked-by: []
---

# 10 — Close worktree wall-time gaps

**Summary.** Bring common status and checkout paths toward the sub-100 ms target
without weakening correctness or resource bounds.

## Problem

`docs/reference/benchmark-current.md` shows bounded SQL usage but roughly 500 ms
for clean status after commit and ordinary branch checkout on the 24,252-file
fixture. The README therefore still calls out full-repository status and checkout
as blockers for a performance-complete release.

The status half is attributed. Its contributors are filed as separate items
with independent witnesses — [54](54-prune-ignored-directories-in-status-walk.md)
(ignored directories are walked, not pruned),
[55](55-sparse-status-across-untracked-files.md) (one untracked file forces the
full path), [56](56-reseal-index-tracker-on-commit.md) (the first status after
commit pays a full tree diff), and [57](57-single-prepass-in-full-status.md)
(the index is streamed three times). The checkout half is not yet attributed.

## Approach / acceptance

- Profile under a CPU lease and attribute time to filesystem scans, tree/index
  joins, hashing, writes, and sparse-workspace fallback paths before changing the
  design.
- Reuse authoritative revision and tree metadata to avoid redundant full scans,
  while keeping every SQLite row untrusted and preserving fallback correctness.
- Add functional witnesses for every optimized path and adversarial tests for
  stale or corrupt cache data.
- Update the curated benchmark from repeated leased measurements. The target is
  below 100 ms for operations touching at most 1,000 changed paths, or a documented
  narrower claim backed by measurements if the target proves unattainable.

## Touch points

`src/core/ops/status*.ts`, `src/core/ops/checkout*.ts`, `src/sqlite/`, `tests/`,
`bench/`, `docs/reference/benchmark-current.md`, `README.md`
