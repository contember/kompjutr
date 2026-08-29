# Sprint — Budget targets and table-family store split (2026-08-29)

**Goal.** Make SQL statement count a measured performance target instead of a
runtime failure, retain only limits that protect a real failure, and split the
SQLite Git store by table family without changing its public facade.

**Theme.** Backlog 60 corrects one inverted safety rule before partial clone
adds another state to every object read path. The statement model, memory-limit
inventory, and monolithic store belong together because all three currently
concentrate policy and implementation in `src/sqlite/store.ts` and its callers.
Success means runtime behavior never depends on a projected query count, every
remaining byte bound has named evidence, and callers still import the same
`SqliteGitDatabase`, `SharedRepoStore`, and `CheckoutStore` facade.

## Refs re-verified at HEAD (2026-08-29)

Planning is grounded at `6dac935`; `✔` = confirmed live · `⚠` = drift or nuance
caught before implementation.

- ✔ Root invariant 5 now defines `≤1,000` SQL statements as a target measured
  in `bench/`, never a runtime barrier. Structural and retained-memory limits
  still fail closed when they prevent a real platform failure — `CLAUDE.md`.
- ✔ The runtime has 28 named `MAX_*` statement constants across 13 files plus
  26 declaration-level semantic aliases whose names say pages, reads, rows,
  batches, patterns, or object properties. Together they drive 34 ordinary
  query/work refusals, three query-derived corruption failures, four silent
  fallbacks, and seven module-load assertions. The transport budget alone has
  56 SQL accounting call sites.
- ✔ `RefMutationBudget.requireSqlHeadroom()` is not a statement barrier despite
  its name. It reserves retained bytes for SQLite work and must remain unless
  the memory inventory proves a different real allocation model —
  `src/sqlite/store.ts:1159-1187`.
- ⚠ The suite has 492 `statementCount` references in 68 files. Of 333 direct
  matcher assertions, 171 are exact equalities and 162 are inequalities. Exact
  zero/one assertions sometimes prove a semantic query shape such as no scalar
  lookup or no materialisation; those are not cost targets and must not be
  weakened mechanically.
- ⚠ Existing benchmarks count statements for synthetic, macro, shell, clone,
  Next.js and production-probe phases, but have no dedicated rows for
  merge/rebase/replay, fetch publication, redirect streaming, schema init,
  sparse prune, maintenance repack, or the `ls-files` models whose runtime
  barriers are removed — `bench/scenarios.ts`, `bench/nextjs-workflow.ts`.
- ⚠ The backlog names 117 `MAX_*_BYTES` declarations, but 30 reordered names
  (`DIFF_MAX_*_BYTES`, `*_BYTES_MAX`, and similar) enforce the same policy. The
  complete `MAX`-containing declaration inventory is 147 constants; 28 hidden
  byte sites without that naming shape are reconciled separately. No individual
  threshold is benchmark-derived at HEAD; boundary tests prove enforcement, not
  the chosen number.
- ✔ Eight initial removal candidates count streamed or paged work rather than a
  live allocation: streamed redirect total, add/rm/merge-guard hash totals,
  read-tree writes, rebase baseline bytes, maintenance header bytes, and caller
  protocol chunk size. Uses of a pack batch size as a maximum valid object size
  have the same category error. These remain proposals until WU1 evidence review.
- ✔ `src/sqlite/store.ts` is 9,259 lines. It exports three facade classes and
  public contracts while implementing repository identity/routing, shared
  caches, objects, refs/reflogs, config, index/scratch index, operation state,
  initial state, commit cache, shallow state, and destruction.
- ✔ Core operations, runtime code, maintenance, Git clients and tests import
  `src/sqlite/store.js`; `tests/public-exports.test.ts` is the public package
  witness. The split must not redirect those consumers to internal modules.
- ⚠ `tests/CLAUDE.md` still says cost is behavior in the unit suite. Living
  references also describe a 1,000-statement runtime ceiling in architecture,
  concurrency, Git support, shell and production-probe docs. Accepted ADRs are
  immutable; the new decision records the changed rule instead of rewriting
  their history.

## Frozen policy contract

1. Production code has no statement-count admission, reservation, fallback,
   projection refusal, or module-load ceiling. It may still structure work in
   pages and batches so measured cost stays low.
2. `≤1,000` remains a benchmark target. Benchmark rows report target pass or
   miss, but a known target miss is optimization evidence, not a runtime-like
   harness failure. Missing rows, invalid end state, or regression against a
   frozen baseline may fail the measurement.
3. Operation-cost assertions in Vitest become coarse `<1,000` alarms. An exact
   zero/one query-shape assertion survives only when its name and nearby comment
   state the semantic property it proves.
4. No reviewer request may introduce a new statement constant or projected-count
   refusal. Such a finding is rejected with root invariant 5 and ADR 0017.
5. A byte limit is classified before it changes: external format/platform
   limit, persisted-schema validation, retained-memory/OOM guard, real
   structural or algorithmic limit, work counter, batching threshold, or
   fallback heuristic. Only the first four may refuse a call, and each must name
   its real failure, structural invariant, or aggregate memory equation.
6. The store split is a pure internal move. SQL text, transaction boundaries,
   validation, cache ownership, class constructors, method signatures, root
   exports and package subpaths stay unchanged. Internal table-family modules are
   not new public exports.
7. WU6 deliberately retires four exported policy constants whose semantics no
   longer exist: `MAX_REMOTE_NAME_BYTES`, `MAX_REMOTE_URL_BYTES`,
   `MAX_LS_REMOTE_PATTERN_BYTES`, and `MAX_REFSPEC_REF_BYTES`. This project has
   no production users and does not require backward compatibility. All other
   public exports stay unchanged; no obsolete constant remains as a misleading
   compatibility value.

## Work units

### WU1 — Establish the evidence ledger (effort L)

- **Problem.** Removing runtime models without a replacement would lose the cost
  signal, while changing byte bounds before a complete inventory would turn an
  arbitrary policy into another arbitrary policy.
- **Verify first.** Recount the 28 statement constants, 26 declaration-level
  semantic aliases, 147 `MAX`-containing byte declarations, 28 hidden byte
  sites, 333 direct statement matchers and benchmark gaps from the commands
  recorded in the run log. Run three clean
  current Next.js benchmarks under the same two-vCPU no-SMT lease as the before
  baseline.
- **Scope.** Add a deterministic `bench:statements` surface with correctness-
  checked rows for schema init, streamed redirect, cached and combined
  `ls-files`, sparse prune, fetch publication, merge-base selection, recursive
  virtual base, merge apply/recovery/restore, replay plan/preflight/recovery, rebase
  plan/transition, maintenance repack selection, pack fallback audit/uncached
  authentication/uncached reads, ignore loading, index-tracker dirty traversal/
  reseal, checkout removal, worktree guards, staging add/rm, full status,
  initial checkout, sparse commit, index/worktree diff, and transport discovery/
  fetch/push;
  reuse existing clone/commit/checkout Next.js rows where they are the exact
  measured operation. Append a stable grouped-site barrier ledger to this run
  log: policy owner/source sites, old operation/error/fallback, focused removal witness,
  representative benchmark row, and removal WU for all 48 grouped sites: 34
  ordinary refusals, three query-derived corruption failures, four fallbacks,
  and seven load assertions. Shared helpers and equivalent branches stay in one
  owner row, so raw throw-branch count is intentionally higher. The focused former-first-excess
  witness is separate from the representative target row: an admitted stress
  call may exceed the target without becoming a runtime error. Target rows
  report pass/miss and compare against the frozen baseline; they do not turn a
  known target miss into an admission rule. Append the
  147-row declaration TSV plus the hidden-site byte ledger with kind, owner,
  failure, evidence and decision.
  Freeze exact byte removals/replacements only after independent evidence
  review. Record accepted ADR 0017 and register it in the decision log and docs
  index; root invariant 5 already makes this policy binding.
- **Acceptance / witness.** `npm run bench:statements -- --check` emits every
  required row with validated end state and statement count; repeated output is
  deterministic. Representative rows report the measured target and fail on a
  regression against their frozen baseline, while removal witnesses only prove
  the runtime no longer manufactures failure. The known Next.js clone baseline
  miss is reported without failing correctness. The barrier
  ledger has one reviewed disposition per removal site. The inventory has one
  stable `source + symbol` key for every semantic byte constant and no duplicate
  or missing key under a TypeScript-AST audit. The baseline and proposed byte
  actions are reviewed to clean before WU2/WU6.
- **Touch points.** `bench/`, `package.json`, this sprint run log,
  `docs/decisions/{0017-measure-query-cost-and-bound-real-failures.md,
  README.md}`, `docs/INDEX.md`.

### WU2 — Remove core integration and history statement models (effort L)

- **Problem.** Merge-base, integration, merge apply/recovery, replay, rebase,
  commit and reflog identity propagate projected SQL fields and reject otherwise
  valid calls.
- **Verify first.** Pin the existing refusal and calculator witnesses, including
  merge apply and restore, recursive virtual merge-base, replay recovery and
  rebase lifecycle.
- **Scope.** Delete statement constants, module-load assertions, projected SQL
  fields/calculators and runtime refusals from the core integration/history
  family. Remove the same query currency where it is encoded as integration/
  merge snapshot read calls, scan pages/rows, or dirty/checkout-guard hash
  batches/range reads. Preserve graph-size, path, object, actual retained-memory,
  journal, candidate/cardinality and CAS bounds. Do not change result semantics
  beyond removal of query/work-count refusal.
- **Acceptance / witness.** Former first-excess statement fixtures now complete
  with the same public repository state as Git; memory/structural first-excess
  fixtures still fail. Run the focused merge/integration group and the focused
  replay/rebase group separately, each below 30 seconds, then `npm test`.
- **Touch points.** `src/core/ops/{commit,integration,integration-worktree,
  merge-base,merge,merge-apply,replay,replay-lifecycle,rebase-plan,
  rebase-lifecycle,ref-log,refs,worktree-io}.ts` and matching tests.

### WU3 — Remove transport and publication SQL accounting (effort L)

- **Problem.** Clone/fetch/push and ref publication reserve and charge an
  invented SQL currency, and push/fetch projections reject work before SQLite.
- **Verify first.** Pin transport memory reservation, fetch publication fencing,
  push CAS, response-loss and retry behavior independently from statement
  accounting.
- **Scope.** Remove the statement half of `TransportOperationBudget`, all 56 SQL
  charge/reserve/release calls, push projection and fetch-publication admission.
  Keep its 64 MiB retained-memory coordinator, token ownership, ref namespace
  revisions, atomic publication, pack memory limits and every CAS.
- **Acceptance / witness.** Over-former-budget fetch/push/publication fixtures run
  to their protocol or structural outcome; concurrency and cold-reopen oracles
  remain unchanged; memory reservation cleanup still proves zero leaks. Run
  focused fetch/publication tests and push/network tests as separate sub-30-
  second commands, then `npm test`.
- **Touch points.** `src/core/ops/{transport-budget,network,ls-remote,push-plan,
  push}.ts`, `src/sqlite/{packs,store}.ts`, and matching tests.

### WU4 — Remove standalone statement gates and fallbacks (effort L)

- **Problem.** Schema initialization, atomic redirect streaming, checkout
  removal, pathspec/`ls-files`, index/worktree diff, staging, sparse tracker/
  checkout paths, pack authentication, and maintenance repack retain independent
  projected work barriers outside the shared transport/history models.
- **Verify first.** Add direct witnesses for redirect first excess, sparse
  selected-plan fallback, maintenance selection, and both `ls-files`
  projections where current tests cover only their calculators. Schema has a
  fixed initialization stream and no caller-controlled over-999 fixture; pin
  fresh initialization, reopen and corrupt-schema behavior plus the wrapper's
  source/API shape instead of inventing a test seam.
- **Scope.** Delete the schema 999 wrapper, redirect 900-statement refusal,
  checkout removal-batch admission, pathspec/staging assertions and query-derived
  pattern/prefix/scan/hash limits, diff scan-row admission, sparse SQL-driven
  fallbacks, and maintenance repack statement estimate/refusal. Remove the
  semantically named pack audit-page/uncached-read, ignore discovery/read, and
  tracker consumer/producer row refusals or fallbacks. Retain transactional
  rollback, real cardinality, non-refusing batch/page sizes, memory limits,
  cursor progress/corruption checks, and restartable maintenance ownership.
- **Acceptance / witness.** Caller-reachable former refusals/fallbacks proceed;
  redirect remains atomic, sparse state matches the full path, and maintenance
  resumes and publishes the same objects. A source/API audit proves the schema
  counting wrapper is absent while fresh init, exact reopen, version mismatch
  and corrupt schema retain their prior outcomes. Run schema, filesystem
  redirect, pathspec/staging/sparse and maintenance witnesses separately, then
  `npm test`.
- **Touch points.** `src/{fs/store/stream-write,sqlite/schema,
  sqlite/maintenance/repack,sqlite/packs,sqlite/index-tracker,
  sqlite/sparse-workspace}.ts`, `src/core/{ignore/index,ops/checkout,ops/diff,
  ops/initial-checkout,ops/pathspec,ops/staging,ops/status-sparse,
  ops/sparse-checkout}.ts`, and matching tests.

### WU5 — Put cost policy in benchmarks and living docs (effort M)

- **Problem.** Exact operation-cost assertions and living docs would otherwise
  preserve the removed runtime model by implication.
- **Verify first.** Classify all 171 exact statement equalities as operation cost
  or semantic query shape; do not bulk-rewrite ambiguous zero/one assertions.
- **Scope.** Convert operation-cost assertions to `<1,000`; retain and name exact
  semantic query-shape assertions. Update `tests/CLAUDE.md`, root/core module
  context, architecture, concurrency, Git support, shell, production probe and
  benchmark wording. Align living docs with accepted ADR 0017 and list every
  removed runtime refusal and fallback by operation/error in this sprint run log.
- **Acceptance / witness.** An AST audit reports no exact operation-cost matcher,
  while named semantic zero/one witnesses remain. Source search reports no
  runtime statement constant, accounting method, projected-count refusal or
  load assertion. `npm run bench:statements -- --check`, typecheck, docs links,
  and `npm test` pass.
- **Touch points.** `tests/`, `tests/CLAUDE.md`, `src/core/CLAUDE.md`, `bench/`,
  `docs/{decisions,reference}/`, `docs/decisions/README.md`, `docs/INDEX.md`,
  this sprint file.

### WU6 — Remove only evidence-rejected byte barriers (effort L)

- **Problem.** Several byte counters reject streamed/paged work even though the
  counted bytes are not simultaneously retained; other superficially similar
  limits protect real allocation or external format bounds.
- **Verify first.** The WU1 inventory and independent evidence review must name
  the exact approved removals/replacements. If that review is not approved, this
  WU is blocked and no byte constant changes.
- **Scope.** Apply the exact WU1 action ledger below. Remove the eleven named
  cumulative work counters, every reconciled hidden work alias, and the
  pack-batch validity misuse. Replace or deduplicate all 98 inventory rows
  marked `replace`/`dedupe` through their named canonical
  owner; do not substitute a new component ceiling. The work lands as WU6a–WU6g
  so each memory owner and import seam can be reviewed independently. Keep the
  38 reviewed aggregate OOM, protocol framing, persisted-row, non-refusing
  batching and fallback limits unchanged.
- **Acceptance / witness.** A workload above each removed threshold succeeds
  while per-page/per-chunk retained high-water remains within the central memory
  model. Focused memory, pack, protocol, filesystem and lifecycle witnesses pass.
  A cgroup-backed benchmark under a CPU lease covers the large streamed/hash/
  rebase/reachability cases; it is evidence of bounded live memory, not a new
  runtime admission threshold.
- **Touch points.** Exact files and symbols are frozen in the WU1 action ledger.
  WU6a owns common limit/memory seams and initial writes; WU6b owns refs/config;
  WU6c owns integration/history; WU6d owns reads/tree/sparse; WU6e owns
  transport/protocol; WU6f owns CLI/shell; WU6g owns SQLite stores/caches.

### WU7 — Establish the internal store module seam (effort L)

- **Problem.** Family extraction is unsafe while public contracts, database
  identity, shared cache ownership and checkout implementation are interleaved
  in one 9,259-line file.
- **Verify first.** Snapshot every named export of `src/sqlite/store.ts`, public
  constructor/method type, package export and representative SQL statement text.
- **Scope.** Turn `src/sqlite/store.ts` into an explicit compatibility facade;
  move public contracts plus the database identity/routing registry, shared
  repository facade and checkout implementation into internal `src/sqlite/store/`
  modules. Resolve cycles with type-only contracts, not casts or widened public
  types. This is a mechanical move; no SQL or behavior change.
