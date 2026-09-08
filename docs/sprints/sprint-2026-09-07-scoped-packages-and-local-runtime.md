# Sprint — scoped packages and local runtime (2026-09-07)

**Goal.** Publish five `@kompjutr/*` packages and deliver a crash-recoverable
Unix local SQLite Git runtime without regressing the Durable Object filesystem.

**Theme.** Package ownership, drive independence, and local atomicity are one
change because each boundary is valid only when both runtime compositions pass
through the public package graph.

## Refs re-verified at HEAD (2026-09-07)

- ✔ One `Workspace` currently gives Git and filesystem the same database —
  `packages/do/src/runtime/workspace.ts:50-98`.
- ✔ Git's worktree type derives from the concrete `Filesystem` and exposes its
  database identity — `packages/git/src/ops/worktree/worktree.ts:4-34`.
- ✔ Native realpath and scan use one private WeakMap lookup before direct SQL —
  registration is at `packages/do/src/fs/filesystem.ts:250`, the registry is at
  `packages/do/src/fs/store/owned-read.ts:6-27`, ordinary traversal consumes it at
  `packages/git/src/ops/worktree/worktree-io-walk.ts:246-255`, and merge snapshot
  traversal consumes it at `packages/git/src/ops/merge/merge-apply-snapshot.ts:67-80`.
- ✔ Exact path state provenance crosses directly from Git into filesystem code —
  `packages/git/src/ops/worktree/worktrees.ts:1,187`.
- ✔ Sparse provenance records exact database identity and source kind at
  `packages/git/src/store/sparse/receipt.ts:3-30`; the selected-path, workspace, and
  commit-tree producers bind it at `packages/git/src/store/sparse/selection.ts:348-349`,
  `packages/git/src/store/sparse/workspace.ts:234-235`, and
  `packages/git/src/store/sparse/snapshot.ts:424-425`.
- ✔ Sparse consumers gate optimized status, staging, checkout, and tree building
  at `packages/git/src/ops/status/status-sparse.ts:102-178`,
  `packages/git/src/ops/staging/staging-selected.ts:139-187`,
  `packages/git/src/ops/checkout/sparse-checkout-operation.ts:101-131`, and
  `packages/git/src/ops/tree/tree-build-sparse.ts:221`.
- ✔ Executable Git SQL refers to `fs_*` only in sparse selection/hydration,
  tracker root validation, and tracker triggers —
  `packages/git/src/store/sparse/selection.ts:194-269`,
  `packages/git/src/store/sparse/workspace.ts:122-155`,
  `packages/git/src/store/indexes/index-tracker.ts:351-362`, and
  `packages/git/src/store/indexes/index-tracker-triggers.ts:138-186`.
- ✔ The optimized initial checkout writer is filesystem-owned and injected by
  Workspace — `packages/do/src/fs/store/initial-write.ts:38-95` and
  `packages/do/src/runtime/workspace.ts:75-88`.
- ⚠ Same-database checks cover clone and several CLI paths, but typed checkout,
  `readTree({ updateWorktree: true })`, and other coupled operation families rely
  on Workspace composition — `packages/git/src/ops/network/network-clone.ts:81-85`,
  `packages/git/src/cli/write/write-runtime.ts:71-77`, and
  `packages/git/src/client-factory.ts:19-44`. Typed checkout hydrates before its mutation
  guard at `packages/git/src/client-refs.ts:84-100`; `readTree({ updateWorktree: true })`
  enters checkout apply without affinity validation at
  `packages/git/src/ops/repository/plumbing.ts:86-140`.
- ✔ Shared code calls `transactionSync()` and never emits transaction SQL —
  `packages/do/src/db/db.ts:39-47,190-195` and
  `packages/git/src/store/core/mutation-guard.ts:7-24`.
- ✔ The package currently emits one `src` tree and one tarball —
  `package.json:1-75`, `tsconfig.build.json:1-10`, and
  `scripts/package-smoke.mjs:68-90`.
- ✔ Current post-checkout status baselines are 10–11 SQL statements, 8 rows, and
  0.834–0.975 ms medians — `docs/reference/benchmark-current.md:42-45`.
