> **OUTCOME — shipped 2026-08-24.** Native and Computer-compatible pull now
> resolve one bounded configured upstream, fetch it over Smart HTTP, revalidate
> HEAD and upstream state across the await boundary, and delegate local
> integration to the complete merge lifecycle. Native conflicts and no-commit
> results remain restart-safe; compatibility conflicts roll local integration
> back while retaining fetched objects and tracking refs. Commit map: WU1–WU3 →
> `2e5f36b`; WU4 → `2e5f36b` plus this archive commit. Verification: `npm run
> check`; `npm run typecheck`; 150 targeted integration tests; leased production
> build; leased full suite — 82 files and 1,530 tests passed, 5 skipped, with one
> unchanged `reads.test.ts` 100 ms wall-clock witness failing at 106.63 ms and
> reproducing on parent `aa3785e` at 112.64 ms. Backlog closed: 01 and 03.
> Deferred: rebase, abortable network operations, general interleaving coverage,
> and the other explicit non-goals below.

# Sprint — Complete pull (2026-08-24)

**Goal.** Deliver a bounded native and compatibility `pull` that fetches the
configured upstream and safely integrates it into the checked-out branch across
already-merged, fast-forward, clean divergent, and conflicted histories.

**Theme.** Fetch already publishes validated remote objects and tracking refs,
while merge already owns bounded history selection, worktree protection, merge
commits, and restart-safe conflict recovery. This sprint composes those operations
without duplicating either engine. Success means every pull either completes its
local integration atomically, leaves native callers an explicit recoverable merge
state, or leaves the local branch, index, and worktree unchanged while retaining a
successful fetch.

Consumed backlog items 01 and 03, which were deleted on ship.

## Refs re-verified at HEAD (2026-08-24, `9058b51`)

- ✔ Native `Git.pull()` still accepts only `GitDirOptions`, returns `never`, and
  throws `EUNSUPPORTED`; merge immediately beside it is live —
  `src/git/client.ts:170`, `src/git/client.ts:369`.
- ✔ The compatibility client also stubs pull, while the installed Computer
  contract already declares remote, URL, local and remote ref selectors,
  fast-forward modes, authentication callbacks, and merge identities, returning
  `Promise<void>` — `src/compat/computer/client.ts:251`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:470`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:914`.
- ✔ Clone records `branch.<name>.remote` and `branch.<name>.merge` in the same
  transaction as the initial local branch and HEAD, so an ordinary cloned branch
  already has a canonical upstream — `src/core/ops/network.ts:392`.
- ✔ Fetch accepts an exact remote ref selector, ingests a provisional pack before
  publication, then updates the selected remote-tracking refs in one transaction;
  it returns the selected incoming OID without moving the local branch —
  `src/core/ops/network.ts:57`, `src/core/ops/network.ts:151`,
  `src/core/ops/network.ts:196`, `src/core/ops/network.ts:233`.
- ✔ Merge already distinguishes already-merged, fast-forward, shallow,
  unrelated, and divergent histories through the bounded merge-base layer. It
  enforces `fastForward` and `fastForwardOnly`, worktree guards, and a final
  expected-HEAD check inside one synchronous transaction —
  `src/core/ops/merge.ts:800`, `src/core/ops/merge.ts:819`,
  `src/core/ops/merge.ts:863`, `src/core/ops/merge.ts:881`.
- ✔ A native divergent conflict or `commit: false` result persists authenticated
  merge state and returns `MergeResult`; continue and abort survive a reopen —
  `src/core/ops/merge.ts:885`, `src/core/ops/merge.ts:901`,
  `src/core/ops/merge.ts:932`, `src/core/ops/merge.ts:974`,
  `src/core/ops/kinds.ts:59`.
- ✔ Compatibility merge deliberately passes `persistConflicts: false`, because
  that interface exposes neither continue nor abort. A conflicted compatibility
  operation therefore rolls back its local mutation and reports `EMERGEFAIL` —
  `src/compat/computer/client.ts:254`, `src/core/ops/merge.ts:870`.
- ⚠ Merge derives conflict labels and its default commit message from the
  `theirs` revision. Pull needs remote-aware Git-compatible presentation without
  teaching the merge engine how to fetch — `src/core/ops/merge.ts:122`,
  `src/core/ops/merge.ts:128`, `src/core/ops/merge.ts:828`.
- ⚠ Backlog item 01 asks pull to classify history itself, and item 03 still says
  merge prerequisites do not exist. Both facts drifted when the merge lifecycle
  shipped; pull must delegate graph selection rather than introduce a second
  bounded walk — `docs/backlog/01-fast-forward-pull.md:22`,
  `docs/backlog/03-divergent-pull.md:14`,
  `docs/archive/sprint-2026-08-24-merge-operation-lifecycle.md:1`.
