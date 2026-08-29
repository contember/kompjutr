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
- ✔ The runtime has 28 `MAX_*` statement constants across 12 files, 13 thrown
  statement-count refusal sites, one statement-driven sparse-checkout fallback,
  seven module-load assertions, and statement projections spread over 24 source
  files. The transport budget alone has 56 SQL accounting call sites.
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
  complete semantic inventory is 147 constants. No individual threshold is
  benchmark-derived at HEAD; boundary tests prove enforcement, not the chosen
  number.
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
2. `≤1,000` remains a benchmark target. Benchmark and production-probe harnesses
   may fail their measurement when a row exceeds the target because they do not
   change package runtime behavior.
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

## Work units

### WU1 — Establish the evidence ledger (effort L)

- **Problem.** Removing runtime models without a replacement would lose the cost
  signal, while changing byte bounds before a complete inventory would turn an
  arbitrary policy into another arbitrary policy.
- **Verify first.** Recount the 28 statement constants, 24 affected source files,
  147 semantic byte constants, 333 direct statement matchers and benchmark gaps
  from the commands recorded in the run log. Run three clean current Next.js
  benchmarks under the same two-vCPU no-SMT lease as the before baseline.
- **Scope.** Add a deterministic `bench:statements` surface with correctness-
  checked rows for schema init, streamed redirect, cached and combined
  `ls-files`, sparse prune, fetch publication, merge-base selection, recursive
  virtual base, merge apply/recovery/restore, replay plan/recovery, rebase
  plan/transition, maintenance repack, and transport discovery/fetch/push;
  reuse existing clone/commit/checkout Next.js rows where they are the exact
  measured operation. Append a one-to-one statement-barrier ledger to this run
  log: source site, old operation/error/fallback, focused removal witness,
  representative benchmark row, and removal WU for all 13 thrown sites, the
  sparse fallback and seven load assertions. The focused former-first-excess
  witness is separate from the representative target row: an admitted stress
  call may exceed the target without becoming a runtime error. Append the
  147-row byte-limit TSV with kind, owner, failure, evidence and decision.
  Freeze exact byte removals/replacements only after independent evidence
  review. Draft ADR 0017 and register it in the decision log and docs index.
- **Acceptance / witness.** `npm run bench:statements -- --check` emits every
  required row with validated end state and statement count; repeated output is
  deterministic. Its representative rows enforce the measured target; removal
  witnesses only prove the runtime no longer manufactures failure. The barrier
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
  family. Preserve all graph-size, path, object, retained-memory, journal and CAS
  bounds. Do not change result semantics beyond removal of statement-based
  refusal.
- **Acceptance / witness.** Former first-excess statement fixtures now complete
  with the same public repository state as Git; memory/structural first-excess
  fixtures still fail. Run the focused merge/integration group and the focused
  replay/rebase group separately, each below 30 seconds, then `npm test`.
- **Touch points.** `src/core/ops/{commit,integration,integration-worktree,
  merge-base,merge,merge-apply,replay,replay-lifecycle,rebase-plan,
  rebase-lifecycle,ref-log}.ts` and matching tests.

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

- **Problem.** Schema initialization, atomic redirect streaming, pathspec/
  `ls-files`, sparse checkout and maintenance repack retain independent projected
  count barriers outside the shared transport/history models.
- **Verify first.** Add direct witnesses for redirect first excess, sparse
  selected-plan fallback, maintenance selection, and both `ls-files`
  projections where current tests cover only their calculators. Schema has a
  fixed initialization stream and no caller-controlled over-999 fixture; pin
  fresh initialization, reopen and corrupt-schema behavior plus the wrapper's
  source/API shape instead of inventing a test seam.
- **Scope.** Delete the schema 999 wrapper, redirect 900-statement refusal,
  pathspec/staging assertions and projections, sparse SQL-driven fallback, and
  maintenance repack statement estimate/refusal. Retain transactional rollback,
  binding/page sizes, memory limits, and restartable maintenance ownership.
