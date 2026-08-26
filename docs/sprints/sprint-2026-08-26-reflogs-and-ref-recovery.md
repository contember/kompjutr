# Sprint — Bounded reflogs and ref recovery (2026-08-26)

**Goal.** Make every Git-visible ref movement recoverable through bounded,
validated history without weakening atomic updates, restart safety, or the
sub-1,000-statement operation model.

**Theme.** Reflogs are the retention boundary between ordinary ref mutation and
destructive repository maintenance. This sprint consumes backlog 12 before
merged-branch deletion or garbage collection can proceed. Success means one
storage seam records every direct-ref and `HEAD` transition in the same
synchronous transaction as the ref change, callers can inspect and recover an
active entry through typed APIs, and future maintenance can stream the exact
unexpired object roots without materialising them.

Consumes backlog item 12. It closes only after the cross-operation mutation
matrix and recovery witnesses pass.

## Refs re-verified at HEAD (2026-08-26, `8cc1dff`)

- ✔ The schema stores only the current raw `HEAD` value on
  `git_repositories` and the current target of each named ref in `git_refs`; no
  historical table exists — `src/sqlite/schema.ts:158`,
  `src/sqlite/schema.ts:166`.
- ⚠ Ref mutation is split across five public store methods. `setRef`,
  `updateRefExpected`, `deleteRef`, `updateRefs`, and `setHead` write the current
  row without a shared history contract — `src/sqlite/store.ts:2549`,
  `src/sqlite/store.ts:2563`, `src/sqlite/store.ts:2587`,
  `src/sqlite/store.ts:2592`, `src/sqlite/store.ts:2644`.
- ✔ Batched fetch already updates or deletes tracking refs in one synchronous
  transaction, and the store witness updates 9,329 refs in at most five SQL
  statements. Reflog capture must stay set-based rather than add one lookup or
  insert per ref — `src/core/ops/network.ts:196`,
  `src/sqlite/store.ts:2599`, `tests/store.test.ts:789`.
- ⚠ Local operations reach the mutation methods through distinct paths:
  branch/tag management and checkout, commit publication, hard reset,
  fast-forward merge, rebase publication, clone/fetch, push tracking, and
  plumbing updates. A fix at only `commit()` or `setRef()` would miss `HEAD`
  transitions, deletions, and bulk updates — `src/core/ops/refs.ts:44`,
  `src/core/ops/commit.ts:162`, `src/core/ops/staging.ts:773`,
  `src/core/ops/merge.ts:601`, `src/core/ops/rebase-lifecycle.ts:725`,
  `src/core/ops/network.ts:196`, `src/core/ops/plumbing.ts:49`.
- ✔ `HEAD` may be symbolic, detached, or unborn. `Repository.head()` resolves
  only the current value, while `revParse()` accepts refs/OIDs and `^`/`~`
  suffixes but has no reflog selector — `src/core/repository.ts:255`,
  `src/core/repository.ts:275`.
- ✔ The native facade already owns the clock, timezone, and optional default
  identity, but several core ref operations currently receive only a
  `Repository`. Metadata must be passed deliberately without making previously
  identity-free operations fail — `src/core/context.ts:60`,
  `src/git/client.ts:244`, `src/git/client.ts:390`.
- ✔ Schema initialization and migration run inside one platform
  `transactionSync()` and count every SQL statement, with version 12 recorded
  only after migration succeeds — `src/sqlite/schema.ts:1031`,
  `src/sqlite/schema.ts:1190`, `src/sqlite/schema.ts:1248`.
- ✔ The public `Git` interface exposes `revParse()` and `updateRef()` but no
  reflog listing or recovery method. The support reference marks both `@{n}` and
  reflog state unsupported — `src/git/client.ts:186`,
  `src/git/client.ts:220`, `docs/reference/git-support.md:214`,
  `docs/reference/git-support.md:431`.
- ⚠ A live Git control at this HEAD confirms that branch movement writes both
  the branch and `HEAD` logs, checkout writes only `HEAD`, and deleting a branch
  removes Git's per-branch log. This sprint intentionally retains a bounded
  deletion entry because recovery after deletion is its primary safety goal.

