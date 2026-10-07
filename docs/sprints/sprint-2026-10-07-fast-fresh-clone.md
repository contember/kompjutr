# Sprint — fast fresh clone (2026-10-07)

**Goal.** Remove the clone work native Git never does: history-wide
connectivity walks, projection-derived promise registration, and eager
projection of every historical tree.

**Theme.** The re-profile at `8bd064f` attributes 197 s of the full-history
`blob:none` Next.js v15.5.2 clone to native SQL (68 %). The three largest
regions are tree projection (43.6 s writes + 22.5 s parse), the connectivity
statement (50.2 s) and promise registration (15.3 s). They are coupled:
connectivity and registration read every historical projection. The sprint
first replaces both with a per-pack check at ingest
([ADR-0029](../decisions/0029-check-fetched-connectivity-per-pack.md)), then
projects trees on demand
([ADR-0030](../decisions/0030-project-trees-on-demand.md)). Success: clone
≤ 60 s on the reference harness, with the same HEAD, file count and clean
worktree, and Git-visible behaviour unchanged except for the divergences the
ADRs record.

## Measured baseline (2026-10-07, `8bd064f`)

The scratch harness posts the playground `clone` action to Miniflare under
`cpu-lease run -n 2 --no-smt`. It uses fresh persistence, and the HEAD and
worktree are verified.

| Measure | Value |
|---|---:|
| Wall | 197.0 s |
| Statements / rows returned | 6,414 / 537,989 |
| Isolate busy, of which native SQL | 204.2 s, 138.1 s |
| Tree projection writes / parse | 43.6 s / 22.5 s |
| Connectivity statement | 50.2 s (25.1 M rows read) |
| Promise registration + publication DELETE | 15.3 s (14.9 M rows read) |
| Projected entry rows / read by HEAD checkout | 6,689,426 / 34,746 |
| Native git (same origin, `file://`, `--no-local`) | 17.2–18.9 s |

## Refs re-verified at HEAD `dddf98a` (2026-10-07)

Paths are relative to `packages/git/src/`.

- ✔ Connectivity runs once, in the guarded publication block, after all packs
  are published — `ops/network/network-fetch-mapped.ts:221-232`. It is the only
  caller of `validateFetchedConnectivity` (`ops/network/network-connectivity.ts:13`).
- ✔ The SQL walks commits via `git_commits` and trees via complete projections
  only; a tree with `complete IS NOT 1` is a `source` failure —
  `store/trees/connectivity.ts:8-86`.
- ✔ `readCommitTreeRoots` has another caller, `ops/merge/merge-base.ts:254`; it
  stays.
- ✔ Promise registration reads projections: `addBlobsFromPackTrees` —
  `store/fetch/promisor.ts:122-166`. It is called from the ingest `published`
  callback inside pack publication — `ops/network/network-transfer.ts:71-80,173-176`.
- ✔ The publication-time promise DELETE runs before that callback —
  `store/pack/packs.ts:181-198`. Pack publication order: complete flag, membership
  audit, `commits.finish()`, source generation, `published` —
  `store/pack/ingest.ts:119-146`.
- ✔ Every resolved object passes through `PackResolvedProjection.insertResolved`
  (both the first pass and deferred deltas) with buffered, chunked or streamed
  bytes — `store/pack/ingest/ingest-projection.ts:23-62`.
- ✔ The shallow response is known before ingest starts —
  `ops/network/network-transfer.ts:116-150`. A fetch may ingest a second pack
  for tag following — `ops/network/network-fetch-mapped.ts:293-317`.
- ✔ Hydration ingests through `transferPack` without a promisor —
  `ops/network/network-promisor.ts:46-110`.
- ✔ Projection readers that matter after ADR-0029:
  `WALK_TREE_SQL`, `WALK_TREE_DIFF_SQL` (`store/trees/tree-walk-sql.ts:1,160`,
  a missing source is an `ECORRUPT` error row, `:128,201-211`); maintenance
  `treeExpansion` (`store/maintenance/reachability/reachability-expand.ts:105-139`,
  missing or incomplete → error); sparse snapshot and depth readers
  (`do-fs/sparse/snapshot.ts:49,240,270`, `do-fs/sparse/tree-resolution.ts:17`)
  degrade to `available: false`.
