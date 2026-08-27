> **OUTCOME — shipped 2026-08-25.** Native status now reports every legal
> unmerged index shape, exposes path/ignored/untracked options and bounded branch
> metadata, and emits exact staged renames. Native diff and summary emit exact
> `R100` moves. The Computer facade preserves its pinned shapes by rejecting
> unmerged status and disabling rename detection. Commit map: plan → `328144e`;
> WU1 → `52c8e0b`; WU2 → `c114edf`; WU3 → `9ad5af0`; WU4 → `44a1cf6`.
> Verification: `npm run check`; leased `npm run typecheck`; leased full suite —
> 96 files and 1,705 tests passed, 5 skipped; leased `npm run build`; leased
> `npm run package:smoke`; docs lint. Backlog closed: 31 and 34. Deferred:
> similarity-scored renames, copy detection, and staged diff.

# Sprint — Status and rename correctness (2026-08-25)

**Goal.** Make native status and diff truthful for unresolved integrations and
exact file moves without weakening the bounded merge-join cost model or silently
changing the Computer compatibility contract.

**Theme.** Backlogs 31 and 34 are the remaining scheduled Tier S Git
parity gaps. They belong together because both require status rows to model more
than independent `A`/`M`/`D` paths, both change porcelain output and public view
types, and both need an all-or-nothing classification pass over path-ordered
streams. Success means conflicts cannot masquerade as ordinary deletions, the
native facade reaches the status options already implemented in core, and a
pure move is one `R100` change in native status and diff.

The archived release-correctness sprint is independent. Its local and hosted
gates pass; this sprint builds on that verified baseline without changing the
release path.

## Refs re-verified at HEAD (2026-08-25, `36593b3`)

- ⚠ The conflict premise has drifted in detail but not severity. The full status
  stream discards every non-zero index stage before its three-way join. A live
  cherry-pick `UU` fixture therefore reports `D  conflict.txt`, not the backlog's
  expected plain `M`; real Git reports `UU` and a porcelain v2 `u` row with stage
  1/2/3 modes and OIDs — `src/core/ops/status.ts:147`,
  `src/core/ops/status.ts:208`, `src/core/ops/status-rows.ts:79`.
- ✔ The index scan is already paged in `(path, stage)` order. A status-side
  grouping stream can retain at most the four legal rows for one path and does
  not need scalar `indexGet()` calls or a materialised index —
  `src/sqlite/store.ts:3688`.
- ⚠ The sparse status path marks conflicts dirty, but hydration still selects
  only stage zero and passes `undefined` to the ordinary tracked-row builder.
  Fixing only the full traversal would leave same-database `Workspace.status()`
  wrong — `src/core/ops/status-sparse.ts:168`,
  `src/core/ops/status-sparse.ts:187`, `src/core/ops/status-sparse.ts:217`.
- ✔ Core already implements exact-or-prefix `paths`, `includeIgnored`, and
  `untrackedFiles: "normal" | "all"`. The native `Git.status()` accepts only
  `dir` and drops all three before calling `eagerStatus()` —
  `src/core/ops/status-rows.ts:52`, `src/git/client.ts:128`,
  `src/git/client.ts:173`, `src/git/client.ts:282`.
- ⚠ `includeIgnored` currently reuses the untracked `?` row. Real Git's
  porcelain uses `!!` in v1 and `!` in v2, so exposing the option without a
  distinct ignored row would create another plausible wrong answer —
  `src/core/ops/status.ts:163`, `src/core/ops/status-rows.ts:214`,
  `src/core/ops/status.ts:423`.
- ⚠ The installed Computer contract is pinned at 0.2.1. Its status input admits
  `dir` only, and its status and diff-summary unions do not admit `U`, `!`, or
  `R`. The compatibility facade deliberately projects exactly that declared
  status shape, but currently calls the same diff summary as native code —
  `package-lock.json:221`, `src/compat/computer/client.ts:121`,
  `src/compat/computer/client.ts:130`.
- ✔ Native status and diff view types stop at `A | M | D`; status details have
  only one path and two endpoint OIDs. The porcelain v2 formatter can emit only
  ordinary `1` and untracked `?` rows — `src/core/ops/kinds.ts:18`,
  `src/core/ops/kinds.ts:32`, `src/core/ops/status-rows.ts:42`,
  `src/core/ops/status.ts:423`.
