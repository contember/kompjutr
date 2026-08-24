> **OUTCOME — shipped 2026-08-24.** The native client now supports bounded
> already-merged, fast-forward, divergent, conflicted, no-commit, continue, and
> abort outcomes for the checked-out branch; the compatibility client exposes
> atomic single-shot merge. Recovery state is authenticated in schema v9, and
> graph, guard, tree, SQL, and memory limits fail closed. Commit map: WU1 →
> `6215367`, `497fb7a`; WU2 → `99dfad0`, `12f4f13`, `e84695f`; WU3 →
> `ad7bd90`, `e8e030e`, `c52491e`; WU4 → `c1c783f`, `49c2d19`; WU5 →
> `49c2d19`. Verification: `npm run check`; `npm run typecheck`; leased full
> suite — 82 files, 1,494 passed, 5 skipped; leased production build. Backlog
> closed: 19. Deferred: pull composition, octopus/unrelated/detached merges,
> rename detection, custom drivers, signing, hooks, and other listed non-goals.

# Sprint — Complete merge operation lifecycle (2026-08-24)

**Goal.** Deliver the complete bounded two-head merge lifecycle for the checked-out
branch: history selection, fast-forward, clean and conflicted application, durable
continue and abort, and two-parent merge commits.

**Theme.** The pure integration engine now resolves three trees but deliberately
does not choose commits or mutate repository state. This sprint turns that engine
into one recoverable public operation. Success means a merge either completes
atomically, leaves an explicit resumable state, or changes nothing.

Consumed backlog item 19 and builds directly on the archived
[three-way integration sprint](./sprint-2026-08-24-three-way-integration-engine.md).

## Refs re-verified at HEAD (2026-08-24, `fb12702`)

- ✔ Native `Git.merge()` is still an unsupported stub, while the exported
  `MergeResult` already carries the Computer-compatible `oid`, `alreadyMerged`,
  and `fastForward` fields — `src/git/client.ts:161`, `src/git/client.ts:333`,
  `src/core/ops/kinds.ts:59`.
- ✔ The pure integration engine returns a bounded delta with exact conflict
  stages and merged bytes. Its current ceilings are 1,000 output entries,
  200,000 source rows, a 32 MiB retained plan, and 134 modeled SQL statements —
  `src/core/ops/integration.ts:23`, `src/core/ops/integration.ts:30`,
  `src/core/ops/integration.ts:66`.
- ⚠ `Repository.walkIndexed()` provides a validated, shallow-aware commit graph
  cursor bounded to 50,000 commits and 32 MiB, but there is no ancestry or
  merge-base operation yet — `src/core/repository.ts:381`,
  `src/core/repository.ts:390`.
- ⚠ Normal commit construction takes only the current HEAD as its parent and
  updates the ref after writing the object. Merge needs an explicit-parent seam
  and an expected-HEAD check inside the same transaction as the operation —
  `src/core/ops/commit.ts:36`, `src/core/ops/commit.ts:42`,
  `src/core/ops/commit.ts:50`.
- ✔ The index already stores stages 1–3, detects unresolved entries, and `add`
  replaces all stages for a resolved path with stage zero —
  `src/sqlite/store.ts:2421`, `src/core/ops/staging.ts:126`,
  `src/core/ops/staging.ts:213`.
- ⚠ Checkout already has a bounded tracked/untracked overwrite guard and a
  structure-restoring tree writer, but the guard is private to checkout. Merge
  needs the same policy against only the paths it will touch —
  `src/core/ops/refs.ts:157`, `src/core/ops/refs.ts:248`,
  `src/core/ops/checkout.ts:62`.
- ✔ Git metadata and the working tree use the same `Database`, so one outer
  `transactionSync()` can cover refs, objects, index rows, merge state, and
  filesystem writes — `src/runtime/workspace.ts:36`,
  `src/runtime/workspace.ts:50`, `src/runtime/workspace.ts:59`.
- ⚠ Schema version 7 has no operation-state table. A restart-safe merge requires
  a migration plus validation for every persisted field —
  `src/sqlite/schema.ts:13`, `src/sqlite/schema.ts:302`.
- ⚠ The Computer compatibility facade also stubs `merge()`. Its installed
  interface exposes single-shot merge but no typed continue or abort method —
  `src/compat/computer/client.ts:235`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:499`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:916`.

## Work units

### WU1 — Bounded ancestry and recursive merge bases (effort L)

- **Problem.** Merge cannot distinguish already-merged, fast-forward, divergent,
  unrelated, or history-limited inputs, and criss-cross histories can have more
  than one best common ancestor.
