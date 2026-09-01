<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Everyday Git shell (2026-08-31)

**Goal.** Make the injected Git command an asynchronous, bounded surface for the
ordinary inspect, stage, commit, branch, rebase, and remote synchronization flow.

**Theme.** The native Git operations already cover most of a coding session, but
the synchronous shell and narrow argv allowlist expose only eight local command
shapes. This sprint makes the shell asynchronous without losing pull-based
pipelines, closes the three native gaps that block ordinary inspection and
pull-rebase, and exposes a deliberately exact everyday CLI rather than claiming
arbitrary Git compatibility.

## Refs re-verified at HEAD (2026-08-31)

- ✔ Shell execution is synchronous from `Shell.run()` through `execute()` and
  command invocation — `src/shell/index.ts:49-53`,
  `src/shell/exec/execute.ts:52-83`, `src/shell/exec/context.ts:299-316`.
- ✔ `ByteStream` is a synchronous generator, and `xargs` invokes child commands
  lazily while its own generator is pulled — `src/shell/exec/bytes.ts:11-12`,
  `src/shell/commands/xargs.ts:150-181`.
- ✔ The Git shell adapter calls `GitCliRunner.runCli()` synchronously and buffers
  the returned stdout and stderr — `src/git/shell.ts:12-35`,
  `src/git/cli/types.ts:27-29`.
- ✔ The argv dispatcher admits only `status`, `diff`, `log`, `rev-list`,
  `symbolic-ref`, `add`, `commit`, and rebase continuation/abort —
  `src/git/cli/parse.ts:130-139`, `src/git/cli/parse.ts:331-339`.
- ✔ Native clone, fetch, ls-remote, push, and pull are asynchronous, while local
  operations are exposed through promise-returning facade methods over mostly
  synchronous domain operations — `src/git/client.ts:303-377`,
  `src/git/client.ts:446-805`.
- ✔ Staged diff is absent: the public diff accepts tree/tree or
  tree/working-tree endpoints but no index endpoint —
  `src/git/ops/diff-internal.ts:5`, `docs/reference/git-support.md:313-327`.
- ✔ Native rebase start, continue, skip, and abort already exist, but the CLI
  admits only continue and abort — `src/git/client.ts:370-373`,
  `src/git/cli/types.ts:92-95`.
- ⚠ Pull already performs fetch plus merge, but explicitly rejects every enabled
  `pull.rebase` value. Fetch publication, later replay failure, stale refs, and
  restart recovery therefore remain part of the work rather than simple argv
  wiring — `src/git/ops/pull.ts:154-168`, `src/git/ops/pull.ts:302`.
- ✔ `show()` returns commit metadata only and `log()` has no path selection —
  `src/git/ops/reads.ts:60-125`, `docs/backlog/37-history-reads-patch-and-paths.md`.
- ✔ Local mutating CLI handlers preflight formatted output inside the same outer
  SQLite transaction, so a reported output-limit failure publishes no mutation —
  `src/git/cli/write.ts:157-180`,
  `docs/decisions/0016-preflight-mutating-cli-output-inside-the-transaction.md`.

## Work units

### WU1 — Async shell and Git argv seam (effort L)

- **Problem.** `Command`, `CommandContext.invoke`, `ByteStream`, `execute()`, and
  `Shell.run()/exec()` are synchronous. Awaiting only the top-level Git call would
  leave async producers unusable in pipelines and would make `xargs` either
  materialize every child result or reject async commands.
- **Verify first.** Run
  `npx vitest run tests/shell/run-inputs.test.ts tests/shell/xargs.test.ts tests/shell/redirect-stream.test.ts tests/shell/git.test.ts` and record the current
  lifecycle, early-close, redirect, stderr, and retained-byte behavior.
