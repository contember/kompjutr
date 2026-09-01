---
id: 35
title: Add a staged diff mode
blocked-by: []
---

# 35 — Add a staged diff mode

**Summary.** WU2 implements the capability; keep this item open until the
Everyday Git shell sprint closes. `git diff --cached` now inspects what is about
to be committed.

## Problem

`DiffOptions` (`src/git/ops/diff-internal.ts`) now offers an explicit `staged`
endpoint. `collect()` in `src/git/ops/diff.ts` merges the selected tree with the
ordered index and rejects conflict stages. The sprint still needs to close and
graduate this item through the normal docs lifecycle.

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

`src/git/ops/diff.ts`, `src/git/ops/diff-internal.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/diff.test.ts`,
`docs/reference/git-support.md`
