---
id: 61
title: Bound add for explicit pathspecs
blocked-by: []
---

# 61 — Bound `add` for explicit pathspecs

**Summary.** Effort M. `add` with N explicit paths issues O(N) statements
before it starts and scans the whole index against every spec. One thousand
paths reach the statement ceiling on their own; one hundred cost 656 ms on the
24,252-file fixture.

## Problem

Two steps grow with the repository or with the pathspec count, and neither
needs to:

- `assertPathspecsMatch` (`src/core/ops/staging.ts:833`) calls
  `worktree.stat` once per spec — one resolved lookup each
  (`src/fs/store/ops.ts:146`) — and probes the index with
  `indexScan({ prefix, pageSize: 1 })` for every spec that is not on disk. The
  header calls this "O(pathspecs)", which is true in statements, and that is
  the problem: 1,000 explicit paths spend the whole 1,000-statement operation
  budget before the walk begins.
- `snapshotAddIndex` (`staging.ts:130`) streams the entire index — 24,252
  rows, 25 pages — and filters each row with `matchesPaths`
  (`src/core/ops/checkout.ts:31`), which is linear in the specs and runs a
  regex `replace` per spec per row. The worktree walk applies `withinPathspec`
  (`src/core/ops/worktree-io.ts:233`) the same way to every entry it visits.

[`benchmark-current.md`](../reference/benchmark-current.md): `git.add — 100`
takes 656 ms, 245 SQL and 31,380 rows for 100 changed files. The module header
promises that "the only work proportional to the tracked-file count is the
single SELECT over `git_index`"; with explicit pathspecs even that is
avoidable, and the per-spec statements are not in the promise at all.

The index write side is already right: `#applyIndexMutations`
(`src/sqlite/store.ts`) batches puts and removes through one JSON array.

## Approach / acceptance

- Existence check in two statements for any number of specs: one JSON-array
  lookup over `fs_paths` and one over `git_index`, the shape `hydrate` already
  uses for `readWorktree` and `readIndex`.
- Split specs into exact files and directory prefixes. Exact files: point
  lookups of index rows and worktree stat per path in one statement each — no
  index scan, no walk. Directory prefixes: keep the merge join but scope both
  sides to the prefix (`indexScan({ prefix })` exists; the walk already prunes
  outside `paths`), so cost follows the subtree, not the repository.
- Replace the linear `matchesPaths` / `withinPathspec` scans with a sorted spec
  index where they remain.
- `all` keeps the full scan; that is what it means.
- **Witness.** Recorded statement count for `add` with N explicit paths is
  constant for N = 1, 100, 1,000, and rows grow with N only. An adversarial
  test with 1,000 explicit paths stays under the statement budget. Parity in
  `tests/staging.test.ts` is unchanged. `git.add (100)` re-measured under a
  CPU lease below 100 ms and `benchmark-current.md` updated.

## Touch points

`src/core/ops/staging.ts`, `src/core/ops/checkout.ts`,
`src/core/ops/worktree-io.ts`, `src/core/sparse-workspace.ts` and
`src/sqlite/sparse-workspace.ts` if `hydrate` is reused, `tests/staging.test.ts`,
`bench/nextjs-workflow.ts`, `docs/reference/benchmark-current.md`.

<!-- Origin: code review of add/commit/checkout, 2026-08-26; wall-time sibling of 10. -->
