# Sprint — Concurrency and restart conformance (2026-08-27)

**Goal.** Define and prove deterministic repository behavior for every real
asynchronous boundary and every durable restart boundary without serializing
independent work.

**Theme.** Only clone, fetch, push, pull, and maintenance yield. This sprint
tests those owners against the shared ref, index, worktree, journal, pack, and
maintenance seams; fixes only races demonstrated by a deterministic witness;
and proves every visible state remains readable and restartable.

## Refs re-verified at HEAD (2026-08-27)

Planning was grounded at `975dcce`. `✔` = confirmed live · `⚠` = drift or
missing contract found during planning.

- ✔ The public client exposes promises for every method, but only clone, fetch,
  push, pull, and maintenance reach an `await` inside core work. Local operations
  run synchronously before their wrapper resolves — `src/git/client.ts:341`,
  `src/core/ops/network.ts:413`, `src/core/ops/network.ts:557`,
  `src/core/ops/push.ts:97`, `src/core/ops/pull.ts:273`,
  `src/core/ops/maintenance.ts:82`.
- ✔ Pack ingest publishes reservation, data, index/delta checkpoints, and the
  final complete state separately. Deterministic yields already exist after
  4 MiB of input, 1,024 indexed objects, and delta pages —
  `src/sqlite/packs.ts:1532`, `src/sqlite/packs.ts:1681`,
  `src/sqlite/packs.ts:1866`, `src/sqlite/packs.ts:2167`.
- ⚠ Ordinary pending-pack ownership is an instance-local `Set`, while the
  object index has one `(repo_id, oid)` owner and inserts collisions with
  `OR IGNORE`. Overlapping ingests of the same OID are unqualified and can leave
  a complete pack dependent on an abandoned pending pack —
  `src/sqlite/packs.ts:391`, `src/sqlite/packs.ts:1168`,
  `src/sqlite/schema.ts:393`, `src/sqlite/pack-ingest-index.ts:309`.
- ⚠ Fetch records one remote advertisement, then unconditionally publishes its
  tracking refs after one or two pack transfers. A slower old fetch can race a
  newer publication; the store currently offers only a single-ref expected-OID
  seam — `src/core/ops/network.ts:430`, `src/core/ops/network.ts:460`,
  `src/core/ops/network.ts:496`, `src/sqlite/store.ts:4255`.
- ⚠ Clone creates and routes the repository before its first network await and
  removes it only from the live call's `catch`. There is no durable provisional
  marker for a cold retry — `src/core/ops/network.ts:557`,
  `src/core/ops/network.ts:563`, `src/core/ops/network.ts:614`,
  `src/sqlite/schema.ts:76`.
- ✔ Pull already snapshots HEAD and upstream configuration and rejects drift
  after fetch while retaining fetched state — `src/core/ops/pull.ts:273`,
  `tests/pull.test.ts:668`, `tests/pull.test.ts:780`.
- ✔ Ref/HEAD/reflog publication, checkout/merge/replay publication, and complete
  operation-journal transitions use synchronous transactions and expected-state
  checks. Rebase has cold witnesses for its initial journal, every replay step,
  conflict suspension, abort/skip, and final CAS — `src/sqlite/store.ts:4131`,
  `src/sqlite/store.ts:5163`, `src/core/ops/checkout.ts:214`,
  `tests/rebase-restart.test.ts:323`.
- ✔ Maintenance root epochs cover refs, index, checkout lifecycle, shallow
  state, and operation journals. They restart stale marking but are not an
  asynchronous-owner lock — `src/sqlite/maintenance/roots.ts:1082`,
  `src/core/ops/maintenance.ts:90`,
  `tests/maintenance-qualification.test.ts:654`.
- ✔ Existing tests already prove pull HEAD/config/journal races, same-instance
  active pack protection, cold abandoned-pack cleanup, maintenance drift from
  index/journal/commit, concurrent pending fetch preservation, and operation
  restart. The new suite must credit those witnesses instead of duplicating
  them — `tests/pack.test.ts:608`, `tests/rebase-restart.test.ts:453`,
  `tests/maintenance-qualification.test.ts:654`.

## Work units

### WU0 — Freeze the seam matrix and deterministic harness (effort M)

- **Problem.** An all-public-method Cartesian matrix would duplicate synchronous
  transactions and still miss the real yield checkpoints.
