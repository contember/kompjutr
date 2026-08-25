---
id: 39
title: Complete the plumbing read surface
blocked-by: []
---

# 39 — Complete the plumbing read surface

**Summary.** Tier A. The plumbing commands tooling builds on are either
one-level, type-blind, or absent.

## Problem

In `src/core/ops/reads.ts` and `src/core/ops/plumbing.ts`:

- `lsTree()` reads one tree level; there is no `-r`, so walking a tree means one
  call per directory — exactly the scalar pattern the cost model exists to avoid.
- `catFile()` returns `{ oid, bytes }`; there is no `-t` or `-s`, so a caller must
  materialise a blob to learn its type or size.
- `updateRef()` can create and overwrite but not delete, and takes no expected
  old value, so a compare-and-set ref update is impossible.
- `hashObject()` writes blobs only.
- There is no public ref enumeration (`for-each-ref`), commit enumeration
  (`rev-list`) or `merge-base`, although bounded implementations of the last two
  exist internally for merge and rebase.

## Approach / acceptance

- Add recursive `lsTree` over the existing bounded recursive tree cursor, with
  the tree-only and blob-only filters Git offers, inside the traversal budget.
- Return type and size from `catFile` without reading content when the object
  store already knows them.
- Add ref deletion and an expected-old-value guard to `updateRef`.
- Export bounded `forEachRef`, `revList` and `mergeBase` reads built on the
  existing validated walks; each must fail closed on its own limits rather than
  degrading.
- Real Git parity tests per command, including deep trees, submodule gitlinks,
  missing objects, a stale compare-and-set, and every bound.

## Touch points

`src/core/ops/reads.ts`, `src/core/ops/plumbing.ts`, `src/core/ops/merge-base.ts`,
`src/git/client.ts`, `src/compat/computer/client.ts`, `tests/reads.test.ts`,
`docs/reference/git-support.md`