- **Acceptance / witness.** The public-export snapshot is byte-for-byte
  unchanged from the post-WU6 snapshot (which records only the four deliberate
  retired policy exports); external source imports still target
  `src/sqlite/store.js`;
  database identity, checkout lifecycle, scratch ownership and reopen tests
  pass. Typecheck and `npm test` pass.
- **Touch points.** `src/sqlite/store.ts`, new `src/sqlite/store/{contracts,
  database,shared,checkout}.ts`, focused lifecycle/store tests.

### WU8 — Extract objects, packs and commit/shallow state (effort L)

- **Problem.** Object/blob-id reads and writes, pack fallback, caches, commit
  projection and shallow state dominate the checkout implementation and share a
  clear repository-table ownership boundary.
- **Verify first.** Pin loose/packed authenticated reads, blob-id buffering,
  batch rollback, cache invalidation, commit cache and shallow reopen behavior.
- **Scope.** Move the object-family implementation behind an internal component
  used by `CheckoutStore` and `SharedRepoStore`. Existing `packs.ts` remains the
  pack engine; only its store-facing ownership seam moves. Preserve cache keys,
  memory reservation owners, transaction scope and SQL text.
- **Acceptance / witness.** Object, pack, tree, commit-cache, shallow and
  maintenance focused witnesses pass in bounded groups with identical SQL text,
  statement/row counts, transaction boundaries and cache behavior. A discovered
  defect stops extraction; its fix must land as a separate reviewed pre-
  extraction WU/commit before the pure move resumes. `npm test` passes.
- **Touch points.** `src/sqlite/store/{checkout,shared,objects}.ts`,
  `src/sqlite/packs.ts` only if an internal type import moves, matching tests.

### WU9 — Extract refs, reflogs and config (effort L)

- **Problem.** Ref normalization/publication, reflog validation/retention and
  config section operations are independent table families with transactional
  seams hidden inside the checkout class.
- **Verify first.** Pin exact ref CAS, fetch/tracking token ownership, reflog
  retention/root enumeration, bounded config reads and section moves.
- **Scope.** Move refs/reflogs and config into separate internal components.
  Keep token classes and public types re-exported from the facade. Preserve
  maintenance root-epoch bumps, ref namespace revisions, event ordering, config
  sequence ordering and transaction boundaries.
- **Acceptance / witness.** Store, fetch publication, concurrency fetch/network,
  reflog API and config tests pass in separate bounded groups; public exports and
  `npm test` pass.
- **Touch points.** `src/sqlite/store/{checkout,refs,config,contracts}.ts`,
  ref/config tests and internal type-only imports.

### WU10 — Extract index, checkout state and operation journals (effort L)

- **Problem.** The remaining checkout implementation still mixes index/scratch
  rows, initial checkout publication and restart-safe merge/rebase journals.
- **Verify first.** Pin index iteration/order, replacement rollback, scratch
  poisoning, initial-state ownership, every journal kind, stale CAS and cold
  reopen recovery.
- **Scope.** Move index/scratch behavior and operation/initial state into their
  own internal components, leaving `CheckoutStore` as the unchanged coordinating
  facade. Remove obsolete helpers from the facade and enforce the one-way import
  graph with a focused static witness.
- **Acceptance / witness.** Index, checkout-initial, operation-state,
  restart-conformance and lifecycle tests pass in separate bounded groups;
  `src/sqlite/store.ts` contains only explicit public re-exports, family modules
  do not import the public barrel at runtime, public exports remain unchanged,
  typecheck and `npm test` pass.
- **Touch points.** `src/sqlite/store/{checkout,index,operations,contracts}.ts`,
  `src/sqlite/store.ts`, matching tests.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Fundamental behavior and storage-module structure change across nearly every Git path. | Independent T3 review-to-clean of the integrated diff; both parity harnesses, target benchmarks, public package smoke and the closure suite must pass. | Any SQL/schema/public API change, new refusal, unresolved memory evidence, or benchmark target miss. |
| WU1 | Evidence determines every later removal. | Independent T3 evidence review of benchmark coverage, all 147 declaration rows, all hidden byte sites, and proposed actions; fixes return to the same reviewer. | A constant/site cannot be classified or a former statement barrier lacks a measurable row. |
| WU2 | Merge/rebase/recovery behavior and public error surface. | Independent T3 review-to-clean plus exact focused witnesses. | A projected count also encoded a real graph/memory bound. |
| WU3 | Network publication, ownership and CAS are high blast radius. | Independent T3 review-to-clean plus fetch/push concurrency witnesses. | Atomicity, retry or memory ownership changes. |
| WU4 | Several independent runtime barriers, including schema and maintenance. | Independent T3 review-to-clean; caller-reachable gates have direct former-first-excess witnesses, while schema uses source/API plus fresh/reopen/version/corruption witnesses. | Removing the statement gate exposes unbounded traversal or per-row SQL. |
| WU5 | Mostly tests/docs, but a wrong classification can hide cost regressions. | T2 independent review of exact-vs-coarse assertions and source audit; integrated T3 rechecks policy. | An exact assertion has mixed correctness and cost meaning. |
| WU6 | Memory failures are real; false removal can OOM production. | Independent T3 review-to-clean of only the WU1-approved actions plus cgroup evidence. | Evidence is test-only, high-water is unbounded, or a replacement needs architecture change. |
| WU7–WU10 | Pure moves, but private ownership, cycles and transaction seams are fundamental. | Independent T3 review-to-clean per WU, focused family witnesses, public export snapshot and routine gate. | SQL text/ordering, transaction scope, cache owner, public type or runtime import graph changes. |

## Test cadence

- **Per WU.** Run only the named focused witnesses, split so every ordinary test
  command remains in the tens of seconds and below 30 seconds.
- **Routine integration.** Run `npm test` after each landed WU. It is the stable
  cross-layer smoke gate and must remain below 30 seconds.
- **Benchmarks.** Run correctness-only statement targets while iterating. Lease
  two no-SMT vCPUs for the before/final Next.js and cgroup memory measurements;
  never report unleased wall or memory numbers.
- **Sprint closure.** After final independent review is clean, run Git parity
  (`npx vitest run tests/git-upstream-parity.test.ts`), shell real-binary parity
  (`npx vitest run tests/shell/parity-grep.test.ts
  tests/shell/parity-rg.test.ts tests/shell/parity-touch.test.ts`), filesystem
  conformance (`npx vitest run tests/fs/conformance`), `npm run typecheck`,
  `npm run check`, `npm run build`, `npm run package:smoke`, and `npm run
  test:full` exactly once under a two-vCPU lease.
- **Next.js comparison.** Run three clean before and three clean final
  `npm run bench:nextjs` passes under the same two-vCPU no-SMT lease. Every phase
  must succeed and retain its exact median statement count; returned-row medians
  must match when rounded to three significant figures. Per-run statement and
  row counts may vary at a transport chunk boundary. Final median wall time must
  not exceed the before median by more than the larger of 20% or 25 ms per
  phase. RSS/heap deltas are reported as informational because the harness
  cannot make them deterministic.
- **Failure loop.** Reproduce a closure failure with its exact file/domain slice.
  Rerun the exhaustive suite only after the focused witness is stable.

## Out of scope (explicit)

- The external consumer adapter and its provider bulk-scan limitation. That gate
  remains outside this public repository and must not influence runtime statement
  admission under invariant 5.
- Partial clone, deepening, force-with-lease, cancellation and all later backlog
  parity work.
- Schema migrations or backward compatibility. The project has no production
  users; the store split changes no schema anyway.
- Compatibility shims for the four retired byte-policy exports. Their removal
  is intentional and is the only accepted public-export delta in this sprint.
- Blanket removal or numerical retuning of retained-memory, protocol, persisted-
  row, SQL-binding, batching or fallback limits. Only WU1-reviewed actions land.
- Production deployment or a new production probe. This sprint uses local
  benchmark evidence and the existing production record.
- Performance optimization hidden inside the store move. Any discovered
  optimization becomes a separate measured work item.

## Decisions

- SQL statement count is observation, not admission. Runtime code never refuses
  work from a projected count, including on reviewer request.
- Exact query-shape witnesses survive only when they prove correctness; operation
  cost lives in benchmark rows plus the suite's coarse `<1,000` alarm.
- Byte limits are decided from the complete semantic inventory. Counting work is
  not a memory guard; batching without refusal is not a user-visible limit.
- The public store module remains the only consumer import path. Internal family
  modules may evolve, but this sprint makes no new public surface.
- Store extraction follows statement and memory cleanup so moved code does not
  preserve obsolete accounting or create overlapping edits.

## Sequencing

1. WU1 implements the benchmark and inventory evidence, receives independent
   review-to-clean, and only then commits/lands. Its reviewed action table
   freezes WU6 scope.
2. WU2 and WU3 remove the shared core and transport models in that order; WU3
   deletes store statement constants only after WU2 consumers are gone.
3. WU4 removes disjoint standalone gates. WU5 normalizes tests/docs and proves
   the statement model is absent.
4. WU6 applies only reviewed byte-limit decisions.
5. WU7 establishes the store module seam. WU8–WU10 extract table families
   sequentially because each edits the coordinating checkout facade.
6. Integrated T3 review and fixes settle before benchmark/parity/full closure
   gates and archival.

## Plan review

An independent reviewer checks the complete proposal against HEAD, especially
invariant 5, benchmark coverage, the two-stage memory decision gate, exact query-
shape exceptions, store import topology and proportional per-WU review.

- **Reviewer:** Huygens (`review_budget_store_plan_t3`)
- **Verdict:** approved after corrections
- **Material findings:** The first proposal lacked stable grouped-site barrier evidence,
  asked for an infeasible over-999 schema fixture, omitted structural byte
  limits, allowed defect fixes inside a pure store move, and left closure gates
  underspecified. The approved plan now maps every barrier to separate behavior
  and benchmark witnesses, uses source/API schema evidence, reviews all 147
  declaration rows plus hidden byte sites including real structural failures,
  stops extraction for separate fixes,
  and names parity/conformance plus three-run benchmark thresholds.

## Run log

- 2026-08-29 — The initial name-based audit found 28 statement constants. The
  completed semantic dataflow audit found 26 additional declaration-level
  aliases plus propagated limit properties and caller literals. The complete
  grouped surface is 34 ordinary query/work refusals, three query-derived
  corruption failures, four silent fallbacks, and seven load assertions.
  Benchmark target checks are retained.
- 2026-08-29 — Read-only memory audit expanded the backlog's 117-name regex to
  147 semantically equivalent `MAX`-containing byte declarations and separately
  reconciled 28 hidden byte sites. None has per-threshold benchmark evidence at
  HEAD; the classification must separate live allocation, external format,
  persisted validation, batching, fallback and streamed work.
- 2026-08-29 — The store has drifted from 8,493 to 9,259 lines. Public consumers
  still converge on `src/sqlite/store.js`, so the planned internal directory
  keeps that file as an explicit facade.
- 2026-08-29 — Huygens approved the corrected T3 proposal. Implementation may
  start with WU1; its evidence must receive its own review-to-clean before it is
  committed and before any runtime barrier changes.
- 2026-08-29 — Three clean Next.js baselines ran under one two-vCPU no-SMT
  lease. All phases completed. `git.clone` varied at one transport chunk boundary
  (`1,587/109,919`, `1,586/109,918`, `1,586/109,918` statements/rows) and has a
  1,586-statement median, so it is already a target miss. Every non-clone phase
  had a median of at most 67 statements. Final comparison therefore uses exact
  median statements and three-significant-figure median rows. Clone optimization
  is outside this sprint; the target miss remains visible evidence.
- 2026-08-29 — WU1 semantic review closed at 48 grouped query/work policy
  owners: 34 ordinary refusals, three query-derived corruption failures, four
  silent fallbacks, and seven load assertions. The comparable declaration audit
  is 28 named statement constants plus 26 semantic aliases. Generic synchronous
  CPU/cardinality row ceilings without query-target provenance remain structural
  pending separate evidence.
- 2026-08-29 — The byte review closed at 147 `MAX`-containing declarations
  (`38 keep / 11 remove / 67 replace / 31 dedupe`) plus 28 hidden sites. WU6 has
  an explicit stage, owner, and witness for all 98 replacement/deduplication
  actions, all direct removals, and every hidden site. The documented 2 MB SQL
  value size is batching guidance, not a package-side first-failure boundary.
- 2026-08-29 — `bench:statements -- --check` now validates 34 deterministic
  operation rows, exact SQL and returned-row baselines, semantic end state, and
  three-significant-figure Next.js row medians. Two final two-vCPU no-SMT runs
  were identical at 7.20 s and 7.14 s; an independent rerun passed at 7.3 s.
  Every synthetic row meets the target. Next.js clone remains the intentional
  report-only miss at 1,586 SQL / 109,918 rows.
- 2026-08-29 — Ohm (`fix_computer_worktree_scan_t3`) approved WU1
  review-to-clean after the expanded semantic and byte audits. Independent typecheck,
  Biome, benchmark, and diff checks passed. The routine smoke gate passed 148/
  148 in 16.99 s under a two-vCPU no-SMT lease.
- 2026-08-29 — WU2 removed the core integration/history statement currency,
  read-call admissions, scan-row/page ceilings, and hash batch/range-read
  admissions. Initial T3 review caught a missing worktree cursor-progress guard,
  a dead range-read calculator, and weak first-excess oracles; all were fixed.
  Reachable boundaries now prove exact merge, rebase, replay-preflight, and 65th
  range-read outcomes. The former 11th dirty batch, sixth rebase batch, and
  replay statement refusal are shadowed by lower real cardinality/byte maxima;
  their arithmetic is recorded in the reviewed tests and no artificial seam was
  added. Ohm approved the final review-to-clean.
- 2026-08-29 — WU3 removed all 56 transport SQL charge/reserve/release sites,
  push projection, fetch-publication admission, and pack-ingest SQL wrappers.
  The 64 MiB retained-memory coordinator, fetch/push CAS and revisions, atomic
  publication, retry uncertainty, and pack leases remain. Ohm independently
  approved the 1,024-ref publication/reopen witness and final T3 review.
- 2026-08-29 — WU4 removed the remaining schema, redirect, checkout,
  pathspec/staging/diff, tracker/sparse, maintenance, ignore, and pack query
  gates or fallbacks. Review replaced false >100,000-row witnesses, added exact
  tracker reopen/epoch and pack 181st-read boundaries, and bounded sparse dirty
  loading by `floor(remaining retained bytes / 1,037) + 1` sentinel rows. This
  derives only from the real 8 MiB owner, not query cost. Dalton approved the
  final review-to-clean. The combined routine smoke gate passed 150/150 in
  12.30 s under a two-vCPU lease.
- 2026-08-29 — WU5 moved SQL cost policy to benchmarks and living docs. Unit
  operation costs are coarse `<1,000` target alarms; exact counts remain only
  where named histogram, paging, cache, pre-SQL, or API instrumentation proves a
  semantic query shape. The production probe and clone/workerd harnesses now
  report target pass/miss without turning a known miss into failure. Ohm's
  two-round independent review restored every weakened semantic/API witness and
  approved the final test classification; Dalton approved the docs and
  benchmark/probe half. `bench:statements -- --check` passed in 6.36 s, including
  the report-only Next.js clone miss at 1,586 SQL. Typecheck and Biome passed,
  and the routine smoke gate passed 150/150 in 11.81 s under a two-vCPU lease.
  Agent-docs lint reports only the pre-existing `docs/AGENTS.md` root file.

The committed before baseline below preserves the medians required by the final
gate; wall values are external local durations under the one shared lease.

| Next.js phase | Median wall ms | Median SQL | Median rows |
|---|---:|---:|---:|
| `git.clone` | 14,627.488 | 1,586 | 109,918 |
| `git.status (clean clone)` | 3.324 | 14 | 12 |
| `git.branch` | 6.091 | 28 | 18 |
| `fs.writeFiles (100)` | 29.314 | 6 | 288 |
| `git.status (100 modified)` | 1,146.106 | 61 | 49,540 |
| `git.diffSummary (100)` | 69.916 | 29 | 1,575 |
| `git.diff (100)` | 62.240 | 28 | 1,573 |
| `git.add (100)` | 80.574 | 18 | 1,754 |
| `git.status (100 staged)` | 1,119.358 | 60 | 49,194 |
| `git.commit (100)` | 51.280 | 44 | 722 |
| `git.push (100)` | 412.773 | 45 | 760 |
| `git.status (clean commit)` | 31.204 | 25 | 685 |
| `git.checkout main` | 69.369 | 66 | 825 |
| `git.checkout main (force)` | 66.138 | 67 | 925 |
| `git.status (clean main)` | 0.725 | 11 | 8 |
| `git.checkout bench-work` | 70.394 | 65 | 1,024 |
| `git.checkout bench-work (force)` | 67.162 | 65 | 1,024 |
| `git.status (clean work)` | 0.747 | 10 | 8 |

