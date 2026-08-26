---
id: 44
title: Add patch interchange — apply, and appliable diff output
blocked-by: []
---

# 44 — Add patch interchange — apply, and appliable diff output

**Summary.** Tier A. kompjutr writes patches nobody can apply, and cannot read
one at all.

## Problem

`src/core/ops/diff.ts` emits `diff --git` text, but two things make that text
one-way:

- no `--binary` — a binary change becomes the literal line `Binary files a/… and
  b/… differ`, which carries no content;
- no `--full-index` — the `index` line stays abbreviated, so a three-way apply on
  the other side has no blob oid to resolve against.

And there is no `apply` at all: no patch parser, no application. The three-way
engine exists and is well tested (`src/core/ops/merge-apply.ts`,
[ADR-0003](../decisions/0003-port-xdiff-text-merge.md)), but it only ever runs
over trees, never over a patch.

The pair is what makes a change portable between two repositories that do not
share history. The [reference
workload](../reference/git-support.md#the-reference-workload) moves uncommitted
work onto a rebased tip with exactly `diff --binary --full-index A B` followed by
`apply --3way --cached`, and neither half exists here.

## Approach / acceptance

- Add `--full-index` and binary hunks (Git's literal/delta base85 form) to the
  patch writer. Acceptance is external: a patch kompjutr emits must apply
  cleanly with real `git apply`.
- Add a bounded patch parser and `apply()`, with a three-way mode and an
  index-only mode, reusing the existing three-way merge. A conflict writes index
  stages 1–3 exactly as `merge()` does, so conflict resolution has one shape.
- Bound patch bytes, file count and hunk count explicitly. A patch past a limit
  is refused with a stable code before anything is written — never partially
  applied.
- Reject what cannot be represented rather than guessing: a `Subproject commit`
  hunk (gitlink) has no three-way meaning here and must fail closed with its own
  code, not surface as a bogus conflict.
- Real Git parity tests in both directions: kompjutr patch → real `git apply`
  (text, binary, rename, mode change, new file, deleted file); real `git diff`
  output → `apply()`; a three-way apply that resolves; one that conflicts; and
  each bound.

## Touch points

`src/core/ops/diff.ts`, `src/core/ops/diff-internal.ts`,
`src/core/ops/merge-apply.ts`, a new `src/core/ops/apply.ts`,
`src/git/client.ts`, `tests/diff.test.ts`, `tests/merge-apply.test.ts`,
`tests/git-upstream-parity.test.ts`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
