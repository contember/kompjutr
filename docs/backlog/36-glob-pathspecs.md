---
id: 36
title: Add mutating glob pathspecs
blocked-by: []
---

# 36 — Add mutating glob pathspecs

**Summary.** Tier B. Read-only `lsFiles()` selection is complete for the current
builder workload. Mutating commands still accept only exact paths and directory
prefixes, and no current caller needs glob-shaped mutations.

## Problem

`matchesPaths()` in `src/core/ops/checkout.ts` remains the exact/prefix matcher
for add, rm, reset, checkout, clean, diff, and status. Glob-shaped mutations
therefore still fail loudly with `PathspecNotFoundError`.

## Approach / acceptance

- Reuse the existing byte matcher for add, rm, reset, checkout, clean, diff, and
  status without changing their unmatched-path or ignore/force semantics.
- Decide magic per command; continue to reject every unsupported leading-`:`
  form explicitly.
- Add real Git parity and exact cap witnesses for every mutating command adopted.

## Touch points

`src/core/ops/checkout.ts`, `src/core/ops/staging.ts`, `src/core/ops/status.ts`,
`src/core/ops/diff.ts`, `tests/pathspec.test.ts`, `tests/staging.test.ts`,
`tests/status.test.ts`, `docs/reference/git-support.md`

<!-- Read-only tracked/ref globs shipped 2026-08-28; cached/others/exclude-standard selection shipped 2026-08-29. -->
