> **OUTCOME - shipped 2026-09-03.** Durable operation plans are immutable and
> transition in constant journal work under one SQLite-owned local mutation;
> filesystem, config, index, sparse, loose-object, and maintenance-root reads now
> rely on explicit write premises and plain trusted projections. Commit map:
> plan -> `31c3803`; WU1 -> `8904d4f`, `8bfb87d`; WU2 -> `ddaf047`; WU3 ->
> `0787053`; WU4 -> `3662b92`; WU5 -> `efcdd1f`; WU6 -> `9c4a70a`; WU7 ->
> `730a921`; integration and closure -> `eda7a5d`, `dca55c6`, `a7187c1`,
> `9fa664a`, `b4e82a3`, `34337fa`, `793fc84`, `d50532c`, `6028bf1`, `48752ba`.
> Verification: every focused witness and independent review passed; N-step
> replay used 534 SQL statements / 593 rows versus 950 / 1,081 at 2N; both
> targeted memory scenarios passed; smoke passed 168/168 in 14.92 seconds;
> typecheck, Biome check, build, and package smoke passed; the 3,399-case test
> inventory passed through the complete 8-root-shard, protocol, 5-pack-shard,
> filesystem, shell, and end-to-end exhaustive matrix in 791.22 seconds. Backlog
> closed: ARCH-5/CORR-6, ARCH-6, ARCH-11, ARCH-15, ARCH-28, CORR-13, ARCH-32,
> and ARCH-35 were removed from backlog 65. Deferred: remaining architecture and
> structural-bound findings stay in backlog 65; packed traversal stays in
> backlog 63; optional integrity audit and snapshots stay in backlog 17.

# Sprint - Trusted reads and linear journal (2026-09-02)

**Goal.** Complete the remaining coherent ADR-0018 tranche and make durable
operation transitions linear before the separate ADR-0017 structural-bounds
sprint.

**Theme.** Ordinary journal, index, sparse, loose-object, and maintenance-root
reads still re-prove invariants that supported writes and schema constraints must
own. These paths move to plain projections and shared decoders together because
the journal and sparse seams first need an explicit write-time premise. The
sprint also removes the journal's whole-state replacement loop, which is the
largest correctness-relevant cost consequence of the remaining distrust. Local
same-database state machines serialize through synchronous SQLite transactions;
detached hashes, revisions, leases, and in-memory mutexes do not duplicate that
owner. Existing CAS, epochs, and leases remain where state crosses an async or
multi-transaction boundary.

## Refs re-verified at HEAD (2026-09-02)

Grounding is `f8921a9`; `✔` = confirmed live, `⚠` = drift or planning nuance.

- ✔ Every journal read projects SQL `typeof`/canonical BLOB witnesses, rebuilds
  all steps and touched rows, recomputes integrity, and revalidates referenced
  objects - `src/git/store/operation-journal.ts:540-750`.
- ✔ A rebase transition rereads that complete journal, deletes all child rows,
  and reinserts the complete next journal -
  `src/git/store/operation-journal.ts:1171-1215`.
- ✔ Local Git mutation is synchronous, `transactionSync()` rejects thenables,
  and another request cannot interleave inside the transaction -
  `src/db/db.ts:64-75`, `src/db/db.ts:190-195`,
  `docs/reference/concurrency.md:3-11`.
- ⚠ Nested `transactionSync()` uses the outer SQLite transaction rather than
  blocking the same stack. Public worktree and index-tracker callbacks are
  structurally injectable, so a transaction-local database guard must reject
  synchronous mutation reentry without becoming durable ownership -
  `src/git/client.ts:389-405`, `src/git/ops/rebase-lifecycle.ts:585-613`.
- ✔ The filesystem tables do not constrain every type, range, and relationship
  consumed by sparse Git projections - `src/fs/schema.ts:23-67`.
- ✔ Index tracker reads retain SQL type witnesses and ordinary persisted index
  scans decode rows twice and recheck SQL ordering -
  `src/git/store/index-tracker.ts:448-478`,
  `src/git/store/index-table.ts:209-243`.
