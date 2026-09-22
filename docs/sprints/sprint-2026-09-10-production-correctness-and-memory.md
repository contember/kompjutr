# Sprint — Production correctness and memory (2026-09-10)

**Goal.** Make accepted packs readable after reopen, keep provisional projections
invisible, and bound live payloads in packed reads and three-way integration.

**Theme.** First production-hardening tranche for the Durable Object agent
workflow: fetch, checkpoint, merge/rebase, and reopen. Shared Git fixes must also
preserve the Unix composition. This is an eight-WU long sprint, not a declaration
of production readiness. The external consumer integration and recovery gate
remains required.

**Backlog ownership.** Consume all of [74](../backlog/74-align-pack-ingest-with-physical-membership.md)
and [63](../backlog/63-bound-packed-dependency-graph-traversal.md), plus only
ARCH-9 and ARCH-8 from [65](../backlog/65-git-sqlite-architecture-review.md).
The remainder of 65 stays unscheduled. On closure delete 74/63 only if every
acceptance is met; remove just the completed findings from 65 and reconcile its
overlapping integration ledger entry with [66](../backlog/66-retire-modeled-retained-byte-charges.md).

## Refs re-verified at HEAD (2026-09-10)

Baseline: `7b958e0bf81971503e0888e93f37ff09c8efd30c`, clean working tree before
planning. These are source inspections, not new runtime reproductions or memory
measurements. Paths below are repository-relative.

- ✔ `PackCommitIndex.#stage()` marks a pack complete, writes ordinary commit
  projections, then restores pending inside one transaction:
  `packages/git/src/store/pack/pack-ingest-index.ts:403–409`.
  `readCommitCache()` reads those rows by key without source qualification:
  `packages/git/src/store/trees/commits-cache.ts:434–450`.
- ✔ Graph traversal follows `git_commits`; missing-source verdicts count only
  uncached nodes, so a cached pending-only commit bypasses the missing check:
  `packages/git/src/store/trees/commits-graph.ts:46–57,105–108`.
- ✔ Every physical tree occurrence invokes projection after object membership
  insertion: `packages/git/src/store/pack/ingest/ingest-projection.ts:37–61`.
  Entry insertion identifies a source by repo/OID/storage/pack, not offset:
  `packages/git/src/store/trees/tree-index-batch.ts:181–187`.
- ✔ Cold delta resolution charges an extra modeled 256 bytes:
  `packages/git/src/store/pack/shared-delta.ts:8–9,79–83`; ingest instead checks
  base + instructions + target:
  `packages/git/src/store/pack/ingest/ingest-inflate.ts:36–54,121–125`.
- ⚠ The reduced-depth witness already exists at `tests/pack.test.ts:3143`.
  The production-depth failure still needs a valid public ingest/cold-read
  witness; do not present a lowered test seam as production reproduction.
- ✔ Packed reads retain decoded bases and every delta target in a per-call map:
  `packages/git/src/store/pack/read/read-resolver.ts:370–447`.
  External base payloads are also loaded together at `:343–358`.
- ⚠ Paged discovery accumulates page descriptors and per-origin checkpoint sets,
  but replaces decoded checkpoint results between reverse passes:
  `packages/git/src/store/pack/read/read-graph.ts:43–60,174–180,191–217`.
  Bound metadata and live checkpoint payloads; do not claim every prior decoded
  page stays resident.
- ✔ Maintenance validates a full delta suffix, then enqueues its immediate base:
  `packages/git/src/store/maintenance/reachability/reachability-packed.ts:24–123`;
  `packages/git/src/store/maintenance/reachability/reachability-expand.ts:191–209`.
  Repeating this along one chain causes quadratic suffix work.
- ✔ Integration retains loaded inputs and resolved entries:
  `packages/git/src/ops/integration/integration-plan.ts:117–118,197`.
  Binary conflicts retain current bytes at
  `packages/git/src/ops/integration/integration-content.ts:141–159`.
  The default plan limit is 1,000 entries, with no default aggregate payload cap:
  `packages/git/src/ops/integration/integration-types.ts:8–9`;
  `packages/git/src/ops/integration/integration-limits.ts:21–27,69–75`.
- ✔ Public merge invokes that planner before projection and application:
  `packages/git/src/ops/merge/merge.ts:256–296`. Generated objects are only written
  later; inline worktree writes accumulate again:
  `packages/git/src/ops/merge/merge-apply-blobs.ts:126–169`.
- ⚠ The existing default-clone benchmark has an approved <160 MiB added-peak
  RSS gate, not <100 MiB (see `docs/reference/benchmark-current.md`). That
  exception does not establish a new target for this sprint or prove the
  production isolate limit is met.

## Work units

### WU1 — Hide provisional commit projections (effort L; ARCH-9)

- **Problem.** Staged projections outlive temporary complete state and enter
  trusted ordinary reads; see the first two verified refs above.
- **Verify first.** Reproduce with a format-valid pack large enough to force
  projection staging (start with 3,073 commits). Interrupt public fetch after
  staging, before publication; inspect public reads before and after reopen.
  No arbitrary SQL writes to fabricate the defect.
- **Scope.** Keep provisional projections separate from ordinary published rows
  through the store ingest/publication seam. Specify staging ownership, atomic
  promotion, duplicate OIDs with existing loose/complete sources, and reclaim
  cleanup before changing schema. No per-read reauthentication or whole-pack
  in-memory projection buffer.
- **Acceptance / witness.** Pending-only commits are unavailable to commit and
  graph reads; existing published copies remain readable. Interrupted/rejected
  fetch leaves refs/HEAD unchanged; retry publishes complete objects and
  projections together. Cold reclaim leaves no orphan staging. Cover same- and
  second-handle reads, successful publication, and cleanup fault rollback. Add
  `tests/pack-projection-publication.test.ts`; extend
  `tests/concurrency-fetch.test.ts` and `tests/concurrency-pack.test.ts`.
- **Touch points.** `store/pack/pack-ingest-index.ts`, `store/pack/lifecycle/`,
  `store/trees/commits*.ts`, schema and store-owned cleanup under
  `packages/git/src/`; `docs/reference/concurrency.md`.

### WU2 — Project repeated tree sources once (effort M; 74)

- **Problem.** Repeated physical trees restart ordinals for the same source key.
- **Verify first.** Build a duplicate nonempty-tree pack; confirm native
  `git index-pack` accepts it, then demonstrate current ingest rejection.
- **Scope.** Deduplicate projection by exact source while preserving every
  physical offset/membership row. Cover buffered, chunked, and streamed paths,
  including repeats across flushes. No unbounded pack-wide set or blanket
  `INSERT OR IGNORE` hiding partial/inconsistent projections.
- **Acceptance / witness.** Full/full, full/delta, and delta/delta occurrences
  within/across flushes match real Git and remain readable after reopen.
  Repeated OIDs in different packs and loose-shadowed sources retain correct
  selection/deletion. Extend `tests/pack-physical-membership.test.ts` and
  `tests/tree-index-stream.test.ts`.
- **Touch points.** `store/pack/ingest/ingest-projection.ts`,
  `store/pack/pack-ingest-index.ts`, `store/trees/tree-index*.ts`.

### WU3 — Establish cold-readable delta admission (effort L; 74)

- **Problem.** Ingest/read working-set checks differ; no single end-to-end depth
  contract has been established.
- **Verify first.** Run the reduced-depth witness and trace immediate, deferred,
  OFS, REF, and external-base resolution through publication. Add a production-
  limit fixture before choosing the depth enforcement seam.
- **Scope.** Remove the modeled wrapper discrepancy; establish a shared real
  size/depth contract at ingest, including cross-pack dependencies and loose
  bases. Preserve frozen physical OFS membership. Reject before publication;
  do not lower current structural limits to force a pass.
  Define cycle/depth admission over the effective canonical OID graph used by
  cold reads and maintenance, separately from incoming physical pack chains.
  Representation, normalization, and admission strategy remain design-gated.
- **Acceptance / witness.** At-limit accepted objects remain readable after
  cache eviction and reopen; over-limit objects fail without visible incomplete
  projections or moved refs. Test both sides of actual size/depth boundaries;
  compare format validity/decoded bytes with Git. Repacking or loose shadowing
  cannot make an accepted object unreadable. Cover duplicate-OID substitutions
  whose physical and canonical depths differ, and later ingestion that replaces
  a loose terminal with a packed dependency. In particular: existing packed B
  depends on loose A; a new valid pack contains full B and A as a delta of B.
  Retaining canonical B→A while adding A→B must not publish a cycle. Also cover
  acyclic canonical depth extension beyond the admitted limit. Newly admitted
  objects and previously published dependents must remain cold-readable and
  maintenance-traversable, or the new publication must be rejected atomically.
  Add
  `tests/pack-cold-admission.test.ts`; run with `tests/pack.test.ts` and
  `tests/pack-physical-membership.test.ts`.
- **Touch points.** `store/pack/shared-delta.ts`, `store/pack/ingest/`,
  `store/pack/read/`, lifecycle admission and metadata as needed.

### WU4 — Bound packed-read payload lifetime (effort L; 63)

- **Problem.** Decoded intermediates/external bases outlive their immediate use.
- **Verify first.** Measure a cold scalar read of a chain with one 8 MiB base and
  16 distinct 8 MiB targets; return only the final target. Separately measure
  shared-base batches through the bounded-prefix blob API. Distinguish mandatory
  returned payload from unnecessary intermediates.
- **Scope.** Retain the active resolution frontier and bounded reusable cache;
  release dead intermediates and batch external bases. Preserve request order,
  prefix progress, missing/type errors, cache byte ownership, and ordinary/paged
  resolution. Measure reinflation cost rather than adding an admission refusal.
- **Acceptance / witness.** With output batch bytes fixed, increasing chain
  length/root count does not retain their combined decoded payloads. Cover
  cold/warm reads, shared/distinct/external bases, mixed types, and error cleanup.
  Add `tests/pack-read-lifetime.test.ts`; run with
  `tests/pack-prefix-selection.test.ts`, `tests/client.test.ts`, and WU3 witnesses.
  Record before/after high-water and inflation/SQL work in WU8.