## Work units

### WU1 — Add the schema-v13 reflog contract and atomic mutation seam (effort L)

- **Problem.** Current ref writes preserve only the latest value, use several
  independent methods, and have no place to assign stable order, validate log
  fields, or expire retention roots. Adding an insert beside each call site
  would miss bulk changes and could expose a ref without its recovery record —
  `src/sqlite/schema.ts:158`, `src/sqlite/store.ts:2549`.
- **Verify first.** Enumerate every production caller of the five ref mutation
  methods and freeze a table of old raw target, old resolved OID, requested raw
  target, new resolved OID, and whether `HEAD` points at the changed ref. Ask
  real Git for create, same-OID update, symbolic checkout, detach, deletion, and
  bulk tracking-ref behavior before fixing the row semantics.
- **Scope.** Add schema-v13 reflog state and entry tables with a repository-wide
  monotonic ordinal and a `(repo_id, ref_name, ordinal)` read index. Store
  nullable old/new raw targets and resolved OIDs, bounded ref/reason and optional
  actor fields, and integer timestamp/timezone fields. Raw targets distinguish
  absence, direct OIDs, dangling/cyclic symbolic refs, and same-OID retargets;
  resolved OIDs remain nullable for absent, unborn, or dangling endpoints.
  Validate affinities, lengths, OIDs, ordinals, and cross-field shapes both in
  DDL and on every read. Replace the
  five independent write paths with one nested-transaction-safe store seam that
  captures the prior row, applies direct puts/deletes or a raw `HEAD` change,
  appends all required log rows, advances ordinals, and enforces retention
  atomically. Keep the five existing public method signatures as compatibility
  wrappers. Preserve bulk final-state semantics: deletes apply before puts and
  the last duplicate put wins, but history records one pre-state to final-state
  event per changed ref. Keep bulk changes bounded, JSON-paged, and set-based.
  Migrate v12 by creating empty history; never invent entries for movements that
  predate v13.
- **Acceptance / witness.** Fresh and genuine v12 databases reach v13 with
  identical current refs and empty history. A failed mutation or migration
  leaves both ref and log unchanged. Creation, deletion, detached/symbolic HEAD,
  same-OID checkout, stale expected-old update, and mixed bulk put/delete have
  exact row witnesses. Corrupt affinity, OID, ordinal, identity, reason, and
  cross-field rows fail closed with `ECORRUPT`. A 9,329-ref mutation has a flat,
  explicit statement ceiling and no scalar query per ref; schema initialization
  remains below 1,000 statements.
- **Touch points.** `src/sqlite/schema.ts`, a focused
  `src/sqlite/schema-migration-v13.ts`, `src/sqlite/store.ts`, frozen v12 test
  schema/fixtures, `tests/schema-migration.test.ts`, `tests/store.test.ts`.

### WU2 — Record every operation-owned ref and HEAD transition (effort L)

- **Problem.** The store can make a write atomic, but only the owning operation
  knows whether a transition is a commit, amend, checkout, reset, merge, rebase,
  fetch, push, or explicit recovery. Current call sites neither supply a bounded
  reason nor use one common actor policy — `src/core/ops/refs.ts:44`,
  `src/core/ops/commit.ts:76`, `src/core/ops/network.ts:149`.
- **Verify first.** Build a mutation inventory from `src/core/ops/` and run the
  equivalent operations in real Git. Record which logical operation writes
  `HEAD`, the direct ref, both, or neither. Include failed/stale paths,
  unpublished replay commits, path-only checkout/reset, fetch prune, clone, and
  a pull whose fetch succeeds but integration fails.
- **Scope.** Give every core mutation one typed reflog metadata value. Reuse the
  resolved committer identity when the operation already requires one; otherwise
  use configured/default identity when available and record explicit absence
  rather than inventing an actor or introducing a new refusal. Generate reasons
  from bounded internal labels, not unbounded user text. A checked-out direct-ref
  movement records both that ref and `HEAD`; checkout/detach records `HEAD` even
  when old and new OIDs match but the raw symbolic target changes. Direct-ref
  creation and deletion remain recoverable. No-op writes, path-only operations,
  unpublished commits, failed preflights, stale compare-and-swap updates, and
  rolled-back operations write no entry. Preserve fetch/pull's existing
  two-phase visibility: fetched tracking history may survive a later local
  integration refusal, while local branch history follows merge atomicity.
