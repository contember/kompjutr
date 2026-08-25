---
id: 35
title: Add a staged diff mode
blocked-by: []
---

# 35 — Add a staged diff mode

**Summary.** Tier A (missing capability). There is no `git diff --cached`, so
what is about to be committed cannot be inspected.

## Problem

`DiffOptions` (`src/core/ops/diff-internal.ts`) offers `ref` and `to` only, and
`collect()` in `src/core/ops/diff.ts` builds either a tree-to-tree comparison or
a tree-to-working-tree one. The index is read as a hashing shortcut for the
working-tree side, never as an endpoint of its own. A caller that stages
selectively cannot see the staged result, which is the standard review step
before `commit()`.

## Approach / acceptance

- Add an explicit staged mode comparing the stage-0 index with `ref` (default
  HEAD), and support it in both `diff()` and `diffSummary()`.
- Reuse the existing merge-join: the index scan is already path-ordered, so the
  tree/index join is the same shape as the current tree/tree join, with no extra
  working-tree traversal and no new SQL statement class.
- Refuse the mode while unmerged stages exist, or define the conflict rendering
  explicitly; do not silently show stage 0.
- Real Git parity tests for staged add, staged delete, staged modification,
  staged mode change, staged-plus-unstaged on one path, and a path filter.

## Touch points

`src/core/ops/diff.ts`, `src/core/ops/diff-internal.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/diff.test.ts`,
`docs/reference/git-support.md`
