---
id: 14
title: Implement cherry-pick and revert
blocked-by: [./02-three-way-integration-engine.md]
---

# 14 — Implement cherry-pick and revert

**Summary.** Replay or invert one commit through the shared three-way conflict
engine without adding a second patch application model.

## Problem

The public API has no cherry-pick or revert operation. Both require commit-parent
selection, a three-way tree application, conflict state, and safe continue or
abort behaviour that should build on merge rather than duplicate it.

## Approach / acceptance

- Add typed start, continue, and abort APIs for cherry-pick and revert.
- Apply the selected commit relative to its parent through shared merge
  primitives; require an explicit mainline parent for merge commits.
- Preserve author and message semantics for cherry-pick and create Git-compatible
  revert messages while assigning a new committer identity.
- Persist enough operation state to survive a Durable Object restart. Ref, index,
  and worktree changes must be atomic at every transition.
- Add real Git parity tests for clean, empty, conflicted, merge-commit, continue,
  skip where applicable, abort, and interrupted operations.

## Touch points

`src/core/ops/`, `src/git/client.ts`, `src/compat/computer/client.ts`,
operation-state storage, `tests/`
