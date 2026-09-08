<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — lifecycle and network integrity (2026-09-08)

**Goal.** Stop maintenance from deleting objects that are still reachable, and
stop fetch from publishing refs over an object graph it never proved complete.

**Theme.** Three units share one contract: nothing is deleted or published until
the physical bytes it depends on are proven present. WU1 owns the promise-to-
physical transition, WU2 owns pack dependencies across ingest, promotion, and
sweep, WU3 owns the network boundary. They belong in one sprint because each one
alone can make a repository look corrupt while every individual operation reports
success.

Consumes backlog [71](../backlog/71-invalidate-maintenance-on-promise-fulfillment.md),
[72](../backlog/72-preserve-pack-dependencies-during-lifecycle.md), and
[73](../backlog/73-validate-fetch-connectivity-and-publication.md).

## Refs re-verified at HEAD (2026-09-08)

`✔` = confirmed live · `⚠` = drift/nuance caught. Everything below is static
verification; unlike the public-API sprint, none of these three has a planning-
time runtime reproduction through public operations. Producing one is the first
task of each unit.

- ✔ Marking skips an edge whose target is a missing promised blob —
  `packages/git/src/store/maintenance/reachability/reachability-publish.ts:87`.
- ✔ Loose publication removes the promise through a trigger —
  `packages/git/src/store/schema/schema-object-statements.ts:45-52`; complete pack
  publication deletes it directly — `packages/git/src/store/pack/packs.ts:233`.
- ✔ Neither advances the maintenance root epoch. The bump has one implementation
  (`packages/git/src/store/maintenance/control.ts:60-75`) and its callers are
  checkout mutations (`database-checkout-mutations.ts:219,277,356`), shallow
  (`refs/shallow.ts:103`), fetch publication (`fetch/fetch-publication.ts:421`),
  and the index tracker (`do-fs/indexes/index-tracker.ts:269,306,359,395,406`).
- ✔ The sweep grace period is 14 days — `GC_GRACE_MS = 1_209_600_000`,
  `packages/git/src/store/maintenance/sweep/sweep-contracts.ts:3`, applied at
  `sweep/sweep-shared.ts:87-94`.
- ✔ Pack deletion authenticates surviving delta bases for *complete* children
  only — `packages/git/src/store/pack/lifecycle/lifecycle-delete.ts:196-199`.
- ✔ Ingest deletes a pending row once its delta is flushed —
  `packages/git/src/store/pack/ingest/ingest-pending.ts:312`.
- ✔ Pack sweep always selects the lowest surviving `pack_id` —
  `ORDER BY pack_id LIMIT 2`, `sweep/sweep-packs.ts:77,139` — so a blocked
  candidate is re-selected on every run.
- ✔ Mapped fetch validates root type and hash and peels tags; there is no
  connectivity walk anywhere in `packages/git/src/ops/network/` —
  `network-fetch-mapped.ts:248-250`.
- ✔ Publication preflight compares namespace generation, revision, shallow
  revision, and checkout revision — never physical availability —
  `packages/git/src/store/fetch/fetch-publication-preflight.ts:19-60`.
- ✔ Legacy fetch awaits a checkpoint immediately before ref publication —
  `packages/git/src/ops/network/network-fetch-legacy.ts:208`.
- ✔ The sideband reader returns on EOF exactly as on flush and forwards an
  unknown band as a message — `packages/git/src/protocol/upload-pack.ts:251-266`.
- ⚠ Backlog 72's first two mechanisms were observed through *direct store*
  deletion, and its probe failed in its own cleanup (`db.storage.close` is not a
  function). Treat them as store-level observations, not as proof that ordinary
  maintenance destroys reachable history.
- ⚠ Backlog 71's end-to-end journey (HTTP partial clone → `catFile()` hydration →
  sweep) was never run; only the publication path is traced.
