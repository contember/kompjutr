> **OUTCOME — shipped 2026-08-24.** The native client now supports bounded
> one-commit cherry-pick and revert with clean, conflicted, empty, restart-safe
> continue, skip, and abort outcomes. Both commands share one authenticated
> schema-v10 operation journal and one three-tree replay lifecycle; Computer
> compatibility remains unchanged because its installed interface has no replay
> methods. Commit map: plan → `ba58f56`; WU1 → `a55ed53`; WU2 → `0c40e45`;
> WU3 → `36989c5`; shared conflict-label seam → `3dc9b69`; WU4 → `1a8df50`;
> WU5 → `8bf6c6d`. Verification: `npm run check`; `npm run typecheck`; leased
> full suite — 90 files and 1,590 tests passed, 5 skipped; leased production
> build; docs lint. Backlog closed: 14. Deferred: multi-commit rebase and
> sequencing, reflogs, rename detection, custom merge drivers, signing, hooks,
> rerere, and the other explicit non-goals below.

# Sprint — Cherry-pick and revert lifecycle (2026-08-24)

**Goal.** Deliver bounded native cherry-pick and revert for one selected commit,
including clean, empty, conflicted, restart-safe continue, skip, and abort
outcomes on the checked-out branch.

**Theme.** Cherry-pick and revert are the same one-commit replay with opposite
tree inputs. Cherry-pick applies the selected commit relative to its chosen
parent; revert applies that change in reverse. Both must reuse the existing
three-tree integration and path-scoped recovery machinery. Success means either
operation commits atomically, leaves one explicit recoverable state, or changes
nothing.

Consumed backlog item 14, which was deleted on ship, and established the
one-commit replay seam needed by the later [rebase](../backlog/07-rebase.md)
sprint without implementing a sequencer here.

## Refs re-verified at HEAD (2026-08-24, `ba85a8b`)

- ✔ The native `Git` surface has merge recovery and stash stubs but no
  cherry-pick or revert methods or types — `src/git/client.ts:102`,
  `src/git/client.ts:137`.
- ⚠ The backlog listed the Computer compatibility facade as a touch point, but
  the installed `@cloudflare/computer` `GitClient` exposes merge and stash only;
  it has no cherry-pick or revert contract to implement —
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:863`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:913`.
- ✔ The pure integration engine already accepts base, current, and incoming
  trees, emits a Git-path-ordered delta, and caps source rows at 200,000,
  output entries at 1,000, and retained plans at 32 MiB —
  `src/core/ops/integration.ts:26`, `src/core/ops/integration.ts:80`,
  `src/core/ops/integration.ts:98`.
- ✔ Merge already composes that pure plan with a clean-index precondition,
  touched-path worktree protection, structural conflict projection, bounded SQL
  accounting, and one atomic apply — `src/core/ops/merge.ts:802`,
  `src/core/ops/merge.ts:841`, `src/core/ops/merge.ts:847`,
  `src/core/ops/merge.ts:868`, `src/core/ops/merge.ts:898`.
- ⚠ Durable recovery is merge-specific at schema version 9. The tables, types,
  integrity vector, helpers, and stable errors all assume two merge parents and
  one `merge` kind — `src/sqlite/schema.ts:13`, `src/sqlite/schema.ts:100`,
  `src/core/ops/merge-state.ts:18`, `src/core/ops/merge-state.ts:27`,
  `src/core/ops/merge-state.ts:427`, `src/core/ops/merge-state.ts:459`.
- ✔ The apply layer snapshots only owned index/worktree paths, persists state
  only for a suspended outcome, validates SQL below 1,000 statements, and can
  restore those paths atomically — `src/core/ops/merge-apply.ts:820`,
  `src/core/ops/merge-apply.ts:837`, `src/core/ops/merge-apply.ts:846`,
  `src/core/ops/merge-apply.ts:887`, `src/core/ops/merge-apply.ts:1068`.
- ✔ Commit construction already accepts an explicit ordered parent list,
  exact `Person` values, and an expected HEAD, so replay does not need another
  object writer. Cherry-pick can retain the source author while resolving a new
  committer — `src/core/ops/commit.ts:26`, `src/core/ops/commit.ts:57`,
  `src/core/ops/commit.ts:70`, `src/core/ops/commit.ts:102`.
