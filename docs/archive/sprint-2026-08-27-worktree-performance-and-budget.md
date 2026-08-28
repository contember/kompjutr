> **OUTCOME — shipped 2026-08-27.** Explicit add now uses bounded exact-first
> selection, commit reuses authenticated unchanged HEAD subtrees and advances
> the tracker baseline, full status combines its prepass and safely prunes clean
> ignored trees, and whole-tree checkout uses active-frontier differences and a
> shared create-only initial materializer. The checkout harness measures real
> source-to-target transitions. Commit map: plan → `16e8025`; WU1 → `dce2ab6`;
> WU0 → `034bf7b`; WU2 → `8213000`, `2dd6040`, `272a8f4`, `d03aa70`; WU3 →
> `e472d31`, `b77195d`, `de4fc72`; WU4 → `4154b9d`; WU5 → `b8eba1d`,
> `bf86471`; WU6 → `3e7251e`, `ea59822`, `d4098af`; contract corrections →
> `b2aab9c`, `d33239b`, `bf997c2`. Verification: `npm run check`, typecheck,
> build, package smoke, docs lint, and the full suite — 119 files, 2,180 passed,
> 5 skipped.
> Three CPU-leased Next.js runs kept every operation below 1,000 statements;
> every run for add, commit, clean post-commit status, and both real checkout
> directions was below 100 ms. Their maxima were 76.957, 58.832, 29.558,
> 89.446, and 79.682 ms. Backlog closed: 10, 54, 56, 57, and 60–62. Deferred:
> production Durable Object timing, concurrency/restart conformance, repack and
> garbage collection, audit/integrity tooling, glob pathspecs, deployment, and
> publication.

# Sprint — Worktree performance and budget closure (2026-08-27)

**Goal.** Make the common Next.js-sized add, commit, status, and checkout paths
meet their truthful SQL and wall-time contracts without weakening bounded
fallbacks or Git parity.

**Theme.** Backlog items 10, 54, 56, 57, and 60–62 describe one remaining
release boundary: work proportional to the full repository still hides behind
operations that touch at most 1,000 paths, one benchmark reports checkout work
it never performed, and standalone checkout can exceed the universal statement
ceiling. The sprint first fixes measurement and shared optional acceleration
seams, then closes each hot path against the same 24,252-file fixture.

## Refs re-verified at HEAD (2026-08-27)

`✔` = confirmed live · `⚠` = drift/nuance caught.

- ✔ The current curated workflow reports `add — 100` at 656.4 ms, `commit —
  100` at 496.2 ms, clean post-commit status at 502.2 ms, and the two real
  branch transitions at 519.8 and 526.5 ms —
  `docs/reference/benchmark-current.md:17`.
- ✔ Both force-checkout phases immediately repeat the branch already checked
  out, so their 7.1 and 6.7 ms rows are no-op measurements —
  `bench/nextjs-workflow.ts:209`.
- ✔ Explicit `add` performs one scalar worktree lookup and possibly one scalar
  index prefix probe per spec, then streams the full index and applies a linear
  matcher to each row — `src/core/ops/staging.ts:74`,
  `src/core/ops/staging.ts:130`, `src/core/ops/staging.ts:833`.
- ⚠ The current sparse hydration source cannot implement explicit-path `add`:
  it mixes tree and checkout facts, caps requests at 1,000 paths, and is not
  available to the operation. A separate optional same-database selected-path
  source is required; generic and Computer callers keep the current bounded
  fallback — `src/core/context.ts:24`, `src/sqlite/sparse-workspace.ts:1247`.
- ✔ Full status performs a rename HEAD/index prepass, a second index snapshot,
  and the main HEAD/index/worktree join. The 24,252-file witness records 75
  index page statements — `src/core/ops/status.ts:234`,
  `src/core/ops/status.ts:297`, `tests/status.test.ts:996`.
- ⚠ Combining rename classification with the index snapshot can reduce index
  passes from three to two, but exact rename detection still requires two HEAD
  traversals while `statusStream()` stays lazy and bounded —
  `src/core/ops/status.ts:224`, `src/core/ops/status.ts:267`.
