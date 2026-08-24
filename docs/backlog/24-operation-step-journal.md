---
id: 24
title: Add an operation step table before rebase and stash extend the journal
blocked-by: []
---

# 24 — Add an operation step table before rebase and stash extend the journal

**Summary.** `git_operation_state` models one integration as one wide row with
a `CHECK`-encoded state machine. Rebase and stash need an ordered sequence of
steps; give the journal a step table now rather than more nullable columns.

## Problem

`git_operation_state` (`src/sqlite/schema.ts`) holds merge, cherry-pick, and
revert in 22 columns, with a `CHECK` that spells out which columns each `kind`
and `phase` may fill. That is a reasonable encoding for one-shot operations and
keeps "one operation per repository" free via the `repo_id` primary key.

Backlog 07 (rebase) needs a todo list: N commits to replay in order, a cursor,
per-step outcomes, and the ability to continue, skip, or abort at any step.
Backlog 06 (stash) needs at least a stack of saved states. Neither fits a single
row. Adding `step_ordinal`, `remaining_oids`, or similar to the existing table
would grow the `CHECK` past what anyone can read and push per-step data into
JSON columns that the read side would then have to validate per row.

## Approach / acceptance

- Add `git_operation_steps (repo_id, ordinal, source_oid, outcome, result_oid,
  …)` keyed `(repo_id, ordinal)`, with `outcome` constrained to a small set and
  a `CHECK` tying `result_oid` to `outcome`. Keep `git_operation_state` as the
  header: `kind`, `phase`, original HEAD, labels, identity, budgets, and
  `integrity_oid` extended to cover the step rows.
- Model cherry-pick and revert as a one-step sequence so the two shapes do not
  diverge; the existing `kind IN ('merge','cherry-pick','revert')` branch of the
  `CHECK` shrinks accordingly.
- Bound the step count and the bytes retained per operation, and fail closed
  with a stable error code when exceeded (invariant 5).
- Migrate the v10 journal in place; an active cherry-pick or revert becomes a
  one-step sequence.

Acceptance: `tests/operation-state.test.ts` covers header/step integrity
binding, continue/skip/abort over a multi-step sequence, budget rejection, and
the v10 → v11 migration of an active operation. Backlog 06 and 07 list this item
in `blocked-by` once it is scheduled.

## Touch points

`src/sqlite/schema.ts`, `src/sqlite/store.ts`, `src/core/ops/operation-state.ts`,
`src/core/ops/replay.ts`, `src/core/ops/merge-state.ts`, migrations,
`tests/operation-state.test.ts`, `tests/merge-state.test.ts`

<!-- Origin: git schema architecture review, 2026-08-24. Related: ./06-stash-operations.md, ./07-rebase.md -->