- ✔ The test harness can compare local state with a pinned real Git fixture and
  can serve that fixture through real `git http-backend`, including request
  recording and authentication — `tests/helpers/git.ts:18`,
  `tests/helpers/http-backend.ts:1`, `tests/helpers/http-backend.ts:50`.

## Work units

### WU1 — Pull contract and upstream resolution (effort M)

- **Problem.** There is no native pull option or result contract, and the raw
  branch and remote configuration needed to choose an incoming branch is an
  untrusted SQLite boundary. Starting network work before validating the checked-
  out branch, option combinations, upstream, and active operation state would
  fetch for a command that could never integrate — `src/git/client.ts:170`,
  `src/core/ops/network.ts:78`, `src/core/repository.ts:255`.
- **Verify first.** Build a contract table from real Git and the installed
  Computer declaration for: no options; configured upstream; explicit `remote`,
  `url`, `ref`, and `remoteRef`; `fastForward`, `fastForwardOnly`, and their
  conflicting combinations; `pull.ff`; detached and unborn HEAD; missing,
  malformed, or non-branch upstream configuration; active merge state; and
  missing identity on a path that would create a merge commit. Pin which failures
  happen before any HTTP request.
- **Scope.** Add a pull operation module with a bounded `PullOptions` contract and
  a pure preflight resolver. Require the current attached branch; if `ref` is
  supplied, require it to name that same branch. Resolve the incoming remote and
  branch from explicit supported options first and then
  `branch.<name>.remote`/`branch.<name>.merge`. Validate all config row types,
  lengths, remote/ref names, URL selection, and option conflicts before using
  them. Support `pull.ff` when no explicit fast-forward option overrides it.
  Reject rebase configuration explicitly instead of silently changing the
  requested integration strategy. Capture the expected symbolic HEAD and OID for
  the later asynchronous stale check. Give missing upstream and malformed pull
  configuration distinct stable errors.
- **Acceptance / witness.** Table-driven resolver tests cover every precedence
  and validation row without a transport. Public tests prove preflight failures
  make zero HTTP requests and do not change objects, refs, index, merge state, or
  worktree rows. Type tests prove the native input is a compatible superset of the
  installed Computer options without `any`, casts, or error suppressions.