- ✔ Status deliberately walks with `includeIgnored: true` so tracked ignored
  paths remain visible, then discards untracked ignored rows in JavaScript —
  `src/core/ops/status.ts:314`, `src/core/ops/status.ts:387`.
- ⚠ A directory-prune callback can skip every later scan page under an ignored
  subtree, but the filesystem has already materialised the current 1,000-row
  page. The witness must allow at most that first-page spill rather than claim
  zero raw descendant rows — `src/core/ops/worktree-io.ts:131`,
  `src/core/ops/worktree-io.ts:190`.
- ✔ Commit always scans the whole index and serialises every open directory;
  the tracker exposes a sealed baseline and bounded dirty rows but no narrow
  baseline advance or authoritative commit-tree snapshot —
  `src/core/ops/commit.ts:149`, `src/core/ops/tree-build.ts:243`,
  `src/sqlite/index-tracker.ts:376`.
- ✔ Ordinary commit and `commitIndex()` publication stay inside one synchronous
  SQLite transaction. Merge and replay also publish through `commitIndex()`,
  while `writeUnpublishedCommit()` must neither reuse HEAD state nor move the
  tracker — `src/core/ops/commit.ts:84`, `src/core/ops/commit.ts:128`,
  `src/core/ops/commit.ts:140`.
- ✔ Standalone checkout into an empty 24,252-file worktree costs 1,117 SQL
  statements, while clone stays at 813 through a bounded initial-state writer —
  `docs/reference/benchmark-current.md:151`, `src/core/ops/network.ts:565`.
- ⚠ Empty-worktree materialisation and ordinary branch transition are separate
  defects. The first can reuse the existing initial writer; the second is a
  51-statement CPU hotspot whose root cause remains profile-gated —
  `src/core/ops/refs.ts:202`, `src/core/ops/sparse-checkout.ts:136`.

## Work units

### WU0 — Freeze optional acceleration seams (effort L)

- **Problem.** Add, status, commit, and checkout currently share linear pathspec
  helpers, one worktree walker, and context/runtime composition. Parallel units
  would otherwise edit the same hot files or invent incompatible cache rules.
- **Verify first.** Pin current pathspec semantics for empty/dot/trailing-slash,
  non-BMP order, file/directory replacement, ignored paths, and conflict stages;
  pin tracker corruption and unavailable-source fallbacks.
- **Scope.** Extract one compiled byte-ordered exact/prefix matcher while keeping
  the existing `matchesPaths` re-export; add an optional directory-prune predicate
  to the worktree walker; add separate optional same-database sources for
  explicit-path facts and commit-tree reuse; add
  `IndexTrackerWriter.advanceBaseline()`. Add a positive capability check that
  proves the initial worktree writer participates in the supplied Git database's
  synchronous transaction domain. Wire native workspace composition. Generic
  and compatibility paths remain available without these sources.
- **Acceptance / witness.** Existing pathspec and walker output is unchanged;
  selected-path facts are paged, bounded, ordered, and fully validate SQL rows;
  tree snapshots authenticate every reused source. A request that exceeds a
  declared input or retained-state bound returns `available: false` or stable
  `E2BIG` before emitting partial facts; malformed stored rows and invalid dirty
  state remain corruption and fail closed. Baseline advance changes only a
  sealed state and participates in its caller's outer transaction. The initial
  writer capability returns true only for the exact native Git database wrapper
  composed over the same raw database.
- **Touch points.** `src/core/context.ts`, `src/core/sparse-workspace.ts`,
  `src/core/ops/checkout.ts`, `src/core/ops/worktree-io.ts`,
  `src/fs/store/initial-write.ts`, `src/git/client.ts`,
  `src/sqlite/index-tracker.ts`, `src/sqlite/sparse-workspace.ts`,
  `src/runtime/workspace.ts`, `tests/index-tracker.test.ts`,
  `tests/sparse-workspace.test.ts`, `tests/workspace.test.ts`, and focused
  pathspec/walker tests selected and recorded before WU0 implementation.

### WU1 — Correct force-checkout measurement (#60, effort S)