- ✔ The test adapter already demonstrates `node:sqlite` over the structural SQL
  interface — `tests/helpers/storage.ts`.

## Work units

### WU0 — Freeze the pre-change DO baseline (effort S)

- **Problem.** The curated benchmark predates HEAD, so a package-move comparison
  needs a same-machine, same-commit baseline.
- **Verify first.** Confirm a CPU lease is enforced and the Next.js fixture is
  available.
- **Scope.** Record HEAD, Node, SQLite, Git, kernel, and CPU affinity. Run three
  independent leased `bench:nextjs` measurements and copy the overwritten result
  after each run to `bench/results/baseline-head-{1,2,3}.json`. Run the
  deterministic statement check separately. These are a historical sanity
  baseline; WU10 also compares against a clean HEAD worktree under one
  order-balanced lease.
- **Acceptance / witness.** `cpu-lease run -n 2 --no-smt -- bash -lc 'for n in 1
  2 3; do npm run bench:nextjs && cp bench/results/nextjs-workflow.json
  bench/results/baseline-head-$n.json; done'` and `cpu-lease run -n 2 --no-smt
  -- npm run bench:statements -- --check` pass. Exact statement/row output and
  environment are recorded in the run log.
- **Touch points.** `bench/results/`, this sprint's run log.

### WU1 — Establish packages, shared contracts, and package smoke (effort L)

- **Problem.** One manifest and relative domain imports cannot prove installable
  or platform-isolated boundaries.
- **Verify first.** Inventory current entry exports, cross-domain imports, license
  files, and all concrete `Worktree` method uses.
- **Scope.** Create the private npm workspace root and all five manifests; move
  the SQLite contract/helpers and drive vocabulary; define minimal `GitDrive`,
  scan stream, native receipts, and mutation scope; update TypeScript project
  builds and package-aware import graph checks. Rewrite package smoke now to
  expect exactly `kompjutr-sqlite`, `kompjutr-drive`, `kompjutr-git`,
  `kompjutr-do`, and `kompjutr-local` tarballs and install those exact artifacts.
  Package smoke must remain green after every later manifest/export change.
- **Acceptance / witness.** `npx vitest run tests/import-graph.test.ts
  tests/public-exports.test.ts tests/file-ceiling.test.ts`, `npm run typecheck`,
  `npm run build`, and `npm run package:smoke` pass. Worker-entry graph tests
  reject Node-only builtins and the isolated consumers resolve no source file or
  registry copy of an internal package.
- **Touch points.** `package.json`, `package-lock.json`, `packages/sqlite/`,
  `packages/drive/`, TypeScript configs, `tests/import-graph.test.ts`,
  `tests/public-exports.test.ts`.

### WU2 — Relocate the generic Git package (effort L)

- **Problem.** Generic Git still imports concrete filesystem types and private
  filesystem receipts.
- **Verify first.** Re-run WU1 package smoke and inventory every Git-to-filesystem
  import plus the LGPL/dgit license files.
- **Scope.** Move generic Git into `@kompjutr/git`; replace concrete filesystem
  types and path helpers with `@kompjutr/drive`; keep generic sparse capability
  interfaces and fallback algorithms; preserve one public error constructor and
  all license attribution. Do not recompose DO or add mutation guards here.
- **Acceptance / witness.** `npx vitest run tests/import-graph.test.ts
  tests/public-exports.test.ts tests/store-module-exports.test.ts
  tests/plumbing-git-contract.test.ts tests/client.test.ts
  tests/git-cli-smoke.test.ts`, `npm run typecheck`, `npm run build`, and `npm run
  package:smoke` pass. The packed `@kompjutr/git` consumer installs without
  `@kompjutr/do`, and its ordinary entry cannot reach `do-fs`.
- **Touch points.** `packages/git/`, Git imports and entrypoints, licenses,
  package graph and focused tests.

### WU3 — Recompose DO and its hardcoded Git integration (effort L)

- **Problem.** Filesystem, shell, runtime, and mixed SQL must move without losing
  any DOFS-specific accelerator or creating a package cycle.
- **Verify first.** Inventory native registration, ordinary and merge snapshot
  scans, exact-state receipts, sparse receipt producers/consumers, mixed sparse
  SQL, tracker SQL/triggers, and initial checkout writer.