- ✔ Revision parsing already validates and resolves `^n` parents, while commit
  reads expose the complete ordered parent array needed for an explicit
  one-based mainline choice — `src/core/repository.ts:300`,
  `src/core/repository.ts:337`.
- ⚠ Public mutation interlocks and ordinary `commit()` currently inspect only
  merge state. `add` and `rm` remain available for conflict resolution, while
  hard reset clears the merge journal — `src/git/client.ts:257`,
  `src/git/client.ts:264`, `src/git/client.ts:276`,
  `src/sqlite/store.ts:2676`, `src/sqlite/store.ts:2697`.
- ✔ Real-Git fixtures already pin identity and timestamps and execute the system
  `git` binary, so commit objects and lifecycle state can be compared
  deterministically — `tests/helpers/git.ts:18`, `tests/helpers/git.ts:30`.

## Work units

### WU1 — Pin the replay contract and build a pure planner (effort L)

- **Problem.** The integration engine can combine any three trees, but no
  operation selects a commit parent, maps cherry-pick and revert to those trees,
  or defines their empty, merge-commit, dirty-worktree, and identity semantics.
  Reusing merge orchestration directly would incorrectly perform ancestry
  selection and create a two-parent commit — `src/core/ops/merge.ts:812`,
  `src/core/ops/merge.ts:917`.
- **Verify first.** Capture real-Git state and output for a clean change, root
  commit, source commit with an empty tree delta, change that becomes empty on
  the destination, content and structural conflicts, add/delete/mode changes,
  merge commits with missing/valid/invalid mainline, detached and unborn HEAD,
  staged changes, touched and unrelated unstaged changes, and touched untracked
  files. Pin source author, new committer, timestamps, message, ordered parents,
  index stages, worktree bytes and modes, and the observable state after every
  stopped outcome.
- **Scope.** Add a mutation-free replay planner shared by both commands. Resolve
  one source commit and one explicit mainline parent when required. Treat an
  allowed root commit as having an empty parent tree. For cherry-pick, integrate
  `selected parent tree → current HEAD tree → source tree`; for revert,
  integrate `source tree → current HEAD tree → selected parent tree`. Reuse the
  current bounded tree planner, collision projection, clean-index check, and
  touched-path safety guard. Bound revision text, parent selection, retained
  source metadata, tree rows, produced entries, blob reads, and combined SQL
  before mutation.
- **Acceptance / witness.** Pure tests compare the selected trees and projected
  entries with the real-Git fixture matrix. Exact parent, path, row, byte, blob
  read, and SQL limits accept the boundary and reject the next unit with stable
  errors. Every invalid source, mainline, shallow/corrupt object, dirty path, and
  capacity failure leaves refs, objects, index, worktree, and operation state
  unchanged.
- **Touch points.** `src/core/ops/replay.ts`, `src/core/ops/integration.ts`,
  `src/core/ops/merge.ts`, `src/core/ops/merge-apply.ts`,
  `src/core/ops/checkout.ts`, `src/core/repository.ts`,
  `tests/replay.test.ts`, `tests/helpers/git.ts`.

### WU2 — Generalize the durable operation journal and interlocks (effort L)

- **Problem.** `git_merge_state` can authenticate and restore only a two-head
  merge. Adding separate cherry-pick and revert tables would duplicate the
  hardest corruption, memory, restart, and command-interlock rules while still
  permitting ambiguous simultaneous operation states —
  `src/sqlite/schema.ts:100`, `src/sqlite/store.ts:2450`,
  `src/sqlite/store.ts:2551`, `src/sqlite/store.ts:2697`.
- **Verify first.** Inventory every read and write of merge state, every command
  that calls `requireNoMergeState()`, merge continuation through ordinary
  `commit()`, and hard-reset cleanup. Reopen schema versions 8 and 9 with clean,
  conflicted, ready, corrupt, and orphaned merge rows before choosing the
  migration shape. Prove the existing merge error codes and result shapes at
  `ba85a8b` before changing storage.