- **Problem.** The force rows time an equal-tree no-op and cannot be used as
  evidence about real checkout work.
- **Verify first.** Record that each current force phase starts with HEAD already
  on its target and that direct equal-tree diff performs no work.
- **Scope.** Make each force phase perform the same real branch transition as its
  non-force counterpart, without folding setup into the timed phase. Keep push
  and fixture cleanup guarantees unchanged.
- **Acceptance / witness.** Harness state proves source and target differ before
  both force phases. A leased baseline run reports comparable rows and statement
  shape for equivalent force/non-force transitions; no force row can pass on an
  equal-tree transition.
- **Touch points.** `bench/nextjs-workflow.ts`, focused benchmark helpers/tests;
  measurement output is recorded in WU7.

### WU2 — Bound explicit-path add (#61, effort L)

- **Problem.** N explicit specs spend O(N) scalar statements before the walk and
  scan unrelated index/worktree rows with O(N) JavaScript matching.
- **Verify first.** Pin Git parity for mixed exact and directory specs, overlaps,
  unmatched specs, ignored paths, conflict stages, symlink ancestors, and
  file/directory replacements.
- **Scope.** Use WU0's native source for bulk exact and multi-prefix selection;
  classify exact and directory sides without losing replacement semantics; use
  one compiled matcher for remaining merge joins. Preserve the full streaming
  implementation for `all` and `trackedOnly`, and preserve generic fallback.
- **Acceptance / witness.** Exact selection uses two selected-path fact
  statements and returns only N worktree/index facts for N = 1, 100, and 1,000,
  independent of repository size. Directory cost follows selected
  subtrees, not the repository. A 1,000-file mutation stays below 1,000 SQL
  statements; `add — 100` is below 100 ms in repeated leased runs. Total
  mutation/hash statements may follow their bounded batch formula and are not
  falsely claimed constant.
- **Touch points.** `src/core/ops/staging.ts` and `tests/staging.test.ts`. WU0
  exclusively owns the source implementation and its focused tests.

### WU3 — Prune ignored status and merge its index prepass (#54, #57, effort M)

- **Problem.** Full status streams ignored subtrees it will not report and, with
  renames enabled, pages the entire index three times.
- **Verify first.** Pin current Git output for tracked files inside ignored
  directories, ignored-row modes, rename fallback, and abandoned lazy streams.
- **Scope.** Feed WU0's directory-prune predicate with "ignored directory and no
  tracked descendant" when ignored rows were not requested. Combine rename
  classification and tracked-directory/path collection in one bounded prepass.
  Keep the main lazy join and exact-rename fallback unchanged.
- **Acceptance / witness.** An ignored subtree with at least 2,500 files yields
  no descendants to the join, reads at most the first 999 descendant rows, and
  uses a constant first-page-plus-seek scan shape. Tracked descendants and
  `includeIgnored: true` disable pruning. At 24,252 paths, rename-enabled status
  uses 50 index page statements instead of 75; rename-disabled normal status
  uses two index passes, and rename-disabled `untrackedFiles: "all"` uses one.
  HEAD remains two traversals with renames and one without. Construction and
  abandonment remain lazy.
- **Touch points.** `src/core/ops/status.ts` and `tests/status.test.ts`.

### WU4 — Advance commit baselines and reuse unchanged subtrees (#56, #62, effort XL)

- **Problem.** Commit rebuilds every tree from a full index scan, then leaves the
  sealed tracker on the previous HEAD so the next clean status diffs two trees.
- **Verify first.** Pin full-build OIDs against Git and record tracker/dirty state
  after ordinary commit, merge, cherry-pick, revert, and unpublished writes.
- **Scope.** When WU0 supplies an authenticated snapshot whose sealed baseline
  equals HEAD, validate all dirty/index/tree rows before object writes, rebuild
  affected directories bottom-up, and reuse untouched HEAD subtree OIDs. Only
  availability or structural-cap failures fall back to the current full build;
  corruption propagates. After successful HEAD publication, advance the sealed
  baseline in the same transaction for ordinary and `commitIndex()` paths,
  retaining dirty rows. Unpublished commits stay on the full path and do not
  advance state.
