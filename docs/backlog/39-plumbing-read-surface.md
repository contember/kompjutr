---
id: 39
title: Complete the plumbing read surface
blocked-by: []
---

# 39 — Complete the plumbing read surface

**Summary.** Tier A. The plumbing commands tooling builds on are either
one-level, type-blind, or absent. Three of them are on the orchestrator's
checkpoint path and go first; the rest waits for a caller.

## Problem

In `src/core/ops/reads.ts` and `src/core/ops/plumbing.ts`:

- `updateRef()` can create and overwrite but not delete, and takes no expected
  old value, so a compare-and-set ref update is impossible. The store already
  has the seam (`updateRefExpected` in `src/sqlite/store.ts`); it is not
  exposed.
- There is no public `merge-base`, although a bounded implementation exists
  internally for merge and rebase.
- `lsTree()` reads one tree level; there is no `-r`, so walking a tree means one
  call per directory — exactly the scalar pattern the cost model exists to avoid.
- `catFile()` returns `{ oid, bytes }`; there is no `-t` or `-s`, so a caller must
  materialise a blob to learn its type or size.
- `hashObject()` writes blobs only.
- There is no public ref enumeration (`for-each-ref`) or commit enumeration
  (`rev-list`).

## Approach / acceptance

**Required subset — the orchestrator issues these:**

- `updateRef`: an expected-old-value guard and deletion, over the existing
  store seam. A stale expectation is a stable error, never a silent overwrite.
  The workload publishes a rebased tip with `update-ref <ref> <new> <old>` and
  rolls it back the same way.
- `mergeBase`: export the bounded internal walk merge and rebase already use.
- Recursive `lsTree` with modes, over the existing bounded recursive tree
  cursor, inside the traversal budget. The workload scans a snapshot for
  gitlink entries (`160000`) before replaying it.
- Real Git parity for each: a stale compare-and-set, deletion of a missing ref,
  `merge-base` on diverged and unrelated histories, a deep tree with gitlinks.

**Rest — no caller yet:**

- Type and size from `catFile` without reading content when the object store
  already knows them.
- Tree-only and blob-only `lsTree` filters.
- Bounded `forEachRef` and `revList` reads built on the existing validated
  walks; each fails closed on its own limits rather than degrading.
- Real Git parity per command, including missing objects and every bound.

## Touch points

`src/core/ops/reads.ts`, `src/core/ops/plumbing.ts`, `src/core/ops/merge-base.ts`,
`src/sqlite/store.ts`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`tests/reads.test.ts`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage; split 2026-08-28 by consumer demand -->