- ⚠ Backlog 73's legacy fetch/maintenance interleaving is a static schedule. A
  normal mapped transfer with a fresh fallback pack is a different witness and
  does not establish it.

## Work units

### WU1 — Invalidate maintenance marks when promised blobs become physical (effort M–L)

- **Problem.** A tree that names a missing promised blob is marked without that
  edge (`reachability-publish.ts:87`). When the blob is later published, the
  promise disappears (`schema-object-statements.ts:45-52`, `packs.ts:233`) but the
  root epoch does not move, so an unfinished generation keeps a reachability view
  in which the now-physical blob is unreachable. After the 14-day grace
  (`sweep-contracts.ts:3`) the sweep deletes it — local bytes and the automatic
  promise-based recovery are both gone.
- **Verify first.** Build the deterministic schedule with an injected clock:
  reference the tree, mark while the blob is absent, publish loose, then publish
  packed, leave the generation unfinished, resume past the grace. Record whether
  the blob is actually deleted for each storage variant *before* changing code. If
  a variant does not reproduce, narrow the claim in the run log.
- **Scope.** 1) Atomically invalidate the stale reachability generation when
  physical publication fulfills a promise, for both loose and packed writes.
  2) Confirm the next destructive action restarts or incorporates the newly
  physical leaves before deleting anything. 3) Keep the normal grace-period
  collection of genuinely unreachable objects. Do not make every promise a
  maintenance root.
- **Acceptance / witness.** `npx vitest run tests/maintenance-sweep.test.ts tests/promisor-store.test.ts`
  — the loose and packed schedules above keep the blob, HEAD stays readable, cold
  reopen agrees, and an unreachable object is still collected after the grace.
  Add the partial-clone → hydration → maintenance journey if the verify-first step
  shows the publication path is reachable that way.
- **Touch points.** `packages/git/src/store/maintenance/reachability/reachability-publish.ts`,
  `packages/git/src/store/maintenance/control.ts`,
  `packages/git/src/store/maintenance/sweep/`,
  `packages/git/src/store/pack/packs.ts`,
  `packages/git/src/store/schema/schema-object-statements.ts`,
  `packages/git/src/ops/network/network-promisor.ts`,
  `tests/maintenance-sweep.test.ts`, `tests/promisor-store.test.ts`.

### WU2 — Preserve pack dependencies across ingest, promotion, and sweep (effort L)

- **Problem.** Three mechanisms, one contract. Deletion protects the bases of
  complete children only (`lifecycle-delete.ts:196-199`), so a resolved-but-
  flushed pending child (`ingest-pending.ts:312`) can lose its base and publish
  complete with an unreadable cold read. Canonical promotion after a deletion can
  produce an `A↔B` delta cycle. And pack sweep re-selects the lowest `pack_id`
  (`sweep-packs.ts:77,139`), so one `EBUSY` candidate starves every later one.
- **Verify first.** Before any fix, establish for each mechanism whether a
  *public* schedule reaches it — deterministic fetch plus maintenance for the
  first two, repeated public maintenance for the third. Record the answer in the
  run log. A mechanism that only reproduces through direct store deletion keeps
  the narrower claim and a store-level witness.
- **Scope.** 1) Protect the dependencies of unresolved *and* resolved pending
  entries, without changing ingest ownership, expiry, or cleanup. 2) Make
  publication and canonical promotion preserve a terminating physical dependency
  path — metadata and ownership validation only, never re-authentication of
  stored bytes ([ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md)).
  3) Stop dependency-blocked candidates from starving unrelated work: process dead
  dependencies in a safe order or a bounded group, and retain bases that surviving
  mixed packs still need.
- **Acceptance / witness.** `npx vitest run tests/concurrency-pack.test.ts tests/concurrency-maintenance.test.ts tests/maintenance-sweep.test.ts tests/pack.test.ts`
  — the thin-delta schedule, the three-pack cycle, a self-referential alternative,
  and the blocked-lowest-id sweep all keep every reachable object readable after
  cache eviction and cold reopen; repeated maintenance makes progress past a
  blocked candidate.