- **Acceptance / witness.** Differential tests cover initial commit, ordinary
  commit, amend, branch creation, symbolic and detached checkout, hard reset,
  fast-forward and commit merge, conflicted continue/abort, cherry-pick/revert
  continue, fast-forward and replay rebase, fetch/prune, clone, pull, push
  tracking updates, tag/update-ref creation and forced movement, and deletion.
  Each asserts the exact affected log names, endpoints, actor/time, and reason;
  every refusal asserts zero extra entries. Cold reopen preserves order and
  pending operation journals remain authoritative independently of reflog rows.
- **Touch points.** `src/core/context.ts`, `src/core/ops/commit.ts`,
  `src/core/ops/refs.ts`, `src/core/ops/staging.ts`, merge/replay/rebase lifecycle
  modules, `src/core/ops/network.ts`, `src/core/ops/push.ts`,
  `src/core/ops/plumbing.ts`, `src/git/client.ts`, operation and parity tests.

### WU3 — Expose bounded listing, selectors, recovery, and retention roots (effort L)

- **Problem.** Even durable history is not a recovery feature until callers can
  page it, select a prior OID, restore a direct ref without racing another
  writer, and hand active OIDs to future garbage collection. The current
  revision parser has no `@{n}` path and public methods return no reflog rows —
  `src/core/repository.ts:279`, `src/git/client.ts:186`.
- **Verify first.** Pin Git's zero-based `HEAD@{n}` behavior, missing/expired
  selection errors, and ordering for multiple events in one second. Exercise a
  deleted ref whose newest event has a null new endpoint. Confirm an ordinal
  cursor remains stable while a newer entry is appended.
- **Scope.** Add native `reflog()` listing, newest first, with a default page of
  100, a maximum page of 1,000, and ordinal cursor pagination. Return typed,
  fully validated entries. Extend revision parsing only with decimal
  `HEAD@{n}` for active entries; dates, `@{upstream}`, arbitrary-ref selectors,
  and formatted output remain unsupported. Add `recoverRef()` for direct
  `refs/*` destinations: it selects an active source entry and explicit old/new
  endpoint, requires the caller's expected current target (including null),
  verifies that the selected non-null object still exists, and performs a
  logged compare-and-swap update. Add a lazy `db.iterate()`-backed internal
  stream of distinct active old/new OIDs for future maintenance.
- **Acceptance / witness.** Listing returns stable, complete pages at 0, 1, 100,
  1,000, and one-over-limit inputs. `HEAD@{0}` through the retained boundary
  resolves identically to the corresponding listed non-null new OID and composes
  with the existing bounded `^`/`~` suffixes; a null selected endpoint fails
  deterministically. Recovery recreates a deleted branch,
  can select either endpoint, records its own entry, and rejects an expired,
  null, missing-object, corrupt, or stale candidate without mutation. The root
  stream excludes expired entries, deduplicates OIDs in SQL, uses one lazy
  traversal, and never calls `db.all()`.
- **Touch points.** `src/sqlite/store.ts`, `src/core/repository.ts`, a focused
  reflog/recovery op module, `src/git/client.ts`, `src/git/index.ts`,
  `src/index.ts`, public-export tests, reflog/recovery tests.

### WU4 — Prove retention, cost, and the recovery contract end to end (effort M)

- **Problem.** Reflogs touch every mutation path and become object-retention
  authority. A locally correct table or API is insufficient if one operation
  bypasses it, expiry protects the wrong OID, corruption is skipped, or a bulk
  fetch turns into thousands of SQL statements.
- **Verify first.** Run the complete mutation inventory against the final store
  seam and search production code again for direct writes to `git_refs` or
  `git_repositories.head`. Capture statement counts for 1, 1,000, and 9,329
  tracking-ref updates before accepting a ceiling.