- **Touch points.** `store/pack/read/read-resolver.ts`, `read-data.ts`,
  `store/pack/read.ts`, existing cache/external-resolver seams.

### WU5 — Bound graph discovery and linearize maintenance (effort L; 63)

- **Problem.** Paging accumulates graph metadata; maintenance repeats suffixes.
- **Verify first.** Count descriptor/frontier growth in deep/wide cold reads;
  count visited chain rows for public maintenance at N/2N depth. Ingest valid
  packs rather than mutating stored rows.
- **Scope.** Bound page metadata and decoded checkpoints. Propose store-owned
  progress if traversal cannot fit a fixed frontier. Make each maintenance edge
  cost constant amortized work per generation. Preserve cycle/depth/source
  checks, physical-only bases, promises, restart ownership, and epoch invalidation.
- **Acceptance / witness.** N/2N witnesses count all visited dependency rows,
  including repeated internal scans, not only statements/output rows. Maintenance
  work is linear within an unchanged generation; interruption resumes and root
  drift restarts before destruction. Read metadata/payload stay inside the
  declared fixed frontier/page envelope. Extend `tests/pack-read-lifetime.test.ts`,
  `tests/maintenance-reachability.test.ts`, and
  `tests/concurrency-maintenance.test.ts`; preserve needed bases through repack,
  loose deletion, and sweep.
- **Touch points.** `store/pack/read/read-graph.ts`, `read-resolver.ts`,
  `store/maintenance/reachability/`, maintenance state/schema if needed.

### WU6 — Bound integration planning and application (effort XL; ARCH-8)

- **Problem.** Planning, projection, and application retain aggregate content;
  raising the 1,000-entry cap alone worsens the failure.
- **Verify first.** Through public merge reproduce 150 distinct binary conflicts
  with 1 MiB current contents; also trace generated text and reused identities.
  Inventory consumers: merge, recursive virtual bases, replay/cherry-pick/revert,
  snapshot replay, and rebase.
- **Scope.** Propose an operation-owned bounded output sink and reference-based
  plan before implementing it. Bound input reuse and generated output through
  projection, journal creation, and worktree writes. Define cleanup before
  publication, rollback, post-publication maintenance roots, continue/abort,
  and cold recovery. The planner is explicitly pure today; changing that
  contract needs the design approval below, not implicit ordinary-object writes.
  The design deliverable includes a consumer ownership matrix naming producer,
  owner, traversal/replay requirements, publication point, and disposal path.
  Explicit rows cover merge-journal ownership reconstruction (validation only),
  snapshot replay's conflict-only return, and virtual-base validation followed
  by materialization, alongside the applying consumers listed above.
- **Acceptance / witness.** The 150-conflict case completes with bounded live
  payload. Public merge and rebase succeed on 1,001 changed paths after replacing
  the old entry materialization cap with a real structural bound. Include long
  valid paths and overlapping blob identities. Real-Git parity covers clean,
  text, binary, mode, structural, virtual-ancestor and replay results, continue
  and abort. Pre-publication faults preserve refs/index/worktree/operation state;
  after publication, generated objects survive reopen and maintenance. Add
  `tests/integration-bounded-output.test.ts`; extend `tests/merge-apply.test.ts`,
  `tests/rebase-restart.test.ts`, and relevant replay/virtual-base tests.
  Existing per-object text limits remain real limits.
  Witness disposal after successful validation, conflict-only return, and
  validation failure; validation-only consumers must not publish ordinary
  objects. Preserve repeatable plan traversal or approve its explicit replacement.
  Generated snapshot and virtual-base output must survive its full consumption
  window and release provisional ownership afterward; output adopted by a
  published result must retain its normal object/root lifetime.
- **Touch points.** `ops/integration/`, `ops/merge/`, `ops/replay/`, `ops/rebase/`,
  `store/operations/` and existing object/scratch seams, all within Git.
  Update operation/reference contracts; preserve package boundaries.

### WU7 — Qualify interrupted and cold workflows (effort M)

- **Problem.** Per-operation tests miss fetch → integration → reopen → cleanup.
- **Verify first.** Locate journey/concurrency hooks for fetch failure, storage
  reopen, rebase conflict, and maintenance interleaving.
- **Scope.** Add `tests/e2e/production-cold-workflow.test.ts` with the real-Git
  journey harness, plus focused fault hooks where Git has no equivalent. Cover
  complete/blobless clone and fetch, cold packed reads, checkpoint refs,
  merge/rebase conflict, reopen, continue/abort, push, and maintenance with
  physical bases and generated operation output still rooted.
- **Acceptance / witness.** Compare public refs, stages, bytes/modes, history,
  and pending state under the existing rebase comparison exception. Interrupted
  fetch/retry never exposes pending-only history. Run affected local composition
  mutation parity. This journey does not replace the consumer workflow or prove
  full workspace backup/restore.
- **Touch points.** `tests/e2e/`, `tests/concurrency-*.test.ts`, `tests/local/`.

### WU8 — Measure the hardening envelope (effort M)

- **Problem.** Static retention proofs are not measured peaks or OOM thresholds.
- **Verify first.** Run `npm run bench:memory -- --runtime-check` to verify its
  self-leased cgroup wiring. Establish comparable baseline fixtures before
  WU4–6 fixes. Stop if lease enforcement is unavailable.
- **Scope.** Extend the memory harness for deep scalar reads, bounded wide/shared
  reads, graph paging, and binary/generated-text integration; record N/2N
  maintenance work. Build fixtures outside measurement, reopen cold, reset
  high-water, and record same-run baseline. Hold output size/layout constant.
  Existing `core.integration.guard-hash` measures the clean-worktree guard, not
  integration planning/application, so it cannot stand in for the new merge
  scenario. The current production graph page is 4,096 entries and depth ceiling
  is 50,000 (`store/pack/shared.ts`); include a fixture crossing the real page
  boundary, separately from reduced-page unit-test seams. Use fixed-size,
  distinct small payloads for graph/depth work and multi-megabyte payloads for
  retention work so fixture generation does not conflate the two costs.
- **Acceptance / witness.** Run `npm run bench:memory` (self-leased),
  `cpu-lease run -n 2 -- npm run bench:statements -- --check`, and
  `cpu-lease run -n 2 -- npm run bench:workerd:nextjs` after fixes settle.
  New memory cases target <100 MiB reset `VmHWM` minus same-run baseline, with
  the separate existing 512 MiB cgroup runaway cap. Record raw process peak,
  baseline, added peak, cgroup peak, SQL/rows, local elapsed time, inflation work,
  dimensions, versions, and lease details. Structural lifetime witnesses must
  pass too. A target miss blocks closure pending explicit user disposition;
  never silently widen a gate or introduce rejection currencies. Report the
  existing clone <160 MiB exception separately. Local workerd does not prove
  the production isolate memory limit. Live deploy/probe requires separate
  authorization and the repository's CI release path.
- **Touch points.** `bench/memory*`, existing workerd workflow qualification,
  `docs/reference/benchmark-current.md`.

## Decisions and implementation design gate

- Scope is the four named correctness/lifetime candidates. The DO workflow is
  the assumption; confirm before broadening to local-specific scaling.
- ADR-0004 trusted reads, ADR-0005 structural bounds, physical pack membership,
  promise semantics, and transaction ownership remain binding.
- **Before WU1/WU3/WU5/WU6 code changes:** record the exact store/schema/lifetime
  contract here, independently review it, and obtain user approval for
  architecture/data-flow changes. Provisional projection storage, persistent
  graph progress, and replacement for the pure integration plan are proposed
  seams, not approved schemas/APIs. Write ADRs for adopted durable decisions.
  No schema migration compatibility is required.
- WU6 is one acceptance unit with internal design → input lifetime → output
  ownership → application/restart steps. A binary-conflict shortcut or increased
  path cap alone does not close ARCH-8.

## Sequencing

### WU1 implementation contract — approved 2026-09-11

Independent step review and user approval are complete for this design.
The accepted ownership decision is [ADR-0022](../decisions/0022-stage-pack-commit-projections-until-publication.md).

- Add `git_pack_commit_staging`, keyed by `(repo_id, pack_id, oid)`, owned by
  `git_pack_meta` through a composite FK with `ON DELETE CASCADE`. Store the
  validated commit projection columns with the same constraints as `git_commits`.
  Share their static column definitions rather than let the two schemas drift.
  Ordinary commit and graph readers continue reading only `git_commits`.
- Keep the existing bounded `PackCommitIndex` buffering and large-commit cache
  eligibility rules. Stage eligible projections while the pack is pending;
  flush object membership before staging. Replace temporary complete→pending
  toggling entirely. Staging accepts only prepared projections backed by the
  exact pack's physical commit membership and matching size. This is a write
  boundary, not ordinary read-time validation. Use an existence predicate so
  duplicate physical occurrences cannot multiply staging input rows.
- Repeated physical commit occurrences have one staging row per exact pack/OID.
  Physical entry counting remains the membership audit's responsibility.
  Track admitted/skipped physical occurrences separately from distinct staged
  rows; deduplication must not turn a legitimate repeat into a count mismatch.
  Eligibility depends on object bytes and therefore agrees for identical OIDs.
- Flush the final pending projection batch before the final publication
  transaction. Within the existing synchronous publication transaction: mark
  the pack complete, run the existing membership audit, promote its eligible
  staged projections into `git_commits`, delete its staging rows, invoke the
  existing lifecycle callback, and release the ingest lease. Failure at any
  step rolls back publication/promotion/staging deletion together.
- Promotion uses `INSERT … SELECT` scoped to the exact pack's staging rows;
  do not return or reconstruct the pack's payloads in JavaScript. A distinct
  staged-row count and scalar count of staged keys covered by `git_commits`
  establish complete promotion without a per-row round trip. `db.run()` returns
  void; do not assume an affected-row result. Conflict-preserving insertion
  counts existing published keys as covered, not as new inserts. Preserve
  already-published projections for duplicate
  OIDs; canonical membership may already belong to another complete pack or a
  loose object. Publication still requires a complete canonical source through
  the existing membership audit. Promotion must not erase a prior valid cache.
