<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Simplification (2026-09-23)

**Goal.** Remove machinery that the reference workload and real platform limits
do not need, while every supported command and option in
[`git-support.md`](../reference/git-support.md) keeps working.

**Theme.** A 2026-09-23 audit found that the Git engine (77k lines, 61 `git_*`
tables, 25 ADRs) has a sound core — streaming status, pending-pack ingest,
staged commit projections, durable promises, restartable rebase journals,
paged marking — surrounded by four kinds of excess:

1. Defence against inputs the workload never produces (thin packs stored as
   received, 50,000-deep delta chains, cross-pack cycles).
2. Read-time re-validation of the store's own rows, which ADR-0004 forbids.
3. Modeled byte ledgers, which ADR-0005 forbids.
4. Test-only leftovers and forwarding layers.

The 2026-09-10 sprint added 15 tables and caused both statement misses
([87](../backlog/87-bring-rebase-transition-under-the-statement-target.md),
[90](../backlog/90-bring-the-nextjs-clone-under-the-statement-target.md)).
Success: the WUs below land; `test:full` is green; no statement row rises
except the one approved in WU17; 87 and 90 are re-measured; and rebase works on
the 24,252-file Next.js fixture.

## Refs re-verified at HEAD (2026-09-23, `62edc57`)

Five read-only planning agents verified each premise; the lead spot-checked the
marked ones. Line numbers are HEAD's. Exclude `bench/results/*/source/` copies
from every grep and edit.

- ✔ `REBASE_BASELINE_MAX_ENTRIES = 4_096` refuses larger indexes —
  `packages/git/src/ops/rebase/rebase-lifecycle-baseline.ts:32,86,97,223`.
  ⚠ A second blocker: `requireCleanIntegrationWorktree` caps dirty-path rows at
  10,000 — `ops/integration/integration-worktree.ts:29-37`.
- ✔ `MAX_DELTA_DEPTH = 50_000`; graph page 4,096 —
  `store/pack/shared.ts:47,51`.
- ✔ Thin packs are requested by default — `protocol/upload-pack.ts:68`; the
  promisor path already disables them — `ops/network/network-promisor.ts:99`.
- ⚠ Fix-thin alone does not make packs self-contained: reads follow
  `base_oid` to the canonical `git_pack_objects` owner, so an in-pack base can
  resolve to another pack's copy — `store/pack/read/read-resolver.ts:141-170`.
  Bases must resolve by `(pack_id, base_offset)`.
- ✔ `git_tree_entries.raw_entry` is written and never read —
  `store/trees/tree-index-batch.ts:183,281`. ⚠ `cumulative_base`/`base_cost`/
  `entry_count` are read by `tree-walk-sql.ts` to bound the recursive CTE
  queue; they stay.
- ✔ Maintenance packs hold full objects — ADR-0012; repack is
  `store/maintenance/repack/*` (1,520 lines). `git_loose_object_lifecycle` is
  read only by repack — `repack-finalize-sources.ts:231,301`.
- ⚠ `source_generation` is also used by paged reads
  (`store/pack/read/read-scope.ts:114,130`) and the mark; it stays until WU13
  proves otherwise.
- ✔ Sparse source receipts — `store/sparse/receipt.ts`; only `do-fs` creates
  sources (`packages/do/src/runtime/workspace.ts:87-89`). ⚠ The untrusted path
  runs in tests only through statement-counting wrappers that spread the source
  (`tests/staging.test.ts:124-155`, `tests/checkout-sparse.test.ts:170-215`).
- ✔ Modeled byte limits in integration — `ops/integration/integration-limits.ts:11,50-56,71-84`,
  checked at `integration-plan-owned.ts:100,136,146`; only tests set them.
- ✔ Continue/skip/abort re-plan to validate the journal —
  `ops/merge/merge-journal.ts:30-150`, `ops/replay/replay-lifecycle.ts:184-291`,
  `ops/rebase/rebase-lifecycle-step.ts:173-263`; write-time validation in
  `store/operations/operation-journal-validation.ts`.
- ⚠ Caller merge message and identity fail as `CorruptError` instead of
  `GitError` — `ops/merge/merge.ts:173-183`, `store/operations/operations-merge.ts:74-83,218`.
- ✔ Push re-hashes stored objects — `ops/push/push-plan-auth.ts:28-42`.
  Ingest hashes every object (`store/pack/ingest/ingest-index.ts:117-122,180`,
  `ingest-pending.ts:248`), so fetch re-hashing in
  `ops/network/network-fetch-mapped.ts:93-157` and `network-tags.ts:84` adds
  nothing.
