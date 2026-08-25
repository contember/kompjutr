---
id: 25
title: Add explicit rebase targets and roots
blocked-by: []
---

# 25 — Add explicit rebase targets and roots

**Summary.** Extend the native sequencer with `--onto`, explicit branch, and
root-rebase selection without weakening bounded planning or atomic publication.

## Problem

The current `rebase({ upstream })` contract uses the resolved upstream as both
the history boundary and replay destination, and it only operates on the
checked-out branch. It cannot transplant a selected range onto a different
commit, rebase from the root, or select another local branch.

## Approach / acceptance

- Define typed, mutually exclusive options for `upstream`, `onto`, `root`, and
  an optional branch while preserving the existing call unchanged.
- Separate the selected commit range from the replay destination in the planner
  and authenticate both in the operation journal.
- Define whether an explicitly selected branch must become checked out before
  replay; never mutate an unrelated worktree or publish a stale branch.
- Keep the 4,096-step, retained-byte, SQL, and memory bounds and the single final
  compare-and-set publication.
- Add real Git parity tests for `--onto`, `--root`, explicit branch, no-op,
  fast-forward, conflict, cold reopen, abort, invalid combinations, and stale
  refs.

## Touch points

`src/core/ops/rebase-plan.ts`, `src/core/ops/rebase-lifecycle.ts`,
`src/core/ops/operation-state.ts`, `src/git/client.ts`, `tests/rebase*.test.ts`,
public declarations and reference docs

<!-- Origin: ../archive/sprint-2026-08-25-bounded-rebase-sequencer.md -->