### WU1 audit commands and results

The declaration audit ran at `6dac935`. It used declaration nodes, not text
occurrences, so imports and uses do not inflate the result. The two regex counts
are retained as a cheap independent cross-check:

```sh
rg -n '^(export )?const MAX_[A-Z0-9_]*BYTES\s*=' src | wc -l
# 117
rg -n '^(export )?const [A-Z0-9_]*(MAX[A-Z0-9_]*BYTES|BYTES[A-Z0-9_]*MAX)[A-Z0-9_]*\s*=' src | wc -l
# 147
```

The exact TypeScript-AST predicate was: visit every variable declaration under
`rg --files src -g '*.ts'`; require an identifier name and initializer; count a
byte declaration when `name.includes("MAX") && name.includes("BYTES")`; count a
statement declaration when `name.includes("MAX") &&
name.includes("STATEMENT")`. It produced:

```text
byte declarations: 147 = 117 MAX_*_BYTES prefix + 30 reordered names
statement declarations: 28 in 13 declaration files
statement-policy source surface: 24 files
grouped query/work policy sites: 34 refusals + 3 corruption failures + 4 fallbacks + 7 assertions
statementCount references: 492 in 68 test files
direct statement matchers: 333 = 171 exact + 162 inequality
```

The direct-matcher audit parsed Vitest `expect` call expressions, followed one
local identifier assignment to include multiline `statementCount` deltas, and
classified `toBe`/`toEqual` as exact and the four less/greater matchers as
inequalities. No source file was changed by either audit.

The name predicate was not treated as completeness evidence. A second semantic
pass searched throws, error text, comments, limit-object properties, projected
page/read/batch counters, query-derived row caps, and every caller literal. It
added these 26 declaration-level aliases:
`MAX_PACK_FALLBACK_AUDIT_PAGES`, `MAX_PACK_AUTH_UNCACHED_ROW_READS`,
`MAX_PACK_GENERIC_UNCACHED_ROW_READS`, `IGNORE_LIMITS.discoveryStatements`,
`IGNORE_LIMITS.readStatements`, `MAX_DIRTY_ROWS`, `MAX_ITERATE_PAGES`,
`MAX_REPLAY_PREFLIGHT_READ_CALLS`, `MAX_INTEGRATION_BLOB_READ_CALLS`,
`MAX_MERGE_APPLY_SCAN_PAGES`, `MAX_MERGE_APPLY_SCAN_ROWS`,
`MAX_MERGE_APPLY_SNAPSHOT_READ_CALLS`, `MAX_MERGE_APPLY_BLOB_READ_CALLS`,
`CHECKOUT_REMOVE_BATCHES`, `ADD_MAX_HASH_RANGE_READS`,
`RM_MAX_HASH_RANGE_READS`, `RM_MAX_HASH_BATCHES`, `MAX_LS_FILES_PATTERNS`,
`MAX_LS_FILES_COMBINED_PATTERNS`, `MAX_LS_FILES_SCAN_ROWS`,
`MAX_LS_FILES_SCAN_PREFIXES`, `MAX_LS_FILES_COMBINED_SCAN_PREFIXES`,
`FULL_STATUS_TRACKER_ROWS`, `INITIAL_TRACKER_ROWS`,
`MAX_SNAPSHOT_DIRTY_ROWS`, and `DIFF_INDEX_WORKTREE_MAX_SCAN_ROWS`. The audit
also follows their non-constant propagation
through integration/read-call, hash-guard, and pathspec limit objects. Their
runtime sites and benchmark ownership are included in the 48-row grouped ledger
below. Batching page size, real retained/cardinality limits, progress/corruption
checks, and memory-derived SQL headroom were inspected but not relabelled as
query admission.

### Statement-barrier removal ledger

The focused witness is deliberately distinct from the representative benchmark
row. It proves that the former first excess reaches its protocol, structural, or
successful outcome. The benchmark row owns normal operation cost.

| Source site | Old runtime behavior | Focused removal witness | Representative benchmark row | Removal WU |
|---|---|---|---|---|
| `src/core/ops/transport-budget.ts:83,91,101-102,114` | Shared transport `chargeSql`, `admitSql`, `reserveSql`, and `chargeReservedSql` threw `E2BIG` when the invented currency was exhausted. | `tests/refspec.test.ts` and transport fetch/push former-first-excess calls complete without a statement-budget error; retained-memory pressure still fails. | `transport.discovery`, `transport.fetch`, `transport.push` | WU3 |
| `src/core/ops/push-plan.ts:665-669` | Push projection threw `E2BIG` above 1,000 projected statements. | `tests/push-refspec.test.ts` over-former-budget push reaches pack/protocol or structural outcome with unchanged CAS state. | `transport.push` | WU3 |
| `src/core/ops/merge-base.ts:265-267` | Caller `maxSqlStatements` rejected merge-base with `E2BIG` before graph traversal. | `tests/merge-base.test.ts` former first excess returns the same base and ahead/behind result as the unbounded call. | `merge-base.select` | WU2 |
| `src/core/ops/rebase-lifecycle.ts:212-215` | Rebase transition model threw `E2BIG` at 1,000 projected statements. | `tests/rebase-restart.test.ts` former transition 1,000 fixture completes or reaches its structural limit with journal/reopen state unchanged. | `rebase.transition` | WU2 |
| `src/core/ops/replay-lifecycle.ts:190-193` | Replay transition model threw `E2BIG` at 1,000 projected statements. | `tests/replay.test.ts` former transition first excess preserves Git-equivalent result and restart state. | `replay.recovery` | WU2 |
| `src/core/ops/replay.ts:248-276` | Replay preflight threw `E2BIG` after eight object-read calls, a value derived from the obsolete 32 MiB cumulative source-byte cap and then converted back to projected SQL. | `tests/replay.test.ts` source set requiring the former ninth read authenticates every commit and produces the same plan; current object-batch memory and structural step limits remain. | `replay.preflight` | WU2 |
| `src/core/ops/integration.ts:30,412-416,922-926` | Integration limits admitted only 16 blob-read batches because each call was multiplied into the SQL model. | `tests/integration.test.ts` former 17th read produces the same exact integration plan; current batch memory, source-row, and entry owners remain. | `merge.apply`, `merge.virtual-base` | WU2 |
| `src/core/ops/merge.ts:303-310` | Recursive virtual-base synthesis threw `E2BIG` when its accumulated SQL model reached 1,000. | `tests/integration-virtual-base.test.ts` over-former-budget recursive base produces the same virtual tree or its graph/memory failure. | `merge.virtual-base` | WU2 |
| `src/core/ops/merge.ts:422-425` | Merge recovery threw `E2BIG` when the recovery projection plus tail reached 1,000. | `tests/merge-lifecycle.test.ts` former first excess recovers with identical journal ownership and worktree/index state. | `merge.recovery` | WU2 |
| `src/core/ops/merge-apply.ts:1018-1026` | Merge apply refused when the local share or whole-operation SQL estimate crossed its ceiling. | `tests/merge-apply.test.ts` former recovery statement 1,000 applies and retains identical rollback material. | `merge.apply` | WU2 |
| `src/core/ops/merge-apply.ts:40,480-520` | Worktree snapshots refused the 51st scan page because page count was an operand in the statement model. | `tests/merge-apply.test.ts` former page 51 applies and restores exact index/worktree state; current-page memory and cursor progress remain bounded. | `merge.apply`, `merge.restore` | WU2 |
| `src/core/ops/merge-apply.ts:42,160-166,559-615,672-687` | Snapshot preflight/execution refused the fifth read batch and used the same four-call value as a 16 MiB cumulative snapshot ceiling. | `tests/merge-apply.test.ts` former fifth call and >16 MiB streamed snapshot retain exact journal/rollback state; current batch and operation memory remain bounded. | `merge.apply` | WU2 for read calls; WU6c for cumulative bytes |
| `src/core/ops/merge-apply.ts:43,160-166,672-687,690-724,1284-1339` | Apply and restore refused the ninth authenticated blob batch because read-call count was projected as SQL cost. | `tests/merge-apply.test.ts` former ninth batch applies/restores exact bytes and journal ownership; current object batch, output, and operation memory bounds remain. | `merge.apply`, `merge.restore` | WU2 |
| `src/core/ops/merge-apply.ts:41,532-539` | The index-snapshot path separately rejected row 50,001 under the query-derived scan-row cap. | `tests/merge-apply.test.ts` a 50,001-row snapshot reaches its semantic or retained-memory outcome without a row-count refusal. | `merge.apply` | WU2 |
| `src/core/ops/merge-apply.ts:1425-1431` | Merge restore refused when its projected total reached 1,000. | `tests/merge-apply.test.ts` over-former-budget restore returns the exact pre-operation index/worktree and clears the same state. | `merge.restore` | WU2 |
| `src/sqlite/store.ts:1485-1487` | Fetch publication projection threw `E2BIG` above 1,000 statements before the atomic publication. | `tests/fetch-publication.test.ts` over-former-budget publication commits the expected refs/reflogs/shallow state or rolls back only for an existing CAS/memory fault. | `fetch.publication` | WU3 |
| `src/fs/store/stream-write.ts:146-148` | Atomic redirect streaming threw `EFBIG` after 900 content statements even below the byte limit. | `tests/fs/stream-write.test.ts` former 901st content chunk commits exact bytes; injected failure still rolls back atomically. | `fs.redirect.stream` | WU4 |
| `src/core/ops/checkout.ts:72,736-768` | Checkout removal planning rejected the 17th JSON batch although paths were already retained under the removal/prune memory owner. | `tests/refs.test.ts` and `tests/checkout-sparse.test.ts` former batch 17 removes/prunes exact paths atomically; each current JSON batch stays bounded. | `checkout.remove` | WU4 |
| `src/core/ops/worktree-io.ts:617-710` plus integration/rebase callers | Dirty-path guards rejected the next flushed hash batch or 64 KiB range read under caller literals chosen for the query model. | `tests/integration.test.ts` and `tests/rebase-restart.test.ts` cross the former 11th/6th batch and 65th range read with identical clean/dirty and restart state; candidate/cardinality/memory owners remain. | `worktree.guard` | WU2 shared seam |
| `src/core/ops/refs.ts:437-442,755-793` plus integration/rebase callers | Checkout guards rejected the next hash batch or range read under caller literals of 1/5 batches and 30/64 reads. | `tests/integration.test.ts` and `tests/rebase-restart.test.ts` cross each former caller threshold with the same tracked/untracked blocker result. | `worktree.guard`, `rebase.transition` | WU2 shared seam |
| `src/core/ops/staging.ts:67,1153-1172` | Add refused the 65th streamed file range read even though only one 64 KiB chunk was live. | `tests/staging.test.ts` former 65th read writes the exact blob/index OID and preserves atomic failure behavior. | `staging.add` | WU4 |
| `src/core/ops/staging.ts:1267-1268,1448-1463` | Rm grouped cumulative hash batches/range reads with real candidate/cardinality checks and refused the 17th batch or 65th read. | `tests/staging.test.ts` crosses both former work totals with the same Git-equivalent safety/removal result; retained candidate ownership remains. | `staging.rm` | WU4 |
| `src/sqlite/schema.ts:1037-1039` | The initialization wrapper threw `E2BIG` after 999 emitted statements. | Source/API audit removes the wrapper; `tests/schema.test.ts` proves fresh init, exact reopen, version mismatch, and corrupt-schema outcomes. | `schema.init` | WU4 |
| `src/sqlite/maintenance/repack.ts:424-430` | Candidate selection threw `E2BIG` when one object could not fit its projected 900-statement batch. | `tests/maintenance-repack.test.ts` former single-object excess makes restartable progress without changing publication or recovery ownership. | `maintenance.repack.select` | WU4 |
| `src/sqlite/packs.ts:2801-2805` | Fallback membership audit threw `E2BIG` after 32 SQL pages even though object cardinality and retained state remained valid. | `tests/pack.test.ts` audit requiring the former 33rd page completes with identical authenticated membership; object/cardinality/memory first excess still fails. | `pack.fallback-audit` | WU4 |
| `src/sqlite/packs.ts:207-220` | Packed authentication/read projected uncached row reads and threw `E2BIG` above maintenance 180 or generic 900, values explicitly chosen to leave room below 1,000 statements. | `tests/pack.test.ts` former 181st/901st uncached read authenticates the same object graph; compressed-size/delta/memory first excess remains. | `pack.uncached-auth`, `pack.uncached-read` | WU4 |
| `src/core/ignore/index.ts:153-162` | Ignore discovery threw `IgnoreLimitError(E2BIG)` before the ninth SQL page. | `tests/ignore.test.ts` discovery requiring the former ninth page loads identical patterns and matching results; file/pattern/retained-memory bounds remain. | `ignore.load` | WU4 |
| `src/core/ignore/index.ts:165-170` | Ignore loading threw `IgnoreLimitError(E2BIG)` before the ninth bulk-read statement. | `tests/ignore.test.ts` former ninth read loads exact rules and match results; raw/file/compiled-memory bounds remain. | `ignore.load` | WU4 |
| `src/core/ops/pathspec.ts:6-25,218-220,278-301` | Public pathspec limits rejected pattern/prefix counts whose maxima were chosen to keep index-page statements below 1,000. | `tests/pathspec.test.ts` former 257th pattern/513th prefix, and combined 65th/129th cases, retain exact Git matching subject only to real parser/memory work. | `ls-files.cached`, `ls-files.combined` | WU4 |
| `src/core/ops/pathspec.ts:12,89-101,278-301` | `CompiledReadPathspec.collect()` rejected valid source row 100,001 under the query-derived scan cap. | `tests/pathspec.test.ts` former row 100,001 produces the exact selected output or real matcher/result-memory failure. | `ls-files.cached`, `ls-files.combined` | WU4 |
| `src/core/ops/staging.ts:101,1788-1801` | Combined `ls-files` rejected compiled prefix 129 because it was part of the 700-statement model. | `tests/staging.test.ts` former prefix 129 returns exact combined cached/untracked/ignored output. | `ls-files.combined` | WU4 |
| `src/core/ops/staging.ts:1892-1907` | Cached/combined index traversal rejected valid row 100,001 under propagated `maxScanRows`. | `tests/staging.test.ts` former index row 100,001 is streamed and selected exactly; result memory remains bounded. | `ls-files.cached`, `ls-files.combined` | WU4 |
| `src/core/ops/staging.ts:1910-1924` | Combined index/worktree merge rejected valid row 100,001 under the same query-derived cap. | `tests/staging.test.ts` former merged row 100,001 returns exact byte-ordered output or real result-memory failure. | `ls-files.combined` | WU4 |
| `src/core/ops/diff.ts:55,1048-1057` | Index/worktree diff rejected scan row 100,001; its source comment defines the cap as 100 SQL pages plus a terminal/first-excess query. | `tests/git-cli-read.test.ts:675-709` flips the existing 100,001st-row `E2BIG` witness to a successful empty diff while retaining output/renderer memory limits. | `diff.index-worktree` | WU4 |
| `src/sqlite/index-tracker.ts:464-508` | Dirty-row traversal treated the 32,001st valid derived row as corruption because 32 pages were chosen below the old statement gate. | `tests/index-tracker.test.ts` former first excess streams ordered rows and preserves tracker availability; malformed/unordered/page-memory failures remain. | `index-tracker.dirty` | WU4 |
| `src/sqlite/index-tracker.ts:464-466` | Dirty-row traversal also threw after 512 pages regardless of valid row count; with public `pageRows: 1`, row 513 failed. | `tests/index-tracker.test.ts` 513 valid one-row pages stream in order and remain available; cursor non-progress/malformed rows still fail. | `index-tracker.dirty` | WU4 |
| `src/sqlite/index-tracker.ts:650-660` | Tracker reseal treated the 32,001st valid input row as corruption for the same query-derived cap. | `tests/index-tracker.test.ts` former first excess reseals/reopens with exact flags and root epoch; malformed rows and real engine failures remain atomic. | `index-tracker.reseal` | WU4 |
| `src/core/ops/status-sparse.ts:43,108-127` | Full-status tracker silently became unavailable at row 32,001 because it copied the query-derived dirty-row cap. | `tests/status-sparse.test.ts` former row 32,001 keeps the tracker available when actual retained headroom permits and returns exact status. | `status.full`, `index-tracker.dirty` | WU4 |
| `src/core/ops/initial-checkout.ts:15,106-128` | Initial checkout silently discarded its tracker seed at row 32,001 even when the retained-byte owner had headroom. | `tests/checkout-initial.test.ts` former row 32,001 publishes/reopens the exact seed when actual retained headroom permits. | `checkout.initial`, `index-tracker.reseal` | WU4 |
| `src/sqlite/sparse-workspace.ts:43,2518-2521,2587-2592` | Sparse commit snapshot queried at most 32,001 dirty rows and silently became unavailable above the query-derived 32,000 cap. | `tests/sparse-workspace.test.ts` former row 32,001 remains on the sparse path when its reservation has headroom and produces the exact tree snapshot. | `commit.sparse`, `index-tracker.dirty` | WU4 |
| `src/core/ops/sparse-checkout.ts:696-700` | A projected prune count silently abandoned the selected sparse plan and fell back to the general checkout path. | `tests/checkout-sparse.test.ts` over-former-budget selected plan remains selected and produces the same sparse index/worktree. | `sparse.prune` | WU4 |
| `src/core/ops/integration.ts:36-38` | Module load threw if the ordinary integration SQL model reached 1,000. | Source audit removes the assertion; focused integration tests load and execute the same structural first-excess cases. | `merge.apply` | WU2 |
| `src/core/ops/integration.ts:43-45` | Module load threw if the virtual-ancestor model reached 1,000. | Source audit removes the assertion; virtual-base correctness and memory first-excess tests remain. | `merge.virtual-base` | WU2 |
| `src/core/ops/rebase-plan.ts:27-29` | Module load threw if the rebase-plan constant reached 1,000. | Source audit removes the assertion; `tests/rebase-plan.test.ts` retains plan correctness, graph, and memory bounds. | `rebase.plan` | WU2 |
| `src/core/ops/merge-apply.ts:56-58` | Module load threw if the merge-apply projection reached 1,000. | Source audit removes the assertion; `tests/merge-apply.test.ts` retains apply/restore state witnesses. | `merge.apply` | WU2 |
| `src/core/ops/pathspec.ts:24-26` | Module load threw if the index-scan projection exceeded the `ls-files` ceiling. | Source audit removes the assertion; `tests/pathspec.test.ts` retains cached selection and pathspec correctness. | `ls-files.cached` | WU4 |
| `src/core/ops/staging.ts:111-113` | Module load pinned the cached `ls-files` model to exactly 903 statements. | Source audit removes the assertion; cached tracked-file result remains byte-for-byte identical. | `ls-files.cached` | WU4 |
| `src/core/ops/staging.ts:114-116` | Module load pinned the combined `ls-files` model to exactly 700 statements. | Source audit removes the assertion; combined tracked/untracked/ignored result remains byte-for-byte identical. | `ls-files.combined` | WU4 |