- **Acceptance / witness.** Fast and forced-full trees are byte-identical to Git
  across add/delete/modify/mode/rename, empty/new/deep directories, root changes,
  and file/directory replacement. Missing/incomplete/mismatched state and a
  snapshot request rejected for declared capacity fall back; malformed tracker,
  index, or tree state publishes neither objects nor refs. A 100-path
  commit reads affected rows instead of 24,252 index entries, completes below
  100 ms in repeated leased runs, and the following clean status avoids a
  baseline-to-HEAD tree diff. Merge/replay publication advances the baseline;
  unpublished writes do not.
- **Touch points.** `src/core/ops/commit.ts`, `src/core/ops/tree-build.ts`,
  `src/core/ops/merge.ts`, `src/core/ops/replay-lifecycle.ts`,
  `tests/commit.test.ts`, `tests/status-sparse.test.ts`,
  `tests/transactions.test.ts`, and the existing merge/replay test files named
  in the assignment. WU0 exclusively owns the snapshot contracts and sources.

### WU5 — Reuse initial materialisation for standalone checkout (effort M)

- **Problem.** Whole-tree checkout into an absent or empty worktree/index repeats
  general removal and materialisation paths and exceeds the statement ceiling,
  while clone already has an atomic bounded create-only writer.
- **Verify first.** Pin the 1,117-statement decomposed Next.js checkout and prove
  the initial writer's absent/empty-root, empty-all-stages, gitlink-dirty, and
  rollback contracts.
- **Scope.** Extract the network-local initial materialiser and use it from clone
  and whole-tree checkout before sparse/full fallback. Eligibility requires no
  path filter, an absent or empty root, every index stage empty, and a WU0 writer
  capability that positively identifies the current Git database as its
  synchronous transaction domain. Unavailable or capacity refusal leaves no
  partial state and takes the existing path.
- **Acceptance / witness.** Initial checkout writes exact bytes, modes, symlinks,
  index, HEAD/reflog, and a clean sealed tracker; gitlinks remain skipped and
  dirty. Nonempty root/index, conflict stages, and path checkout remain on legacy
  semantics. Injected late failures roll back filesystem, index, mappings,
  tracker, refs, and reflog. The 24,252-file decomposed checkout is below 1,000
  SQL statements with exact end-state parity; no sub-100-ms claim is made for
  materialising that many files.
- **Touch points.** New `src/core/ops/initial-checkout.ts`,
  `src/core/ops/network.ts`, `src/core/ops/refs.ts`, initial checkout/clone tests,
  and `bench/clone-storage.ts`. WU0 exclusively owns `src/core/context.ts` and
  `src/fs/store/initial-write.ts` capability contracts.

### WU6 — Close ordinary branch-checkout wall time (#10 checkout half, effort L)

- **Problem.** Two branch transitions that change only 100 files cost about 520
  ms despite staying at 51 SQL statements; tree-diff validation is only a lead,
  not a proven attribution.
- **Verify first.** Profile direct tree diff, guard/hydrate, hashing, writes, and
  reseal separately for 100 and 1,000 changed leaves, concentrated and spread,
  on the same 24,252-file trees. Compare sparse checkout with forced legacy
  fallback; equal-tree diff is the negative control.
- **Scope.** Optimize the measured dominant phase only. Preserve authoritative
  tree-source validation, sparse fallback, structural guards, path ordering,
  and all resource ceilings. A result requiring a new public/storage contract or
  a changed trust boundary is a material re-gate, not an implicit expansion.
  Profiling is a read-only gate. Before implementation, the leader records the
  attribution, exact production/test write territory, and focused gates in this
  run log and commits that amendment. No WU6 implementation starts before that
  territory is frozen.
- **Acceptance / witness.** Both real 100-change branch directions complete below
  100 ms across repeated leased runs; the 1,000-change boundary remains below
  1,000 SQL statements with exact index/worktree/HEAD parity. Corrupt, shallow,
  over-cap, dirty, conflict, and structural cases retain their current fail-closed
  or bounded fallback behavior.