- **Scope.** Enforce a fixed initial retention policy: an entry is active only
  while it is both at most 90 days old and among the newest 1,024 entries for
  its ref. Apply count pruning to every touched ref and time pruning
  transactionally; listing, selectors, recovery, and root traversal must apply
  the active predicate even before physical cleanup. Preserve deletion entries
  within that window. Add differential, corruption, rollback, restart, exact
  boundary, and statement-budget suites. Document the supported native surface,
  the deliberate deleted-ref difference from Git, the fixed retention policy,
  and the future GC root contract. Graduate the retention/deletion policy to an
  ADR before closing because it constrains later repack and garbage collection.
- **Acceptance / witness.** The parity matrix proves every successful movement
  produces exactly the intended rows and every failed movement produces none.
  Entry 1,024 remains active and 1,025 expires; the exact 90-day boundary is
  active and one second older expires. Backward/equal timestamps cannot reorder
  ordinal pagination. Bulk statement counts are flat by page rather than ref
  count and every operation stays below 1,000 statements. `npm run check`, a
  leased `npm run typecheck`, leased full suite, leased build, package smoke,
  and docs lint all pass with exact counts recorded at close.
- **Touch points.** Focused reflog parity and cost tests, all ref-mutating
  operation suites, `docs/reference/architecture.md`,
  `docs/reference/git-support.md`, `docs/decisions/`, public README only if its
  capability summary changes.

## Out of scope (explicit)

- Merged-branch reachability enforcement and force-delete behavior remain
  backlog [33](../backlog/33-branch-delete-merged-check.md). It becomes
  schedulable only after this sprint closes.
- Repack, garbage collection, object deletion, and reflog-aware pruning remain
  backlog [04](../backlog/04-repack-and-garbage-collection.md). This sprint
  supplies the active-root stream but does not consume it destructively.
- Full repository audit, repair, or snapshots remain backlog
  [17](../backlog/17-integrity-audit-and-snapshots.md).
- Date-based selectors, arbitrary `<ref>@{n}`, `@{upstream}`, human reflog
  formatting, configurable expiry, reachability-dependent 30/90-day Git expiry,
  and a reflog CLI. The first contract is typed, fixed-policy, and bounded.
- Reconstructing symbolic `HEAD` from OID history. Recovery restores a direct
  ref; callers use checkout to attach or detach `HEAD` explicitly.
- Changes to the Computer compatibility facade, stash, branch-management
  expansion, force-with-lease, or pull-rebase.
- Production Durable Object deployment, release publication, or performance
  claims. Existing CI/release and production-probe work remain independent.

## Decisions

- Use one schema-v13 additive migration. A repository-wide monotonic ordinal
  gives stable ordering and pagination even when timestamps collide or move
  backward; a per-ref index serves bounded listing and retention.
- The store owns old/new capture, log insertion, ordinal allocation, pruning,
  and ref mutation in one synchronous transaction. Core operations own the
  bounded reason and best available actor metadata.
- Log bounded raw targets and resolved OID endpoints. Raw null means a named row
  is absent; OID null may also mean an unborn or dangling symbolic endpoint. A
  raw target change is still an event when both resolved OIDs match or are null.
  Keep deleted-ref history for the active window instead of copying Git's
  deletion of the per-ref log.
- Actor identity is optional. Existing commit-like operations reuse their
  resolved committer; other operations use configured/default identity when
  present. Reflog support must not make checkout, branch, fetch, or plumbing fail
  only because no identity is configured.
- Initial retention is fixed at 90 days and 1,024 entries per ref. An entry must
  satisfy both limits. This gives future GC one deterministic root predicate;
  reachability-sensitive or configurable policy waits for real maintenance
  evidence.
- Public reads are ordinal-paged and bounded. `HEAD@{n}` is the only revision
  shorthand added. Explicit recovery names the source row and endpoint and uses
  expected-current compare-and-swap; it does not guess which prior state the
  caller intended.
- No ADR is created at sprint opening. WU4 graduates the shipped retention and
  deletion semantics after implementation evidence confirms them.

**Planning alternative rejected.** Instrumenting each core operation directly
without a store-level mutation seam would make reasons easy to add, but it could
not guarantee that public `RepoStore` mutations, bulk fetch/prune, or future
callers update history atomically. Logging only in the store without operation
metadata would preserve OIDs but lose the reason and actor that make recovery
auditable. The split ownership above keeps both guarantees.