- ✔ Walk wrappers yield rows lazily from `db.iterate` —
  `store/trees/tree-walk.ts:48-140`. Exposed on the shared and checkout stores —
  `store/repository/shared-objects.ts:129-146`, `store/checkout/checkout.ts:164-180`.
- ✔ Loose tree writes seed through the `git_tree_sources_loose_insert` trigger
  and index immediately — `store/schema/schema-tree-statements.ts:48`,
  `store/objects/objects-write.ts:62,174`, `store/objects/objects-batch.ts:210`.
- ✔ `transactionSync` nests as a savepoint in the local adapter —
  `packages/local/src/sqlite/database.ts:281,354`.
- ✔ Pack deletion removes a tree's projection with its last copy —
  `store/pack/lifecycle/lifecycle-delete.ts:142-161`.
- ✔ ADR-0026 gates `clone.v8.peakUsedPlusExternalBytes` at 450 MiB.

## Work units

### WU0 — Commit the full-history clone harness (S)

- **Problem.** The baseline and target come from a scratch harness
  (`reprofile/`). `bench:workerd:nextjs` clones at depth 1
  (`bench/workerd/worker.ts:210`).
- **Scope.** Add a full-history `blob:none` mode to `bench/workerd/run.ts`
  (flag `--history=full`). It reuses the fixture, Miniflare setup, statement
  counts and V8 memory sampling. It reports wall time, statements, rows,
  HEAD, tracked files, a clean worktree and `clone.v8.peakUsedPlusExternalBytes`.
  The depth-1 default and its ADR-0026 gate stay unchanged; the full mode
  reports memory without gating it. Document the mode in `bench/CLAUDE.md`.
- **Acceptance.** One leased run (`cpu-lease run -n 2 --no-smt`) at the WU0
  commit reproduces the baseline within noise: 6,414 statements, same HEAD,
  24,252 files, clean. Record it in the run log.
- **Touch points.** `bench/workerd/*`, `bench/CLAUDE.md`.

### WU1 — Pack reference collector, promises from it, fresh-store check (L)

- **Problem.** Promise registration joins every pack tree's projection
  (`store/fetch/promisor.ts:122-166`). A fresh clone runs the history-wide
  connectivity statement (50.2 s) although its store is empty.
- **Verify first.**
  - Record the `bench:statements` rows for clone, fetch and partial clone.
  - Record the promise set of a `--no-checkout` `blob:none` clone of the pinned
    fixture, served over `tests/helpers/http-backend.ts` with
    `uploadpack.allowFilter`.
- **Scope.**
  1. **Collector.** A pack reference collector, fed from `insertResolved`.
     - It is an open-addressing table keyed by 20-byte binary OID, sized from
       the pack header count and grown by rehash.
     - Each slot holds the in-pack type and the expected-type bits referenced.
     - Commits contribute tree and parents. Tags contribute target and declared
       type. Trees contribute their entries by mode.
     - Streamed trees and tags use the existing re-inflate path; chunked trees
       use the streaming tree parser.
     - No per-edge storage.
  2. **Ingest option.** A `connectivity` option on `packs.ingest` carries the
     filter, the promisor remote, the shallow response and the operation's
     accepted packs. Only `transferPack` supplies it, so the store primitive and
     the ~27 test files that ingest arbitrary packs stay unchecked.
  3. **Promises.** In a filtered fetch, the unresolved blob references, minus
     present blobs, are inserted as promises in fixed pages, inside the pack's
     publication transaction. This replaces `addBlobsFromPackTrees` for every
     fetch, fresh or not.
  4. **Fresh-store check.** When the store was fresh at fetch start (ADR-0029),
     the publication transaction resolves every reference by the ADR-0029 rules
     and skips the SQL walk:
     - missing → `ObjectNotFoundError`, which the fetch maps to `EFETCHFAIL`;
     - type mismatch → `CorruptError`;
     - either failure leaves the pack unpublished.
     Non-fresh fetches keep `validateFetchedConnectivity` unchanged in this WU.
  5. **Docs.** Rewrite ADR-0015's registration sentence. Update
     `docs/reference/git-support.md:619-639` and the ingest pipeline in
     `docs/reference/architecture.md`.
