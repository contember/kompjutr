---
id: 95
title: Reduce the Next.js rebase step's full-tree passes and peak
blocked-by: []
---

# 95 — Reduce the Next.js rebase step's full-tree passes and peak

**Summary.** Rebasing one 100-file commit onto a new `main` commit in the
24,252-file Next.js checkout reads 1.06 million rows and adds 96.6 MiB of
process peak in Node, just under the <100 MiB target. The rows come from
repeated full-tree passes; the peak is short-lived garbage from them.

## Problem

Measured at `62ffbf0` (2026-09-24) with `bench:nextjs`, phase
`git.rebase (100 onto main)`: 942 statements, 1,061,270 rows, 10.8 s, 96.6 MiB
added peak RSS. WU22 of the simplification sprint measured 951 statements,
1.06M rows, ~10 s and ~102 MiB when it added the phase.

WU22 showed the peak is garbage, not retention: a 30,000-file probe passes with
`--max-old-space-size=56`. A row histogram of the phase at `62ffbf0` shows
where the rows come from:

| Query family | Statements | Rows | Full-tree equivalents |
|---|---:|---:|---:|
| `git_index` scans | 388 | 388,046 | ~16 × 24,252 entries |
| Recursive tree-source walks | 15 | 339,540 | ~10 × 34,746 tree entries |
| Worktree path walks (`fs_paths` ⋈ `fs_nodes`) | 294 | 289,258 | ~8 × 35,937 paths |
| Blob payload reads | 46 | 40,964 | — |
| Everything else | 199 | 3,462 | — |

A 100-file change should not need about 34 full passes over the index, the
trees and the worktree. Some are full by construction: the start of `rebase()`
runs a clean-worktree check and two baseline-tree preflights
(`packages/git/src/ops/rebase/rebase.ts:64,71,73`).
[Backlog 84](84-read-integration-worktree-inputs-once.md) tracks the repeated
worktree content reads in the same integration code; this item is the index,
tree and path passes.

## Approach / acceptance

Name the consumer of each full pass first — instrument the phase per call site,
not per query shape. Then collapse the passes that read the same rows for the
same decision, and bound the ones that only need the touched paths by the diff
between the step's base and its result. Keep every pass streamed and batched.

Witness: the Next.js rebase phase reads fewer rows with unchanged statement
count or lower, unchanged rebase semantics and native oracles, and an added
peak that falls over three leased runs; `core.rebase.baseline-hash` stays under
100 MiB.

## Touch points

`packages/git/src/ops/rebase/`, `packages/git/src/ops/integration/`,
`packages/git/src/ops/worktree/`, `packages/git/src/ops/tree/`,
`bench/nextjs-workflow.ts`.

<!-- Origin: sprint-2026-09-23 simplification, WU22 run-log entry. -->
