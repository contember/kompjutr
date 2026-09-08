---
id: 78
title: Make SQL cursors seek and deliver incrementally
blocked-by: []
---

# 78 — Make SQL cursors seek and deliver incrementally

**Summary.** Remove repeated prefix work and qualify early delivery in bounded
index, operation-root, and tree-diff consumers.

## Problem and evidence

- Index continuation uses `path > ? OR (path = ? AND stage > ?)`, while the dirty
  tracker uses an optional-cursor OR. Review query plans constrained checkout
  identity without the continuation key; tuple comparison produced a full seek.
  Independent verification confirmed the SQL, not a second plan execution. This
  is planner-specific evidence, not a universal claim about OR predicates.
- Operation-root paging uses an ordered ten-arm UNION with `LIMIT/OFFSET`.
  Later pages consume preceding roots again even under an ideal ordered merge.
  The 4,096-step cap bounds cardinality but does not make paging linear.
- Tree diff orders the recursive queue, then applies an outer error-first sort.
  A sparse consumer stopping on result 1,001 may still require the whole differing
  graph before receiving ordinary rows. Static confidence is medium until an
  execution-plan/first-row-work witness is added. Equal subtrees are pruned.

These are valid workload costs, not corruption or misuse. Sparse directory
selection and cursorless sweep are already owned by
[65](65-git-sqlite-architecture-review.md), ARCH-20 and ARCH-16 respectively.

## Approach / acceptance

- Capture current target-SQLite plans and row/VM work before selecting rewrites.
- Use seekable row-value continuation and separate initial/continued tracker
  queries where the plan confirms the benefit. Cover checkout and scratch indexes.
- Replace journal OFFSET cursors with source-family/ordinal/endpoint positions
  pushed into their source queries. Preserve restart and duplicate-root semantics.
- Establish a real incremental tree-diff contract while preserving error handling;
  simply deleting the outer ordering is not an accepted design.
- Verify early termination, sorted page concatenation, and N/2N work growth.
  Statement counts and returned page size alone are insufficient evidence.

## Touch points

- `packages/git/src/store/indexes/index-table-helpers.ts`.
- `packages/git/src/do-fs/indexes/index-tracker.ts`.
- `packages/git/src/store/operations/operation-journal-roots.ts`.
- `packages/git/src/store/maintenance/roots/root-worktree-pages.ts`.
- `packages/git/src/store/trees/tree-walk-sql.ts`.
- `tests/store-stream.test.ts`, `tests/maintenance-roots.test.ts`,
  `tests/tree-diff.test.ts`.