- **Acceptance / witness.**
  - New `tests/fetch-pack-connectivity.test.ts`, built on real-git fixtures.
  - **Accepted:**
    - A full clone, a `blob:none` clone and a `--depth` clone publish.
    - The `blob:none` promise set equals the `?` lines of native
      `git rev-list --objects --all --missing=print` on a native `--no-checkout`
      `blob:none` clone of the same origin, both taken before hydration.
    - A gitlink entry is not checked.
    - The tag-follow second pack resolves into the first.
    - A clone runs no connectivity walk statement; the test asserts it by SQL
      text. A fetch into a repository that already holds a complete pack
      keeps the SQL walk.
  - **Rejected on a fresh store.** Each case leaves no ref, no complete pack and
    no promise row, and each must be accepted by the old code or fail with a
    different code:
    - a tree naming a missing subtree (`EFETCHFAIL`; before: `ECORRUPT`);
    - a missing parent without a boundary (`EFETCHFAIL`);
    - a blob-mode entry naming a tree object (`ECORRUPT`);
    - a tag whose target is missing or of the wrong type;
    - a dangling unreachable object (rejected; ADR-0029 divergence).
  - **Existing tests.** `tests/network-connectivity.test.ts:98-131` uses the
    deleted `addPromisedBlobsFromPackTrees`. Port it to the collector path. Its
    loose-graph cases (`:133-245`) still exercise the non-fresh SQL walk and
    stay until WU3. `tests/network-integrity.test.ts`, the partial-clone and
    shallow suites pass.
  - **Measured with the WU0 harness.**
    - The connectivity statement and the promise projection join disappear
      from the clone profile; the promise insert remains.
    - The full-history and depth-1 V8 peaks are reported, and the depth-1 peak
      stays ≤ 450 MiB.
- **Touch points.**
  - New: `store/pack/ingest/ingest-references*.ts`.
  - Store: `store/pack/ingest/ingest-projection.ts`, `store/pack/ingest.ts`,
    `store/pack/packs.ts`, `store/fetch/promisor.ts`,
    `store/repository/shared-objects.ts`, `store/repository/shared.ts:45`,
    `store/repository/shared-support.ts:35`, `store/checkout/checkout.ts:115`,
    `store/checkout/checkout-mutations.ts:40,113`.
  - Ops: `ops/network/network-transfer.ts`, `ops/network/network-connectivity.ts`,
    `ops/network/network-fetch-mapped.ts`.
  - The tests above. The baselines in `bench/statements.ts` are leader-owned.

### WU2 — Expand maintenance trees without a projection (M)

- **Problem.** Maintenance `treeExpansion` throws when a reachable tree has no
  complete projection (`store/maintenance/reachability/reachability-expand.ts:105-139`).
  After WU4 that is the normal state of historical trees. Marking all of history
  must not project all of history.
- **Verify first.**
  - Read how expansion pages 256 edges per durable step
    (`reachability-contracts.ts:4`) and which edge fields it publishes.
  - Add a maintenance-cost row for a history of unprojected trees and record it.
- **Scope.**
  - Applies when the source has no row. A `complete = 0` source is an
    unprojectable tree; it is parsed the same way.
  - Read the tree object through the store's object reader, parse it, and
    publish its edges with the same ordinals, modes and `allowPromisedMissing`
    semantics.
  - Parse once per durable step. Carry the parse position, or bound the skip,
    so that a large tree is not re-parsed for each 256-edge page.
  - Write no projection and bump no generation. A tree object that does not
    parse is `CorruptError`.
- **Acceptance / witness.**
  - New cases in the maintenance reachability suite. A reachable tree without a
    projection marks the same objects as with one; the test deletes the source
    row to simulate the WU4 state, and it must fail before the change. A
    promised blob under such a tree stays a terminal leaf. A tree of more than
    256 entries expands across steps.
  - The cost row stays linear in edges.
  - The maintenance suites pass.
- **Touch points.** `store/maintenance/reachability/*`; maintenance tests;
  `tests/maintenance-cost.test.ts` (new row only).