- ✔ Sparse reads retain SQL witnesses, metadata preflights, and hand-modeled
  retained-byte accounting - `src/git/store/sparse/shared.ts:10-53`,
  `src/git/store/sparse/shared.ts:92-112`, `src/git/store/sparse/workspace.ts`.
- ✔ Loose object reads aggregate all chunk metadata before issuing a second
  payload query - `src/git/store/objects.ts:1196-1275`.
- ✔ Six maintenance root sources preflight page metadata and then reread the
  same rows with type and byte witnesses -
  `src/git/store/maintenance/roots.ts:321-1016`.
- ⚠ ARCH-17 is much broader than the sparse seam: modeled currencies remain in
  integration, tree walk, checkout, status, diff, rename, initial checkout, and
  rebase planning. Closing all of it here would exceed the repository's long
  sprint envelope and mix independent algorithm redesigns.

## Work units

### WU1 - Linear trusted operation journal (effort L)

- **Problem.** Every read authenticates complete topology and objects, and every
  rebase transition replaces all rows, making an N-step replay quadratic.
- **Verify first.** Inventory every supported Git-domain synchronous mutation
  boundary exposed by `Git`, `GitCliRunner`, or re-exported from `.` or `./git`.
  This includes exported Git-domain free mutators and mutating methods on exported
  Git repository/store facades. It excludes `Database`/`SqlDatabase`,
  `Filesystem`/`NodeFsCompat`, Workspace filesystem and process methods, and raw
  SQL. Injected worktree, tracker, and source implementations perform the outer
  operation's owned writes without reacquiring the guard; any supported Git API
  reentry from them must acquire it. Freeze the exact classified boundary list in
  `tests/public-exports.test.ts` before implementing wrappers; a newly discovered
  boundary category escalates scope instead of silently widening WU1. Add
  deterministic N-step and 2N-step statement rows.
  Reproduce same-stack reentry from an injected `Worktree` or
  `IndexTrackerWriter`, from `withScratchIndex`, through a second Git client over
  the same database, through a CLI write, and through one exported low-level
  mutator. Keep stale branch, cold restart, and transaction rollback tests as
  controls. Existing full-hash corruption tests are not correctness controls
  under ADR-0018.
- **Scope.** Remove `integrity_oid` and the detached whole-journal replacement
  API. Treat the validated replay plan as immutable after creation. Persist only
  mutable phase, cursor, current parent, replayed/skipped counters, current-step
  outcome/result, and the current conflict snapshot. Every local transition owns
  one outer `transactionSync()` containing its authoritative read, worktree/index
  mutation, conditional SQL state transition, and root-epoch bump. Encode legal
  transitions with expected phase, cursor, and pending outcome predicates plus
  `RETURNING`; zero changed rows is `EOPMISMATCH`. Use one uncommitted SQLite
  guard row in `git_meta` per database. Every boundary in the frozen Git-domain
  inventory acquires it before its first store or worktree mutation.
  Only the successful outer acquirer deletes the row before commit; a failed
  nested acquisition never deletes the owner's row. Internal composition uses
  non-public owned seams and does not reacquire the guard. Methods that cross
  `await` hold no guard across that boundary; their later local mutation phase
  reacquires it and repeats its authoritative checks. Raw SQL mutation remains
  out-of-band under ADR-0018. Validate complete topology and referenced objects
  only at creation or when introducing a new result. Conflict suspension writes
  only touched rows; continue/skip updates one step and clears them; publication
  and abort clear under the same transaction; hard reset remains the explicit
  unconditional semantic clear. Expose a bounded operation-root page. Do not add
  a revision, rolling hash, per-row version, lease, or in-memory mutex.
