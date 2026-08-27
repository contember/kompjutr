> **OUTCOME — shipped 2026-08-27.** Added one resumable repository maintenance
> state machine that snapshots every authoritative root, marks logical and
> physical reachability, republishes reachable loose objects as bounded validated
> packs, and reclaims only loose objects and wholly unreachable packs after the
> reflog and 14-day grace windows. Public `maintenance()` calls are restartable,
> report durable progress, and preserve interleaved foreground and fetch state.
> Commit map: plan → `24fdbf9`; WU1 → `fb64135`, `a16fbae`; WU2 → `7359173`,
> `52e57b0`; WU3 → `706d348`; WU4 → `38271ed`; WU5 → `b3fa23e`; WU6 →
> `c31382e`; WU7 → `0af272b`; WU8 → `650c83b`; final root-epoch and cost
> correction → `bd452af`. Verification: full suite — 128 files, 2,319 passed,
> 5 skipped —
> plus typecheck, Biome, build, and a relative-link audit. The 50,001-commit
> restart witness completed, and every cold storage-pressure call stayed below
> 1,000 SQL statements and at or below 64 MiB retained memory. Backlog closed: 04.
> Deferred: mixed-pack compaction and outbound delta compression (09), the
> systematic concurrency/restart matrix (16), and integrity snapshots (17).

# Sprint — Repack and garbage collection (2026-08-27)

**Goal.** Bound repository storage growth with resumable loose-object repacking
and grace-period garbage collection that never deletes an authoritative object.

**Theme.** Maintenance is one repository-scoped state machine. It snapshots all
authoritative roots, marks the reachable closure, publishes validated bounded
packs, and reclaims only data proven unreachable across the retention and grace
windows.

## Refs re-verified at HEAD (2026-08-27)

Planning was grounded at `4a95725`.

- ✔ Git schema initialization accepts one exact development-only schema v1
  baseline. It has no production-user compatibility contract and remains
  directly editable — `src/sqlite/schema.ts:25`.
- ✔ Loose objects have no creation timestamp; complete packs already do —
  `src/sqlite/schema.ts:345`, `src/sqlite/schema.ts:373`.
- ✔ Pack ingest already stages invisible rows, validates the trailer, object
  index, trees, and commits, then publishes atomically —
  `src/sqlite/packs.ts:1170`.
- ⚠ Pending-pack cleanup currently reclaims every pending pack. Maintenance
  needs ownership-scoped cleanup so it cannot delete an interleaved fetch —
  `src/sqlite/packs.ts:1119`.
- ✔ Deleting a loose tree switches the effective derived source to a complete
  packed copy — `src/sqlite/schema.ts:513`.
- ✔ Retained reflog endpoints already have a validated root iterator, while
  maintenance still needs a durable paged form for histories above that
  iterator's aggregate guard — `src/sqlite/store.ts:4670`.
- ✔ Object writes have scalar, streamed, and batch paths. Lifecycle metadata
  must be atomic in all three — `src/sqlite/store.ts:3337`,
  `src/sqlite/store.ts:3415`, `src/sqlite/store.ts:3675`.
- ✔ The public Git client has no maintenance operation —
  `src/git/client.ts:221`.

## Work units

### WU1 — Extend the development-only v1 baseline with maintenance state (effort L)

- **Problem.** Maintenance needs durable lifecycle, run, mark, batch, and
  candidate rows in the exact schema baseline.
- **Verify first.** Prove exact-v1 validation, initialization rollback, and the
  current schema statement ceiling in `tests/schema.test.ts`.
- **Scope.** Add sidecar loose birth metadata and bounded maintenance tables
  directly to schema v1. Record lifecycle metadata in every loose write path.
