---
id: 54
title: Prune ignored directories from the full status walk
blocked-by: []
---

# 54 — Prune ignored directories from the full status walk

**Summary.** Effort S. The full status path streams every row under an ignored
directory through the merge join and discards it, so a working tree with
`node_modules/` or `dist/` pays for tens of thousands of rows it never reports.

## Problem

`src/core/ops/status.ts:462` opens the worktree walk with `includeIgnored: true`
so that a tracked file inside an ignored directory stays visible. The walker
prunes an ignored directory only when `includeIgnored !== true`
(`src/core/ops/worktree-io.ts:172`), so status opts out of the one prune it
needs most. Every entry below the ignored directory becomes a `joinSorted3` row
that `statusStreamInternal` drops at `status.ts:396`.

The mechanism already exists. The walker skips a subtree in one page turn
(`pruned` ranges and `afterSubtree` seeks, `worktree-io.ts:129-155`), and
`prunableExcludeRoots` (`status.ts:478`) uses it for nested repositories under
the guard "no tracked path below this root". The same guard is available for
ignored directories before the walk starts: `snapshotStatusIndex`
(`status.ts:520`) computes `trackedDirs` for exactly that purpose.

The benchmark fixture has no ignored tree, so
[`benchmark-current.md`](../reference/benchmark-current.md) does not show this
cost.

## Approach / acceptance

- Give the walk a per-directory prune predicate that applies even with
  `includeIgnored: true`. Status passes "ignored as a directory and not in
  `snapshot.trackedDirs`". A directory that holds a tracked path is still
  descended, so a tracked file under an ignored directory keeps its row.
- Prune only when the caller did not ask for ignored rows. With
  `includeIgnored === true` on the status side the collapsed `! dir/` row comes
  from the first file below the directory, so that mode keeps today's walk.
- No change to the `-unormal` collapsing rules or to the exclude-root pruning.
- **Witness.** `tests/status.test.ts`: a tracked tree plus an ignored directory
  holding N files — the recorded worktree scan reads no row below it, and the
  rows match the current output for (a) an ignored directory with no tracked
  file, (b) an ignored directory containing a tracked file, (c)
  `includeIgnored: true`. Optionally add an ignored-tree phase to
  `bench/nextjs-workflow.ts` under the rules in `bench/CLAUDE.md`.

## Touch points

`src/core/ops/status.ts`, `src/core/ops/worktree-io.ts`, `tests/status.test.ts`,
optionally `bench/nextjs-workflow.ts` and
`docs/reference/benchmark-current.md`.

<!-- Origin: status code review, 2026-08-26; contributor to 10. -->