- **Acceptance / witness.** Caller-reachable former refusals/fallbacks proceed;
  redirect remains atomic, sparse state matches the full path, and maintenance
  resumes and publishes the same objects. A source/API audit proves the schema
  counting wrapper is absent while fresh init, exact reopen, version mismatch
  and corrupt schema retain their prior outcomes. Run schema, filesystem
  redirect, pathspec/staging/sparse and maintenance witnesses separately, then
  `npm test`.
- **Touch points.** `src/{fs/store/stream-write,sqlite/schema,
  sqlite/maintenance/repack}.ts`, `src/core/ops/{pathspec,staging,
  sparse-checkout}.ts`, and matching tests.

### WU5 — Put cost policy in benchmarks and living docs (effort M)

- **Problem.** Exact operation-cost assertions and living docs would otherwise
  preserve the removed runtime model by implication.
- **Verify first.** Classify all 171 exact statement equalities as operation cost
  or semantic query shape; do not bulk-rewrite ambiguous zero/one assertions.
- **Scope.** Convert operation-cost assertions to `<1,000`; retain and name exact
  semantic query-shape assertions. Update `tests/CLAUDE.md`, root/core module
  context, architecture, concurrency, Git support, shell, production probe and
  benchmark wording. Accept ADR 0017 and list every removed runtime refusal and
  fallback by operation/error in this sprint run log.
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
- **Scope.** Apply only the reviewed actions. The initial candidate set is
  streamed redirect total, add/rm/merge-guard hashing totals, read-tree writes,
  rebase baseline bytes, reachability header total, protocol source chunk size,
  and misuse of pack batch size as object validity. Keep aggregate OOM guards,
  protocol framing, SQL binding segmentation, persisted-row validation,
  batching and fallback limits unless the evidence review explicitly says
  otherwise.
- **Acceptance / witness.** A workload above each removed threshold succeeds
  while per-page/per-chunk retained high-water remains within the central memory
  model. Focused memory, pack, protocol, filesystem and lifecycle witnesses pass.
  A cgroup-backed benchmark under a CPU lease covers the large streamed/hash/
  rebase/reachability cases; it is evidence of bounded live memory, not a new
  runtime admission threshold.
- **Touch points.** Exact files frozen in the WU1 inventory review; expected
  families are `src/core/ops/`, `src/core/protocol/`, `src/fs/store/`,
  `src/sqlite/{maintenance,packs}.ts`, tests and benchmarks.

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
  unchanged; external source imports still target `src/sqlite/store.js`;
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
| WU1 | Evidence determines every later removal. | Independent T3 evidence review of benchmark coverage, all 147 inventory rows and proposed actions; fixes return to the same reviewer. | A constant cannot be classified or a former statement barrier lacks a measurable row. |
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
  must succeed and retain exact statement counts; returned-row medians must
  match when rounded to three significant figures. Final median wall time must
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
- **Material findings:** The first proposal lacked one-to-one barrier evidence,
  asked for an infeasible over-999 schema fixture, omitted structural byte
  limits, allowed defect fixes inside a pure store move, and left closure gates
  underspecified. The approved plan now maps every barrier to separate behavior
  and benchmark witnesses, uses source/API schema evidence, reviews all 147 byte
  limits including real structural failures, stops extraction for separate fixes,
  and names parity/conformance plus three-run benchmark thresholds.

## Run log

- 2026-08-29 — Read-only statement audit found 28 named constants, 13 thrown
  refusal sites, one silent sparse fallback, seven load assertions and 24
  affected source files. Benchmark target checks are explicitly retained.
- 2026-08-29 — Read-only memory audit expanded the backlog's 117-name regex to
  147 semantically equivalent byte constants. None has per-threshold benchmark
  evidence at HEAD; the classification must separate live allocation, external
  format, persisted validation, batching, fallback and streamed work.
- 2026-08-29 — The store has drifted from 8,493 to 9,259 lines. Public consumers
  still converge on `src/sqlite/store.js`, so the planned internal directory
  keeps that file as an explicit facade.
- 2026-08-29 — Huygens approved the corrected T3 proposal. Implementation may
  start with WU1; its evidence must receive its own review-to-clean before it is
  committed and before any runtime barrier changes.