- Pending discard, expiry reclaim, repository deletion, and maintenance-owned
  pack cleanup remove staging through pack ownership. A thrown release callback
  or publication hook rolls staging changes back with the pack. Live leases
  still protect staging from another handle's reclaim. No pending staging rows
  are maintenance roots or ordinary cache entries.
- Tests use the existing `GitContext.yieldNow` → pack-ingest yield seam with a
  real Smart HTTP fixture large enough to force projection staging. Observe
  public commit/graph reads with a second handle while paused, abort, reopen,
  reclaim, and retry. The hook may inspect rows to identify the phase; it must
  not mutate stored rows to manufacture a failure. Store tests additionally
  cover duplicate commits and publication/release callback rollback. The
  baseline witness must use a stable indexing phase or recognize HEAD's
  pending-pack/ordinary-projection state; a hook requiring the new staging
  table cannot prove the negative control. Cover both same- and second-handle
  reads and add schema ownership/object/column inventory witnesses.
- **Focused gate:** `cpu-lease run -n 2 -- npx vitest run --maxWorkers=2
  tests/pack-projection-publication.test.ts tests/concurrency-fetch.test.ts
  tests/concurrency-pack.test.ts tests/schema.test.ts tests/pack.test.ts`.
  New coverage must fail against the baseline for pending-only visibility.
  Existing cache eligibility, ordinary trusted reads, and duplicate-source
  tests remain intact. Run routine smoke/typecheck/check before committing WU1.
  The combined five-file gate uses `cpu-lease run -n 4` after the run recorded
  below: two Vitest workers sharing one physical core reproduced an RPC reporting
  timeout despite passing assertions. Tests, worker count, and timeout settings
  are unchanged; four leased vCPU provide two physical cores. Narrow subsets
  retain the two-vCPU lease.
- **Write territory:** one implementation agent owns WU1 changes to
  `packages/git/src/store/schema/schema-object-statements.ts`,
  `packages/git/src/store/trees/commits-cache.ts` and a dedicated sibling helper
  if needed, `packages/git/src/store/pack/pack-ingest-index.ts`,
  `packages/git/src/store/pack/ingest.ts`, and the four named test files other
  than `tests/pack.test.ts` (read/run only unless an existing witness needs a
  reviewed adaptation). Any additional production file is reported before
  editing. The leader owns sprint/ADR/reference/index documentation and commits.
- **Execution:** single working tree/current branch; one implementer followed
  by a separate reviewer, with leader-run gates and one verified WU commit.
  No concurrent implementation in shared pack/schema files. WU2–5 follow their
  existing serial dependencies; WU6 remains behind its own design gate.
- **Step review:** approved by independent general agent
  `ses_f74328613ffedAiy3A7QwgeM4P` on 2026-09-10, no blocking findings. Clarified
  promotion coverage accounting, nonmultiplying physical admission, and the
  baseline test hook from review notes. **User approval:** granted 2026-09-11,
  including sequential implementation/review agents and per-unit verified commits.

### WU3 integration contract — approved 2026-09-21

The user approved this reviewed schema and lifecycle contract on 2026-09-21.
Prototype evidence is recorded in the run log; it does not
establish production cost or maintenance restart semantics.

**Source invariant.** Traverse canonical `git_pack_objects` directly, with a new
partial reverse index `(repo_id, base_oid, oid) WHERE base_oid IS NOT NULL`.
Do not add a second canonical graph projection. A visible complete packed source
wins during dependency traversal; a loose object is a terminal only without that
packed source. Pending packs and promises cannot supply published dependencies.
Every visible chain must terminate, preserve object type, and have at most
50,000 delta edges. A full object has depth zero. Existing ordinary loose-shadowing
and physical OFS offset resolution retain their separate meanings.
Both forward and reverse traversal must join canonical owners to complete pack
metadata. Never choose arbitrary physical fallback entries during validation;
the existing deterministic surviving pack/offset policy owns fallback selection.

**Proposed transaction-local storage.** Add an operation owner
`git_pack_graph_operations(repo_id, op_id)` with a composite primary key and
repository cascade. An internally allocated unique token identifies each nested
operation. Three child tables reference that owner with cascading deletion:

| Table | Payload beyond owner | Keys / indexes |
|---|---|---|
| `git_pack_graph_affected` | `oid`, `pending`, `cursor` | owner + OID PK; owner + pending + OID index |
| `git_pack_graph_memo` | `oid`, `depth`, `type` | owner + OID PK |
| `git_pack_graph_path` | `oid`, `position` | owner + OID PK; unique owner + position |

Use existing OID/type constraints, 0/1 pending state, empty-or-OID cursors, and
nonnegative safe integer depths/positions. Create and remove owner-scoped state
inside the existing `transactionSync()`; successful admission leaves no rows,
and rollback restores the previous candidate and scratch state. Never clear
another operation's rows. This bounds live JavaScript metadata, not total SQL
scratch storage: storage grows with affected nodes and visited suffixes.

**Execution.** Adapt the reviewed prototype's internally bounded 256-row reverse
lanes, forward pages, batched writes, exact depth memo, and indexed disjoint path
unwind. Scope every seek by repository and operation. Within-page cycle state
stays page-sized; cross-page path membership lives in SQLite. Measure production
visibility joins and query plans rather than assuming identical prototype cost.
The statement target remains report-only.

**Candidate boundaries.** Seed canonical OIDs becoming visible at pack
publication. The deletion seam must cover ordinary complete deletion,
`discardOwnedComplete`, `discardPending`, and automatic reclamation/reservation
cleanup. Supported writers ensure that any complete physical occurrence has a
complete canonical owner: pending insertion cannot replace an existing owner,
and membership audit rejects competing publication behind a pending owner.
Keep pending cleanup in the common validated deletion seam. Within its transaction:

1. Capture all old canonical OIDs owned by the entire deletion batch, including
   pending-owned rows and removed sources without fallback.
2. Promote all fallbacks, excluding the entire deletion batch.
3. Preserve `authenticateLooseDeltaBases` before each storage removal, while
   doomed canonical metadata still exists. Its surviving physical/pending
   consumers are not covered by canonical graph validation.
4. Validate the final graph once, after all requested storage removals. Surviving
   reverse dependents must reject a missing terminal. Delete scratch and commit.

Replace only the promotion-only termination check. Do not validate intermediate
deletion states or move physical authentication after its evidence is deleted.
No new graph hooks are needed for loose insertion (adds terminals, not edges),
repack loose removal (existing checks require complete canonical replacements),
or loose sweep (physical/pending dependencies already pin needed terminals).
Redundant-pack removal during repack reaches the same validated deletion seam.
Repository deletion removes the entire graph through ownership.

**Publication order.** Final commit-staging flush remains outside publication.
Inside its existing transaction: verify lease, mark complete, audit membership,
validate the candidate graph, promote commit projections, clear admission scratch,
invoke publication callback, release lease. Failure must roll back visibility,
projections, and source changes together. Preserve existing error conventions,
reentry behavior, and cache invalidation. The valid-prior-graph premise starts
with the empty fresh schema and must be maintained by every relevant writer;
there is no migration or ordinary read-time validation pass.
Clear the operation owner before invoking the callback; never reuse an outer
memo after callback mutation. Supported nested source mutations validate through
their own owner against a valid graph. Preserve synchronous callback checks and
existing lease/pool cleanup. Publication uses existing invalid-pack errors;
deletion that would break surviving dependencies returns `EBUSY`.

**Depth test seam.** Pass the existing bounded `maxDeltaDepth` option to admission
as well as reads; production remains 50,000 edges. Reduced-limit fixtures start
with fresh repositories and keep the same limit across handles. Reopening an
existing database with a smaller test limit does not establish the valid-prior
premise at that limit. Split ingest rejection from later cold-read assertions;
the current combined rejecting promise is not a pre-publication witness.
Keep actual 50,000/50,001-edge tests in addition to reduced-limit tests.

**Size contract.** Remove the modeled 256-byte wrapper charge. Retain the shared
48 MiB logical base + inflated instructions + target bound because cold decoding
materializes instructions. Separately retain the real chunk-allocation guard;
do not replace allocation constraints with a new aggregate accounting currency.
Require immediate/deferred, OFS/REF, streamed, and external-base witnesses around
exact logical and chunk-rounding boundaries.

**WU3 implementation territory and witnesses.** One implementer owns new
`packages/git/src/store/pack/graph/` helpers and
`schema/schema-pack-graph-statements.ts`, schema assembly/inventory updates,
`pack/packs.ts`, `pack/ingest.ts`, `pack/shared-delta.ts`, and
`pack/lifecycle/` wiring. Any additional production file requires a reported
reason before editing. Preserve generic read behavior and WU1/WU2 fixes.
Add `tests/pack-cold-admission.test.ts`; adapt existing pack, concurrency, schema,
and physical-membership witnesses only where this contract requires it.
Tests must cover pending ownership blocking competing publication with ESTALE,
later pending ingestion preserving existing complete ownership, and discard,
reclaim and reservation cleanup after rejected publication. Cover reachable
complete-owner fallback cycles, publication substitutions, final-batch repair
and deletion ordering, physical/pending base protection,
nested callbacks, failure rollback, exact depth, logical-size and chunk bounds,
and cold reopen. Produce baseline failures through real pack ingestion, not
fabricated stored rows. Native Git remains the byte/format oracle; the local
depth ceiling has separate explicit assertions.

Focused command: `cpu-lease run -n 4 -- npx vitest run --maxWorkers=2
tests/pack-cold-admission.test.ts tests/pack.test.ts
tests/pack-physical-membership.test.ts tests/pack-projection-publication.test.ts
tests/concurrency-pack.test.ts tests/concurrency-fetch.test.ts tests/schema.test.ts`.
Also require the existing maintenance-caller regression gate before the WU3
commit: `cpu-lease run -n 4 -- npx vitest run --maxWorkers=2
tests/maintenance-repack.test.ts tests/maintenance-sweep.test.ts
tests/concurrency-maintenance.test.ts`. This checks WU3 deletion/reclaim callers,
not WU5's future progress implementation.
Run routine smoke/typecheck/check and independent implementation review before
the WU commit. Production statement/internal-work qualification remains required
by the sprint; the prototype is not a substitute. Preserve WU4/WU5 before-memory
fixtures before changing their lifetime paths.

