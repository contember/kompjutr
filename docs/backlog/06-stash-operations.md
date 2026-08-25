---
id: 06
title: Implement stash operations
blocked-by: []
---

# 06 — Implement stash operations

**Summary.** Replace the `stashPush`, `stashList`, and `stashPop` stubs with
native, recoverable snapshots of index and worktree changes.

## Problem

All stash methods are unsupported-operation stubs. Callers cannot temporarily
clear changes before checkout or pull, and a safe pop needs the same conflict
machinery as a three-way merge. The authenticated operation-step journal is
available for bounded sequencing and recovery.

## Approach / acceptance

- Store Git-compatible stash commits and update the stash ref without requiring
  an external filesystem.
- Preserve staged and unstaged tracked changes separately; define untracked-file
  support explicitly in the public options.
- Restore a stash through the merge engine. Keep the stash entry when pop
  conflicts or fails, and record standard conflict stages.
- Make push and pop atomic across refs, index, and worktree.
- Add real Git parity tests for clean, staged, unstaged, mixed, empty, listed,
  conflicted, and repeated stash operations.

## Touch points

`src/core/ops/`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`src/sqlite/store.ts`, `tests/`
