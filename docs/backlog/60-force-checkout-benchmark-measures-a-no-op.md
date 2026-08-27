---
id: 60
title: Force-checkout benchmark phases measure a no-op
blocked-by: []
---

# 60 — Force-checkout benchmark phases measure a no-op

**Summary.** Effort XS. The two `(force)` checkout rows in the curated
benchmark run with HEAD already on the target branch, so they time an empty
tree diff. Next to the 520 ms non-force rows they read as a fast path that
does not exist.

## Problem

`bench/nextjs-workflow.ts:209-236` runs `git.checkout main`, then
`git.checkout main (force)` without moving away from `main`; the `bench-work`
pair does the same. `trySparseCleanCheckout` returns at
`candidates.length === 0` (`src/core/ops/sparse-checkout.ts:83`) once
`walkTreeDiff(HEAD, HEAD)` is empty, which `iterateTreeDiff` short-circuits
outright (`src/sqlite/tree-walk.ts:734`).

[`benchmark-current.md`](../reference/benchmark-current.md) therefore reports
7.1 ms and 6.7 ms for the force rows against 519.8 ms and 526.5 ms for the
real transitions. `bench/CLAUDE.md`: a number measured wrong is worse than
none.

## Approach / acceptance

- Make each force phase a real transition: switch to the other branch first,
  or force from the other branch over a dirty file, which is what `force` is
  for. Or drop the rows.
- Re-measure under a CPU lease and update `benchmark-current.md` in the same
  change.
- Do this before [10](10-worktree-wall-time.md), [61](61-bounded-add-for-explicit-pathspecs.md)
  or [62](62-reuse-head-subtrees-on-commit.md) re-measure anything.
- **Witness.** The force rows show row counts and wall time comparable to the
  non-force checkout of the same transition.

## Touch points

`bench/nextjs-workflow.ts`, `docs/reference/benchmark-current.md`.

<!-- Origin: code review of add/commit/checkout, 2026-08-26. -->
