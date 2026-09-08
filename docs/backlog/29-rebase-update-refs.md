---
id: 29
title: Update dependent refs after rebase
blocked-by: []
---

# 29 — Update dependent refs after rebase

**Summary.** Add a bounded `--update-refs` mode that moves eligible refs to
their rewritten commits with atomic validation and recovery records.

## Problem

Completed rebase publishes only the checked-out branch. Other local branches
that point into the rewritten range remain on the old commits. Updating them
requires an authenticated old-to-new mapping, multi-ref stale checks, and
reflogs so a history rewrite does not remove the recovery path.

## Approach / acceptance

- Capture eligible refs and their expected OIDs before replay and authenticate
  the old-to-new mapping through journal transitions.
- Define exclusions for refs that moved concurrently or are not safe local
  branch targets; never overwrite a stale ref.
- Publish the checked-out branch, eligible dependent refs, and their reflog rows
  in one bounded synchronous transaction after all replay steps complete.
- Keep a completed journal recoverable when any final validation fails.
- Add real Git parity tests for multiple dependent refs, dropped and skipped
  commits, conflicts, cold reopen, stale refs, exclusions, rollback, and exact
  ref-count limits.

## Touch points

`packages/git/src/ops/rebase/rebase-plan.ts`, `packages/git/src/ops/rebase/rebase-lifecycle.ts`,
`packages/git/src/ops/core/operation-state.ts`, `packages/git/src/ops/refs/refs.ts`, `packages/git/src/store/`,
`packages/git/src/client.ts`, `tests/rebase*.test.ts`, reflog tests and reference docs

<!-- Origin: ../archive/sprint-2026-08-25-bounded-rebase-sequencer.md -->
