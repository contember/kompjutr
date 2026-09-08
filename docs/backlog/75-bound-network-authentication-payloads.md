---
id: 75
title: Bound payload lifetime during network object validation
blocked-by: []
---

# 75 — Bound payload lifetime during network object validation

**Summary.** Keep valid tag and shallow-history validation from retaining full
payloads across otherwise bounded read batches.

## Problem and evidence

`readTagObjects()` accumulates all results in one map before processing the
frontier. Annotated tags pointing to distinct large blobs put those blobs in a
later frontier. Lightweight blob tags alone do not trigger that peeling path.

`authenticateCommitGraphThroughBoundary()` retains full parsed commits, including
messages, throughout traversal. Negotiation and graph cardinality limits exist,
but they do not provide a practical aggregate payload bound with individually
valid objects up to the object-size ceiling.

These are independently verified retention mechanisms for correctly used network
APIs and format-valid, unusual data. No target-runtime OOM or memory benchmark was
run. Mapped-root validation already demonstrates a useful twin: discard each
payload batch and retain only compact types.

## Approach / acceptance

- Process tag payload batches before loading the next; retain only the metadata
  needed to follow targets and detect cycles.
- Keep compact ancestry state rather than complete commit messages for shallow
  traversal. Preserve all required parsing and network-boundary checks.
- Add valid large annotated-tag/blob and long-message history fixtures. Observe
  live payload retention across batches, then measure operation high-water under
  the [benchmark rules](../../bench/CLAUDE.md).
- Preserve shallow/deepen/unshallow and tag semantics. Do not lower arbitrary
  counts or add projected-work admission to manufacture a bound.

## Touch points

- `packages/git/src/ops/network/network-tags.ts`.
- `packages/git/src/ops/repository/repository-walk.ts`.
- `packages/git/src/ops/network/network-fetch-mapped.ts` — bounded twin.
- `tests/network-safety.test.ts`, `tests/fetch-refspec.test.ts`, `bench/`.