### WU3 — Non-fresh fetch connectivity without a history walk (L)

- **Problem.** After WU1, a non-fresh fetch still runs the history-wide SQL
  walk. That walk needs every historical projection, which WU4 removes.
- **Verify first.**
  - Measure the reachability walk from the ref tips over `git_commits` on a
    full-history Next.js store; it is the new per-fetch fixed cost.
  - Confirm that `request.haves` (`network-transfer.ts:24-49,111-116`) only
    adds ref-reachable commits.
  - Measure a one-commit incremental fetch on the full-history Next.js store,
    from the old SQL walk to the new check.
- **Scope.**
  1. **Non-fresh rule.** Extend the WU1 check to non-fresh stores by the
     ADR-0029 rule:
     - An external commit must be reachable from the refs at fetch start, or
       from the `HEAD` of any checkout. Use one recursive walk over
       `git_commits` that exits early once every external commit is found.
       It has no cap (ADR-0005), and its reachable set is cached for the whole
       operation, so the tag-follow second pack does not walk again.
     - An external blob must be present or promised.
     - An external tree in the root-tree closure of a proven external commit
       needs no further check.
     - Any other external tree has its closure verified: every subtree present,
       every blob present or promised.
     - Both closures are read through the store's tree-walk API. After WU4 a
       walk may project trees inside the publication transaction; a rejection
       rolls the projection back with the pack.
  2. **Roots.** Before refs publish, a root that this operation's packs did not
     deliver must be reachable from the refs. Want selection
     (`network-fetch-mapped.ts:273,298`) skips a root only when it is reachable
     from the refs, not merely when it is present.
  3. **Removals.** Delete `store/trees/connectivity.ts`. Remove
     `validateFetchedConnectivity`'s history walk; keep its root type and
     tag-peel checks.
  4. **Docs.** Mark ADR-0029 accepted and finish the reference update.
- **Acceptance / witness.** New non-fresh cases in
  `tests/fetch-pack-connectivity.test.ts`. Each case below fails or is wrongly
  accepted without this change:
  - Scenario A: a `--depth` fetch publishes a pack, then fails before ref
    publication. A later plain fetch of the same tip refetches it and leaves no
    ref on missing history.
  - Scenario B: an unreachable commit whose tree was swept is not accepted as
    an external parent.
  - An incremental fetch on a store that already has those objects publishes.
  - An incremental filtered fetch promises no blob that is present.
  - An unfiltered fetch naming an absent, unpromised blob fails with
    `EFETCHFAIL`.
  - A tree naming a present tree whose closure misses a subtree fails with
    `EFETCHFAIL`.
  - A new bench row for the worst-case reachability walk: an external commit
    that is not reachable, on a long history.

  The loose-graph cases in `tests/network-connectivity.test.ts:133-245` are
  ported to fetch-level equivalents or deleted, each with its reason in the
  test commit. `test:e2e` passes.
- **Touch points.** `ops/network/*`, `store/pack/ingest/ingest-references*.ts`,
  `store/trees/connectivity.ts` (deleted), `store/trees/commits-graph.ts`
  (a reachability reader, if needed), the tests above.

### WU4 — Project trees on demand (L)

- **Problem.** Pack ingest projects every received tree (66 s). After WU1–WU3,
  only walks, sparse readers and maintenance read projections.
- **Verify first.**
  1. Measure the cold HEAD closure on Next.js: read and parse 11,027 trees from
     the pack after ingest. A cost above ~10 s changes the ≤ 60 s target and
     escalates.
  2. List every walk caller and check that it can run a nested
     `transactionSync`. Include callers that interleave lazy streams: status
     `joinSorted3`, three-way integration, `merge-virtual-base.ts:79`,
     `integration-structure-owned.ts:33,43`. Include the local adapter's cursor
     invalidation on nested rollback (`packages/local/src/sqlite/cursors.ts:22-24`).