- **Scope.** Move filesystem, shell, DO adapter, runtime, Git-shell adapter, and
  testing helpers into `@kompjutr/do`. Move Git-owned mixed sparse/tracker code
  behind `@kompjutr/git/do-fs`. Register direct realpath/scan callbacks and exact
  state receipts from DOFS. Recompose Workspace exclusively through package
  exports. Do not add local code or coupled-operation guards here.
- **Acceptance / witness.** `npx vitest run tests/workspace.test.ts
  tests/runtime.test.ts tests/fs/filesystem.test.ts tests/worktree.test.ts
  tests/sparse-workspace.test.ts tests/index-tracker.test.ts
  tests/checkout-initial.test.ts tests/clone-initial.test.ts
  tests/shell/git.test.ts tests/import-graph.test.ts`, `npm run typecheck`, `npm
  run build`, and `npm run package:smoke` pass. Explicit tests prove both ordinary
  worktree and merge snapshot scans use native callbacks; receipts require exact
  database identity and kind; sparse/tracker paths stay optimized; initial
  checkout uses its writer; ordinary Git cannot transitively reach `do-fs`.
- **Touch points.** `packages/do/`, `packages/git/src/do-fs/`, Workspace,
  receipts, tracker/sparse modules, package and focused tests.

### WU4 — Enforce mutation scopes at every coupled boundary (effort L)

- **Problem.** Clone and some CLI commands check database identity, but typed and
  free APIs can reach drive writers after prior database or network effects.
- **Verify first.** Freeze the drive-writing subset of
  `GIT_MUTATION_BOUNDARY_INVENTORY` and the operation matrix in the accepted spec.
- **Scope.** Replace database equality with opaque mutation-scope affinity. Add
  preflight and lower-seam rechecks at every matrix row. Preserve Git-only and
  read-only operations without a writable scope. Inject failures at centralized
  writers for both client and CLI aliases.
- **Acceptance / witness.** `npx vitest run tests/mutation-scope.test.ts
  tests/transactions.test.ts tests/checkout-initial.test.ts
  tests/checkout-sparse.test.ts tests/staging.test.ts
  tests/plumbing-write.test.ts tests/merge-lifecycle.test.ts
  tests/cherry-pick.test.ts tests/revert.test.ts tests/rebase.test.ts
  tests/rebase-restart.test.ts tests/worktrees.test.ts tests/pull.test.ts
  tests/concurrency-clone.test.ts tests/git-cli-write.test.ts` passes. Every
  unsupported scope fails with zero committed database or drive effects,
  including checkout before hydration and pull before fetch publication.
- **Touch points.** Git client and operation boundaries, mutation-scope helpers,
  public inventory and focused tests.

### WU5 — Stop on any DO hot-path regression (effort M)

- **Problem.** Local work must not begin if package or scope changes altered the
  concrete relational path.
- **Verify first.** Inspect built entry graphs and compare deterministic profiles
  with WU0.
- **Scope.** Exercise native registration; ordinary and merge snapshot scans;
  exact-state and sparse receipts; mixed sparse SQL; tracker triggers/root
  resealing; initial checkout; and statement/row profiles.
- **Acceptance / witness.** `npx vitest run tests/worktree.test.ts
  tests/merge-apply.test.ts tests/sparse-workspace.test.ts
  tests/index-tracker.test.ts tests/checkout-initial.test.ts
  tests/clone-initial.test.ts tests/import-graph.test.ts` and `cpu-lease run -n 2
  --no-smt -- npm run bench:statements -- --check` pass with no frozen count
  change. Native scan retains one receipt lookup and one SQL statement per page.
- **Touch points.** Integration code only if a witness exposes drift.

### WU6 — Add the Unix SQLite adapter, lock, and ordered DiskDrive (effort L)

- **Problem.** The test SQL adapter is not production-owned, and host traversal
  has neither indexed order nor bounded whole-tree behavior.
- **Verify first.** Pin Node 24 `node:sqlite` transaction/blob behavior and Unix
  path/error behavior with focused probes.
