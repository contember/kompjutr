# Sprint — Multi-checkout consumer foundation (2026-08-26)

**Goal.** Make one SQLite-native Git store serve isolated session checkouts, expose
the two bounded reads required by Roj, and prove the complete checkout lifecycle
without adding an upgrade chain for the undeployed schema.

**Theme.** Backlog [40](../backlog/40-linked-worktrees.md),
[47](../backlog/47-divergence-against-arbitrary-ref.md), and
[48](../backlog/48-read-symbolic-ref-target.md) are one admission boundary. The
consumer can already express ordinary local Git work, but cannot create two
isolated sessions over one object/ref store or recover its base-branch metadata
after a restart. Success is two checkout roots sharing objects and refs while
keeping HEAD, index, worktree state, operation state, and HEAD history isolated;
the same journey must survive a cold reopen and match real Git where the storage
models overlap.

## Refs re-verified at HEAD (2026-08-26)

`✔` = confirmed live · `⚠` = drift/nuance caught.

- ✔ `git_repositories` still combines the registry root and raw HEAD in one row;
  refs, config, index, and operation state all key from the same `repo_id` —
  `src/sqlite/schema.ts:74`, `src/sqlite/schema.ts:84`,
  `src/sqlite/schema.ts:95`, `src/sqlite/schema.ts:106`,
  `src/sqlite/schema.ts:119`, `src/sqlite/schema.ts:126`,
  `src/sqlite/schema.ts:133`.
- ✔ `SqliteGitDatabase` caches exactly one `RepoStore` per repository id, while
  `RepoStore` owns both `repoId` and `root`; the current seam cannot hand two
  checkout views the same shared store — `src/sqlite/store.ts:1694`,
  `src/sqlite/store.ts:1769`, `src/sqlite/store.ts:1793`,
  `src/sqlite/store.ts:1807`.
- ✔ Directory routing resolves the nearest registered root and constructs one
  `Repository(store, root)`; nested-root exclusion is derived from that same
  registry — `src/core/context.ts:76`, `src/core/context.ts:82`,
  `src/core/context.ts:92`.
- ✔ The public `Git` surface has no worktree lifecycle methods. Every operation
  selects one repository only through `dir` — `src/git/client.ts:144`,
  `src/git/client.ts:195`.
- ✔ Direct-ref and `HEAD` history currently share one repository-wide reflog
  namespace and ordinal. `HEAD` therefore has no checkout identity to preserve —
  `src/sqlite/reflog-schema.ts:27`, `src/sqlite/reflog-schema.ts:38`,
  `src/sqlite/store.ts:3237`.
- ✔ Operation journals, replay steps, touched rows, logical index rows, index
  tracker state, and dirty paths are repository-scoped today; they are precisely
  the rows that must become checkout-scoped — `src/sqlite/schema.ts:54`,
  `src/sqlite/schema.ts:106`, `src/sqlite/schema.ts:119`,
  `src/sqlite/schema.ts:126`, `src/sqlite/schema.ts:141`.
- ✔ The bounded divergence engine already exists internally, but the only public
  consumer is upstream metadata in `statusReport({ branch: true })` —
  `src/core/ops/merge-base.ts:251`, `src/core/ops/status.ts:117`,
  `src/core/ops/status.ts:128`.
- ✔ Ref resolution always follows symbolic refs, and the only symbolic-ref read
  reports the current checkout's HEAD. There is no raw read for
  `refs/remotes/<remote>/HEAD` — `src/core/repository.ts:246`,
  `src/core/repository.ts:256`, `src/core/repository.ts:273`,
  `src/git/client.ts:214`.
- ⚠ Backlog 40 still says to migrate existing repository rows. The Git schema is
  now an undeployed version-1 baseline with exact reopen validation and no upgrade
  chain, so this sprint replaces that baseline directly and deliberately offers
  no compatibility with pre-sprint local databases — `src/sqlite/schema.ts:29`,
  `src/sqlite/schema.ts:713`.
- ✔ Current witnesses cover one repository, exact schema reopen, and
  restart-safe operations, but no test opens two checkout roots over one store —
  `tests/workspace.test.ts:17`, `tests/schema.test.ts:292`,
  `tests/rebase-restart.test.ts:272`.

## Work units

### WU1 — Freeze the store/checkout ownership contract (effort M)