- ✔ CLI mutation output preflight — `cli/write/write-runtime.ts:29-46`,
  modeled `SummaryRetainedBudget` — `cli/write/write-output.ts:8-34`.
- ✔ `bench/statements.ts:2385` fails on any rows-read change; the Next.js
  reference reads a gitignored file — `:2335-2352`.
- ⚠ Ignore caps turn a long anchored `**` pattern into `never` and then fail
  the load with `E2BIG` — `ignore/pattern-compile.ts:104-105`, `ignore/limits.ts:98`.
- ✔ `activeRefLogOids` has no production caller — `store/refs/reflog.ts:343-463`.

## Decisions

Resolved with the user on 2026-09-23:

- **Self-contained packs by not requesting `thin-pack`**, and a delta depth cap
  of 4,095 (Git's `pack-objects` limit). Incremental fetch may transfer more;
  a pack from a non-Git server with a deeper chain fails with `ECORRUPT`.
  Supersedes [ADR-0023](../decisions/0023-validate-canonical-pack-dependencies-at-source-changes.md)
  and the read half of [ADR-0025](../decisions/0025-scope-paged-read-metadata-and-linearize-maintenance-expansion.md).
- **CLI mutations commit and truncate** oversized output with `truncated: true`,
  one policy for every command. Supersedes
  [ADR-0017](../decisions/0017-preflight-mutating-cli-output-inside-the-transaction.md).
- **Push tracking refs come from `report-status`**, like Git; no second
  discovery. `"deferred"` leaves `PushTrackingResult`.
- **Ignore caps that name no real failure go.** Keep `rawBytes`, `fileBytes`,
  `files`, `queryBytes`.
- **`bench:statements --check` becomes a tolerance gate**: any statement rise
  fails; rows read fail above `baseline × 1.10 + 16`; a drop prints a
  rebaseline note; Next.js is report-only unless a path is passed.
- **Not changed:** clone/ingest time leases (ADR-0013), deleted-ref reflog
  retention (ADR-0011), fetch-publication ABA fencing
  ([`concurrency.md`](../reference/concurrency.md) guarantees it), network argv.
- Public result shapes may change where a field only described removed
  machinery (`repackedObjects`, the `"repack"` phase). No backward
  compatibility is required.

## Work units

Phases run in order. WUs inside a phase are independent unless a dependency is
stated. Every WU commits on its own.

### Phase 0 — Gates

#### WU0 — Tolerance gate and fast-path statement rows (effort S)

- **Problem.** The exact rows-read gate forces a rebaseline in every commit,
  and the fast paths have no statement row: `status.sparse`,
  selected-path `add`, and `worktree list` are unmeasured.
- **Verify first.** `staging.add` calls `add()` without a context, so it never
  takes the selected-path path.
- **Scope.** Implement the tolerance gate (keep the linear-scaling checks at
  `bench/statements.ts:2393-2415`; delete the parser self-test at
  `:2281-2333`). Add `status.sparse` (clean and 2-dirty, same fixture as
  `status.full`), `staging.add-selected`, and `worktree.list` (3 roots); freeze
  them at HEAD. Update `bench/CLAUDE.md`.
- **Acceptance / witness.** An injected +20 % rows regression fails `--check`;
  a −5 % change passes with a note; `--check` is green at HEAD.
- **Touch points.** `bench/statements.ts`, `bench/CLAUDE.md`.

### Phase 1 — Dead code and forwarding

#### WU1 — Delete the test-only array integration API (effort M)

- **Problem.** No production caller for `detach`, `planIntegration`,
  `planVirtualAncestorIntegration` (`integration-plan.ts:20,41,47`),
  `planReplay`/`planFixedReplayStep` and the generic `<Integration>`
  (`replay-planning.ts:77,90,163,177`), `classifyStructuralStreams`/
  `classifyIntegrationStructure` (`integration-structure.ts:338,418`),
  `merge-apply-operation.ts`, `merge-apply-restore.ts`, `applyProjectedIndex`
  with `touchedSpecs`/`contentObjects`, `projectedTouchedShape`
  (`integration-worktree.ts:233`), `projectMergePlan` (`merge-projection.ts:229`).
- **Verify first.** Grep each symbol across `packages/`, `tests/`, `bench/`.
- **Scope.** Delete them. Add `tests/helpers/integration.ts` that runs the
  owned planner in `withIntegrationWorkspaceOwned` and collects arrays; migrate
  the integration, virtual-base, structure, replay and merge-projection tests to
  it. Rewrite `merge-apply.test.ts` and the cherry-pick restore case through the
  public API. `bench/statements.ts:35` uses `planReplayOwned`.
- **Acceptance / witness.** Migrated suites green; `bench:statements --check`.
- **Touch points.** `ops/integration/`, `ops/merge/merge-apply-*`,
  `ops/replay/replay-planning.ts`, `bench/statements.ts:31,35`,
  `packages/git/src/index.ts:165`, `client-types.ts:32,56` (barrel imports).
- **Witness files.** `npx vitest run tests/integration.test.ts
  tests/integration-virtual-base.test.ts tests/integration-structure.test.ts
  tests/replay.test.ts tests/merge-projection.test.ts tests/merge-apply.test.ts
  tests/cherry-pick.test.ts`.

#### WU2 — Remove modeled byte limits in integration and rebase (effort S; after WU1)

- **Problem.** `maxPlanBytes`/`maxStructureBytes`, `PlanBudget` bytes, the
  `512`/`64 + len*2` cost model, and `PENDING_REBASE_STEP_BYTES`/
  `maxRetainedBytes` (`rebase-plan.ts:29,69,147`) violate ADR-0005.
- **Scope.** Delete the `limits` option from `IntegrationInput`/`ReplayInput`.
  Keep `MAX_INTEGRATION_SOURCE_ROWS`, the structural entry cap, and the
  text-merge `maxOutputBytes`. Remove the matching rows from backlog 66.
- **Acceptance / witness.** Memory cases `binary-150`, `paths-1001`,
  `paths-1001-rebase` stay under 100 MiB added peak; `rebase-plan.test.ts`
  without byte cases.
- **Touch points.** `ops/integration/integration-{limits,structure,types,plan-owned}.ts`,
  `ops/rebase/rebase-plan.ts`, `tests/integration*.test.ts`.

#### WU3 — Drop `raw_entry`, the wide view, and dead reflog roots (effort S)

- **Problem.** `raw_entry` is never read; `git_tree_entries_wide` is test-only;
  `activeRefLogOids` has no production caller and carries a 9,727-row cap.
- **Scope.** Delete the column, the view, the method and its cap. The method
  is public (`Repository.activeRefLogOids()`, `index.ts:189`,
  `repository.ts:331`); remove it. Update `schema.test.ts:172,524`,
  `tree-index-stream.test.ts:355-455`, `sparse-workspace.test.ts`,
  `foreign-keys.test.ts`, `pack-physical-membership.test.ts`, reflog tests,
  `bench/tree-schema.ts`, `bench/statements.ts`, and `git-support.md:976`.
- **Acceptance / witness.** Tree, sparse, schema and reflog suites green;
  `bench:clone-storage -- nextjs` shows smaller tree-entry storage.
- **Touch points.** `store/schema/schema-tree-statements.ts`,
  `store/trees/tree-index-batch.ts`, `store/refs/reflog.ts`.

#### WU4 — Remove forwarding layers in merge, rebase and refs (effort M; after WU1)

- **Problem.** `rebase.ts` forwards 8 → 8 → 4; non-`Excluding` variants are
  test-only. `refs-checkout-guard.ts:46-150` exports 6 functions over one.
  `prepare*` plus in-transaction re-checks (`rebase-lifecycle.ts:147,240,305`)
  are synchronous. The plan → project → safe → touched → bound → apply sequence
  appears three times (`merge.ts:262-314`, `replay-lifecycle.ts:324-355`,
  `rebase-lifecycle-step.ts:113-146`).
- **Scope.** Four rebase entry points taking `excludeRoots`; one guard with a
  mode; one transaction per lifecycle call; one shared integration step; move
  `merge-apply-*` to `ops/integration/apply/`; inline one-field wrapper types;
  delete the `merge-apply.ts`, `integration.ts` and `replay.ts` barrels.
- **Acceptance / witness.** `rebase`, `merge`, `replay`, `pull` suites;
  import-graph and file-ceiling suites.
- **Touch points.** `ops/rebase/`, `ops/refs/`, `ops/merge/`, `ops/integration/`.

#### WU5 — Remove facades and forwarding twins in status and staging (effort S)

- **Problem.** Re-export facades `sparse-checkout.ts`, `do-fs/sparse/sources.ts`,
  `tree-build.ts`, `worktree/sparse-workspace.ts`; forwarding twins
  `hashWorktreePaths`, `hashExactWorktreePaths`, `hashWorktreePath`,
  `compilePathspecs`, `walkWorktreeEntriesStream`, `dirtyPathStream`; the rm
  family split into 6 files with helpers shared by `add`; `isExcluded`
  duplicated in `status-full.ts`; five unused `*Owned` wrappers in
  `do-fs/sparse/{workspace,snapshot,selection}.ts`.
- **Scope.** Delete the low-importer facades (keep `status.ts`, `staging.ts`,
  `worktree-io.ts` as entry points); collapse twins; move `isExcluded` and
  `relativeExcludeRoots` into `common/paths.ts`; merge rm into two files.
- **Acceptance / witness.** Status, staging, worktree suites; import-graph and
  file-ceiling suites.
- **Touch points.** `ops/{status,staging,worktree,checkout,tree}/`, `do-fs/sparse/`,
  `packages/git/src/index.ts:211`, `client-types.ts:94` (re-export
  `worktree/sparse-workspace.js`).

### Phase 2 — Trust the store (ADR-0004)

#### WU6 — Stop re-validating operation journals (effort M; after WU4)

- **Problem.** Continue/skip/abort re-plan the three-way merge to compare it
  with stored touched rows; rebase continue plans twice
  (`rebase-lifecycle.ts:210`). Write-time validation runs `objectInfo` on every
  touched OID and re-parses commits (`operation-journal-write.ts:76,286`,
  `operation-journal-validation.ts`, `operations-replay.ts:293-346`,
  `operations-merge.ts:100-146,297-357`).
- **Verify first.** Whether write-time `objectInfo` fails on promised blobs in
  a `blob:none` clone — if so, add that as the failing-first witness.
- **Scope.** Keep `requireOriginalHead`, journal kind/phase/step, no unmerged
  entries on continue, `readCommit(sourceOid)` for metadata, `MAX_OPERATION_STEPS`,
  and the `EOPMISMATCH` predicates. Delete the rest. Move caller message and
  identity validation to the ops boundary as `GitError`.
- **Acceptance / witness.** New: a NUL in a merge message fails `EINVAL`, not
  `ECORRUPT`. `rebase-restart`, `merge-lifecycle`, `cherry-pick`, `revert`
  (cold continue/skip/abort). Delete the `UPDATE git_operation*` tamper cases;
  update `trusted-read-policy.test.ts`. `rebase.transition*` rows fall.
- **Touch points.** `ops/{merge,replay,rebase}/`, `store/operations/`.

#### WU7 — One sparse capability, trusted sources (effort M; after WU0, WU5)

- **Problem.** Six optional capabilities wired one by one
  (`client-types.ts:295-300`, `client-factory.ts:27-36`), E2BIG wrapped twice,
  and a per-call receipt that routes copied sources through a validating path
  (`staging-selected-validation.ts`, `sparse-checkout-selected.ts:16-145`,
  `sparse-checkout-validation.ts:14-51`, `status-sparse.ts:366`,
  `tree-build-sparse.ts:51-73,103-203,261-315`).
- **Scope.** Replace `indexTracker`, `sparseWorkspace`, `selectedPaths`,
  `commitTrees` with one `sparse?: {database, tracker, workspace, selected,
  commitTrees}` built by one `do-fs` factory; `client-factory` checks
  `sparse.database === binding.database` once. Delete `store/sparse/receipt.ts`,
  `store/sparse/sparse-workspace.ts`, the validators, `trusted` flags and
  `structuralBytes`. Fix `git-support.md:285` and `architecture.md:178`.
- **Acceptance / witness.** All WU0 fast-path rows at or below baseline;
  `staging.add`, `commit.sparse`, `sparse.prune`; `core.sparse-selected-add`
  memory case; keep the fallback and corruption fakes in `diff-sparse` and
  `status-sparse`.
- **Touch points.** `client-*.ts`, `store/sparse/`, `ops/{status,staging,checkout,tree}/`,
  `do-fs/` (incl. `do-fs/index.ts:2` export of `hasSparseSourceReceipt`),
  `packages/do/src/runtime/workspace.ts`.

#### WU8 — Trust stored objects in push and fetch (effort M)

- **Problem.** Push re-hashes and re-parses stored roots; fetch re-hashes after
  ingest; push re-discovers after a confirmed push (`push-tracking.ts:62-98`);
  the push plan is a `WeakMap` handle with an openings counter and test-only
  queries (`push-plan-runtime.ts:13,32-35,72-90`); `tracked401Body`
  (`receive-pack-client.ts:69-88`).
- **Scope.** Resolve tag chains from stored type metadata; `authenticateMappedRoots`
  reads types from `objectInfo`; tracking refs from `report-status`; delete
  `authenticatePushBranchTargets`; plain push plan object; keep one 401 retry
  via the request factory (`transport.ts:192-211`) with `safeAbort = status === 401`.
  Update `git-support.md:741`; close most of backlog 75.
- **Acceptance / witness.** New: a confirmed push issues exactly one discovery
  request. `receive-pack` 401-retry and abort tests; push, fetch-refspec,
  network-safety, fetch-publication suites.
- **Touch points.** `ops/push/`, `ops/network/`, `protocol/receive-pack-client.ts`,
  push-tracking rows in `concurrency.md`.

#### WU9 — Trim typed-API boundary checks (effort S)

- **Problem.** `parse-input.ts:34-45` re-checks argv mutation three times;
  `boundedGitCliResult` (`cli/result.ts:232-243`) re-validates internal
  handlers; `untrustedErrorMessage` (`write-errors.ts:73-82`); 19 hand-written
  `typeof` checks in `network-options.ts`/`push-options.ts`.
- **Scope.** `Array.from` once; move options to `OptionsSchema`
  (`common/rows.ts:92`); drop internal re-validation. Keep unknown-key rejection.
- **Acceptance / witness.** `git-cli*`, `network-options`, `push-options` suites.
- **Touch points.** `cli/parse/`, `cli/result.ts`, `ops/network/`, `ops/push/`.

### Phase 3 — Structural removals

#### WU10 — Delete maintenance repack (effort M)

- **Problem.** Full-object maintenance packs save no bytes and cost more to
  read (`pack/read/read-data.ts:184`).
- **Verify first.** On a reference-workload fixture, compare stored bytes,
  rows, and `log`/`cat-file` statements loose vs packed after `finish`.
- **Scope.** Delete `store/maintenance/repack/`, `repack.ts`, both
  `git_maintenance_repack_*` tables, `git_loose_object_lifecycle`, the
  `repacked_objects` column, repack-batch pins (`lifecycle-ingest.ts:73,122`,
  `sweep-packs.ts:19,181`), and the async branch in
  `ops/repository/maintenance.ts:118-155`. Rewrite ADR-0012.
- **Acceptance / witness.** New: after a full run, reachable loose objects stay
  readable across a cold reopen. Maintenance suites, `concurrency-maintenance`,
  `e2e/production-cold-workflow` green; delete `maintenance-repack.test.ts`.
- **Touch points.** `store/maintenance/`, `ops/repository/maintenance.ts`,
  `store/objects/objects-write.ts:53,172,238`, `objects-batch.ts:203` (every
  loose write stops writing the lifecycle row; statement rows fall),
  `bench/statements.ts`, `concurrency.md`, `git-support.md:863,869`,
  `architecture.md`.

#### WU11 — Collapse maintenance phases (effort M; after WU10)

- **Scope.** Phases `roots`, `mark`, `loose`, `packs`, `finish`; keep the root
  epoch and the pack restart loop; drop repack settle and restart handling
  (`state-transitions.ts:98+`); drop own-write re-checks
  (`state-transitions.ts:28-96`, `sweep-packs.ts:169,227`).
- **Acceptance / witness.** `maintenance-sweep` grace, `nextEligibleAt` and
  pack-restart cases; `maintenance-reachability`; `concurrency-maintenance`.
- **Touch points.** `store/maintenance/state/`, `store/maintenance/sweep/`.

#### WU12 — Self-contained packs (effort L)

- **Scope.** Store `base_offset` in `git_pack_entries`; convert in-pack
  ref-deltas at ingest. Reads take the canonical `git_pack_objects` row's
  `pack_id`, then follow `git_pack_entries (repo_id, pack_id, base_offset)`;
  drop `git_pack_objects.base_oid` and its index. Stop requesting `thin-pack`;
  reject external bases at ingest. Today depth is enforced only by
  `PackGraphAdmission` (`store/pack/ingest.ts:160-167`,
  `lifecycle-delete.ts:280`): carry each entry's depth while pending deltas
  drain (base depth + 1) and reject above `MAX_DELTA_DEPTH` with `ECORRUPT`.
  Delete `store/pack/graph/*`, the four `git_pack_graph_*` tables,
  `read/read-external.ts`, `sweep/sweep-pack-dependencies.ts`, the loose-base
  clause in `sweep-loose.ts:20-23`, the admission hook in
  `lifecycle-delete.ts:8,280`, `MAINTENANCE_PACK_BASE_SQL`, and
  `git_pack_entries_by_base`. Fallback promotion stays as plain SQL. Delete
  ADR-0023.
- **Verify first.** In-pack ref-delta cycles already fail in pending-delta
  resolution. Measure incremental fetch bytes with `bench/nextjs-network.ts`
  before and after; the number is report-only and recorded in the run log.
- **Acceptance / witness.** New: packs A (X→Y) and B (Y→X) both read correctly;
  a thin pack is rejected; a chain deeper than the cap is rejected at ingest. `pack`, `delta`, `clone`, `concurrency-pack`,
  `maintenance-*`, `pack-physical-membership`, `protocol` suites. Delete
  `pack-graph-admission.test.ts`.
- **Touch points.** `store/pack/`, `store/maintenance/`, `protocol/upload-pack.ts`,
  `concurrency.md:33-41,218-243`, `store/CLAUDE.md` (loose-base protection),
  `git-support.md` (a server that sends a thin pack anyway now fails).

#### WU13 — Delta depth cap 4,095 and non-paged reads (effort M; after WU12)

- **Scope.** `MAX_DELTA_DEPTH = 4_095`; on a graph-limit error split the wanted
  batch recursively; delete `read-graph.ts`, `read-graph-scratch.ts`,
  `read-scope.ts`, the three `git_pack_read_*` tables and the `graphPageEntries`
  seam. Remove `source_generation` if nothing else needs it; otherwise record
  why. Rewrite ADR-0025.
- **Acceptance / witness.** New: depth 4,096 rejected at ingest; one object at
  depth 4,095 (4,096 entries, exactly one page) reads; 4,096 wanted objects with
  depth-3 chains resolve. Rewrite `pack-read-lifetime.test.ts`.
- **Touch points.** `store/pack/read/`, `store/pack/shared.ts`, schema,
  `store/CLAUDE.md` (`git_pack_read_*`), `concurrency.md:33-41`.

#### WU14 — One tree projection per tree OID (effort M; after WU3, WU12)

- **Scope.** Key `git_tree_sources` by `(repo_id, tree_oid)`; delete
  `git_tree_effective` and its five triggers; delete a projection when no source
  remains. Update `tree-walk-sql.ts`, `tree-index-batch.ts`,
  `lifecycle-delete.ts`, `reachability-expand.ts`, `do-fs/sparse/snapshot.ts`,
  `do-fs/sparse/tree-resolution.ts`, `bench/oid-encoding.ts`,
  `bench/tree-schema.ts`.
- **Acceptance / witness.** A duplicate tree writes no entries; deleting one
  source keeps the projection. Tree, sparse, physical-membership, foreign-key
  suites; `bench/tree-schema.ts`.
- **Touch points.** `store/trees/`, `store/schema/schema-tree-statements.ts`.

#### WU15 — One commit projection path (effort M)

- **Verify first.** Inventory every loose commit write: object-write sites,
  integration adoption, `commitTree`, plumbing object writes. State the
  behaviour for malformed commit bytes and for missing (shallow) parents.
- **Scope.** Index each loose commit on write in the same transaction; delete
  the lazy fill, `walkUncachedOwned`, `ECACHEMISS`, and the `incomplete`
  counting in `commits-graph.ts:115`; derive the graph byte cap from
  `object_size` (it bounds a real `Map`) and drop `cache_bytes`.
- **Acceptance / witness.** New: a commit written by `commit` is in
  `git_commits` before any `log`. `commit-cache`, `pull`, `rebase` suites.
- **Touch points.** `store/trees/commits-*.ts`, `ops/repository/repository-walk.ts`,
  `store/objects/`.

#### WU16 — Integration output as ordinary loose objects (effort L; after WU1, WU6)

- **Scope.** Drop `git_integration_objects`, `git_integration_object_chunks`,
  `git_integration_tree_entries`, most of `integration-workspace/objects.ts`,
  `adoptMany`, `adoptProjectedIndex`. Keep plan, plan-entry, reservation,
  touched and workspace tables. Rewrite ADR-0024.
- **Verify first.** An ordinary loose write retains no 1 MiB blob in a cache
  (`binary-150` is at 91.25 MiB).
- **Acceptance / witness.** Memory cases 150/1,001; a fault before publication
  leaves refs, index and worktree unchanged; invert the "not published" cases
  in `integration-bounded-output.test.ts`.
- **Touch points.** `store/operations/integration-workspace/`, `ops/integration/`,
  `store/CLAUDE.md` (row ownership).

#### WU17 — Plain root stats and one traversal path (effort L; after WU7)

- **Scope.** Replace `exact-path-states.ts`, `ExactRootStateSource` and the
  `exactRootStates` binding with `worktree.stat(root)` per root; delete
  `nativeRealpathOwned`. Make `scanStream` required with a `RealPath` root and
  a DO keyset generator (1,000-row pages, pruned-range stack, per-window restart
  from `after`); one streaming path in walk, hash and dirty code; delete
  `packages/drive/src/receipts.ts`, `packages/do/src/fs/store/owned-read.ts`,
  `scanOwned`.
- **Approved cost change.** `worktree.list` goes from ~1 statement to N (one
  per checkout).
- **Acceptance / witness.** `worktree.guard`, `status.full`,
  `diff.index-worktree`, `ls-files.combined` unchanged; `bench/local.ts`
  unchanged; `worktrees.test.ts`, `mutation-scope.test.ts`.
- **Touch points.** `packages/drive/` (incl. its `index.ts` export of
  `receipts.ts`), `packages/do/src/fs/`, `ops/worktree/`,
  `packages/local/src/workspace.ts:175`.

#### WU18 — CLI output: commit, then truncate (effort M)

- **Verify first.** `summaryFromDiffRows` (`write-summary.ts:115-120`) needs a
  row cap before the byte charge can go.
- **Scope.** Commit, then apply `boundedPublishedGitCliResult`; delete
  `SummaryRetainedBudget`, phase tracking, diagnostic pre-counting, and
  `gitCliUtf8ByteLengthRange`. Rewrite ADR-0017.
- **Acceptance / witness.** Rewritten `git-cli-write.test.ts:803,840,846,1301,1344,1390`,
  `git-cli-network.test.ts:369`, `integration-bounded-output.test.ts:241`: the
  mutation persists across reopen and the result has `truncated: true`.
- **Touch points.** `cli/write/`, `cli/result.ts`, `git-support.md:112-113,160-170,950`.

#### WU19 — Remove ignore caps without a real failure (effort M)

- **Verify first.** Fixtures: a long anchored `a/**/…` pattern and a many-rule
  `.gitignore` with a deep path; both fail at HEAD.
- **Scope.** Delete `compiledBytes`, `patterns`, `patternBytes`, `nfaStates`,
  `totalNfaStates`, `wildcardSegments`, `matcherWork`, `querySegments`; size
  the NFA mask to the pattern. Make `protocolLimits` a module constant with a
  test seam.
- **Acceptance / witness.** The two fixtures match like Git in
  `tests/git-upstream-parity.test.ts`; `ignore.test.ts` drops the removed caps.
- **Touch points.** `ignore/`, `protocol/remote-base.ts`.

#### WU20 — One fetch engine (effort L; after WU8)

- **Scope.** Add depth/deepen/unshallow, prune, tag following with include-tag
  fallback, remote HEAD symref, `fetchHead` and local haves to the mapped
  engine; lower legacy options to forced refspecs; delete
  `network-fetch-legacy.ts`. Split `network-fetch-mapped.ts` along its
  shallow and tag seams to stay under the 500-line ceiling.
- **Verify first.** List the exact shallow, deepen, unshallow and tag test
  files before starting; they are the witness.
- **Acceptance / witness.** Those files; clone and pull suites.
- **Touch points.** `ops/network/`.

#### WU21 — Schema: `STRICT` and `AUTOINCREMENT` (effort M; last in phase 3)

- **Verify first.** A `STRICT` + `WITHOUT ROWID` table opens on real workerd
  (bundled SQLite 3.47) and on `node:sqlite`.
- **Scope.** Switch `git_*` tables to `STRICT`; remove only the
  `typeof(x) = 'T' AND` prefixes; keep range and enum `CHECK`s. Replace
  `git_identity_control` and its cross-check (`database-identities.ts:22-100`)
  with `AUTOINCREMENT`. Update ADR-0004:102.
- **Acceptance / witness.** `schema`, `foreign-keys`, `database` suites;
  `npm run bench:workerd:nextjs`.
- **Touch points.** `store/schema/`, `store/database/`, `bench/memory.ts`
  (`git_identity_control`).

### Phase 4 — Functionality gain

#### WU22 — Rebase on large repositories (effort M)

- **Scope.** Merge the gitlink refusal and per-tree preflight into one streamed
  pass; check blob types page by page; remove `REBASE_BASELINE_MAX_ENTRIES`.
  `dirtyPathLimits()` also caps `maxIndexRows` and `maxHashCandidates` at
  10,000 (`MAX_TREE_BUILD_LEAF_ENTRIES`, `tree-build-full.ts:20`) and
  `maxWorktreeRows` at 50,000 (`integration-worktree.ts:27-37`); the baseline
  caps `maxWorktreeRowsPerPass` at 50,000 (`rebase-lifecycle-baseline.ts:174,212`).
  Stream the clean-worktree check so none of these bound rebase; keep hashing
  batched. `requireCleanIntegrationWorktree` is shared: if merge, cherry-pick
  and revert cannot use the streamed check in this WU, they keep their caps
  and `git-support.md` records the limit.
- **Acceptance / witness.** New, failing first: rebase on 12,000 files with a
  conflict, cold reopen, then continue and abort. Add a rebase step to
  `bench/nextjs-workflow.ts`; `core.rebase.baseline-hash` stays under 100 MiB.
- **Touch points.** `ops/rebase/rebase-lifecycle-baseline.ts`,
  `ops/integration/integration-worktree.ts`, `bench/nextjs-workflow.ts`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Many deletions across layers | `npm test` after every WU; `bench:statements -- --check` after every WU from phase 2 on; `test:full` at the phase 3 end and at closure; `bench:nextjs` at closure | Any statement row rises (except WU17) |
| WU0 | Bench harness only | Direct witness; lead reviews the diff | The gate stops failing on a real rise |
| WU1, WU2, WU3, WU4, WU5, WU8, WU9, WU15, WU18, WU19 | Deletions with tests migrated; WU3/WU5 remove public exports; WU9 changes boundary validation | Witness plus one independent review | Review finds a behaviour change |
| WU6, WU7, WU10, WU11, WU14, WU16, WU20, WU21 | Store or trust contracts | Witness plus independent review until clean | Schema or ADR premise drifts |
| WU12, WU13, WU17, WU22 | Hot read path, schema, memory | Witness, benchmarks named in the WU, independent review until clean | Memory or statement regression |

## Test cadence

- **Per WU.** The exact witness above, plus `npm run typecheck` and
  `npm run check`.
- **Routine integration.** `npm test` after each WU (< 30 s).
- **Statement gate.** `bench:statements -- --check` after every WU from phase
  2 on, so a rise is traceable to one WU.
- **Phase 3 end.** `npm run test:full` under `cpu-lease run -n 4`. This is a
  deliberate second full run: phase 3 changes the schema and read paths, and
  phase 4 should start from a verified base.
- **Sprint closure.** `test:full`, `bench:nextjs` then `bench:statements --
  --check`, `bench:memory` integration cases.
- **Failure loop.** Reproduce with the exact file; rerun the full suite only
  after it is stable.

## Out of scope (explicit)

- Time leases (ADR-0013), deleted-ref reflog retention (ADR-0011), and
  fetch-publication ABA fencing — user decision, behaviour kept.
- Network argv, three-way merge, cherry-pick, revert — product scope.
- Backlog 87 and 90 as optimisation targets — re-measured at closure only.
  Backlog 84 (read integration worktree inputs once) overlaps WU4 and WU22;
  re-check it at closure.

## Sequencing

Schema, `tests/schema.test.ts`, `tests/store.test.ts` and `bench/statements.ts`
are shared by most store WUs, so store WUs run in series.

| Phase | Order | Parallel |
|---|---|---|
| 0 | WU0 | — |
| 1 | WU1 ∥ WU5, then WU3, then WU2 and WU4 | WU1 ∥ WU5; WU2 ∥ WU4 after WU1 |
| 2 | WU7 ∥ WU8, then WU9 (after WU8), WU6 (after WU4) | WU7 ∥ WU8; WU6 ∥ WU9 |
| 3 | Store chain: WU10 → WU11 → WU12 → WU13 → WU14 → WU15 → WU16 → WU21. Network chain after WU12: WU19 → WU20. | WU17 and WU18 run beside the store chain |
| 4 | WU22 | after WU16 |

## Plan review

- **Reviewer:** independent Claude agent (general-purpose), 2026-09-23, at `62edc57`.
- **Verdict:** approved with changes; all changes applied.
- **Material findings:**
  1. WU12 deleted the only depth check → ingest now tracks depth; witness moved.
  2. WU12 schema target unclear → canonical `pack_id` then `base_offset`.
  3. WU11 witness contradicted WU12 and they overlapped → witness dropped, store WUs serial.
  4. Parallel WUs shared schema, bench and network files → sequencing rewritten.
  5. Missing public-export and bench touch points → added; WU3/WU5 get review.
  6. Binding and reference docs not listed → added per WU.
  7. WU22 named one cap; there are four counters → all named, shared-check policy stated.
  8. WU10 misses loose-write sites → added.
  9. WU15 lacked a commit-write inventory → verify-first added.
  10. Vague witnesses → WU8, WU12, WU13, WU19, WU20, WU21, WU1 made concrete.
  11. Cadence → statement gate per WU; full suite at phase 3 end and closure; WU9 reviewed.
  12. Dirty tree → already committed in `c0d8759`; 88 and 89 already closed.

## Run log