- ✔ Diff emits additions and deletions independently and hydrates changes in
  1,000-row windows. Exact rename pairing needs endpoint identities from the
  whole bounded candidate set before any partial rename output; it must not turn
  the existing window into an unbounded change buffer — `src/core/ops/diff.ts:41`,
  `src/core/ops/diff.ts:70`, `src/core/ops/diff.ts:156`,
  `src/core/ops/diff.ts:312`.
- ✔ A live pure staged move produces Git porcelain v2 `2 R. ... R100 new\told`
  and a patch with `similarity index 100%`, `rename from`, and `rename to`.
  kompjutr has no representation or writer path for those records —
  `src/core/ops/diff.ts:73`, `src/core/ops/diff.ts:76`,
  `src/core/ops/diff.ts:128`.
- ✔ The targeted baseline is green under a two-vCPU lease: `tests/status.test.ts`
  and `tests/diff.test.ts`, 2 files and 76 tests in 22.88 seconds. Existing scale
  witnesses cover a 24,252-file status and diff checkout —
  `tests/status.test.ts:608`, `tests/diff.test.ts:452`.

## Work units

### WU1 — Model every unmerged index shape (effort L)

- **Problem.** `statusIndexEntries()` removes stages 1–3, so the ordinary
  HEAD/index/worktree comparison invents a staged deletion for a conflicted
  path. The eager sparse path repeats the same stage-zero assumption. Native
  callers and both porcelain formatters therefore receive a valid-looking lie
  during merge, cherry-pick, revert, and rebase conflicts —
  `src/core/ops/status.ts:147`, `src/core/ops/status.ts:208`,
  `src/core/ops/status-sparse.ts:187`.
- **Verify first.** Pin real Git v1, v2, and short output for all seven legal
  conflict pairs (`DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`), including a missing
  working-tree path and an edited conflict-marker file. Produce conflicts through
  each native integration lifecycle at least once, then cold-reopen one. Record
  sparse and full-path outputs before changing row types.
- **Scope.** Replace the stage-zero filter with a path-grouped index stream that
  validates stage ordinals, uniqueness, modes, OIDs, and the mutually exclusive
  stage-zero/unmerged shapes before use. Add an explicit unmerged status-detail
  variant carrying stage 1/2/3 modes and OIDs plus the worktree mode. Derive the
  seven XY pairs from stage presence, without hashing conflict-marker contents.
  Teach full and sparse status paths, v1, v2 `u`, and short formatters the same
  variant. Widen only the native `StatusEntry` code set. If the Computer facade
  observes an unmerged row created through the native surface, fail with stable
  `EUNMERGED` instead of projecting a code its installed interface cannot express.
- **Acceptance / witness.** Differential fixtures match Git byte for byte for
  every legal conflict pair in v1, v2, and short output. Native `Git.status()`
  returns the same XY pair after merge, cherry-pick, revert, rebase, and cold
  reopen. Corrupt or mixed stage shapes fail closed with `ECORRUPT`. A scale
  conflict fixture forbids scalar index and worktree reads, retains only one
  path group beyond the existing status windows, and stays within the current
  SQL and retained-byte gates. The compatibility rejection is covered explicitly.
- **Touch points.** `src/core/ops/kinds.ts`, `src/core/ops/status-rows.ts`,
  `src/core/ops/status.ts`, `src/core/ops/status-sparse.ts`,
  `src/git/client.ts`, `src/compat/computer/client.ts`, `tests/status.test.ts`,
  `tests/client.test.ts`, compatibility tests, integration lifecycle fixtures.

### WU2 — Expose native status options and branch metadata (effort M/L)

- **Problem.** The native facade accepts only `GitDirOptions`, so callers cannot
  request path filtering, ignored paths, or untracked expansion without dropping
  below the client API. Ignored rows have the wrong public code. Porcelain v2
  also has no branch-report input, even though HEAD, configured upstream refs,
  and bounded ancestry primitives already exist — `src/git/client.ts:173`,
  `src/core/ops/status-rows.ts:52`, `src/core/repository.ts:255`,
  `src/core/ops/merge-base.ts:215`.
- **Verify first.** Pin real Git output and return semantics for path filters,
  `--ignored`, `-unormal`, `-uall`, unborn and detached HEAD, a branch without an
  upstream, and up-to-date/ahead/behind/diverged upstreams. Include a shallow or
  bounded ancestry failure before selecting the branch `ab` policy. Confirm the
  exact installed Computer status input and return declarations again before
  touching its facade.
