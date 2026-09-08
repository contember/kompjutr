---
id: 76
title: Bound full-tree construction before serialization allocation
blocked-by: []
---

# 76 — Bound full-tree construction before serialization allocation

**Summary.** Enforce real retained-state and object-size limits while constructing
commit trees, before oversized buffers are allocated.

## Problem and evidence

Ordinary full commit construction consumes a paged index but retains a growing
`TreeEntry[]` for each open directory. Serialization copies/sorts entries, builds
byte parts, and concatenates them before the object sink checks its 48 MiB limit.
The existing `serializedBytes` check guards integer overflow, not object size.
The ordinary full commit path does not invoke the separate 10,000-entry preflight.

This allocation ordering was independently verified from the public commit call
chain. A wide valid index needs no direct SQL corruption to reach it. An oversized
tree can allocate extensively before rejection; a near-limit valid tree also
retains wrappers and intermediate buffers. No exact OOM threshold was measured.

## Approach / acceptance

- Track actual serialized size before appending/allocating beyond the object
  format/storage limit, and bound the aggregate open-directory frontier.
- Prefer size-aware streaming or bounded storage along the existing tree-building
  seam. Do not add a total-repository path cap as a substitute.
- Through public staging/commit or supported scratch-index APIs, cover a wide
  directory, long valid names, and nested open frontiers. Near-limit valid trees
  must round-trip; oversized trees must fail before allocating the complete
  oversized representation and without moving HEAD.
- Measure retained high-water under the benchmark rules; paged input alone is
  not acceptance. Preserve sorted tree encoding and subtree reuse.

## Touch points

- `packages/git/src/ops/repository/commit.ts`.
- `packages/git/src/ops/tree/tree-build-full.ts`, `tree-build-common.ts`.
- `packages/git/src/common/trees.ts`.
- `packages/git/src/store/objects/objects-batch.ts`.
- `tests/commit.test.ts`, `tests/tree-build-preflight.test.ts`, `bench/`.
