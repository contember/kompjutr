---
id: 16
title: Verify concurrent and interrupted operations
blocked-by: []
---

# 16 — Verify concurrent and interrupted operations

**Summary.** Define and test repository behaviour when asynchronous operations
interleave or a Durable Object restarts at a mutation boundary.

## Problem

Network operations cross asynchronous boundaries and pack ingestion can yield.
Individual transactions and provisional packs have crash-safety rules, but there
is no systematic conformance suite for overlapping fetch, push, checkout, commit,
maintenance, and future integration operations.

## Approach / acceptance

- Enumerate shared mutable state and define which operation pairs may interleave,
  serialize, reject, or observe a generation change.
- Add deterministic barriers around discovery, pack staging, ref publication,
  worktree mutation, and operation-state transitions.
- Test relevant operation pairs in both orders and reopen the same SQLite state at
  every durable boundary.
- Introduce a repository operation epoch or lock only where tests prove existing
  transactional checks are insufficient; stale owners must be recoverable.
- Assert visible refs always resolve, index/worktree state matches its published
  generation, and incomplete storage remains reclaimable.

## Touch points

`src/core/context.ts`, `src/core/ops/`, `src/sqlite/store.ts`, `src/sqlite/packs.ts`,
test storage and transport barriers, `tests/`
