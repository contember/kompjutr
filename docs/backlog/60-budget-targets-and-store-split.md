---
id: 60
title: Make the SQL budget a measured target and split the store
blocked-by: []
---

# 60 — Make the SQL budget a measured target and split the store

**Summary.** The budget rule was meant as a design discipline — *write
operations whose cost stays low enough that the platform's limits never come
into play*. The implementation inverted it into a runtime barrier that fires
first, so kompjutr now refuses calls the platform would have served. Remove
the barriers, keep the discipline in `bench/`, and — in the same pass —
inventory the memory limits and split `src/sqlite/store.ts`.

## Problem

- **The rule is inverted.** "Stay under the system limit" became "refuse
  before the system limit". Nothing in the platform fails at the 1,001st
  statement; the number is our own cost model, and it is set low enough that
  a projection trips it long before the real limit is anywhere near. The
  result is *more* failures than running unguarded would produce — the exact
  opposite of the intent. Three shapes exist:
  runtime accounting (`reserveSql`/`chargeSql`/`chargeReservedSql` in
  `src/core/ops/transport-budget.ts:79-119`), preflight projection
  (`requireStatementBudget` in `src/core/ops/push-plan.ts:656-670`), and
  module-load assertions that make an over-budget model unimportable
  (`src/core/ops/integration.ts:34-44`, `rebase-plan.ts:28`,
  `merge-apply.ts:57`).
- **Enforcement forced a constant per operation.** 28 of the 276 `MAX_*`
  constants in `src/` are statement counts —
  `MAX_LS_FILES_COMBINED_IGNORE_STATEMENTS`,
  `MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ`,
  `MAX_CONFIGURED_REFLOG_IDENTITY_SQL_STATEMENTS`. Each is a number a
  reviewer must re-justify and a failure mode a consumer can hit.
- **The wrong harness defends the cost model.** 490 assertions across 68 test
  files pin exact query counts (`expect(db.storage.statementCount).toBe(9)` —
  `tests/integration.test.ts:307`), so a cost regression surfaces as a unit
  test diff instead of a benchmark row.
- **Memory has the same inversion, but not the same answer.** `<100 MiB` is a
  real failure mode — the Durable Object does OOM — so some of those bounds
  earn their refusal. But the 117 `MAX_*_BYTES` constants do not say which are
  that protection, which were measured on a fixture, and which are arbitrary
  fractions that fire early for no reason.
- **`src/sqlite/store.ts` is 8,493 lines** with about 200 methods, and 25 of
  the 47 files in `src/core/ops/` import it directly. Maintenance already
  lives in `src/sqlite/maintenance/`; refs, index, objects, checkouts, config
  and reflogs do not.

## Approach / acceptance

1. **Delete the statement budget from the runtime.** Remove the 28 constants,
   the statement half of `TransportOperationBudget`, every preflight that
   refuses on a projected count, and the module-load assertions. No operation
   fails because of a query count any more. The memory accounting in the same
   budget object stays untouched.
2. **This is a behaviour change — enumerate it.** A call that used to fail
   with `E2BIG` on a statement projection now runs. List every removed refusal
   in the sprint OUTCOME and update `reference/git-support.md`. `E2BIG` from a
   memory or structural bound is unaffected.
3. **Move the cost model to `bench/`.** Each bounded operation gets a
   statement-count row measured against
   [`benchmark-current.md`](../reference/benchmark-current.md). That is where
   a regression is caught, under a CPU lease, per `bench/CLAUDE.md`.
4. **Keep only a coarse guard in the suite.** Replace exact
   `expect(...statementCount).toBe(n)` with `toBeLessThan(1_000)`. The suite
   catches an order-of-magnitude regression; the benchmark catches drift.
5. **Inventory memory before touching it.** One table in the sprint run log:
   every `MAX_*_BYTES` constant, its file, its value, and its class —
   *derived* (a fraction of the 100 MiB budget), *measured* (cite the
   benchmark row), or *arbitrary*. A bound survives only if it names the real
   failure it prevents; an arbitrary fraction that fires early goes the way of
   the statement counts. Decided from the table, not before it.
6. **Split the store by table family** behind the unchanged
   `SqliteGitDatabase` façade — refs and reflogs, index and checkouts, objects
   and packs, config, identity — following the `maintenance/` precedent. A
   pure move; ops keep importing the façade.
7. **Write the ADR.** Invariant 5 in the root `CLAUDE.md` was already
   corrected on 2026-08-29 — a runtime bound protects against a real failure,
   never a projected query count — so new code stops adding barriers while
   this item waits. The ADR records why the discipline moved to `bench/` and
   which refusals were removed.

Witness: the full suite and both parity harnesses green; `npm run bench:nextjs`
under a CPU lease within noise of `benchmark-current.md`; the `MAX_*` count
before and after in the sprint OUTCOME; the removed `E2BIG` refusals listed
explicitly and `tests/public-exports.test.ts` otherwise unchanged.

## Touch points

`src/core/ops/transport-budget.ts`, `src/core/ops/*.ts` (statement limit
sites), `src/sqlite/store.ts` (split), `src/sqlite/schema.ts`, root
`CLAUDE.md`, `src/core/CLAUDE.md`, `docs/decisions/` (new ADR),
`docs/reference/git-support.md`, `tests/`, `bench/`

<!-- Origin: backlog review 2026-08-28; reframed 2026-08-29 — the statement budget is a target, not an invariant. -->