`RefMutationBudget.requireSqlHeadroom()` is excluded from this ledger. Despite
its name, it reserves retained bytes for SQLite mutation work and does not admit
or reject from a projected statement count.

### Byte-limit inventory and proposed action

Lines and expressions refer to `6dac935`; `source + symbol` is the stable key.
`kind` distinguishes `format`, `platform-binding`, `schema`,
`retained-memory`, `structural`, `algorithmic`, `work-counter`, `batching`, and
`heuristic`. `evidence` distinguishes a platform contract, a complete aggregate
model, boundary tests only, source-level streaming/batching proof, or no value
evidence. A boundary test proves enforcement, not that the chosen number is
correct. The decision is intentionally non-pending on every row: `keep`,
`remove`, `replace`, or `dedupe`. WU6 may implement only these reviewed actions.

```tsv
source	symbol	line	expression	bytes	kind	owner	failure	evidence	rationale	evidence_ref	decision
src/core/ops/config.ts	MAX_REMOTE_NAME_BYTES	12	2_189	2189	structural	remote config name	E2BIG	test-only	Boundary coverage proves enforcement, but 2,189 has no format or allocation derivation.	tests/client.test.ts:824	replace
src/core/ops/config.ts	MAX_REMOTE_URL_BYTES	13	8_192	8192	structural	remote URL value	E2BIG	test-only	Boundary coverage proves enforcement, but 8 KiB is not derived from storage or retained copies.	tests/client.test.ts:779-800	replace
src/core/ops/diff.ts	DIFF_MAX_OUTPUT_BYTES	57	16 * MIB	16777216	retained-memory	rendered diff output	E2BIG	aggregate-model	The final output is live and is charged inside the explicit 64 MiB combined renderer model.	tests/git-cli-read.test.ts:593-670	keep
src/core/ops/diff.ts	DIFF_COMBINED_MAX_MEMORY_BYTES	59	64 * MIB	67108864	retained-memory	combined diff renderer	E2BIG	aggregate-model	The estimator covers coexisting records, rendered output, and source state with a first-excess witness.	tests/git-cli-read.test.ts:641-670	keep
src/core/ops/integration-structure.ts	MAX_INTEGRATION_STRUCTURE_BYTES	13	16 * 1024 * 1024	16777216	retained-memory	integration structural plan	E2BIG	test-only	The plan is retained, but the standalone 16 MiB value has no coexistence equation or measurement.	src/core/ops/integration-structure.ts:20-77	replace
src/core/ops/integration-worktree.ts	MAX_INTEGRATION_INDEX_PATH_BYTES	27	MAX_TREE_BUILD_TOTAL_PATH_BYTES	4194304	retained-memory	integration index path copies	E2BIG	test-only	This aliases an arbitrary tree-build aggregate instead of charging the owning operation reservation.	src/core/ops/integration-worktree.ts:103-133	dedupe
src/core/ops/integration-worktree.ts	MAX_INTEGRATION_SERIALIZED_TREE_BYTES	29	MAX_TREE_BUILD_SERIALIZED_BYTES	16777216	retained-memory	serialized integration trees	E2BIG	test-only	This aliases an arbitrary tree serialization ceiling instead of one operation aggregate.	src/core/ops/integration-worktree.ts:135-163	dedupe
src/core/ops/integration-worktree.ts	MAX_GUARD_HASH_BYTES	34	32 * 1024 * 1024	33554432	work-counter	guard hashing total	E2BIG	source-proof	Large files hash in 64 KiB range chunks and small files use bounded readFiles batches; cumulative file sizes are not simultaneously retained.	src/core/ops/integration-worktree.ts:38-52,214-246;src/core/ops/worktree-io.ts:461-524,680-721	remove
src/core/ops/integration.ts	MAX_INTEGRATION_STRUCTURE_BYTES	28	4 * 1024 * 1024	4194304	retained-memory	integration intermediate structures	E2BIG	test-only	The intermediate is retained, but the second same-named cap has no complete operation equation.	tests/integration-structure.test.ts	replace
src/core/ops/integration.ts	MAX_INTEGRATION_PLAN_BYTES	29	32 * 1024 * 1024	33554432	retained-memory	integration content plan	E2BIG	test-only	Plan content is live, but the standalone cap is not charged to the shared operation owner.	tests/integration.test.ts:73-129	replace
src/core/ops/ls-remote.ts	MAX_LS_REMOTE_PATTERN_BYTES	14	MAX_REF_NAME_BYTES	1024	structural	remote ref pattern	E2BIG	test-only	The alias repeats the unproved ref-name ceiling and should follow one authoritative ref grammar limit.	tests/ls-remote.test.ts:263-311	dedupe
src/core/ops/merge-apply.ts	MAX_MERGE_APPLY_CONTENT_BYTES	44	32 * 1024 * 1024	33554432	retained-memory	merge apply content buffers	E2BIG	test-only	Content is retained during apply, but 32 MiB is not a complete coexistence equation.	tests/merge-apply.test.ts	replace
src/core/ops/merge-base.ts	MAX_MERGE_BASE_RETAINED_BYTES	10	MAX_LOG_STATE_BYTES	33554432	retained-memory	merge-base graph maps and heap	E2BIG	test-only	The alias borrows a log-state value although graph ownership differs and no aggregate proof follows.	tests/divergence.test.ts:327-328	dedupe
src/core/ops/merge-state.ts	MAX_MERGE_STATE_BYTES	8	4 * 1024 * 1024	4194304	retained-memory	merge journal state	E2BIG	test-only	The journal is retained and validated, but the total cap lacks a full field-and-object coexistence equation.	tests/operation-state.test.ts:500-540	replace
src/core/ops/merge-state.ts	MAX_MERGE_PATH_BYTES	9	2_200	2200	structural	merge journal path	E2BIG	test-only	The path bound is one of conflicting 2,200/4,096/8,192 domain limits.	src/sqlite/store.ts:8028-8031	replace
src/core/ops/merge-state.ts	MAX_MERGE_REF_BYTES	10	1_024	1024	structural	merge journal ref	E2BIG	test-only	The ref field repeats the arbitrary 1,024-byte family and should use the authoritative ref limit.	src/sqlite/store.ts:7878	dedupe
src/core/ops/merge-state.ts	MAX_MERGE_LABEL_BYTES	11	256	256	structural	merge labels	E2BIG	test-only	Labels are copied into the journal, but 256 has no structural or aggregate derivation.	src/sqlite/store.ts:7917-7920	replace
src/core/ops/merge-state.ts	MAX_MERGE_IDENTITY_BYTES	12	1_024	1024	structural	merge author and committer fields	E2BIG	test-only	The identity field duplicates other 1,024-byte limits without one owner.	src/sqlite/store.ts:7927-7939	dedupe
src/core/ops/merge-state.ts	MAX_MERGE_MESSAGE_BYTES	13	1024 * 1024	1048576	structural	merge journal message	E2BIG	test-only	The message ceiling is repeated by plumbing and CLI without a shared aggregate contract.	tests/merge-state.test.ts:250-337	replace
src/core/ops/pathspec.ts	MAX_LS_FILES_PATTERN_BYTES	9	2_200	2200	structural	one ls-files pathspec	E2BIG	test-only	The value copies one Git-path cap but pathspec syntax and aggregate parser ownership differ.	tests/pathspec.test.ts	replace
src/core/ops/pathspec.ts	MAX_LS_FILES_INPUT_BYTES	10	64 * 1024	65536	retained-memory	all ls-files pathspec input	E2BIG	test-only	Input strings are retained, but the standalone total is not charged to the invocation aggregate.	tests/pathspec.test.ts	replace
src/core/ops/pathspec.ts	MAX_LS_FILES_RETAINED_BYTES	14	16 * 1024 * 1024	16777216	retained-memory	ls-files output and dedupe state	E2BIG	test-only	The output and dedupe set are live, but 16 MiB has no aggregate coexistence proof.	tests/pathspec.test.ts:726-781	replace
src/core/ops/plumbing.ts	READ_TREE_MAX_WRITE_BYTES	32	64 * 1024 * 1024	67108864	work-counter	read-tree checkout writes	E2BIG	source-proof	Checkout reads at most a 3 MiB blob batch and flushes each worktree/index batch; cumulative published bytes are not retained together.	src/core/ops/plumbing.ts:95-115;src/core/ops/checkout-writes.ts:19-78	remove
src/core/ops/plumbing.ts	MAX_COMMIT_TREE_MESSAGE_BYTES	36	MAX_MERGE_MESSAGE_BYTES	1048576	structural	commit-tree message	E2BIG	test-only	This is a direct alias of the duplicated merge-message policy.	tests/plumbing-write.test.ts:660-666	dedupe
src/core/ops/plumbing.ts	MAX_COMMIT_TREE_INPUT_BYTES	37	MAX_INDEXED_COMMIT_BYTES	1048576	structural	commit-tree serialized input	E2BIG	test-only	This aliases a cache/parser eligibility threshold rather than an invocation allocation owner.	tests/plumbing-write.test.ts:666	dedupe
src/core/ops/pull.ts	MAX_PULL_REF_BYTES	16	1_024	1024	structural	pull ref input	E2BIG	test-only	The value repeats the ref-name family and should use its authoritative owner.	src/core/ops/pull.ts	dedupe
src/core/ops/pull.ts	MAX_PULL_REMOTE_BYTES	17	255	255	structural	pull remote input	E2BIG	test-only	The value duplicates remote-name policy with a different unexplained ceiling.	src/core/ops/pull.ts	dedupe
src/core/ops/pull.ts	MAX_PULL_URL_BYTES	18	8_192	8192	structural	pull URL input	E2BIG	test-only	The value duplicates remote URL policy and should share one owner.	src/core/ops/pull.ts	dedupe
src/core/ops/pull.ts	MAX_PULL_FETCH_REFSPEC_BYTES	19	2_048	2048	retained-memory	pull fetch refspec text	E2BIG	test-only	The parsed input is copied, but 2 KiB is not derived from the invocation aggregate.	src/core/ops/pull.ts	replace
src/core/ops/push-plan.ts	MAX_PUSH_PLAN_BYTES	24	16 * 1024 * 1024	16777216	retained-memory	outbound push graph	E2BIG	test-only	The graph is retained, but its cap is separate from the already shared operation reservation.	tests/push-refspec.test.ts:831-865	replace
src/core/ops/reads.ts	MAX_LS_TREE_RETAINED_BYTES	42	16 * 1024 * 1024	16777216	retained-memory	recursive ls-tree output	E2BIG	test-only	Rows and output are live, but the chosen total lacks a coexistence equation.	tests/reads.test.ts:536-551	replace
src/core/ops/rebase-lifecycle.ts	REBASE_BASELINE_MAX_BYTES	60	32 * 1024 * 1024	33554432	work-counter	rebase baseline blob work	E2BIG	source-proof	Baseline blobs are streamed and the total also feeds the obsolete statement projection.	src/core/ops/rebase-lifecycle.ts:190-210	remove
src/core/ops/ref-log.ts	MAX_IDENTITY_BYTES	14	1_024	1024	structural	reflog actor input	E2BIG	test-only	This duplicates the reflog schema identity limit.	src/core/ops/ref-log.ts	dedupe
src/core/ops/refspec.ts	MAX_REFSPEC_REF_BYTES	10	MAX_REF_NAME_BYTES	1024	structural	refspec source and destination	E2BIG	test-only	This aliases the ref-name ceiling and should not create another owner.	tests/refspec.test.ts:187-201,345-359	dedupe
src/core/ops/rename-detection.ts	MAX_EXACT_RENAME_RETAINED_BYTES	9	16 * 1024 * 1024	16777216	heuristic	exact-rename maps	fallback	test-only	Crossing the threshold falls back to non-exact detection and does not refuse the operation.	src/core/ops/rename-detection.ts	keep
src/core/ops/rename-detection.ts	MAX_RENAME_PATH_BYTES	10	2_200	2200	structural	rename candidate path	E2BIG	test-only	The path value duplicates other Git-path limits.	src/core/ops/rename-detection.ts	dedupe
src/core/ops/replay.ts	MAX_REPLAY_PREFLIGHT_BYTES	37	32 * 1024 * 1024	33554432	retained-memory	replay preflight content	E2BIG	test-only	Preflight retains content, but the cap is not charged to the operation aggregate.	tests/replay.test.ts	replace
src/core/ops/replay.ts	MAX_REPLAY_PLAN_METADATA_BYTES	40	8 * 1024 * 1024	8388608	retained-memory	replay plan metadata	E2BIG	test-only	Metadata remains live through replay, but 8 MiB has no complete journal equation.	tests/replay.test.ts	replace
src/core/ops/staging.ts	ADD_MAX_HASH_BYTES	66	64 * 1024 * 1024	67108864	work-counter	add streamed hashing total	E2BIG	source-proof	File content is hashed incrementally; cumulative bytes are work rather than live memory.	src/core/ops/staging.ts:1160-1230	remove
src/core/ops/staging.ts	MAX_LS_FILES_EXCLUDE_ROOT_UTF8_BYTES	107	MAX_ROUTING_ROOTS_UTF8_BYTES	6291456	retained-memory	ls-files excluded roots	E2BIG	aggregate-model	This direct alias belongs to the routing/discovery aggregate model.	tests/pathspec.test.ts:612	dedupe
src/core/ops/staging.ts	RM_MAX_PATH_BYTES	1264	2_200	2200	structural	rm path input	E2BIG	test-only	The value is another independent Git-path ceiling.	src/core/ops/staging.ts	dedupe
src/core/ops/staging.ts	RM_MAX_HASH_BYTES	1266	32 * 1024 * 1024	33554432	work-counter	rm guard hashing total	E2BIG	source-proof	Guard hashing uses 64 KiB range chunks or bounded small-file batches; cumulative candidate sizes do not coexist.	src/core/ops/staging.ts:1421-1463;src/core/ops/worktree-io.ts:461-524,583-606	remove
src/core/ops/status-format.ts	STATUS_FORMAT_MAX_RETAINED_BYTES	14	16 * 1024 * 1024	16777216	retained-memory	status records and strings	E2BIG	aggregate-model	The formatter accounts retained records before final output and has exact/first-excess witnesses.	tests/status-format.test.ts:166-202	keep
src/core/ops/status-format.ts	STATUS_FORMAT_MAX_OUTPUT_BYTES	15	16 * 1024 * 1024	16777216	retained-memory	formatted status output	E2BIG	aggregate-model	The final contiguous output is charged alongside retained records.	tests/status-format.test.ts:166-202	keep
src/core/ops/transport-budget.ts	MAX_TRANSPORT_MEMORY_BYTES	4	MAX_OPERATION_MEMORY_BYTES	67108864	retained-memory	transport operation reservation	E2BIG	aggregate-model	This is the transport alias of the central coordinator proven at exact and first excess.	tests/refspec.test.ts:368-376	dedupe
src/core/ops/tree-build.ts	MAX_TREE_BUILD_PATH_BYTES	23	2_200	2200	structural	one tree-build path	E2BIG	test-only	The value is one of several independent Git-path limits.	tests/tree-build-preflight.test.ts:99	replace
src/core/ops/tree-build.ts	MAX_TREE_BUILD_TOTAL_PATH_BYTES	25	4 * 1024 * 1024	4194304	retained-memory	all tree-build path copies	E2BIG	test-only	All paths are retained, but the standalone cap lacks an owning operation equation.	tests/plumbing-write.test.ts:375	replace
src/core/ops/tree-build.ts	MAX_TREE_BUILD_SERIALIZED_BYTES	27	16 * 1024 * 1024	16777216	retained-memory	serialized tree objects	E2BIG	test-only	Serialized buffers are live, but the cap is not charged to the shared operation reservation.	src/core/ops/tree-build.ts	replace
src/core/ops/tree-build.ts	MAX_SPARSE_TREE_RETAINED_BYTES	33	8 * 1024 * 1024	8388608	heuristic	sparse tree snapshot	fallback	test-only	Crossing the cap falls back, but the threshold should derive from the owning reservation rather than standalone policy.	src/core/ops/tree-build.ts	replace
src/core/ops/tree-build.ts	MAX_SPARSE_TREE_PLAN_BYTES	34	16 * 1024 * 1024	16777216	heuristic	sparse tree plan	fallback	test-only	The fallback is valid, but its independent value lacks a coexistence equation.	src/core/ops/tree-build.ts	replace
src/core/ops/worktree-io.ts	MAX_COMPILED_PATHSPEC_BYTES	39	1024 * 1024	1048576	platform-binding	compiled pathspec SQL request	E2BIG	unclear	The request enters SQL, but 1 MiB is not derived from the actual binding/framing equation.	tests/worktree.test.ts:562-563	replace
src/core/pack/delta.ts	MAX_DELTA_WORKING_BYTES	8	48 * 1024 * 1024	50331648	retained-memory	delta base and target pool	corrupt	aggregate-model	The allocator charges live base/target bytes and rejects the first byte that would exceed the pool.	tests/delta.test.ts:191-201	keep
src/core/pack/delta.ts	MAX_DELTA_INSTRUCTION_BYTES	9	48 * 1024 * 1024	50331648	algorithmic	delta instruction interpreter	corrupt	aggregate-model	The interpreter bounds its instruction stream before allocation and before applying it to the separately bounded target pool.	src/core/pack/delta.ts:35-87	keep
src/core/protocol/receive-pack.ts	MAX_PUSH_OPTION_BYTES	21	1_024	1024	structural	one push option	E2BIG	test-only	The parser enforces the field size, but 1 KiB has no wire-format derivation.	tests/receive-pack.test.ts:213-221,364-388	replace
src/core/protocol/receive-pack.ts	MAX_PUSH_OPTIONS_BYTES	22	64 * 1_024	65536	retained-memory	all push options	E2BIG	test-only	Options are copied, but the standalone total should charge the protocol aggregate.	tests/receive-pack.test.ts:213-221	replace
src/core/protocol/receive-pack.ts	MAX_RECEIVE_PACK_STATUS_INPUT_BYTES	24	16 * 1024 * 1024	16777216	retained-memory	receive-pack status input	E2BIG	test-only	Status frames are retained during parse, but the cap lacks a complete protocol equation.	src/core/protocol/receive-pack.ts	replace
src/core/protocol/receive-pack.ts	MAX_RECEIVE_PACK_RESULT_BYTES	25	8 * 1024 * 1024	8388608	retained-memory	receive-pack result maps and strings	E2BIG	test-only	Result state is retained, but the independent cap is not charged to the protocol owner.	src/core/protocol/receive-pack.ts	replace
src/core/protocol/remote.ts	MAX_PROTOCOL_RETAINED_BYTES	42	4 * 1024 * 1024	4194304	retained-memory	remote refs capabilities and boundaries	E2BIG	test-only	The state is live, but the 4 MiB sub-cap is not derived from the root operation reservation.	tests/protocol.test.ts:571	replace
src/core/protocol/remote.ts	MAX_PROTOCOL_NEGOTIATION_INPUT_BYTES	43	16 * 1024 * 1024	16777216	retained-memory	negotiation input frames	E2BIG	test-only	Negotiation data is retained, but its cap lacks a full request/response coexistence equation.	tests/protocol.test.ts:872-883	replace
src/core/protocol/remote.ts	MAX_PROTOCOL_TEXT_BYTES	45	MAX_PKT_FRAME_BYTES - 4	65516	format	pkt-line text payload	corrupt	platform	The four-byte pkt-line header leaves exactly this Git protocol payload.	src/core/protocol/stream.ts:89-112	keep
src/core/protocol/stream.ts	MAX_PROTOCOL_SOURCE_CHUNK_BYTES	13	1024 * 1024	1048576	work-counter	caller-provided protocol chunk	E2BIG	test-only	A large source chunk can be sliced internally; its size is not the operation's live high-water.	tests/protocol.test.ts:104-120	remove
src/core/protocol/stream.ts	MAX_PKT_FRAME_BYTES	16	65_520	65520	format	Git pkt-line frame	corrupt	platform	Pkt-line length is encoded in four hexadecimal bytes and the implementation validates the wire frame.	tests/protocol.test.ts:109-113	keep
src/core/ref-name.ts	MAX_REF_NAME_BYTES	1	1_024	1024	structural	Git ref text domain	E2BIG	test-only	This is the current common owner, but 1,024 is not derived from the grammar, storage, or pkt frame.	tests/refspec.test.ts:187-201	replace
src/fs/exact-path-states.ts	MAX_PATH_BYTES	13	4_096	4096	structural	filesystem exact path	E2BIG	test-only	The module has an independent 4 KiB path policy that should share the filesystem path owner.	src/fs/exact-path-states.ts:41-45	replace
src/fs/exact-path-states.ts	MAX_JSON_BYTES	14	1_500_000	1500000	batching	exact-path json_each page	none	platform	The non-refusing threshold segments escaped JSON below the documented 2 MB support boundary.	src/fs/exact-path-states.ts:113	keep
src/fs/store/copy.ts	MAX_JSON_BYTES	13	1_500_000	1500000	batching	copy metadata JSON page	none	platform	The threshold is a non-refusing batching size with escaping/framing headroom below the documented support boundary.	src/fs/store/copy.ts:233	keep
src/fs/store/initial-write.ts	MAX_JSON_BYTES	14	1_500_000	1500000	batching	initial metadata and chunk JSON	E2BIG	platform	Batch segmentation is valid, but a single-row refusal must become chunking or an engine-reported SQLite failure.	tests/fs/initial-write.test.ts:198-219	replace
src/fs/store/initial-write.ts	MAX_PAYLOAD_BYTES	15	1024 * 1024	1048576	batching	initial content-id and chunk payload	E2BIG	test-only	The payload enters SQL, but 1 MiB is not a platform limit; larger values need streaming or singleton execution.	src/fs/store/initial-write.ts	replace
src/fs/store/initial-write.ts	MAX_SMALL_FILE_BYTES	16	1024 * 1024	1048576	structural	initial writeFile contiguous input	E2BIG	test-only	A streaming alternative exists and the method cap is not tied to an allocation owner.	tests/fs/initial-write.test.ts	replace
src/fs/store/initial-write.ts	MAX_PATH_BYTES	17	4096	4096	structural	initial checkout path	E2BIG	test-only	This duplicates the filesystem path domain limit.	src/fs/store/initial-write.ts	dedupe
src/fs/store/initial-write.ts	MAX_INITIAL_WORKTREE_SESSION_BYTES	19	4 * 1024 * 1024	4194304	retained-memory	initial-write session copies	E2BIG	test-only	Session-owned copies are real, but the value lacks a complete live-set equation.	tests/fs/initial-write.test.ts:198-219,293-294,532-533	replace
src/fs/store/initial-write.ts	MAX_METADATA_JSON_BYTES	21	128 * 1024	131072	batching	metadata flush and symlink text	E2BIG	test-only	The flush threshold is valid batching; the symlink refusal must become streaming/singleton execution or an engine-reported failure.	src/fs/store/initial-write.ts	replace
src/fs/store/initial-write.ts	MAX_METADATA_ID_BYTES	22	512 * 1024	524288	batching	content-id metadata flush	none	source-proof	Crossing the threshold flushes a batch and does not reject the operation.	src/fs/store/initial-write.ts	keep
src/fs/store/initial-write.ts	MAX_CHUNK_BATCH_BYTES	23	MAX_PAYLOAD_BYTES	1048576	batching	initial chunk payload batch	none	test-only	This is a direct alias of the payload threshold and should not be a second policy owner.	src/fs/store/initial-write.ts	dedupe
src/fs/store/initial-write.ts	MAX_CHUNK_JSON_BYTES	24	128 * 1024	131072	batching	chunk-offset JSON flush	none	source-proof	Crossing the threshold flushes a JSON page; it does not refuse the overall operation.	src/fs/store/initial-write.ts	keep
src/fs/store/read.ts	MAX_HANDLE_MATERIALIZE_BYTES	72	32 * 1024 * 1024	33554432	retained-memory	contiguous handle read output	EFBIG	aggregate-model	The returned allocation is contiguous and its read budget plus chunk headroom remains below 100 MiB.	tests/fs/read.test.ts:623-635	keep
src/fs/store/scan.ts	GLOB_PATTERN_MAX_BYTES	33	50	50	format	Durable Object SQL GLOB pattern	E2BIG	platform	The platform GLOB surface has a fixed pattern-format constraint before query execution.	src/fs/store/scan.ts:33-75	keep
src/fs/store/scan.ts	DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES	37	MAX_ROUTING_ROOTS_UTF8_BYTES	6291456	retained-memory	discovery root strings	E2BIG	aggregate-model	This is the roots term in the explicit discovery retained-memory formula.	tests/fs/scan.test.ts:827-840	dedupe
src/fs/store/scan.ts	DISCOVERY_EXCLUDE_ITEM_JSON_MAX_BYTES	39	DISCOVERY_EXCLUDE_ROOT_CODE_UNITS_MAX * 6 + 2	24578	batching	worst escaped discovery item	none	platform	Six JSON bytes per UTF-16 code unit plus quotes derives batching work; it is not a value ceiling.	src/fs/store/scan.ts:33-75	keep
src/fs/store/scan.ts	DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES	41	DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES * 6 + DISCOVERY_EXCLUDE_ROOTS_MAX * 3 + 2	37773314	batching	unsplit escaped root vector	none	platform	The value is mechanically derived from root bytes, separators, and worst-case escaping for segmentation.	tests/fs/scan.test.ts:827-840	keep
src/fs/store/scan.ts	DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES	43	1_500_000	1500000	batching	discovery JSON SQL segment	none	platform	Segments stay below the documented 2 MB support boundary with escaping/framing headroom.	tests/fs/scan.test.ts:773-840	keep
src/fs/store/scan.ts	DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES	50	DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES + DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS - 1	37773339	work-counter	segmented discovery JSON total	none	platform	The total is retained-memory evidence for the complete segmented request, not a per-binding refusal.	tests/fs/scan.test.ts:827-840	keep
src/fs/store/scan.ts	DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES	56	2 * DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES + 3 * DISCOVERY_EXCLUDE_ROOTS_MAX * DISCOVERY_EXCLUDE_STRING_FIXED_BYTES + DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS * DISCOVERY_EXCLUDE_STRING_FIXED_BYTES + 2 * DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES + 2 * (DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES + DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX * DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES) + DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES + DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS * DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES + DISCOVERY_EXCLUDE_STRING_FIXED_BYTES + 2 * DISCOVERY_EXCLUDE_ITEM_JSON_MAX_BYTES	89491178	retained-memory	all discovery copies and JSON	E2BIG	aggregate-model	The formula names every coexisting string, array, slot, and JSON copy and remains below 100 MiB.	tests/fs/scan.test.ts:827-840	keep
src/fs/store/search.ts	NEEDLE_MAX_BYTES	31	1024	1024	heuristic	SQL search pushdown needle	fallback	source-proof	Longer needles use the general search path; they are not rejected.	src/fs/store/search.ts	keep
src/fs/store/stream-write.ts	MAX_STREAM_BYTES	12	96 * 1024 * 1024	100663296	work-counter	atomic redirect streamed total	EFBIG	source-proof	Chunks are written incrementally inside the transaction, so the cumulative file size is not the live allocation.	src/fs/store/stream-write.ts:133-169	remove
src/fs/store/touch.ts	MAX_JSON_BYTES	11	1_500_000	1500000	batching	touch path JSON page	none	platform	The non-refusing batching target stays below the documented support boundary with JSON headroom.	src/fs/store/touch.ts	keep
src/fs/store/write.ts	MAX_PAYLOAD_BYTES	38	2_000_000	2000000	batching	filesystem SQL BLOB segment	none	platform	The value is a conservative, non-refusing segmentation target at the documented support boundary, not an exact SQLite ceiling.	src/fs/store/write.ts	keep
src/fs/store/write.ts	MAX_JSON_BYTES	45	1_500_000	1500000	batching	filesystem metadata JSON page	none	platform	The non-refusing target leaves framing/escaping headroom below the documented support boundary.	src/fs/store/write.ts	keep
src/git/cli/types.ts	GIT_CLI_MAX_ARGV_BYTES	2	1024 * 1024	1048576	retained-memory	Git CLI argv copies	E2BIG	test-only	Argv is retained, but a component magic number ignores env, stdin, cwd, and parser coexistence.	tests/git-cli.test.ts:239-324	replace
src/git/cli/types.ts	GIT_CLI_MAX_ENV_BYTES	4	1024 * 1024	1048576	retained-memory	Git CLI environment snapshot	E2BIG	test-only	Environment strings coexist with argv and stdin and should charge one invocation reservation.	tests/git-cli.test.ts:239-324	replace
src/git/cli/types.ts	GIT_CLI_MAX_STDIN_BYTES	5	1024 * 1024	1048576	retained-memory	Git CLI stdin copy	E2BIG	test-only	The input allocation coexists with argv/env and should charge the invocation aggregate.	tests/git-cli.test.ts:239-324	replace
src/git/cli/types.ts	GIT_CLI_MAX_CWD_BYTES	6	4 * 1024	4096	structural	Git CLI cwd	E2BIG	test-only	The cwd repeats an independent 4 KiB filesystem path policy.	tests/git-cli.test.ts:248-295	dedupe
src/git/cli/types.ts	GIT_CLI_MAX_COMMIT_MESSAGE_BYTES	7	1024 * 1024	1048576	structural	Git CLI commit message	E2BIG	test-only	The value duplicates merge and plumbing message ceilings.	tests/git-cli.test.ts:303-324	dedupe
src/git/cli/types.ts	GIT_CLI_MAX_LOG_FORMAT_BYTES	8	64 * 1024	65536	retained-memory	Git log format parser input	E2BIG	test-only	The parsed template is retained, but the component cap lacks an invocation/parser equation.	tests/git-cli.test.ts:309-324	replace
src/git/cli/types.ts	GIT_CLI_MAX_STDOUT_BYTES	10	16 * 1024 * 1024	16777216	retained-memory	Git CLI stdout	E2BIG	test-only	Stdout is part of the combined output allocation and should not own a second independent ceiling.	tests/git-cli.test.ts:493-527	replace
src/git/cli/types.ts	GIT_CLI_MAX_STDERR_BYTES	11	1024 * 1024	1048576	retained-memory	Git CLI stderr	E2BIG	test-only	Stderr is part of the combined output allocation and should not own a component magic number.	tests/git-cli.test.ts:493-527	replace
src/git/cli/types.ts	GIT_CLI_MAX_COMBINED_OUTPUT_BYTES	12	16 * 1024 * 1024	16777216	retained-memory	Git CLI combined output	E2BIG	aggregate-model	The runner charges stdout and stderr to one combined contiguous-output owner with boundary tests.	tests/git-cli.test.ts:493-527	keep
src/shell/exec/execute.ts	ARGUMENT_BYTES_MAX	26	1_000_000	1000000	retained-memory	expanded shell argv	E2BIG	test-only	Expanded arguments coexist with stdin/env and should charge the run-owned reservation.	src/shell/exec/execute.ts:600-620	replace
src/shell/exec/execute.ts	STDIN_BYTES_MAX	27	1024 * 1024	1048576	retained-memory	shell caller stdin copy	E2BIG	test-only	Stdin is retained for the run but the component cap ignores env and argv coexistence.	tests/shell/run-inputs.test.ts:171-216	replace
src/shell/exec/execute.ts	ENV_BYTES_MAX	29	1024 * 1024	1048576	retained-memory	shell caller environment snapshot	E2BIG	test-only	Environment strings are retained with stdin/argv and should charge the same run owner.	tests/shell/run-inputs.test.ts:293-317	replace
src/shell/exec/execute.ts	ATOMIC_REDIRECT_BYTES_MAX	32	96 * 1024 * 1024	100663296	work-counter	shell atomic redirect total	EFBIG	source-proof	This aliases the streamed filesystem total that does not represent live retained memory.	src/shell/exec/execute.ts:470-476	remove
src/sqlite/blob-id-cache.ts	MAX_CACHED_CONTENT_ID_BYTES	2	256	256	schema	one persisted and cached content id	corrupt	test-only	The row/cache field is validated, but 256 has no content-id format or schema derivation.	tests/store.test.ts:655-685	replace
src/sqlite/blob-id-cache.ts	MAX_BLOB_ID_CACHE_CONTENT_BYTES	3	MAX_BLOB_ID_CACHE_ROWS * MAX_CACHED_CONTENT_ID_BYTES	16777216	retained-memory	blob-id cache content bytes	E2BIG	test-only	The total is derived from row count and field cap, but not charged to a cache memory owner.	tests/store.test.ts:655-685	replace
src/sqlite/commits.ts	MAX_INDEXED_COMMIT_BYTES	6	1024 * 1024	1048576	structural	commit parser and cache source	corrupt	test-only	Boundary tests cover cache eligibility and corrupt rows, but 1 MiB is not a Git object-format limit.	tests/commit-cache.test.ts:188-191,350	replace
src/sqlite/commits.ts	MAX_COMMIT_CACHE_BYTES	7	4 * 1024 * 1024	4194304	retained-memory	staged commit-cache batch	corrupt	test-only	The cache batch is retained, but the value lacks a complete cache-plus-parser allocation equation.	tests/commit-cache.test.ts:188-191	replace
src/sqlite/commits.ts	MAX_LOG_STATE_BYTES	9	32 * 1024 * 1024	33554432	retained-memory	log graph rows maps and heap	E2BIG	test-only	Graph state is retained, but the cap is reused by unrelated owners without a coexistence model.	tests/commit-cache.test.ts:553	replace
src/sqlite/index-tracker.ts	MAX_PAGE_BYTES	25	1024 * 1024	1048576	platform-binding	index-tracker JSON page	corrupt	platform	The page segments JSON with binding headroom and validates persisted page size.	src/sqlite/index-tracker.ts:352,660-663	keep
src/sqlite/index-tracker.ts	MAX_PATH_BYTES	26	2_200	2200	schema	persisted index-tracker path	corrupt	test-only	The untrusted row check is required, but the independent 2,200 value must follow one Git-path invariant.	src/sqlite/index-tracker.ts:472-492	dedupe
src/sqlite/maintenance/reachability.ts	MAX_HEADER_OBJECT_BYTES	12	48 * 1024 * 1024	50331648	work-counter	reachability header parser total	E2BIG	aggregate-model	Loose headers stream; packed headers may materialise one object, whose real allocation is already enforced by the pack delta/operation reservation.	src/sqlite/maintenance/reachability.ts:485-505;src/sqlite/store.ts:5534-5548	remove
src/sqlite/maintenance/reachability.ts	MAX_TREE_NAME_BYTES	13	2_200	2200	schema	persisted tree-edge name	corrupt	test-only	Untrusted edge rows need validation, but the value duplicates the unresolved Git-path policy.	src/sqlite/maintenance/reachability.ts:869-886	dedupe
src/sqlite/maintenance/reachability.ts	MAX_TREE_RAW_ENTRY_BYTES	14	2_264	2264	schema	persisted raw tree edge	corrupt	test-only	The raw entry cap adds framing to the path cap and must be rederived after one path invariant is chosen.	src/sqlite/maintenance/reachability.ts:869-886	replace
src/sqlite/maintenance/repack.ts	MAX_REPACK_INFLATED_BYTES	14	32 * 1024 * 1024	33554432	batching	repack inflated input batch	none	source-proof	Crossing the threshold ends the current restartable batch and does not reject the operation.	tests/maintenance-repack.test.ts:659-700	keep
src/sqlite/maintenance/repack.ts	MAX_REPACK_STORED_BYTES	15	64 * 1024 * 1024	67108864	batching	repack stored output batch	none	source-proof	The threshold bounds a restartable output batch and publication continues in later generations.	tests/maintenance-repack.test.ts:659-700	keep
src/sqlite/maintenance/roots.ts	MAX_INDEX_PATH_BYTES	15	2_200	2200	schema	maintenance-root index path	corrupt	test-only	Persisted roots require validation, but this duplicates another Git-path ceiling.	src/sqlite/maintenance/roots.ts:370-380	dedupe
src/sqlite/memory.ts	MAX_OPERATION_MEMORY_BYTES	3	64 * 1024 * 1024	67108864	retained-memory	shared operation coordinator	E2BIG	aggregate-model	The coordinator sums simultaneous owner reservations and proves exact, first-excess, release, and shared-child behavior.	tests/memory.test.ts:23-42,191-199	keep
src/sqlite/packs.ts	MAX_PACK_FALLBACK_AUDIT_BYTES	49	48 * 1024 * 1024	50331648	work-counter	cumulative fallback audit work	E2BIG	aggregate-model	The synchronous deletion audit charges a 58 MiB live reservation for pool/base/compressed/metadata; cumulative pack sizes and streamed loose-base sizes are not additional retained buffers.	src/sqlite/packs.ts:2481-2488,2558-2573,2788-2862,3038-3059	remove
src/sqlite/packs.ts	MAX_PACK_BLOB_BATCH_BYTES	65	4 * 1024 * 1024	4194304	batching	bulk object payload batch	E2BIG	aggregate-model	The 4 MiB batch is useful for bounded reads, but using it as a maximum valid object size is a category error.	tests/pack.test.ts:1944,2462-2507	replace
src/sqlite/packs.ts	MAX_PACK_ROW_CACHE_BYTES	86	DEFAULT_CHUNK_BYTES	4194304	retained-memory	compressed pack-row LRU	none	aggregate-model	The LRU accounts compressed row bytes and participates in the pack memory equation.	src/sqlite/packs.ts:105-139	keep
src/sqlite/packs.ts	MAX_PACK_DELTA_WORKING_BYTES	89	48 * 1024 * 1024	50331648	retained-memory	pack delta base target and output	E2BIG	aggregate-model	The pack pipeline charges live delta work before allocation and shares the central coordinator.	tests/pack.test.ts:2462-2507,2870-2886	keep
src/sqlite/packs.ts	MAX_PACK_AUTH_COMPRESSED_BYTES	96	MAX_PACK_DELTA_WORKING_BYTES + PACK_INFLATE_HEADROOM_BYTES	67108864	work-counter	streamed compressed authentication input	E2BIG	source-proof	Compressed input is read in bounded ranges; total compressed bytes do not coexist with the bounded inflated output.	src/sqlite/packs.ts:1201-1212,1277-1319,1484-1493,1751-1803	remove
src/sqlite/reflog-schema.ts	MAX_REFLOG_REF_BYTES	3	MAX_REF_NAME_BYTES	1024	schema	persisted reflog ref	corrupt	test-only	The untrusted row check is required, but this is a direct alias of the unproved ref limit.	tests/helpers/repository-invariants.ts:154-155	dedupe
src/sqlite/reflog-schema.ts	MAX_REFLOG_RAW_TARGET_BYTES	4	1_024	1024	schema	persisted raw ref target	corrupt	test-only	Stored symbolic targets need validation, but the independent 1 KiB value lacks one ref-target owner.	tests/store.test.ts:2575-2590	replace
src/sqlite/reflog-schema.ts	MAX_REFLOG_IDENTITY_BYTES	5	1_024	1024	schema	persisted reflog actor identity	corrupt	test-only	Stored identity fields need validation, but this duplicates other 1 KiB identity policies.	src/sqlite/store.ts:918-1070	replace
src/sqlite/reflog-schema.ts	MAX_REFLOG_REASON_BYTES	6	256	256	schema	persisted reflog reason	corrupt	test-only	Stored reasons need validation, but 256 has no structural or aggregate derivation.	src/sqlite/store.ts:961-1064	replace
src/sqlite/reflog-schema.ts	MAX_REFLOG_STATE_BYTES	10	48 * 1024 * 1024	50331648	retained-memory	ref and reflog retained state	E2BIG	test-only	Rows and strings are live, but the total lacks a complete coexistence equation.	src/sqlite/store.ts:6911-6925	replace
src/sqlite/schema.ts	MAX_ROUTING_CHECKOUTS_RETAINED_BYTES	29	16 * 1024 * 1024	16777216	retained-memory	routing checkout rows	corrupt	aggregate-model	Routing validation charges retained checkout rows and rejects untrusted underreported state.	tests/store.test.ts:314-315	keep
src/sqlite/schema.ts	MAX_ROUTING_ROOTS_UTF8_BYTES	31	6 * 1024 * 1024	6291456	retained-memory	routing root strings and discovery proof	corrupt	aggregate-model	The root total is an explicit term in the discovery model that stays below 100 MiB.	tests/fs/scan.test.ts:827-840	keep
src/sqlite/schema.ts	MAX_CHECKOUT_ROOT_BYTES	32	4_096	4096	schema	persisted checkout root	corrupt	test-only	Untrusted roots need validation, but 4 KiB duplicates the filesystem path policy.	src/sqlite/store.ts:2335-2337	dedupe
src/sqlite/schema.ts	MAX_INDEX_PATH_BYTES	33	8 * 1_024	8192	schema	persisted index and config path	corrupt	test-only	Untrusted rows need a path check, but 8 KiB conflicts with 2,200 and 4,096 limits.	tests/store.test.ts:2867	replace
src/sqlite/schema.ts	MAX_SCRATCH_INDEX_NAME_BYTES	35	255	255	schema	persisted scratch-index name	corrupt	test-only	The field needs validation, but 255 is not derived from a schema, format, or aggregate owner.	tests/store-stream.test.ts:543-544	replace
src/sqlite/schema.ts	MAX_SCHEMA_OBJECT_RETAINED_BYTES	1018	100 * 1024 * 1024	104857600	retained-memory	sqlite_schema projection	corrupt	aggregate-model	Schema definitions are accumulated and checked strictly below the 100 MiB operation target before retention.	src/sqlite/schema.ts:1018-1025	keep
src/sqlite/schema.ts	MAX_SCHEMA_VERSION_BYTES	1019	String(Number.MAX_SAFE_INTEGER).length	16	format	decimal safe-integer schema version	corrupt	platform	Sixteen decimal characters are exactly the width of Number.MAX_SAFE_INTEGER.	src/sqlite/schema.ts:1019-1025	keep
src/sqlite/sparse-workspace.ts	MAX_PATH_BYTES	30	2_200	2200	schema	sparse workspace path	corrupt	test-only	Untrusted rows need validation, but this is another independent Git-path value.	tests/sparse-workspace.test.ts:1954-1983	dedupe
src/sqlite/sparse-workspace.ts	MAX_ROOT_BYTES	31	4_096	4096	schema	sparse workspace root	corrupt	test-only	Untrusted roots need validation, but this duplicates checkout/filesystem root policy.	src/sqlite/sparse-workspace.ts	dedupe
src/sqlite/sparse-workspace.ts	MAX_REQUEST_JSON_BYTES	33	1024 * 1024	1048576	batching	sparse SQL request JSON	E2BIG	test-only	One MiB is not an engine limit; charge the retained atomic request and let SQLite report any actual storage failure.	src/sqlite/sparse-workspace.ts	replace
src/sqlite/sparse-workspace.ts	MAX_SOURCE_BYTES	45	8 * 1024 * 1024	8388608	heuristic	tree-source validation state	fallback	test-only	The source can fall back or signal corrupt underreporting, but the independent cap lacks an owner equation.	tests/sparse-workspace.test.ts:926-934	replace
src/sqlite/sparse-workspace.ts	MAX_WORKTREE_RETAINED_BYTES	46	4 * 1024 * 1024	4194304	heuristic	worktree facts and content	fallback	test-only	Facts are retained, but the fallback threshold should derive from the caller reservation.	tests/sparse-workspace.test.ts:542,1397-1415	replace
src/sqlite/sparse-workspace.ts	MAX_SPARSE_WORKSPACE_RETAINED_BYTES	47	8 * 1024 * 1024	8388608	retained-memory	sparse request and result	E2BIG	test-only	The aggregate is live, but the value is asserted rather than derived from all coexisting state.	tests/sparse-workspace.test.ts:287,542,1397-1415,2008	replace
src/sqlite/store.ts	MAX_BLOB_BATCH_BYTES	157	MAX_PACK_BLOB_BATCH_BYTES	4194304	batching	store bulk object batch	E2BIG	aggregate-model	This direct alias should not own policy separately from pack batching.	tests/checkout-initial.test.ts:342	dedupe
src/sqlite/store.ts	MAX_LOG_STATE_BYTES	159	32 * 1024 * 1024	33554432	retained-memory	operation-journal commit bodies	E2BIG	test-only	The same name/value is owned separately in commits and the journal lacks a complete allocation equation.	tests/operation-state.test.ts:615-618	dedupe
src/sqlite/store.ts	MAX_REFLOG_ROOT_RETAINED_BYTES	181	100 * 1024 * 1024 - 1	104857599	retained-memory	whole reflog-root operation	E2BIG	aggregate-model	The owner deliberately stays below 100 MiB and partitions scan, object cache, pack cache, and JS headroom.	tests/reflog-api.test.ts:678-693	keep
src/sqlite/store.ts	MAX_REFLOG_ROOT_SCAN_BYTES	185	MAX_REFLOG_ROOT_RETAINED_BYTES - REFLOG_ROOT_OBJECT_CACHE_BYTES - REFLOG_ROOT_PACK_ROW_CACHE_BYTES - REFLOG_ROOT_JS_HEADROOM_BYTES	88080383	retained-memory	reflog root scan rows	E2BIG	aggregate-model	The scan allowance is the exact remainder after every coexisting cache/headroom owner.	tests/reflog-api.test.ts:678-693	keep
src/sqlite/store.ts	MAX_CHECKOUT_LIST_RETAINED_BYTES	200	6 * 1024 * 1024	6291456	retained-memory	materialized checkout list	E2BIG	test-only	The list is materialized, but 6 MiB has no row/array/string coexistence equation.	tests/checkout-lifecycle-store.test.ts:255	replace
src/sqlite/store.ts	MAX_CONFIG_SECTION_MOVE_TEXT_BYTES	202	1024 * 1024	1048576	retained-memory	copied config section text	E2BIG	test-only	The move retains source and destination text, but the cap lacks a complete transaction allocation equation.	tests/store.test.ts:2904-2916	replace
src/sqlite/store.ts	MAX_REF_MUTATION_RETAINED_BYTES	217	64 * 1024 * 1024	67108864	retained-memory	ref snapshots events and SQLite headroom	E2BIG	aggregate-model	The budget charges candidates, snapshots, events, names, targets, and a real SQLite retained headroom owner.	tests/store.test.ts:2082-2093,2575-2590	keep
src/sqlite/store.ts	MAX_BLOB_ID_MISMATCH_RETAINED_BYTES	679	16 * 1024 * 1024	16777216	retained-memory	blob-id mismatch map	E2BIG	test-only	The map is live, but 16 MiB is not charged to a complete lookup/cache operation owner.	tests/store.test.ts:655-685	replace
src/sqlite/store.ts	MAX_BLOB_ID_INPUT_RETAINED_BYTES	680	16 * 1024 * 1024	16777216	retained-memory	blob-id input dedupe and pages	E2BIG	test-only	Input keys and pages coexist, but the standalone cap lacks an aggregate equation.	tests/store.test.ts:655-685	replace
```