- **Scope.**
  1. **Ingest.** Remove tree projection from pack ingest (`PackTreeIndex`, the
     pack modes of `TreeIndexBatch`). Keep the collector.
  2. **`ensureTreeClosure(db, repoId, roots)`** under `store/trees/`.
     - It probes in batches, reads missing trees through the object reader,
       parses them, and writes sources and entries level by level.
     - It stops at projected or unprojectable subtrees, and runs in one
       `transactionSync`.
     - Oversized trees become `complete = 0`, as today.
  3. **Walks.** Each walk SQL returns a structured `error_kind = 'missing_root'`
     when its root has no source row. The wrapper detects it before the first
     yield, closes the cursor, ensures the root closure(s) and retries once.
     Every other missing source stays `ECORRUPT`. Remove the dead
     `checkedTrees` parameter and its `checked_trees` SQL
     (`tree-walk.ts:71-79`).
  4. **Loose writes.** A loose tree write ensures its subtrees' closure in the
     same transaction; fold the check into the existing batch where possible.
  5. **Sparse.** Sparse readers keep their `available: false` fallback. Verify
     that the HEAD tree is projected after clone, checkout, commit and reset.
  6. **Docs.**
     - Rewrite ADR-0009's projection-lifecycle paragraphs and mark ADR-0030
       accepted.
     - Update the projection rules in `packages/git/src/CLAUDE.md` and
       `packages/git/src/store/CLAUDE.md`.
     - Update `docs/reference/architecture.md:193,299,311-313,364-366`.
- **Acceptance / witness.**
  - New `tests/tree-projection-on-demand.test.ts`:
    - After a full-history clone, only the HEAD closure is projected.
    - `ls-tree -r`, `diff`, `show` and `log -p` on an old commit equal real git.
      They project only the missing trees, and a second run writes none.
    - A fault inside a closure leaves no projection rows.
    - A loose tree naming an unprojected subtree projects it.
    - A non-fresh fetch whose external tree has no projection publishes, and
      its rejected variant leaves no projection rows.
    - After each case, every `complete = 1` source's subtrees are projected or
      unprojectable.
  - New interleaving witness, run on the node adapter and on Miniflare: status
    and a three-way merge over two unprojected trees, with a fault injected in
    the second closure. Without the fault, results equal real git. With it, the
    operation fails with the injected error and leaves no projection rows. The
    open cursor of the first stream is not used again, so no `ESTALE` is
    raised. The node and Miniflare results are equal.
  - Existing assertions that rely on ingest-time projection, each with an
    explicit disposition in the test commit (re-pointed to on-demand creation,
    or deleted with a reason):
    - `tests/pack.test.ts:1899`
    - `tests/pack-physical-membership.test.ts:203-250`
    - `tests/store-stream.test.ts:1047`
    - `tests/store.test.ts:1044-1049`
    - `tests/rebase-restart.test.ts:149`
    - `tests/maintenance-sweep.test.ts:412,734`
    - `tests/maintenance-cost.test.ts:613-622`
    - `tests/tree-projection-parity.test.ts`, re-pointed: on-demand projections
      equal `git ls-tree -z`.
  - The benches `bench/clone-storage.ts:111` and `bench/tree-schema.ts` are
    re-pointed or their measured meaning is stated.
  - `tests/tree-index-stream.test.ts` and the pack, sparse, status, diff, push
    and maintenance suites pass, as do `test:fs`, `test:shell` and `test:e2e`.
  - `bench:statements -- --check`: rows whose walks hit projected trees do not
    rise. Each row that rises because it now projects on demand gets a
    disposition in the run log, approved by the leader.
  - Measured with the WU0 harness: the projection region disappears from the
    clone profile; the depth-1 V8 peak stays ≤ 450 MiB.
- **Touch points.**
  - Pack ingest: `store/pack/pack-ingest-index.ts`,
    `store/pack/ingest/ingest-projection.ts`, `store/pack/ingest/ingest-index.ts`.
  - Connectivity: `store/pack/ingest/ingest-references*.ts` (its walks now
    meet unprojected trees).
  - Trees: `store/trees/tree-index*.ts`, new `store/trees/tree-closure.ts`,
    `store/trees/tree-walk.ts`, `store/trees/tree-walk-sql.ts`.
  - Objects: `store/objects/objects-write.ts`, `store/objects/objects-batch.ts`.
  - Stores: `store/repository/shared-objects.ts`, `store/checkout/checkout.ts`.
  - The tests, benches and docs above.