- **Problem.** Moving only `root` and `head` would leave index, operation,
  reflog, cache, and lifecycle ownership implicit. Later units would then choose
  incompatible keys while editing the same central seam.
- **Verify first.** Ask real Git for the shared-versus-per-worktree matrix:
  objects, refs, config, shallow boundaries, HEAD, index, operation state, HEAD
  reflog, branch exclusivity, detached HEAD, clean/dirty removal, and removal of
  a checkout with unique detached commits. Pin the observed public behaviour;
  do not assert `.git/worktrees` layout.
- **Scope.** Write ADR-0009 defining a **store** (objects, packs, refs, config,
  shallow state, derived commit/tree projections, direct-ref reflogs) and a
  **checkout** (root, HEAD, index, index tracker, dirty set, operation state,
  touched rows, and checkout HEAD reflog). Define stable ids, cascade direction,
  branch exclusivity, lifecycle errors, the fixed checkout-count and retained
  state bounds, and how a checkout-scoped HEAD selector is resolved. Record that
  the version-1 baseline is replaced rather than migrated.
- **Acceptance / witness.** ADR-0009 is Accepted before schema implementation
  starts. Its executable ownership-matrix test lands with WU2, when the target
  tables exist; it must fail if a checkout-scoped table is keyed only by the
  shared store id or a shared table is duplicated per checkout.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/reflog-schema.ts`,
  `src/sqlite/operation-schema.ts`, `tests/schema.test.ts`,
  `docs/decisions/0009-*.md`, `docs/decisions/README.md`.

### WU2 — Split the version-1 baseline and storage facade (effort L)

- **Problem.** The registry, shared store, checkout state, and `RepoStore` are
  one physical and TypeScript identity. Re-keying callers before this seam lands
  would duplicate the object cache or accidentally share an index.
- **Verify first.** Inventory every schema column and every `RepoStore` method by
  the WU1 ownership matrix. Search every `repo_id` binding and every `repoId`
  argument; classify it before changing it. Pin the current fresh-init statement
  count and exact-reopen witness.
- **Scope.** Replace the undeployed init schema with shared repository/store rows
  plus checkout rows. Keep `repo_id` as the shared-store key and introduce
  `checkout_id` only for checkout-owned tables. Split the storage facade so all
  checkout views reuse the database-wide object and pack caches and one shared
  ref/config store, while HEAD, index, tracker, dirty rows, and operation rows
  require a checkout id. Validate every joined id and row as untrusted. Preserve
  foreign-key cascades and create the primary checkout atomically with init.
- **Acceptance / witness.** A fresh database creates one store and one primary
  checkout within the existing 1,000-statement budget; exact reopen is a no-op.
  The executable ownership matrix classifies every target table against ADR-0009.
  Two raw checkout facades read the same object/ref/config rows and different
  HEAD/index/operation rows. Cross-store or cross-checkout corruption fails
  closed. No migration module, frozen historical schema, or upgrade test exists.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `src/sqlite/operation-schema.ts`, `src/sqlite/reflog-schema.ts`,
  `src/sqlite/commits.ts`, `src/sqlite/tree-index.ts`, `src/sqlite/tree-walk.ts`,
  `tests/schema.test.ts`, `tests/store.test.ts`, `tests/workspace.test.ts`.

### WU3 — Bind repository views to one checkout without breaking one-checkout callers (effort L)

- **Problem.** Core operations receive `Repository` and `Worktree`, but
  `Repository` currently combines a shared store with one root and reaches
  checkout state through `repo.store`. Existing callers must keep selecting by
  `dir` while checkout-owned reads and writes move behind a distinct seam.
- **Verify first.** Enumerate all `repo.root`, `repo.store.repoId`, HEAD, index,
  and operation-state call sites. Identify hot loops before adding any lookup;
  opening a repository must resolve the checkout once, not query it per path.
- **Scope.** Make `Repository` a checkout-bound view composed from one shared
  store and one checkout store. Route `openRepository`, `findRepository`, and
  `nestedRoots` through checkout roots. Keep every existing public method and
  its `dir` behaviour unchanged for a single checkout. Ensure nested repositories
  and nested checkout roots remain traversal boundaries. Keep object, pack, ref,
  and config APIs on the shared side; make HEAD, index, and operation APIs
  impossible to call without a checkout identity.
- **Acceptance / witness.** The existing suite passes without caller shims. A
  single checkout has byte-identical Git-visible behaviour before and after the
  split. Opening each of two roots returns the correct checkout in a bounded
  number of statements, and a status/checkout traversal performs no new scalar
  lookup per path.
- **Touch points.** `src/core/context.ts`, `src/core/repository.ts`,
  `src/core/ops/`, `src/sqlite/store.ts`, `src/git/client.ts`,
  `tests/workspace.test.ts`, `tests/status.test.ts`, `tests/refs.test.ts`.

### WU4 — Add bounded linked-worktree lifecycle methods (effort L)

- **Problem.** There is no typed equivalent of creating, listing, removing, or
  pruning a checkout over an existing store, and no persisted exclusivity rule
  preventing two checkouts from owning one branch.
- **Verify first.** Pin real Git results for add from default HEAD, add from an
  explicit start point, detached add, an already-checked-out branch, an existing
  root, clean and dirty removal, forced removal, a live operation, missing roots,
  prune, and repeated/idempotent calls. Recheck the retained-state model for the
  fixed 1,024-checkout cap.
- **Scope.** Add typed `worktreeAdd`, `worktreeList`, `worktreeRemove`, and
  `worktreePrune` methods. `worktreeAdd` accepts a missing or empty root and
  creates checkout plus branch/HEAD/index state in one filesystem/SQLite
  transaction; any failure rolls back every write.
  `worktreeList` is ordered with `comparePaths` and capped. Branch ownership is
  enforced in storage with `EBRANCHINUSE`, including direct
  HEAD mutations. Removal always refuses a live operation and force may bypass
  only dirty state; primary removal is forbidden. Prune atomically removes only
  bounded, absent, non-primary checkouts and aborts unchanged if any eligible
  checkout has a live operation.
- **Acceptance / witness.** Differential tests pin Git for every verify-first
  case and explicit divergence tests enforce ADR-0009's atomic add, immutable
  branch ownership, and non-forceable live-operation refusal. Two session branches
  share newly written objects and refs immediately, but modifying/staging one root
  leaves the other root and index unchanged. A 1,000-statement and sub-100-MiB
  witness covers the maximum accepted lifecycle operation; the first input beyond
  each bound fails closed rather than truncating.
- **Touch points.** New `src/core/ops/worktrees.ts`, `src/core/context.ts`,
  `src/core/repository.ts`, `src/sqlite/store.ts`, `src/git/client.ts`,
  `src/git/index.ts`, `src/index.ts`, new `tests/worktrees.test.ts`,
  `tests/git-upstream-parity.test.ts`.

### WU5 — Isolate restart state and HEAD history per checkout (effort L)

- **Problem.** The current one-row operation journal and one `HEAD` reflog become
  ambiguous as soon as two roots share refs. A suspended rebase in one checkout
  must not block ordinary work in another, but a shared-ref publication must
  still log the causal HEAD of the checkout that owns that branch.
- **Verify first.** Pin Git's per-worktree HEAD log and operation behaviour, then
  trace every ref-publication seam in commit, checkout, reset, merge, replay,
  rebase, fetch, pull, and push. Verify whether removal of a detached checkout
  with unique commits is allowed before choosing retention behaviour.
- **Scope.** Key operation journals, steps, touched rows, and HEAD reflog entries
  by checkout. Keep direct-ref history store-scoped. When a shared branch moves,
  append its direct-ref entry and the causal checkout HEAD entry in the same
  `transactionSync()` publication; branch exclusivity makes that checkout
  unambiguous. Aggregate retained reflog roots across direct refs and every live
  checkout without materialising an unbounded cursor. A bounded scalar row count
  above the existing root-scan limit fails with `E2BIG` before allocation or
  yield. Scope zero-based newest-first `HEAD@{n}` and operation recovery to the
  selected checkout. Refuse removal while its journal is live.
- **Acceptance / witness.** Checkout A can suspend a conflict while checkout B
  remains clean and usable. Reopening the database through B first and A second
  preserves both states. Continue/abort in A cannot read or mutate B's index,
  worktree, HEAD log, or operation rows. Shared refs remain visible to both.
  Reflog root enumeration witnesses the exact accepted row-count boundary and its
  first rejection without partial output. At or below the limit, one lazy bounded
  `iterate()` traversal includes every retained checkout endpoint exactly once.
- **Touch points.** `src/sqlite/store.ts`, `src/sqlite/reflog-schema.ts`,
  `src/sqlite/operation-schema.ts`, `src/core/ops/operation-state.ts`,
  integration/replay/rebase lifecycle modules, `tests/reflog-api.test.ts`,
  `tests/reflog-operations.test.ts`, `tests/rebase-restart.test.ts`,
  `tests/worktrees.test.ts`.

### WU6 — Expose the two bounded Roj reads (effort M)

- **Problem.** Roj's status poll needs divergence against a caller-selected base
  and the raw target of `refs/remotes/origin/HEAD`. Reconstructing divergence
  from `log()` materialises history, while `revParse()` deliberately resolves a
  symbolic ref instead of reporting its target.
- **Verify first.** Re-run the consumer call inventory recorded by backlog 47 and
  48. Pin real Git for `rev-list --left-right --count`, `symbolic-ref -q`, and
  `for-each-ref --format=%(symref)` across detached, shallow, unrelated,
  dangling, direct, missing, and chained-symbolic cases.
- **Scope.** Add a public divergence read over the existing bounded graph engine,
  taking two revision expressions and returning counts plus an explicit
  relationship for shallow or unrelated histories. Add a raw ref read returning
  a discriminated `symbolic`, `direct`, or `absent` result without following the
  target. Reuse existing revision/ref validation and stable bounds; never fall
  back to eager `log()` or a second unbounded graph.
- **Acceptance / witness.** Real-Git parity passes for the verify-first matrix. A
  deep-history witness pins statement and retained-memory ceilings. A caller can
  compute commits ahead of `main` from detached or symbolic HEAD and recover the
  remote default branch after a cold reopen without persisting separate metadata.
- **Touch points.** `src/core/ops/merge-base.ts`,
  `src/core/ops/plumbing.ts`, `src/core/repository.ts`, `src/git/client.ts`,
  `src/git/index.ts`, `src/index.ts`, `tests/refs.test.ts`, new focused graph
  tests, `tests/public-exports.test.ts`.

### WU7 — Prove the consumer admission journey and close documentation (effort L)

- **Problem.** Unit parity cannot prove that shared refs, isolated checkout
  state, consumer reads, publication, cold reopen, and teardown compose into one
  usable session lifecycle.
- **Verify first.** Write the journey as pending steps before implementation:
  initialize/clone, create two session checkouts, poll both, edit and commit one,
  rebase it onto the shared main branch, suspend and reopen a conflict, publish
  by fast-forward, remove one checkout, and prune an absent root. Mark which
  storage-native observations have no Git-binary equivalent.
- **Scope.** Extend the differential journey harness only as far as multi-root
  execution requires. Run the lifecycle against real Git and kompjutr. Add
  corruption, statement-count, memory, and maximum-checkout witnesses. Update
  architecture, Git support, README, and public exports. Write the completion header,
  archive it, and delete backlog 40, 47, and 48 only after every witness passes.
- **Acceptance / witness.** The consumer journey passes through a cold database
  reopen and finishes with one shared main ref, the expected retained/removed
  checkout rows, clean surviving worktree state, no active journal, and bounded
  operation counts. `npm run check`, `npm run typecheck`, the CPU-leased full
  suite, `npm run build`, `npm run package:smoke`, and docs lint all pass.
- **Touch points.** `tests/helpers/e2e.ts`, new `tests/e2e/worktree-sessions.test.ts`,
  `tests/worktrees.test.ts`, `README.md`, `docs/reference/architecture.md`,
  `docs/reference/git-support.md`, `docs/INDEX.md`, `docs/sprints/`,
  `docs/archive/`, `docs/backlog/`.

## Out of scope (explicit)

- The actual Roj adapter change is a separate consumer-repository sprint. This
  sprint delivers and proves the kompjutr admission surface only.
- [49 — set-based copy](../backlog/49-set-based-copy.md) is not required by the
  current linked-worktree session model.
- Multi-ref checkpoint pushes, partial clone, wildcard refspec fetch, remote ref
  discovery, scratch indexes, and patch interchange remain in backlog
  [08](../backlog/08-extend-push-refspecs.md),
  [41](../backlog/41-partial-clone.md),
  [42](../backlog/42-remote-ref-discovery-and-refspec-fetch.md),
  [43](../backlog/43-index-and-object-write-plumbing.md), and
  [44](../backlog/44-patch-interchange.md). They belong to the broader checkpoint
  workload, not the current Roj admission gate.
- Safe merged-branch deletion and storage reclamation remain follow-up production
  safety work in [33](../backlog/33-branch-delete-merged-check.md) and
  [04](../backlog/04-repack-and-garbage-collection.md).
- The actual Durable Object release-candidate probe and systematic interleaving
  suite remain [11](../backlog/11-production-do-regression-probe.md) and
  [16](../backlog/16-concurrent-and-restart-conformance.md). This sprint supplies
  the multi-checkout state they must exercise; it does not deploy from localhost.
- No compatibility path is provided for the previous undeployed version-1 schema.
  There will be one current init baseline, no intermediate migrations, and no
  stale generated migration artifacts.
- Git's `.git/worktrees` administrative layout, lock files, and repair after a
  clobbered `.git` pointer are not emulated. The SQLite-native runtime has no such
  pointer. Root relocation must be an explicit bounded checkout-row operation if
  a concrete consumer later requires it; it must not be a fake `repair` no-op.

## Decisions

- The shared identity remains the repository/store id. Checkout-owned tables use
  a separate checkout id; callers never overload one id with both meanings.
- A `Repository` is a checkout-bound view over one shared store. Existing `dir`
  routing continues to select the nearest checkout root.
- Objects, packs, refs, config, shallow state, commit/tree projections, and
  direct-ref history are shared. Root, HEAD, index/tracker/dirty state, operation
  journals, touched rows, and HEAD history are checkout-owned.
- Shared branch ownership is exclusive across checkouts and enforced in the
  storage mutation seam, not by a preflight-only JavaScript scan.
- Existing databases from the previous baseline are disposable because nothing
  has been deployed. WU2 edits schema version 1 directly and adds no migration.
- Lifecycle methods are typed operations; kompjutr still gains no argv parser or
  `.git` compatibility layout.
- The checkout cap is 1,024 and fails closed before creation. WU4 and WU5 pin its
  first-over-limit and retained-state models.
- WU1 graduates the store/checkout identity and reflog ownership into ADR-0009.

## Sequencing

| Phase | Work | Dependency / parallelism |
|---|---|---|
| 1 | WU1 | Lands first; it owns the table and identity contract. |
| 2 | WU2 | Lands the shared seam before any public lifecycle method. |
| 3 | WU3 + WU6 | May run in parallel after WU2; WU3 owns routing/composition, WU6 owns graph/ref reads. Land WU6 before WU4 edits the public interface. |
| 4 | WU4 | Builds lifecycle only on the settled storage and repository view. |
| 5 | WU5 | Audits every publication and restart path after lifecycle exists. |
| 6 | WU7 | Integrates the journey, runs release gates, and performs docs lifecycle cleanup. |

Each work unit lands with its focused witness. WU2 and WU5 require independent
schema/mutation review before the next dependent phase. Do not overlap writers in
`src/sqlite/schema.ts`, `src/sqlite/store.ts`, or `src/git/client.ts`.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0009"). -->

- 2026-08-26 — WU1 froze shared-store and checkout ownership, a fail-closed
  1,024-checkout cap, storage-enforced branch exclusivity, causal checkout `HEAD`
  history, caller-atomic add, destructive checkout removal, and direct replacement
  of the undeployed version-1 baseline. → [ADR-0009](../decisions/0009-split-shared-store-from-checkouts.md)
- 2026-08-26 — Sequencing deviation: WU1 froze the ownership matrix in ADR-0009;
  its executable schema witness moves to WU2 because the checkout tables do not
  exist before the baseline split.
- 2026-08-26 — WU2 split schema v1 directly into shared-store and checkout state,
  added shared/checkout facades with unequal-id witnesses, and made causal ref and
  `HEAD` reflogs atomic with the 9,727/9,728 bound and stable `EBRANCHINUSE`.
  All 189 focused tests, typecheck, and check passed; independent review approved.
  The full suite waits for WU3 to migrate legacy raw-SQL fixtures.
- 2026-08-26 — WU3 bound each `Repository` to one checkout over shared routing,
  removed the temporary compatibility aliases, and proved one-lookup opens and
  cross-view shallow coherence. A blocked real-Git rebase exposed the fixture's
  missing deterministic editors; pinning both editors closed that harness gap.
  All 106 test files passed (1,879 pass, 5 skip); typecheck and check passed.
