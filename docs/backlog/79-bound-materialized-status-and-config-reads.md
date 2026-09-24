---
id: 79
title: Read scalar config values with one row
blocked-by: []
---

# 79 — Read scalar config values with one row

**Summary.** Make a scalar config lookup independent of the values it does not
return.

## Problem and evidence

Scalar config lookup calls `getAll()` and selects the last value. Public
`configSet({ append: true })` can grow that history without an aggregate bound.
The same store already has a descending `LIMIT 1` scalar implementation.
Statically verified; no invalid input or direct SQL mutation is needed.

The eager-status result cap this item also carried was dropped in the
2026-09-24 backlog review: Git does not cap `status` output, and streaming
already serves large results.

## Approach / acceptance

- Reuse the single-row query for scalar config lookup. Collection-returning
  config behavior keeps its own contract.
- A scalar read after many valid appends returns the last value and reads one
  result row, including after reopen.

## Touch points

- `packages/git/src/store/refs/config.ts`.
- `packages/git/src/ops/refs/config.ts`.
- `tests/refs.test.ts`.