The eleven direct removals are frozen separately so `remove` never means
"unbounded":

| Stable key | Live owner / exact seam | WU6 stage | Former-first-excess witness |
|---|---|---|---|
| `integration-worktree.ts:MAX_GUARD_HASH_BYTES` | `dirtyPathLimits()` and `requireSafeIntegrationWorktree()` stop admitting work by cumulative file size, 64 KiB range-read count, or flushed hash-batch count. `hashWorktreePathsAtRoot()` owns one current range chunk or bounded `readFiles` batch; candidate/path arrays remain charged to the integration reservation. | WU6c | `tests/integration.test.ts`: guard crosses the former byte, range-read, and batch thresholds with identical clean/dirty result; injected read failure releases the reservation. Cgroup integration row records bounded high-water. |
| `plumbing.ts:READ_TREE_MAX_WRITE_BYTES` | `readTree()` stops passing a cumulative checkout budget. `flushCheckoutWrites()` owns at most `CHECKOUT_BLOB_BYTES` (3 MiB) plus the current write/index batch, flushes it, then advances. | WU6d | `tests/plumbing-write.test.ts`: read-tree writes >64 MiB with exact index/worktree tree; batch failure rolls back the scratch-aware transaction. Cgroup read-tree row. |
| `rebase-lifecycle.ts:REBASE_BASELINE_MAX_BYTES` | Baseline blob-size, 64 KiB range-read, and flushed-batch totals stop admitting work. At most 4,096 OID/size metadata entries coexist; each worktree hash owns one current range chunk or bounded small-file batch, and current object metadata is charged to the rebase operation reservation. | WU6c | `tests/rebase-restart.test.ts`: baseline crosses the former byte/range/batch thresholds, rebase/abort/reopen state matches Git, and the reservation returns idle. Cgroup rebase row. |
| `staging.ts:ADD_MAX_HASH_BYTES` | Add removes cumulative byte and range-read admissions. `hashWorktreePathsAtRoot()` streams large files in 64 KiB chunks and `readFiles()` bounds the current small-file batch; selected/candidate maps remain under the add retained owner. | WU6d | `tests/staging.test.ts`: add crosses the former byte and range-read thresholds and writes exact blob/index OIDs; injected range/read failure leaves index unchanged. Cgroup add row. |
| `staging.ts:RM_MAX_HASH_BYTES` | Rm keeps only candidate/cardinality owners that bound retained collections; cumulative file size, range-read count, and flushed-batch count no longer admit work. Hash buffers own one current 64 KiB range chunk or bounded small-file batch. | WU6d | `tests/staging.test.ts`: safety proof crosses the former byte/range/batch thresholds and produces the same refusal/removal as Git; error path preserves index/worktree. Cgroup rm row. |
| `protocol/stream.ts:MAX_PROTOCOL_SOURCE_CHUNK_BYTES` | `PktReader` holds one caller-owned chunk reference and slices it while retaining only the current pkt frame (`MAX_PKT_FRAME_BYTES = 65,520`) plus explicitly charged protocol state. Source chunk length is not admission. | WU6e | `tests/protocol.test.ts`: a source chunk >1 MiB containing multiple frames parses byte-exactly; malformed/truncated pkt still fails and transport reservation cleans up. |
| `fs/store/stream-write.ts:MAX_STREAM_BYTES` | `writeFileStream()` stops summing published bytes. It retains only the caller's current chunk slice, one `CHUNK_SIZE` content row, and bounded metadata; SQLite transaction atomicity is preserved. | WU6a | `tests/fs/stream-write.test.ts`: redirect >96 MiB commits exact bytes, while a late source/SQL failure publishes nothing. Cgroup stream row. |
| `shell/exec/execute.ts:ATOMIC_REDIRECT_BYTES_MAX` | Shell stops preflighting the same cumulative redirect total. Its retained budget owns pipeline chunks; filesystem `writeFileStream()` owns the current atomic write slice. No second alias remains. | WU6f | `tests/shell/journey.test.ts` plus redirect-focused shell test: >96 MiB pipeline reaches filesystem and is exact; failure remains atomic and shell buffers release. |
| `maintenance/reachability.ts:MAX_HEADER_OBJECT_BYTES` | Loose commit/tag headers stream chunk-by-chunk. Packed `SharedRepoStore.readChunks()` may materialise one object, but that exact allocation is already admitted by `MAX_PACK_DELTA_WORKING_BYTES` and its operation reservation; no header-total duplicate remains. | WU6g | `tests/maintenance-reachability.test.ts`: loose header >48 MiB streams to the same roots; packed first excess follows the real pack-memory error; corrupt headers remain corrupt. Cgroup reachability row. |
| `packs.ts:MAX_PACK_FALLBACK_AUDIT_BYTES` | Pack deletion remains synchronous/atomic. The existing reservation is the exact coexistence equation: 48 MiB delta pool + 4 MiB base batch + 4 MiB compressed batch + 2 MiB metadata = 58 MiB. Pack/object cardinality stays structural; cumulative audited pack/loose sizes, pages, and uncached reads are work and do not add to the live equation. | WU6g | `tests/pack.test.ts`: audited bytes >48 MiB and former page/read excess delete safely with authenticated fallback objects; transaction failure restores all packs. Cgroup fallback-audit row. |
| `packs.ts:MAX_PACK_AUTH_COMPRESSED_BYTES` | Authentication streams compressed data through 1 MiB range reads and retains only the inflater state, current input chunk, and bounded output/delta live set. Total compressed bytes are work; format and exact inflated-output memory bounds remain. | WU6g | `tests/pack.test.ts`: a valid >64 MiB compressed stream with bounded authenticated output succeeds; truncated/corrupt input and inflated-output memory first excess retain their errors. Cgroup pack-auth row. |