- **Touch points.** `src/core/ops/pull.ts`, `src/core/ops/config.ts`,
  `src/core/errors.ts`, `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `tests/pull.test.ts`, `tests/client.test.ts`.

### WU2 — Fetch-to-merge orchestration and stale-state safety (effort L)

- **Problem.** Fetch crosses asynchronous network and pack-ingest boundaries,
  then publishes its own durable tracking state. The later merge is synchronous
  and atomic, but pull could otherwise integrate into a different branch if HEAD
  or its upstream changes while fetch is awaited. No outer SQLite transaction can
  safely span the network — `src/core/ops/network.ts:151`,
  `src/core/ops/network.ts:196`, `src/core/ops/merge.ts:788`.
- **Verify first.** Capture real-Git results and state for up-to-date, local-ahead,
  fast-forward, forced merge commit, clean divergence, conflict, unrelated
  history, and shallow-boundary histories. Add a deterministic transport barrier
  and mutate HEAD, its OID, and upstream configuration separately while fetch is
  suspended. Confirm the exact remote-aware merge message and conflict labels
  emitted by real Git under pinned identity and time.
- **Scope.** Fetch only the resolved upstream branch through the existing Smart
  HTTP path. After fetch completes and before any local integration, reopen or
  re-read the repository and compare symbolic HEAD, local OID, and the relevant
  upstream selection with the preflight snapshot; fail with `ESTALEHEAD` or a
  configuration-specific stable error when it changed. Pass the fetched incoming
  commit into the existing merge operation exactly once. Add only the narrow
  internal label/default-message seam needed for Git-compatible pull output;
  keep all ancestry, integration, worktree, commit, and recovery logic inside
  merge. Forward `fastForward`, `fastForwardOnly`, `commit`, message, and identity
  inputs without changing merge semantics.
- **Acceptance / witness.** Real Smart HTTP tests prove every history result and
  compare HEAD, local branch, tracking ref, full index stages, worktree bytes and
  modes, merge parents, message, and conflict markers with real Git. Barrier tests
  prove a stale local state never integrates the fetched tip, while the complete
  fetched pack and tracking ref remain readable. Dirty, staged, untracked,
  shallow, unrelated, corrupt, and bounded-capacity failures preserve the merge
  operation's existing atomicity. SQL and retained-memory witnesses cover the
  composed post-fetch integration without weakening either operation's limits.
- **Touch points.** `src/core/ops/pull.ts`, `src/core/ops/network.ts`,
  `src/core/ops/merge.ts`, `src/core/repository.ts`, `tests/pull.test.ts`,
  `tests/helpers/http-backend.ts`, `tests/helpers/git.ts`.

### WU3 — Native recovery and compatibility projection (effort L)

- **Problem.** Native callers can continue or abort a merge and need structured
  pull outcomes, while the installed Computer contract returns `void` and cannot
  reach recovery methods. Sharing one orchestration path must not leave
  compatibility callers in an operation state they cannot complete —
  `src/git/client.ts:171`, `src/compat/computer/client.ts:158`,
  `node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:914`.
- **Verify first.** Exercise clean and conflicted divergent pull through both
  public clients. For native pull, reopen the same SQLite state before continue
  and abort. For compatibility pull, snapshot local branch, index, worktree, and
  merge state before the command and confirm the existing single-shot merge
  policy is the only reachable contract.
- **Scope.** Return `MergeResult` from native pull so callers can distinguish
  already-merged, fast-forward, committed, conflicted, and pending-commit
  outcomes. Expose native `message?: string` and `commit?: boolean` in addition
  to the installed Computer input fields. Persist native conflicts and no-commit
  results through the existing merge journal. Implement compatibility pull with
  the exact installed `Promise<void>` shape: project successful outcomes to
  `void`, use `persistConflicts: false`, and return the existing stable merge
  failure on conflict. In both clients, retain the successful fetch even when
  local integration fails. Replace only the pull unsupported witnesses; stash
  and CLI remain explicit stubs.
- **Acceptance / witness.** Native public tests prove structured results,
  conflict resolution through `add`/`rm` plus `mergeContinue` or `commit`, exact
  restart behaviour, and path-scoped abort. Compatibility tests prove clean pull
  returns exactly `undefined`, conflicts leave no pending merge or local partial
  mutation, and the fetched tracking tip remains available for inspection or
  retry. Public declaration tests cover both exported entry points and the
  optional compatibility peer.
- **Touch points.** `src/git/client.ts`, `src/git/index.ts`, `src/index.ts`,
  `src/compat/computer/client.ts`, `tests/pull.test.ts`, `tests/client.test.ts`,
  declaration/build fixtures.

### WU4 — Adversarial conformance and current documentation (effort M)

- **Problem.** Pull composes the two broadest mutation surfaces in the Git
  runtime. Happy-path output alone would not prove fetch publication, local
  rollback, restart recovery, or the combined cost contract. README and current
  reference still list fetch and merge separately because pull is unsupported —
  `README.md:52`, `docs/reference/architecture.md`.
- **Verify first.** Inventory every new config field, retained string, ref/OID,
  async boundary, and error exit. Map each to a type, corruption, exact-limit,
  first-rejected-boundary, or state-snapshot witness. Re-read the current package
  exports and compatibility smoke surface before documenting support.
- **Scope.** Complete real-Git parity for configured and explicit upstreams,
  authentication/progress forwarding, all history shapes, `pull.ff`, forced and
  ff-only integration, clean and dirty worktrees, conflicts, no-commit, continue,
  abort, stale async state, shallow histories, malformed config rows, hostile
  advertisements, and structural bounds. Assert stable codes rather than class
  identity. Update README and current architecture/reference text to describe
  the shipped native and compatibility semantics and their deliberate difference
  on conflicts. On sprint close, delete backlog items 01 and 03, archive this
  sprint with the required shipped-result header, and refresh all docs indexes
  in the same change.
- **Acceptance / witness.** `npm run check`, `npm run typecheck`, the full test
  suite under an appropriate CPU lease, and a leased production build pass.
  Pull-specific tests include real-server differential witnesses and exact state
  snapshots for success and every failure class. Docs lint reports no broken
  relative links or index drift.
- **Touch points.** `tests/pull.test.ts`, `tests/client.test.ts`,
  `tests/merge-lifecycle.test.ts`, `README.md`, `docs/reference/architecture.md`,
  `docs/INDEX.md`, `docs/backlog/README.md`, `docs/sprints/README.md`.

## Out of scope (explicit)

- Rebase-based pull and `pull.rebase` execution remain out of scope. Native
  rebase shipped later in the
  [bounded rebase sprint](./sprint-2026-08-25-bounded-rebase-sequencer.md), but a
  non-false pull-rebase request still fails explicitly; it never falls back to
  merge.
- Typed upstream setters, branch rename, remote rename, URL mutation, and custom
  tracking cleanup remain in
  [backlog item 18](../backlog/18-branch-and-remote-management.md). Pull consumes
  the configuration clone already writes and callers can set through `configSet`.
- Cancellation of fetch or integration remains in
  [backlog item 15](../backlog/15-abortable-network-operations.md).
- The systematic all-operation interleaving matrix remains in
  [backlog item 16](../backlog/16-concurrent-and-restart-conformance.md). This
  sprint covers the pull-specific await boundary and stale-HEAD/upstream races.
- Reflogs, ref recovery, and garbage-collection roots remain in
  [backlog item 12](../backlog/12-reflogs-and-ref-recovery.md) and
  [backlog item 04](../backlog/04-repack-and-garbage-collection.md).
- Arbitrary fetch refspec expansion, multi-upstream integration, octopus merge,
  unrelated-history opt-in, SSH, signing, hooks, submodule checkout, and custom
  merge drivers are not introduced by pull.
- Compatibility pull does not persist conflicts because its installed public
  interface cannot continue or abort them. Native pull remains the recoverable
  surface.

## Decisions

1. Backlog items 01 and 03 ship as one sprint. Fast-forward and divergent paths
   remain separate work units and can land as atomic commits, but there is no
   temporary public fast-forward-only pull release.
2. Pull is orchestration, not a graph operation. It delegates every history and
   worktree decision to the existing merge engine.
3. Pull targets only the currently checked-out symbolic branch. An explicit
   local `ref` may confirm that branch but cannot mutate an inactive branch or a
   detached HEAD.
4. Merge is the default divergent strategy. Explicit options override supported
   `pull.ff` configuration. Rebase requests fail as unsupported.
5. Native pull returns the existing `MergeResult` and adds `commit` and `message`
   controls. Compatibility pull preserves its installed `Promise<void>` contract.
6. Fetch publication and local integration are two durable phases. Successful
   fetched objects and tracking refs survive any later integration refusal,
   conflict, or stale-state error; branch, index, worktree, and merge-state writes
   remain one merge transaction.
7. Pull captures HEAD and upstream before the first await and revalidates them
   immediately after fetch. It never integrates into whichever branch happens to
   be current later.
8. Native conflicts use the existing restart-safe merge journal. Compatibility
   conflicts use the existing single-shot rollback policy because that interface
   has no recovery methods.

These decisions compose established fetch and merge boundaries. They do not
introduce a new architectural dependency or require an ADR.

## Sequencing

| Order | Work | Dependency / parallelism |
|---|---|---|
| 1 | WU1 contract and resolver | Lands first; fixes the public and internal seam. |
| 2 | WU2 native orchestration | Depends on WU1; parity fixtures can grow alongside implementation. |
| 3 | WU3 compatibility and recovery projection | Depends on WU2; native restart tests can land with either WU2 or WU3. |
| 4 | WU4 adversarial gates and docs | Final integration gate after every public path exists. |

Keep write ownership sequential because WU1–WU3 all touch the client and pull
operation seams. Real-Git fixture capture, hostile transport fixtures, and docs
drafting are read-only or disjoint and may proceed alongside the owning work
unit.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-24 — Real Git 2.54 refuses an unconfigured divergent pull and asks for
  `pull.rebase` or `pull.ff`. This sprint keeps the approved merge-default native
  contract from Decision 4; configured rebase modes fail explicitly rather than
  silently selecting merge.
- 2026-08-24 — Independent WU1 review found that lower-priority invalid upstream
  config could defeat explicit selectors, config values were materialized before
  pull bounds, and HEAD OIDs were trusted. Explicit selectors now avoid unused
  config reads, `configGetBounded()` probes type and byte size before reading the
  value, and pull validates the checked-out commit before HTTP.
- 2026-08-24 — WU1 and WU2 share the public client and acceptance witness, so
  they are integrated as one checkpoint rather than committing a typed public
  method whose runtime body still throws `EUNSUPPORTED`.
- 2026-08-24 — Independent feature review found incorrect `remote`/`url`
  precedence, unsafe URL presentation, a non-Git conflict label, and missing race
  witnesses. Pull now keeps the configured tracking namespace under an explicit
  transport URL, strips userinfo/query/fragment from persisted messages, uses the
  fetched OID in conflict markers, and covers every captured HEAD/upstream field.
- 2026-08-24 — The leased full suite had one unrelated timing failure in
  `reads.test.ts`. An isolated no-SMT run reproduced it on the sprint parent
  `aa3785e`, so it is recorded as a baseline gate exception rather than attributed
  to pull.