- **Acceptance / witness.** N versus 2N replay has linear statement and returned-
  row growth; each replay step changes O(1) journal rows plus its bounded conflict
  snapshot. Reentry through the same client, a second client, CLI, scratch
  callback, and an exported low-level mutation rejects before any state change.
  Catching one nested rejection does not release the outer guard: a second nested
  attempt still rejects. Legitimate internal composition and scratch-index
  methods remain usable; success, rollback, and cold reopen leave no guard row.
  Injected failures after every sub-write roll back journal, index, worktree,
  objects, and root epoch; cold reopen, conflict continue, skip, abort, completed
  publication, hard reset, and stale branch publication remain correct; ordinary
  journal SQL has no ADR-0018 witnesses. Run `npx vitest run
  tests/operation-state.test.ts tests/rebase-restart.test.ts
  tests/concurrency-operations.test.ts tests/public-exports.test.ts` and
  `npm run bench:statements -- --check` with new `rebase.transition-n` and
  `rebase.transition-2n` rows.
- **Touch points.** `src/git/store/{operation-schema,operation-journal,operations,checkout,index}.ts`,
  `src/git/ops/{merge,merge-apply,replay-lifecycle,rebase-lifecycle}.ts`,
  `src/git/client.ts`, `src/git/cli/{index,write}.ts`, supported public mutation
  wrappers and owned seams under `src/git/{ops,store}/`, the named tests, and
  `bench/statements.ts`. Operation DDL lives only in `operation-schema.ts`; this
  WU does not edit `src/git/store/schema.ts`. Guard acquisition code lands and is
  frozen before later Git WUs touch their implementation files.

### WU2 - Establish the filesystem write premise (effort M)

- **Problem.** Sparse Git reads cannot trust `fs_*` values until the filesystem
  schema protects the exact stored envelope they consume.
- **Verify first.** Enumerate every `fs_paths` and `fs_nodes` field read by the
  sparse workspace and compare it with all supported filesystem writers.
- **Scope.** Build a field/writer matrix, then add only type, range,
  nullable-payload, and path relationship constraints every supported writer
  preserves. Add exact filesystem `sqlite_schema` validation at open so an older
  unconstrained version-1 shape is rejected; keep schema version 1 and provide no
  migration. Do not add an immediate path-to-node foreign key that breaks the
  current recursive-delete order. Preserve the root's exceptional parent,
  hardlinks, subtree rename, import, stream and initial writes, and symlinks whose
  public writer supplies a content identity. Handle revalidation remains a stale-
  handle boundary, not ordinary row authentication.
- **Acceptance / witness.** Supported filesystem writers and conformance remain
  green; the former version-1 DDL is rejected at open; malformed values are
  rejected at the DDL write boundary; root, hardlink removal, subtree rename,
  recursive removal, imports, stream/initial writes, and symlink content IDs have
  direct witnesses. Run `npx vitest run tests/schema.test.ts
  tests/fs/store-ops.test.ts tests/fs/remove.test.ts tests/fs/write.test.ts
  tests/fs/import.test.ts tests/fs/initial-write.test.ts` and `npm run test:fs`.
- **Touch points.** `src/fs/schema.ts`, filesystem schema-open code,
  `tests/schema.test.ts`, and the named files under `tests/fs/` only.

### WU3 - Complete index and config trust boundaries (effort L)

- **Problem.** Config mutation can expose raw SQLite constraint errors, scratch
  indexes lack the checkout index's write envelope, tracker reads retain SQL
  witnesses, and persisted index scans decode and reorder-check twice.
- **Verify first.** Drive invalid config paths and malformed scratch entries
  through supported writers; instrument persisted and arbitrary index scans to
  distinguish their decoder and ordering paths.
- **Scope.** Add one shared config-path boundary validator; give scratch rows the
  checkout index field constraints and pre-buffer validation; convert index
  tracker reads to plain projections and shared decoders; decode persisted index
  rows once while retaining ordering validation for arbitrary iterables. Reuse
  shared path/ref validators when touched without widening error taxonomies.