### Frozen byte-limit execution design

The inventory's `replace` and `dedupe` values mean that the declaration does
not survive as an independent admission policy. The exact effective action is
frozen below. This action ledger covers all 98 such rows: 44 structural/schema/
binding rows and 54 memory/heuristic/batching rows. The eleven `remove` rows
remain the direct named removals stated after the inventory; hidden aliases are
reconciled separately, and the 38 `keep` rows do not change.

The evidence review exposed six cross-family choices. They are resolved here so
WU6 has no architecture placeholder:

1. Move the import-free coordinator and its 64 MiB real retained-memory ceiling
   from `src/sqlite/memory.ts` to internal leaf module `src/memory.ts`. Expose a
   reservation's exact remaining bytes. Every allocating operation receives one
   root reservation and uses child scopes for coexisting owners; success and
   every error path dispose it. Direct helpers without a repository create one
   local coordinator. This is the canonical owner for integration, history,
   transport, protocol, CLI output, and SQLite materialisation.
2. Do not add a package-side SQLite value ceiling. Cloudflare documents a
   conservative 2 MB support boundary for a string, BLOB, or row
   ([Durable Objects SQL limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits)),
   but it does not define an exact first failing bound value. `1_500_000` JSON
   pages and `2_000_000` BLOB segments remain non-refusing batching targets.
   A larger singleton value reaches SQLite; a real `SQLITE_TOOBIG` result is
   normalized to the package's stable error without a projected size refusal.
   Persisted data is not corrupt merely because it exceeds a batching target.