- **Scope.** Migrate the single durable journal to an operation-kind-aware
  representation for `merge`, `cherry-pick`, and `revert`. Keep one active
  operation per repository and one shared, path-ordered touched snapshot. Store
  only the discriminated metadata needed to validate the selected source,
  parent/mainline, original HEAD, commit parent, phase, message, identities, and
  recovery action. Version the integrity vector and validate every SQL value,
  referenced object, count, ordinal, path, and retained-byte total before use.
  Preserve existing merge lifecycle behavior and stable merge errors. Generalize
  mutation interlocks so status, diff, add, and rm remain usable; a hard reset
  clears any active operation; unrelated ref/index/worktree mutations fail
  before writes. Ordinary `commit()` remains merge-as-continue only and rejects
  an active replay; typed replay continuation owns replay finalization.
- **Acceptance / witness.** Migration tests upgrade every supported prior schema
  and preserve an active merge byte-for-byte. Cold reopen returns the same
  discriminated operation and next action. Corrupt kind-specific payloads,
  mismatched objects, duplicate/orphaned rows, invalid order, and exact-limit
  overflow fail closed. Cross-kind tests prove a second merge, cherry-pick, or
  revert cannot start, resolution commands remain available, hard reset clears
  state atomically, and the complete existing merge suite remains unchanged.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `src/core/ops/operation-state.ts`, `src/core/ops/merge-state.ts`,
  `src/core/ops/merge-apply.ts`, `src/core/ops/merge.ts`,
  `src/git/client.ts`, `src/compat/computer/client.ts`,
  `tests/migrations.test.ts`, `tests/merge-state.test.ts`,
  `tests/operation-state.test.ts`.

### WU3 — Implement the complete cherry-pick lifecycle (effort XL)

- **Problem.** Callers cannot replay even one existing commit. A safe start must
  preserve the source author, create a new committer and one-parent commit on
  the current branch, or suspend with enough authenticated state to resolve,
  continue, skip, or abort after a restart.
- **Verify first.** Use the WU1 fixtures to distinguish originally empty commits
  from commits whose change is already present, and pin whether Git stops,
  commits, or offers skip for each default case. Confirm conflict labels,
  `CHERRY_PICK_HEAD`-equivalent source ownership, message cleanup, author date,
  committer date, and the final state of unrelated local changes after start,
  partial resolution, continue, skip, and abort.
- **Scope.** Start one cherry-pick only on a checked-out symbolic branch with a
  committed HEAD and index baseline equal to HEAD. Resolve the source and
  optional one-based mainline, build and reserve the replay plan, protect only
  touched paths, then apply inside one outer database transaction. A clean
  non-empty result writes a commit with the original HEAD as its sole parent,
  the source commit's exact author, a newly resolved committer, and the source
  message unless explicitly replaced. A conflict writes standard stages and
  conflict-marker content plus an authenticated replay journal without moving
  HEAD. Model the captured default empty outcome explicitly; never silently
  invent or drop a commit. Continue requires resolved stages and unchanged
  journal ownership; skip restores the pre-operation index/worktree and discards
  this source; abort restores the same pre-operation state. All transitions are
  atomic and restart-safe.
- **Acceptance / witness.** Real-Git parity compares HEAD, the new commit object,
  parent order, tree, author, committer, timestamps, message, full index stages,
  worktree bytes/modes, conflict markers, and empty outcomes. Reopen at every
  suspended phase, resolve with native add/rm, and prove continue, skip, and
  abort produce the pinned result. Fault injection after every write class rolls
  back fully. Unrelated staged or worktree content is either rejected by the
  pinned Git precondition or remains byte-identical. Exact SQL and memory limits
  fail before partial mutation.
- **Touch points.** `src/core/ops/replay.ts`, `src/core/ops/cherry-pick.ts`,
  `src/core/ops/operation-state.ts`, `src/core/ops/merge-apply.ts`,
  `src/core/ops/commit.ts`, `src/core/objects.ts`, `src/sqlite/store.ts`,
  `tests/cherry-pick.test.ts`, `tests/transactions.test.ts`.

