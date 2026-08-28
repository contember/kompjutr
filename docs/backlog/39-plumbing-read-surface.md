---
id: 39
title: Complete the remaining plumbing reads
blocked-by: []
---

# 39 — Complete the remaining plumbing reads

**Summary.** Tier A. The checkpoint-critical subset has shipped. Four common
read shapes remain absent, but no current consumer issues them.

## Problem

In `src/core/ops/reads.ts` and `src/core/ops/plumbing.ts`:

- `catFile()` returns `{ oid, bytes }`; there is no `-t` or `-s`, so a caller must
  materialise a blob to learn its type or size.
- `lsTree()` has no tree-only or blob-only result filter.
- There is no public ref enumeration (`for-each-ref`) or commit enumeration
  (`rev-list`).

## Approach / acceptance

- Type and size from `catFile` without reading content when the object store
  already knows them.
- Tree-only and blob-only `lsTree` filters.
- Bounded `forEachRef` and `revList` reads built on the existing validated
  walks; each fails closed on its own limits rather than degrading.
- Real Git parity per command, including missing objects and every bound.

## Touch points

`src/core/ops/reads.ts`, `src/core/ops/plumbing.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/reads.test.ts`,
`docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage; split 2026-08-28 by consumer demand -->
