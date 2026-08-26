---
id: 33
title: Enforce the merged check on branch deletion
blocked-by: []
---

# 33 — Enforce the merged check on branch deletion

**Summary.** Tier S (silent divergence, data loss). `branchDelete()` behaves as
`git branch -D`; there is no safe `-d`.

## Problem

`branchDelete()` in `src/core/ops/refs.ts` checks only that the branch exists
and is not checked out, then calls `deleteRef`. Git's `-d` refuses to delete a
branch whose tip is not reachable from HEAD or from its configured upstream, and
requires the explicit `-D` to override.

kompjutr retains the deleted tip in bounded reflog history, but has no
`git fsck`-style repair surface. The safe spelling is still the one callers reach
for, and it still does the dangerous thing. Recovery now depends on acting inside
the fixed retention window.

## Approach / acceptance

- Add a bounded reachability check from HEAD and from `branch.<name>.merge`,
  reusing the merge-base graph walk and its `MAX_MERGE_BASE_COMMITS` bounds.
- Refuse an unmerged deletion with a stable error naming the tip, and add
  `force` for the `-D` behaviour.
- Fail closed when reachability cannot be decided within the bounds or across a
  shallow boundary; never delete on an inconclusive check.
- Real Git parity tests for merged, unmerged, upstream-merged, detached HEAD,
  shallow, and forced deletion.

## Touch points

`src/core/ops/refs.ts`, `src/core/ops/merge-base.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/refs.test.ts`,
`docs/reference/git-support.md`