### WU5 — Measure and close (S)

- Re-run the WU0 harness and the native baseline under the same lease and
  profile the result. Record wall time, statements, rows and both V8 peaks. If
  the depth-1 measure dropped, lower the ADR-0026 limit in the same change.
- File backlog items for what remains above ≤ 60 s or toward the ≤ 30 s
  stretch: pack object rows, native SHA-1, and a sliced resumable clone under
  the Durable Object CPU limit.
- Archive the sprint with its OUTCOME, and update `INDEX.md` and the READMEs.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Changes the fetch acceptance rule and the projection model; every Git read path is downstream | `npm run typecheck`, `npm run check`, `npm test`, `bench:statements -- --check` after each WU; `npm run test:full` at closure | any Git-visible behaviour change not listed in ADR-0029/0030 |
| WU0 | Bench-only | one leased run reproducing the baseline; leader review | the baseline is not reproduced |
| WU1 | Fundamental: a wrong check accepts a disconnected graph or rejects valid clones | its witness + `test:e2e`; independent review to clean (fixes re-reviewed) | a change to pack publication order beyond adding the check inside it |
| WU2 | Normal: read-only fallback inside maintenance, which deletes data | its witness + maintenance suites; one independent review | any write or generation bump in the fallback |
| WU3 | Fundamental: the soundness of every incremental fetch | its witness + `test:e2e`; independent review to clean | a one-commit incremental Next.js fetch is not faster than the old SQL walk, or takes > 5 s |
| WU4 | Fundamental: reads become writes; a broken invariant is `ECORRUPT` on a hot path | its witness + `test:fs`, `test:shell`, `test:e2e`; independent review to clean | a walk caller that cannot run a transaction; a steady-state statement rise; cold HEAD closure > 10 s |
| WU5 | Measurement only | leased runs, numbers recorded with commit | target missed by > 20 % |

## Test cadence

- **Per WU.** The exact witness above, plus the listed slices.
- **Routine integration.** `npm test` (< 30 s) and `bench:statements -- --check`
  after each committed WU.
- **Sprint closure.** `npm run test:full` once, after the final reviews.
- **Failure loop.** Reproduce with the exact file, and run a negative control
  against the pre-change commit before blaming the WU.

## Out of scope (explicit)

- **Implicit promises without `git_promised_blobs` rows.** Registration becomes
  a set insert from ingest, so explicit rows stay and ADR-0015's model stands.
- **Pack object rows (16.7 s), native SHA-1 and a Wasm codec kernel.** These are
  measured after WU5.
- **A sliced, resumable clone under the Durable Object CPU limit.** It is filed
  at WU5.
- **Background projection of history.**

## Decisions

- [ADR-0029](../decisions/0029-check-fetched-connectivity-per-pack.md):
  connectivity is checked per received pack, at ingest, through an option
  supplied by the fetch.
  - A fresh store resolves only inside the fetch's packs.
  - A non-fresh store follows Git's `--not --all` rule.
  - Dangling unreachable objects are rejected.
  - A missing subtree is `EFETCHFAIL`.
- [ADR-0030](../decisions/0030-project-trees-on-demand.md): trees are projected
  on demand.
  - A tree has three projection states.
  - The projected set is downward-closed.
  - Walks retry once on `missing_root`.
  - Maintenance parses without projecting.
- Promises stay explicit rows (ADR-0015); only their source changes.
- ADR-0003 (row ownership) and ADR-0004 (trusted reads) hold unchanged.
  Projections stay repository-owned derived rows and are written from
  authenticated objects.

## Sequencing

| Wave | Units | Note |
|---|---|---|
| 1 | WU0 ∥ WU1, then WU2 when WU0 lands | at most two agents; WU0 (`bench/workerd`) and WU2 (`store/maintenance`) are disjoint from WU1 |
| 2 | WU3 | after WU1; shares `ops/network` and the collector |
| 3 | WU4 | after WU2 and WU3 |
| 4 | WU5 | after WU4 is committed |

## Plan review