**Step review.** `ses_f6eb754c6ffevaAs2qUj5AoOlB` found three contract gaps:
pending reclaim can change the effective graph; physical authentication must
precede storage removal even when graph validation follows the whole batch;
and admission must explicitly share the reduced depth test seam. This revision
addresses all three and removes unnecessary loose-write/sweep hooks. Re-review
approved the contract for the user gate after adding the three existing
maintenance-caller suites above. No algorithm, schema, lifecycle, or territory
blockers remain. User approval of this exact integration contract was granted
on 2026-09-21 with the instruction to continue and complete the sprint.

**WU5 remains a separate design gate.** Transaction-local validation does not
establish resumable maintenance. A later read-progress owner may share narrow
canonical decoding and bounded traversal helpers, but requires explicit snapshot,
nested-read, and cleanup semantics after WU4 settles payload lifetime. Durable
maintenance memo/path/progress must be run-owned and reset when its source
assumptions change. Source changes without ref changes and maintenance-owned
repack/fallback transitions need an explicit invalidation/settlement rule before
that schema is approved. Do not infer it from the prototype or reuse admission
rows across transactions.

| Order | Work | Dependency / ownership |
|---|---|---|
| 0 | Approve plan; establish WU8 baseline fixtures | Clean independent plan review before implementation; memory baselines precede fixes |
| 1 | WU1 | Settle provisional publication before further ingest changes |
| 2 | WU2 → WU3 | Same pack/projection files; serialize edits |
| 3 | WU4 → WU5 | Same resolver seam; run WU4-specific after-measurements when WU4 settles, before its completion gate |
| 4 | WU6 | Can proceed independently after design gate; revalidate against WU3–5 |
| 5 | WU7 → finish WU8 | Integrate settled units, qualify semantics, then final measurements |

WU8 supplies baseline and per-WU measurement work throughout the sprint; it is
not a dependency postponed entirely until closure. WU4's own lifetime scenarios
must pass before WU4 is complete. WU5/WU6 receive their corresponding measurements
when settled, followed by final integrated qualification after WU7.

Read-only research can overlap. Parallel implementation is optional and requires
explicit disjoint write ownership and authorization. Benchmarks run under leases
without competing measurements.

## Review strategy

Each fundamental WU receives independent review after its focused witnesses.
Resolve blocking findings and re-review semantic fixes until clean. Naming/docs-
only follow-ups need direct inspection unless they change a contract or claim.

| Scope | Risk | Required gate and independent review | Escalate when |
|---|---|---|---|
| WU1 | Publication/visibility | New projection-publication + concurrency fetch/pack; store/publication review | Read semantics, schema ownership, reclaim contract changes |
| WU2 | Membership/source identity | Physical-membership + tree-index tests; pack review | Source selection/deletion or parser validation changes |
| WU3 | Cold-readable admission | Cold-admission + pack + membership tests; ingest/read review | Depth policy or physical/canonical mapping changes |
| WU4 | Payload ownership | Read-lifetime + prefix + client + WU3 tests and WU8; lifetime review | Result contract or cache ownership changes |
| WU5 | Traversal/destruction | Read-lifetime + maintenance reachability/concurrency; lifecycle review | Epoch, sweep, promise or physical-root rules change |
| WU6 | Cross-operation recovery | Bounded-output + integration/merge/replay/rebase; all-consumer/fault review | Planner purity, public types, schema or transaction boundaries change |
| WU7 | Cross-WU correctness | New journey + E2E slice + affected local tests; integration review | Existing parity comparison must be narrowed |
| WU8 | Measurement validity | Lease/cgroup, new cases, frozen SQL gate, workerd workflow; measurement review | Missing before data, changed fixture, target miss |
| Integration | Admission → read → integration → cleanup | Clean review, WU7/8, typecheck/check, then exhaustive suite | Out-of-scope defect or architectural deviation |

## Test cadence

- **Per WU:** `cpu-lease run -n 2 -- npx vitest run --maxWorkers=2 <exact test
  files named by that WU>`. New paths above are deliverables, not existing
  witnesses. WU6's existing consumer witnesses include `tests/replay.test.ts`,
  `tests/snapshot-replay.test.ts`, `tests/integration-virtual-base.test.ts`,
  `tests/merge-lifecycle.test.ts`, and `tests/concurrency-operations.test.ts` in
  addition to its named focused tests. WU7's local command is
  `cpu-lease run -n 2 -- npx vitest run --maxWorkers=2 tests/local/git-parity.test.ts
  tests/local/restart.test.ts`. Extend these witnesses for new lifetime behavior;
  their existing small cases alone do not prove the new scale acceptance.
- **Routine:** `cpu-lease run -n 4 -- npm test`, target <30 seconds;
  `cpu-lease run -n 2 -- npm run typecheck` and `npm run check` after an integrated
  unit. FS/shell slices only when a domain is crossed.
- **Cross-layer:** `cpu-lease run -n 4 -- npm run test:e2e` and affected local
  witnesses at WU7. Preserve parity exceptions and ownership assertions.
- **Closure:** after review/focused fixes settle,
  `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run -n 4 -- npm run test:full`
  once. Reproduce failures by exact file/slice before any exhaustive rerun.
- **Memory:** baseline early; after data when affected fixes settle. The memory
  runner leases itself; do not nest it inside a lease. No full benchmark reruns
  for unrelated small edits.

## Out of scope (explicit)

- Consumer wiring, full backup/restore proof, deployment: external integration
  gate. [17](../backlog/17-integrity-audit-and-snapshots.md) stays separate.
- [75](../backlog/75-bound-network-authentication-payloads.md),
  [76](../backlog/76-bound-full-tree-construction.md),
  [79](../backlog/79-bound-materialized-status-and-config-reads.md), the ref
  threshold and other findings in 65 remain production candidates to assess
  against the real workload, not implicitly fixed by this sprint.
- [77](../backlog/77-remove-repeated-local-traversal-work.md),
  [78](../backlog/78-make-sql-cursors-seek-and-deliver-incrementally.md),
  [80](../backlog/80-restore-import-graph-domain-guarantees.md),
  [81](../backlog/81-copy-object-bytes-only-when-retained.md), general ledger
  removal, schema normalization, unrelated sweep costs. If one blocks a declared
  witness, report the overlap and ask before expanding.
- Additional Git parity, outbound delta compression, API cleanup, full
  architecture remediation. Green tests alone do not establish production readiness.

## Plan review

- **Reviewer:** independent general agent, session
  `ses_f743fd924ffeZwxHetlb1MIsx4`.
- **Verdict:** approved after a second independent pass on 2026-09-10; no
  remaining blocking findings. Implementation design gates remain in force;
  WU1 implementation authorized on 2026-09-11.
- **Material findings:** canonical graph admission must protect previously
  published dependents, not just incoming physical chains (WU3); validation-only,
  conflict-return, and repeated-traversal consumers need explicit output lifetime
  witnesses (WU6). Both requirements are now included. The measurement timing
  ambiguity is resolved by per-WU after-measurements before completion. Exact
  replay/virtual-base/local test selection is recorded in Test cadence; re-check
  that selection against the adopted WU6 design before implementation.

## WU5 integration contract — draft 2026-09-21

The user selected SQL read scratch plus immediate-edge maintenance discovery.
Exact snapshot, generation and repack settlement semantics below require review
and approval before implementation.

### Cold-read scope

- One internal synchronous read scope covers source selection, bounded blob
  prefix selection, graph discovery and payload consumption. Public packed reads,
  pending resolution and source authentication all enter it. Do not scope only
  `PackGraphPager`, because loose/packed metadata selection happens earlier.
- Owner-qualified SQL rows replace cumulative page descriptors, origin checkpoint
  sets and reverse replay metadata. Keys include repository and unique read ID;
  nested reads have distinct owners. Keep existing bounded graph pages and WU4's
  bounded payload lifetime. No scratch cursor or reference escapes the call.
- Use `transactionSync()` without reacquiring the public mutation guard, so reads
  within guarded operations continue to work. On local SQLite this reserves the
  writer lock even for a cold read. Cleanup deletes only this owner before return.
  Respect abort-only nested adapters; do not catch a failed transaction and claim
  the enclosing operation can safely proceed.
- A durable repository source generation identifies the selected sources. Check
  generation around external resolver callbacks and before returning. A callback
  that changes sources causes `ESTALE` and rollback of the read scope, including
  its nested writes; do not silently retry user callbacks. Revalidate caches on
  rollback through the existing coordinator. Pure nested reads remain supported.
  Review must verify this error fits current resolver contracts and enumerate
  every callback seam; transaction isolation alone is not a reentry guarantee.
- Keep canonical/pending visibility, supplied seeds, authentication cache bypass,
  expected types, allowed missing roots and request-prefix ordering per invocation.
  WU3's complete-graph invariant does not justify dropping checks for pending or
  authenticated physical reads.

### Maintenance discovery and source drift

- Trust WU3 admission for canonical complete-graph acyclicity, type and depth.
  Expand only the immediate physical dependency through existing run-owned queue
  state, rather than checking a complete suffix for each queued OID. Existing
  physical-only and pending-source protection remains independently enforced.
- Persist the source generation observed by each run alongside its root epoch.
  Source changes must invalidate already-expanded dependency assumptions even
  when roots and promises are unchanged. Generation covers canonical publication,
  fallback selection/deletion and loose-source availability changes relevant to
  reads/discovery. Define pending source coverage explicitly at review.
- Central state decoding, reset, owned-batch settlement and destructive gates
  compare both identities. On external drift, settle the existing owned repack
  batch, clear run-owned discovery and restart before further destruction.
- Maintenance-owned source changes need explicit progress reconciliation, not an
  unconditional restart after every repack. The proposed rule is to adopt the new
  generation atomically only for a batch whose replacement introduces no new
  dependency outside the existing marked closure; otherwise settle and restart.
  Review must identify the exact existing full-object repack invariant or replace
  this rule with a concrete bounded reconciliation. No generic exemption for
  maintenance writes is permitted.

