---
id: 60
title: Consolidate operation limits and split the store
blocked-by: []
---

# 60 — Consolidate operation limits and split the store

**Summary.** Cleanup. Seventeen archived sprints left 218 distinct `MAX_*`
constants in `src/` and an 8,500-line `src/sqlite/store.ts`. Neither is wrong;
both are the friction every later sprint pays. No behaviour change, no new
surface.

## Problem

- Invariant 5 (bound before allocating) has two budgets: ≤1,000 SQL statements
  and <100 MiB per operation. The code expresses them as 218 separately named
  constants (`grep -rhoE "MAX_[A-Z_]+" src | sort -u | wc -l`), many of them
  per-operation fragments of one of the two —
  `MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ`,
  `MAX_CONFIGURED_REFLOG_IDENTITY_SQL_STATEMENTS`,
  `MAX_BLOB_ID_MISMATCH_RETAINED_BYTES`. The code does not say which are
  derived from a budget, which were measured on the fixture, and which are
  arbitrary. Each one is a failure mode a consumer can hit and a number a
  reviewer must re-justify.
- `src/sqlite/store.ts` is 8,493 lines with about 200 methods, and 25 of the
  47 files in `src/core/ops/` import it directly. Maintenance already lives in
  `src/sqlite/maintenance/`; refs, index, objects, checkouts, config and
  reflogs do not.

## Approach / acceptance

1. **Inventory first.** One table in the sprint run log: every `MAX_*`
   constant, its file, its value, and its class — *derived* (a fraction of a
   global budget), *measured* (cite the benchmark row), or *arbitrary*. Nothing
   changes until the table exists.
2. **One budget per operation.** Replace arbitrary per-operation fragments with
   a budget object derived from the two global budgets and threaded through the
   existing statement and retained-byte accounting seams. Every stable error
   code survives: a consumer that hit `E2BIG` before still hits `E2BIG`.
   Measured limits keep their number and gain a pointer to the measurement.
3. **Split the store by table family** behind the unchanged
   `SqliteGitDatabase` façade — refs and reflogs, index and checkouts, objects
   and packs, config, identity — following the `maintenance/` precedent. A pure
   move; ops keep importing the façade.
4. **Record the rule** in `src/core/CLAUDE.md`: a new limit is derived from a
   global budget or measured and cited; a bespoke constant is a review stop.

Witness: the full suite and both parity harnesses green; `npm run bench:nextjs`
under a CPU lease within noise of
[`benchmark-current.md`](../reference/benchmark-current.md); the `MAX_*` count
before and after in the sprint OUTCOME; no public type or error code changed
(`tests/public-exports.test.ts`).

## Touch points

`src/sqlite/store.ts` (split), `src/core/ops/*.ts` (limit sites),
`src/core/CLAUDE.md`, `tests/`, `bench/`

<!-- Origin: backlog review 2026-08-28 -->
