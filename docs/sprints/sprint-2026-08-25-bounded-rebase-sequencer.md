# Sprint — Bounded rebase sequencer (2026-08-25)

**Goal.** Deliver a bounded, restart-safe native rebase for one checked-out
linear branch, with explicit continue, skip, and abort transitions and one final
atomic branch publication.

**Theme.** Rebase is ordered one-commit replay. It belongs with the operation
step journal because the existing one-row journal cannot authenticate a replay
queue or its cursor. Success means every selected commit is replayed in order,
the checked-out branch moves exactly once after the sequence completes, and any
suspended or rejected outcome remains recoverable without relying on a `.git`
directory.

Consumes backlog items [24](../backlog/24-operation-step-journal.md) and
[07](../backlog/07-rebase.md). Backlog 24 is the first implementation unit, not a
parallel follow-up.

## Refs re-verified at HEAD (2026-08-25, `7b5bc3c`)

- ✔ Schema v10 has one wide `git_operation_state` row for `merge`,
  `cherry-pick`, and `revert`, plus a path-ordered touched snapshot. It has no
  step table, replay cursor, or `rebase` kind — `src/sqlite/schema.ts:13`,
  `src/sqlite/schema.ts:100`, `src/sqlite/schema.ts:143`.
- ✔ The v9 → v10 migration preserves authenticated merge state, while active
  one-commit replay already round-trips through a cold reopen. The v11 migration
  must retain both shapes rather than invalidating them —
  `src/sqlite/schema.ts:384`, `tests/schema-migration.test.ts:475`,
  `tests/operation-state.test.ts:105`.
- ✔ Journal reads stream touched rows with `db.iterate()`, validate ordinals,
  counts, retained bytes, referenced objects, and an integrity OID before use —
  `src/sqlite/store.ts:2484`, `src/sqlite/store.ts:2575`,
  `src/sqlite/store.ts:2635`, `src/sqlite/store.ts:2642`.
- ✔ Cherry-pick and revert share a pure, bounded one-commit planner and one
  lifecycle. The planner already preserves source commit metadata and maps a
  selected parent into the three-tree integration engine —
  `src/core/ops/replay.ts:11`, `src/core/ops/replay.ts:37`,
  `src/core/ops/replay.ts:270`, `src/core/ops/replay-lifecycle.ts:308`.
- ⚠ The shared replay lifecycle assumes that the original HEAD remains the
  current parent for the whole operation. Continuation always re-plans against
  `originalHeadOid`, so it cannot resume the second or later rebase step —
  `src/core/ops/replay-lifecycle.ts:88`,
  `src/core/ops/replay-lifecycle.ts:196`,
  `src/core/ops/replay-lifecycle.ts:455`.
- ⚠ `commitIndex()` always moves the observed HEAD ref after writing a commit.
  Rebase needs the same tree/commit writer without publication so intermediate
  result commits remain reachable only through the authenticated journal —
  `src/core/ops/commit.ts:57`, `src/core/ops/commit.ts:70`,
  `src/core/ops/commit.ts:87`.
- ✔ The indexed commit graph walk is bounded at 50,000 commits and 32 MiB,
  validates cycles and missing parent rows, and stops traversal at recorded
  shallow boundaries — `src/core/repository.ts:381`,
  `src/core/repository.ts:390`, `src/core/repository.ts:442`.
- ✔ Merge-base selection distinguishes already-contained, fast-forward,
  divergent, unrelated, and shallow histories with a bounded graph model. A
  linear rebase range can reuse this selection without inventing a second graph
  reader — `src/core/ops/merge-base.ts:21`,
  `src/core/ops/merge-base.ts:215`, `src/core/ops/merge-base.ts:243`.
- ✔ Public mutation interlocks already reject a second integration operation,
  allow conflict resolution through add/rm, and make hard reset clear the
  journal atomically — `src/git/client.ts:281`, `src/git/client.ts:286`,
  `src/git/client.ts:293`, `src/git/client.ts:305`.