- **Scope.** Add and export `GitStatusOptions`, omitting internal `excludeRoots`
  and `ignores`, and thread it through native `Git.status()`. Represent ignored
  paths as `!`/`!!`. Keep the array-returning status methods stable. Add an
  additive native/core `statusReport()` result for optional branch metadata
  (`oid`, `head`, optional `upstream`, `ahead`, `behind`) and let the v2 formatter
  prepend the corresponding `# branch.*` rows. Resolve configured upstreams with
  the existing pull/ref rules and compute ahead/behind through a bounded indexed
  graph helper; never run one scalar commit query per ancestor. Keep the Computer
  input `dir`-only because its pinned interface has no option fields.
- **Acceptance / witness.** Native client tests prove all three existing core
  options are reachable and nested-root exclusions remain mandatory. Ignored and
  branch porcelain matches Git byte for byte for every verify-first case.
  Missing upstream metadata is omitted exactly where Git omits it. Corrupt or
  over-limit ancestry fails closed with a stable error and stays below 1,000 SQL
  statements. Existing `status()` and `Git.status()` callers still receive arrays
  with no hidden enumerable report fields, and root plus `git` entrypoints export
  matching option/report types.
- **Touch points.** `src/core/ops/status-rows.ts`, `src/core/ops/status.ts`,
  `src/core/ops/status-sparse.ts`, `src/core/ops/merge-base.ts`, possibly a
  read-only upstream resolver extracted from `src/core/ops/pull.ts`,
  `src/git/client.ts`, `src/index.ts`, `src/git/index.ts`,
  `tests/status.test.ts`, `tests/client.test.ts`, `tests/public-exports.test.ts`.

### WU3 — Build a bounded exact-rename classifier (effort M)

- **Problem.** Exact moves need a global pairing decision, but status and diff
  currently emit path-local results. Pairing as each 1,000-row window arrives
  can produce partial or order-dependent renames; retaining every change defeats
  the cost model — `src/core/ops/status.ts:67`, `src/core/ops/diff.ts:156`,
  `src/core/ops/diff.ts:312`.
- **Verify first.** Ask real Git how it pairs duplicate source and destination
  OIDs, basename matches, swaps, executable files, symlinks, moves into new
  directories, and path-filtered endpoints. Pin option/config precedence for an
  explicit `renames` boolean, `status.renames`, and `diff.renames`. Pin the
  intentional exact-only difference for move-plus-edit before encoding it in
  tests and reference docs.
- **Scope.** Add one shared exact-identity classifier over additions and
  deletions. Pair only compatible modes with equal authoritative blob OIDs and
  report similarity 100. Charge both candidate count and retained UTF-8 bytes
  before inserting into OID buckets. If either cap is exceeded, discard the
  entire pairing result and use complete add/delete output; never emit a partial
  prefix. Use `comparePaths` for every path ordering and deterministic tie-break.
  Where a public stream must preserve final Git ordering, use a bounded identity
  prepass plus a second traversal instead of materialising arbitrary changes.
- **Acceptance / witness.** Focused classifier tests match Git's deterministic
  exact pairing for every verify-first case, including duplicate OIDs and
  non-BMP paths. Tests at the exact candidate and retained-byte limits classify
  all pairs; one unit over produces zero pairs and complete A/D output. The
  classifier reads no blob bodies, performs no SQL itself, and has no unbounded
  array or map. Explicit options override config; config overrides the default
  `true` setting.
- **Touch points.** New focused module under `src/core/ops/`,
  `src/core/ops/diff-internal.ts`, `src/core/ops/status-rows.ts`, focused unit
  tests, config parsing shared with existing ops if needed.

### WU4 — Emit rename-aware native status and diff (effort L)

- **Problem.** Native status has no `R` row or source path. Diff always writes
  independent new/deleted headers, and `DiffSummaryEntry` cannot represent one
  rename. Passing a widened summary through the Computer facade would violate
  its declared 0.2.1 return union — `src/core/ops/kinds.ts:18`,
  `src/core/ops/kinds.ts:32`, `src/core/ops/diff.ts:76`,
  `src/compat/computer/client.ts:130`.
- **Verify first.** Run the WU3 fixture matrix end to end through status v1/v2,
  short, patch, name-status-equivalent summary, native client, and compatibility
  client. Measure the clean and 24,252-file scale witnesses with rename detection
  on and off; timings are diagnostic only unless run under `cpu-lease`.
