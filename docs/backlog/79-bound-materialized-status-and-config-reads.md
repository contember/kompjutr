---
id: 79
title: Bound materialized status and avoid scalar config overreads
blocked-by: []
---

# 79 — Bound materialized status and avoid scalar config overreads

**Summary.** Give eager results an explicit allocation contract and make scalar
configuration reads independent of values they do not return.

## Problem and evidence

Eager status spreads the stream into an array and sorts it. Its options contain
no result limit. An unborn repository with many untracked files can avoid the
tracked-state bound while producing a large result. Returning an array is
intentional; the issue is its missing allocation boundary, not the existence of
an eager API. This is distinct from tracked-path accounting in
[66](66-retire-modeled-retained-byte-charges.md).

Scalar config lookup calls `getAll()` and selects the last value. Public
`configSet({ append: true })` can grow that history without an aggregate bound.
The same store already has a descending `LIMIT 1` scalar implementation.

Both call chains were statically verified. Neither requires invalid inputs or
direct SQL mutation. No large-result OOM or latency measurement was run.

## Approach / acceptance

- Define the eager status result limit or bounded collection contract at the
  public boundary. Preserve streaming for larger output and never truncate
  silently. Cover unborn, tracked, untracked-all, and fallback paths.
- Compare complete in-bound eager results with streamed results; demonstrate a
  clear failure before uncontrolled eager allocation beyond the accepted bound.
- Reuse a single-row query for scalar config lookup. Collection-returning config
  behavior needs its own explicit contract, not an accidental scalar overread.
- A scalar read after many valid appends returns the last value and reads one
  result row, including after reopen.

## Touch points

- `packages/git/src/ops/status/status-core.ts`, `status-rows.ts`.
- `packages/git/src/store/refs/config.ts`.
- `packages/git/src/ops/refs/config.ts`.
- `tests/status.test.ts`, `tests/refs.test.ts`.