- ⚠ The native `Git` surface has replay methods but no rebase contract. The
  installed `@cloudflare/computer` interface has no rebase method, so the
  compatibility facade has no corresponding method to implement —
  `src/git/client.ts:158`, `src/git/client.ts:197`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:913`.
- ✔ Targeted replay and journal regression tests pass at HEAD: 4 files and 46
  tests — `tests/replay.test.ts`, `tests/operation-state.test.ts`,
  `tests/cherry-pick.test.ts`, `tests/revert.test.ts`.

## Work units

### WU1 — Add the authenticated operation step journal (effort XL)

- **Problem.** One source commit, parent selection, outcome, and result are
  encoded directly in the operation header. That shape cannot represent an
  ordered rebase queue and extending the header would make its kind/phase
  `CHECK` unreadable — `src/sqlite/schema.ts:102`,
  `src/core/ops/operation-state.ts:31`, `src/sqlite/store.ts:2482`.
- **Verify first.** Enumerate every read, write, replacement, clear, corruption
  probe, and migration involving `git_operation_state` or
  `git_operation_touched`. Reopen schema v10 with clean, conflicted, and empty
  cherry-pick/revert journals plus every supported merge phase. Record the exact
  current integrity vectors before changing them.
- **Scope.** Add a schema-v11 `git_operation_steps` table keyed by
  `(repo_id, ordinal)`. Each row stores one authoritative source commit,
  selected parent/mainline where applicable, a constrained outcome, and a result
  OID only for an applied step. Keep the operation row as the bounded header and
  keep touched rows as ownership for only the suspended step. Extend the
  integrity vector and retained-byte accounting over the header, ordered steps,
  and touched rows. Bound step count and retained bytes before allocation or
  mutation. Migrate each active v10 cherry-pick/revert into one pending step;
  preserve active merge state. Make existing one-commit replay use the one-step
  shape without changing its public results or stable errors. Add the `rebase`
  operation discrimination and typed store seams needed by later units, but no
  rebase execution.
- **Acceptance / witness.** `tests/operation-state.test.ts` proves multi-step
  order, cursor/outcome transitions, object validation, exact count/byte limits,
  orphan rejection, integrity binding, and cold reopen. Migration tests prove
  v10 → v11 preservation for every active operation kind. Existing merge,
  cherry-pick, and revert lifecycle suites remain unchanged and pass.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `src/core/ops/operation-state.ts`, `src/core/ops/replay-lifecycle.ts`,
  `tests/schema-migration.test.ts`, `tests/operation-state.test.ts`,
  `tests/merge-state.test.ts`, `tests/cherry-pick.test.ts`,
  `tests/revert.test.ts`.

### WU2 — Select one bounded linear replay sequence (effort L)

- **Problem.** Merge-base can classify two histories, but no pure operation
  selects `HEAD` commits absent from an upstream, proves that the selected range
  is linear, orders it oldest-first, or accounts for the retained sequence —
  `src/core/ops/merge-base.ts:215`, `src/core/repository.ts:381`.
- **Verify first.** Capture real Git results for upstream already contained by
  HEAD, HEAD behind upstream, one divergent linear commit, several divergent
  commits, multiple best bases, a merge commit in the selected range, unrelated
  histories, a shallow boundary, an invalid revision, and exact count/byte
  boundaries. Pin commit order and no-op/fast-forward behavior before defining
  the result contract.
- **Scope.** Add a mutation-free planner for `rebase({ upstream })`. Resolve and
  peel one bounded revision. Reuse bounded merge-base selection, then retain only
  the unique first-parent chain from the selected base to HEAD. Reject selected
  merge commits and ambiguous/multiple bases with stable errors; reject shallow
  or unrelated proof gaps. Record the resolved upstream/base/original HEAD and
  the ordered source steps. Bound revision text, graph commits, step count,
  retained bytes, parent edges, and SQL work.
- **Acceptance / witness.** Pure tests compare the selection and ordering with
  the real Git fixture matrix. The exact count and byte boundary passes; the next
  unit fails with `E2BIG`. Invalid, corrupt, cyclic, shallow, nonlinear, and
  unrelated inputs leave refs, objects, index, worktree, and operation state
  unchanged.
- **Touch points.** `src/core/ops/rebase-plan.ts`,
  `tests/rebase-plan.test.ts`, `tests/helpers/git.ts`.

### WU3 — Write replay commits without publishing HEAD (effort L)

- **Problem.** `commitIndex()` combines two responsibilities: materializing the
  index tree/commit and updating HEAD. Rebase must authenticate intermediate
  commits in its journal while leaving the branch at the original commit until
  the sequence completes — `src/core/ops/commit.ts:57`,
  `src/core/ops/commit.ts:70`.
- **Verify first.** Prove the current commit object, cache projection, statement
  model, and stale-HEAD behavior for `commitIndex()`. Pin real Git author,
  author date, message, new committer date, and rewritten parent behavior across
  two replayed commits.
- **Scope.** Split commit materialization from conditional ref publication.
  Expose one internal unpublished writer that builds the stage-zero tree and
  commit object with explicit parents and identities, atomically with its cache
  projection, but never updates HEAD. Keep `commit()` and `commitIndex()` behavior
  unchanged by composing the same primitive. Return the tree and commit OIDs
  needed for sequencer validation, with explicit SQL accounting.
- **Acceptance / witness.** Unit tests prove the unpublished writer creates an
  authoritative commit and cache projection while refs remain byte-identical.
  Existing commit, merge, cherry-pick, and revert tests retain their exact
  results. Fault injection rolls back objects and projections together.
- **Touch points.** `src/core/ops/commit.ts`, `tests/commit.test.ts`,
  `tests/commit-cache.test.ts`, `tests/transactions.test.ts`.

### WU4 — Execute and recover the rebase lifecycle (effort XL)

- **Problem.** There is no coordinator that applies each selected patch onto the
  previous unpublished result, advances the authenticated cursor, suspends at a
  conflict, or restores the original checked-out state on abort —
  `src/core/ops/replay-lifecycle.ts:308`,
  `src/core/ops/replay-lifecycle.ts:397`,
  `src/core/ops/replay-lifecycle.ts:469`.
- **Verify first.** Pin real Git state after clean completion, source-empty and
  result-empty steps, a conflict at every sequence position, partial conflict
  resolution, continue, skip, abort, and process restart. Compare HEAD, branch
  refs, commit parents/trees/messages/identities, index stages, worktree bytes and
  modes, and the absence of sequencer state after terminal outcomes.
- **Scope.** Start only on a checked-out local branch with committed HEAD and a
  clean index baseline. Persist the complete bounded step queue before the first
  mutation. Apply each source delta against the previous result tree through the
  shared three-tree integration and path-safety machinery. Materialize clean
  steps without publishing the branch, persist each result/cursor transition,
  and suspend conflicts with authenticated touched ownership. Continue resolves
  the current step, then advances; skip restores that step and advances; abort
  restores the original HEAD tree/index/worktree and clears the journal. Preserve
  original author, author date, message, and intentional source-empty commits;
  use a new committer and drop commits whose patch becomes empty, matching the
  pinned default Git behavior. Publish the checked-out branch with one final
  expected-old-OID update only after all steps complete. Every durable transition
  is atomic, restart-safe, and below the SQL and memory caps.
- **Acceptance / witness.** Real Git parity covers linear completion, up-to-date,
  fast-forward, conflict/continue, conflict/skip, abort from every step,
  source-empty, result-empty, shallow history, and restart after each durable
  transition. Fault injection after every write class yields either the previous
  authenticated state or the next complete state. Stale branch/ref, corrupt step,
  and capacity failures publish nothing and return stable errors.
- **Touch points.** `src/core/ops/rebase.ts`,
  `src/core/ops/rebase-lifecycle.ts`, `src/core/ops/replay.ts`,
  `src/core/ops/integration-worktree.ts`, `src/core/ops/merge-apply.ts`,
  `tests/rebase.test.ts`, `tests/rebase-restart.test.ts`,
  `tests/transactions.test.ts`.

### WU5 — Expose the native API and lock cross-command interlocks (effort M)

- **Problem.** Callers cannot start or recover a rebase, and current stable
  operation errors discriminate only merge, cherry-pick, and revert —
  `src/git/client.ts:158`, `src/core/ops/operation-state.ts:25`,
  `src/core/ops/operation-state.ts:320`.
- **Verify first.** Inventory every public mutation while each rebase phase is
  active. Confirm that status/diff/add/rm remain available for resolution, hard
  reset clears state, and every other ref/index/worktree mutation rejects before
  writes. Confirm package barrels emit the intended declaration surface.
- **Scope.** Add `rebase({ upstream })`, `rebaseContinue()`, `rebaseSkip()`, and
  `rebaseAbort()` to the native `Git` interface. Return a discriminated
  `RebaseResult` that distinguishes completed, conflicted, and up-to-date
  outcomes and exposes the completed HEAD plus replayed/skipped counts. Wire the
  operations through current repository resolution and interlocks. Export the
  option/result types from both native package barrels. Keep the Computer
  compatibility facade unchanged because its installed contract has no rebase.
- **Acceptance / witness.** Public client tests drive every lifecycle method
  through reopen, assert wrong-operation stable codes, and typecheck the exported
  contract. The full operation-interlock matrix passes for merge, cherry-pick,
  revert, and rebase. Build declarations contain no compatibility-only rebase
  surface.
- **Touch points.** `src/git/client.ts`, `src/core/ops/kinds.ts`,
  `src/index.ts`, `src/git/index.ts`, `tests/client.test.ts`,
  `tests/rebase.test.ts`, `tests/operation-state.test.ts`.

## Out of scope (explicit)

- Interactive rebase, edit/reword/squash/fixup/exec, autosquash, and custom todo
  editing. This sprint exposes one deterministic non-interactive sequence.
- `--rebase-merges` and replay of a merge commit. A selected nonlinear range is
  rejected instead of silently flattening or choosing a mainline.
- Separate `--onto`, branch arguments, and `--root`. The first native contract
  rebases the checked-out branch onto one resolved upstream.
- Rebase-based pull. `pull.rebase` remains rejected by
  `src/core/ops/pull.ts`; enabling it needs its own network/config parity scope.
- Reflogs and recovery of a branch after a completed rebase — backlog
  [12](../backlog/12-reflogs-and-ref-recovery.md).
- A repository-wide async operation epoch and full concurrent/restart matrix —
  backlog [16](../backlog/16-concurrent-and-restart-conformance.md). This sprint
  still owns stale-ref checks and restart safety for its journal transitions.
- Stash operations. Backlog [06](../backlog/06-stash-operations.md) depends on the
  step journal but keeps its own commit shape and conflict parity sprint.
- Pulling CI/release work into the feature sprint — backlog
  [05](../backlog/05-ci-and-release-gates.md) remains the next release-readiness
  sprint.

## Decisions

- The initial native API is `rebase({ upstream })` on the checked-out local
  branch, plus explicit continue, skip, and abort methods. `onto`, `root`, and a
  separate branch selector are deferred.
- The accepted history shape is one unique base and a linear first-parent replay
  range. The implementation rejects merge commits and ambiguous bases rather
  than guessing a flattening policy.
- Intermediate rewritten commits are durable objects referenced by the journal,
  not temporary refs. The checked-out branch remains at its original OID until
  one final compare-and-set publication.
- Operation steps are authenticated relational rows. JSON may batch bounded SQL
  parameters but does not become persisted sequencer state.
- Each step transition has its own bounded transaction and durable cursor.
  A caller may advance several clean steps in one async method, but no transition
  may rely on one unbounded transaction or exceed the per-operation limits.
- Source-empty commits are retained and result-empty commits are skipped, subject
  to the real Git witness captured before WU4 implementation.
- No ADR is required yet: these choices scope the first rebase surface and can be
  extended compatibly. If implementation proves that branch publication or
  journal ownership changes a repository-wide invariant, stop and record that
  decision before continuing.

## Sequencing

| Wave | Unit | Depends on | Write territory | Done-check |
|---|---|---|---|---|
| 0 | WU1 journal seam | none | schema, store, operation state, existing replay lifecycle | migration + operation-state + existing replay suites |
| 1 | WU2 sequence planner | WU1 types | new rebase planner + planner tests | pure planner and real-Git selection parity |
| 1 | WU3 unpublished commits | WU1 types | commit writer + commit/cache/transaction tests | ref-preserving commit witness |
| 2 | WU4 lifecycle | WU1–WU3 | rebase coordinator/apply + rebase tests | lifecycle, restart, bounds, fault injection |
| 3 | WU5 public surface | WU4 | client/barrels/interlock tests | public API, typecheck, declarations |

WU2 and WU3 have disjoint write territories and may run in parallel after WU1.
WU4 freezes their contracts before composing them. WU5 owns the public barrels
and client surface so no earlier implementer appends to those hot files.

Sprint gates, in order: targeted tests per WU; `npm run typecheck`; `npm run
check`; leased `npm test`; leased `npm run build`; docs lint. Full test and build
gates run serially through `cpu-lease`.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim it to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-25, WU1 pre-review: v10 → v11 migration must validate the legacy
  retained-byte count and integrity vector before re-authenticating transformed
  rows. The v11 seam must also authenticate the complete rebase topology and
  expose one whole-journal CAS transition; later WUs do not own schema/store.
- 2026-08-25, WU1 diff review: journal reads validate anchors by object type,
  the complete source chain through original HEAD, result parents, and monotonic
  CAS transitions. They deliberately do not walk the upstream graph on every
  state read; WU2 selects that relationship and WU4 must revalidate it before
  using resumed state so ordinary mutation interlocks stay bounded.
- 2026-08-25, WU3 review: the unpublished commit writer owns exact source
  messages, including empty and non-canonical messages, while public commit
  paths retain their existing cleanup. Commit materialization now exposes one
  shared preflight cost model and leaves ref publication to its caller.
- 2026-08-25, WU2 review: replay and rebase share one bounded authoritative
  revision resolver without changing replay validation precedence. Planner
  limits are lower-only, so exact step, retained-byte, and graph boundaries are
  testable without weakening the production ceilings.
