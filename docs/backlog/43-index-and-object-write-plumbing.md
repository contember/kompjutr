---
id: 43
title: Add index and object write plumbing
blocked-by: []
---

# 43 — Add index and object write plumbing

**Summary.** Tier A. A tree or a commit can only be built by going through the
working tree and the one repository index. There is no `read-tree`,
`write-tree`, `commit-tree`, and no detached index.

## Problem

`src/core/ops/plumbing.ts` exposes `hashObject()` (blobs only) and
`updateRef()`. Tree and commit construction is not on the surface at all,
although `src/core/ops/tree-build.ts` already builds trees from index rows
internally for every commit.

The index is equally fixed: `git_index` is keyed by `repo_id`, `add()` always
stages from the working tree into it, and `commit()` always commits it. Git's
`GIT_INDEX_FILE` escape hatch — compose a tree against a throwaway index without
disturbing what the user is doing — has no equivalent.

So an operation like "capture the current working tree as a commit without
touching the caller's staged state" cannot be expressed. That is the shape the
[reference workload](../reference/git-support.md#the-reference-workload) runs
after every agent turn (`read-tree HEAD`, `add -A`, `write-tree`, `commit-tree`
against a scratch index), and it is what makes uncommitted work recoverable
there.

## Approach / acceptance

- Add a named scratch index scoped to the repository — a bounded row set, not a
  file — created and dropped within one operation, with a cap on how many may
  exist at once. The repository index must be provably untouched afterwards.
- Add `readTree` (populate an index from a tree; optionally `-u`, writing the
  working tree too), `writeTree` (build and store a tree from an index) and
  `commitTree` (a commit from a tree with explicit parents and identity) over
  the existing bounded tree builder.
- `writeTree` refuses an index carrying unmerged stages, as Git does. Every
  ordering goes through `comparePaths`; nothing sorts by JavaScript strings.
- All three stay inside the operation statement and byte budgets and fail closed
  past them, with the same stable codes the commit path already uses.
- Real Git parity tests on oid equality against real Git: a nested tree, a tree
  with a symlink and a gitlink, an empty tree, an unmerged index (refused), a
  commit with zero, one and two parents, and a scratch-index round trip that
  leaves both the repository index and the working tree unchanged.

## Touch points

`src/core/ops/plumbing.ts`, `src/core/ops/tree-build.ts`,
`src/core/ops/staging.ts`, `src/core/ops/commit.ts`, `src/sqlite/schema.ts`,
`src/sqlite/store.ts`, `src/git/client.ts`, `tests/staging.test.ts`,
`tests/reads.test.ts`, `tests/git-upstream-parity.test.ts`,
`docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