### Remaining review gates

Specify source-generation mutation owners, read-scope entry points, exact scratch
schema, rollback/cursor behavior on both adapters and the repack reconciliation
proof before calling this contract implementation-ready. Current root epoch and
in-memory pack cache counters are insufficient substitutes.

Acceptance includes nested reads, rejected source-changing callbacks, pending
authentication, local rollback cursor semantics, cold resume after every durable
maintenance boundary, source-only drift and owned-repack drift without infinite
restart. Measure descriptor/checkpoint maxima and N/2N dependency work with native
SQL instrumentation; emitted rows and statement counts alone do not establish
bounded internal work. Keep WU3 lifecycle and WU4 payload regressions in the gate.

## WU6 integration contract — approved 2026-09-21

The user approved this exact scoped SQL storage contract on 2026-09-21 after
independent review by `ses_f3ba1e6d7ffeACQblIaRyWZc0c` found no remaining blockers.
Implementation and behavioral verification remain required.

### Ownership and visibility

- Internal `withIntegrationWorkspaceOwned` owns one repository-qualified,
  uniquely identified integration workspace. Its creation, use and deletion
  run inside `transactionSync()` and the existing mutation/scratch coordinator.
  It never reacquires the public mutation guard. Planners take the capability
  explicitly and return scoped handles. The callback encloses every consumer,
  adoption, index/worktree/journal change and final commit/ref publication.
  Replay reconstruction cannot return a live plan after closing this callback;
  keep continuation inside it or return detached typed metadata only.
  A caught nested failure poisons the enclosing scratch transaction; asynchronous
  callback results fail using the existing synchronous-callback convention.
- Owner-qualified child tables hold output object metadata/chunks, parsed
  virtual tree edges, ordered plan/projection records, and path reservations.
  Foreign keys cascade from the owner and repository. No ordinary object,
  projection, promise, or maintenance query can see these provisional rows.
- Store contracts expose typed storage capabilities, not ops classification
  rules. Store owns descriptor contracts; ops owns their classification. Store
  reads refine driver values using shared decoders; writes establish invariants.
- The callback capability is revoked on all exits. No scoped reference can be
  put into a durable journal, returned public result, cache, or another owner.
  Nested scopes have distinct owner IDs. Successful cleanup precedes transaction
  completion; exceptions roll back scratch and application together.
  Preserve the outer local recovery boundary: nested rollback does not itself
  undo disk writes, and a nested failure with disk effects makes it abort-only.

### Storage and API seams

All workspace child keys begin with `(repo_id, workspace_id)` and cascade from
`git_integration_workspaces`. IDs for plans are allocated within one live owner.
The workspace never survives successful callback completion.

| Table suffix (prefix `git_integration_`) | Remaining key / stored fields | Traversal/index |
|---|---|---|
| `workspaces` | Owner primary key | Repository FK; owner-qualified deletion |
| `objects` | `oid`; `type`, `size` | Owner/OID point metadata lookup |
| `object_chunks` | `oid, seq`; `data` | Object FK; ordered chunk traversal |
| `tree_entries` | `tree_oid, ordinal`; `name`, `mode`, `child_oid` | Object FK; unique owner/tree/name; tree-order traversal |
| `plans` | `plan_id`; `kind`, `source_rows`, `entry_count` | Owner/plan header |
| `plan_entries` | `plan_id, path`; typed descriptor JSON | Plan FK; BINARY path keyset; no embedded payload bytes |
| `reservations` | `plan_id, family, path`; typed ownership/collision metadata | Plan FK; exact/prefix membership and BINARY traversal |
| `touched` | `plan_id, ordinal`; `path`, `logical_path`, `purpose`, typed snapshot fields | Plan FK; unique plan/path; ordinal keyset |

The concrete descriptor discriminated unions and codecs belong to the store's
integration-workspace contract and are imported by ops; they must not be an
unstructured JSON container. Ops retains classification and projection behavior.
Descriptor writes parse once at this boundary. Stored rows use shared shape
decoders, without read-time reauthentication. `kind` distinguishes structural,
resolved and projected plans so the handle returns the corresponding concrete
record type, not unchecked casts. Scratch objects permit only blob/tree types.

`withIntegrationWorkspaceOwned(store, body)` passes a revocable capability with
typed plan writers, repeatable plan traversal, reservation/touched storage, scoped
object writes and the narrow integration source reader. Entry points
`planIntegration`, `planVirtualAncestorIntegration` and `planReplay` receive that
capability explicitly. A plan handle contains its scoped identity and scalar
counts and exposes repeatable ordered traversal; it has no retained entry array.
All handles and cursors check that their owner is active. Drain/close cursors
before cleanup; no lazy reader escapes the callback.

Source reads expose `objectInfo`, bounded-prefix `readBlobs` and ordered tree
traversal for ordinary or explicitly scoped tree identities. A workspace object
can resolve only within its owner; ordinary sources remain the fallback for OIDs
not produced there. Adoption walks published references while the workspace is
live and uses existing ordinary object writers, including normal projections.
It does not adopt every temporary object indiscriminately.

Operations-store internal consumers use `readOperationHeader`,
`iterateOperationTouched` and streamed touched-write/replace capabilities. Existing
public APIs that explicitly return complete operation state may materialize that
mandatory result, but internal application, validation, continuation and abort
must not call those materializing readers. Remove the implicit 1,000-row refusal
from public journal decoding too; an operation accepted with 1,001 paths must
remain readable after reopen.

### Bounded planning and repeat traversal

- Classify three ordered tree streams into SQL-backed descriptors. Replace
  whole-plan arrays, global payload-use maps, path reservation sets and sorted
  output arrays with replayable keyset pages and indexed path membership. Use
  fixed 256-record metadata batches and SQLite `BINARY` path order, preserving
  `comparePaths` at JavaScript merge boundaries.
- Load candidate inputs in bounded-prefix blob batches. A fixed reusable cache
  may reread evicted shared identities; last-use counts must not pin all inputs.
  Retain only the active candidate inputs, the fixed read window/cache, and its
  output. Write generated bytes to scratch immediately and release them before
  advancing. Reuse existing object chunk sizes and object/hash codecs.
- Plans carry object identities and scoped content references rather than
  `Uint8Array`s. Repeated descriptor traversal does not repeat text merging.
  Projection uses streaming lookahead for file/directory groups and SQL-backed
  reservations/collision membership. Materialize sorted projected descriptors
  into the same workspace for repeat application and journal validation.
- Preserve existing text/object limits and caller validation. Do not introduce
  an aggregate payload admission cap. Replace the 1,000-entry materialization
  ceiling throughout planning, touched-path expansion, journal writing/reading,
  reconstruction and application with paged ownership. Do not merely raise it.
  Audit every remaining count/byte cap against its actual protected resource;
  changing an unrelated API limit requires a separate decision.

### Journal and caller-limit contracts

- Add metadata-only operation header/cursor reads and repeatable keyset touched
  traversal by `(checkout_id, ordinal)`. Keep `touched_count` in the header;
  neither `readRebaseCursor` nor ownership reconstruction materializes all rows.
- Write, validate, replace and restore touched records through iterables/pages.
  Snapshot drafts and touched membership belong to workspace SQL, including
  ancestors and relocations. Preserve current first-insertion ownership in
  canonical projected path order; explicit and ancestor collisions must not
  silently replace their original logical path/purpose.
- Bound transport pages by both 256 records and the existing `jsonPages` byte
  policy. A long valid path must not cause an arbitrary component limit or a
  whole-operation allocation. Apply the same paging to abort and restoration.
- `ReplaySnapshotResult.conflicts` and required conflict-message strings are
  detached mandatory output. The separate whole-plan conflict-kind lookup map
  is not: replace it with ordered traversal or a workspace join.

| Limit | Proposed default | Explicit caller contract |
|---|---|---|
| `maxSourceRows` | Existing 200,000 | Preserve safe integers 0–200,000 and existing failure behavior |
| `maxEntries` | No implicit 1,000-entry materialization refusal | Preserve currently accepted explicit safe integers 0–1,000, counting logical plan entries rather than SQL pages |
| `maxStructureBytes` | Absent | Preserve explicit nonnegative safe-integer limit and existing accounting semantics |
| `maxPlanBytes` | Absent | Preserve explicit nonnegative safe-integer limit, including content length and current logical entry/path accounting; do not count only descriptor storage |
| Text/object limits | Unchanged | Preserve current validation, output limits and error semantics |

The retained explicit byte options are caller-requested ceilings, not evidence
of actual RSS. They do not become default admission ledgers. Removing their
existing modeled accounting would be a separate contract change.

### Virtual sources and application

- Introduce an explicit integration source capability for object metadata,
  bounded blob reads and parsed tree traversal. It composes the ordinary repository with this workspace's
  virtual sources. Ordinary repository reads remain unchanged; no ambient
  current-owner lookup or temporary ordinary-object publication is permitted.
- Virtual tree construction writes scratch objects and parsed edges. Selection
  and integration consume those scoped sources, including validation followed
  by materialization. Preserve the existing virtual-base recursion bound and
  Git identities, labels and conflict rules. Return a tree identity/source;
  do not add a virtual commit reader. Reject unsupported additional synthesis
  before a synthetic commit can reach ordinary graph lookup. Preserve the
  single-synthesis acceptance boundary; review the error precedence explicitly.
- Applying consumers explicitly adopt generated objects into the ordinary store
  only within their existing publication transaction. Stream adoption and
  `writeFiles` batches; do not rebuild a whole-operation inline payload array.
  Adopt every scratch-backed OID published into index stages 0–3 and every
  scratch-backed dependency reachable from a published tree/commit, before
  publishing those consumers. This includes a virtual-base blob becoming the
  final conflict's stage-1 identity. Promise fulfillment happens only at ordinary
  publication.
- Adopted output has normal index/tree/commit roots. Do not add a generated
  worktree-only conflict root family: continuation reconstructs ownership and
  commits the resolved index; abort uses saved pre-operation roots. Worktree-only
  generated bytes can be copied directly from scratch without ordinary adoption.