- **Verify first.** Capture real-Git outcomes for linear, divergent, unrelated,
  shallow, corrupt, and criss-cross graphs. Include cases where one candidate
  common ancestor is itself an ancestor of another. Pin deterministic ordering
  independently of commit timestamps and insertion order.
- **Scope.** Add an ancestry/merge-base layer over the validated indexed graph.
  Find every best common ancestor under explicit commit-count, retained-byte,
  merge-base-count, and SQL limits. Distinguish a proven unrelated history from
  a shallow boundary that prevents proof. For multiple best bases, recursively
  synthesize a deterministic virtual base through the pure integration engine;
  materialize only content-addressed temporary objects inside the enclosing merge
  transaction. Validate every indexed row against authoritative commit objects
  and fail closed on missing parents, cycles, corrupt projections, or capacity
  exhaustion.
- **Acceptance / witness.** Real-Git parity fixtures prove already-merged,
  fast-forward, true divergence, unrelated refusal, shallow-history refusal, and
  criss-cross virtual-base selection. Boundary tests accept the exact graph and
  base limits and reject the next row or byte with a stable error. A mutation
  witness proves graph-selection failure leaves no temporary objects behind.
- **Touch points.** `src/core/repository.ts`, `src/core/ops/merge-base.ts`,
  `src/core/ops/integration.ts`, `src/sqlite/commits.ts`,
  `tests/merge-base.test.ts`, `tests/helpers/git.ts`.

### WU2 — Durable merge journal and operation interlocks (effort L)

- **Problem.** Conflict stages alone do not record the original branch, parents,
  message, physical conflict paths, or enough pre-merge state to continue or
  abort after a Durable Object restart.
- **Verify first.** Enumerate every mutation that can move HEAD or rewrite the
  index/worktree. Prove which commands must remain available for resolution
  (`status`, `diff`, `add`, and `rm`) and which would invalidate an active merge.
  Model abort for files, removals, executable bits, symlinks, and both directions
  of file/directory replacement.
- **Scope.** Migrate the schema to version 8 with merge-specific operation and
  touched-path tables. Persist the original symbolic ref and OID, both merge
  parents, merge mode and labels, proposed message, operation phase, and a
  bounded snapshot of the original index/worktree identities for only the paths
  merge owns. Validate row types, OIDs, modes, ordinals, revisions, phases, path
  order, and cardinality on every read. Allow one active merge per repository.
  Provide one guard for later public operations: resolution reads plus `add` and
  `rm` remain available; a second merge and unrelated HEAD/index-rewriting
  commands fail with stable operation-state errors. Reserve ordinary `commit()`
  as an allowed finalizer for WU4. A user-requested hard reset clears active merge
  state as part of its destructive reset semantics.
- **Acceptance / witness.** Reopen the workspace over the same SQLite storage at
  every operation phase and obtain the same status, stages, parents, and next
  action. Corrupt and oversized journal rows fail closed. Interlock tests prove
  allowed resolution commands still work and prohibited mutations change no
  ref, object, index, state, or worktree row.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `src/core/ops/merge-state.ts`, `src/core/ops/staging.ts`,
  `src/core/ops/commit.ts`, `src/git/client.ts`,
  `tests/merge-state.test.ts`, `tests/migrations.test.ts`.

### WU3 — Atomic start, fast-forward, and conflict application (effort XL)

- **Problem.** The integration plan has logical paths and no side effects. The
  lifecycle must protect local changes, project structural conflicts to physical
  paths, write stages and files, and either publish all related state or none.
- **Verify first.** Capture real-Git index and worktree output for clean merges,
  text and binary conflicts, add/add, modify/delete, mode conflicts, and both
  file/directory directions. Pin `~HEAD` and `~<branch>` collision suffixes with
  pre-existing tracked and untracked paths. Measure the complete graph + plan +
  journal + apply SQL and memory model before choosing batch sizes.
- **Scope.** Resolve and abbreviate safe current/incoming labels, then turn the
  logical plan into a bounded physical apply plan. Reuse the checkout overwrite
  guard as a shared path-scoped primitive so unrelated worktree changes survive,
  while touched dirty or untracked paths fail before mutation. Match Git's index
  preconditions: a non-fast-forward merge starts from an index equal to HEAD;
  fast-forward preserves staged paths it does not overwrite. Re-reserve retained
  integration-plan memory until application finishes. In one outer database
  transaction, revalidate the expected symbolic HEAD and index baseline; write
  new blobs and trees; apply stage-zero or stages 1–3; write clean content or
  conflict-marker content; perform structural removals and label-derived
  relocation; persist resumable state when needed; and update the branch only
  for a completed outcome. Use bulk writes so the entire operation, including
  nested helpers, remains below 1,000 SQL statements and 100 MiB. Handle
  already-merged without writes and fast-forward with the same local-change guard
  and atomic ref/index/worktree update.
