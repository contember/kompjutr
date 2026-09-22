---
id: 84
title: Read integration worktree inputs once
blocked-by: []
---

# 84 — Read integration worktree inputs once

**Summary.** A conflicted three-way integration reads every worktree input
eight times. Residency stays bounded, but the transfer volume dominates the
operation's wall time.

## Problem

Measuring WU6 at `fe4e4e2` attributed 1,200 MiB of worktree reads to a merge
whose conflicted inputs total 150 MiB — eight passes over the same bytes,
delivered as 2,400 `fs_chunks` rows of `CHUNK_SIZE` 512 KiB with one row live
at a time. The same ratio holds at 75 files (600 MiB against 75 MiB).

This is not a memory defect: WU6's bound holds, and the case meets the
<100 MiB added-peak target. It is the dominant term in that case's ~10 s, and
it is why binary-150 reaches the 512 MiB cgroup cap through page cache and
records several hundred `memory.max` reclaim events.

Evidence and the per-table-family ledger are in ignored
`bench/results/integration-after-2026-09-22/`.

## Approach / acceptance

Identify the eight passes before changing anything — the count comes from a
storage-double ledger that attributes statements and transferred bytes per
table family, not from reading the code, so the consumers must be named first.
Collapse the ones that read the same content for the same purpose, keeping one
row live at a time and preserving the bounded-prefix contract.

Witness: the attributed worktree-read volume for the 150-file binary case
drops with unchanged public results, unchanged native byte/mode/stage/HEAD
oracles, and no regression in added process peak. Re-run the frozen fixtures
in the artifact directory so the before and after are like for like.

## Touch points

`packages/git/src/ops/integration/`, `packages/git/src/ops/merge/`,
`packages/git/src/ops/worktree/`, `bench/` fixtures.

<!-- Origin: sprint-2026-09-10 WU6 measurement, 2026-09-22 run-log entry. -->
