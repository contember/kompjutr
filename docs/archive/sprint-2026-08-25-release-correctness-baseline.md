> **OUTCOME — shipped 2026-08-25.** CI now verifies the functional suite,
> production build, and one exact package tarball on every pull request and push
> to `main`; a tag workflow is checked in to repeat those gates before its OIDC
> publish job. SQLite foreign keys are explicit, persisted OIDs remain TEXT by
> measured decision, ordinary empty commits fail closed, and native `rm` uses
> Git-safe defaults while the compatibility facade keeps its declared contract.
> Commit map: plan → `5938935`; WU1 → `983eecd`; WU2 → `55c78d3`; WU3 →
> `bebaf6f`; WU4 → `573f75d`; WU5 → `d5c8d74`; integration fixes → `7f1b6b0`;
> docs integration → `b9b48d1`; hosted-gate fixes → `06ab593`, `9af6c51`.
> Verification: local check, typecheck, build, exact-tarball smoke, and leased
> full suite; hosted CI run
> [32873652211](https://github.com/contember/kompjutr/actions/runs/32873652211)
> passed 95 files and 1,674 tests with 5 intentional skips, then built and
> smoke-tested the package. Backlog closed: 05, 19, 22, 30, and 32. Deferred:
> the `npm` GitHub environment, npm trusted publisher, first version/tag and
> publication, the production Durable Object probe, storage-key rebuilds, and
> wall-time work including one isolated 120.36 ms read-gate signal.

# Sprint — Release correctness baseline (2026-08-25)

**Goal.** Make a green result trustworthy before the first serious release: CI
must test the packed artifact, SQLite enforcement must be explicit, Git mutation
defaults must stop reporting false success, and the persisted OID representation
must be decided from measurements.

**Theme.** Each work unit closes a place where kompjutr currently returns or
records a plausible success without proving the corresponding release, platform,
or Git contract. Success means a clean checkout can produce one verified
tarball, test and runtime SQLite agree on foreign keys, ordinary commit and
native `rm` match Git's safe defaults, and OID storage has an accepted ADR before
production data makes the choice expensive.

Scheduled backlog: 05, 19, 22, 30, and 32. All five items closed with this
sprint.

## Refs re-verified at HEAD (2026-08-25, `6236815`)

- ✔ There is no checked-in `.github/` workflow. The package is still `0.0.0`,
  while `check`, `typecheck`, `test`, and `build` already exist as independent
  scripts — `package.json:3`, `package.json:43`.
- ⚠ `npm pack --dry-run --json` succeeds locally, but `dist/` is ignored and no
  built file is tracked. The result therefore depends on local build residue and
  does not prove that a clean checkout can build and package every declared
  export — `.gitignore:2`, `package.json:8`, `package.json:36`.
- ✔ The current public-export test compares selected source-level types from only
  the root and Git entry points. It does not install the tarball or import the
  root, `fs`, `git`, `shell`, `testing`, and optional compatibility exports as an
  external consumer — `tests/public-exports.test.ts:1`,
  `tests/public-exports.test.ts:76`.
- ⚠ The foreign-key backlog premise has drifted. The schema declares one
  cascading deferred FK and kompjutr never sets `PRAGMA foreign_keys`, while the
  Node harness reports it enabled. A locally checked workerd revision also builds
  SQLite with `SQLITE_DEFAULT_FOREIGN_KEYS=1`; actual adapter state must therefore
  be measured before changing schema — `src/sqlite/schema.ts:355`,
  `src/sqlite/db.ts:96`, `tests/helpers/storage.ts:108`,
  `workerd/build/BUILD.sqlite3:16` at `8ae9e49a5`.
- ✔ Schema v11 stores OIDs as 40-character `TEXT` across commit, ref, index,
  loose-object, pack, and parsed-tree tables. Core APIs use hex strings, so a
  BLOB choice would move conversion into the SQLite boundary rather than the
  Git engine — `src/sqlite/schema.ts:46`, `src/sqlite/schema.ts:50`,
  `src/sqlite/schema.ts:150`, `src/sqlite/schema.ts:170`,
  `src/sqlite/schema.ts:270`, `src/sqlite/schema.ts:313`,
  `src/sqlite/schema.ts:344`.
- ⚠ Not every OID-shaped field is a scalar key: `git_commits.parents` encodes an
  ordered list in one `TEXT` column. A BLOB prototype must inventory compound
  representations instead of applying a mechanical column-affinity rewrite —
  `src/sqlite/schema.ts:155`.
- ✔ `commit()` rejects an empty message and unmerged index, then always builds a
  tree and publishes a commit. `CommitOptions` has no `allowEmpty`; the existing
  parity fixture reaches today's behavior only by giving real Git
  `--allow-empty` — `src/core/ops/commit.ts:17`, `src/core/ops/commit.ts:73`,
  `src/core/ops/commit.ts:118`, `tests/commit.test.ts:185`.
- ⚠ An empty root commit is not a Git exception: real Git refuses it without
  `--allow-empty`. Only a root commit whose projected tree is non-empty succeeds
  by default, so the old backlog wording was too broad.
- ✔ Merge completion has its own authenticated lifecycle and calls
  `commitIndex()` directly. The ordinary empty-commit guard must not block a
  completed merge, including a tree-identical merge commit —
  `src/git/client.ts:322`, `src/core/ops/merge.ts:652`,
  `src/core/ops/merge.ts:679`.
- ✔ `rm()` currently ignores its worktree argument and removes only index rows;
  the test explicitly compares it with `git rm --cached`. The filesystem already
  exposes a six-statement bounded bulk removal inside `transactionSync()` —
  `src/core/ops/staging.ts:229`, `src/core/ops/staging.ts:237`,
  `tests/staging.test.ts:250`, `src/fs/store/remove.ts:98`,
  `src/fs/store/remove.ts:152`.
- ⚠ Native and Computer clients currently call the same `rm` operation, but the
  installed Computer contract describes `paths` as paths to unstage. Native
  defaults may change to Git semantics only if the compatibility facade keeps
  the existing cached-only contract — `src/git/client.ts:307`,
  `src/compat/computer/client.ts:142`, `package.json:58`.
- ✔ The targeted baseline is green: schema migration, commit, staging, client,
  and public-export suites pass at HEAD — 5 files and 85 tests.

## Work units

### WU1 — Establish CI, package, and release gates (effort M)

- **Problem.** The repository has local scripts and declared package exports but
  no clean-checkout automation, no exact-tarball consumer test, and no CI-only
  tag release path — `package.json:8`, `package.json:36`, `package.json:43`.
- **Verify first.** From a clean temporary checkout, run `npm ci`, build, create
  a tarball, list its files, and install that exact tarball into two isolated
  consumers. Inventory which export can load without `@cloudflare/computer` and
  which one deliberately requires the optional peer. Record the current failure
  before adding workflows.
- **Scope.** Add PR/default-branch CI for `npm run check`, `npm run typecheck`, the
  full suite, and the production build. Add a package-smoke command that always
  builds before packing, installs the exact tarball without the optional peer and
  imports `.`, `fs`, `git`, `shell`, and `testing`, then installs the peer in a
  second consumer and imports `compat/computer`. Add a tag-driven release
  workflow that validates `v<package-version>`, rejects `0.0.0`, repeats the
  artifact gate, and publishes only from a protected CI environment. Keep
  benchmark jobs outside ordinary CI. Document the maintainer toolchain,
  supported Workers runtime, release sequence, and the no-local-publish rule.
- **Acceptance / witness.** A fresh checkout produces one tarball and both
  isolated consumers import their allowed exports. Removing an export, omitting
  a declaration, or leaking the optional peer into a standalone entry makes the
  smoke gate fail. PR CI runs all four repository gates. The release workflow
  cannot reach publish for a mismatched tag, `0.0.0`, a failed gate, or without
  its protected environment.
- **Touch points.** `.github/workflows/`, `package.json`, package-smoke fixture or
  script, `tests/public-exports.test.ts`, `README.md`, new
  `docs/reference/release.md`, `docs/reference/README.md`.

### WU2 — Pin one foreign-key contract across adapters (effort S/M)

- **Problem.** Foreign-key behavior is implicit. The original backlog assumed
  production was off, but current workerd evidence points to an on-by-default
  build. Neither fact is an application-owned contract, so an adapter or runtime
  upgrade can silently change what schema tests prove — `src/sqlite/schema.ts:355`,
  `src/sqlite/store.ts:1128`, `tests/helpers/storage.ts:108`.
- **Verify first.** Query `PRAGMA foreign_keys` through `TestDatabase`, the native
  `Database`, the Computer provider adapter, and a real local workerd Durable
  Object before schema creation, after initialization, and after reopen. In each
  adapter, attempt one orphan insert and one source deletion with explicit delete
  helpers disabled in the fixture. Inventory every current explicit tree-entry
  cleanup before choosing a mode.
- **Scope.** Record ADR 0004 choosing enforced everywhere or nowhere. Prefer
  explicit enforcement when every supported adapter accepts the pragma; choose
  no FK only if a supported production adapter cannot honor the same contract.
  Under enforcement, set and assert the pragma before schema initialization and
  keep explicit cleanup as defense in depth. Under no enforcement, rebuild the
  affected table without the FK and configure the Node harness accordingly.
  Either path must make fresh, migrated, native, and compatibility databases
  report the same state. Add the chosen state to backlog 11's future production
  probe requirements.
- **Acceptance / witness.** One adapter matrix asserts the selected pragma state
  and behavior, not just schema text. Enforced mode proves cascade behavior for
  loose and packed tree sources; unenforced mode proves an empty
  `foreign_key_list` plus explicit cleanup. Schema migration tests preserve a
  v11 repository with loose and packed sources. ADR 0004 records the evidence,
  rejected alternative, and the condition that would reopen the decision.
- **Touch points.** `src/sqlite/store.ts`, possibly `src/sqlite/schema.ts` and
  `src/sqlite/db.ts`, `src/compat/computer/client.ts`, `tests/helpers/storage.ts`,
  local workerd probe, `tests/schema-migration.test.ts`, pack/tree tests,
  `docs/decisions/0004-*.md`, `docs/decisions/README.md`, backlog 11.

### WU3 — Measure and decide the persisted OID encoding (effort L)

- **Problem.** Schema v11 repeats 40-byte hex text in primary and secondary keys,
  but the repository has no evidence that 20-byte BLOB keys reduce total storage
  or wall time enough to offset conversion and migration complexity —
  `src/sqlite/schema.ts:46`, `src/sqlite/schema.ts:270`,
  `src/sqlite/schema.ts:313`, `src/sqlite/schema.ts:355`.
- **Verify first.** Freeze the standard fixture revision and enumerate every OID
  column and every SQLite/core boundary conversion. Prove that the comparison
  harness creates logically identical databases and traverses identical rows
  before accepting timing or size numbers.
- **Scope.** Time-box a representative TEXT-versus-BLOB prototype for total
  database bytes, major table/index bytes where SQLite exposes them, commit/tree
  traversal wall time, and conversion overhead at reads and writes. Cover both
  the packed Next.js fixture and a loose-object fixture so pack payload does not
  hide the signal. Merely changing column affinity while still binding strings is
  not a valid BLOB variant. Run repeated measurements under `cpu-lease run -n 2
  --no-smt`; do not use unleased timing. Record raw evidence and ADR 0005. Keep
  TEXT unless the measured end-to-end storage or traversal benefit is material
  enough to justify converting every persisted key. Do not land the schema-wide
  BLOB migration in this sprint.
- **Acceptance / witness.** The benchmark reproduces from one command, reports
  fixture revision, environment, repetitions, database bytes, traversal timing,
  and conversion work for both variants, and rejects non-equivalent row sets.
  ADR 0005 chooses one encoding and states what result would reverse it. If TEXT
  wins, close backlog 22. If BLOB wins, narrow backlog 22 to a bounded v11
  migration scheduled with backlog 21.
- **Touch points.** `bench/`, `docs/decisions/0005-*.md`,
  `docs/decisions/README.md`, `docs/reference/benchmark-current.md`, backlog 22;
  production schema files are read-only in this unit.

### WU4 — Refuse ordinary empty commits (effort S)

- **Problem.** Ordinary `commit()` publishes when its projected index tree equals
  its parent tree, and there is no opt-in spelling for the current behavior —
  `src/core/ops/commit.ts:17`, `src/core/ops/commit.ts:73`,
  `src/core/ops/commit.ts:142`.
- **Verify first.** Pin real Git outcomes and public state for an empty unborn
  repository, a non-empty root commit, an unchanged second commit, content
  restaged to the same OID, metadata-only amend, explicit `--allow-empty`, and a
  tree-identical merge continuation. Decide and document the stable failure code
  before callers can depend on it.
- **Scope.** Add `allowEmpty` to the native commit option. During ordinary commit,
  compare the newly materialized tree with the first parent's authoritative tree,
  or with the canonical empty tree for an unborn HEAD, inside the existing
  transaction. Fail with `EEMPTYCOMMIT` before ref publication unless the caller
  opted in. Preserve non-empty root commits, metadata-only amend, unpublished
  replay commits, and merge completion. Keep the installed Computer surface
  compatible; it gains the safer default but no undeclared option.
- **Acceptance / witness.** Differential tests match Git for every verify-first
  case, including refusal of an empty root and success of a non-empty root.
  Refusal leaves refs, object visibility, index, worktree, and operation state
  unchanged and returns `EEMPTYCOMMIT`. `allowEmpty` produces the same commit OID
  as Git. Existing merge, replay, rebase, and scale/cost tests remain green
  without extra scalar index reads.
- **Touch points.** `src/core/ops/commit.ts`, `src/git/client.ts`,
  `src/compat/computer/client.ts`, `tests/commit.test.ts`, `tests/client.test.ts`,
  integration lifecycle tests, `docs/reference/git-support.md`.

### WU5 — Give native `rm` Git-safe semantics (effort M/L)

- **Problem.** Native `rm` is named like `git rm` but behaves only as
  `--cached`, performs no HEAD/index/worktree safety comparison, and does not
  exclude nested repository roots — `src/core/ops/staging.ts:229`,
  `src/core/ops/staging.ts:237`, `src/git/client.ts:303`.
- **Verify first.** Pin real Git state and errors for clean removal, cached
  removal, index different from HEAD, worktree different from index, both sides
  different, force, directory pathspec with and without `-r`, last-file directory
  pruning, a directory retaining an untracked file, symlink, gitlink/nested
  repository boundary, unmatched pathspec, unmerged entries, and exact
  retained-byte and statement limits. Separately pin the installed Computer
  client's cached-only, implicitly recursive contract.
- **Scope.** Add native `cached`, `force`, and `recursive` options. Native
  directory removal refuses without `recursive`, matching Git. Use sorted
  HEAD/index/worktree streams and batched hashing to reject unsafe removals
  without scalar reads. Once validated, remove worktree paths through the bounded
  bulk filesystem API and remove index rows in one outer `transactionSync()`;
  extract or reuse checkout's empty-directory pruning without deleting a
  directory that retains untracked content or crossing the repository or
  nested-root boundary. Keep the existing retained-state ceiling and fail closed
  when the safety proof exceeds a bound. Pass `cached: true` and `recursive: true`
  explicitly from the Computer facade so its declared and current behavior does
  not change.
- **Acceptance / witness.** Real Git parity covers every verify-first case on the
  native surface. Fault injection proves index and filesystem removal roll back
  together. A large-tree test forbids scalar worktree methods and stays below the
  operation statement and retained-byte caps. Compatibility tests prove Computer
  still leaves working-tree bytes untouched.
- **Touch points.** `src/core/ops/staging.ts`, `src/git/client.ts`,
  `src/compat/computer/client.ts`, `src/core/worktree.ts`, possibly a bounded
  filesystem directory-prune seam extracted from `src/core/ops/checkout.ts:470`,
  `tests/staging.test.ts`, `tests/client.test.ts`, `tests/compat.test.ts`,
  `docs/reference/git-support.md`.

## Out of scope (explicit)

- The schema-wide OID migration. A BLOB decision becomes a narrowed follow-up to
  run with backlog 21, so keyed tree tables are rebuilt once.
- Parsed-tree key narrowing, `git_blob_ids` lifecycle, and write-time CHECKs —
  backlogs 20, 21, and 23.
- Full production Durable Object release probing and the concurrent/restart
  matrix shipped later in the [production probe](sprint-2026-08-27-production-do-probe.md)
  and [concurrency sprint](sprint-2026-08-27-concurrency-and-restart-conformance.md).
  WU2 owns only the focused local workerd FK witness needed for its decision.
- Worktree wall-time optimization and timing gates in ordinary CI — backlog
  [10](sprint-2026-08-27-worktree-performance-and-budget.md).
- Unmerged status and exact rename detection shipped independently in the
  [status and rename correctness sprint](sprint-2026-08-25-status-and-rename-correctness.md).
- Creating the first version tag, changing `0.0.0`, or publishing a release while
  running this sprint. WU1 creates the CI-only path; a later explicit release
  action uses it.
- Changing Computer's `rm` option type or cached-only behavior. Its installed
  compatibility contract is preserved deliberately.

## Decisions

- The sprint includes backlog 30 after the four release-baseline units; it is no
  longer a stretch item. Backlog 31 remains separate because its status type and
  porcelain changes are a larger public seam.
- CI tests the exact freshly built tarball. Source imports and a local
  `npm pack` over ignored build residue are not release witnesses.
- Foreign keys default to explicit enforcement if all supported adapters accept
  it. The alternative, removing the FK everywhere, is valid only when a supported
  production adapter cannot honor enforcement. ADR 0004 owns the final choice.
- OID representation remains TEXT during this sprint. ADR 0005 may select BLOB,
  but implementation waits for the coordinated table rebuild with backlog 21.
- Native `rm` takes Git's remove-and-unstage default. The Computer facade keeps
  its documented cached-only and current implicitly recursive behavior by
  selecting those options explicitly.
- Ordinary empty commit refusal uses stable code `EEMPTYCOMMIT`; the explicit
  native `allowEmpty` option is the only ordinary bypass. Amend and integration
  commit seams retain their existing behavior.
- No release or benchmark runs from an unleased or local publish path. CI owns
  package publication; CPU-leased commands own reported timing.

**Planning alternative rejected.** A feature-only sprint containing 30–32 would
close visible parity gaps faster, but it would leave no trustworthy artifact gate
and would make schema decisions after more data accumulates. A gates-only sprint
would be smaller, but would knowingly bless two false-success mutation defaults.
The combined baseline wins on release confidence while each work unit remains
independently testable and reversible.

**Revisit the scope if** the package is not intended to approach a release, or if
the OID comparison cannot measure boundary conversion without first implementing
the full migration. In the latter case, stop WU3 after the harness feasibility
check and ask before expanding its write scope.

## Sequencing

Effort labels describe uncertainty and blast radius, not human days. Plan the
sprint as roughly ten focused agent passes. A routine pass should take about
10–25 minutes of active agent time; CI, leased benchmarks, and external runner
queues add wall time but not implementation effort. This estimate is a planning
budget, not an acceptance criterion.

| Wave | Unit | Agent passes | Depends on | Write territory | Done-check |
|---|---|---:|---|---|---|
| 0 | WU1 CI/artifact gate | 2 | none | workflows, package smoke, release reference | clean-checkout tarball consumers |
| 1 | WU2 FK contract | 1 | WU1 gates | database/schema adapters, schema tests, ADR 0004 | adapter matrix + chosen behavior |
| 1 | WU3 OID decision | 2 | WU1 gates | benchmark harness/evidence, ADR 0005 | leased comparison + accepted ADR |
| 1 | WU4 empty commits | 1 | WU1 gates | commit op and commit parity tests | atomic refusal + allow-empty parity |
| 2 | WU5 native rm | 3 | WU4 freezes shared client/docs seams | staging op, client/compat rm, staging tests | native parity + compat preservation |
| 3 | Integration/docs | 1 | WU1–WU5 | reference and backlog lifecycle edits | full gates + package smoke |

WU2, WU3, and WU4 may run in parallel after WU1. Reserve ADR 0004 for WU2 and
0005 for WU3; publish them in numeric order. WU3 measures from the WU1 commit so
WU2 schema work cannot contaminate its TEXT baseline. WU5 lands after WU4 to
avoid concurrent edits to client declarations, compatibility wiring, and Git
support reference.

Per-unit targeted tests run immediately. Final gates, in order: `npm run
typecheck`; `npm run check`; `cpu-lease run -n 2 -- npm test`; `cpu-lease run -n
2 -- npm run build`; exact-tarball package smoke. WU3 timing uses `cpu-lease run
-n 2 --no-smt -- <benchmark>` and records repetitions and raw results. No timing
number measured without a lease may enter ADR 0005 or reference docs.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim it to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-25 planning: backlog 19 assumed workerd left foreign keys disabled,
  but the checked workerd build defines `SQLITE_DEFAULT_FOREIGN_KEYS=1`. WU2 is
  verify-first and must not mutate schema until the adapter matrix resolves the
  actual contract.
- 2026-08-25 planning: the installed Computer `GitRmOptions` describes `rm` as
  unstaging. WU5 changes the native default only and pins compatibility to
  `cached: true` plus `recursive: true`. Native directory removal requires the
  new explicit `recursive` option.
- 2026-08-25 execution: WU2–WU5 shipped. The full suite passes with 95 files,
  1,674 passed tests, and 5 skipped tests. Typecheck, Biome, and the production
  build pass. The package smoke also passes for both isolated consumers.
- 2026-08-25 resolution: the canonical source is `contember/kompjutr`. The public
  repository now exists, the package manifest records it, and WU1 passed the
  exact-tarball smoke gate before commit.
- 2026-08-25 blocker: WU1 still needs its hosted acceptance witness. The new
  public repository is empty, so GitHub Actions cannot run until the local
  history is explicitly pushed.
- 2026-08-25 resolution: the reviewed public history was pushed. The first
  hosted run exposed a missing `rg` prerequisite and host-sensitive read timing
  assertions in the ordinary functional suite.
- 2026-08-25 closure: CI and release verification now provision `rg`; read
  timing checks opt in through `KOMPJUTR_TIMING_GATE=1`. The second hosted run
  passed every repository and package gate. An isolated leased timing run kept
  the unchanged 100 ms ceiling and recorded one 120.36 ms result for follow-up
  with backlog 10.
