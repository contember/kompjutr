---
id: 83
title: Order unmerged status rows after changed rows
blocked-by: []
---

# 83 — Order unmerged status rows after changed rows

**Summary.** When one operation leaves both a changed row and an unmerged row,
kompjutr's porcelain v2 row order differs from real Git's. No test pins it.

## Problem

`buildStatusRows` groups rows as ordinary(0) / untracked(1) / ignored(2) and
orders by path inside each group
(`packages/git/src/ops/status/status-core.ts:26-36`), so an unmerged path sorts
among the ordinary ones. Real Git (2.54.0) prints every changed (`1`/`2`) row
before every unmerged (`u`) row, whatever the paths are.

Reproduced two ways while authoring the WU7 journey:

- conflicted `logo.png` plus cleanly merged `story.txt` — Git prints
  `1 … story.txt`, then `u UU … logo.png`.
- renaming the conflicted path to `a_conflict.txt` and the clean one to
  `z_clean.txt` — Git still prints the changed row first, so this is a class
  order, not a path order.

Any journey that reaches a partially conflicted merge compares porcelain v2 and
would fail on it. `tests/e2e/production-cold-workflow.test.ts` avoids the shape
rather than asserting the wrong order; nothing else covers it.

## Approach / acceptance

Order rows by class first — changed before unmerged before untracked before
ignored — then by path inside each class, confirming the exact class order
against the `git` binary rather than from this note. Witness a merge that leaves
one conflicted and one cleanly merged path, compared against real Git through
the existing parity harness, and let the WU7 journey use the natural shape.

## Touch points

`packages/git/src/ops/status/status-core.ts`, `tests/status.test.ts`,
`tests/e2e/production-cold-workflow.test.ts`.

<!-- Origin: sprint-2026-09-10 WU7 authoring, 2026-09-22. -->
