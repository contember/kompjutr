---
id: 50
title: Report the untracked file a cached removal leaves behind
blocked-by: []
---

# 50 — Report the untracked file a cached removal leaves behind

**Summary.** Tier S. After `rm({ cached: true })` the working-tree file survives
but `status` never mentions it, so a caller sees a deletion where Git shows a
deletion *and* an untracked file. Effort S.

## Problem

`git rm --cached <path>` drops the index entry and leaves the file on disk. Git
then reports the path twice — `1 D.` for the HEAD-to-index deletion and
`? <path>` for the file still in the working tree (`D ` and `??` in porcelain
v1). kompjutr emits only the deletion row.

The cause is a shortcut in the three-way merge-join.
`src/core/ops/status.ts:392` takes the tracked branch whenever HEAD holds the
path and comments *"A tracked path is never also untracked, whatever is on
disk"*, so the untracked branch below it is unreachable for a path that is in
HEAD but not in the index. That assumption is what a cached removal breaks.

The row builder already assumes the opposite:
`src/core/ops/status-rows.ts:278` reads *"Not in the index: the file, if any,
shows up as untracked instead"*. The two sites contradict each other, and the
one that decides is the wrong one.

Nothing warns. The index is correct either way, which is why the existing
coverage missed it: `tests/staging.test.ts` compares index lines after a cached
removal and never looks at status.

This is a missing row, not a formatting fault — distinct from
[45](45-framing-safe-porcelain-output.md), which is about quoting the paths in
the rows that do get emitted.

## Approach / acceptance

- Let one path yield both an ordinary row and an untracked row when HEAD holds
  it, the index does not, and the working tree still does. Resolve the
  contradiction by making `status.ts` agree with `status-rows.ts`, not the
  reverse.
- Keep the emission order Git uses: ordinary rows first, then `?`, then `!`
  (`formatPorcelainV2` already appends the last two in that order).
- Honour `untrackedFiles: "no"` and `.gitignore` for the new row exactly as the
  ordinary untracked path does — an ignored leftover becomes `!`, not `?`.
- **Witness.** `tests/e2e/solo-workflow.test.ts` already pins the divergence: the
  cached-removal step asserts that `world.run` *rejects*. When this lands, that
  pin turns red and becomes a plain mirrored step.

## Touch points

`src/core/ops/status.ts`, `src/core/ops/status-rows.ts`,
`tests/e2e/solo-workflow.test.ts`, `tests/status.test.ts`.

<!-- Origin: ../archive/sprint-2026-08-26-e2e-journeys.md run log, finding 1. -->
