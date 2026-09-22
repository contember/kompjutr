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

The remaining cost is the traversal *count*, not the per-traversal price.
ADR-0024 deliberately made a plan traversable more than once rather than
holding it in memory; whether a rebase step needs forty traversals is a
separate question that was never asked.

## Approach / acceptance

Count the traversals per step and name what each one reads before changing
anything — the number comes from a per-query histogram, not from reading the
code. Look for consumers that re-traverse a plan they could read once, and for
per-step work that could be hoisted across steps.

Witness: `rebase.transition-2n` reports `pass` against the 1,000-statement
target with unchanged rows read and unchanged rebase semantics, and the frozen
baselines for all three rebase rows move down rather than up.

## Touch points

`packages/git/src/ops/rebase/`, `packages/git/src/ops/integration/`,
`packages/git/src/store/operations/integration-workspace/`, `bench/statements.ts`.

<!-- Origin: sprint-2026-09-10 WU8 measurement and the 2026-09-22 baseline triage. -->