- **Reviewer:** independent Claude agent (general-purpose), two rounds
  against `dddf98a`.
- **Verdict:** round 1 blocked; round 2 approved with changes, folded in.
- **Material findings:**
  - Round 1 (blocking): "present ⇒ closed" is false at HEAD. A failed shallow
    fetch leaves a published pack without a recorded boundary, and the sweep
    order can leave an unreachable commit without its tree. → ADR-0029 now uses
    Git's `--not --all` rule for non-fresh stores. Want selection uses
    reachability, not presence. WU3 holds the witnesses.
  - Round 1 (material): the shallow rule was reversed; the check was always on
    in `packs.ingest`; existing tests were misdescribed; the `EFETCHFAIL` change
    was undeclared; oversized trees broke the invariant; the list of projection
    assertions was incomplete; there was no interleaving witness; the harness
    was uncommitted. → All folded in: the ingest option, three projection
    states, `missing_root`, the WU4 lists, and WU0.
  - Round 2 (material): verifying external trees cost a full checkout closure,
    so ref-reachable parent trees are now the stop set. WU3 did not say how the
    closure check is built; it now uses the walk API, and WU4 covers it. The
    walk was described as bounded; it is now an early-exit walk with no cap,
    plus a bench row.
  - Round 2 (minor): the trust premise is stated, the witness outcomes are
    exact, ADR-0030's error change is declared, and a fresh-path witness was
    added.

## Run log

- **WU0 baseline (`d3f230f`, isolated snapshot, one leased run).**
  - 179.5 s wall, 6,373 statements, 537,955 rows, HEAD `497ec6aa`, 24,252 files,
    clean worktree.
  - `clone.v8.peakUsedPlusExternalBytes` was 987,608,064 (942 MiB). The full
    mode reports this peak and does not gate it.
  - The first WU0 run (6,419 statements) is void: WU1 edits were in the tree.
- **WU1 statements.** `transport.fetch` rose from 72/53 to 76/56. The extra
  statements are the fresh-store probe, two shallow reads at ingest start and
  the shallow revision re-read at publication. Accepted and rebaselined.
- **WU1 deferred to WU3.** A tag-fallback round on a fresh store can fail
  closed (`EFETCHFAIL`) when a concurrent fetch publishes the same tag object
  during the awaits. WU3 reworks want selection, so it computes fallback wants
  against the accepted packs.
- **WU1 deferred to WU4.** Streamed trees are inflated twice, once for the
  collector and once for the projection. The projection goes away in WU4.
- **Stale workflow results.** `nextjs:git.clone` in `bench:statements` reads a
  stale, ignored `bench/results/nextjs-workflow.json` from Sep 24. It is
  report-only and predates this sprint.
- **WU1 measured (`bb69e93`, isolated snapshot, leased).**
  - The clone ran 230.5 s wall: 6,420 statements, 477,263 rows, V8 peak 776 MB
    (baseline 988 MB).
  - Wall time is noisy at load ~15, so the CDP profile is the authority. It
    shows 194.5 s busy, against 204.2 s at `8bd064f`.
  - Connectivity fell from 50.2 s to 0.09 s, and the promise projection join is
    gone.
  - The collector costs about 25 s on its own. It parses with `TreeParser`,
    which decodes every name and mode as text, then converts each OID to hex
    and back (`hexWord` 5.3 s, `toHex` 3.2 s, `isOid` 3.4 s, plus the
    `TreeParser` push, take and decode work).
  - → **WU1b** (added, S, after WU3, same territory): replace the collector's
    tree parse with a byte scanner that reads the raw 20-byte OIDs into the
    table's words. It decodes no names, does no hex round trip, and keeps the
    mode and structure checks. Witness: the WU1 suites, plus a profile showing
    the collector under 3 s.
- **WU2 schema.** The fallback carries the byte offset of `edge_cursor` in a new
  nullable `git_maintenance_objects.edge_offset`, the leader's remedy for
  quadratic paging. A call keeps expanding an incomplete tree until its budget
  ends, so a tree over the 2 MiB object-cache admission limit is read once per
  call, not once per page. Statements are unchanged: `maintenance.mark-*` stays
  at 10/8.