- **Acceptance / witness.** Real-Git parity compares HEAD, refs, full index
  stages, worktree bytes and modes, conflict labels, and relocated paths for the
  complete fixture matrix. Fault injection after every write class proves full
  rollback. Unrelated local changes remain byte-identical. Exact SQL, memory,
  path-count, output-size, and collision limits fail before partial mutation.
- **Touch points.** `src/core/ops/merge.ts`, `src/core/ops/integration.ts`,
  `src/core/ops/checkout.ts`, `src/core/ops/refs.ts`,
  `src/core/ops/worktree-io.ts`, `src/sqlite/store.ts`, `src/fs/`,
  `tests/merge-apply.test.ts`, `tests/transactions.test.ts`.

### WU4 — Continue, abort, no-commit, and merge commits (effort L)

- **Problem.** A clean non-fast-forward merge normally creates a two-parent
  commit, while a conflict or `commit: false` result must remain resumable.
  Abort must restore only merge-owned paths and must not erase unrelated work.
- **Verify first.** Capture real-Git behavior for default messages, explicit
  messages and identities, `--no-commit`, conflict resolution by add/rm followed
  by commit, abort before and after partial resolution, and fast-forward combined
  with no-commit. Confirm author/committer timestamp behavior across a restart.
- **Scope.** Refactor commit construction to accept validated explicit parents
  and an expected symbolic ref without weakening normal commit behavior. On a
  clean divergent merge, create the tree, two-parent commit, ref update, index,
  and worktree atomically. `commit: false` leaves a durable ready state; expected
  conflicts leave a durable conflicted state. `mergeContinue()` and ordinary
  `commit()` reject remaining stages, resolve identity and message at
  finalization, create exactly one two-parent commit from the entire resolved
  index, clear journal state, and leave unrelated unstaged worktree content
  untouched. `mergeAbort()` restores the original ref, index, and worktree for
  journaled paths, removes merge-created relocation paths, preserves everything
  outside that set, and refuses a structural restore that would destroy
  newly-created unrelated content.
- **Acceptance / witness.** Restart parity covers clean no-commit, partial
  conflict resolution, continue, commit-as-continue, and abort. Commit objects
  match Git for tree, ordered parents, identities, timestamps, and message under
  pinned inputs. Abort restores a byte-for-byte pre-merge snapshot while an
  unrelated-change sentinel remains untouched. Repeated continue/abort calls are
  deterministic stable errors and every failure is atomic.
- **Touch points.** `src/core/ops/merge.ts`, `src/core/ops/merge-state.ts`,
  `src/core/ops/commit.ts`, `src/core/objects.ts`, `src/sqlite/store.ts`,
  `src/git/client.ts`, `tests/merge-lifecycle.test.ts`,
  `tests/commit.test.ts`.

### WU5 — Public surface, compatibility, and final conformance (effort M)

- **Problem.** Native and Computer clients still advertise unsupported merge,
  and the current test suite treats that error as the correct result.
- **Verify first.** Compile a contract table for every native option/result and
  for the narrower installed Computer interface. Inventory exported types and
  the CLI error mapper before changing signatures. Confirm all new stable error
  codes are unique and asserted by code rather than `instanceof`.
- **Scope.** Add native `GitMergeOptions` with the existing Computer fields plus
  `commit?: boolean`; extend `MergeResult` with bounded `conflicted` and
  `pendingCommit` signals without changing existing fields; and expose typed
  `merge()`, `mergeContinue()`, and `mergeAbort()` methods. The operation targets
  the checked-out symbolic branch; `ours`, when supplied, must resolve to that
  branch. Detached HEAD and a different non-checked-out target fail before
  mutation. Wire the compatibility `merge()` to its existing single-shot shape:
  completed outcomes return its standard result, while expected conflicts map to
  `EMERGEFAIL` without leaving compatibility callers in an unreachable pending
  state. Keep native conflict recovery available through native methods and
  through `add`/`rm` plus `commit`. Replace the unsupported client witness with
  parity tests and update current reference/support documentation.
- **Acceptance / witness.** Type tests cover native and compatibility option and
  result shapes. Public tests cover already-merged, fast-forward, forced merge
  commit, ff-only refusal, clean, conflict, no-commit, continue, commit-as-continue,
  abort, restart, detached HEAD, wrong `ours`, unrelated, shallow, corrupt, dirty,
  untracked, active-state, missing-state, and every structural bound. The sprint
  closes only after `npm run check`, `npm run typecheck`, the leased full suite,
  and a leased production build pass; architecture and support docs describe only
  shipped behavior; backlog item 19 is deleted.
