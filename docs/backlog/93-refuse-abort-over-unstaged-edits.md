---
id: 93
title: Refuse merge and replay abort over unstaged edits
blocked-by: []
---

# 93 — Refuse merge and replay abort over unstaged edits

**Summary.** Aborting a stopped merge, cherry-pick or revert silently
overwrites unstaged edits the user made afterwards to a path the operation
merged cleanly. Git's `reset --merge` refuses and keeps the edit. Parity tier S:
silent divergence that loses data.

## Problem

Reproduced at `62ffbf0` (2026-09-24) against git 2.54.0. `topic` changes
`s.txt` (conflicting) and `c.txt` (clean); `main` changes `s.txt`. Merge
`topic`, which stops on the conflict and writes the merged `c.txt`. Edit
`c.txt` in the worktree. Then abort:

| | Result | `c.txt` afterwards |
|---|---|---|
| `git merge --abort` | exit 128, `error: Entry 'c.txt' not uptodate. Cannot merge.` | the user's edit |
| `mergeAbort` | success | the pre-merge content; the edit is lost |

`mergeAbort` (`packages/git/src/ops/merge/merge.ts:377-387`) and
`cancelReplay` (`packages/git/src/ops/replay/replay-lifecycle.ts:303-309`, which
serves cherry-pick and revert abort and skip) both call
`restoreIntegrationOwned`
(`packages/git/src/ops/integration/integration-restore-owned.ts:17`). It
removes, recreates and rewrites every touched path from its saved pre-operation
state (`:88-117`) without comparing the current worktree with what the
operation wrote. Only a path that now blocks a removal is refused (`:55-66`).

## Approach / acceptance

Before any restore write, compare each touched path's worktree and index with
the state the operation left (its stage-0 index entry for a cleanly merged
path). Refuse with `ECHECKOUTFAIL`, naming the paths, when a path the restore
would change carries unstaged changes; change nothing. Mirror Git's
`reset --merge` rules for staged-but-unchanged and conflicted paths rather than
inventing a stricter rule.

Witness: parity tests against real `git` for `merge --abort`,
`cherry-pick --abort` and `revert --abort` with an unstaged edit to a cleanly
merged path — exit status, stderr, worktree bytes, index, and the operation
state left in place. The existing abort suites stay green.

## Touch points

`packages/git/src/ops/integration/integration-restore-owned.ts`,
`packages/git/src/ops/merge/merge.ts`,
`packages/git/src/ops/replay/replay-lifecycle.ts`, the CLI abort mappings in
`packages/git/src/cli/write/`, `docs/reference/git-support.md`.

<!-- Origin: sprint-2026-09-23 simplification, WU6 run-log entry. -->
