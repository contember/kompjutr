---
id: 55
title: Keep status sparse across untracked files under normal collapsing
blocked-by: []
---

# 55 — Keep status sparse across untracked files under normal collapsing

**Summary.** Effort M. With the default `untrackedFiles: "normal"`, one
reportable untracked file sends `status` down the full path. The sparse fast
path therefore only serves a working tree with no new files, which is not the
normal state of a working tree.

## Problem

`src/core/ops/status-sparse.ts:180-181` returns `null` — full status — as soon
as a candidate is a reportable untracked file and collapsing is `"normal"`.
`tests/status-sparse.test.ts:342` pins this ("falls back for normal untracked
collapsing and stays sparse for all").

The reason is that collapsing has to answer two questions per ancestor
directory of the untracked file: does it hold a tracked path
(`shallowestUntrackedDirectory`, `status.ts:571`), and is it itself a tracked
file that a directory replaced (`status.ts:427`). Today both answers come from
`snapshotStatusIndex` (`status.ts:520`) — a full index scan retained in memory
as `trackedDirs` and `trackedPaths`, up to `STATUS_RETAINED_BYTES`.

The cost is the whole gap the sparse path exists to close. On the 24,252-file
fixture the sparse path answers in 0.7–1.9 ms and the full path in roughly
500 ms ([`benchmark-current.md`](../reference/benchmark-current.md),
`git.status — clean main` against `git.status — clean commit`). A scratch file,
or any file written before `git add`, is enough to lose it.

The candidate set is already complete for this. The tracker journals every
worktree write as `WORKTREE_DIRTY`, the full-status seed marks untracked leaves
(`FullStatusTrackerSeed.observeUntracked`), and `sparseStatus` retains them on
reseal — so every untracked file is a sparse candidate.

## Approach / acceptance

- Answer both questions with one bounded lookup over `git_index` instead of a
  retained snapshot. Collect the distinct ancestor directories of the untracked
  candidates (at most 1,000 candidates × depth; cap and fall back on `E2BIG`),
  pass them as one JSON array the way `hydrate` passes paths, and return per
  ancestor whether `path = ancestor` exists and whether the range
  `ancestor || '/'` … `ancestor || '0'` holds a row. One or two statements.
- Re-implement the two `shallowest…Directory` helpers over that answer, dedupe
  the collapsed `dir/` row across candidates, and keep the
  tracked-file-replaced-by-directory rule. Ignore rules stay in memory via
  `loadIgnoreMatcher`, as today.
- Retained flags on reseal are unchanged: an untracked leaf stays
  `WORKTREE_DIRTY`.
- The same lookup can later replace `trackedPaths` retention in the full path —
  `status.ts:427` and `prunableExcludeRoots` are its only consumers — and shrink
  the full path's memory to `trackedDirs`. Out of scope here; file it when this
  lands.
- **Witness.** `tests/status-sparse.test.ts:342` flips: normal collapsing stays
  sparse. Recorded statement count stays flat as the number of untracked files
  grows. Output matches `status()` for: an untracked file in a tracked
  directory, a wholly untracked directory, a nested untracked directory under a
  tracked one, a tracked file replaced by a directory, an ignored directory with
  and without `includeIgnored`.

## Touch points

`src/core/ops/status-sparse.ts`, `src/core/ops/status.ts` (shared collapse
helpers), `src/core/sparse-workspace.ts` and `src/sqlite/sparse-workspace.ts`
(the bounded ancestor lookup), `tests/status-sparse.test.ts`.

<!-- Origin: status code review, 2026-08-26; contributor to 10. -->
