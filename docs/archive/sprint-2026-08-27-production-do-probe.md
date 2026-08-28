# Sprint — Production Durable Object probe (2026-08-27)

> **OUTCOME — SHIPPED 2026-08-27.** Added a pinned Wrangler deployment,
> authenticated production Worker, external runner, analytics query, protocol
> tests, reference runbook, and sanitized retained evidence. A production run
> completed every Git, restart, failure, storage-reset, and physical-audit
> witness below. The Worker remains deployed for later release candidates.

**Goal.** Produce a repeatable release-candidate probe against production
Durable Object SQLite and retain evidence for correctness, restarts, cost, and
external wall time.

**Theme.** One operator workflow owns the production-only facts that local
Node and workerd runs cannot prove. It deploys one isolated probe Worker, drives
bounded operations through one request per measurement, resets the DO at
authenticated rebase boundaries, and records the result without committing
credentials.

## Refs re-verified at HEAD (2026-08-27)

- ✔ The current local release baseline is pinned at `d03aa70`; production timing
  remains explicitly unverified —
  `../reference/benchmark-current.md:1`,
  `../archive/sprint-2026-08-27-worktree-performance-and-budget.md:444`.
- ✔ The existing workerd harness measures only clone and runs through
  Miniflare, not a deployed Worker — `../../bench/workerd/worker.ts:149`,
  `../../bench/workerd/run.ts:115`.
- ✔ `Workspace.git` initializes the Git store lazily and accepts an injected
  HTTP transport, which lets the probe use real external fetch for clone/fetch
  and a deterministic receive-pack witness for push —
  `../../src/runtime/workspace.ts:44`, `../../src/runtime/workspace.ts:50`,
  `../../src/runtime/workspace.ts:79`.
- ✔ The public Git client exposes clone, fetch, mutation, push, and the complete
  rebase lifecycle needed by the probe — `../../src/git/client.ts:221`.
- ✔ The Durable Object adapter delegates synchronous nesting to
  `storage.transactionSync()`; production storage is therefore the required
  transaction witness — `../../src/sqlite/db.ts:96`.
- ✔ The project has no Wrangler dependency, deploy configuration, or probe
  operator command at HEAD — `../../package.json:35`,
  `../../.github/workflows/ci.yml:1`.
- ✔ Wrangler OAuth is valid for the authorized account with Workers write access.
  Local deployment of `kompjutr-git-probe` was explicitly authorized for this
  sprint; credentials remain outside the repository.
- ✔ Cloudflare documents `ctx.abort()` as an immediate Durable Object reset.
  New class lifecycle state can be declared with a SQLite `exports` entry in
  current Wrangler configuration.

## Work units

### WU1 — Probe contract and production Worker (effort L)

- **Problem.** `bench/workerd/worker.ts:149` proves one local clone only. It has
  no production request contract, authentication, restart control, failure
  classification, or multi-operation state witness.
- **Verify first.** Confirm the deployed runtime supports SQLite DO class
  exports, `transactionSync()`, `SqlStorage.databaseSize`, and `ctx.abort()`.
- **Scope.** Add an authenticated Worker and SQLite Durable Object under
  `bench/production/`. Count SQL statements and returned rows per operation;
  record foreign-key state before and after Git initialization on every
  constructor; expose bounded steps for clone, fetch, write/add/commit, push,
  clean and conflicting rebase, continue, abort, application failure, isolate
  reset, storage reset, and physical audit. Use a unique named DO per run.
- **Acceptance / witness.** A local bundle/type gate passes. The deployed Worker
  rejects a missing token, each successful operation stays at or below 1,000
  SQL statements, every postcondition is checked inside the DO, and a response
  above the configured result bound fails closed.
- **Touch points.** `bench/production/worker.ts`, `bench/production/protocol.ts`,
  production-focused tests.

### WU2 — Operator runner and pinned Wrangler setup (effort M)

- **Problem.** `package.json:35` has no reproducible deploy tool or command, and
  the production wall clock must be measured outside the Worker.
- **Verify first.** Run `wrangler whoami` and confirm the selected account before
  any write. Confirm the Worker name is unused or is already this probe.
- **Scope.** Pin Wrangler, add `bench/production/wrangler.jsonc`, and add a Node
  operator runner. The runner generates a unique run ID, sends one operation per
  request, measures external wall time, verifies constructor changes across
  resets, and writes bounded raw JSON under gitignored `bench/results/`.
  Account ID and bearer token enter only through environment variables or
  Wrangler secrets.
- **Acceptance / witness.** A Wrangler dry run bundles the exact entry point;
  the runner rejects a missing URL/token and malformed or incomplete responses;
  no credential or account-specific identifier appears in tracked files.
- **Touch points.** `package.json`, `package-lock.json`,
  `bench/production/wrangler.jsonc`, `bench/production/run.ts`.

### WU3 — Restart, failure, and repository-state witnesses (effort L)

