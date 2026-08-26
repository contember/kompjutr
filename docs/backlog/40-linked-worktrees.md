---
id: 40
title: Support linked worktrees over one repository
blocked-by: []
---

# 40 — Support linked worktrees over one repository

**Summary.** Tier A. Every table is keyed by `repo_id`, so a second checkout of
one repository is a second object store. `git worktree` has no representation.

## Problem

`src/sqlite/schema.ts` models a repository as `git_repositories (id, root,
head)` — one root path, one HEAD. Everything else hangs off that single id:
`git_objects`, `git_refs`, `git_config`, `git_shallow`, `git_index`,
`git_index_state`, `git_index_dirty`, `git_operation_state`.

`init({ dir })` can therefore create a second repository over the same
workspace, but it shares nothing with the first: separate refs, separate
objects, separate config. That is a second clone, not a worktree.

The consequence is structural, not cosmetic. A caller that wants N isolated
checkouts of one repository — the shape the [reference
workload](../reference/git-support.md#the-reference-workload) uses, one worktree
per session over a single clone — pays for N copies of the object store, and
cannot share a ref namespace between them at all. It also needs `worktree add`
with and without a start point, `worktree remove --force`, `worktree prune`,
`worktree repair` after the workspace moves, and `worktree unlock`.

## Approach / acceptance

- Split the repository row into a **store** (objects, refs, config, shallow —
  shared) and a **checkout** (root, HEAD, index, index state, dirty set,
  operation state — per worktree), and migrate existing rows. A repository with
  one checkout must be byte-identical in behaviour to today.
- Add `worktreeAdd`, `worktreeList`, `worktreeRemove` and `worktreePrune`, with
  a bounded worktree count and Git's exclusivity rule: a branch checked out in
  one worktree cannot be checked out in another (`EBRANCHINUSE` or equivalent
  stable code).
- Keep operation state per checkout. A rebase suspended in one worktree must be
  invisible to the others and must still survive a cold reopen, including when
  the reopen lands on a different checkout first.
- Removal is bounded and fails closed: a worktree with a live operation, or one
  whose removal would exceed the statement budget, throws rather than
  half-removing. `prune` only drops rows whose root is provably gone.
- Real Git parity tests: add with and without a start point; add on a branch
  already checked out elsewhere; remove clean, remove dirty, remove `--force`;
  prune after the directory disappears; a conflict resolved in one worktree
  while another stays clean; and a cold reopen mid-rebase in a non-primary
  checkout.
- Write an ADR for the store/checkout split — it changes the central identity
  of the schema and will outlive this item.

## Touch points

`src/sqlite/schema.ts`, `src/sqlite/store.ts`, `src/core/repository.ts`,
`src/core/context.ts`, `src/core/ops/init.ts`, `src/core/ops/operation-state.ts`,
`src/git/client.ts`, `tests/workspace.test.ts`, `tests/schema.test.ts`,
`docs/decisions/`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