3. Use SQLite-native long paths. There is no public `PATH_MAX` and no universal
   Git-ref byte ceiling. Grammar, canonical UTF-16, NUL/slash rules, actual
   SQLite acceptance, pkt-line framing, and complete operation memory are
   separate owners. Derived path/ref rows validate against the same applicable
   owner; they do not invent 2,200/4,096/8,192-byte policies.
4. Put pkt-line constants in import-free
   `src/core/protocol/pktline.ts`: 65,520 bytes per frame and 65,516 payload
   bytes. Protocol text and push options use that real wire limit.
5. Cache and batch eligibility never determine object validity. A value that
   does not fit a cache/JSON batch uses an uncached or singleton path. The
   authoritative object is rejected only by format, an engine-reported
   `SQLITE_TOOBIG`, contiguous allocation, or complete retained-memory failure.
6. Cumulative traversal, serialization, source, and streamed-wire bytes are
   work metrics. Benchmarks may record them, but runtime charges only the
   current page/object plus state that actually coexists. A contiguous tree or
   commit allocation is charged at its exact size before allocation; no fixed
   cumulative surrogate replaces the removed counter.

#### Structural, schema, and binding actions (44 rows)

| Exact inventory keys | Effective action and owner | Boundary witness |
|---|---|---|
| `config.ts:{MAX_REMOTE_NAME_BYTES,MAX_REMOTE_URL_BYTES}`; `pull.ts:{MAX_PULL_REMOTE_BYTES,MAX_PULL_URL_BYTES}`; `initial-write.ts:{MAX_JSON_BYTES,MAX_PAYLOAD_BYTES,MAX_SMALL_FILE_BYTES}`; `blob-id-cache.ts:MAX_CACHED_CONTENT_ID_BYTES`; `schema.ts:MAX_SCRATCH_INDEX_NAME_BYTES` | Remove component refusals. Generated config values and persisted fields use non-refusing SQL batches; JSON uses the 1.5 MB page target; `writeFile()` streams above its former 1 MiB limit; content IDs above cache eligibility remain valid and uncached. SQLite remains the authority for its actual value/row limit. | `tests/{client,pull,store,store-stream}.test.ts`, `tests/fs/initial-write.test.ts`: every former first excess succeeds; larger singleton values either round-trip or surface the real normalized SQLite error, and rollback remains atomic. |
| `ls-remote.ts:MAX_LS_REMOTE_PATTERN_BYTES`; `pull.ts:MAX_PULL_REF_BYTES`; `ref-log.ts:MAX_IDENTITY_BYTES`; `refspec.ts:MAX_REFSPEC_REF_BYTES`; `receive-pack.ts:MAX_PUSH_OPTION_BYTES`; `ref-name.ts:MAX_REF_NAME_BYTES`; `reflog-schema.ts:{MAX_REFLOG_REF_BYTES,MAX_REFLOG_RAW_TARGET_BYTES,MAX_REFLOG_IDENTITY_BYTES,MAX_REFLOG_REASON_BYTES}` | Remove universal ref/identity/reason caps. Local/persisted text uses grammar, non-refusing SQL batching, and the complete ref-mutation reservation; outbound text/options use the pkt payload owner. | `tests/{ls-remote,pull,refspec,refspec-contract,receive-pack,reflog-operations,reflog-api,store}.test.ts`: long canonical values pass their former caps; pkt first excess and engine-reported SQLite failures retain their wire/atomic error result. |
| `merge-state.ts:{MAX_MERGE_PATH_BYTES,MAX_MERGE_REF_BYTES,MAX_MERGE_LABEL_BYTES,MAX_MERGE_IDENTITY_BYTES,MAX_MERGE_MESSAGE_BYTES}`; `plumbing.ts:{MAX_COMMIT_TREE_MESSAGE_BYTES,MAX_COMMIT_TREE_INPUT_BYTES}`; `git/cli/types.ts:GIT_CLI_MAX_COMMIT_MESSAGE_BYTES`; `commits.ts:MAX_INDEXED_COMMIT_BYTES` | Remove field and cache-validity ceilings. Journal fields charge exact bytes to the operation reservation. Commit serialization/parser bytes are charged before allocation; cache rows that do not fit a batch use the authenticated uncached path, and SQLite owns any actual storage failure. | `tests/{merge-state,operation-state,plumbing-write,commit-cache,pack,git-cli,git-cli-write}.test.ts`: former field/cache first excess works, aggregate first excess fails before allocation, cold reopen authenticates the same commit/journal, and reservations return idle. |
| `pathspec.ts:MAX_LS_FILES_PATTERN_BYTES`; `rename-detection.ts:MAX_RENAME_PATH_BYTES`; `staging.ts:RM_MAX_PATH_BYTES`; `tree-build.ts:MAX_TREE_BUILD_PATH_BYTES`; `worktree-io.ts:MAX_COMPILED_PATHSPEC_BYTES`; `exact-path-states.ts:MAX_PATH_BYTES`; `initial-write.ts:MAX_PATH_BYTES`; `git/cli/types.ts:GIT_CLI_MAX_CWD_BYTES`; `index-tracker.ts:MAX_PATH_BYTES`; `maintenance/reachability.ts:{MAX_TREE_NAME_BYTES,MAX_TREE_RAW_ENTRY_BYTES}`; `maintenance/roots.ts:MAX_INDEX_PATH_BYTES`; `schema.ts:{MAX_CHECKOUT_ROOT_BYTES,MAX_INDEX_PATH_BYTES}`; `sparse-workspace.ts:{MAX_PATH_BYTES,MAX_ROOT_BYTES}` | Delete conflicting path caps. Exact paths, compiled matchers, tree components, JSON requests, and derived rows use grammar plus their actual SQLite/pkt/contiguous-allocation/operation owner. Tracker entries that cannot fit a derived cache page make the cache unavailable and rebuildable; they do not invalidate the repository. Raw tree-entry size is derived from mode bytes + name bytes + 22 framing bytes. | `tests/{pathspec,rename-detection,staging,tree-build-preflight,tree-index-stream,worktree,git-cli,index-tracker,maintenance-reachability,maintenance-roots,store,store-stream,sparse-workspace}.test.ts` and `tests/fs/{exact-path-states,initial-write}.test.ts`: former path first excess works, actual memory/pkt/engine failure is stable, derived caches fall back, and malformed persisted rows are corrupt. |

The path/ref correction also audits aliases whose names did not match the
original `MAX`+`BYTES` AST predicate: branch status ref estimates,
`TREE_WALK_PATH_BYTES`, `ByteField(2_200)`, tracker/add/diff path estimates,
filesystem path-code-unit limits, routing discovery code-unit estimates, and
literal 2,200/4,096 checks. They follow the same canonical-family action and
cannot remain as hidden admission policies.

The same ledger captures non-`MAX` byte aliases that mix a valid batch target
with a singleton refusal or count streamed work as retained memory.

The exact hidden-alias ledger below is grounded at `6dac935`. The in-repo
Computer compatibility worktree is included: only the unrelated external
consumer/provider bulk-scan gate is out of scope.

