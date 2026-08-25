---
id: 37
title: Complete history reads — patch output for `show`, path filter for `log`
blocked-by: []
---

# 37 — Complete history reads — patch output for `show`, path filter for `log`

**Summary.** Tier A (missing capability). `show()` cannot show what a commit
changed, and `log()` cannot answer what changed a file.

## Problem

`show()` in `src/core/ops/reads.ts` returns a `CommitView` — oid, message, tree,
parents, identities — and nothing else. `log()` accepts `ref` and `depth` only.
Together these are the two most common history questions ("what did this commit
do", "what touched this file"), and neither can be answered without the caller
re-implementing a tree walk on top of the public surface.

## Approach / acceptance

- Add optional patch output to `show()` by reusing `diff({ ref: parent, to: oid })`
  with the existing patch writer; define the merge-commit rendering explicitly
  (first parent, or a required mainline) rather than defaulting silently.
- Add `paths` to `log()`, filtering each step by a bounded tree comparison against
  the selected parent, with early exit once `depth` is satisfied.
- Add `firstParent` while the walk is being touched; it is the cheap bound that
  makes a path-filtered log affordable on a merge-heavy history.
- Keep both inside the operation statement budget and the existing bounded-walk
  limits; a history that cannot be filtered within them fails closed.
- Real Git parity tests for a root commit, a merge commit, a path-filtered log
  across renames (add/delete until [34](34-rename-detection.md) lands), a path
  with no history, and a depth-bounded filtered log.

## Touch points

`src/core/ops/reads.ts`, `src/core/ops/diff.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/reads.test.ts`, `tests/client.test.ts`,
`docs/reference/git-support.md`