- **Scope.** Implement the Node adapter, state schema, kernel-released lifetime lock,
  virtual/host path mapping, persistent observation revision leases, GitDrive
  reads and bulk writes, and fixed-memory external sorting for wide directories.
- **Acceptance / witness.** `npx vitest run tests/local/sqlite.test.ts
  tests/local/lock.test.ts tests/local/disk-drive.test.ts
  tests/local/disk-scan.test.ts` and `npm run package:smoke` pass. Cases cover
  SQLite nesting/BLOBs, UTF-8 order, invalid byte names, symlinks, root escape,
  wide/deep bounded traversal, spill cleanup, post-crash takeover, live rejection,
  same-size/timestamp-adjacent edits, and disk bulk operations.
- **Touch points.** `packages/local/src/sqlite/`,
  `packages/local/src/drive/`, `tests/local/`.

### WU7 — Implement generation-backed disk recovery (effort L)

- **Problem.** Independent SQLite and disk commits can expose a partially
  materialized worktree after failure or process death.
- **Verify first.** Enumerate every Git drive writer and inject a late ordinary
  exception through each representative mutation shape.
- **Scope.** Implement length/checksum-framed intent records, durable initial and
  append boundaries, whole-batch device preflight, and a crash-cleanable live
  rename probe for every distinct source-parent/recovery pair. Implement
  first-touch backup renames, parent creation tracking, synced replacement and
  directory operations, reverse rollback, generation publication,
  uncertain-commit reopen/settlement, and idempotent synced cleanup. Add
  deterministic process-kill checkpoints for every durability transition named
  by the accepted spec.
- **Acceptance / witness.** `npx vitest run tests/local/recovery.test.ts
  tests/local/recovery-crash.test.ts tests/local/recovery-device.test.ts
  tests/mutation-scope.test.ts` and `npm run test:local-mounts` pass. The matrix
  covers initial creation and every append, torn final frames, semantic
  corruption, probe placement/cleanup, backup/replacement/deletion, both
  reported-commit-error outcomes, both committed generations, every cleanup
  step, different-device `EXDEV`, and same-device distinct bind mounts with zero
  pre-existing caller entry/content or committed Git effects after settlement.
  Tests allow the documented probe-name, directory-metadata, and filesystem-event
  observations. The Linux mount witness runs in an isolated privileged mount
  namespace; fault injection covers hosts where that fixture is unavailable.
- **Touch points.** `packages/local/src/recovery/`, Node adapter transaction owner,
  DiskDrive mutations, `tests/local/recovery*.test.ts`.

### WU8 — Compose and qualify LocalWorkspace (effort L)

- **Problem.** The components are not useful until the public local composition
  survives real Git workflows and reopen boundaries.
- **Verify first.** List operations that have real-Git differential harnesses and
  those needing explicit local-only recovery assertions.
- **Scope.** Add `LocalWorkspace`, public lifecycle, generic fallback providers,
  local Git parity journeys, reopen and second-process tests, plus a local
  benchmark fixture reporting traversal, hash, SQL, wall, and memory metrics.
- **Acceptance / witness.** `npx vitest run tests/local/workspace.test.ts
  tests/local/git-parity.test.ts tests/local/restart.test.ts
  tests/local/process-lock.test.ts`, `npm test`, and `cpu-lease run -n 2 --no-smt
  -- npm run bench:local` pass. Init, clone, status, add, commit, checkout, reset,
  merge, cherry-pick/revert, rebase, clean, and linked-worktree scenarios are
  covered; restart and contention pass; the benchmark reports traversal, hashes,
  SQL, wall, and peak memory without claiming DO parity.
- **Touch points.** `packages/local/src/workspace.ts`, `tests/local/`, local bench
  harness and scripts.

### WU9 — Finish release automation and living docs (effort M)

- **Problem.** Passing package smoke is not enough to publish lockstep artifacts
  safely or explain the new public surfaces.
- **Verify first.** Inspect every packed file list and dependency version from
  `npm pack --json`.
- **Scope.** Validate lockstep versions and publish verified WU1 tarballs in
  dependency order through CI OIDC. Rewrite README and living architecture,
  concurrency, benchmark, and release references; remove obsolete
  single-package statements.