- **Touch points.** `packages/git/src/store/pack/ingest/ingest-pending.ts`,
  `packages/git/src/store/pack/lifecycle/lifecycle-delete.ts`,
  `lifecycle-ingest.ts`, `packages/git/src/store/maintenance/sweep/sweep-packs.ts`,
  `tests/concurrency-pack.test.ts`, `tests/concurrency-maintenance.test.ts`,
  `tests/maintenance-sweep.test.ts`, `tests/pack.test.ts`.

### WU3 — Validate fetched connectivity and final publication (effort L)

- **Problem.** Root type and hash checks plus pack membership
  (`network-fetch-mapped.ts:248-250`) do not establish commit, tree, or blob
  connectivity, so a remote that omits a parent produces a successful `clone()`
  with a HEAD whose history is missing. Separately, publication preflight compares
  snapshots, not physical availability (`fetch-publication-preflight.ts:19-60`),
  while legacy fetch awaits a checkpoint just before publishing
  (`network-fetch-legacy.ts:208`). The sideband reader also accepts frames real Git
  rejects (`protocol/upload-pack.ts:251-266`).
- **Verify first.** Reproduce the incomplete-graph clone against a faulty test
  remote. Then attempt the legacy fetch/maintenance interleaving; if it does not
  reproduce, the lifetime half of this unit ships as an ownership guarantee with
  the schedule recorded as unproven rather than as a claimed fix.
- **Scope.** 1) Reject an incomplete graph before ref publication, for clone,
  fetch, and unmaterialized fetched branches. 2) Explicitly allow declared shallow
  boundaries, absent gitlinks, and durable `blob:none` promises
  ([ADR-0015](../decisions/0015-model-partial-clone-blobs-as-durable-promises.md)).
  3) Use bounded metadata walks and batches; do not re-hash trusted local objects
  (ADR-0004) and do not invent a projected-work refusal
  ([ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md)).
  4) Establish object lifetime across the validation/publication seam by ownership
  or an effective final check. 5) Make sideband framing differential: empty
  packets, unknown bands, and EOF without termination. Trailing bytes after flush
  are out of scope.
- **Acceptance / witness.** `npx vitest run tests/clone.test.ts tests/fetch-refspec.test.ts tests/concurrency-fetch.test.ts tests/protocol.test.ts`
  — a response missing a parent, a tree, or a non-promised blob is rejected before
  any ref moves; previous refs and checkout state survive every rejection; shallow,
  gitlink, and promise cases still succeed; large valid transfers still stream.
- **Touch points.** `packages/git/src/ops/network/network-fetch-mapped.ts`,
  `network-fetch-legacy.ts`, `network-tags.ts`, `network-checkpoint.ts`,
  `packages/git/src/store/fetch/fetch-publication-preflight.ts`,
  `packages/git/src/protocol/upload-pack.ts`, `tests/clone.test.ts`,
  `tests/fetch-refspec.test.ts`, `tests/concurrency-fetch.test.ts`,
  `tests/protocol.test.ts`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | WU1 and WU2 both change what maintenance may delete; WU3 changes what fetch may publish. A wrong combination deletes reachable data silently | `npm test` plus `npx vitest run tests/maintenance-sweep.test.ts tests/concurrency-pack.test.ts tests/concurrency-maintenance.test.ts tests/clone.test.ts`; independent integration review after the last WU, repeated after any fix that touches deletion order | Any unit widens what may be deleted, or two units edit the same sweep file |