### WU4 — Implement revert through the same lifecycle (effort L)

- **Problem.** Revert needs the inverse tree mapping and different commit
  identity/message rules, but its safety, conflict stages, recovery, and cost
  model are otherwise identical to cherry-pick. A separate patch or apply engine
  would create parity drift and duplicate bounds.
- **Verify first.** Capture real-Git results for ordinary and root commits,
  changes already absent from HEAD, content and structural conflicts, revert of
  a merge commit with every valid mainline, missing/invalid mainline, source
  subjects containing unusual whitespace, and continue/skip/abort after partial
  resolution. Pin the exact default message and identity timestamps.
- **Scope.** Apply the inverse replay plan from WU1 and use the shared journal
  and transition machinery from WU2/WU3. A completed revert writes one new
  commit whose sole parent is the original HEAD, whose author and committer are
  resolved for the new operation, and whose default message identifies the
  reverted commit in Git-compatible form. Require an explicit one-based mainline
  for a merge commit and persist that selection. Keep all conflict, empty,
  restart, interlock, atomicity, SQL, and memory behavior symmetric with
  cherry-pick unless the real-Git witness proves a command-specific difference.
- **Acceptance / witness.** The complete revert fixture matrix matches real Git
  for commit contents and repository state. Restart witnesses cover conflict and
  empty phases. Wrong-operation continue/skip/abort calls fail with stable codes
  and do not consume another operation's state. A forward cherry-pick followed
  by the corresponding revert restores the original tree without requiring
  object-identity equality for the commits.
- **Touch points.** `src/core/ops/replay.ts`, `src/core/ops/revert.ts`,
  `src/core/ops/operation-state.ts`, `src/core/ops/merge-apply.ts`,
  `src/core/ops/commit.ts`, `tests/revert.test.ts`,
  `tests/operation-state.test.ts`.

### WU5 — Ship the native API and adversarial conformance (effort M)

- **Problem.** The native client and package exports do not advertise replay
  operations, and no public declaration or compatibility smoke test protects
  the intended surface — `src/git/client.ts:106`, `src/git/client.ts:137`,
  `src/index.ts:18`, `src/git/index.ts:45`.
- **Verify first.** Compile a contract table for start, continue, skip, and abort
  inputs/results before adding methods. Re-read both package entry points and the
  installed Computer interface. Inventory every new stable error code and every
  operation-state branch in the client so callers never need `instanceof`.
- **Scope.** Export native typed methods for `cherryPick`,
  `cherryPickContinue`, `cherryPickSkip`, `cherryPickAbort`, `revert`,
  `revertContinue`, `revertSkip`, and `revertAbort`. Use one compact replay
  result shape that distinguishes committed, conflicted, and explicit empty
  outcomes without exposing persisted rows. Keep the optional Computer facade
  exactly at its installed contract; only update its generic operation
  interlocks where WU2 requires it. Add declaration/build fixtures, public
  client tests, stable-code tests, schema/corruption bounds, and current docs.
  On close, delete backlog item 14, stamp the required shipped-result header,
  and refresh every affected index and reference page in the same change.
- **Acceptance / witness.** Public type tests cover every method and option from
  both native entry points. Native runtime tests cover clean, root, empty,
  conflicted, merge-commit/mainline, continue, skip, abort, restart, wrong
  operation, detached/unborn HEAD, dirty/staged/untracked paths, corrupt state,
  and each structural bound. Compatibility tests prove its declared surface and
  return shapes did not change. The sprint closes only after `npm run check`,
  `npm run typecheck`, a leased full test suite, a leased production build, and
  the docs lint all pass.