- **Acceptance / witness.** `npx vitest run tests/release-gate.test.ts
  tests/import-graph.test.ts tests/public-exports.test.ts`, `npm run
  package:smoke`, `npm run build`, `npm run typecheck`, and `npm run check` pass.
  Scope ownership is recorded as the only external publication prerequisite.
- **Touch points.** Package manifests/readmes/licenses, packaging scripts,
  workflows, root README, `docs/reference/`.

### WU10 — Final regression and sprint closure (effort M)

- **Problem.** Cross-package and recovery changes need one integrated verdict,
  including the exact DO performance promise.
- **Verify first.** Ensure all focused failures are settled before broad gates.
- **Scope.** Run smoke, full suite once, package smoke, deterministic statements,
  and an order-balanced wall comparison. Create a clean detached worktree at the
  WU0 HEAD under `/tmp/opencode`, install its exact lockfile, then run baseline and
  candidate in order `B,C,C,B,B,C` under one lease. Copy each overwritten JSON to
  `/tmp/opencode/kompjutr-nextjs-comparison/{baseline,candidate}-{1,2,3}.json`.
  Additional adjudication samples use suffixes 4 through 7. Compare every
  identically named successful row.
  The wall estimator is the sum of corresponding operation medians for each
  side. The candidate passes when its total is no greater than the baseline
  total plus 5%. Individual phase medians remain diagnostics because reducing
  allocation can move a V8 collection between adjacent phases. A failed total
  triggers four additional order-balanced runs per side; the median-of-seven
  total uses the same threshold and still blocks on failure. Node, SQLite, Git,
  kernel, fixture revision, and enforced CPU affinity must match or the
  comparison is invalid. Deterministic statement/row equality for every phase
  is a separate hard gate.
- **Acceptance / witness.** `npm test`, `cpu-lease run -n 8 -- env
  GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true npm run test:full`, `npm run check`,
  `npm run typecheck`, `npm run build`, `npm run package:smoke`, `cpu-lease run
  -n 2 --no-smt -- npm run bench:statements -- --check`, and the saved leased
  order-balanced Next.js comparison all pass. Statement/row counts are identical;
  total wall time is inside the declared noise envelope; OUTCOME records exact
  results and honest deferrals.
- **Touch points.** Tests, `docs/reference/benchmark-current.md`, sprint lifecycle
  and documentation indexes.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Public packages, two runtimes, and crash semantics can each pass alone but fail in composition. | Independent plan review before code; independent final review-to-clean of the complete diff; smoke, full, package, statement, and order-balanced leased benchmark gates. | Any package cycle, Node leak, recovery uncertainty, or DO cost drift blocks closure. |
| WU0 | Read-only measurement. | Lease verification and benchmark self-checks. | Fixture or host mismatch prevents a comparable baseline. |
| WU1 | Public dependency, artifacts, and type identity boundary. | Exact witnesses plus self-review; include in the WU1–WU3 independent review-to-clean. | A shared type requires a reverse dependency, duplicate runtime constructor, or smoke cannot stay green. |
| WU2 | Fundamental generic Git relocation. | Exact witnesses plus self-review; include in the WU1–WU3 independent review-to-clean. | Git needs a DO dependency or attribution is lost. |
| WU3 | Fundamental DO/`do-fs` extraction. | Exact accelerator witnesses, then independent WU1–WU3 review-to-clean; repeat after material boundary fixes. | Any optimized path falls back, package cycle appears, or ordinary Git reaches `do-fs`. |
| WU4 | Atomicity preflight across every public alias. | Exact mutation matrix plus independent review-to-clean; repeat after boundary movement. | Any coupled path has committed effects before preflight or escapes the inventory. |
| WU5 | Explicit performance stop gate. | Deterministic statement check, entry-graph inspection, and self-review; do not proceed on drift. | Any count changes or ordinary Git reaches `do-fs`. |
| WU6 | Host path, lock, and bounded traversal safety. | Adversarial exact witnesses plus independent review-to-clean; repeat after path/lock changes. | A path can escape root, device checks are incomplete, or traversal materializes unbounded tree state. |
| WU7 | Crash consistency is the highest-risk new behavior. | Deterministic exception/kill/mount matrix plus independent review-to-clean; every material protocol fix is re-reviewed. | Any outcome cannot be classified old or new after reopen, or rename compatibility relies only on `st_dev`. |
| WU8 | Broad behavior across a new composition. | Real-Git differential journeys, local restart witnesses, and self-review. | Generic fallback diverges or a coupled writer lacks scope validation. |
| WU9 | Published supply-chain and documentation boundary. | Exact packed consumers, workflow witnesses, and self-review. | Smoke reaches source files, registry internal packages, or Node builtins from Worker entries. |
| WU10 | Release-candidate integration. | Independent complete-diff review-to-clean, then closure cadence exactly once. | Focused failures remain or benchmark environments are not comparable. |

