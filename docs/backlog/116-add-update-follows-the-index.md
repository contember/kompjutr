---
id: 116
title: Make `add -u` follow the index, not HEAD
blocked-by: []
---

# 116 — Make `add -u` follow the index, not HEAD

**Summary.** `add -u` updates only paths present in HEAD. Git updates every path
in the index. Tier S (silent divergence).

## Problem

Found by WU4 of the 2026-10-07 full-history performance sprint. It predates
that sprint: the full scan and the tracker-driven path behave the same way.

`applyAdd` drops every row without a HEAD entry when `trackedOnly` is set
(`ops/staging/staging-add.ts`, `if (trackedOnly && row.c === undefined) continue;`).

Repro: commit `README.md`; write `new.txt` = `one`; `add new.txt`; write
`new.txt` = `two`; `add -u`. Git stages `two`; kompjutr keeps `one`. If
`new.txt` is deleted instead, `git add -u` removes it from the index; kompjutr
keeps it.

## Approach / acceptance

Restrict `-u` by index membership. Witness: an e2e journey in
`tests/staging-tracker.test.ts` for both repro cases, with the tracker sealed
and invalid, compared against the `git` binary.

## Touch points

`packages/git/src/ops/staging/staging-add.ts`,
`packages/git/src/ops/staging/staging-add-tracker.ts`.

<!-- Origin: sprint-2026-10-07-full-history-performance run log (WU4). -->