- **Acceptance / witness.** Invalid config and scratch input fails atomically with
  stable Git errors before SQL; valid scratch workflows are unchanged; persisted
  scans decode once; an unsorted generic iterable still fails; tracker restart,
  dirty paging, and root epoch behavior remain correct. The scratch-index witness
  stays in this WU's exclusive `tests/store.test.ts`. Run `npx vitest run
  tests/index-tracker.test.ts tests/store.test.ts`.
- **Touch points.** `src/git/store/{schema,config,index-table,index-tracker,ref-validation}.ts`,
  matching config/index tests. `tests/store.test.ts` belongs exclusively to this
  WU; loose-object witnesses use a dedicated file in WU5.

### WU4 - Trust same-database sparse projections (effort L)

- **Problem.** Sparse store reads re-authenticate persisted Git and filesystem
  rows, and ops then treats same-database projections as hostile input and
  applies another modeled-byte ledger.
- **Verify first.** Capture ordinary sparse SQL and map each check to caller
  input, write premise, row-shape refinement, or algorithmic guard.
- **Scope.** After WU2, first freeze an internal non-forgeable receipt tied to the
  exact `Database` instance; a structurally identical, spread, wrapped, custom,
  or different-database source remains generic. Then convert every native source
  and consumer to plain projections and shared row decoders. Remove mutable
  reserve/release/peak accounting and ops-side duplicate authentication. Bound
  each native fast-path result collection to one fixed 1,000-row materialized
  page, including a global 1,000-entry snapshot-tree result; overflow returns
  `available: false` before retaining the excess row and uses the existing
  generic streaming fallback rather than rejecting the caller. Keep request,
  cycle, depth, ordering, SQL binding, page, batch, and caller-output guards that
  name a real failure. Do not perform the repository-wide ARCH-17 sweep.
- **Acceptance / witness.** Native sparse selection, snapshot, staging, and tree
  build preserve exact results; supported malformed writes fail at their
  boundary; structural copies and sources from another database cannot claim
  same-store trust; every 1,001st materialized native result takes the generic
  fallback without truncation; a worst-case-path memory scenario remains below
  the process target without modeled accounting.
  Run `npx vitest run tests/sparse-workspace.test.ts tests/checkout-sparse.test.ts
  tests/status-sparse.test.ts tests/diff-sparse.test.ts tests/staging.test.ts
  tests/commit.test.ts` and `npm run bench:memory --
  --scenarios=core.sparse-selected-add`.
- **Touch points.** `src/git/store/sparse/`, `src/git/store/contracts.ts`,
  `src/runtime/workspace.ts`, `src/git/client.ts`, `src/git/ops/context.ts`,
  `src/git/ops/{commit,sparse-checkout,status-sparse,sparse-diff,staging,tree-build}.ts`,
  named tests, `bench/memory.ts`, and `bench/memory-protocol.ts`. This WU has an
  internal serialized seam step before its consumers. Its sparse source and
  consumer files are exclusive; the benchmark files are shared with WU5 and
  integrate serially.

### WU5 - Read loose objects in one payload pass (effort M)

- **Problem.** Ordinary loose reads first aggregate chunk metadata and only then
  fetch payload, duplicating traversal and trusting a preflight ADR-0018 rejects.
- **Verify first.** Capture the current metadata and payload query pair for one
  scalar and one bounded batch read.
- **Scope.** Stream ordered payload rows once while retaining only the final
  output, current payload row/feed, and fixed inflater state; never accumulate or
  concatenate all compressed chunks. Validate row shape, object and sequence
  boundaries, actual encoded size, inflate progress, and final size while
  decoding. Keep only the narrow metadata API reachability needs; do not alter
  packed reads or packed dependency traversal.
- **Acceptance / witness.** Scalar and batch loose reads issue one payload query,
  preserve every payload encoding, and fail safely on sequence, size, and inflate
  violations. A near-`MAX_OBJECT_BYTES` many-chunk scenario fits when the final
  object plus one feed fits but retaining all compressed chunks with the output
  would cross the target. Run `npx vitest run tests/loose-objects.test.ts
  tests/maintenance-reachability.test.ts` and `npm run bench:memory --
  --scenarios=core.loose-object-stream`.
- **Touch points.** `src/git/store/objects.ts`, the loose-metadata portion of
  `src/git/store/maintenance/reachability.ts`, new
  `tests/loose-objects.test.ts`, `tests/maintenance-reachability.test.ts`, and
  `bench/{memory,memory-protocol}.ts`. WU4 and WU5 integrate benchmark scenario
  registration serially.

### WU6 - Decode maintenance root pages once (effort L)

- **Problem.** Root discovery rereads refs, HEADs, reflogs, index rows, index
  baselines, and shallow rows; operation roots authenticate a complete journal
  instead of consuming a bounded page.
- **Verify first.** Count projections per source page and keep epoch-drift,
  cursor, page-boundary, and retained-reflog tests as controls.
- **Scope.** After WU1, decode each root page once through shared row shapes and
  rewire the database callback to consume the paged operation-root seam. Preserve
  keyset cursors, strict cursor progression, repository ownership, root semantics,
  epoch fencing, and every guard needed before destructive maintenance.
- **Acceptance / witness.** Each source page uses one projection; operation roots
  do not reread the complete journal; cold resume, page boundaries, retained
  reflogs, and epoch drift remain correct. Run `npx vitest run
  tests/maintenance-roots.test.ts tests/maintenance-cost.test.ts
  tests/concurrency-maintenance.test.ts`.
- **Touch points.** `src/git/store/maintenance/roots.ts`,
  `src/git/store/database.ts`, named tests.

### WU7 - Conformance witness and living documentation (effort S)

- **Problem.** The remaining policy has no narrow automated witness, and backlog
  17 still describes the pre-ADR trust model and obsolete source paths.
- **Verify first.** Enumerate only the ordinary read queries changed by WU1-WU6;
  exclude schema checks, write SQL, JSON ordinal casts, network ingest, and
  filesystem handle revalidation.
- **Scope.** Add `tests/trusted-read-policy.test.ts`; update living architecture,
  concurrency, and Git support where behavior changed; record the transaction-
  owned local state-machine decision in a new ADR; correct backlog 17's trust/cost
  wording and touch points while leaving its implementation unscheduled. Do not
  remove backlog rows, stamp `OUTCOME`, archive the sprint, or update lifecycle
  indexes until integrated review and every closure gate has completed.
- **Acceptance / witness.** The policy test rejects a reintroduced ordinary-read
  authentication witness without flagging allowed boundaries; docs links and
  transaction docs distinguish local SQLite serialization from async CAS/epochs;
  backlog 17 states the current trust model. Run `npx vitest run
  tests/trusted-read-policy.test.ts tests/import-graph.test.ts`; the integrated
  reviewer resolves every relative Markdown link changed by WU7. Run `npm run
  check` separately for formatting and lint.
- **Touch points.** `tests/trusted-read-policy.test.ts`, `docs/reference/`, the
  new ADR,
  `docs/backlog/{17-integrity-audit-and-snapshots,65-git-sqlite-architecture-review}.md`,
  and this sprint record. Final lifecycle edits are the leader-owned epilogue.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Durable journal state, filesystem schema, cross-domain trust, object decode, and destructive maintenance meet in one policy change. | Independent integrated review-to-clean after all focused witnesses; then routine, static, package, and one exhaustive closure gate. | A public API, schema version, packed read, maintenance deletion rule, or broad ARCH-17 seam changes. |
| WU1 | Replaces detached content CAS with SQLite-owned local serialization and changes restart state, operation roots, and replay cost. | Focused semantic, rollback, reentry, and N/2N witnesses plus independent review-to-clean. | Any journal state crosses `await`, another live database connection can interleave, or a callback cannot be kept inside/rejected by the transaction guard. |
| WU2 | The schema establishes trust for another domain. | Filesystem conformance plus independent review-to-clean of every new constraint against supported writers. | A constraint would reject valid POSIX state or require migration behavior. |
| WU3 | Mixes caller error taxonomy with persisted index guarantees. | Focused boundary/tracker witnesses and one independent review; fixes repeat the focused gate. | Public index semantics or transaction ownership changes. |
| WU4 | Establishes a non-forgeable cross-domain trust seam and removes local memory accounting. | Sparse witnesses, measured memory evidence, and independent review-to-clean. | The seam requires a public nominal type, removes a real structural cap, or cannot preserve custom fallback. |
| WU5 | Object decode errors can affect identity and availability. | Exact query-shape, malformed-payload, and near-ceiling memory witnesses plus independent review-to-clean. | Packed reads, cache ownership, or object publication changes. |
| WU6 | Roots feed destructive maintenance. | Root, cost, and concurrency witnesses plus independent review-to-clean. | Root membership, epoch semantics, or maintenance phase ownership changes. |
| WU7 | Policy and docs only after settled implementation. | Direct policy witness, docs/link check, and integrated reviewer approval. | The witness needs to ban valid boundary SQL or backlog scope changes materially. |

## Test cadence

- **Per WU.** Run only the exact witness above while iterating. An implementer
  does not run the full suite.
- **Routine integration.** Run `npm test` after every integrated wave; keep the
  smoke gate below 30 seconds.
- **Benchmarks.** Run `npm run bench:statements -- --check` for WU1,
  `npm run bench:memory -- --scenarios=core.sparse-selected-add` for WU4, and
  `npm run bench:memory -- --scenarios=core.loose-object-stream` for WU5. The
  memory runner owns its CPU lease and cgroup. Targets remain evidence, never
  runtime admission.
- **Sprint closure.** After final review and fixes, run `npm run typecheck`,
  `npm run check`, `npm run build`, `npm run package:smoke`, then one
  `cpu-lease run -n 4 -- env GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true npm run
  test:full`.
- **Failure loop.** Reproduce a closure failure with its exact file or stable
  domain slice before another exhaustive run.

## Out of scope (explicit)

- The broad ADR-0017 sweep: ARCH-8 and the remaining ARCH-17/CORR-11/CORR-12
  currencies in integration, tree walk, checkout, status, diff, rename,
  initial checkout, and rebase planning. It is the next sprint before packed
  traversal.
- Packed dependency graphs and packed-read memoization
  ([backlog 63](../backlog/63-bound-packed-dependency-graph-traversal.md)).
- Integrity audit, repair, snapshot export, and import
  ([backlog 17](../backlog/17-integrity-audit-and-snapshots.md)).
- Pack publication, repack, ref-scan, physical-schema, facade, and helper cleanup
  in the remaining non-ADR rows of backlog 65.
- Unverified claims in `../ideas/git-sqlite-architecture-review-triage.md` except
  the subsumed witness premises explicitly attached to a selected finding.

## Decisions

- Split the conformance phase by policy seam: finish trusted reads and their
  write premises here; redesign broad structural bounds in the following sprint.
  A combined sprint would exceed ten independent units and mix unrelated
  algorithms.
- Out-of-band database mutation remains undefined behavior. Tests may witness a
  schema write constraint, but ordinary read tests do not revive corruption
  authentication.
- Local same-database read-decide-write state machines use one blocking
  `transactionSync()` as their concurrency owner. Authoritative checks move
  inside that transaction; detached integrity hashes, revisions, leases, and
  mutexes are removed rather than renamed. Legal transitions still use SQL state
  predicates, and a transaction-local database guard rejects same-stack mutation
  reentry through injected callbacks. This decision is recorded in a new ADR.
- Transactions do not replace coordination across `await` or durable checkpoints.
  Original-ref CAS, fetch/push ownership, maintenance epochs, pack leases, and
  other async-boundary guards remain unchanged.
- SQL ordering is trusted for persisted store scans. Ordering checks remain at
  arbitrary iterable and cursor-progression boundaries.

## Sequencing

| Wave | Work | Isolation |
|---|---|---|
| 0 | Plan review and shared sprint contract. | Serialized; no implementation before approval. |
| 1 | WU1 and WU2. | Parallel domains: global Git mutation/journal ownership versus filesystem schema. |
| 2 | WU3 and WU5 after WU1. | Parallel index/config versus loose-object territories; WU1 guard wrappers are frozen. |
| 3 | WU4 after WU1 and WU2; WU6 after WU1. | Parallel sparse/runtime versus maintenance-root territories; WU4 and WU5 benchmark registrations integrate serially. |
| 4 | WU7 policy and living docs. | Serialized after implementation shapes settle. |
| 5 | Integrated review-to-clean and focused fixes. | No lifecycle closure while review is open. |
| 6 | Routine, static, package, benchmark, and one exhaustive closure gate. | Serialized in the main worktree. |
| 7 | Leader-owned epilogue: remove completed backlog rows, stamp `OUTCOME`, archive the sprint, and refresh indexes. | Only after every final number exists. |

## Plan review

An independent reviewer checks grounding, WU boundaries, exact witnesses,
review proportionality, and whether the split leaves a coherent ADR-0017
successor rather than hiding unfinished work.

- **Reviewer:** independent plan reviewer (`ses_f9d690cf3ffeu1CPJzmprnp79o`)
- **Verdict:** approved after three correction passes
- **Material findings:** The first pass found an unresolved journal concurrency
  model, missing N/2N evidence, no exact filesystem schema-open premise, unsafe
  constraint assumptions, an incomplete sparse trust seam and memory witness,
  unbounded loose-chunk retention, overlapping territories, a missing operation-
  root integration point, inexact gates, and premature lifecycle closure. The
  corrected plan chooses transaction-owned local state machines without a
  durable revision, adds a transaction-local reentry guard, exact witnesses and
  bounds, schema-shape validation, disjoint ownership, and a post-gate epilogue.
  A second pass accepted those corrections but required complete guard coverage
  across public Git/CLI/low-level mutation boundaries, serialized ownership of
  shared benchmark registration, and an explicit manual relative-link check;
  those corrections are now applied. The final pass narrowed the frozen guard
  inventory to Git-domain entry points so filesystem and raw database mutations
  remain outside WU1; re-review found no remaining blockers.

## Run log

- 2026-09-02 - The user authorized the package sprint after reviewing the
  external-gate-first sequencing. Execution assumes the external consumer gate
  has no package blocker that supersedes this work.
- 2026-09-02 - The first independent plan review blocked WU1's unspecified
  opaque revision and eleven secondary gaps. The user selected blocking SQLite
  transactions wherever a local same-database state machine permits them; the
  plan now removes detached journal CAS instead of replacing its currency.
- 2026-09-02 - WU7 enumerated only the ordinary reads changed by WU1-WU6:
  operation state/steps/touched and operation-root pages; index tracker state
  and dirty pages; native sparse selection, workspace, tree-resolution, and
  snapshot projections; the joined loose-object payload cursor; and ref, HEAD,
  reflog, index, baseline, shallow, and operation-checkout maintenance pages.
  The policy witness deliberately excludes schema validation, write SQL, JSON
  ordinal casts, network ingest, filesystem stale-handle revalidation, and true
  algorithmic guards.
- 2026-09-02 - Local state-machine ownership, rejected detached
  revisions/hashes/leases/mutexes, and release/reacquisition around `await`
  graduated to
  [ADR-0022](../decisions/0022-own-local-git-mutations-with-sqlite-transactions.md).
- 2026-09-02 - WU7 did not broaden the ARCH-17 sweep. Backlog 65 now records
  the settled trusted-read tranche and narrows ARCH-17 to its remaining
  unscheduled algorithms; backlog 17 remains the opt-in integrity-audit and
  snapshot work rather than an ordinary-read requirement.
- 2026-09-02 - WU7 review clarified that sparse bounds use different units:
  selected-path projection counts 1,000 distinct paths (with up to four index
  conflict stages each), workspace hydration bounds request and index rows, and
  commit-tree snapshot shares one global 1,000-item materialization counter.