- **Scope.** Add native rename rows with `originalPath` and `similarity: 100`
  only when status compares HEAD to the index or diff compares its selected
  endpoints. Emit v1/short `old -> new`, v2 `2 ... R100 new\told`, and patch
  `similarity index`, `rename from`, and `rename to` headers. Widen native
  `DiffSummaryEntry.status` to `R` and return one destination row with the source
  path; do not fabricate insertions or deletions for an exact move. Apply the
  WU3 option/config policy consistently to status, patch, and summary. Pass
  `renames: false` explicitly from Computer status/diff methods so its input and
  output contracts and serialized shapes remain unchanged until the upstream
  package declares rename support.
- **Acceptance / witness.** Native status, diff, and summary match real Git for
  pure moves, swaps, duplicate OIDs, mode-compatible moves, new directories,
  filters, disabled config, and cap fallback. Move-plus-edit remains complete
  A/D output and is documented as the exact-only limit. Removing either endpoint
  from the classifier cannot create a rename. Compatibility tests prove the old
  A/D arrays and patch behavior are byte-for-byte stable. Existing scale gates
  remain under 1,000 SQL statements, use bulk reads only, and show that the
  rename prepass does not retain the repository or read unchanged blobs.
- **Touch points.** `src/core/ops/kinds.ts`, `src/core/ops/status.ts`,
  `src/core/ops/diff.ts`, `src/core/ops/diff-internal.ts`,
  `src/core/ops/sparse-diff.ts`, `src/git/client.ts`,
  `src/compat/computer/client.ts`, `src/index.ts`, `src/git/index.ts`,
`tests/status.test.ts`, `tests/diff.test.ts`, `tests/client.test.ts`,
compatibility and public-export tests, `docs/reference/git-support.md`.

## Out of scope (explicit)

- Similarity-scored rename detection and copy detection. Exact OID pairing is
  the accepted scope; move-plus-edit
  remains A/D and must be recorded as partial support, not disguised as parity.
- Staged-only diff selection (`git diff --cached`) and broader patch/history
  reads — backlogs [35](../backlog/35-staged-diff.md) and
  [37](../backlog/37-history-reads-patch-and-paths.md).
- Glob pathspecs, path quoting, colour, long human status output,
  `--untracked-files=no`, submodule dirtiness, and `.gitattributes` diff drivers.
  This sprint exposes and corrects the core options already scheduled in 31; it
  does not turn the typed API into a full CLI parser.
- Changing `@cloudflare/computer`, widening its status/diff-summary declarations,
  or exposing native-only option fields through its facade. A future upstream
  release may permit that follow-up; the compatibility layer must compile
  against 0.2.1 throughout this sprint.
- Branch creation, upstream mutation, remote rename/prune, or pull-rebase —
  backlogs [18](../backlog/18-branch-and-remote-management.md) and
  [28](../backlog/28-pull-rebase.md). WU2 only reads existing branch config.