## Test cadence

- **Per WU.** Run the exact acceptance witness and only the affected stable slice.
- **Routine integration.** Run `npm test`; keep the gate below 30 seconds.
- **Package boundaries.** Run import/export witnesses and `npm run package:smoke`
  whenever an entry point or manifest changes.
- **Performance.** Run deterministic statements at WU0, WU5, and WU10. Run wall
  benchmarks only under `cpu-lease` at WU0 and WU10.
- **Sprint closure.** Run `cpu-lease run -n 8 -- env GIT_EDITOR=true
  GIT_SEQUENCE_EDITOR=true npm run test:full` once after focused fixes and
  independent review settle, followed by build, package smoke, statements, and
  the leased wall comparison.
- **Failure loop.** Reproduce a broad failure in its exact file or package. Do not
  rerun full or benchmark gates until the focused witness is stable.

## Out of scope (explicit)

- Windows and network-filesystem recovery semantics.
- Conventional `.git` import/export and a drop-in Git executable.
- Concurrent local writers, shared read locks, and Git-compatible fine-grained
  lock files.
- Containment against a process that ignores the lifetime lock and concurrently
  replaces checked directory ancestors or fixed state artifacts.
- Pre-existing bind-mounted aliases of nested worktree, state, or recovery
  directories; exact aliases remain rejected.
- Disk metadata mirrors, watchers, and clean-status optimization beyond correct
  bounded hashing.
- Independent package version cadences or an unscoped compatibility facade.

## Decisions

- Five lockstep `@kompjutr/*` packages and the isolated DO integration subpath —
  [ADR-0020](../decisions/0020-publish-runtime-boundaries-as-scoped-packages.md).
- Lifetime Unix lock and generation-backed undo journal —
  [ADR-0021](../decisions/0021-recover-local-worktree-mutations-with-an-undo-journal.md).
- The accepted implementation contract is
  [`scoped-packages-and-local-runtime.md`](../specs/scoped-packages-and-local-runtime.md).

## Sequencing

WU0 precedes every source edit. WU1 establishes manifests, contracts, and the
multi-package smoke gate. WU2 relocates generic Git; WU3 recomposes DO and then
receives one independent extraction review. WU4 freezes and guards mutation
scopes. WU5 is the performance stop gate before local work. WU6 provides the
host components WU7 wraps; WU8 composes them. WU9 follows stable public surfaces.
WU10 runs only after every focused gate and independent review is settled.

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
the package graph, every existing hardcoded DOFS integration, mutation coverage,
recovery protocol, witnesses, and review gates.

- **Reviewer:** general agent `ses_f83eba7f7ffeWoWMmZlUILaJ1U`
- **Verdict:** approved after three correction rounds
- **Material findings:** Required torn-tail-safe framing, explicit fsync and
  uncertain-commit settlement, same-device preflight, a frozen coupled-operation
  matrix, package smoke in WU1, smaller extraction WUs, literal witnesses,
  defined wall comparison, and stronger review-to-clean gates. Re-review then
  required rename proof beyond `st_dev` and consistent probe journaling/observable
  guarantees. All findings are resolved; the reviewer reported no blockers.

## Run log

- 2026-09-07 — User approved five packages, generation-backed undo recovery, and
  lockstep versions. No backward-compatible `kompjutr` facade is required.
