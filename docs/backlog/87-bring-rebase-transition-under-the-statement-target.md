---
id: 87
title: Bring an eight-step rebase under the statement target
blocked-by: []
---

# 87 — Bring an eight-step rebase under the statement target

**Summary.** `rebase.transition-2n` costs 1,279 SQL statements, over the
repository's 1,000-statement target. It is linear in steps, so the miss is a
per-step cost, not runaway growth.

## Problem

Measured at `e355936`: `rebase.transition` 404, `rebase.transition-n` (4
steps) 699, `rebase.transition-2n` (8 steps) 1,279. About 184 statements per
rebase step, dominated by roughly 40 integration plan traversals each.

WU6 (`3a37c27`, [ADR-0024](../decisions/0024-own-integration-output-in-a-scoped-sql-workspace.md))
introduced this when it moved integration output into a scoped workspace: the
row went 928 at `491189b` to 1,462 at `3a37c27`. Eliding the terminating
keyset page (`e355936`) took it to 1,279. It passes the harness's linearity
gate (1,279 <= 2 x 699), and no frozen baseline existed until now, so
`--check` never mentioned it.

A per-step histogram at `4c333ce` (2026-09-23) corrects the earlier reading:
the marginal cost is 145 statements per step over a fixed ~119, spread across
~80 query shapes. Integration plan traversals are the largest family at 21 per
step (planning 3, projection 3, worktree safety 2, touched shapes 2, apply 7,
the step itself 2), then index reads 9, `git_objects` type lookups 8, tree
walks 7, worktree path walks 11, and ref DWIM probes 6. Removing every plan
traversal would still leave ~1,150. Reaching ≤1,000 at eight steps needs
≤ ~110 per step, which means fusing integration phases.

## Approach / acceptance

This is a design question before it is an optimisation: decide whether
ADR-0024's traversal contract should let apply fuse its seven passes (and
projection its three) into fewer streamed passes, and write that decision
first. Cheap cuts alone (ref DWIM probes, the step's own conflict scan) do not
change the verdict.

Witness: `rebase.transition-2n` reports `pass` against the 1,000-statement
target with unchanged rows read and unchanged rebase semantics, and the frozen
baselines for all three rebase rows move down rather than up.

## Touch points

`packages/git/src/ops/rebase/`, `packages/git/src/ops/integration/`,
`packages/git/src/store/operations/integration-workspace/`, `bench/statements.ts`.

<!-- Origin: sprint-2026-09-10 WU8 measurement and the 2026-09-22 baseline triage. -->
