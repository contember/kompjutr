---
id: 87
title: Bring an eight-step rebase under the statement target
blocked-by: []
---

# 87 — Bring an eight-step rebase under the statement target

**Summary.** `rebase.transition-2n` costs 1,132 SQL statements, over the
repository's 1,000-statement target. It is linear in steps, so the miss is a
per-step cost, not runaway growth.

## Problem

Measured at `62ffbf0` (2026-09-24) with `bench:statements`:
`rebase.transition` 365 (2 steps), `rebase.transition-n` 624 (4 steps),
`rebase.transition-2n` 1,132 (8 steps) over 1,157 rows. The marginal cost is
127 statements per step over a fixed ~116. Reaching ≤1,000 at eight steps needs
≤110 per step, so each step must lose at least 17 statements.

History: WU6 of the 2026-09-10 sprint (`3a37c27`,
[ADR-0024](../decisions/0024-own-integration-output-in-a-scoped-sql-workspace.md))
moved integration plans into a scoped workspace and took the row from 928 to
1,462. Eliding the terminating keyset page (`e355936`) took it to 1,279. The
simplification sprint took it to 1,132; the drop was not attributed per unit.

The per-step marginal at `62ffbf0`, from the difference between the 8-step and
4-step histograms, spreads over about 55 query shapes:

| Family | Per step | Largest shapes |
|---|---:|---|
| Integration workspace | 37 | plan-entry page reads 17, plan create/update 8, entry/touched/reservation writes 6, touched reads 4, workspace create/delete 2 |
| Object reads | 23 | `git_objects` type 8, packed type 4, read-graph walk 3, loose payload 3, other payload and pack-data reads 5 |
| Worktree reads | 14 | path and stat walks 13, one chunk read |
| Index reads | 10 | index scans 8, unmerged-stage probe 2 |
| Ref resolution | 8 | DWIM `SELECT 1` probes 6, target reads 2 |
| Tree walks | 7 | recursive tree-source walk |
| Step commit, journal and the rest | 28 | object/tree/commit writes, worktree and index writes, journal reads and updates, config, maintenance epoch |

Plan-entry reads fell from 21 to 17 per step since `4c333ce`. Removing every
remaining plan traversal would still leave ~110 per step and the row just under
the target, with no margin.

## Approach / acceptance

This is a design question before it is an optimisation: decide whether
ADR-0024's traversal contract should let apply fuse its passes over the plan
into fewer streamed passes, and write that decision first. Cheap cuts alone
(ref DWIM probes, the per-step workspace create/delete, repeated type lookups)
are worth ~10 per step and do not change the verdict alone.

Witness: `rebase.transition-2n` reports `pass` against the 1,000-statement
target with unchanged rows read and unchanged rebase semantics, and the frozen
baselines for all three rebase rows move down rather than up.

## Touch points

`packages/git/src/ops/rebase/`, `packages/git/src/ops/integration/`,
`packages/git/src/store/operations/integration-workspace/`, `bench/statements.ts`.

<!-- Origin: sprint-2026-09-10 WU8 measurement and the 2026-09-22 baseline triage; remeasured at the 2026-09-23 simplification closure. -->