- No provisional virtual object needs to survive callback exit unless explicitly
  adopted into a published result. Cold journal reconstruction builds a new
  workspace and must leave no ordinary virtual object behind.

### Consumer ownership matrix

| Consumer | Scope / traversal | Publication and disposal |
|---|---|---|
| Merge | Base synthesis, plan, both collision projections, validation and apply share one scope | Adopt in existing object/index/worktree/journal/ref transaction; discard on compatibility rejection or failure |
| Cherry-pick / revert | Replay planning through final application | Adopt on application; empty and error paths discard |
| Rebase applying step | One workspace per existing step transaction | Adopt index/tree dependencies before step publication; existing roots retain them; skipped/empty steps discard |
| Replay/rebase ownership reconstruction | Scope includes every consumer of the reconstructed plan | Validation only; no adoption; dispose after comparison, including failure |
| Merge-journal reconstruction | Includes recursive base synthesis and repeated projection | Validation only; neither outputs nor virtual objects become ordinary objects |
| Snapshot replay | Plan through conflict enumeration or clean tree publication | Conflict-only return discards; clean result adopts inside the transient-index/tree transaction |
| Recursive virtual base | Identity validation, tree construction and enclosing integration remain in the parent scope | Provisional source survives both traversals; only published dependencies are adopted |

### Review and measurement gates

Review must settle exact workspace table/API ownership, journal paging and public
result boundaries, virtual source breadth, and operation-root invalidation before
this contract is approved. Fixed pages must cover ancestors/relocations and long
valid paths, not just changed leaves. Public result arrays, if required by an
existing API, must be identified as mandatory output rather than hidden scratch.

Freeze public 75/150 binary-conflict fixtures and generated-text fixtures before
implementation. Acceptance retains all WU6 parity and fault gates, including
1,001-path merge/rebase, distant shared-input reuse, validation-only object counts,
snapshot conflict returns, repeated virtual traversals, revoke/nested-failure
checks, maintenance during suspended conflicts, cold continue and abort. Measure
active input/output, copies and caches separately; unchanged per-object limits
do not imply that every legal single candidate fits the 100 MiB target.

## Run log

- 2026-09-22: WU6 integration is behaviorally green after four defects were
  fixed. The shared worktree walk lost the non-advancing-cursor guard when merge
  apply moved onto it, so a drive that ignores the scan cursor looped forever;
  the guard is now `CorruptError` in `worktree-io-walk.ts`, where the paging loop
  lives, and covers every walk consumer. `applyProjectedMerge` widened its
  outcome literal to `string` and failed typecheck. Two witnesses encoded the
  ceiling this contract removes: `merge-apply`'s structural-ancestor case now
  requires a 1,000-component path to apply, round-trip and abort, and
  `merge-state`'s journal case no longer asserts the deleted
  `MAX_MERGE_TOUCHED_PATHS`. The dead constant, `worktreeSnapshotScan`,
  `indexSnapshots`, `applyDestructiveRoots`, `structuralRemovals`,
  `materialiseWrites`, `validateSourceBlobs`, `restoreWorktree`,
  `abortDestructiveRoots` and their types are removed. Stale inventories updated:
  the trusted-read policy scopes for the new journal readers, the store facade
  surface, and the schema table list (WU1 staging, WU3 graph, WU6 workspace).
  Typecheck and repository Biome pass.

- 2026-09-22: A committed WU3 regression is recorded as
  [backlog 82](../backlog/82-restore-clone-statement-target-after-graph-admission.md)
  and blocks sprint closure. One public 24,252-file clone costs 1,264 SQL
  statements at `491189b`, against 784 at `2af7f69`, so
  `tests/clone-initial.test.ts` fails its unchanged <1,000 assertion. Bisected
  over detached worktrees at `7b958e0`, `187b9dd`, `e0c34d9`, `2af7f69` and
  `491189b`; only `491189b` fails, and the counts come from replacing the
  assertion with `toBe(-1)` on the same fixture. WU3's recorded 673-statement
  reclaim measurement does not cover this witness. The user directed that WU6
  continue and that WU3 receive its own unit; no admission constant was changed
  and the failing assertion was not relaxed.

- 2026-09-21: WU3 landed as `491189b`; design rationale →
  [ADR-0023](../decisions/0023-validate-canonical-pack-dependencies-at-source-changes.md).
  The independently approved source-less starting-root filter reduces the actual
  reclaim witness from 1,185 to 673 statements, preserving all 65,536 reverse
  seeds and the unchanged <1,000 alarm. Leader passed the seven-file 108-test
  focused gate, typecheck and scoped Biome; smoke passed 160 tests in the working
  tree (including one concurrent WU6 journal witness). Implementer passed 53
  relevant pack and 51 maintenance-caller tests. Global Biome currently reports
  formatting only in active WU6 edits. Native internal-work qualification remains
  with WU8; emitted counters do not establish it. WU1–WU4 implementation is now
  complete. Leader then assembled the eight approved WU6 workspace tables and
  schema inventories; all 25 schema tests pass, unblocking runtime integration.

- 2026-09-21: WU3 implementation reviewer `ses_f3b7f4ee6ffeyZNT5U9Ud8e6o6`
  found no production correctness defects and passed three independent
  concurrency witnesses. User approved correcting the unreachable pending-shadow
  cycle acceptance: supported insertion, membership audit and complete-only
  fallback promotion preserve a complete canonical owner for every complete
  physical occurrence. The contract now requires direct witnesses of these
  invariants, all pending cleanup routes, and reachable complete fallback cycles.
  Common pending graph validation is retained. The 1,185-statement cost alarm
  still blocks closure pending production cost diagnosis/disposition.

- 2026-09-21: Independent WU6 re-review approved the exact workspace, adoption,
  virtual-source, journal and limit contracts with no remaining blockers. User
  explicitly approved implementation. Preserve E2BIG for unsupported additional
  virtual synthesis, and keep every replay-plan consumer inside its owning scope.
  Implementation must coordinate shared schema assembly with the active WU3
  owner rather than editing the same seam concurrently.

- 2026-09-21: WU6 frozen public-merge baseline at `dd0005c` completed under
  enforcing two-vCPU leases and zero-swap 512 MiB cgroups. Binary 75/150 distinct
  1 MiB conflicts add 153.77/287.29 MiB process HWM; both miss the target. The
  150-file case records 1,657 cgroup memory-max events but no OOM/kill, so its
  11.76 s includes reclaim pressure. Native byte/mode/stage/HEAD oracles pass.
  Clean text 32/64 cases add 34.82/38.62 MiB; marker cases add 32.95/40.53 MiB.
  A 1,001-path public merge fails with expected E2BIG and preserves initial state.
  All packs use full objects, isolating these fixtures from WU4 delta retention.
  Published-object counts remain 102→102 in separate planning witnesses and
  134→134 in journal validation; these do not qualify every virtual consumer.
  Source audit covers all 927 archived files. Scripts, fixtures, raw results and
  limitations live in ignored `bench/results/integration-baseline-2026-09-21/`.
  These are single-sample public-operation measurements, not planner-only
  attribution, stable timing estimates or completion of WU6.

- 2026-09-21: WU4 landed as `2af7f69`. Reviewer
  `ses_f3b9c2ae4ffe7EMpZrTEglvngP` approved payload lifetime and external windows,
  and verified frozen source/harness identities. Leader passed 55 lifetime/prefix/
  client tests, 159 smoke tests, typecheck and scoped Biome. Repository-wide
  Biome currently reports only formatting in concurrently edited WU3 files;
  those remain with their implementer. Four behavioral negative controls fail
  against the old resolver. Scalar sixteen-edge added peak changes from 136.41
  to 88.20 MiB in single-sample Node observations, with 17 inflations and unchanged
  SQL counts. This is not a robust RSS ceiling or Worker-isolate qualification.
  Reproducible evidence is in ignored `bench/results/packed-read-after-2026-09-21/`.
- 2026-09-21: WU5 design reviewer `ses_f3b9e4d73ffeICHWBEUjLSPyn1` withheld
  approval pending exact generation owners, maintenance self-drift reconciliation
  for every finalization/sweep path, read callback/error scope, coordinator/cache
  settlement and scratch keys/indexes. Packed-first physical dependency selection
  must remain distinct from loose-first logical reads. Implementation stays gated.

- 2026-09-21: WU6 design reviewer `ses_f3ba1e6d7ffeACQblIaRyWZc0c` withheld
  approval pending exact APIs, journal paging, limit semantics and virtual-source
  ownership. Draft corrections now name the owned callback extent, local outer
  recovery boundary, metadata-aware virtual source and adoption of all published
  index stages. Removed the proposed extra conflict-output root family: no
  consumer requires worktree-only generated blobs after scratch disposal.
  Journal schema/API and explicit limit policy remain unresolved; implementation
  stays gated and the revised contract needs another independent review.

- 2026-09-21: User selected WU5's direction for detailed design/review: scoped
  SQL cold-read metadata and immediate-edge maintenance expansion trusting WU3's
  admitted canonical graph. This does not yet approve read snapshot/reentry or
  durable source-generation semantics. Local read scratch would acquire the
  adapter's writer reservation; root epoch alone misses source replacements.
  Physical/pending-base protection remains independent of canonical admission.

- 2026-09-21: Reconstructed WU3 traversal passed 1,500 oracle mutation batches,
  actual depth boundaries, and unrelated-source isolation. Independent reviewer
  `ses_f3ba87822ffeUNR4fd9C900wbL` approved after 176 additional admissions,
  including forward concatenation and cross-root active-path reuse. Integration
  is now proceeding against the approved lifecycle contract. The 256-record
  recursive limit bounds admitted records/live queue, not all speculative record
  construction or native VM work. Production must retain synchronous callback
  checks absent from the prototype adapter. Lifecycle wiring and native internal
  work remain separate qualification gates.
- 2026-09-21: User selected operation-scoped SQL output storage as the WU6 design
  direction over deterministic recomputation. This approves preparation of the
  exact contract and independent review, not implementation of unresolved
  virtual-source or durable-root seams. Frozen public-integration memory
  baselines are being prepared before production changes.