- **Touch points.** None until the read-only profile gate freezes exact paths.
  The expected candidates are `src/core/ops/sparse-checkout.ts`, bounded
  tree-diff or hydration code, checkout-focused tests, and profiling helpers;
  they are not authorized write territory merely by appearing here.

### WU7 — Integrated measurement and release claim (effort M)

- **Problem.** Per-unit cost witnesses do not prove the complete workflow or a
  publishable performance claim.
- **Verify first.** Run functional gates before any timing run and confirm the
  CPU lease has idle SMT siblings.
- **Scope.** Run repeated leased Next.js workflow and clone-storage measurements;
  update the curated snapshot and README resource/status claim from the measured
  result; close consumed backlog and archive the sprint.
- **Acceptance / witness.** Every accepted operation remains below 1,000 SQL
  statements. The exact leased wall-time rows `add — 100`, `commit — 100`, clean
  post-commit status, and both real 100-change checkout directions are each below
  100 ms across repeated runs. The 1,000-path add/commit/checkout witnesses prove
  the statement ceiling and bounded row/batch scaling, not a sub-100-ms claim.
  Full CI-equivalent checks, package smoke, docs lint, and repeated measurement
  state checks pass.
- **Touch points.** `bench/`, `docs/reference/benchmark-current.md`, `README.md`,
  sprint/backlog/docs indexes.

## Out of scope (explicit)

- Production Durable Object execution remains
  [11](sprint-2026-08-27-production-do-probe.md); this sprint produces the
  local release-candidate baseline it should test but does not deploy.
- Systematic async interleaving and restart conformance shipped later in the
  [concurrency sprint](sprint-2026-08-27-concurrency-and-restart-conformance.md).
- Repack/garbage collection and public audit/snapshot formats remain
  [04](sprint-2026-08-27-repack-and-garbage-collection.md) and
  [17](../backlog/17-integrity-audit-and-snapshots.md); no object deletion or new
  persistent format lands here.
- Glob pathspec syntax remains [36](../backlog/36-glob-pathspecs.md). WU0 only
  compiles the existing exact-or-directory-prefix contract.
- Deployment, publication, version changes, benchmark claims from unleased runs,
  and changes to the universal memory/statement ceilings are excluded.

## Decisions

- Native same-database acceleration is optional behind narrow context sources;
  generic and Computer-compatible callers retain the correct bounded fallback.
- SQL rows used by a fast path are untrusted. Corruption fails closed; only an
  unavailable source or an explicitly bounded capacity refusal may fall back.
- Baseline advance applies to every HEAD-publishing `commitIndex()` path in the
  same transaction. `writeUnpublishedCommit()` never moves it.
- Exact rename status keeps two HEAD traversals to preserve lazy bounded output;
  #57 closes redundant index passes, not that deliberate traversal.
- Ignored-directory pruning accepts one already-materialised scan-page spill and
  prevents all later pages; a stronger zero-row claim would require a separate
  database range-prune architecture.
- Initial checkout reuses the proven create-only writer. It does not generalise
  or weaken ordinary structural checkout semantics.
- Ordinary checkout implementation follows measured attribution. No tree-walk,
  hydration, or filesystem redesign is assumed before the profile.

## Sequencing

| Wave | Units | Parallelism |
|---|---|---|
| 0 | sprint contract; WU0 seams; WU1 benchmark truth | two implementers after the contract |
| 1 | WU2 add; WU3 status; WU4 commit | three disjoint implementers after seams freeze |
| 2 | WU5 initial checkout; WU6 profiled branch checkout | sequential where profiling or shared checkout ownership requires it |
| 3 | WU7 integrated gates, measurements, docs, backlog closure | leader-owned and serialized |

Every implementation receives an independent review from an agent that did not
write it. The leader verifies and commits each green unit before the next unit
may reuse its result. Single-tree isolation is used with explicit write
territories; CPU-heavy gates and every reported benchmark run use `cpu-lease`.

## Run log

- The user approved the performance-and-budget option before execution.
- Grounding corrected the raw-row and HEAD-traversal claims in #54 and #57; this
  active plan is the execution contract.