| WU1 | Fundamental. Failure mode is silent local data loss with no automatic recovery | Independent review to clean; the reviewer re-runs the injected-clock schedule for both storage variants | The fix needs a schema change, or the verify-first step cannot reproduce either variant |
| WU2 | Fundamental and extra-large. Three mechanisms over ingest, promotion, and sweep, with concurrency schedules | Independent review to clean, per mechanism; a mechanism without a public reproduction ships with a store-level witness and an explicit narrower claim | A single mechanism grows past its own witness — split it out into its own unit rather than widening this one |
| WU3 | Fundamental. Adds a new validation pass to every fetch, so both correctness and cost are in play | Independent review to clean; reviewer checks that no stored object is re-hashed and that the walk is bounded and streaming | Connectivity validation measurably changes clone cost — then measure under `bench/CLAUDE.md` before merging |

## Test cadence

- **Per WU.** Run the exact acceptance witness above, plus `npm run test:e2e`
  for WU3 because it crosses the network transport.
- **Routine integration.** `npm test` after each WU lands; keep it under 30 s.
- **Sprint closure.** `npm run test:full` once, after the last review and its
  focused fixes have settled.
- **Failure loop.** Reproduce a full-suite failure with its exact file or slice,
  stabilize it, then rerun the full suite. Concurrency witnesses that fail
  intermittently are treated as findings, not as flakes, until proven otherwise.

## Out of scope (explicit)

- [67](../backlog/67-own-public-object-buffers.md)–[70](../backlog/70-enforce-local-scan-and-discovery-contracts.md)
  — they run as [sprint-2026-09-08-public-api-correctness](sprint-2026-09-08-public-api-correctness.md).
- [74](../backlog/74-align-pack-ingest-with-physical-membership.md) — pack ingest
  versus physical membership is interoperability with real Git packs, a different
  contract from deletion safety, and it would double this sprint's size.
- [63](../backlog/63-bound-packed-dependency-graph-traversal.md) — bounded
  dependency traversal is coordinated with WU2 but not delivered here. WU2 must
  not leave a traversal that grows worse than the current one.
- [65](../backlog/65-git-sqlite-architecture-review.md), ARCH-16 cursors and
  ARCH-9 pending projections: adjacent to WU1 and WU2 but separately owned.
- Trailing bytes after a sideband flush, and any general storage normalization
  experiment (65, ARCH-22).

## Decisions

1. **Fulfilling a promise invalidates the stale reachability generation**, rather
   than promoting every promise to a maintenance root. Roots-for-promises would
   keep unreachable promised blobs alive forever.
2. **Dependency protection is metadata and ownership validation.** Re-reading or
   re-hashing stored bytes to decide what is safe to delete contradicts ADR-0004
   and is rejected.
3. **Connectivity validation runs on bounded metadata walks**, batched and
   streaming, with shallow boundaries, gitlinks, and durable promises as declared
   exceptions. A projected-work refusal is rejected under ADR-0005.
4. **Verify-first is a gate, not a formality.** A mechanism that reproduces only
   through direct store manipulation keeps the narrower claim in its backlog
   record and ships with a store-level witness. Out-of-band database mutation is
   undefined behavior, so it can never be the sole justification for a fix.

## Sequencing

| Order | Unit | Parallel with | Why |
|---|---|---|---|
| 1 | WU1 | WU3 | Establishes what a generation means before WU2 changes selection inside the same sweep files |
| 2 | WU2 | WU3 | Shares `store/maintenance/sweep/` with WU1; serialize to keep the witnesses attributable |
| — | WU3 | WU1 and WU2 | Disjoint territory: `ops/network/`, `store/fetch/`, `protocol/` |

Two agents at most: one on the WU1 → WU2 chain, one on WU3. Do not run WU1 and
WU2 concurrently even though their fixes look separable — both change deletion
eligibility, and a combined failure is hard to attribute.

## Plan review

An independent reviewer checks this proposal against HEAD, including whether the
verify-first gates are strong enough to keep an unreproduced schedule from being
written up as a fixed defect.

- **Reviewer:** pending
- **Verdict:** pending
- **Material findings:** —

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-09-08 — Planning verified every mechanism statically at HEAD; no unit has a
  public runtime reproduction yet. Each WU's verify-first step must record one
  before its fix lands.