- **Scope.** Make `Shell.run()` and `Shell.exec()` return promises. Let injected
  commands and `invoke()` be awaitable. Define `ByteStream` as the one public
  union of synchronous and asynchronous byte iterators, but make every generic
  consumer and transform await-aware: pull with `for await`, await `next()` and
  `return()`, and never pass async input into a sync-only consumer. Existing
  built-ins may remain synchronous producers; every stdin-consuming stage,
  redirect, sink, diagnostic merger, and `xargs` child drain must accept either
  producer through the shared stream kit. Preserve early `return()`, run-owned
  stdin restoration, redirect atomicity, `&&`/`||`/`;` ordering,
  status-after-drain-or-close, exactly-once cleanup, retained-memory release, and
  operation accounting. Add a generic settled-command truncation signal to
  `CommandResult`; `execute()` ORs it with sink truncation into
  `RunResult.truncated`. Make the Git argv dispatcher and handlers awaitable,
  with a promise-returning public runner, while local handlers continue to run and
  preflight synchronously inside `transactionSync()`. Update ADR-0015 and ADR-0016
  to describe the new settled contract; keep `src/shell/` independent of Git.
- **Acceptance / witness.** The focused baseline above passes with awaited calls;
  new witnesses cover delayed and rejecting async sources through a byte consumer,
  a line consumer, `head`, redirect, and stderr merge/drop; multiple async `xargs`
  children; and early close that awaits cleanup exactly once before reading
  status. Rejection releases stdin and retained bytes, and a local Git mutation
  rolls back on output overflow. A pre-truncated Git result sets
  `Shell.run().truncated` even when the sink itself has room. `npm run test:shell`,
  `npm run typecheck`, and
  `npm run package:smoke` pass.
- **Touch points.** `src/shell/exec/`, `src/shell/commands/xargs.ts`,
  `src/shell/commands/index.ts`, `src/shell/index.ts`, `src/git/cli/`,
  `src/git/shell.ts`, shell and Git CLI tests, public export tests, ADR-0015,
  ADR-0016, and shell/Git reference docs.

### WU2 — Staged diff from index to tree (effort L)