- 2026-09-21: Pager join-order prerequisite is verified. Seven inner joins now
  explicitly preserve frontier/reachable → canonical OID → visible-pack order;
  predicates, seeds, recursive limit, depth and cache semantics are unchanged.
  The new EXPLAIN witness fails on baseline repo-only scans and passes with OID
  seeks. Reviewer `ses_f3bb3993bffegh5v5QhCblqUFj` approved. Leader ran nine
  targeted pager/cache tests, including the unchanged actual 50,000-edge cold
  reopen witness (10.88 s), then 159 smoke tests, typecheck and lint. WU3's new
  admission test file remains uncommitted with intentional baseline publication
  failures while its separate implementation is pending. This prerequisite does
  not close WU5's metadata lifetime or maintenance-work acceptance.

- 2026-09-21: Actual-depth witness diagnosis localizes the long acceptance run
  to the cold pager's recursive query plan: child lookup uses a repo-only range
  ahead of the recursive frontier, repeating scans. Fixture generation/native
  verification/ingest are short; actual 50,001-edge publication rejection now
  fails against baseline in 6.93 s as intended. Pull forward only WU5's local
  join-order correction, preserving source selection and all limits, to unblock
  the unchanged 50,000-edge cold-acceptance witness. No fixture reduction or
  timeout increase is authorized. Reconstruction of WU3's separate admission
  algorithm continues independently. Evidence lives in ignored
  `bench/results/pack-depth-witness-2026-09-21/`.

- 2026-09-21: WU3 verify-first witnesses reproduce premature publication of a
  reduced-limit over-depth pack and an old canonical cycle; native Git accepts
  those physical inputs. Production code is not yet changed. The implementer
  reported the lost graph prototype as blocking faithful integration. User
  explicitly approved reconstruction with independent algorithm verification;
  reconstructed source/evidence will live under ignored
  `bench/results/pack-graph-reconstruction-2026-09-21/` rather than temporary-only
  storage. Separate diagnosis is investigating the slow actual 50,000/50,001
  depth fixtures without increasing test timeouts or lowering the requirement.
- 2026-09-21: Frozen WU4 baseline at `49f68c9` confirms avoidable retention:
  scalar 8 MiB output through sixteen 8 MiB delta targets adds 136.41 MiB process
  HWM, versus 72.35 MiB for eight targets and 8.00 MiB output-only control.
  All seven baseline processes passed output oracles and the independent 512 MiB
  cgroup cap under enforced leases. Bounded-prefix shared-base cases add 16.11
  MiB. Graph fixtures cross 4,096 and 8,192 edges. Internal inflation/descriptor/
  maintenance dependency counters remain unobserved, not inferred from statement
  counts. Source archives, fixtures and raw results are preserved under ignored
  `bench/results/packed-read-baseline-2026-09-21/`.

- 2026-09-21: User approved WU3 implementation and instructed completion of the
  remaining sprint. WU3 implementation starts from `49f68c9` under the reviewed
  contract. Independent preparation of frozen WU4/WU5 memory baselines writes
  only isolated benchmark artifacts. WU5/WU6 unresolved architectural contracts
  retain their explicit design gates; do not silently choose those boundaries.

- 2026-09-21: Replaced the byte iterator in `TreeParser.push` with bounded
  indexed traversal, preserving parser state and yields. Independent reviewer
  `ses_f3bec0bc2ffeZiJnjiCx38T6T9` approved. Leader checks passed: 52 focused
  tree/parser/physical-pack tests, 159 smoke tests, typecheck, and repository lint.
  No API, schema, lifetime, or data-flow changes were needed.
- 2026-09-21: Five alternating live-Smart-HTTP Next.js clone pairs plus a separate
  sampled-allocation pair qualify the parser change against `e0c34d9`. All 12
  runs pass native HEAD, clean-status and all 24,252 checkout-blob hash checks;
  this inherited oracle does not independently cover all reachable objects or
  all modes/tracking refs. Sampled byte-iterator allocation falls from 54.78 MiB
  to no samples; total sampled cumulative allocation estimate falls 4.09%.
  Whole-clone added RSS medians are 235.67 versus 237.15 MiB with nearly identical
  ranges; no reliable RSS reduction is established. Latency medians are 13.006
  versus 12.294 s with overlapping ranges. This is an allocation improvement,
  not closure of the clone memory objective. Artifacts and source/input audits:
  ignored `bench/results/tree-parser-memory-2026-09-21/REPORT.md`.

- 2026-09-21: Applied the one-line staging lookup hint for the existing
  `git_pack_entries_by_oid` index. All admission predicates, duplicate upsert
  accounting, and publication ownership remain unchanged. Reviewer
  `ses_f3c35e262ffeV9IbhqvZ4rhHZD` approved the code. Leader verified 178 focused
  tests: 52+56 complementary pack groups and 70 publication/concurrency/schema/
  membership tests; splitting was necessary after full-file Vitest RPC reporting
  timeouts despite passing assertions. No timeout or assertion changed. Smoke
  passed 159 tests. Typecheck and lint passed after user-approved exclusion of
  generated `bench/results` fixture copies from TypeScript and Biome scanning.
- 2026-09-21: Staging index qualification compared `f25965b` with only that hint,
  preserving the subtree cache in both versions. Five alternating history-clone
  pairs gave 6.074→2.658 s medians, all five faster; three broad-clone pairs gave
  12.027→12.756 s with mixed pair direction and overlapping ranges. Do not claim
  broad neutrality or memory reduction. Statement/returned-row counts and storage
  are unchanged. EXPLAIN changes from repo/pack primary-key search to
  `(repo_id, oid, pack_id)` index search. All 16 native-oracle samples and 18
  harness selftests passed under one enforcing two-vCPU lease on CPUs 12–13.
  Measurement reviewer `ses_f3c0d7bd6ffeGRQ2Jrp0tCvWdN` independently approved the
  identities, raw medians, and input audit. The wrapper's final exit 1 came from
  adding three analysis-only files after its strict input-list snapshot; all
  measured scripts/inputs were verified unchanged, and all child commands passed.
  Evidence: ignored `bench/results/staging-index-2026-09-21/README.md`.

- 2026-09-21: Committed checked-subtree optimization as `3be3828`. Production
  correctness review and required focused/routine checks passed as recorded
  below. Performance evidence supports the shared-history improvement; broad
  clone remains storage-confounded. WU3–WU8 and staging-index/promotion proposals
  remain open; this optimization does not close those units.

- 2026-09-21: Checked-subtree optimization is ready to commit after the approved
  implementation, corrected input-bound review, leader tests, and performance
  qualification. The later broad-clone investigation changes the interpretation
  of the earlier observed regressions: storage I/O confounds throughput, and a
  cache-code-caused regression is not established. Four same-path ABBA runs
  include unchanged-baseline variation of almost three seconds; 42 of 45 COMMITs
  precede connectivity traversal. Write bytes, SQL/row counts, PRAGMAs, and
  file-size sequences agree. Two traced runs attribute essentially the whole
  final-COMMIT difference to database fsync latency. All six diagnostic operations
  pass full native oracles. This does not exclude a smaller code effect and is
  not a regression-free or Worker-memory claim. No speculative SQL specialization
  or durability change was made. See ignored artifacts
  `bench/results/subtree-cache-transaction-2026-09-21/` and the preceding
  `subtree-cache-no-hit-2026-09-21/` investigation.
- 2026-09-21: Independent measurement review
  `ses_f3c9c9451ffe3WTFRipTgTvM1n` approved reconstructed sample identities,
  boundaries, raw arithmetic, and native verification. Its report-regeneration
  finding is resolved by preserving interpretation separately in
  `bench/results/subtree-cache-2026-09-21/REVIEW.md`. Shared-history gains are
  supported by the new experiment; broad-clone throughput remains inconclusive
  under shared-storage noise. The cache does not address staging free pages,
  WU3 admission, or WU4–WU6 lifetime work.

- 2026-09-21: User approved fresh paired benchmark reconstruction after temporary
  artifact loss. New inputs/harness/raw results are preserved under ignored
  `bench/results/subtree-cache-2026-09-21/`; these are not the previous frozen
  workload. Three alternating pairs per workflow (24 measured operations) passed
  native-Git-derived oracles. The frozen cache patch includes the examined-input
  fix. Reported history clone/fetch medians fell 109.53→5.39 s and 101.15→1.18 s;
  corresponding transient process RSS medians fell 309.36→155.26 MiB and
  234.39→24.85 MiB. Broad clone instead rose 11.18→12.60 s with identical
  statement/returned-row counts, slower in all three pairs. Broad fetch ranges
  overlap. These are local Node results, not Worker memory compliance.
- 2026-09-21: Independent audit of the reconstructed measurement is running.
  Do not commit the cache optimization as regression-free: investigate and
  remove unnecessary empty/no-hit cache overhead first, preserving the approved
  connectivity and queue contracts. Separate tuning artifacts must retain the
  original benchmark and frozen identities for comparison.

- 2026-09-21: Checked-subtree implementation passed independent review after
  fixing examined-input accounting (128 invalid-length entries must not permit
  a later valid certificate). Reviewer `ses_f3cbcdf0bffelci4tbItMu0kD8` approved
  the correction. Leader observed the new witness fail before the fix, then
  46 tree/network tests pass afterward. Before that boundary-only fix the
  six-file fetch gate passed 111 tests and smoke passed 159. Final typecheck,
  formatter, and repository check passed. Changes remain uncommitted pending
  performance qualification.
- 2026-09-21: Performance qualification is blocked: the previous
  `/tmp/opencode/kompjutr-sprint-perf/` now contains no regular files. Frozen
  inputs, harness, oracle and raw measurements cannot be recovered there.
  Earlier recorded measurements remain historical reports, not currently
  reproducible artifacts. New qualification performed zero measured runs.
  A snapshot and missing-artifact inventory were saved in
  `/tmp/opencode/kompjutr-subtree-cache-perf/`; that snapshot precedes the small
  examined-input review fix. Restore the old artifacts or obtain user approval
  to reconstruct fresh paired workloads; never present reconstructed bytes as
  the original frozen inputs or compare new timing directly with old samples.

