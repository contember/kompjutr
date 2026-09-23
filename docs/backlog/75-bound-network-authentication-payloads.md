---
id: 75
title: Bound payload lifetime during shallow-history validation
blocked-by: []
---

# 75 — Bound payload lifetime during shallow-history validation

**Summary.** Keep valid shallow-history validation from retaining full commit
payloads across otherwise bounded read batches.

## Problem and evidence

`authenticateCommitGraphThroughBoundary()` retains full parsed commits, including
messages, throughout traversal. Negotiation and graph cardinality limits exist,
but they do not provide a practical aggregate payload bound with individually
valid objects up to the object-size ceiling.

This is an independently verified retention mechanism for correctly used network
APIs and format-valid, unusual data. No target-runtime OOM or memory benchmark was
run. Tag peeling already demonstrates a useful twin: it takes types from stored
metadata and reads only tag bodies, so a tag's large blob target is never loaded.

## Approach / acceptance

- Keep compact ancestry state rather than complete commit messages for shallow
  traversal. Preserve all required parsing and network-boundary checks.
- Add a valid long-message history fixture. Observe live payload retention
  across batches, then measure operation high-water under the
  [benchmark rules](../../bench/CLAUDE.md).
- Preserve shallow/deepen/unshallow semantics. Do not lower arbitrary counts or
  add projected-work admission to manufacture a bound.

## Touch points

- `packages/git/src/ops/repository/repository-walk.ts`.
- `packages/git/src/ops/network/network-shallow.ts`.
- `tests/network-safety.test.ts`, `bench/`.