- **Acceptance / witness.** Fresh creation and reopen validate the exact v1
  catalog; failed initialization leaves an empty database; every loose write
  path creates lifecycle metadata atomically.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`, schema and
  lifecycle tests.

### WU2 — Extract a bounded full-object pack pipeline (effort L)

- **Problem.** `PackWriter` is reusable, but push owns the object stream;
  `PackStore.ingest()` allocates its own pack and broad pending cleanup is unsafe
  for resumable maintenance.
- **Verify first.** Pin existing push pack bytes, pending-pack visibility, pack
  validation, and tree-source publication.
- **Scope.** Extract a neutral bounded full-object pack stream; let maintenance
  reserve and own one pending pack; reclaim only that pack on retry; add exact
  complete-pack verification, bulk deletion, and storage-cache revalidation
  seams.
- **Acceptance / witness.** Push output remains compatible; a maintenance pack is
  readable by real Git; failures before publication leave only the loose source;
  failure after publication leaves both readable until finalization.
- **Touch points.** `src/core/pack/`, `src/core/ops/push-plan.ts`,
  `src/sqlite/packs.ts`, focused pack tests.

### WU3 — Snapshot all authoritative roots (effort L)

- **Problem.** Roots span shared refs, every checkout, reflogs, all index stages,
  shallow boundaries, index tracker baselines, and active operation journals.
  No durable cross-call snapshot exists.
- **Verify first.** Enumerate one validated witness for each root field and prove
  absent gitlinks remain valid.
- **Scope.** Add repository root epochs inside root-changing transactions; page
  every root source with persisted keyset cursors; restart a snapshot when the
  epoch drifts; validate complete operation journals before accepting their
  object IDs.
- **Acceptance / witness.** Cold reopen resumes exactly; a mutation between pages
  restarts without publishing a partial snapshot; every root source and boundary
  is covered; caches and pending packs are excluded.
- **Touch points.** New `src/sqlite/maintenance/roots.ts`, root-mutation seams in
  `src/sqlite/store.ts`, focused root and concurrency tests.

### WU4 — Mark the logical and physical closure (effort L)

- **Problem.** Existing commit and tree walks are bounded read APIs, not a durable
  reachability engine for histories larger than one call.
- **Verify first.** Pin direct commit, tree, annotated-tag, shallow-boundary, and
  delta-base edges, including corruption failures.
- **Scope.** Add a persistent deduplicated queue and marks; page direct tree
  children; expand commit, tree, tag, and physical pack-base edges; stop parent
  traversal at shallow commits; ignore absent gitlink targets; meter every slice
  below the statement and retained-memory limits.
- **Acceptance / witness.** Histories above existing walk limits complete over
  multiple calls; reopen resumes; missing or corrupt non-gitlink edges fail
  closed before classification.
- **Touch points.** New `src/sqlite/maintenance/reachability.ts`, a direct-tree
  paging seam, focused reachability and cost tests.

### WU5 — Repack reachable loose objects (effort L)

- **Problem.** Locally written objects remain loose forever.
- **Verify first.** Record exact batch membership and preflight object count,
  inflated bytes, generated bytes, and statement cost.
- **Scope.** Select marked loose objects in OID order; create independent
  full-object packs with at most 2,048 objects, 32 MiB inflated input, 64 MiB
  stored output, and 900 estimated statements; publish through the validated
  pack path; atomically verify membership and delete loose copies; resume every
  crash boundary from durable batch state.
- **Acceptance / witness.** Reachable loose objects become readable complete-pack
  objects; commit and tree projections stay valid; retry is idempotent before
  and after publication; one oversized object is streamed only after explicit
  preflight.
- **Touch points.** New `src/sqlite/maintenance/repack.ts`, maintenance
  coordinator, focused repack and crash tests.

### WU6 — Classify and sweep unreachable storage (effort L)

- **Problem.** Unreachable loose objects and wholly unreachable packs have no
  candidate age or safe deletion lifecycle.
- **Verify first.** Pin retained reflog boundaries, exact grace boundary, mixed
  pack behaviour, stale blob-ID mappings, and derived-cache cleanup.
- **Scope.** Record first-unreachable time only after a complete stable mark;
  remove candidates that become reachable; after 14 days, delete eligible loose
  objects and wholly unreachable complete packs in bounded transactions; remove
  stale blob-ID, commit, and tree-derived rows; recheck root epoch before each
  destructive transaction.
- **Acceptance / witness.** Reflog retention plus grace protects deleted history;
  exact-boundary deletion is deterministic; mixed live/dead packs stay intact;
  wholly dead packs reclaim live row bytes; interrupted sweep is idempotent.
- **Touch points.** New `src/sqlite/maintenance/sweep.ts`, maintenance
  coordinator, focused GC, reclamation, and corruption tests.

### WU7 — Expose and document bounded maintenance (effort M)

- **Problem.** Callers cannot start or resume maintenance or observe when only a
  grace-period candidate remains.
- **Verify first.** Pin the public result discriminants and one complete lifecycle
  through the runtime binding.
- **Scope.** Add `git.maintenance({ dir? })`; make one call advance one bounded
  durable slice; report phase, stable run ID, counters, root-restart status, and
  `nextEligibleAt`; document the storage and scheduling contract.
- **Acceptance / witness.** Repeated calls reach `complete`; close/reopen between
  every phase is safe; public types build and runtime tests pass.
- **Touch points.** New `src/core/ops/maintenance.ts`, `src/git/client.ts`, package
  exports, runtime tests, `docs/reference/architecture.md`,
  `docs/reference/git-support.md`.

### WU8 — Final crash, concurrency, and cost qualification (effort L)

- **Problem.** Destructive maintenance is only shippable with boundary-level
  evidence across the composed state machine.
- **Verify first.** Enumerate every durable phase transition and destructive
  transaction.
- **Scope.** Add crash injection before and after each publication boundary;
  interleave ref, index, operation, commit, and fetch state; run large-history
  and storage-reclamation witnesses; assert exact per-call SQL and memory caps.
- **Acceptance / witness.** Every restart preserves readability; stale roots
  force restart; concurrent pending fetch packs survive; every invocation stays
  below 1,000 statements and 100 MiB; full repository gates pass.
- **Touch points.** Maintenance integration, crash, concurrency, and cost tests.

## Out of scope (explicit)

- Delta-compressing outbound or maintenance packs remains
  [`09`](../backlog/09-outbound-delta-compression.md).
- Live-object evacuation and compaction of mixed packs is deferred. This sprint
  deletes only packs with no marked object, matching backlog 04's explicit
  loose-repack scope.
- The systematic pairwise operation matrix and restart harness remain
  [`16`](../backlog/16-concurrent-and-restart-conformance.md); this sprint covers
  maintenance-specific interleavings only.
- Integrity reports and reproducible snapshots remain
  [`17`](../backlog/17-integrity-audit-and-snapshots.md).
- No deploy, production probe, release, or push is part of this sprint.

## Decisions

- Schema v1 remains the one editable development-only baseline with no
  production-user compatibility contract. This sprint adds maintenance state
  directly and introduces no compatibility migration.
- Maintenance uses restart-on-root-epoch-drift, not a long-lived repository write
  lock. Mutations stay available; sustained churn may delay collection safely.
- Collection grace is a fixed 14 days after first complete unreachable
  observation. Reflog retention expires before that clock can start. There is no
  zero-grace public option.
- The public operation is `maintenance()`, not `gc()`, because one call advances
  one resumable bounded slice.
- Shallow commits retain their tree but stop parent traversal. Missing gitlink
  targets are valid and do not become traversal errors.
- The complete index-tracker baseline tree is retained conservatively. Derived
  blob-ID, commit, and tree caches are not roots and are removed when their
  authoritative object disappears.
- Maintenance packs contain full objects. Physical delta bases in received packs
  remain protected with the whole pack. Only wholly unreachable packs are swept.
- The concurrency, grace, and pack-publication choices will be recorded as ADRs
  before their implementation seams are frozen.

## Sequencing

| Wave | Units | Isolation and contract |
|---|---|---|
| 0 | WU1 | Serial shared seam: schema v1 maintenance state, durable types, ADR. |
| 1 | WU2 + WU3 | Parallel after the schema seam: pack pipeline owns pack files; roots owns store/root files. |
| 2 | WU4 | Consumes the frozen root and direct-object contracts. |
| 3 | WU5 + WU6 | Separate repack and sweep modules over the frozen coordinator state. |
| 4 | WU7 + WU8 | Public integration, composed qualification, reference updates. |

Each verified unit receives an independent review and an atomic semantic commit.
No unit may change another unit's frozen contract without returning to the
integration gate.

## Gates

Focused tests run per WU. The serialized final gate is:

```bash
cpu-lease run -n 4 -- npm test
cpu-lease run -n 2 -- npm run typecheck
npm run check
cpu-lease run -n 2 -- npm run build
```

## Run log

- 2026-08-27: Corrected the schema premise: v1 is a development-only baseline
  with no production-user compatibility contract, so WU1 extends it directly.
- 2026-08-27: Planning audit chose 14-day first-unreachable grace,
  restart-on-epoch concurrency, and whole-pack-only collection.