- **Verify first.** Trace every public method to its first and last `await`, and
  map each synchronous method to the ref, paged-index, worktree, journal,
  checkout-lifecycle, or read-only seam it uses.
- **Scope.** Add a named one-shot promise barrier, buffered discovery/POST
  wrappers, a predicate-driven pack checkpoint barrier, cold-reopen factories,
  and one invariant oracle. Record the finite compatibility matrix in living
  reference: `coexist`, `stale-reject`, `active-reject`, `root-restart`, or
  `busy/fenced`. Keep each helper below 1 MiB retained state.
- **Acceptance / witness.** Harness self-tests prove exact entry/release, failure
  cleanup, response-loss injection, both orders for async×async pairs, and no
  timers or randomized scheduling.
- **Touch points.** New `tests/helpers/interleaving.ts`, focused helper tests,
  new `docs/reference/concurrency.md`, reference indexes.

### WU1 — Qualify overlapping pack owners and duplicate OIDs (effort L)

- **Problem.** The current same-instance test uses disjoint OIDs. It does not
  cover two stores over one Durable Object storage or duplicate object ownership.
- **Verify first.** Pause two ordinary ingests after reservation and after index
  checkpoints; use identical and partially overlapping object sets; finish and
  fail each owner in both orders.
- **Scope.** Require pending packs to remain invisible, every complete pack to
  retain authenticated membership, and cleanup to target only a stale owner.
  If the witness fails, add the narrowest pack-ingest fence or serialization
  contract with a stable error and cold stale-owner recovery. Do not add a
  repository-wide lock.
- **Acceptance / witness.** Same-store and separate-Workspace schedules cannot
  delete an active winner or leave a complete pack whose indexed object belongs
  only to a removed pending pack. Cold retry reclaims every loser once; all
  successful objects remain readable; each call stays below 1,000 statements
  and 64 MiB.
- **Touch points.** `src/sqlite/packs.ts`, pack index/schema only if proven
  necessary, `tests/pack.test.ts`, new concurrency tests.

### WU2 — Make clone provisional, isolated, and cold-retryable (effort L)

- **Problem.** A crash after repository creation leaves a routed half-clone that
  blocks retry, and the live `catch` cannot run after Durable Object eviction.
- **Verify first.** Pause at repository creation, complete-pack publication,
  ref publication, and initial worktree materialization; try a same-root clone,
  a routed public operation, a different-root clone, and a cold retry.
- **Scope.** Add an exact provisional clone lifecycle directly to the
  development schema. Hide provisional roots from ordinary routing. Reject a
  second live same-root owner with a stable busy error. On cold retry, discard
  the exact abandoned provisional repository and restart rather than attempting
  to resume an HTTP exchange. Publish readiness only after refs, index, and the
  native initial worktree are complete. Record this choice in an ADR.
- **Acceptance / witness.** No public operation observes a half-clone; failure or
  cold retry cannot delete another owner's ready repository; a different root
  proceeds; every successful ready checkout has resolving refs and matching
  index/worktree state after reopen.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `src/core/ops/network.ts`, clone tests, new ADR.

### WU3 — Publish fetch results with bounded multi-ref expectations (effort L)

- **Problem.** Two same-remote fetches may complete out of discovery order and
  let the older advertisement regress tracking refs or undo a newer prune.
- **Verify first.** Pause two fetches before pack and ref publication, including
  same ref, prune, tags, different remote namespaces, and response loss after a
  committed publication. Include conflicting same-name tags advertised by two
  remotes.
- **Scope.** Add a bounded atomic expected-state seam for the exact ref set a
  fetch may put or delete. Reject stale same-namespace publication with a stable
  `ESTALEFETCH` error while retaining complete fetched objects. Independent
  remotes, local branches, index changes, and journals must continue to coexist.
- **Acceptance / witness.** Both completion orders preserve the newest tracking
  generation, an old prune cannot delete newer refs, and disjoint remote
  namespaces with nonconflicting global refs commute. Same-name tags from
  different remotes use the same bounded stale/CAS contract. Every visible ref
  resolves after cold reopen, and retry does not duplicate a committed reflog
  publication.
- **Touch points.** `src/sqlite/store.ts`, `src/core/ops/network.ts`, ref mutation
  types, fetch/concurrency/restart tests.

### WU4 — Keep push and pull tracking state coherent (effort L)