- **Problem.** `git diff --cached` and `--staged` are absent, so a caller cannot
  inspect exactly what the next commit would contain
  ([backlog #35](../backlog/35-staged-diff.md)).
- **Verify first.** Run `npx vitest run tests/diff.test.ts tests/git-cli-read.test.ts`
  and add failing parity cases for staged add, delete, modification, mode change,
  staged-plus-unstaged content, path filtering, and an unmerged index.
- **Scope.** Add one explicit staged endpoint to `diff()` and `diffSummary()`,
  comparing the selected tree (HEAD by default) with stage 0 through the existing
  ordered merge. Reject unmerged entries explicitly. Extend the argv grammar with
  `git diff --cached|--staged [<ref>] [-- <paths>...]`; retain plain diff and add
  the already-native one-ref, two-ref, path, and `-U<n>` forms while this parser is
  being touched. Route missing historical blobs through `withPromisorHydration`;
  the CLI handler must not bypass the facade's promisor retry boundary.
- **Acceptance / witness.** The failing cases agree with the installed Git binary
  for patch bytes and structured summaries. Focused diff and CLI suites pass, and
  a cost witness confirms staged diff does not traverse the working tree or add a
  per-path query. A blobless-clone case proves historical staged diff hydrates only
  the required blobs.
- **Touch points.** `src/git/ops/diff-internal.ts`, `src/git/ops/diff.ts`,
  `src/git/client.ts`, `src/git/cli/`, `src/compat/computer/client.ts`,
  `tests/diff.test.ts`, `tests/git-cli-read.test.ts`, and Git support docs.

### WU3 — Everyday read argv (effort M)

- **Problem.** Common read operations exist natively but are unavailable to a
  shell caller, which currently has to leave the CLI surface for repository and
  index questions.
- **Verify first.** Add a table-driven parser test that proves each proposed form
  is currently rejected and list the exact native operation and formatter that
  will serve it.
- **Scope.** Admit bounded forms of `git status` (default, existing short and
  porcelain v1, porcelain v2, optional branch header and literal paths),
  `git rev-parse` (one revision, `--verify`, optional `--quiet`, and
  `--show-toplevel`), `git branch --show-current|--list`, and `git ls-files`
  (`--cached`, `--others`, `--exclude-standard`, and existing bounded pathspecs).
  Add only the human status formatter needed by optionless status; do not broaden
  revision or pathspec grammar beyond the native surface.
- **Acceptance / witness.** Table-driven differential tests compare stdout,
  stderr, and exit code with Git for every admitted form, detached/unborn HEAD,
  no matches, ignored files, nested cwd, malformed combinations, and output
  ceilings. `npx vitest run tests/git-cli.test.ts tests/git-cli-read.test.ts tests/shell/git.test.ts` passes.
- **Touch points.** `src/git/cli/parse.ts`, `src/git/cli/read.ts`,
  `src/git/cli/result.ts`, status formatters, CLI and shell Git tests, and Git
  support docs.

### WU4 — Everyday staging and commit argv (effort M)

- **Problem.** The CLI exposes literal `add` and message-only `commit`, although
  native operations already support the standard whole-tree, tracked-only,
  ignored-path, amend, and empty-commit cases.
- **Verify first.** Add rejected-form tests for `add -A|-u|-f` and
  `commit -a|--amend|--allow-empty`, then ask Git for the exact diagnostics of
  incompatible and missing arguments.
- **Scope.** Add exact forms for `git add -A|--all`, `-u|--update`, `-f|--force`,
  literal paths, and `--`; and `git commit -m|--message`, `-a|--all`, `--amend`,
  and `--allow-empty`. Compose `commit -a` inside the existing outer transaction
  so staging, commit publication, formatting, and output preflight remain one
  rollback unit. Reject unsupported options rather than ignoring them.
- **Acceptance / witness.** Differential tests cover clean, ignored, deleted,
  amended, empty, conflict, nested-cwd, identity, and output-overflow cases. Every
  failed or over-limit command leaves refs, index, worktree, objects, reflogs, and
  operation state unchanged. `npx vitest run tests/git-cli-write.test.ts tests/shell/git.test.ts` passes.
- **Touch points.** `src/git/cli/parse.ts`, `src/git/cli/write.ts`, staging and
  commit operations only where a shared bounded helper is required, CLI and shell
  Git tests, ADR-0016 if its wording needs refinement, and Git support docs.

### WU5 — Everyday branch and worktree-state argv (effort L)

- **Problem.** Native reset, checkout, branch, and complete rebase lifecycle
  operations exist, but the shell cannot start a rebase, skip one, change branch,
  restore paths, or perform the standard recovery commands.
- **Verify first.** Inventory each exact spelling against the public methods in
  `src/git/client.ts:315-373`; add parser refusals and one real-Git state oracle
  per command family before adding handlers.
- **Scope.** Admit bounded exact forms of `git reset [--mixed|--hard] [<ref>]`
  and `git reset [<ref>] -- <paths>...`; `git checkout [-f] <ref>`,
  `git checkout -b <name> [<start>]`, and `git checkout <ref> -- <paths>...`;
  narrow `switch <branch>|-c <name>` and `restore [--source=<ref>] <paths>...`
  aliases over the same native primitives; branch create/list/delete/force-delete
  and rename; `rebase <upstream>|--continue|--skip|--abort`; and the recovery-only
  `merge --continue|--abort` forms needed after a conflicted pull. Preserve dirty
  checks, operation-state exclusions, nested-checkout pruning, and mutating CLI
  output preflight. No new rebase target or merge-start semantics land here.
- **Acceptance / witness.** Differential state tests compare HEAD, refs, index,
  worktree, status, and recovery state after successful and refused commands,
  including detached HEAD, conflicts, nested cwd, stale paths, and cold reopen. A
  shell-level conflicted pull can be committed or aborted after reopen.
  `npx vitest run tests/git-cli-write.test.ts tests/rebase.test.ts tests/rebase-restart.test.ts tests/refs.test.ts tests/checkout-initial.test.ts tests/checkout-sparse.test.ts tests/pull.test.ts tests/shell/git.test.ts` passes.
- **Touch points.** `src/git/cli/`, existing refs, checkout, staging, and rebase
  operations, CLI write tests, relevant operation suites, shell Git tests, and Git
  support docs.

### WU6 — Everyday history reads (effort L)

- **Problem.** `show()` cannot return a commit patch and `log()` cannot select a
  path, leaving two standard code-review questions unanswered
  ([backlog #37](../backlog/37-history-reads-patch-and-paths.md)).
- **Verify first.** Add real-Git cases for root and merge commits, first-parent
  selection, literal path history, exact rename, move-plus-edit, no history, and
  bounded depth.
- **Scope.** Change native `show()` to return
  `{ commit: CommitView, patch?: string }` from options
  `{ ref, patch?: boolean, mainline?: number }`; the compatibility facade keeps
  its metadata-only contract by projecting `commit`. A root patch compares with
  the empty tree, a one-parent commit uses that parent, and a merge requires an
  explicit mainline rather than silently choosing. Add literal `paths` and
  `firstParent` to `log()` with metadata/tree comparisons and early exit. Expose
  exact `git show [--first-parent] [<ref>]` and existing bounded log
  formats/counts with `--first-parent` and `-- <paths>...` through the CLI;
  optionless show of a merge fails loudly as a declared divergence. Route patch
  reads through `withPromisorHydration`; path-log filtering must not hydrate blob
  content.
- **Acceptance / witness.** Differential tests match Git's selected commits and
  patch bytes for the verify-first matrix, prove early depth termination, and
  retain operation and output bounds. Blobless-clone witnesses prove `show` lazily
  hydrates required patch blobs while path-log filtering leaves promises intact.
  `npx vitest run tests/reads.test.ts tests/diff.test.ts tests/git-cli-read.test.ts` passes.
- **Touch points.** `src/git/ops/reads.ts`, `src/git/ops/diff.ts`,
  `src/git/client.ts`, `src/git/cli/`, compat only where its contract can express
  the result, read/diff/CLI tests, and Git support docs.

### WU7 — Repository and network argv (effort L)

- **Problem.** Async clone, ls-remote, fetch, merge-based pull, and push are
  available only through typed APIs; the shell currently reports them as unknown
  or unsupported commands.
- **Verify first.** Record real-Git stdout, stderr, exit status, and repository
  state for the exact basic forms below. Identify which output is knowable before
  each local or remote publication and seed output-limit failures on both sides of
  the receive-pack invocation boundary.
- **Scope.** Add exact bounded forms for `init`, HTTP(S) `clone`, `remote`
  list/add/remove/get-url/set-url, `ls-remote`, `fetch`, merge-based `pull`, and
  `push`, restricted to options already represented by the native API. Route
  authentication through binding callbacks/headers, never environment credential
  helpers. Apply the command-class output policy in Decisions: local-only
  mutations retain ADR-0016 rollback, read-only network output may fail preflight,
  and a command that has crossed a local or remote publication boundary returns
  bounded bytes plus an explicit truncation bit instead of replacing the durable
  outcome with generic `E2BIG`. Preserve `EABORTED`, `EPUSHUNCERTAIN`, confirmed
  receive-pack status, and tracking-reconciliation certainty. Keep all parsing in
  the one allowlisted dispatcher and all transport work out of `src/shell/`.
- **Acceptance / witness.** Real Smart HTTP tests cover success, auth retry,
  cancellation, rejection, response loss, malformed status, stale leases,
  tracking reconciliation, output ceilings, pipelines, redirects, and reopen.
  No test substitutes a mock where the real backend can express the case.
  Directed output-limit cases cover before and after publication for clone,
  fetch, pull, and push.
  `npx vitest run tests/git-cli.test.ts tests/shell/git.test.ts tests/clone.test.ts tests/fetch-refspec.test.ts tests/fetch-publication.test.ts tests/push.test.ts tests/pull.test.ts tests/network-safety.test.ts` passes.
- **Touch points.** `src/git/cli/`, `src/git/shell.ts`, native client option
  decoders, Git CLI/shell tests, Smart HTTP fixtures, ADR-0016, and Git/shell
  reference docs.

### WU8 — Pull with native rebase (effort L)

- **Problem.** Pull recognizes rebase configuration but rejects it, and the
  observable boundary between a published fetch and a replay that completes,
  conflicts, or resumes after eviction is undefined
  ([backlog #28](../backlog/28-pull-rebase.md)).
- **Verify first.** Add failing native and CLI parity cases for explicit and
  configured rebase, fast-forward, clean replay, conflict, cold reopen, continue,
  abort, fetch-only persistence after replay failure, invalid config, stale HEAD,
  and concurrent upstream movement.
- **Scope.** Add an explicit native pull-rebase option and
  `pull.rebase=true`; reject interactive and merge-topology modes. Capture the
  fetched remote-tracking target after successful fetch publication. Revalidate
  HEAD and upstream configuration after the HTTP await and before creating the
  rebase journal. Once the journal exists, later tracking/config movement does not
  retarget the replay: continuation validates journal integrity and final
  publication compare-and-sets the original branch OID. Return
  `PullResult = { strategy: "merge"; result: MergeResult } | { strategy: "rebase"; result: RebaseResult }`;
  compatibility remains merge-only unless its installed contract can represent
  the union. Map a CLI conflict to non-zero status with durable recovery state
  intact, and expose `git pull --rebase [<remote> [<branch>]]` through the async
  CLI. A replay failure must never hide or roll back a completed fetch.
- **Acceptance / witness.** The verify-first native and CLI matrix agrees with
  Git on public repository state. Same-runtime barriers cover races during HTTP
  awaits; fresh `Workspace` checks occur only after a conflicted/pending result
  has returned and the old owner is dead. Directed concurrency tests prove stale
  owners cannot publish, while tracking movement after journal creation does not
  change its captured target. The existing merge-based pull behavior remains
  unchanged. `npx vitest run tests/pull.test.ts tests/rebase.test.ts tests/rebase-restart.test.ts tests/concurrency-network.test.ts tests/shell/git.test.ts` passes.
- **Touch points.** `src/git/ops/pull.ts`, rebase lifecycle and operation-state
  modules, `src/git/client.ts`, `src/git/cli/`, compat only if its installed
  contract can represent recovery, pull/rebase/concurrency/CLI tests, and Git
  support docs.

## Review strategy

Most work units rely on exact differential or state witnesses and receive no
mandatory peer review. Independent implementation review is reserved for the
three seams where a locally plausible mistake can violate execution lifetime or
publish state with the wrong certainty.

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Cross-WU risk is grammar drift and lost bounds between async shell, dispatcher, and native operations. | All focused witnesses, `npm test`, typecheck, check, build, package smoke, and one full suite at closure. No blanket peer review after the three critical WUs are clean. | Any integration fix changes a reviewed lifetime, transaction, or publication seam. |
| WU1 | Fundamental execution-model and public API change; early close or rejection can leak retained bytes or run upstream work. | Focused shell/CLI gates plus independent review of backpressure, cleanup, status timing, and local mutation rollback. Fix and repeat review until no blocking finding remains. | The implementation buffers a formerly lazy pipeline, introduces concurrent pipeline stages, or keeps a transaction open across `await`. |
| WU2 | New read endpoint over an existing ordered merge; no external side effect. | Direct Git parity, cost witness, diff/CLI tests; no peer review. | It adds a new traversal/query shape, changes ordinary diff, or chooses to render unmerged stage 0. |
| WU3 | Parser/formatter exposure of existing reads. | Table-driven differential tests and output-bound witnesses; no peer review. | A handler bypasses native validation or introduces an unbounded formatter/enumeration. |
| WU4 | Existing mutations composed under the established outer transaction. | Differential state tests and rollback-on-overflow witnesses; no peer review. | A command cannot fit ADR-0016's transaction/preflight model or changes native commit/staging semantics. |
| WU5 | Existing local mutation primitives with larger argv grammar. | Differential whole-state and recovery tests; no peer review. | New operation semantics are needed, a worktree mutation crosses databases, or conflict recovery changes. |
| WU6 | Bounded reads only; failures are loud and publish nothing. | Real-Git history/patch parity and bound witnesses; no peer review. | Merge policy is implicit, promised-blob hydration bypasses its owner, or filtering requires an unbounded walk. |
| WU7 | Network commands can create irreversible remote effects and output failure must not falsify certainty. | Real-backend matrix plus independent review focused on abort/uncertain/result and output-limit boundaries. Fix and repeat review until no blocking finding remains. | Transport, push planning, lease semantics, or post-confirmation retry behavior changes rather than being adapted. |
| WU8 | Fetch publication followed by restart-safe local replay crosses await, concurrency, and recovery boundaries. | Native/CLI parity, directed concurrency and cold-reopen witnesses, plus independent review of publication and recovery ownership. Fix and repeat review until no blocking finding remains. | Pull needs a new journal shape, changes merge-default behavior, or broadens rebase beyond the stated linear mode. |

## Test cadence

- **Per WU.** Run the exact acceptance witness. Run `npm run test:shell` for WU1
  and every later WU that changes shell behavior; run only the named Git files
  while iterating on an operation family.
- **Routine integration.** Run `npm test` after each WU; keep this smoke gate below
  30 seconds. Also run `npm run typecheck` and `npm run check` whenever a public
  command, result, or iterator type changes.
- **Sprint closure.** After critical reviews and focused fixes settle, run
  `npm run typecheck`, `npm run check`, `npm run build`,
  `npm run package:smoke`, and then once
  `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run -n 4 -- npm run test:full`.
- **Failure loop.** Reproduce a full-suite failure with its exact file or domain
  slice. Rerun the full suite only after the focused witness is stable.

## Out of scope (explicit)

- Stash remains [backlog #06](../backlog/06-stash-operations.md); it needs new
  durable semantics rather than argv wiring.
- New native upstream/remote lifecycle operations remain
  [backlog #18](../backlog/18-branch-and-remote-management.md). WU7 exposes only
  already-supported remote operations.
- Rebase `--onto`, `--root`, explicit branch selection, interactive editing,
  merge topology, and dependent-ref rewriting remain backlog
  [#25](../backlog/25-rebase-targets-and-roots.md),
  [#26](../backlog/26-interactive-rebase.md),
  [#27](../backlog/27-rebase-merges.md), and
  [#29](../backlog/29-rebase-update-refs.md).
- Glob-shaped mutating pathspecs remain
  [backlog #36](../backlog/36-glob-pathspecs.md). This sprint uses each native
  operation's current literal/prefix selection.
- General `rev-list`, `for-each-ref`, `cat-file -t|-s`, and filter-complete
  plumbing remain [backlog #39](../backlog/39-plumbing-read-surface.md).
- Merge, cherry-pick, revert, stash, tag, reflog, worktree administration, and
  maintenance CLI spellings are not part of the everyday allowlist in this
  sprint, even where typed operations already exist.
- Arbitrary Git flags, fallback execution, SSH/local transports, credential
  helpers, hooks, signing, submodules, and byte-invalid paths remain unsupported.

## Decisions

- The shell becomes asynchronous as a deliberate breaking change. There is one
  promise-returning `run`/`exec` API, not parallel sync and async variants.
- Pull-based byte flow remains the execution model. Supporting async commands
  must not turn pipelines or `xargs` into eager whole-output materialization.
- The Git argv runner becomes awaitable but remains one exact allowlisted
  dispatcher shared by native, compatibility, and shell callers. ADR-0015 is
  rewritten in WU1; the shell package still never imports Git.
- Local mutating handlers remain synchronous inside `transactionSync()` through
  formatting and output preflight. No SQLite transaction spans an `await`.
  ADR-0016 is rewritten only as needed to distinguish local rollback from network
  certainty.
- Network output follows four explicit certainty classes:

  | Class / boundary | Output-limit result |
  |---|---|
  | Local-only `init` and `remote` mutations | Format and preflight inside ADR-0016's transaction; `E2BIG` rolls back everything. |
  | Read-only `ls-remote` | Bounded collection may return `E2BIG`; no state exists to preserve. |
  | Clone/fetch/pull before publication | A known insufficient destination fails before publication; no local state is moved. |
  | Clone/fetch/pull after local publication | Preserve operation status and published state; bound stdout/stderr and set `GitCliResult.truncated`, never replace success or conflict with generic `E2BIG`. |
  | Push before receive-pack invocation | A known insufficient destination may fail with `E2BIG`; no remote request was invoked. |
  | Push after invocation but before confirmed status | Transport certainty decides success/error, including `EPUSHUNCERTAIN`; output truncation is secondary and recorded separately. |
  | Push after confirmed status | Return the confirmed mapped exit status and bounded output with `truncated`; never replace it with `E2BIG`. |
- The everyday surface is the exact grammar named by WU2-WU8. It is not a promise
  of arbitrary Git CLI compatibility.

## Cross-sprint boundary

The completed [shell POSIX surface sprint](../archive/sprint-2026-08-31-shell-posix-surface.md)
owns new shell syntax and built-ins. Its executor work built on WU1's reviewed
async seam; this sprint continues to own the Git argv surface and does not absorb
the POSIX work.

## Sequencing

| Order | Work | Dependency / parallelism |
|---|---|---|
| 1 | WU1 | Foundation; nothing else starts before its review is clean. |
| 2 | WU2, WU3 | May proceed in parallel after WU1; both primarily own read-side files, so coordinate parser edits or land WU2 first. |
| 3 | WU4, WU5, WU6 | May proceed in parallel with disjoint primary operation families; serialize shared parser/type edits. |
| 4 | WU7 | Requires WU1 and the settled parser/handler shape. |
| 5 | WU8 | Requires WU7's async network result policy and WU5's rebase-start CLI. |

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
whether the review strategy is proportionate to each WU and the integrated
sprint risk. Resolve blocking findings before implementation.

- **Reviewer:** independent general agent (`ses_fa74aa3dfffenQ0lldJGCjbL5f`)
- **Verdict:** approved
- **Material findings:** The initial review blocked on the await-aware stream
  contract, post-publication output certainty, partial-clone hydration, rebase
  journal ownership, conflicted-pull recovery, and stale test paths. The plan now
  fixes each contract explicitly, including generic truncation propagation in
  WU1; final re-review found no blocker.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-09-01 — WU1 landed (`739608f`): await-aware shell streams and Git argv
  runner, generic truncation propagation, and async API migration. Focused 63/63,
  shell 344/344, smoke 164/164, typecheck/check/package smoke passed; independent
  lifecycle review clean after one fix round.
- 2026-09-01 — WU2 landed (`0d940a4`): staged diff over the ordered stage-0
  index, exact bounded CLI grammar, and promisor hydration. Focused 180/180,
  smoke 164/164, typecheck/check passed; the cost witness performs no worktree
  traversal or scalar index lookup.
- 2026-09-01 — WU3 landed (`1aa25ce`): bounded everyday status, rev-parse,
  branch, and ls-files argv with cwd-relative paths and human status output.
  Focused 191/191, smoke 164/164 after correcting one stale nested-cwd witness,
  typecheck/check passed.
- 2026-09-01 — WU4 landed (`e11ec4c`): whole-tree, tracked-only, and forced
  staging plus commit-all, amend, and allow-empty argv. Focused 191/191, smoke
  164/164, typecheck/check passed; failure and output-overflow witnesses preserve
  complete repository state.
- 2026-09-01 — WU5 landed (`9431d76`): bounded reset, checkout, switch,
  restore, branch mutation, rebase lifecycle, and merge recovery argv. Focused
  219/219, parser 202/202, shell smoke 164/164, typecheck/check/build passed;
  differential state and cold-reopen recovery witnesses passed. A focused review
  found no remaining blocker after fixing index-source restore, source deletions,
  unsupported branch force-reset, remote switch targets, and literal paths with
  spaces.
- 2026-09-01 — WU6 landed (`28486b3`): native and CLI show patches, explicit
  merge mainlines, first-parent history, and literal path-selected log with
  TREESAME parent pruning. The Computer facade retains its metadata-only show
  shape. Acceptance witnesses passed 118/118, parser 211/211, and smoke 165/165;
  typecheck/check/build passed. Blobless show hydrated only its required patch
  blob, path log issued no HTTP request or blob read, and a 257-commit
  first-parent walk stayed below 1,000 statements through one graph cursor.
