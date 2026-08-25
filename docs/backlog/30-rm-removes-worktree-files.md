---
id: 30
title: Remove working-tree files in `rm`
blocked-by: []
---

# 30 — Remove working-tree files in `rm`

**Summary.** Tier S (silent divergence). `rm()` only clears index rows, so a
caller that asks Git to delete a file keeps the file on disk.

## Problem

`rm(repo, _worktree, options)` in `src/core/ops/staging.ts` never touches the
working tree — the `worktree` parameter is unused and the body only calls
`indexApply(sink.remove)`. The result is `git rm --cached`, but the method is
named and documented as `rm`. Nothing warns the caller; a subsequent `status()`
reports the path as untracked and a subsequent `add()` brings it straight back.

Real Git also refuses to remove a path whose working-tree or index content
differs from HEAD unless `-f` is given. kompjutr has no such check, so the
safety behaviour is missing in both directions.

## Approach / acceptance

- Delete the matched working-tree entries in the same `transactionSync()` as the
  index removal, using the bounded bulk filesystem API rather than per-path calls.
- Add explicit `cached` (index only, today's behaviour), `force`, and `recursive`
  options. A native directory pathspec without `recursive` must fail as Git does;
  the compatibility facade preserves its current implicit recursion explicitly.
  Without `force`, refuse a path that differs from HEAD or from the index with a
  stable error, as Git does.
- Prune directories that become empty, matching Git's behaviour for a recursive
  removal, and keep the retained-state cap already enforced by `ADD_RETAINED_BYTES`.
- Real Git parity tests: clean removal, `--cached`, staged-but-different,
  worktree-modified, directory pathspec with and without recursion, a directory
  retaining an untracked file, nested repository boundary, and a pathspec that
  matches nothing.

## Touch points

`src/core/ops/staging.ts`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`tests/staging.test.ts`, `tests/client.test.ts`, `docs/reference/git-support.md`
