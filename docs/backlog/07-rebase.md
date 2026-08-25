---
id: 07
title: Implement rebase
blocked-by: [./24-operation-step-journal.md]
---

# 07 — Implement rebase

**Summary.** Add bounded commit replay with explicit continue and abort state.

## Problem

Rebase is absent from the public API. Implementing it safely requires ancestry
selection, patch replay, conflict stages, temporary state, and atomic ref updates;
these should reuse merge primitives rather than introduce a second conflict
engine.

## Approach / acceptance

- Add a typed public API for starting, continuing, and aborting a non-interactive
  rebase.
- Select the replay range through bounded graph traversal and preserve commit
  order, authorship, messages, and empty-commit semantics.
- Replay each commit through shared three-way machinery and persist enough state
  to resume after a Durable Object restart.
- Update the branch only after successful replay; abort must restore its original
  ref, index, and worktree safely.
- Add real Git parity tests for linear replay, no-op, conflicts, continue, skip,
  abort, shallow history, and interrupted execution.

## Touch points

`src/core/ops/`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`src/sqlite/schema.ts`, `src/sqlite/store.ts`, `tests/`
