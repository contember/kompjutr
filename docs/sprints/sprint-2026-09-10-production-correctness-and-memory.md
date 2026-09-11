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

## Run log

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