- The user-approved narrow tracker/tree seam is optional and fallback-compatible;
  it also advances all HEAD-publishing `commitIndex()` paths for one consistent
  tracker contract.
- WU1–WU5 landed as `dce2ab6`, `034bf7b`, `8213000`, `e472d31`,
  `b77195d`, `4154b9d`, and `b8eba1d`. The clone-storage harness follow-up is
  `bf86471`. A leased decomposed Next.js checkout at that revision used 608 SQL
  statements, below the WU5 limit of 1,000.
- WU6's read-only gate used the real 24,252-path Next.js fixture under
  `cpu-lease run -n 2 --no-smt`. After warm-up, three-run medians were 2,640.0 ms
  for 100 concentrated changes and 1,916.6 ms for 100 spread changes. The
  capability-disabled legacy controls were 4,860.2 ms and 4,861.0 ms; the
  equal-tree sparse control was 10.09 ms. The 1,000-change concentrated sparse
  run used 75 statements; the spread run fell back after sparse preflight and
  still stayed bounded at 228 statements.
- Phase probes attributed the 100-change cost to the authoritative direct tree
  diff (692–741 ms) and duplicate tree resolution in the guard/hydration phase
  (1,168–1,909 ms).
  Initial-writer eligibility was 3.5–4.3 ms, the blocking-index guard 4.7 ms,
  filesystem writes 11–14 ms, reseal 0.13–0.15 ms, and hashing had zero calls.
  Existing `selectedPaths.select` was also unsuitable as-is (1,408 ms for 100
  exact paths), while an equality-join feasibility probe took 1.90 ms for 100
  paths and 17.53 ms for 1,000 paths.
- WU6 implementation territory is now frozen to
  `src/core/ops/sparse-checkout.ts`, `src/sqlite/sparse-workspace.ts`, and
  `src/sqlite/tree-walk.ts`, with witnesses in `tests/checkout-sparse.test.ts`,
  `tests/sparse-workspace.test.ts`, and `tests/tree-diff.test.ts`. The selected
  source may add a bounded exact-only equality branch, while its general query
  remains unchanged. The branch must preserve the existing two selected-fact
  statements by folding deduplicated ancestor equality and integrity into the
  worktree statement. It also retains the current bounds, ordering, cardinality,
  full-row validation, and corruption behavior. Sparse checkout may combine
  those validated index/worktree facts with authoritative diff candidates and
  must retain the current hydrate and legacy fallbacks. Tree diff may carry the
  already-validated `source_key` into direct `git_tree_entries` joins, but every
  effective-source, authoritative object, completeness, ordinal, raw-edge,
  cumulative-cost, path, cycle, and queue check remains mandatory.
- The raw-object JavaScript diff alternative measured 46.6 ms for 100 changes,
  but it is rejected: it bypasses the binding parsed-edge traversal contract and
  changes missing/corrupt v3 projection behavior. WU6 adds no public capability,
  schema, migration, or trust-boundary change.
- Focused WU6 gates are the three owned test files plus regression runs for
  `tests/staging.test.ts` and `tests/refs.test.ts`, typecheck, exact-file Biome,
  and diff checks. Acceptance adds forward/reverse 100-change concentrated and
  spread witnesses, exact 1,000/1,001 boundaries, malformed/unavailable source
  behavior, structural fallback parity, and repeated leased Next.js checkout
  rows below 100 ms in both real directions.
- The first WU6 implementation and its consolidated review fix passed 21 checkout,
  35 selected-source, 20 tree-diff, and 80 staging/ref assertions, typecheck,
  Biome, and two independent post-fix reviews. A leased integrated run still
  rejected the unit: `add — 100` was 2,233.0 ms, `commit — 100` 1,278.6 ms,
  clean post-commit status 962.8 ms, and the real checkout directions 553.2 ms
  and 519.8 ms. The implementation remains uncommitted because those are sprint
  acceptance failures, not publishable results.
