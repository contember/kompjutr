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
4. WU6 applies only reviewed byte-limit decisions. After WU6a/WU6b, a
   review-approved WU6c-pre prerequisite lands the internal owner-aware tree,
   graph, hash/checkout-guard and journal seams before WU6c consumes them. It
   promotes only the required WU6d/WU6g seam and call-site work: stable keys
   remain assigned to their original stage until every default consumer is
   converted. `CHECKOUT_GUARD_BYTES` is a promoted hidden WU6c alias;
   `CHECKOUT_GUARD_BATCH` remains a non-refusing flush size.
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
- **Sequencing-delta reviewer:** Ohm (`fix_computer_worktree_scan_t3`)
- **Sequencing-delta verdict:** approved after corrections
- **Sequencing-delta findings:** WU6c could not remove its integration aliases
  while tree-build and graph defaults still enforced the same ceilings. The
  approved WU6c-pre stage promotes only internal owner-aware seams and exact
  WU6c call sites. `commits.ts:MAX_LOG_STATE_BYTES` remains open for WU6g until
  `Repository.walk()` and all default consumers are converted.

## Run log

- **Planning + baseline / WU1 (2026-08-29).** Grounding at `6dac935` found 48 grouped query/work policy owners (34 refusals, three corruption failures, four fallbacks, seven assertions), 28 named statement constants plus 26 aliases, and 147 byte declarations plus 28 hidden sites. Huygens approved the corrected plan; Ohm approved WU1 review-to-clean after the byte review froze `38 keep / 11 remove / 67 replace / 31 dedupe`. `bench:statements -- --check` validated 34 deterministic rows in 7.20/7.14 s and an independent 7.3 s rerun; smoke passed 148/148 in 16.99 s. Three leased Next.js baselines completed; clone intentionally misses the target at median 1,586 SQL / 109,918 rows and remains optimization evidence outside this sprint.
- **WU2 (2026-08-29).** Ohm approved core integration/history statement-model removal after review caught and fixed a missing worktree cursor-progress guard, dead range-read calculator, and weak first-excess oracles. Exact merge/rebase/replay/range-read outcomes are pinned; several former excesses remain unreachable below real cardinality/byte maxima without an artificial seam.
- **WU3 (2026-08-29).** Ohm approved transport SQL-accounting removal with the 64 MiB memory coordinator, CAS/revisions, atomic publication, retry uncertainty, and pack leases intact; the 1,024-ref publication/reopen witness passed.
- **WU4 (2026-08-29).** Dalton approved the standalone-gate removal after review replaced false >100,000-row witnesses and added exact tracker reopen/epoch and pack 181st-read boundaries; sparse dirty loading is bounded only by the real 8 MiB owner. Smoke passed 150/150 in 12.30 s.
- **WU5 (2026-08-29).** Ohm's two-round review restored weakened semantic/API query-shape witnesses; Dalton approved docs and benchmark/probe policy. `bench:statements -- --check` passed in 6.36 s with the intentional clone miss, typecheck/Biome passed, and smoke passed 150/150 in 11.81 s; docs lint reported only the pre-existing `docs/AGENTS.md` root file.
- **WU6a (2026-08-29).** Three Ohm review rounds closed allocation-before-admission gaps and one false charge; the final source and `bench:memory` review was clean. Leased memory rows reported 23,666,688 transient bytes for initial write and 3,661,824 for redirect; typecheck/Biome passed and smoke passed 153/153 in 12.19 s.
- **WU6b (2026-08-30).** Four Ohm rounds closed authentication, decode, lifetime, repeated-allocation, transient-candidate, validation, and error-precedence gaps; final verdict CLEAN. Focused exact/+1, rollback, corruption, and reopen slices passed under four seconds; Biome/typecheck/diff/build passed and smoke passed 156/156 in 11.66 s. The leader gate also exposed and repaired a stale WU4 65th-range-read witness in `tests/plumbing-write.test.ts`; the test-only repair passed in 1.95 s with runtime unchanged.
- **WU6c-pre (2026-08-30).** Read-only design lanes found integration/history witnesses still depended on later tree-build and graph ceilings; Ohm approved the minimal topological correction, then reviewed the owner-aware prerequisite to CLEAN after fixing an accidental cardinality gate, allocation ordering, and corrupt `fs_nodes.type` materialization. The 111-test filesystem/worktree slice, typecheck, Biome, build, public exports, and smoke 157/157 passed; smoke took 12.55 s.
- **WU6c (2026-08-30).** Five Ohm passes closed allocation-order, ownership-transfer, double-charge, and iterator-cleanup findings; final verdict CLEAN. Exact/+1, rollback, and cold-reopen witnesses plus typecheck, Biome, diff, public exports, package smoke, and smoke 165/165 passed in 13.18 s; full suite deferred to closure.
- **WU6d (2026-08-30).** Review-to-clean closed allocation-order, ownership-transfer, double-charge, payload-preflight, iterator-cleanup, and rollback gaps across all lanes; no projected statement barrier was added. Focused former-bound and exact/+1 witnesses, typecheck, Biome, diff, build, public exports, package smoke, and smoke 166/166 passed in 14.05 s; full suite deferred to closure.
- **WU6e (2026-08-30).** Review-to-clean closed allocation-order, ownership, retry-cleanup, and iterator-finalization gaps; no projected statement barrier was added. Focused protocol/receive-pack/push/refspec/tag witnesses and routine gates passed, including smoke 166/166 in 13.76 s; full suite deferred to closure.
- **WU6f (2026-08-30).** CLI and shell reviews closed allocation ordering, string sizing, mutable input, discarded diagnostics, output coexistence, error precedence, and synchronous cleanup findings; both verdicts CLEAN. Focused input/output/redirect/cleanup witnesses and routine gates passed, including smoke 166/166 in 13.65 s; no statement barrier was added and full suite remains deferred to closure.

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

## Frozen evidence ledger

The accepted [budget-targets evidence ledger](../specs/budget-targets-evidence-ledger.md)
is incorporated into this sprint contract. The sprint's frozen policy contract
remains authoritative.
