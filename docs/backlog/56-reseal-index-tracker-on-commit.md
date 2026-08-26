---
id: 56
title: Move the index tracker baseline on commit
blocked-by: []
---

# 56 — Move the index tracker baseline on commit

**Summary.** Effort S. The first `status` after `commit` diffs two full trees
to recover the paths the commit just wrote. The tracker can move with HEAD
inside the commit transaction instead.

## Problem

`src/core/ops/commit.ts` never touches `context.indexTracker`. Clone and fetch
(`src/core/ops/network.ts:357`) and the sparse clean checkout
(`src/core/ops/refs.ts:174`) do reseal. After a commit the sealed baseline is
therefore the *previous* tree, and `sparseStatusCandidates`
(`src/core/ops/status-sparse.ts:297`) adds `repo.walkTreeDiff(baseline, current)`
to the candidates — a diff of two full trees whose result the commit already
knew.

[`benchmark-current.md`](../reference/benchmark-current.md) shows the price:
`git.status — clean commit` 502 ms, 23 SQL, 1,156 rows; the next clean status
after a checkout resealed is 0.7 ms. [10](10-worktree-wall-time.md) records the
number without a cause. The row count says this is CPU, not I/O — profile per
10 before assuming the diff is all of the 500 ms.

Moving the baseline alone is sound. Commit builds the tree from the whole index
(`commit.ts:156`), refuses unmerged paths (`commit.ts:92`), and runs in
`transactionSync` (`commit.ts:131`). For every path outside the dirty rows,
baseline == index == worktree held before the commit; the commit changes neither
index nor worktree, and the new tree equals the index — so new tree == index ==
worktree still holds. Dirty rows stay dirty: an `INDEX_DIRTY` flag on a
committed path is now stale but conservative, and the next status re-checks and
reseals it clean.

## Approach / acceptance

- After the ref moves, inside the commit transaction, move the tracker baseline
  to the new tree without touching dirty rows. Prefer a narrow writer method
  (one `UPDATE git_index_state … SET baseline_tree_oid`) over
  `reseal(checkoutId, tree, dirtyPaths)`, which would read up to 32,000 rows to
  write them back.
- Only a sealed state (`complete = 1`) moves; an incomplete tracker stays
  incomplete.
- Clearing `INDEX_DIRTY` for committed paths is optional and not required for
  correctness.
- **Witness.** A sibling of `tests/status-sparse.test.ts:558` ("uses the tree
  diff when HEAD changes after the tracker baseline"): after `commit`, status
  runs sparse with an empty tree diff and the recorded statement count matches
  the clean-main case. Re-measure `git.status (clean commit)` under a CPU lease
  and update `benchmark-current.md`.

## Touch points

`src/core/ops/commit.ts`, `src/core/context.ts`, `src/sqlite/index-tracker.ts`,
`src/runtime/workspace.ts`, `tests/status-sparse.test.ts`,
`docs/reference/benchmark-current.md`.

<!-- Origin: status code review, 2026-08-26; contributor to 10. -->