- **Problem.** Push captures a local OID before discovery and publishes its
  tracking ref only after a remote side effect; fetch can publish the same
  tracking ref in between. Pull's existing drift matrix lacks an interleaved
  staged-index change.
- **Verify first.** Pause after receive-pack discovery, during pack POST, after
  confirmed remote success, and during pull fetch. Interleave local commit/ref
  move, fetch, another push, operation-journal creation, maintenance, and add.
- **Scope.** Keep push as a snapshot of the captured local OID. Reconcile the
  local tracking ref with expected state after remote success without regressing
  a newer confirmed fetch. Explicit-URL pushes continue without local tracking
  publication. Preserve the existing `EPUSHUNCERTAIN` boundary and pull's
  fetched-state-on-stale behavior.
- **Acceptance / witness.** One of two same-ref pushes wins the remote CAS; the
  loser reports the existing stable rejection; local HEAD/index/journal never
  move as a push side effect; configured-remote tracking ends at the confirmed
  remote tip; pull rejects interleaved staged or dirty state that overlaps the
  incoming change after retaining its fetch. Unrelated staged and dirty changes
  remain negative controls that may coexist.
- **Touch points.** `src/core/ops/push.ts`, `src/core/ops/pull.ts`,
  `tests/push.test.ts`, `tests/pull.test.ts`, and
  `tests/concurrency-network.test.ts`.

### WU5 — Complete journal and paged local restart coverage (effort L)

- **Problem.** Store primitives are authenticated, but public operation pairs
  and partial paged index mutations are not covered systematically outside the
  rebase suite.
- **Verify first.** Build one representative public row for merge, cherry-pick,
  revert, and rebase in both active-operation orders. Inject failure after the
  first durable page of add, soft reset, and index replacement.
- **Scope.** Prove one-active-journal errors, hard-reset clearing, stale branch
  CAS preservation, continue/skip/abort after cold reopen, and convergence of
  paged local mutations. Add a checkout-local generation/journal only if a real
  partial state is otherwise unauthenticated. If a witness requires a production
  seam, stop the parallel wave and serialize its design after WU2.
- **Acceptance / witness.** Every active operation keeps a validated recovery
  path; no second operation overwrites it; every visible index OID resolves;
  successful commit, checkout, reset, and ref publication survive immediate
  cold reopen; failed paged work can be safely rerun.
- **Touch points.** Public client/core lifecycle tests; production store/core
  seams only after the serialization gate. Own
  `tests/concurrency-operations.test.ts` and
  `tests/restart-conformance.test.ts`.

### WU6 — Qualify maintenance with every asynchronous owner (effort L)

- **Problem.** Root drift covers foreground mutations, but two maintenance
  calls and the reverse maintenance→fetch pack schedule lack an admission and
  ownership contract.
- **Verify first.** Pause maintenance at selected, pending, published, and cache
  revalidation boundaries. Interleave another maintenance call, ordinary fetch,
  push, ref/index/journal mutations, and sibling checkout add/remove.
- **Scope.** Preserve the existing root-restart model and exact maintenance pack
  ownership. Define concurrent maintenance as one publisher plus a stable
  busy/fenced result if tests prove admission is needed. Reuse WU1's narrow pack
  seam; do not introduce a global repository lock.
- **Acceptance / witness.** Neither owner deletes the other's pending pack;
  counters and deletion happen once; foreground roots force same-run restart;
  read-only status and cat-file remain available; cold retry settles every
  selected/pending/published owner exactly once.
- **Touch points.** Maintenance coordinator/repack only if proven necessary,
  `tests/maintenance-qualification.test.ts`, and a new
  `tests/concurrency-maintenance.test.ts`.

### WU7 — Compose the public restart and cost qualification (effort L)

- **Problem.** Passing isolated rows does not prove that the finite matrix leaves
  a repository valid after each durable boundary.
- **Verify first.** Enumerate every matrix cell and point to either an existing
  witness or a new test; reject indirect coverage.
- **Scope.** Run the common invariant oracle after every schedule and cold
  reopen: visible refs resolve, all non-gitlink index OIDs resolve, worktree and
  authenticated complete index baseline plus dirty journal agree with the
  worktree, operation journals validate, pending packs are invisible and
  reclaimable, and maintenance state is resumable. If WU5 adds a generation,
  strengthen the oracle to validate it. Update the living concurrency reference
  and public architecture documentation.
