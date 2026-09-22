---
id: 82
title: Restore the clone statement target after canonical graph admission
blocked-by: []
---

# 82 — Restore the clone statement target after canonical graph admission

**Summary.** WU3's canonical dependency admission made a single public clone of
24,252 files cost 1,264 SQL statements, up from 784, crossing the repository's
<1,000 statement gate.

## Problem and evidence

`tests/clone-initial.test.ts > clone initial-state fast path > keeps a
24,252-file fallback clone within the statement target` asserts
`storage.inner.statementCount < 1_000`. It fails at `HEAD` with
`expected 1264 to be less than 1000`.

Bisected on detached worktrees, one public clone of the same fixture, with the
assertion replaced by `toBe(-1)` to print the measured count:

| Commit | Statements | Result |
|---|---|---|
| `7b958e0` (sprint baseline) | — | passes |
| `187b9dd` (WU1) | — | passes |
| `e0c34d9` | — | passes |
| `2af7f69` (WU4) | 784 | passes |
| `491189b` (WU3) | 1,264 | **fails** |

`491189b` is the first failing commit: +480 statements, +61%. WU3's own run-log
entry measured 673 statements on the *reclaim* witness and recorded that gate as
preserved; the clone witness was not part of that gate and was not run.

The likely structural cause is not confirmed: `GRAPH_PAGE` is 256
(`packages/git/src/store/pack/graph/graph-sql.ts:1`), while the production pack
graph page elsewhere is 4,096 (`packages/git/src/store/pack/shared.ts`).
Admission cost then grows linearly in pack objects at 256 rows per page, which
is roughly the observed delta for this fixture. No per-page statement count was
measured, and no alternative page size was tried.

## Approach / acceptance

- Attribute the added statements to exact admission queries before changing a
  constant. A page-size change alters the declared memory envelope and needs its
  own review, per [ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md).
- Keep every WU3 admission invariant: supported insertion, membership audit,
  complete-only fallback promotion, depth and cycle rejection.
- Witness: the existing clone statement-target test passes unchanged, the
  reclaim witness stays at or below its recorded 673 statements, and
  `tests/pack-cold-admission.test.ts` plus `tests/pack-graph-admission.test.ts`
  stay green. Do not relax the assertion.

## Touch points

`packages/git/src/store/pack/graph/graph-admission.ts`,
`packages/git/src/store/pack/graph/graph-sql.ts`, `packages/git/src/store/pack/ingest.ts`.

<!-- Origin: sprint-2026-09-10 run log, 2026-09-22 entry. -->
