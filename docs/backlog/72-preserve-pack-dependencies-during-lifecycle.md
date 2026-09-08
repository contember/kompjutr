---
id: 72
title: Preserve pack dependencies across ingest, promotion, and sweep
blocked-by: []
---

# 72 — Preserve pack dependencies across ingest, promotion, and sweep

**Summary.** Repair verified pack-lifecycle mechanisms, with public-operation
qualification before attributing store-level failures to ordinary Git workflows.

## Problem and evidence

| Mechanism | Evidence and actual impact |
|---|---|
| Pending child loses a packed base | Resolve thin delta T against complete packed B, flush T, remove its deferred row, then yield. Pack deletion protects complete children only. Deleting B through the store succeeds; T publishes complete and its cold read fails with a missing base. Runtime-observed. Public maintenance reaches this deletion path, but the full fetch/maintenance interleaving remains a static schedule. |
| Canonical promotion creates a cycle | P1 contains full A, P2 contains B→A, and P3 contains alternate A→B. Direct store deletion of P1 promotes A into a canonical A↔B cycle; cold reads fail. Runtime-observed. This does not prove normal GC corrupts reachable history: a reachable P1 is marked and protected. |
| Lowest-ID blocked pack prevents sweep progress | With dead older base A and newer dead child C, sweep repeatedly selects A and gets `EBUSY`, never reaching C. A surviving mixed pack with an unreachable delta can also keep A undeletable. Statically verified; repeated public maintenance needs a permanent witness. |

The dependency probe printed the first two failures before failing in its own
cleanup (`db.storage.close` was not a function). Treat the observations as
evidence, not that probe as a passing regression test. No arbitrary SQL mutation
was needed for the triggers.

## Approach / acceptance

- Start with deterministic public fetch/maintenance and repeated-maintenance
  witnesses. Record whether each public schedule reproduces; do not infer live
  repository data loss from a direct store deletion alone.
- Protect dependencies of both unresolved and resolved pending entries. Preserve
  exact ingest ownership, expiry, and cleanup behavior.
- Publication and canonical promotion must preserve available, terminating
  physical dependency paths. This is metadata/ownership validation, not repeated
  authentication of stored bytes.
- Keep valid alternative representations readable after deletion and cold reopen;
  cover the three-pack cycle and a self-referential alternative.
- Dependency-blocked candidates must not starve unrelated work. Process dead
  dependencies in a safe order or bounded group, and retain bases needed by
  surviving mixed packs.
- Coordinate with [63](63-bound-packed-dependency-graph-traversal.md) on bounded
  dependency traversal, without making the correctness fix depend on a general
  storage normalization experiment.

## Touch points

- `packages/git/src/store/pack/ingest/ingest-pending.ts`.
- `packages/git/src/store/pack/lifecycle/lifecycle-delete.ts`.
- `packages/git/src/store/pack/lifecycle/lifecycle-ingest.ts`.
- `packages/git/src/store/maintenance/sweep/sweep-packs.ts`.
- `tests/concurrency-pack.test.ts`, `tests/concurrency-maintenance.test.ts`,
  `tests/maintenance-sweep.test.ts`, `tests/pack.test.ts`.