- 2026-09-21: User explicitly approved a 128-entry, invocation-local checked
  subtree cache for fetch connectivity. Independent design review
  `ses_f6dd78fbdffe69wR8XIdXU6g4N` established the stable-transaction OID contract.
  Admit bounded candidate trees only after the whole walk and final metadata
  flush succeed; prune recursive descendants, not just emitted rows. Preserve
  checked-directory validation and unchanged one-sided limits for actual
  expansion. Eviction retraverses rather than refuses work. Generic two-sided
  diff stays unchanged. One implementation agent owns the four existing
  connectivity/store-walk files plus tree-diff/network-integrity witnesses;
  independent review and same-workload performance measurement follow.
- 2026-09-21: Staging diagnostics narrow the earlier RSS interpretation: paired
  traced fetches have approximately equal total V8 allocation and post-GC live
  heap (~46.3 MiB). High/low modes track nursery growth timing; both revisions
  exhibit both modes. Allocation profiles attribute ~98.7% to existing
  connectivity traversal. This argues against 42 MiB additional live WU1 data,
  but does not explain earlier uninstrumented mode frequencies or clear the
  product-memory gate. Existing-index staging SQL and paged promotion remain
  separate unimplemented proposals; user selected the subtree-cache work first.

- 2026-09-11: User redirected the next work toward performance and memory
  optimization. Diagnose WU1 staging allocation/physical-membership query costs
  and, independently, the 3,001 repeated tree walks in the measured small history
  fetch. Use isolated diagnostics and the frozen product workloads. Preserve
  publication/connectivity invariants; prefer verified local optimizations and
  obtain approval before schema or data-flow changes. WU3 implementation waits
  while this user-requested performance work proceeds.

- 2026-09-11: Product performance comparison completed: 50 primary samples
  (`7b958e0` versus `ea75af3`) plus 15 WU1 attribution samples (`187b9dd`).
  All 60 successful public clone/fetch operations passed native-Git-derived
  object/ref/checkout verification; five baseline duplicate-tree rejections were
  expected. Fixed native HTTP responses, cold-open file-backed WAL databases,
  alternating/rotating sample order and enforced CPU leases were used. Local
  latency ranges overlap; no stable end-to-end direction is established.
- 2026-09-11: The performance check is not neutral: the 3,000-commit/2,000-file
  clone retains 12.5 MiB more checkpointed database space (85.09375 versus
  97.59375 MiB), including 3,204 reusable free pages after staging deletion.
  Next.js small-fetch transient RSS medians were 68.855 versus 111.570 MiB;
  separate baseline/WU1/shipped attribution medians were 70.156/114.141/111.840
  MiB. Overlapping five-sample distributions associate the shift with WU1 but
  do not establish significance, retained allocations, or GC causality. RSS
  includes the local process/server/instrumentation, not a Worker isolate.
- 2026-09-11: Independent measurement review
  `ses_f6df1469cffeklA6Do0UnGg25S` cross-checked all 65 raw records, manifest hashes,
  arithmetic, sample boundaries, and lease consistency. No material methodology
  defect requires rerunning. SQL evidence counts returned rows, not native rows
  read; staging EXISTS searches physical membership by repo/pack without OID as
  an index search term. Internal scan cost is unquantified. The existing history
  fetch performs 3,001 recursive tree walks in both versions. Artifacts and
  reproduction are in `/tmp/opencode/kompjutr-sprint-perf/`. No production fix
  or WU3 implementation was made during this measurement.

- 2026-09-11: User requested a whole-product performance check before continuing
  WU3. Compare shipped `ea75af3` with baseline `7b958e0` on identical actual
  clone/fetch inputs, including ordinary history, small incremental fetch into
  an existing large repository, and duplicate-tree correctness. Measure repeated
  leased runs, SQL work, reset process HWM, and database growth. Prototype-to-
  prototype statement reductions do not demonstrate improvement over baseline
  kompjutr. Isolated measurement is delegated; WU3 implementation remains gated.

- 2026-09-11: User approved isolated affected-graph admission experiments, then
  the batched approach as the basis for the WU3/WU5 integration design. Exact
  production schema, lifecycle, and restart contracts still require independent
  review and user approval before implementation.
- 2026-09-11: Two metadata-only prototypes established affected reverse closure
  plus transaction-local forward memoization with fixed 256-row JavaScript
  pages. Both passed 1,210 independent oracle candidates; the batched version
  also passed 11 adversarial batching/rollback witnesses. Leader reran both
  oracle suites. Reviewers `ses_f6ee8a4a1ffe2qDMIZdDHgiYK2` and
  `ses_f6ec7d15dffet1mjAYWkqZD9L2` approved the isolated evidence. The latter's
  hard-coded SQLite-version finding was fixed with `sqlite_version()` and
  verified against the runtime; existing recorded versions were correct.
- 2026-09-11: Fourteen leased, fresh-process/file-backed cases compared original
  and batched admission. Accepted depth-50,000 extension fell from 600,404 to
  1,583 statements; cold forward depth-50,000 fell from 250,216 to 608. Maximum
  reset-VmHWM increment was 29,892 versus 27,568 KiB. Native SQLite 3.46.1 replay
  of 28 traces matched query results and final digests but showed 1.25–1.54x more
  VM steps for the eight N/2N cases. Explicit work remained approximately linear;
  100k/200k unrelated objects changed neither statements nor replay VM steps.
  These are single local metadata samples, without a cgroup memory cap, not
  Worker memory, Node SQLite 3.50.2 native counters, or production rows-read
  evidence. Two accepted batched cases exceed the 1,000-statement target.
- 2026-09-11: Reproduction artifacts remain outside the repository at
  `/tmp/opencode/kompjutr-graph-spike` and
  `/tmp/opencode/kompjutr-graph-spike-batched` (README, runners, raw results and
  SQLite fixtures). The approach assumes a valid prior graph, complete changed
  source enumeration, and stable source choice. Production physical selection,
  payload admission, maintenance epochs/resumption, and destruction safety were
  not implemented or qualified. WU3/WU5 remain open.

- 2026-09-11: WU2 passed independent review by `ses_f6f05a905ffeafzone0HZHOnKA`
  with no findings. Leader ran the repeated-tree witness on detached `187b9dd`:
  all eight selected full/full, full/delta, delta/delta, cross-flush, streamed,
  and chunked cases failed with the original source/ordinal UNIQUE collision
  after native `git index-pack --stdin` accepted their bytes. `--strict`
  deliberately rejects duplicate objects and is not the oracle for this input.
- 2026-09-11: WU2 leader gate passed 141 tests in 53.04 s, exit 0:
  `cpu-lease run -n 4 -- npx vitest run --maxWorkers=2 tests/pack-physical-membership.test.ts
  tests/tree-index-stream.test.ts tests/pack-projection-publication.test.ts tests/pack.test.ts`.
  The batching witness covers 6,000 physical occurrences in three source lookups.
  Routine smoke passed 159 tests in 15.95 s; typecheck and check passed. WU2 is
  verified for commit; backlog 74 now retains only cold-read admission work.

- 2026-09-11: WU1 committed as `187b9dd`. Starting WU2 with one implementation
  agent; territory is `store/pack/pack-ingest-index.ts`,
  `store/pack/ingest/ingest-projection.ts`, `store/trees/tree-index*.ts`,
  `tests/pack-physical-membership.test.ts`, and `tests/tree-index-stream.test.ts`.
  Preserve WU1 staging. Deduplication belongs at the pack projection write seam;
  bounded within-batch identity tracking and batched exact-source lookup may
  reuse current schema. No schema/read-policy changes, per-small-tree scalar
  preflights, unbounded pack-wide seen set, or entry-level conflict suppression.
  Any needed change beyond that contract is reported before implementation.

- 2026-09-11: WU1 passed independent implementation review by
  `ses_f6f1e234cffeCtG0AGL7h7MagN` with no findings. Leader independently ran the
  new Smart HTTP witness against detached baseline `7b958e0`: it failed at
  `reader.readCommit(oid)` because pending-only content was returned. No stored
  data was fabricated. The same witness passes with the staging implementation.
- 2026-09-11: WU1 leader gate: all 164 focused tests passed, exit 0, with
  `cpu-lease run -n 4 -- npx vitest run --maxWorkers=2` and the five contract
  files (57.09 s). The two-vCPU combined run passed assertions but reported
  Vitest `onTaskUpdate` timeout; isolated `pack.test.ts` (108) and the remaining
  files (56) both passed with exit 0 before the clean combined rerun. No test
  timeout or assertion was changed. `cpu-lease run -n 4 -- npm test` passed
  159 tests in 16.60 s; leader typecheck and `npm run check` passed. Full suite
  and operation-memory benchmarks remain scheduled for their declared gates.
- 2026-09-11: WU1 is verified for commit. Updated current ownership/concurrency
  references and removed shipped ARCH-9 from backlog 65; ARCH-8 remains open.

- 2026-09-11: User approved the WU1 staging contract and execution mode. Starting
  WU1 on `main` at the recorded baseline; subsequent design gates remain in force.
- 2026-09-11: Recorded accepted staging ownership in ADR-0022 and selected the
  existing replay, snapshot, virtual-base, journal, and local restart witnesses
  for later WU6/WU7 verification. WU1 implementation is delegated to one agent;
  documentation remains leader-owned.

- 2026-09-10: Prepared from source inspection at the recorded baseline. No tests,
  runtime reproductions, benchmarks, or implementation changes executed for planning.
- 2026-09-10: Independent review found two acceptance gaps; expanded canonical
  admission and non-publishing consumer lifetime coverage. Second pass approved
  the revised plan. Relative links, declared paths, template fields, and
  whitespace were checked.
- 2026-09-10: Execution started with WU1 design grounding. The memory runtime
  check first timed out waiting for lease capacity; retry after capacity became
  available passed (`status: ok`, constrained CPU, 256 MiB runtime-check cgroup,
  zero swap). This qualifies harness wiring only, not operation memory. WU1
  staging/promotion contract is proposed; no production code changed.