- **Acceptance / witness.** Every finite matrix cell has direct evidence; each
  call stays below 1,000 statements and 64 MiB; the full repository gates pass.
- **Touch points.** New concurrency/restart suites, existing affected suites,
  `docs/reference/concurrency.md`, `docs/reference/architecture.md`.

## Out of scope (explicit)

- Cancellation and `AbortSignal` support remain
  [`15`](../backlog/15-abortable-network-operations.md). This sprint tests
  interruption and cold recovery; it does not add cooperative cancellation.
- Force-with-lease remains [`13`](../backlog/13-force-with-lease.md). Local
  concurrency expectations do not widen the public push refspec contract.
- Clone depth/deepening and partial-clone behavior remain
  [`38`](../backlog/38-clone-depth-and-deepening.md) and
  [`41`](../backlog/41-partial-clone.md).
- General workflow scheduling, distributed multi-Durable-Object locking, and a
  repository-wide mutex are excluded. Coordination is scoped to one repository
  in one Durable Object storage and only to the failing seam.
- No deploy, production probe, release, push, or schema backward-compatibility
  migration is part of this sprint.

## Decisions

- The matrix is `(real async boundary × shared durable seam)`, not every public
  method pair. One representative covers synchronous operations that call the
  same transaction seam.
- Use promise barriers and SQL predicates only. Sleeps, random scheduling, and
  timing assertions cannot serve as conformance evidence.
- For async×sync pairs, run async-pause → sync → async-resume plus the ordinary
  sequential control. Run both completion orders only for async×async pairs.
- A cold interrupted clone is discarded and restarted. HTTP exchange state is
  not resumable; a ready repository is never adopted as provisional.
- A stale same-namespace fetch rejects before ref mutation and retains its
  already complete objects. It never rolls a tracking generation backwards.
- Push sends the OID captured at invocation. A later local commit remains ahead;
  remote success does not authorize overwriting a newer local tracking result.
- Root epochs remain maintenance invalidation, not a foreground lock. Add a
  narrow pack fence, checkout journal, or owner admission only after a
  deterministic witness proves it necessary.
- Schema changes edit the development-only v1 baseline directly. No migration
  or compatibility layer is required.

## Sequencing

| Wave | Units | Isolation and contract |
|---|---|---|
| 0 | WU0 | Serial test/reference seam; freezes names, schedules, and invariant oracle. |
| 1 | WU1 | Serial pack architecture gate before network or maintenance owners build on it. |
| 2 | WU2 + WU5 | Parallel: clone owns its production lifecycle and tests; local restart owns only its two named test files. |
| 3 | WU3 | Serial shared ref-publication seam. |
| 4 | WU4 + WU6 | Parallel: push/pull files versus maintenance files. |
| 5 | WU7 | Serialized composed qualification, reference refresh, and full gates. |

Each verified unit receives an independent review and an atomic semantic commit.
Any proposed global lock, unbounded expected-state snapshot, or new unauthenticated
partial state is a stop condition and returns to the sprint decision gate.

## Gates

Focused tests run per WU. The serialized final gate is:

```bash
GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run -n 4 -- npm test
cpu-lease run -n 2 -- npm run typecheck
npm run check
cpu-lease run -n 2 -- npm run build
git diff --check
```

## Run log

- 2026-08-27: Planning reduced the matrix to five yielding operations and six
  shared mutation seams. Existing pull, rebase, and maintenance witnesses count
  directly; the sprint does not duplicate them.
- 2026-08-27: Architecture gates are duplicate-OID pack ownership, stale
  same-namespace fetch publication, and cold provisional clone recovery. No
  repository-wide lock is justified before those witnesses run.
- 2026-08-27: WU0 records the current finite seam matrix in
  `docs/reference/concurrency.md`. Cells without an ownership or expected-state
  guard are named `unfenced`; later units must replace those cells with a proved
  outcome rather than treating them as supported concurrency.
- 2026-08-27: WU0 added named one-shot and predicate barriers, bounded buffered
  transport response/loss injection, fail-fast owner settlement, both-order
  scheduling, cold reopen, and a bounded static readability oracle. The
  transport helper payload ceiling is 960 KiB with 64 KiB reserved headroom;
  the oracle reads payloads in at most 512 KiB windows.
