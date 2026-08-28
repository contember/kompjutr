---
id: 62
title: Classify status renames over the sparse candidates, not the whole repository
blocked-by: []
---

# 62 — Classify status renames over the sparse candidates, not the whole repository

**Summary.** Performance, not parity. A non-empty tracker-backed `status` pays a
full HEAD-tree stream plus a full index scan for exact rename detection, so
`status` with 100 dirty paths in a 24,252-file checkout costs ~1.3 s and
~49,500 rows where `diff` on the same state costs ~65 ms and ~1,570 rows. The
sparse hydration already holds every row the classifier needs.

## Problem

- `src/core/ops/status.ts:217` — after `sparseStatus` returns a non-empty
  result, `eagerStatus` calls `classifyStatusRenames(repo, repo.headTree(), …)`.
- `src/core/ops/status.ts:294–330` — that function merge-joins
  `treeStream(repo, headTreeOid)` with `statusIndexGroups(repo.checkout.indexScan())`:
  one recursive tree traversal and one paged scan of `git_index`, proportional
  to tracked paths, regardless of how many paths are dirty.
- `diff` does not have this cost. `src/core/ops/diff.ts:202` classifies over
  the sparse `PendingChange[]`, so its rename pass is proportional to changed
  paths.
- Rename detection defaults on (`src/core/ops/rename-detection.ts:71`), so
  every consumer pays it. The empty-result branch (`status.ts:212–215`) skips
  the classification, which is why a clean sealed `status` stays at ~10 rows.

Measured on 2026-08-28 at `f8b834f` (express fixture, 218 tracked files, 10
modified through `fs.writeFiles`; statement and row counts, deterministic):

| operation | SQL | rows |
|---|---:|---:|
| `status`, renames on (default) | 34 | 542 |
| `status`, `renames: false` | 30 | 105 |
| `diffSummary` | 26 | 156 |
| `status` after `add`, renames on | 33 | 504 |
| `status` after `add`, `renames: false` | 28 | 67 |

The query histogram shows the difference is exactly the `WITH RECURSIVE
params(repo_id, root_oid, …)` tree stream and the `SELECT … FROM git_index
WHERE checkout_id = ? AND (path > ? …)` scan. On the Next.js workflow
(`docs/reference/benchmark-current.md`) the same two streams account for
~48,500 of the 49,540 rows in `git.status — 100 modified` and for the
"remain full-repository paths" caveat recorded there.

The existing witness does not catch it: `tests/status-sparse.test.ts:367–392`
("hashes one hundred modified tracked paths without a refresh scan") asserts
`< 50` statements and `< 10,000` rows on a fixture small enough for the full
join to fit under both bounds.

## Approach / acceptance

- In the sparse branch of `eagerStatus`, build the `ExactRenameClassifier`
  from the hydrated `SparseWorkspaceRow[]` (`row.current` as the HEAD side,
  the stage-0 entry of `row.index` as the index side) instead of a fresh
  whole-repository join. A rename source is a path present in HEAD and absent
  from the index; a destination is the reverse. Both are index mutations
  since the baseline, so a complete journal (`git_index_state.complete = 1`)
  plus the baseline-to-HEAD tree difference already lists every one of them
  among the candidates. Sparse hydration admits at most 1,000 paths, below
  `MAX_EXACT_RENAME_CANDIDATES`, so the classifier never falls back on this
  path.
- The full (non-sparse) `status` and `statusStream` keep the existing join;
  this item changes only the tracker-backed path. Results must stay identical
  to the full status and to Git for exact staged renames, including a rename
  whose source is still present in the worktree
  (`tests/status-sparse.test.ts:449`, `:544`).
- Witness: a sparse `status` over N modified or staged paths in a checkout
  large enough that the whole-repository join cannot hide under the bound —
  rows proportional to N, not to tracked paths — and, with the statement
  histogram, no tree-stream or `git_index` range-scan statement. A second
  case stages an exact rename through the sparse path and asserts the `R`
  row matches the full status. Re-run `npm run bench:nextjs` under a CPU lease
  and refresh `docs/reference/benchmark-current.md`; the target is
  `git.status — 100 modified` and `— 100 staged` in the same order as `diff`
  (≈1,600 rows, below 100 ms).

## Touch points

- `src/core/ops/status.ts` — `eagerStatus`, `classifyStatusRenames`
- `src/core/ops/status-sparse.ts` — `sparseStatus` must expose the hydrated
  rows (or classify inline) rather than only the finished `StatusDetail[]`
- `src/core/ops/rename-detection.ts` — unchanged unless the classifier needs
  a row-based input helper
- `tests/status-sparse.test.ts`, `tests/rename-detection.test.ts`
- `docs/reference/benchmark-current.md`, `docs/reference/architecture.md`
  ("Sparse workspace tracking" — status bullet)

<!-- Origin: benchmark comparison on 2026-08-28 (bench:nextjs, 3 leased runs at f8b834f) and a query-histogram probe of status vs diff on the express fixture. -->
