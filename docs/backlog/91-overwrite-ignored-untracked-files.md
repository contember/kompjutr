---
id: 91
title: Overwrite ignored untracked files on checkout, merge and rebase
blocked-by: []
---

# 91 — Overwrite ignored untracked files on checkout, merge and rebase

**Summary.** Git treats an ignored untracked file as expendable and overwrites
it when a checkout, merge or rebase writes a tracked file at the same path.
kompjutr refuses with `ECHECKOUTFAIL`. Parity tier B: a loud refusal, no data at
risk, and deleting the ignored file is a workaround.

## Problem

Reproduced at `62ffbf0` (2026-09-24) against git 2.54.0. Fixture: `.gitignore`
contains `*.log`; branch `topic` force-adds a tracked `x.log`; `main` does not
track it; the worktree on `main` holds an untracked, ignored `x.log`.

| Command | git | kompjutr |
|---|---|---|
| `checkout topic`, `switch topic` | exit 0, `x.log` replaced | exit 128, `untracked working tree files would be overwritten by checkout: x.log` |
| `merge topic` | exit 0 | `ECHECKOUTFAIL` `untracked working tree files would be overwritten by merge: x.log` |
| `rebase topic` | exit 0 | exit 128, `… would be overwritten by rebase: x.log` |

All three go through `checkoutBlockers`
(`packages/git/src/ops/refs/refs-checkout-guard.ts:70`). It records every
untracked worktree row that a target entry would replace as a blocker
(`:106`, `:113`, `:139`) and never consults the ignore rules. The refusals are
raised at `ops/refs/refs.ts:172`, `ops/integration/integration-worktree.ts:147-164`
(merge, cherry-pick, revert) and `ops/rebase/rebase-lifecycle-baseline.ts:119-161`.

The simplification sprint's WU1 review found the merge case; the same probe
shows checkout and rebase share it.

## Approach / acceptance

Classify an untracked blocker with the repository's standard excludes, through
the `IgnoreMatcher` from `loadIgnoreMatcher` (`packages/git/src/ignore/`) that
status already uses, and drop ignored paths from the untracked blocker list.
Keep refusing for untracked files that are not ignored and for every
tracked-change blocker. Decide explicitly whether an ignored directory that
must become a file is removed, and match Git.

Witness: a parity test per command (checkout, merge, cherry-pick, rebase)
against real `git`, asserting exit status, the written bytes, index, and HEAD;
a companion case with an untracked, not ignored file still refuses in both.

## Touch points

`packages/git/src/ops/refs/refs-checkout-guard.ts`,
`packages/git/src/ignore/`, the three callers above,
`docs/reference/git-support.md`.

<!-- Origin: sprint-2026-09-23 simplification, WU1 review run-log entry. -->