- **Touch points.** `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `src/compat/computer/client.ts`, `src/core/errors.ts`,
  `tests/client.test.ts`, `tests/compat.test.ts`,
  `docs/reference/architecture.md`, `README.md`, docs indexes.

## Out of scope (explicit)

- `pull` composition shipped in the later
  [complete pull sprint](./sprint-2026-08-24-complete-pull.md). This sprint
  accepts only commits and refs already present in the local object database.
- Octopus merges, unrelated-history opt-in, detached-HEAD merges, and merging
  into a branch other than the checked-out branch are separate command shapes.
  This sprint fully implements the normal two-head checked-out-branch lifecycle
  and fails those variants before mutation.
- Rename detection, attributes, custom merge drivers, submodule checkout,
  signing, hooks, rerere, and strategy selection remain follow-on behavior. The
  shipped integration engine continues to model renames as delete/add and
  gitlinks as identities or conflicts.
- Stash, rebase, cherry-pick, and revert remain separate consumers in
  [backlog item 06](../backlog/06-stash-operations.md),
  [backlog item 07](../backlog/07-rebase.md), and
  [backlog item 14](../backlog/14-cherry-pick-and-revert.md).
- The generic `git.cli()` dispatcher remains unsupported. This sprint ships the
  typed native and compatibility method surfaces, not a shell parser.
- No benchmark or production deployment claim belongs to this sprint.

## Decisions

- Ship the whole normal local merge lifecycle in one sprint. A graph-only or
  apply-only subset would not produce a usable public operation.
- Keep the pure integration engine mutation-free. Commit selection, virtual-base
  object lifetime, physical conflict paths, state persistence, and application
  belong in `src/core/ops/merge.ts` and merge-state/storage helpers.
- Limit the operation to the checked-out symbolic branch. This gives index and
  worktree state one unambiguous owner and makes restart recovery safe. An
  explicit `ours` is a guard, not a request for a headless branch merge.
- Expected content and structural conflicts are native result states, not
  exceptions. Invalid input, unsafe local state, missing/incomplete history,
  corruption, stale operation state, and exceeded limits are stable errors.
- Use `commit?: boolean`, defaulting to true, for the native no-commit mode.
  Like Git, it does not stop an otherwise permitted fast-forward.
- Match Git's local-state split: a divergent merge requires an index equal to
  HEAD, a fast-forward may preserve non-overwritten staged entries, and either
  path refuses only worktree or untracked content it would overwrite.
- Persist only merge metadata and original state for paths the merge owns. Do
  not snapshot the whole index or worktree. Abort restores that set and refuses
  rather than deleting an unrelated structural blocker.
- Keep the journal merge-specific. A speculative generic operation framework
  would couple rebase, stash, cherry-pick, and revert before their requirements
  are known.
- Completed native and compatibility outcomes preserve the installed
  `MergeResult` fields. Native-only pending signals are additive. The narrower
  compatibility surface never persists an operation its callers cannot continue
  or abort through that interface.
- Treat the full operation as one resource budget. Each work unit must update a
  single end-to-end SQL and retained-memory model; helper-local limits are not
  sufficient evidence.

## Sequencing

| Order | Work | Dependency |
| --- | --- | --- |
| 1a | WU1 — graph selection | Starts immediately. Defines merge-base and virtual-base results. |
| 1b | WU2 — journal/interlocks | Starts after the operation-state contract is fixed; storage work is independent of graph code. |
| 2 | WU3 — atomic start/apply | Requires WU1 result and WU2 persistence primitives. |
| 3 | WU4 — continue/abort/commit | Requires WU3 physical-path journal and apply semantics. |
| 4 | WU5 — public surface/conformance | API types can start after contracts settle; final wiring and docs close last. |

Use targeted tests after each work unit. Before close, run:

```bash
npm run check
npm run typecheck
cpu-lease run -n 2 -- npm test
cpu-lease run -n 2 -- npm run build
```

Do not run or publish a benchmark from this sprint.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- Independent lifecycle review found five recovery/interlock gaps. Regression
  witnesses now cover missing tracked files, unmerged fast-forward indexes,
  compatibility commit, continuation capacity, and parent substitution.
- Type-valid journal substitution required a deterministic integrity identity;
  this advanced the merge journal from schema v8 to v9. Migrating v8 clears an
  unauthenticated pending operation instead of trusting it.
- Resource audit disproved the initial fixed guard and commit estimates. Final
  limits include hash batch/range caps and streaming preflight of current,
  projected, final, and virtual tree shapes.
