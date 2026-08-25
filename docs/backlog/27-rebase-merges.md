---
id: 27
title: Replay merge topology during rebase
blocked-by: []
---

# 27 — Replay merge topology during rebase

**Summary.** Extend rebase from one linear chain to a bounded authenticated
topology equivalent to Git's `--rebase-merges` mode.

## Problem

The planner rejects a selected merge commit with `EUNSUPPORTED`. Flattening it
would silently lose topology, while replaying it requires more than the current
one-parent ordered step sequence: rewritten labels, multiple parents, merge
steps, and their recovery state must all be authenticated.

## Approach / acceptance

- Define a bounded topology plan with explicit labels, rewritten parent edges,
  picks, and merge steps. Reject unsupported topology before mutation.
- Extend journal validation so every referenced label and parent resolves to an
  authenticated original or earlier rewritten result.
- Reuse the merge engine for merge steps and preserve restart-safe conflict,
  continue, skip, and abort semantics.
- Keep all graph, step, retained-byte, SQL, and memory limits explicit and fail
  closed when the topology cannot fit.
- Add real Git parity tests for nested and cousin merges, merge conflicts at each
  position, empty merges, cold reopen, abort, corruption, and exact limits.

## Touch points

`src/core/ops/rebase-plan.ts`, `src/core/ops/rebase-lifecycle.ts`,
`src/core/ops/operation-state.ts`, `src/core/ops/merge-apply.ts`,
`src/sqlite/schema.ts`, `src/sqlite/store.ts`, `tests/rebase*.test.ts`, reference
docs

<!-- Origin: ../archive/sprint-2026-08-25-bounded-rebase-sequencer.md -->
