---
id: 122
title: Stop the workerd bench RSS reset flake
blocked-by: []
---

# 122 — Stop the workerd bench RSS reset flake

**Summary.** `bench:workerd:nextjs` sometimes aborts before the clone starts. Its
RSS reset check races two `/proc` reads. Effort: S.

## Problem

`resetPeakRss` (`bench/workerd/proc-memory.ts:53-60`) writes `clear_refs`,
then requires `VmHWM` to equal `VmRSS` within one page. RSS can drop between
the two non-atomic reads, for example "VmHWM 78266368 did not reset to VmRSS
78221312". The run then throws, and a leased benchmark of several minutes must
be repeated. This happened in about one of eight runs in the
2026-10-07 sprint.

## Approach / acceptance

Read both values from one `/proc/<pid>/status` snapshot. Accept `VmHWM` within
a small margin above `VmRSS`, or retry the reset a bounded number of times.
Witness: twenty consecutive leased depth-1 runs pass, or a unit test that
feeds the check a status snapshot where RSS dropped.

## Touch points

`bench/workerd/proc-memory.ts`.

<!-- Origin: sprint-2026-10-07-fast-fresh-clone run log. -->