- **Touch points.** `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `src/core/ops/kinds.ts`, `src/core/errors.ts`,
  `src/compat/computer/client.ts`, `tests/client.test.ts`,
  `tests/compat.test.ts`, package declaration fixtures, `README.md`,
  `docs/reference/architecture.md`, docs indexes.

## Out of scope (explicit)

- Multiple commits, revision ranges, todo lists, reordering, squashing, and any
  multi-step sequencer remain in [backlog item 07](../backlog/07-rebase.md).
  This sprint deliberately establishes only one replay item and one active
  source commit.
- `--no-commit`, batch cherry-pick/revert, `--quit`, editable instruction lists,
  `-x` provenance trailers, signing, hooks, rerere, strategy selection, custom
  merge drivers, and commit-message editors are not introduced.
- Detached-HEAD and unborn-branch replay are rejected before mutation. The
  checked-out symbolic branch remains the single owner of index and worktree
  state, matching the current merge lifecycle.
- Rename detection, attributes, submodule checkout, and custom conflict drivers
  remain deliberate integration-engine omissions. Replay inherits those limits.
- The Computer compatibility client gains no methods that its installed
  interface does not declare. The generic `git.cli()` dispatcher also remains
  unsupported.
- Reflogs and post-success ref recovery remain in
  [backlog item 12](../backlog/12-reflogs-and-ref-recovery.md). This sprint makes
  suspended operations abortable but does not add historical ref retention.
- Repack/GC, benchmark claims, and production deployment are unrelated to this
  functional sprint.

## Decisions

- One invocation selects exactly one commit. Cherry-pick and revert share one
  replay planner and recovery lifecycle; command-specific code owns only tree
  direction, identity, and message semantics.
- Replay consumes the existing three-tree integration plan. It does not create
  or persist a textual patch representation.
- One authenticated durable operation journal arbitrates merge, cherry-pick,
  and revert. Existing merge behavior and stable errors remain backward
  compatible; replay does not add parallel state tables.
- Start targets only the checked-out symbolic branch. The original HEAD is the
  sole parent of every completed replay commit.
- Merge commits require an explicit one-based mainline. Root-commit behavior and
  both empty classes follow the pinned real-Git default instead of an invented
  fallback.
- Expected conflicts and default empty stops are typed replay results. Invalid
  input, unsafe local state, corruption, and resource exhaustion remain stable
  errors and are always atomic.
- `skip` and `abort` are distinct public transitions even though a one-item
  operation normally gives them the same final tree. This keeps caller intent
  explicit and leaves a stable surface for the later multi-item sequencer.
- Ordinary `commit()` remains merge-as-continue only in this sprint. Replay must
  finish through its typed continue method so operation kind, empty behavior,
  source author, and default message cannot be lost.
- The public feature is native-only because the installed Computer contract has
  no cherry-pick or revert methods. No compatibility-only API is invented.

## Sequencing

| Order | Work | Dependency / parallelism |
|---|---|---|
| 1 | WU1 contract and pure planner | Starts first; real-Git fixtures become the contract for all later WUs. |
| 2 | WU2 journal and interlocks | Uses WU1 metadata requirements; migration fixtures can be prepared alongside WU1 parity fixtures. |
| 3 | WU3 cherry-pick lifecycle | First complete consumer of WU1 and WU2; establishes shared transitions. |
| 4 | WU4 revert lifecycle | Reuses WU3 transitions; revert-specific parity fixtures can be prepared while WU3 runs. |
| 5 | WU5 public surface and gates | Lands after both commands stabilize; final docs and exhaustive gates are last. |

Each WU lands as its own verified commit. Do not split WU2 so schema, validation,
and migration can temporarily disagree, and do not expose public methods before
their complete restart-safe lifecycle exists.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-24 — Git 2.54 parity probe corrected two edge cases without changing
  scope: an empty cherry-pick retains recoverable state, while an empty revert
  terminates without `REVERT_HEAD`; `mainline: 1` is also valid for a normal
  one-parent source. Command-specific behavior wins over the planned symmetric
  fallback.
- 2026-08-24 — Planning touch-point drift: migration witnesses live in
  `tests/schema-migration.test.ts`; atomic apply witnesses live in
  `tests/merge-apply.test.ts` and `tests/merge-lifecycle.test.ts`. The proposed
  `tests/migrations.test.ts` and `tests/transactions.test.ts` do not exist.
- 2026-08-24 — Revert conflict markers required a command-specific incoming
  label. The shared replay policy now selects either the cherry-pick source
  subject or Git's `parent of` revert form and revalidates it after restart.