**Revisit the scope if** the 9,329-ref witness cannot retain its set-based cost
with one entry per changed direct ref, or if same-OID symbolic checkout cannot be
represented without storing a bounded raw `HEAD` transition. Stop for an owner
decision rather than dropping entries, truncating a bulk update, or weakening
the existing ref transaction.

## Sequencing

| Wave | Unit | Depends on | Parallelism | Done-check |
|---|---|---|---|---|
| 0 | WU1 schema and mutation seam | Sprint plan | One owner; shared store/schema seam | migration, atomicity, bulk cost |
| 1 | WU2 operation metadata | WU1 API frozen | Can split by disjoint op modules; shared store stays single-owner | complete mutation matrix |
| 1 | WU3 read/recovery API | WU1 row/read contract | Can proceed beside WU2 outside shared exports | paging, selector, CAS recovery, roots |
| 2 | WU4 retention and integration gates | WU2–WU3 | Serialized final audit and leased gates | exact boundaries, all gates, docs/ADR |

WU2 and WU3 may proceed after WU1 freezes the row and store contracts. Public
exports land once both type surfaces agree. Close only after a final search finds
no production ref write outside the audited seam, backlog 12 is deleted,
references are current, the shipped policy has an ADR, and exact verification
counts are recorded in the archived outcome.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-26 — Sprint opened from backlog 12 after re-verifying schema v12, all
  current ref-mutation seams, the 9,329-ref bulk witness, public API gaps, and
  live Git behavior for commit, amend, checkout, reset, branch creation, and
  branch deletion.
- 2026-08-26 — Independent WU1 step reviews found that nullable OIDs alone cannot
  represent supported dangling/cyclic symbolic refs or unborn `HEAD`. The frozen
  row contract now stores bounded raw and resolved endpoints for every entry,
  keeps existing `RepoStore` signatures as wrappers, and preserves bulk final-
  state semantics while logging one pre-to-final event per ref.
- 2026-08-26 — WU1 landed in `2a95c4e`. Schema v13 now owns reflog state and
  entries through lifecycle foreign keys; one atomic store seam validates and
  logs raw/resolved transitions, nullable-expected CAS, causal `HEAD`, pruning,
  and byte-ordered bulk updates under a shared 64 MiB retained-memory budget.
  Independent review closed endpoint, rollback, and bound-before-allocation
  findings. Focused verification passed 90/90 tests, leased typecheck, and the
  full Biome check; the 9,329-ref witness stayed below 24 SQL statements.
- 2026-08-26 — WU2 caller review found two scope decisions before implementation:
  complete metadata plumbing needs mechanical internal changes in the Computer
  compatibility client despite the explicit facade exclusion, and atomic
  branch-create-plus-checkout needs one outer transaction to avoid publishing a
  branch/reflog entry when checkout later refuses.
- 2026-08-26 — Owner approved both WU2 exceptions. The compatibility change is
  limited to internal context plumbing with no public facade change; branch
  creation plus checkout becomes one atomic operation.
- 2026-08-26 — WU2a landed in `a991971`. A closed reason union and typed actor/
  time constructors now drive commit, branch, tag, checkout, hard reset, and
  plumbing publication; the native and compatibility clients only plumb
  context. Full checkout and branch-create-plus-checkout are atomic, detached
  reset moves raw `HEAD`, setup imports leave empty history, and unpublished
  rebase commits keep their materialization-only cost model. Independent review
  closed ordinary/sparse rollback, detached-reset, and statement-model findings.
  The root verification passed 162/162 focused tests, leased typecheck, and the
  full Biome check; the large sparse checkout witness uses exactly 59 statements.
- 2026-08-26 — WU3 review froze exclusive ordinal paging, an atomic CAS recovery
  reasoned `recover-ref`, a lazy validated active-root stream, and decimal
  `HEAD@{n}`. Because the existing suffix parser was unbounded, WU3 also caps a
  revision expression at 1,024 code units and 32 total traversal operations;
  overflow fails with `E2BIG`.
