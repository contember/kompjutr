---
id: 36
title: Support glob pathspecs
blocked-by: []
---

# 36 — Support glob pathspecs

**Summary.** Tier A (missing capability). Every pathspec is an exact path or a
directory prefix, so `add("*.ts")` matches nothing.

## Problem

`matchesPaths()` in `src/core/ops/checkout.ts` is the single pathspec matcher
for add, rm, reset, checkout, clean, diff and status. It accepts an exact string
match or a directory prefix; there is no wildcard, no `**`, and no `:(exclude)`
magic. An unmatched pathspec throws `PathspecNotFoundError`, so the failure is
loud — but every glob-shaped call fails.

The machinery already exists elsewhere: `src/core/ignore*` compiles Git wildmatch
patterns to byte-oriented deterministic matchers with explicit caps, checked
against real Git.

## Approach / acceptance

- Reuse the ignore engine's compiled matcher for pathspecs; do not write a second
  pattern implementation.
- Keep the prefix fast path. A literal pathspec must still bound the underlying
  scan; a glob loses that bound, so it needs its own explicit row and byte caps
  that fail closed rather than degrading into a full traversal.
- Decide whether `:(exclude)` and `:(icase)` magic are in scope and state it in
  the public option types; reject unsupported magic explicitly.
- Real Git parity tests per command for `*.ext`, `dir/**`, a leading-slash
  anchored pattern, a pattern matching nothing, a pattern matching an ignored
  file with and without `force`, and the cap fallback.

## Touch points

`src/core/ops/checkout.ts`, `src/core/ops/staging.ts`, `src/core/ops/status.ts`,
`src/core/ops/diff.ts`, `src/core/ignore/`, `tests/staging.test.ts`,
`tests/status.test.ts`, `docs/reference/git-support.md`
