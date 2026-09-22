---
id: 85
title: Restore the remaining broken benchmark harnesses
blocked-by: []
---

# 85 — Restore the remaining broken benchmark harnesses

**Summary.** Two benchmark harnesses still fail before they measure anything.
Three others failed the same way and were repaired in `5c30bc2`; these two
cannot be fixed without deciding what they should measure.

## Problem

Both break independently of the 2026-09-10 sprint, and both have been broken
since `b2cabed` (2026-09-08) — long enough that nobody noticed the numbers
were missing.

**`sqlite.maintenance.reachability`** fails during *setup*:
`CHECK constraint failed: … size BETWEEN 0 AND 50331648`. Its
`LARGE_HEADER_BYTES` is 50,397,184 by design, against `MAX_OBJECT_BYTES`
50,331,648. Both constants are unchanged since `b2cabed`. Any repair changes
what the scenario measures, which is why it was left alone.

**`bench/clone-storage.ts`** throws `unclassified tables` on any clone.
`TABLE_GROUPS` (`bench/clone-storage.ts:53-88`) classifies 34 tables while HEAD
has 61, and `dbstat` emits a row for every table including empty ones. The
unclassified set includes `git_maintenance_*`, `git_integration_*`,
`git_promised_blobs`, `git_pack_entries`, `git_pack_graph_*`,
`git_scratch_index*` and `git_pack_read_*`.

## Approach / acceptance

For the reachability fixture, decide whether the scenario is meant to exercise
an object at the limit or above it, then set the constant from
`MAX_OBJECT_BYTES` rather than hard-coding a number that drifts away from it.

For `clone-storage`, classify by rule rather than by list, so a new table
joins a group automatically and an unclassified table is a deliberate verdict
rather than an outage. Exclude empty tables from the report.

Witness: both run and report; a newly added table does not break either.

## Touch points

`bench/memory.ts`, `bench/clone-storage.ts`, `bench/scenarios.ts`.

<!-- Origin: sprint-2026-09-10 WU8 measurement, 2026-09-22 run-log entry. -->
