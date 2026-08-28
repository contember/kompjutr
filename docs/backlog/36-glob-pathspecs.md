---
id: 36
title: Complete ls-files selection and mutating glob pathspecs
blocked-by: []
---

# 36 — Complete ls-files selection and mutating glob pathspecs

**Summary.** Tier A (missing capability). Native `lsFiles({ paths })` now has a
bounded Git-compatible default glob subset for tracked index or ref paths. The
project builder also needs untracked, non-ignored worktree selection; mutating
commands still accept only exact paths and directory prefixes.

## Problem

`lsFiles({ paths })` filters the tracked index, or a selected tree with `{ ref }`,
through the bounded byte matcher. It does not expose Git's `--others` or
`--exclude-standard`, so it cannot yet express the builder's full
`ls-files --cached --others --exclude-standard -- '<dir>/*-<hash>.svg'` call.

`matchesPaths()` in `src/core/ops/checkout.ts` remains the exact/prefix matcher
for add, rm, reset, checkout, clean, diff, and status. Glob-shaped mutations
therefore still fail loudly with `PathspecNotFoundError`.

## Approach / acceptance

**Required in Phase 1 — complete the builder read:**

- Extend native `lsFiles()` with explicit tracked/untracked and standard-ignore
  selection while preserving its tracked-index default.
- Merge bounded index and worktree/ignore cursors in Git byte order, deduplicate
  paths, apply the existing read-only pathspec compiler, and fail closed on row,
  work, statement, and retained-result limits.
- Match real Git for the builder's combined flags and glob, including tracked,
  untracked, ignored, nested, empty, and exact-bound cases.

**Rest — no caller yet:**

- Reuse the existing byte matcher for add, rm, reset, checkout, clean, diff, and
  status without changing their unmatched-path or ignore/force semantics.
- Decide magic per command; continue to reject every unsupported leading-`:`
  form explicitly.
- Add real Git parity and exact cap witnesses for every mutating command adopted.

## Touch points

`src/core/ops/checkout.ts`, `src/core/ops/staging.ts`, `src/core/ops/status.ts`,
`src/core/ops/diff.ts`, `src/core/ops/worktree-io.ts`, `src/core/ignore/`,
`src/git/client.ts`, `tests/pathspec.test.ts`, `tests/staging.test.ts`,
`tests/status.test.ts`, `tests/client.test.ts`, `docs/reference/git-support.md`

<!-- Read-only tracked index/ref glob subset shipped 2026-08-28. -->