- **Problem.** Reconstructing `Workspace` locally does not prove a production
  isolate reset. Application failure, isolate reset, and destructive storage
  reset currently have no separate production evidence.
- **Verify first.** Seed two independent conflicted rebase repositories and
  capture their original HEADs, unmerged status, and operation-journal rows
  before requesting a reset.
- **Scope.** Force `ctx.abort()` after each rebase suspends, poll until the
  constructor instance ID changes, then resolve/continue one repository and
  abort the other. Exercise an application error without a reset. Exercise
  `deleteAll()` only on a separate disposable DO name, then reset it. Audit
  quick-check, foreign keys, refs, index/worktree state, pending packs, and
  database bytes after reopening.
- **Acceptance / witness.** Continue publishes the expected resolved commit;
  abort restores the original commit and worktree; application failure retains
  the same instance and state; isolate reset changes the instance but retains
  state; storage reset changes the instance and removes the disposable marker.
- **Touch points.** `bench/production/worker.ts`, `bench/production/run.ts`.

### WU4 — Production run and retained evidence (effort M)

- **Problem.** Backlog 11 is complete only when a deployed release candidate has
  raw, attributable evidence rather than a working harness.
- **Verify first.** Run formatting, typecheck, focused tests, production build,
  and Wrangler dry-run before deploying. Confirm the Git fixture refs still
  equal the pinned OIDs.
- **Scope.** Deploy `kompjutr-git-probe` to the authorized Cloudflare account,
  install a generated Worker secret, run the operator workflow, query available
  Workers analytics for the exact run window, and curate the stable evidence in
  `docs/reference/`. Retain the Worker for later release-candidate runs.
- **Acceptance / witness.** Raw evidence names the source commit, Wrangler
  version, deployment version, run ID, fixture OIDs, region/colo, per-operation
  external wall time, SQL/row counts, database size, restart generations,
  correctness facts, and available platform CPU/request/error analytics. The
  final repository gates pass and the sprint closes with honest deferrals.
- **Touch points.** `bench/results/`, `docs/reference/benchmark-current.md` or a
  dedicated production reference, backlog/sprint/docs indexes.

## Out of scope (explicit)

- A general public repository audit or snapshot API remains
  [17](../backlog/17-integrity-audit-and-snapshots.md). This sprint owns a
  private, bounded probe audit only.
- A general Git Smart HTTP server is not introduced. Clone and fetch use a real
  pinned public origin; push uses the real pack writer and receive-pack parser
  against a deterministic bounded probe transport, avoiding writes to an
  external repository.
- Systematic pairwise concurrency shipped later in the
  [concurrency and restart sprint](sprint-2026-08-27-concurrency-and-restart-conformance.md).
- The probe is an operator tool, not a normal CI gate. Automating it on every
  release requires a separate decision about Cloudflare credentials and spend.

## Decisions

- Worker name: `kompjutr-git-probe`.
- Deployment target: the explicitly authorized Cloudflare account.
- Configuration uses declarative SQLite DO class exports rather than the legacy
  migration array.
- The public endpoint requires a generated Worker secret. No account ID, token,
  or fixture credential is committed.
- Each run gets a unique named DO. The destructive storage-reset witness gets a
  second disposable name and cannot erase the main run.
- The deployed Worker is retained after the sprint for repeatable release probes.

## Sequencing

| Wave | Units | Parallelism |
|---|---|---|
| 0 | WU1 contract and Worker | serial; freezes the response schema |
| 1 | WU2 runner/config; WU3 restart witnesses | implementation may interleave after the schema freezes |
| 2 | local gates, WU4 deploy/run/evidence | serial; no deploy before every local gate passes |

## Run log

- The local Wrangler binary was outside this repository. The sprint pins its own
  version instead of depending on a sibling checkout.
- Cloudflare's current declarative `exports` field replaces a legacy migration
  history for a new SQLite DO namespace.
- The first deployed harness revision called `git.init()` without first creating
  its worktree directory. Production returned `ENOENT`; the next unique run
  verified the explicit directory creation.
- Calling `ctx.abort()` immediately after `deleteAll()` prevented the deletion
  from becoming the successful request's durable result. The final contract
  commits `deleteAll()` in one request and resets the isolate in the next; the
  database fell from 364,544 to 4,096 bytes and reopened without its marker.
- A freshly rotated Worker secret propagated gradually. The final run started
  only after five consecutive authenticated control requests and a five-second
  stabilization window.
- Final run `probe-20260827162435732-6f26df18` completed in PRG. Every operation
  stayed below 300 SQL statements; the main audit was clean at 372,736 bytes.
  The GraphQL window reported three expected isolate-reset exceptions, no
  unexpected errors, peak bucket CPU P99 of 895 microseconds, and memory P99 of
  7,934,362 bytes.
- Full local gates passed before deployment: 120 test files, 2,186 passing tests,
  5 intentional skips, typecheck, Biome check, production build, and Wrangler
  dry-run. Biome continued to report its pre-existing schema/deprecation infos.