- 2026-09-07 — Initial independent plan review blocked implementation on journal
  framing/durability, device preflight, mutation inventory, smoke sequencing,
  executable witnesses, benchmark policy, and review strength. The plan and spec
  were corrected. Two re-review rounds tightened mount/rename proof and probe
  observability; the final verdict is approved with no actionable blockers.
- 2026-09-07 — WU0 ran at HEAD `d0c059ce` with Node 24.4.0, SQLite 3.50.2, Git
  2.54.0, Linux 6.17.0-41, and a two-vCPU no-SMT lease. Three Next.js samples
  were saved under `bench/results/baseline-head-{1,2,3}.json`. The deterministic
  check exposed frozen values left behind by post-snapshot feature work: current
  semantics passed, but several statement/row profiles and the three Next.js
  reference rows no longer matched. The frozen gate was rebased to repeated WU0
  HEAD measurements before package source changes.
- 2026-09-07 — WU1–WU5 established the five-package workspace, moved generic Git
  and the DO runtime to their declared owners, isolated `do-fs`, replaced
  concrete database identity checks with opaque mutation scopes, and froze the
  21-operation coupled-mutation inventory. Build, package smoke, import graph,
  public exports, mutation scope, and deterministic statement witnesses pass.
- 2026-09-07 — WU6–WU8 added `LocalWorkspace`, `node:sqlite`, conservative disk
  observations, Unix process locking, observed-symlink containment, bounded
  multi-level external sorting, generation-backed undo recovery, crash/mount
  witnesses, and real-Git local parity. The privileged bind-mount witness skips
  because this host rejects user mount namespaces; injected `EXDEV` and a real
  `/dev/shm` different-device witness pass.
- 2026-09-07 — Independent safety review found user-space stale-lock takeover,
  rollbackable observation leases, unbound recovery identity, async transaction
  continuation, backup sync ordering, replacement exclusivity, traversal-frontier,
  and path-race issues. The user selected pure-JavaScript best-effort containment
  rather than a native `openat` boundary. The lock now uses a kernel-released
  SQLite exclusive transaction; the other actionable protocol findings have
  focused witnesses. Hostile concurrent ancestor replacement is explicitly out
  of scope.
- 2026-09-07 — Safety re-review found that per-state locks did not exclude two
  configurations of one root, caught nested async results could still commit,
  empty forced spills failed, and rollback cleanup lacked direct crash points.
  The lock is now root-keyed, async detection is sticky through the outer
  transaction, empty spills return directly, and kill/reopen tests cover
  rollback restoration, deletion, temporaries, probes, and cleanup. Static
  nested bind aliases are documented as unsupported because portable Node has no
  mount-aware ancestry API.
- 2026-09-07 — A leased local qualification over 2,500 files measured 23.256 ms
  and zero SQL rows for ordered traversal, then 321.764 ms, 18 statements, and
  10,009 rows for clean conservative status; whole-process peak RSS was
  200,892,416 bytes.
- 2026-09-07 — The first WU10 median-of-seven wall comparison found identical
  deterministic medians but blocked on `git.branch` and `git.diff (100)` timing.
  Investigation found that package extraction had routed bounded DO `all()`
  calls through reflective cursor iteration. Restoring native cursor
  materialization with shared row normalization retained deterministic counts;
  a leased diagnostic sample measured 4.706 ms and 48.036 ms respectively.
  The final balanced comparison remains pending after review settles.
- 2026-09-08 — Two review-to-clean tracks found and resolved structural scan
  ordering, nested-root exclusion, bounded journal framing, low-level path
  validation, and linear recovery-settlement defects. The final recovery and
  package re-reviews reported no findings. The unprivileged bind-mount witness
  remains unavailable because this host rejects user mount namespaces.
- 2026-09-08 — Repeated leased comparisons showed exact per-phase SQL/row
  parity but unstable phase wall medians as lower row-normalization allocation
  moved V8 collection between clone, diff, add, and status. The user approved a
  workflow-total wall gate with per-phase counts still hard. In the final seven
  order-balanced samples, candidate operation medians totalled 15,682.580 ms
  versus 16,580.647 ms for baseline, a 5.416% reduction. Both sides produced
  clone profile 2,381/79,273 six times and the exact +2 statements/+1 row
  alternate once.