| Stable source + symbol/site | Current behavior | Canonical action / stage | Boundary witness |
|---|---|---|---|
| `src/core/ops/branch-upstream.ts:STATUS_BRANCH_REF_BYTES` | Rejects a configured branch merge ref above 1,024 bytes. | Remove component cap; ref grammar + ref-mutation memory owner; SQLite remains the authority for storage failures — WU6b. | `tests/status-format.test.ts`: long canonical upstream ref and normalized engine failure. |
| `src/core/ops/branch-upstream.ts:STATUS_REMOTE_BYTES` | Rejects configured remote text above 255 bytes. | Remove component cap; generated config keys/values use non-refusing batching and engine-reported storage limits — WU6b. | `tests/status-format.test.ts`: 256-byte remote resolves. |
| `src/core/ops/branch-upstream.ts:STATUS_FETCH_BYTES` | Rejects configured fetch refspec above 2,048 bytes. | Remove component cap; ref grammar plus config binding/pkt frame at use — WU6b. | `tests/status-format.test.ts`: former first excess parses and resolves. |
| `src/core/ops/refs.ts:checkRefText(MAX_REF_NAME_BYTES - HEADS.length)` | Ref creation rejects the obsolete 1,024-byte family. | Grammar locally; persisted values use non-refusing batching and engine-reported storage limits — WU6b. | `tests/refs.test.ts`: long canonical branch round-trip and normalized engine failure. |
| `src/core/protocol/remote.ts:checkRefText(MAX_REF_NAME_BYTES)` | Discovery rejects advertised ref/symref above 1,024 bytes. | Validate grammar and the real pkt payload; charge retained refs — WU6e. | `tests/protocol.test.ts`: long framed ref accepted; pkt first excess rejected. |
| `src/core/protocol/receive-pack.ts:checkRefText(MAX_REF_NAME_BYTES)` | Receive-pack commands reject refs above 1,024 bytes. | Validate grammar and command pkt payload — WU6e. | `tests/receive-pack.test.ts`: exact payload/first excess. |
| `src/core/ops/push-plan.ts:checkRefText(MAX_REF_NAME_BYTES)` | Push preflight rejects source/destination refs above 1,024 bytes. | Grammar + emitted pkt payload + exact retained request owner — WU6e. | `tests/push-refspec.test.ts`: long canonical update reaches protocol result. |
| `src/core/objects.ts:ByteField(2_200, "entry name")` | Tree parser treats a longer component as corrupt. | Charge exact contiguous tree allocation; derived SQLite edges use non-refusing batches and surface real engine limits — WU6d. | `tests/reads.test.ts`, `tests/tree-index-stream.test.ts`: former first excess authenticates; allocation or engine failure is stable. |
| `src/core/ops/sparse-checkout.ts:selectedUtf8Bytes(path, 2_200)` | Long selected paths force the general checkout path. | Selection uses the caller's real remaining reservation; no fixed path fallback — WU6d. | `tests/checkout-sparse.test.ts`: long selected path uses sparse path when headroom exists and matches general result otherwise. |
| `src/core/ops/diff.ts:DIFF_PATH_BYTES` | Diff rejects a path above 2,200 bytes. | Charge exact path/output records to the existing combined diff owner — WU6d. | `tests/git-cli-read.test.ts`: former path first excess succeeds; combined-memory first excess remains. |
| `src/core/ops/integration.ts:virtual relocation 2_200 literal` | Virtual relocation throws `E2BIG` above 2,200 bytes. | Charge relocation string/trie to the integration reservation — WU6c. | `tests/integration-virtual-base.test.ts`: long relocation works below aggregate. |
| `src/core/ops/status-sparse.ts:TRACKER_PATH_BYTES` | Long tracker path makes sparse status unavailable. | Charge tracker/path state to caller remaining reservation; cache fallback is based on real headroom — WU6d. | `tests/status-sparse.test.ts`: long path sparse/general equivalence. |
| `src/core/ops/staging.ts:ADD_SELECTED_PATH_BYTES` | Long selected path abandons the selected-path add route. | Charge selected paths to the add operation owner; fallback only on real headroom — WU6d. | `tests/staging.test.ts`: long path selected/general equivalence. |
| `src/sqlite/tree-walk.ts:TREE_WALK_PATH_BYTES` | Tree SQL and row validation reject paths above 2,200 bytes. | Charge the exact current path; batch SQL without refusing a valid value and keep no traversal-total cap — WU6d. | `tests/tree-index-stream.test.ts`, `tests/store-stream.test.ts`: long path authenticates; a real engine failure stays atomic. |
| `src/sqlite/tree-index.ts:nameBytes.length > 2_200` | Derived tree-index row becomes unavailable above 2,200 bytes. | Derived cache accepts the authoritative name when it fits its real row/binding; otherwise cache is unavailable, not repository-corrupt — WU6d. | `tests/tree-index-stream.test.ts`: former first excess uses index; true cache-unavailable path falls back. |
| `src/sqlite/schema.ts:git_tree_edges 2_200 literals` | Schema projections filter longer persisted edge names. | Use canonical tree grammar and memory ownership; remove the projected value ceiling — WU6d. | `tests/schema.test.ts`, `tests/tree-index-stream.test.ts`: long valid edge and malformed-row witness. |
| `src/sqlite/schema.ts:git_checkouts.head 1_024 literal` | Fresh schema rejects a symbolic HEAD above 1,024 bytes. | Keep OID/symbolic-ref grammar; remove the size check and let SQLite report its real persisted-TEXT limit — WU6b. | `tests/schema.test.ts`, `tests/checkout-lifecycle-store.test.ts`: fresh long canonical HEAD works; an engine-reported failure is normalized and atomic. |
| `src/sqlite/schema.ts:git_tracking_ref_revisions.ref_name 1_024 literal` | Fresh schema rejects a tracking ref above 1,024 bytes. | Keep `refs/remotes/` grammar; remove the size check and retain the ref-mutation memory owner — WU6b. | `tests/schema.test.ts`, `tests/store.test.ts`: long tracking ref publication/reopen; an engine-reported failure is atomic. |
| `src/sqlite/schema.ts:git_fetch_namespaces.tracking_prefix 1_024 literal` | Fresh schema rejects a tracking prefix above 1,024 bytes. | Keep prefix grammar/trailing slash; remove the size check and retain the fetch-publication aggregate — WU6b. | `tests/schema.test.ts`, `tests/fetch-publication.test.ts`: long prefix publication/reopen; an engine-reported failure is atomic. |
| `src/sqlite/store.ts:initialPathJsonBytes default TREE_WALK_PATH_BYTES` | Initial path JSON preflight inherits the 2,200-byte tree-walk cap. | Compute exact encoded JSON and batch at the 1.5 MB target without refusing a larger singleton — WU6a. | `tests/checkout-initial.test.ts`: former path first excess writes; a real SQLite failure remains atomic. |
| `src/core/ops/checkout.ts:CHECKOUT_REMOVE_BINDING_BYTES` | Removal planning uses 1,000,000 bytes both to flush JSON batches and to reject one larger encoded absolute path. | Keep it only as a non-refusing flush target; a larger singleton reaches `removeFiles()`/SQLite — WU6d. | `tests/refs.test.ts`: former 1,000,001-byte singleton succeeds when SQLite accepts it; real/injected engine failure remains atomic. |
| `src/core/ops/staging.ts:RM_REMOVE_BINDING_BYTES` | Rm uses 1,000,000 bytes both to flush removal JSON and to reject one larger encoded absolute path. | Keep it only as a non-refusing flush target; a larger singleton reaches the filesystem/SQLite — WU6d. | `tests/staging.test.ts`: former 1,000,001-byte singleton reaches its Git-equivalent result; real/injected engine failure leaves index/worktree unchanged. |
| `src/core/ops/network.ts:TAG_AUTH_BYTES` | Fetch tag peeling sums authenticated bytes across hops and rejects above 64 MiB even though only the current hop is retained. | Remove the cumulative counter; charge the current hop to `TransportOperationBudget` and retain `TAG_PEEL_HOPS` as a structural cycle/depth bound — WU6e. | `tests/clone.test.ts`: tag chain above the former cumulative byte total authenticates exact targets while per-hop memory stays bounded; malformed/cyclic/deep chains retain their errors. |
| `src/compat/computer/worktree.ts:MAX_PATH_CODE_UNITS` | Compatibility worktree rejects/invalidates handles above 4,096 UTF-16 units. | Remove local cap; canonical filesystem grammar plus actual SQLite acceptance/allocation owner — WU6d. | `tests/compat.test.ts`: long canonical path and handle revalidation. |
| `src/fs/store/resolve.ts:MAX_PATH_CODE_UNITS` | Resolution throws `ENAMETOOLONG` above 4,096 code units. | Remove local cap; traversal is streaming and SQL values are not pre-refused by projected size — WU6d. | `tests/fs/resolve.test.ts`: former first excess resolves; a real SQLite failure is normalized. |
| `src/fs/store/read.ts:MAX_PATH_CODE_UNITS` | Long persisted handle path is treated as invalid. | Validate grammar; retained handle materialization keeps its aggregate owner and SQLite owns storage failure — WU6d. | `tests/fs/read.test.ts`: long handle reopen and malformed persisted-row witness. |
| `src/fs/store/scan.ts:DISCOVERY_EXCLUDE_ROOT_CODE_UNITS_MAX` | Discovery rejects/falls back on a 4,096-code-unit root. | Derive JSON item/page size for batching and charge the reviewed discovery aggregate — WU6d. | `tests/fs/scan.test.ts`: former first excess and multi-page JSON witness. |
| `src/core/ops/worktrees.ts:4_096 root literals` | Add/move worktree reject roots above 4,096 code units. | Canonical filesystem grammar + routing memory aggregate; SQLite owns storage failure — WU6d. | `tests/worktrees.test.ts`: long root add/move and normalized engine failure. |

This 28-site ledger is reconciled separately from the 147 declaration rows;
`maintenance/roots.ts:MAX_INDEX_PATH_BYTES` stays only in the declaration ledger.
Source search at WU6 closure must report no remaining runtime 1,024/2,200/4,096
path/ref policy or 1,000,000-byte singleton refusal, except unrelated page/
cardinality constants whose owner and name do not admit path or ref bytes.

#### Memory, heuristic, batching, and work actions (54 rows)

| WU6 stage and exact inventory keys | Effective action and coexistence model | Witness |
|---|---|---|
| **WU6c — integration/history (10):** `integration-structure.ts:MAX_INTEGRATION_STRUCTURE_BYTES`; `integration-worktree.ts:{MAX_INTEGRATION_INDEX_PATH_BYTES,MAX_INTEGRATION_SERIALIZED_TREE_BYTES}`; `integration.ts:{MAX_INTEGRATION_STRUCTURE_BYTES,MAX_INTEGRATION_PLAN_BYTES}`; `merge-apply.ts:MAX_MERGE_APPLY_CONTENT_BYTES`; `merge-base.ts:MAX_MERGE_BASE_RETAINED_BYTES`; `merge-state.ts:MAX_MERGE_STATE_BYTES`; `replay.ts:{MAX_REPLAY_PREFLIGHT_BYTES,MAX_REPLAY_PLAN_METADATA_BYTES}` | Delete all ten ceilings. One operation reservation charges relocation trie + identities + structural plan + content + snapshots + journal/replay metadata while they coexist. Merge-apply content already owned by the plan is not double charged. Cumulative index paths, serialized trees, and replay source bytes are benchmark work; the current parsed object/batch is the live owner. Returned plans retain a child scope until explicit release. | `tests/{integration,integration-virtual-base,divergence,merge-apply,merge-state,operation-state,replay}.test.ts`: exact aggregate/first excess, former cumulative first excess, success/error/cold-reopen cleanup. Cgroup `bench:memory` integration/history rows. |
| **WU6d — reads/tree (8):** `pathspec.ts:{MAX_LS_FILES_INPUT_BYTES,MAX_LS_FILES_RETAINED_BYTES}`; `pull.ts:MAX_PULL_FETCH_REFSPEC_BYTES`; `reads.ts:MAX_LS_TREE_RETAINED_BYTES`; `tree-build.ts:{MAX_TREE_BUILD_TOTAL_PATH_BYTES,MAX_TREE_BUILD_SERIALIZED_BYTES,MAX_SPARSE_TREE_RETAINED_BYTES,MAX_SPARSE_TREE_PLAN_BYTES}` | Remove raw/cumulative/component ceilings. Compiled patterns + dedupe/result strings share one read scope. A refspec is checked by ref grammar, emitted pkt framing, and complete memory ownership rather than a derived text cap; SQLite owns actual storage failure. Tree traversal charges current row and exact largest serialized object; sparse snapshot + plan use the caller's actual remaining reservation and fall back only when that real headroom is unavailable. | `tests/{pathspec,pull,reads,tree-build-preflight,plumbing-write}.test.ts`: former cumulative first excess succeeds, exact live aggregate fails cleanly, sparse fallback matches the general path. Cgroup read/tree rows. |
| **WU6e — transport/protocol (7):** `push-plan.ts:MAX_PUSH_PLAN_BYTES`; `transport-budget.ts:MAX_TRANSPORT_MEMORY_BYTES`; `receive-pack.ts:{MAX_PUSH_OPTIONS_BYTES,MAX_RECEIVE_PACK_STATUS_INPUT_BYTES,MAX_RECEIVE_PACK_RESULT_BYTES}`; `remote.ts:{MAX_PROTOCOL_RETAINED_BYTES,MAX_PROTOCOL_NEGOTIATION_INPUT_BYTES}` | Delete aliases, fixed sub-budgets, cumulative inbound-wire counters, and hidden cumulative tag-peel bytes. `TransportOperationBudget` reports named actual parts directly to its reservation. Request frames + graph/plan + result coexist until explicit release; streamed response and prior tag hops do not accumulate. Graph SQL receives the reservation's dynamic remaining bytes, never a fixed byte or statement surrogate. | `tests/{protocol,receive-pack,push-refspec,checkpoint-transport,clone}.test.ts`: exact aggregate/first excess, tag chain above the former cumulative total, and zero ownership after success, auth/malformed response, callback throw, and retry. Cgroup discovery/fetch/push rows. |
| **WU6a — initial-write/discovery (4):** `initial-write.ts:{MAX_INITIAL_WORKTREE_SESSION_BYTES,MAX_METADATA_JSON_BYTES,MAX_CHUNK_BATCH_BYTES}`; `scan.ts:DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES` | Inject a generic child reservation into the filesystem writer; charge metadata + chunks + assembler + path/flush transient. Rename 128 KiB metadata value to a flush-only batch target; delete the chunk alias and symlink refusal. Discovery formulas import the canonical routing-root aggregate directly. | `tests/fs/{initial-write,scan}.test.ts`: exact aggregate/first excess, >64 KiB symlink below real binding, stream/transaction error cleanup, and formula equality. Cgroup initial-write row. |
| **WU6f — CLI/shell (9):** `git/cli/types.ts:{GIT_CLI_MAX_ARGV_BYTES,GIT_CLI_MAX_ENV_BYTES,GIT_CLI_MAX_STDIN_BYTES,GIT_CLI_MAX_LOG_FORMAT_BYTES,GIT_CLI_MAX_STDOUT_BYTES,GIT_CLI_MAX_STDERR_BYTES}`; `shell/exec/execute.ts:{ARGUMENT_BYTES_MAX,STDIN_BYTES_MAX,ENV_BYTES_MAX}` | Delete limits on already allocated caller strings and component output caps; keep entry/cardinality/syntax rules. Thread one invocation reservation through parser, handler, and result. Charge only retained parsed copies and combined returned output; caller-provided lower output options remain. Shell stdin + env + expanded argv use its existing shared retained owner and release on early pipeline/error. | `tests/git-cli.test.ts`, `tests/shell/run-inputs.test.ts`: large caller-owned input without component refusal, combined-output exact/first excess, stdin+env+argv coexistence, and all cleanup paths. Cgroup CLI/shell rows. |
| **WU6g — SQLite stores/caches (11):** `blob-id-cache.ts:MAX_BLOB_ID_CACHE_CONTENT_BYTES`; `commits.ts:{MAX_COMMIT_CACHE_BYTES,MAX_LOG_STATE_BYTES}`; `packs.ts:MAX_PACK_BLOB_BATCH_BYTES`; `reflog-schema.ts:MAX_REFLOG_STATE_BYTES`; `store.ts:{MAX_BLOB_BATCH_BYTES,MAX_LOG_STATE_BYTES,MAX_CHECKOUT_LIST_RETAINED_BYTES,MAX_CONFIG_SECTION_MOVE_TEXT_BYTES,MAX_BLOB_ID_MISMATCH_RETAINED_BYTES,MAX_BLOB_ID_INPUT_RETAINED_BYTES}` | Delete the dead blob-id export, aliases, cumulative journal-body count, and fixed graph/map ceilings. Rename 4 MiB values to flush/batch targets only; oversized objects use singleton/streaming and uncached paths. Dynamic reservation scopes charge graph map/heap, current object/page, dedupe/mismatch maps, config rows/JSON, and checkout rows/array slots. Checkout-list capacity is derived from maximum checkout cardinality plus applicable root/ref field owners, never a literal fraction. `RefMutationBudget` remains the complete reflog owner. | `tests/{commit-cache,pack,maintenance-repack,operation-state,reflog-api,checkout-lifecycle-store,store}.test.ts`: >4 MiB valid object, >32 MiB cumulative journal work, exact live aggregate/first excess, and idle coordinator. Cgroup graph/object/config/checkout rows. |
| **WU6d — sparse/staging (5):** `staging.ts:MAX_LS_FILES_EXCLUDE_ROOT_UTF8_BYTES`; `sparse-workspace.ts:{MAX_REQUEST_JSON_BYTES,MAX_SOURCE_BYTES,MAX_WORKTREE_RETAINED_BYTES,MAX_SPARSE_WORKSPACE_RETAINED_BYTES}` | Delete the routing alias, the 1 MiB atomic-JSON refusal, and absolute sparse sub-caps. Every production sparse request receives caller remaining headroom; request JSON + trees + index + worktree coexist, while released validation/source pages do not. A larger atomic request reaches SQLite, fallback is based only on real remaining reservation, and neither path hides corruption. | `tests/{sparse-workspace,checkout-sparse,status-sparse,pathspec}.test.ts`: former 1 MiB JSON and 8 MiB source thresholds, exact caller headroom, success/fallback equivalence, normalized engine failure, corruption propagation, and bounded cgroup high-water. |

WU6a first moves the generic coordinator seam and SQLite/pkt foundations. WU6b
then applies the structural ref/config actions above. WU6c–WU6g follow in table
order, with the sparse/staging slice last inside WU6d to avoid an overlapping
edit to `staging.ts`. Each stage receives its own focused review-to-clean and
routine smoke gate; the final WU6 review reconciles all 98 keys plus the hidden
alias audit.

Inventory result: 147 unique stable keys, no duplicate key, no unresolved
decision. Proposed actions are 38 `keep`, 11 `remove`, 67 `replace`, and 31
`dedupe`. Removed counters are guard hashing, read-tree writes, rebase baseline
bytes, add hashing, rm hashing, protocol source chunks, filesystem redirect
streaming and its shell alias, reachability header objects, synchronous pack
fallback-audit totals, and streamed compressed-authentication input. The pack
blob batch remains a batch, but WU6 replaces its use as an object-validity
ceiling.

The post-write AST reconciliation reported `147` declarations and `147` ledger
rows, with zero missing keys, extra keys, duplicate keys, line drift, normalized
expression drift, or evaluated-byte drift. Every data row has exactly 12 TSV
columns. The evaluator resolves imported aliases, arithmetic, `Math.ceil`, and
the decimal `Number.MAX_SAFE_INTEGER` width.
