---
id: 62
title: Reuse unchanged HEAD subtrees when commit builds its tree
blocked-by: []
---

# 62 — Reuse unchanged HEAD subtrees when commit builds its tree

**Summary.** Effort M–L. Every commit re-serialises and re-hashes every tree
object of the whole index. The sealed index tracker knows which paths changed
since HEAD, which is the cache-tree Git uses to skip the rest.

## Problem

`writeCommitObjects` (`src/core/ops/commit.ts:156`) streams the entire index
through `buildTreeInBatch` (`src/core/ops/tree-build.ts:244`): 24,252 rows in
12 pages, then one serialisation and one SHA-1 per tree object. `#flushObjects`
(`src/sqlite/store.ts:3672`) dedupes the writes in SQL with
`ON CONFLICT DO NOTHING`, so statements stay bounded and the cost is CPU
proportional to the index. [`benchmark-current.md`](../reference/benchmark-current.md):
`git.commit — 100` takes 496 ms, 31 SQL, 24,301 rows for a 100-file change.

Git's `write-tree` has the same shape and avoids it with the cache-tree index
extension. The tracker offers the equivalent. When it is sealed and its
baseline equals the HEAD tree (the check `src/core/ops/sparse-checkout.ts:70`
already makes), every index path outside `git_index_dirty` equals HEAD's entry:
index inserts, deletes and semantic updates are journaled by triggers
(`src/sqlite/index-tracker.ts:117-127`). A directory with no dirty descendant
therefore has a subtree identical to HEAD's, and its tree oid can be reused
without reading its entries.

## Approach / acceptance

- With a sealed tracker at the HEAD baseline: read the dirty paths (bounded,
  the existing 32,000-row cap), compute their ancestor set, build only those
  directories, and take every other child directory's oid from HEAD's tree
  rows. Fall back to the full build when the tracker is absent, incomplete, at
  another baseline, or over the cap.
- Reads stay bounded: HEAD's entries for the rebuilt directories only, in one
  JSON-array lookup or one lookup per touched directory — never a full tree
  stream.
- The result must be byte-identical to the full build.
- Pairs with [56](56-reseal-index-tracker-on-commit.md): once commit moves the
  baseline, consecutive commits stay on this path.
- **Witness.** Tree oid equality between the fast and the full build across:
  added, deleted, modified, mode-changed and index-renamed paths, an emptied
  directory, a new deep directory, and a root-level change. A tracker whose
  baseline is not HEAD takes the full path. `git.commit (100)` re-measured
  under a CPU lease below 100 ms.

## Touch points

`src/core/ops/commit.ts`, `src/core/ops/tree-build.ts`,
`src/core/context.ts` (`sparseWorkspace.dirtyPaths` already exposes the rows),
`tests/commit.test.ts`, `bench/nextjs-workflow.ts`, `docs/reference/benchmark-current.md`.

<!-- Origin: code review of add/commit/checkout, 2026-08-26; wall-time sibling of 10. -->
