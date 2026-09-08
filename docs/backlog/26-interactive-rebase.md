---
id: 26
title: Add programmable interactive rebase
blocked-by: []
---

# 26 — Add programmable interactive rebase

**Summary.** Add a durable typed rebase todo surface for reorder, edit, reword,
squash, fixup, drop, and autosquash workflows.

## Problem

The sequencer persists one fixed oldest-first list of `pick` steps. Callers
cannot review or alter that list, combine commits, pause for amendment, or derive
fixup ordering from commit subjects. A callback or external editor cannot be the
source of truth because it would not survive a Durable Object restart.

## Approach / acceptance

- Define a bounded serializable todo model and validate the complete edited plan
  before it becomes active journal state.
- Support reorder, pick, edit, reword, squash, fixup, and drop with stable
  validation errors for invalid parent, message, and sequence combinations.
- Add autosquash as a deterministic planner transform. Treat `exec` as a
  separate command-runtime decision; do not pretend an in-memory callback is
  restart-safe.
- Preserve one final branch publication and make every pause resumable after a
  cold reopen.
- Add real Git parity tests for commit trees, parents, authors, messages, empty
  outcomes, conflicts, abort, and exact plan limits.

## Touch points

`packages/git/src/ops/rebase/rebase-plan.ts`, `packages/git/src/ops/rebase/rebase-lifecycle.ts`,
`packages/git/src/ops/core/operation-state.ts`, `packages/git/src/store/`, `packages/git/src/client.ts`,
`tests/rebase*.test.ts`, public declarations and reference docs

<!-- Origin: ../archive/sprint-2026-08-25-bounded-rebase-sequencer.md -->