- Read-only leased triage found three repo-wide query plans hidden behind low
  statement and returned-row counts. `WALK_TREE_DIFF_SQL` materialised 13,079
  effective sources and 43,011 parsed edges; it cost 472.8 ms inside the
  integrated checkout and 622 ms in a separate isolated diagnostic. A one-cursor
  parsed-edge prototype visited 725 active-frontier rows,
  returned the same 100 changes, and took 18.9–20.2 ms. Add always requested
  recursive selected facts, spending about 2,198 ms in the general index and
  worktree queries. Commit and clean status spent about 994 ms and 972 ms in
  `SPARSE_TREE_DEPTH_SQL`. The 1,000-path exact preflight also rejected a real
  30,483-byte deduplicated ancestor JSON through a 1,199,308-byte conservative
  estimate, sending two bounded result cursors through tens of millions of
  internal row pairs; the existing exact statements took about 51 ms together.
- The user approved an exceptional second performance-fix wave after that
  evidence. Its write territory is frozen to three disjoint units:
  `src/sqlite/tree-walk.ts` with `tests/tree-diff.test.ts` and the integration-only
  `tests/checkout-sparse.test.ts` for active-frontier leaf diff;
  `src/sqlite/sparse-workspace.ts` with
  `tests/sparse-workspace.test.ts`, `tests/commit.test.ts`, and
  `tests/status-sparse.test.ts` for exact preflight, exact snapshot index, and
  active-frontier tree-depth/entry resolution; and `src/core/ops/staging.ts`
  with `tests/staging.test.ts` for exact-first explicit add classification.
  Existing WU6 production checkout code remains frozen.
- The second wave preserves one recursive parsed-edge cursor, effective-source
  qualification, loose shadowing, complete-pack authority, every marker,
  ordinal, cumulative-cost, raw-edge, path, cycle, queue, retained-memory, and
  statement bound, plus all generic fallbacks. It adds no raw-object traversal,
  public capability, schema, migration, or module-boundary change. Each SQL
  rewrite needs an active-frontier `EXPLAIN` witness and corruption-before-yield
  coverage. The unit is green only after focused tests, two independent reviews,
  and a leased integrated run put all five required rows below 100 ms.
- The exceptional wave landed the active-frontier tree diff in `3e7251e` and
  `ea59822`, selected-workspace reuse in `d4098af`, the exact descendant seam in
  `2dd6040`, and exact-first add in `272a8f4`. Review corrections
  `de4fc72` and `d03aa70` tightened the direct status measurement and snapshotted
  untrusted selected-path facts without changing the public or schema surface.
- The clean three-run Next.js baseline at `d03aa70` used Node v24.4.0, SQLite
  3.50.2, git 2.54.0, Linux 6.17.0-41-generic, and an AMD Ryzen 7 PRO 8840HS
  under a two-vCPU no-SMT lease. Medians were 75.338 ms for add 100, 55.527 ms
  for commit 100, 29.487 ms for clean post-commit status, 87.534 ms for checkout
  to main, and 71.178 ms for checkout to bench-work. Every one of the three runs
  for those five rows was below 100 ms; their maxima were 76.957, 58.832,
  29.558, 89.446, and 79.682 ms. The real force transitions had medians of
  70.305 and 78.531 ms and maxima of 72.793 and 98.198 ms. Every operation
  stayed below 1,000 statements in all three runs and every operation/status
  assertion passed.
- Three self-leased clone-storage runs requested four no-SMT vCPUs and observed
  CPU list `8,10`. Next.js clone had a 9,151.759 ms median and used 824
  statements. Its standalone initial checkout had a 5,339.358 ms median and
  used 608 statements. Both produced the exact expected HEAD, 24,252 index
  entries, and 24,252 worktree leaves. Each final state had the same
  228,667,392-byte allocated database size.
- The final gate passed Biome check, typecheck, all 119 test files with 2,180
  passed and 5 skipped, production build, package smoke, and docs lint.
- Schema cleanup required no final code change. `SCHEMA_VERSION` is 1, fresh
  initialization runs in one `transactionSync()`, and unsupported versions are
  rejected. Commit `21fc1ea` had already removed the intermediate migration
  modules, fixtures, and tests before this sprint closed.
- Production Durable Object timing remains unverified. Backlogs 11, 16, 04, 17,
  and 36 remain, as do deployment and publication.
