---
id: 117
title: Report a pending type change as `T` in status
blocked-by: []
---

# 117 — Report a pending type change as `T` in status

**Summary.** When a tracked file becomes a symlink (or the reverse) in the
worktree, porcelain v2 status shows `M`; Git shows `T`. Tier S (silent
divergence) in status output only.

## Problem

Found while writing the type-change journey for WU4 of the 2026-10-07
full-history performance sprint. The journey compares state only after the
commit, because the per-step comparison fails on this row. It happens with
the tracker sealed and invalid, before any add.

## Approach / acceptance

Classify a mode change between the regular-file and symlink families as a
type change in the status row builder. Witness: change the WU4 journey in
`tests/staging-tracker.test.ts` to compare after each step again.

## Touch points

`packages/git/src/ops/status/`, `tests/staging-tracker.test.ts`.

<!-- Origin: sprint-2026-10-07-full-history-performance run log (WU4). -->
