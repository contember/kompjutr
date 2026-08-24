---
id: 19
title: Implement merge operation lifecycle
blocked-by: [./02-three-way-integration-engine.md]
---

# 19 — Implement merge operation lifecycle

**Summary.** Turn the shared integration engine into the public merge operation,
including graph selection, atomic application, conflict recovery, and commits.

## Problem

The integration engine deliberately does not choose commits or mutate repository
state. `Git.merge()` remains an unsupported-operation stub until an orchestration
layer finds merge bases, handles trivial histories, applies the result, persists
conflict state, and creates a two-parent commit.

## Approach / acceptance

- Implement bounded ancestry and merge-base traversal, including unrelated and
  multiple-base histories, shallow boundaries, and corruption validation.
- Handle already-merged and fast-forward histories without invoking a content
  merge. Preserve dirty and untracked worktree safety.
- Apply a clean integration plan atomically to the index and worktree, update the
  branch, and create a two-parent merge commit when requested.
- Persist unresolved stages and enough operation state to continue or abort after
  a Durable Object restart. Abort must restore the original ref, index, and
  worktree without discarding unrelated changes.
- Add typed merge, continue, and abort APIs with stable errors for detached HEAD,
  unmerged state, unsafe worktrees, missing history, and exceeded limits.
- Cover fast-forward, already-merged, clean, conflicted, no-commit, continue,
  abort, restart, and multi-base histories with real Git parity tests and SQL and
  memory gates.

## Touch points

`src/core/ops/`, `src/core/repository.ts`, `src/sqlite/schema.ts`,
`src/sqlite/store.ts`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`tests/`
