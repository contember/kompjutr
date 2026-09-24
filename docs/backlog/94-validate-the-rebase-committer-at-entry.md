---
id: 94
title: Validate the rebase committer option at the entry point
blocked-by: []
---

# 94 — Validate the rebase committer option at the entry point

**Summary.** `rebase()` accepts an invalid `committer` option, starts the
operation, and fails only at the first step commit, leaving a running rebase
journal behind. Cherry-pick already refuses the same input before it starts.

## Problem

At `62ffbf0`, `rebase` (`packages/git/src/ops/rebase/rebase.ts:49-114`) passes
`options.committer` only to `operationRefLogMetadata`
(`rebase.ts:87,93-96`). That helper silently drops an identity that
`validActor` rejects — for example a name containing `<` — and falls back to
the environment, config, or default identity
(`packages/git/src/ops/core/ref-log.ts:132-147,188-194`). The start transaction
then writes the operation journal (`rebase.ts:98`) and commits.

The first replayed step resolves the identity again and refuses it with
`requireJournalIdentity` (`packages/git/src/ops/rebase/rebase-lifecycle-step.ts:68`).
A probe at `62ffbf0` confirms it: the caller gets `EINVAL` (`rebase committer
name contains an invalid character`) from `rebase()`, but the repository is left in a
running rebase that only `rebaseContinue` with a valid committer or
`rebaseAbort` clears. When every step is skipped as already upstream, the
invalid committer is never checked and the rebase completes with a `null`
reflog actor; the redundant-commit case in the test at
`tests/rebase.test.ts:335-403` pins that behaviour.

Cherry-pick validates at entry (`packages/git/src/ops/replay/cherry-pick.ts:44`).

## Approach / acceptance

Resolve and validate the committer with `requireJournalIdentity` in `rebase()`
before the start transaction writes anything, the way cherry-pick does.
`rebaseContinue` already refuses an invalid committer without advancing the
journal (`tests/rebase.test.ts:513`).

Witness: `rebase()` with an invalid `committer` fails with `EINVAL` and leaves
HEAD, refs, index, worktree, reflog and operation state unchanged, both for a
replaying rebase and for one whose steps would all be skipped. Rewrite the
redundant-commit expectation in `tests/rebase.test.ts:378-403` to expect the
refusal.

## Touch points

`packages/git/src/ops/rebase/rebase.ts`,
`packages/git/src/ops/rebase/rebase-lifecycle-step.ts`,
`packages/git/src/ops/core/journal-input.ts`, `tests/rebase.test.ts`.

<!-- Origin: sprint-2026-09-23 simplification, WU6 run-log entry. -->
