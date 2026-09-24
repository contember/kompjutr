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

Remeasured at `62ffbf0` (2026-09-24), after the simplification sprint's
forwarding-layer removal (WU4) and large-rebase streaming (WU22). Neither
changed the pass count. The instrumented pass for the 150-file binary merge
still attributes 1,200 MiB of worktree reads to conflicted inputs that total
150 MiB: one query shape,
`SELECT c.idx, substr(c.bytes, 1, ?) FROM fs_chunks c WHERE c.inode = ? …`,
runs 2,400 times and returns 2,400 rows of `CHUNK_SIZE` 512 KiB, one row live at
a time. It was the same 2,400 rows and 1,200 MiB at `fe4e4e2`.

This is not a memory defect. The case adds 92.4–96.2 MiB of process peak over
three runs, under the <100 MiB target, in 8,040 statements. The reads are the
dominant term in its 7.8–10.3 s, and they are why binary-150 reaches the
512 MiB cgroup cap through page cache: 667–809 `memory.max` reclaim events per
run, no OOM.

Evidence and the per-table-family ledger: ignored
`bench/results/integration-after-2026-09-22/` (baseline) and a HEAD copy of that
harness, rebuilt from the same frozen packs.

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

`packages/git/src/ops/integration/` (including `apply/`),
`packages/git/src/ops/merge/`, `packages/git/src/ops/worktree/`, `bench/`
fixtures.

<!-- Origin: sprint-2026-09-10 WU6 measurement, 2026-09-22 run-log entry; remeasured at the 2026-09-23 simplification closure. -->