- Reflogs, branch-delete ancestry enforcement, and repository maintenance —
  backlogs [12](sprint-2026-08-26-reflogs-and-ref-recovery.md),
  [33](sprint-2026-08-26-git-boundary-correctness.md#wu1--safe-branch-deletion-33-effort-m), and
  [04](sprint-2026-08-27-repack-and-garbage-collection.md).
- Publishing a release. The tag workflow is checked in, but configuring the
  `npm` environment and trusted publisher, selecting the first version, and
  pushing its tag remain separate explicit actions.

## Decisions

- Native correctness and Computer compatibility are separate public contracts.
  Native types may add truthful `U`, `!`, and `R` states. The compatibility
  facade keeps 0.2.1 shapes, rejects native-created unmerged state, and disables
  rename classification explicitly. It never narrows a new native code into a
  plausible old one.
- Existing array-returning `status()` and `Git.status()` APIs remain arrays.
  Branch metadata uses an additive `statusReport()` result; no properties are
  attached to arrays and no formatter performs hidden repository reads.
- Unmerged status is derived from authoritative stage presence. Conflict-marker
  contents do not alter the XY pair, so status reads the worktree mode but does
  not hash conflict bytes merely to format a `u` row.
- Rename detection is exact identity only and defaults on for native status and
  diff. Explicit `renames` wins over command-specific config, which wins over
  the default. `false` is a supported deterministic escape hatch.
- Rename-cap overflow is an all-or-nothing heuristic fallback, not truncated
  output: the full set of additions and deletions still appears. No pair is
  emitted until the classifier knows the candidate set is within both bounds.
- Rename results use destination `path`, source `originalPath`, and numeric
  `similarity: 100`. Optional fields are absent from ordinary rows so existing
  serialized A/M/D shapes do not grow.
- No ADR is required for the scheduled exact-only policy or additive native
  types. Write one only if execution changes the compatibility boundary, the
  array-return contract, or the global cost model.

**Planning alternative rejected.** Implementing conflicts and renames in
separate sprints would reduce simultaneous type churn, but each would edit the
same status variants, formatters, native facade, compatibility projection, and
public exports. Doing the shared type boundary once is safer. Combining branch
management or similarity scoring would make the classifier and ancestry work
too broad to verify independently.

**Revisit the scope if** the installed Computer contract grows native conflict
or rename types before WU1 lands, or if Git's deterministic exact pairing cannot
be reproduced without pairwise content scoring. In the latter case, stop after
the WU3 fixture evidence and ask before adding similarity reads or changing the
accepted exact-only policy.

## Sequencing

Effort labels describe uncertainty and blast radius, not human days. Plan the
sprint as roughly eight focused agent passes plus the full integration gates.

| Wave | Unit | Agent passes | Depends on | Write territory | Done-check |
|---|---|---:|---|---|---|
| 0 | WU1 unmerged status | 2 | none | status variants/streams, sparse status, conflict fixtures | seven XY pairs + sparse/cold parity |
| 1 | WU2 native options/branch report | 2 | WU1 freezes status variants | status report, bounded ancestry, native facade | option reachability + branch porcelain |
| 1 | WU3 exact classifier | 1 | WU1 freezes shared names | new classifier and focused tests | deterministic pairing + all-or-none caps |
| 2 | WU4 rename integration | 2 | WU2, WU3 | status/diff writers, public and compat facades | R100 end-to-end + compat preservation |
| 3 | Integration/docs | 1 | WU1–WU4 | support reference and backlog lifecycle edits | targeted suites, full gates, package smoke |

WU2 and WU3 may proceed independently after WU1. WU3 must not edit public
status/diff result types; WU4 owns that shared seam after the classifier contract
is fixed. Close the sprint only after deleting or rescoping backlogs 31 and 34,
updating `docs/reference/git-support.md`, running `npm run check`,
`npm run typecheck`, the full test suite, `npm run build`, and
`npm run package:smoke`, and recording exact counts in the archive header.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-25 — WU1 complete. Status now groups and validates `(path, stage)`
  rows, emits all seven unmerged XY shapes and porcelain v2 `u` records, and
  preserves conflict truth through sparse hydration and cold reopen. Native
  merge, cherry-pick, revert, and rebase witnesses report `UU`; the Computer
  facade rejects unrepresentable conflict rows with `EUNMERGED`. Verification:
  status 66/66, sparse status 18/18, client 17/17, and typecheck pass.
- 2026-08-25 — WU2 complete. Native `Git.status()` now exposes path, ignored,
  and untracked expansion options while retaining nested-repository exclusion.
  Ignored rows use Git's `!!`/`!` codes. Additive core and native
  `statusReport()` APIs expose validated HEAD and upstream metadata; ahead and
  behind counts use two bounded indexed graph cursors and seven SQL statements.
  Real Git parity covers unborn, attached, detached, missing tracking,
  up-to-date, ahead, behind, diverged, and shallow histories. Computer 0.2.1 was
  re-verified as `dir`-only and remains unchanged. Verification: five focused
  files, 116/116 tests; typecheck and docs lint pass.
- 2026-08-25 — WU3 complete. A pure bounded classifier now pairs equal OIDs
  within compatible regular-file or symlink mode classes. It follows Git's
  destination-path order, prefers an available same-basename source without
  reserving sources for later destinations, and uses UTF-8 path ordering. The
  10,000-candidate and 16 MiB retained-state caps fall back all at once. Shared
  option resolution implements explicit value over `status.renames` or
  `diff.renames` over the enabled default, including Git's `copies` value.
  Verification: rename classifier 10/10 and typecheck pass.
- 2026-08-25 — WU4 complete. Native status, patch, and summary now emit exact
  `R100` moves with source paths while the Computer facade explicitly preserves
  its existing A/D arrays and patch shape. Full and sparse status/diff paths use
  the same classifier; bounded sparse identities are reused for output instead
  of traversed twice. A 10,002-candidate integration witness proves cap overflow
  returns every one of 5,001 additions and deletions with no partial rename.
  The 24,252-file witnesses remain below 1,000 SQL statements and read no clean
  blob bodies. Verification: eight focused files, 155/155 tests; check and
  typecheck pass.
