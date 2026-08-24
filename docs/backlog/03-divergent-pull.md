---
id: 03
title: Complete divergent pull
blocked-by: []
---

# 03 — Complete divergent pull

**Summary.** Extend pull beyond fast-forward histories by composing fetch with
the native merge engine.

## Problem

The first pull implementation deliberately rejects divergent histories. A full
pull needs merge semantics, conflict state, and multi-parent commit support that
do not exist until the merge backlog item ships.

## Approach / acceptance

- Reuse the upstream resolution, fetch, and safety checks from fast-forward pull.
- Integrate a divergent remote tip through the merge operation without
  duplicating graph or worktree logic.
- Respect an explicit fast-forward-only option and supported pull configuration.
- Preserve fetched objects and refs when integration conflicts, while leaving a
  recoverable merge state.
- Add real Git parity tests for divergent clean merges, conflicts, no-commit
  behaviour, and fast-forward-only rejection.

## Touch points

`src/git/client.ts`, `src/compat/computer/client.ts`, `src/core/ops/network.ts`,
merge operation modules, `tests/`