- 2026-08-28: WU1 replaced instance-local ordinary pack ownership with a
  five-minute durable generation lease and monotonic pack IDs. Deterministic
  same-store and separate-store witnesses prove `EBUSY` before expiry,
  `ESTALE` at takeover, no ID reuse, pending invisibility, and cold cleanup.
- 2026-08-28: WU1 added exact per-pack physical membership alongside the
  canonical OID read index. Publication rejects a dependency on another
  pending owner, sequential duplicate OIDs remain valid, and deletion promotes
  a complete fallback before reclaiming the canonical pack.
- 2026-08-28: Independent review found and closed four additional schedules:
  delta fallback deletion now requires a surviving base closure; fallback SQL
  rows and their pack bytes are authenticated before promotion; tree projection
  repair touches only promoted OIDs; and a reentrant progress callback is fenced
  with `ESTALE`. Maintenance also finalizes against an ordinary complete winner
  and discards a fully redundant owned pack in the same transaction.
- 2026-08-28: WU1 directly covers lease renewal, exact-expiry takeover, all
  1,024 overlapping payloads, two-owner batch deletion in both orders, and the
  statement and memory ceilings. Final review also added fail-closed witnesses
  for a missing control row, invalid cleanup state, duplicate-OID row mutation,
  warm-cache pack corruption, loose-only delta bases, and excessive fallback
  fanout. Exact expected membership now authenticates publication, while
  fallback deletion revalidates uncached pack bytes and promoted object hashes
  under explicit SQL and memory budgets.
- 2026-08-28: A second independent review found two additional deletion edges.
  The closure audit now includes non-canonical physical delta children, and
  exact full entries whose compressed bytes exceed the 4 MiB bulk boundary use
  bounded uncached inflate-and-hash authentication. Direct tests cover all
  deletion orders, valid and corrupt loose bases, fallback promotion, and all
  three maintenance finalization paths both before and after loose deletion.
- 2026-08-28: Final cost review closed repeated oversized dependencies across
  pages. Authentication requires unique OIDs, admits at most 48 MiB of output
  and 64 MiB of compressed data, and shares a 180-row uncached-read budget
  across each pass and its recursive delta graph. Maintenance's two validation
  passes therefore leave 639 statements for fixed work. Direct maintenance and
  fallback witnesses reject before the next page read and roll back exactly.
- 2026-08-28: The final affected WU1 gate passed all 242 tests with two Vitest
  workers. Typecheck, build, diff validation, and Biome checks pass apart from
  the existing Biome schema-version notices. The docs linter reports only its
  known false positive for the managed `docs/AGENTS.md` symlink.
- 2026-08-28: WU5 completed the 11 missing directed active-operation cells.
  Merge, cherry-pick, and revert retain their exact journal, refs, index,
  worktree, and reflogs when another operation or stale branch CAS rejects.
  Cold abort and hard reset restore the complete clean pre-operation snapshot.
- 2026-08-28: WU5 also interrupts public add, path reset, and full index
  replacement after the first committed 512-row page of a 513-path mutation.
  Each cold partial state remains readable and retry converges without duplicate
  objects. Immediate post-checkout reopen preserves HEAD, index, worktree,
  status, and reflog. Independent review is clean; all 262 affected tests pass.
- 2026-08-28: WU2 now reserves clone roots through a five-minute exact-owner
  lease. Provisional roots remain traversal barriers but are absent from public
  repository lookup. Same-root overlap gets `EBUSY`, exact-expiry takeover
  fences the old owner with `ESTALE`, and repository, checkout, and owner
  identities are never reused.
- 2026-08-28: Clone worktree, index, tracker, and ready state now publish in one
  store-owned SQLite transaction. The shared-database guard runs before
  reservation or cleanup; native capacity rollback can retry the bounded
  fallback, and fallback rejects exact or structural target collisions while
  preserving unrelated untracked paths. A stale owner after response loss
  cannot discard or republish the ready repository.
- 2026-08-28: Two independent WU2 reviews are clean after direct probes for
  owner forgery, cache rollback, injected checkout cardinality, public
  filesystem isolation, and cold replacement safety. The final affected gate
  passes all 343 tests across 16 files, including the 24,252-path fallback cost
  witness. Typecheck, build, Biome, and diff validation pass. The docs linter
  reports only its known false positive for the managed `docs/AGENTS.md`
  symlink.
