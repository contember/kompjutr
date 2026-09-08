> **OUTCOME — shipped 2026-09-08.** All four public-API failures are closed and
> each has a committed regression witness. WU1 makes a nested failure abort-only
> *when that scope produced effects* — rows, schema, or disk — which keeps the
> deliberate caught-reentry pattern working instead of killing it, and both
> Durable Object test doubles now model workerd's savepoint nesting rather than
> flattening it. WU2 turned out to be the hard one: the first fix was a no-op,
> because `Buffer.prototype.slice()` is Node's alias for `subarray()` and every
> witness had built its input with `utf8.encode()`. The rule now lives in one
> shared `ownedBytes()` below every composition, and it closed two sites the
> sprint never planned for — the batch writer, which *persisted* corrupted bytes
> under a clean OID, and pack ingest's trailer lookbehind at the network trust
> boundary. WU3 and WU4 landed as planned; WU4's target behavior came from asking
> git 2.54.0 rather than from reading a spec.
>
> Commit map: WU1 → `057606a`, WU2 → `9350c8b` + `674a5a9`, WU4 → `a4ad6a2`,
> WU3 → `3a77f48`; review fixes → `d6ad7fc`, `2a90d99`, `e98f224`; docs →
> `a94f5f6`, `602cc8c`.
>
> Verification: `npm run test:full` clean on the final tree — 449.9 s wall over
> 3 lanes, no failing slice. Along the way: `npm test` 158, `npm run test:fs`
> 467, `tests/local` + `tests/rebase.test.ts` 104, the WU witnesses 258. Every
> fix was also verified in reverse, by temporarily restoring the defect and
> watching its witness fail.
>
> Backlog closed: 67, 68, 69 deleted; 70 deleted whole — WU4 consumed its
> discovery contract and planning refuted its scan-ordering claim (Decision 3),
> with the refutation preserved in the record below. Filed: 81, the estimated cost
> of unconditional ownership copies.
>
> Deferred / honest notes: the `## Plan review` below stayed **pending** — no
> independent reviewer checked the plan against HEAD before implementation, which
> `docs/CLAUDE.md` requires. Independent review of WU1 and WU2 did happen, twice
> each, and found the WU2 no-op; that is the only reason this sprint did not ship
> a fix that fixed nothing. Two latent WU1 residuals are recorded in the run log
> (`temp`-schema DDL is invisible to the effect mark; a hand-set negative schema
> cookie fails closed as `ECORRUPT`), neither reachable from source. One earlier
> run of `tests/reads` + `tests/pack` + `tests/local` reported 2 failures whose
> detail was lost to a truncated pipe; the same set and then the full suite ran
> clean afterwards, and that run also carried two vitest worker RPC timeouts
> under a saturated CPU pool — likely but not proven to be the cause.

# Sprint — public API correctness (2026-09-08)

**Goal.** Close four reproduced public-API failures of the local composition: a
mutated stored object, a permanently blocked repository, a failing repeated path
mutation, and a symlink returned as a regular-file handle.

**Theme.** All four are ownership defects at a public boundary — who owns a
buffer, who owns a failed nested transaction, who owns a path after its first
touch, and what a "file" handle means. Each one is reproducible today through the
public API, each fix is small, and none needs a benchmark to justify. The batch
succeeds when every reproduction below is a committed regression witness, the
local and Durable Object compositions agree where the review found them
disagreeing, and no operation loses current parity.

Consumes backlog 67, 68, 69, and the discovery half of backlog 70 (historical
identifiers; the consumed items were deleted at closure).

## Refs re-verified at HEAD (2026-09-08)

`✔` = confirmed live · `⚠` = drift/nuance caught. Entries marked **reproduced**
were executed against the built `dist` during planning; the scripts were
temporary and are not a committed suite.

- ✔ Scalar object writes cache the caller's `Uint8Array` without copying —
  `packages/git/src/store/objects/objects-write.ts:101`.
- ✔ The batch writer already copies the same input —
  `packages/git/src/store/objects/objects-batch.ts:62`.
- ✔ A cached read returns that stored object directly —
  `packages/git/src/store/objects/objects.ts:125-126`; the public boundary
  forwards its bytes — `packages/git/src/client-plumbing.ts:35-42`.
- ✔ **Reproduced.** `hashObject({content, write: true})` then mutating the input
  makes `catFile()` return `xbc`; mutating the returned bytes makes the next read
  return `xyc`. The OID is unchanged, so the stored bytes and their name disagree.
- ✔ Nested `transactionSync()` invokes the closure directly and never marks the
  outer transaction abort-only —
  `packages/local/src/sqlite/database.ts:287-295`. Abort-only state exists, but
  only for failed disk operations — `database.ts:323-325`.
- ✔ The Git mutation guard deletes its row only after the body succeeds —
  `packages/git/src/store/core/mutation-guard.ts:12-24`.
- ✔ **Reproduced.** After one failed Git mutation inside an outer
  `transactionSync()`, the outer transaction commits the guard row and every later
  mutation throws `EREENTRANT`, including after reopen.
- ✔ `writeFiles()` calls `symlinkSync()` without removing an existing destination
  — `packages/local/src/drive/write.ts:203`; the single-path `symlink()` rejects an
  existing path instead — `write.ts:236-238`.
- ✔ `remove()` executes `rmSync(host, { force, recursive })` —
  `packages/local/src/drive/write.ts:264`.
- ✔ The recovery coordinator records a touch once per outer transaction and moves
  the backup on that first touch only —
  `packages/local/src/recovery/coordinator.ts:271-330`.
- ✔ **Reproduced.** Two `writeFiles()` of the same symlink in one transaction fail
  with `EEXIST`. `makeDirectories(["/dir"])` + `rmdir("/dir")` in one transaction
  fails with Node's raw `ERR_FS_EISDIR`; the same pair in separate transactions
  succeeds. The escaping host code is a second defect: local errors must carry a
  stable `code`.
- ✔ `discoverFiles()` narrows with `filesOnly` —
  `packages/local/src/drive/disk-drive.ts:262` — and `scanStream()` yields every
  non-directory entry, symlinks included — `disk-drive.ts:223`.
- ✔ The Durable Object twin selects regular files explicitly —
  `packages/do/src/fs/store/scan/discovery.ts:121,140`.
- ✔ **Reproduced.** With an in-root symlinked `.gitignore`, `readFileHandles()`
  and `git.status()` fail with `ESTALE`
  (`packages/local/src/drive/read.ts:241-250`); an escaping symlink fails with
  `EACCES`. Ignore loading consumes exactly this page —
  `packages/git/src/ignore/source.ts:160`.
- ⚠ **Backlog 70's scan-ordering mechanism is refuted.** The sorter keys a
  directory's descend event as `a/` — `packages/local/src/drive/external-sort.ts:37-43`
  — but every row that key introduces carries the same `a/` prefix, so the sibling
  comparison is identical for `a/` and `a/child`. A reproduction on `{a/, a.txt,
  a0, empty/}` emitted `/a, /a.txt, /a/file, /a0, /empty` — exactly `comparePaths`
  order — and a one-row page followed by `after: "/a"` skipped nothing. This
  sprint does not fix it; see Decisions.

## Work units

### WU1 — Abort the outer transaction after a nested failure (effort M)

- **Problem.** `packages/local/src/sqlite/database.ts:287-295` runs a nested
  closure with no failure semantics, so a failure inside an outer
  `transactionSync()` leaves the outer transaction committable. The mutation guard
  row at `packages/git/src/store/core/mutation-guard.ts:12-24` then commits and
  blocks every later mutation with `EREENTRANT`, permanently.
- **Verify first.** Reproduce the guard row surviving, then check the same
  sequence against the Durable Object database (`packages/do/src/db/db.ts`) to
  learn whether the shared contract or only the local adapter diverges. Read the
  nested-rollback wording in `packages/sqlite/src/index.ts` before changing
  behavior.
- **Scope.** 1) Mark the outer transaction abort-only when a nested closure
  throws, and fail the outer commit with the existing recovery error path.
  2) Keep the async-callback rejection at `database.ts:290-295,315-322` exactly as
  it is. 3) State the nested-failure rule in the shared contract so both
  compositions are bound by it. Do not introduce independent disk savepoints.
- **Acceptance / witness.** `npx vitest run tests/transactions.test.ts tests/local/sqlite.test.ts`
  — a caught nested Git-mutation failure makes the outer transaction fail; after
  reopen, ordinary mutations succeed; a nested failure after real SQL *and* disk
  effects rolls back both; a caught CLI mutation failure inside an outer
  transaction behaves the same.
- **Touch points.** `packages/local/src/sqlite/database.ts`,
  `packages/sqlite/src/index.ts`, `packages/git/src/store/core/mutation-guard.ts`,
  `packages/git/src/cli/write/write-runtime.ts`, `tests/transactions.test.ts`,
  `tests/local/sqlite.test.ts`.

### WU2 — Own buffers across public object boundaries (effort S–M)

- **Problem.** `objects-write.ts:101` caches the caller's array and
  `objects.ts:125-126` hands it back, so a caller that reuses its input — or that
  writes into the bytes it just read — changes what an immutable OID returns. The
  batch writer already copies (`objects-batch.ts:62`), so the two write paths
  disagree.
- **Verify first.** Run the write-then-mutate and read-then-mutate reproductions.
  Inventory every producer that feeds the object cache and every consumer that
  keeps a returned buffer, so the copy lands once per boundary rather than once
  per call site.
- **Scope.** 1) Establish ownership at the write cache insertion and at the public
  read boundary. 2) Keep internal zero-copy paths only where ownership is
  explicit and documented in one line. 3) Cover stream-backed writes
  (`objects-write.ts:109-160,207-306`). Do not rehash stored content on read —
  invariant 4 and [ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md).
- **Acceptance / witness.** `npx vitest run tests/plumbing-write.test.ts tests/reads.test.ts tests/pack.test.ts`
  — input reuse after `hashObject({write: true})` and mutation of a returned
  `catFile()` buffer leave later reads byte-identical, for warm and cold reads,
  loose and packed sources, scalar and batch writes, and after reopen.
- **Touch points.** `packages/git/src/store/objects/objects-write.ts`,
  `objects.ts`, `objects-batch.ts`, `packages/git/src/client-plumbing.ts`,
  `tests/plumbing-write.test.ts`, `tests/reads.test.ts`, `tests/pack.test.ts`.

### WU3 — Preserve local mutation semantics after first touch (effort M)

- **Problem.** Both defects rely on the first-touch backup move to perform the
  requested operation. A second `writeFiles()` of the same symlink reaches
  `symlinkSync()` with the destination present (`write.ts:203`) and fails
  `EEXIST`; a non-recursive directory removal reaches `rmSync()` (`write.ts:264`)
  and escapes as Node's `ERR_FS_EISDIR`. Public rebase hits the first when a
  feature branch changes a symlink, because baseline materialization and replay
  run in one transaction.
- **Verify first.** Reproduce both in one transaction and confirm both succeed
  across separate transactions. Confirm the rebase path materializes and replays
  under a single outer transaction before writing the parity witness.
- **Scope.** 1) Replace a symlink independently of backup creation, through a
  recovery-compatible temporary symlink and rename. 2) Use empty-directory removal
  semantics for non-recursive directory deletion. 3) Normalize the escaping host
  error into a stable `code`. 4) Preserve first-touch backup ownership and the
  existing directory fsync rules.
- **Acceptance / witness.** `npx vitest run tests/local/disk-drive.test.ts tests/local/recovery.test.ts tests/rebase.test.ts`
  — rebase over a symlink change matches real Git; repeated symlink writes,
  same-transaction mkdir/rmdir, paths already covered by an ancestor intent, and
  rollback plus reopen after a later failure all behave; every failure carries a
  stable `code`.
- **Touch points.** `packages/local/src/drive/write.ts`,
  `packages/local/src/drive/disk-drive.ts`,
  `packages/local/src/recovery/coordinator.ts`, `tests/local/`,
  `tests/rebase.test.ts`.

### WU4 — Return regular-file handles from discovery (effort S)

- **Problem.** `disk-drive.ts:262` discovers with `filesOnly`, which excludes
  directories but keeps symlinks (`disk-drive.ts:223`), so a symlinked
  `.gitignore` becomes a `RegularFileHandle`. The reader correctly refuses it
  (`read.ts:241-250`) and ignore loading propagates the failure into `status` and
  `add`. The Durable Object twin selects `fs_nodes.type = 'file'`
  (`scan/discovery.ts:121,140`), so the two compositions disagree.
- **Verify first.** Reproduce `status` failing with `ESTALE` on an in-root
  symlinked `.gitignore` and `EACCES` on an escaping one, then check what real Git
  does with the same three topologies before choosing the target behavior.
- **Scope.** 1) `discoverFiles()` returns regular-file handles only. 2) Ordinary
  Git traversal keeps seeing symlinks — this narrows discovery, not scanning.
  3) Ignore loading follows real Git for regular, valid-symlink, dangling-symlink,
  and escaping-symlink `.gitignore` entries.
- **Acceptance / witness.** `npx vitest run tests/local/disk-scan.test.ts tests/local/git-parity.test.ts tests/ignore.test.ts`
  — `status` and `add` succeed with a symlinked `.gitignore` and match the real
  binary; discovery returns no symlink handles; DO and local discovery agree.
- **Touch points.** `packages/local/src/drive/disk-drive.ts`,
  `packages/git/src/ignore/source.ts`, `tests/local/disk-scan.test.ts`,
  `tests/local/git-parity.test.ts`, `tests/ignore.test.ts`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | WU1 and WU3 both change local transaction and recovery behavior; WU2 changes an allocation pattern on every object read | `npm test` plus `npx vitest run tests/local tests/transactions.test.ts tests/rebase.test.ts`; one independent integration review after the last WU lands | Any WU changes a shared contract file (`packages/sqlite/src/index.ts`) — then the integration review repeats after the fix |
| WU1 | Fundamental. Blast radius is every local mutation, and the failure mode is an unusable repository | Independent review to clean, against the witness above; reviewer re-runs the reproduction | The fix reaches into disk savepoints or changes the DO adapter — stop and re-plan |
| WU2 | Fundamental. Touches the read path of every object; a naive copy-everywhere fix costs memory on hot reads | Independent review to clean; reviewer confirms no read-time rehashing was added and checks the copy count per boundary | Object-read benchmarks are needed to defend the chosen ownership — then measure under `bench/CLAUDE.md` before merging |
| WU3 | Normal. Contained in the local drive and its coordinator, with a real parity witness | Direct witness plus one review pass; second review only if the recovery journal format changes | The fix changes first-touch ownership or the undo ordering |
| WU4 | Easy. One narrowing of a query plus parity coverage | Direct witness; no independent review required | Real Git turns out to reject symlinked `.gitignore`, which changes the target behavior |

## Test cadence

- **Per WU.** Run the exact acceptance witness above. Add `npm run test:fs` only
  when a change crosses the filesystem domain (WU4 does not; WU3 does if the
  coordinator changes).
- **Routine integration.** `npm test` after each WU lands; keep it under 30 s.
- **Sprint closure.** `npm run test:full` once, after the last review and its
  focused fixes have settled.
- **Failure loop.** Reproduce a full-suite failure with its exact file or slice,
  stabilize it, then rerun the full suite.

## Out of scope (explicit)

- [71](../backlog/71-invalidate-maintenance-on-promise-fulfillment.md),
  [72](../backlog/72-preserve-pack-dependencies-during-lifecycle.md), and
  [73](../backlog/73-validate-fetch-connectivity-and-publication.md) — they run as
  [sprint-2026-09-08-lifecycle-and-network-integrity](../sprints/sprint-2026-09-08-lifecycle-and-network-integrity.md).
- [74](../backlog/74-align-pack-ingest-with-physical-membership.md) and everything
  in [75](../backlog/75-bound-network-authentication-payloads.md)–[79](../backlog/79-bound-materialized-status-and-config-reads.md):
  the scaling items start with measurement, not with a fix.
- [80](../backlog/80-restore-import-graph-domain-guarantees.md) — cheap, but it is
  test-only enforcement and does not belong in a correctness batch.
- Backlog 70's scan-ordering mechanism — refuted, see Decisions.
- Asynchronous-callback misuse handling (65, ARCH-33/ARCH-39) keeps its current
  behavior; WU1 must not weaken it.

## Decisions

1. **A nested failure makes the outer transaction abort-only.** Rejected:
   deleting the guard row in a `finally`, because it hides partial SQL and disk
   effects rather than undoing them; rejected: independent disk savepoints, which
   is a larger design than this defect justifies. If implementation shows
   abort-only cannot hold the recovery journal's contract, stop and write an ADR.
2. **Ownership is established by copying at the write-cache insertion and the
   public read boundary**, not by re-hashing stored content on read — invariant 4
   and ADR-0004 stand.
3. **Backlog 70 is rewritten, not shipped whole.** Its scan-ordering mechanism is
   refuted by the reproduction recorded above; on closure the item keeps only the
   discovery contract, which WU4 consumes, and the ordering claim is deleted with
   the refutation kept in this sprint's record. No ADR — nothing about the system
   changed, only a claim about it.
4. **Every local failure carries a stable `code`.** The escaping `ERR_FS_EISDIR`
   found during planning is in WU3's scope rather than a separate item.

## Sequencing

| Order | Unit | Parallel with | Why |
|---|---|---|---|
| 1 | WU1 | WU2, WU4 | Changes the failure semantics WU3's rollback witnesses depend on |
| 2 | WU3 | WU2, WU4 | Needs WU1's abort-only behavior to assert rollback after a later failure |
| — | WU2 | anything | Only `packages/git/src/store/objects/` and the plumbing boundary |
| — | WU4 | anything | Only local discovery and the ignore source |

WU2 and WU4 have disjoint write territories from WU1/WU3 and from each other, so
three agents can work at once. Closure order is WU1, WU3, then whichever of WU2
and WU4 finishes last.

## Plan review

An independent reviewer checks this proposal against HEAD, including whether each
gate is proportionate to its unit's blast radius.

- **Reviewer:** pending
- **Verdict:** pending
- **Material findings:** —

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-09-08 — Planning reproduced WU1–WU4 against the built `dist` and refuted
  backlog 70's scan-ordering mechanism. → Decision 3.
- 2026-09-08 — **Decision 1 refined during WU1.** Blanket abort-only on any
  nested throw is wrong: `withGitMutationGuard` rejects reentry *before*
  changing anything, and real workerd `transactionSync` rolls a failed nested
  scope back with `SAVEPOINT`/`ROLLBACK TO`
  (`api/actor-state.c++:713`), so the outer transaction survives there. The
  blanket rule would have killed the deliberate caught-reentry pattern on local
  only — a new divergence inside the sprint that exists to remove them. The
  shipped rule is abort-only *when the nested scope produced effects*: rows
  changed on the connection, or disk effects recorded by the coordinator. That
  needed `RecoveryCoordinator.changed` to become a monotonic `effects` counter.
  Cost is one `SELECT total_changes()` per nested entry; measured nesting is 1–3
  per public operation (`init`, `add` and `commit` over 1,000 files).
- 2026-09-08 — Both Durable Object test doubles were flattening nested
  `transactionSync` (`tests/helpers/storage.ts`, `tests/helpers/db.ts`), so the
  harness modelled neither workerd nor the DO adapter. They now use savepoints
  and delegate every call, which is what makes the new shared-contract clause
  testable in both compositions.
- 2026-09-08 — Real Git (2.54.0) opens an exclude file with `O_NOFOLLOW`, warns,
  and proceeds as if it were absent — identical `status` output for regular,
  in-root symlinked, dangling and escaping `.gitignore`. That fixed WU4's target
  behavior.
- 2026-09-08 — Witness placement deviates from the plan where the defect is
  local-only: the WU3 rebase and WU4 ignore parity witnesses live in
  `tests/local/git-parity.test.ts` (the harness that runs the real binary
  against `LocalWorkspace`) rather than `tests/rebase.test.ts` and
  `tests/ignore.test.ts`, and WU2's public-boundary witness lives in
  `tests/client.test.ts` beside the rest of the public client surface.
- 2026-09-08 — **Independent review of WU1 and WU2 found the first WU2 fix was a
  no-op.** `Buffer.prototype.slice()` is Node's alias for `subarray()`, so it
  returns a view; `node:fs` hands callers a `Buffer`, and every witness had built
  its input with `utf8.encode()`. The batch writer carried the same hole and was
  worse — its flush is deferred, so a mutation between `batch.write()` and the
  flush is *persisted* under a clean OID. Closed with a shared `ownedBytes()` in
  the bytes kit, applied at every ownership snapshot (`objects-write.ts`,
  `objects-batch.ts`, `client-plumbing.ts`, `blob-ids.ts`,
  `pack-ingest-index.ts`), and witnessed with a `Buffer` through
  `LocalWorkspace`. The sprint's premise that "the batch writer already copies"
  was false for the composition the sprint is about.
- 2026-09-08 — Review of WU1: `total_changes()` is blind to DDL, so a nested
  scope that created a table and then threw stayed committed. Effect detection
  now reads `schema_version` in the same statement, so the cost is unchanged.
  `diskEffects` had no dedicated witness — every disk test also changed rows —
  and `diskChanged` was redundant with `diskEffects > 0` while letting a stub
  express a state the coordinator cannot reach; both fixed.
- 2026-09-08 — Review of WU1: the first contract wording ("leave no effect
  behind") hid what the local escape clause actually does — the failed scope's
  rows stay readable inside the transaction until the commit is refused, where
  the Durable Object has already removed them. Reworded, and
  `reference/concurrency.md` now records both runtimes.
- 2026-09-08 — Review of WU2 estimated the cost of unconditional ownership
  copies: `catFile` of a 48 MiB blob can hold two 48 MiB buffers, and a scalar write
  above the cache's entry limit copies bytes the cache then drops. The rule is
  right (a cold read is cached too, so the boundary cannot tell); process peak
  memory was not established by this static estimate. → backlog 81.
- 2026-09-08 — **Re-review after the fixes found one more live site of the same
  class**, which is why `ownedBytes()` now lives in `@kompjutr/sqlite` rather
  than the Git bytes kit: pack ingest kept its rolling 20-byte trailer
  lookbehind as `joined.slice(...)` across `for await` iterations
  (`store/pack/ingest/ingest-write.ts`). The pack body comes from a caller's
  `GitHttpClient`, and `node:http` yields `Buffer`s, so the trailer validated
  need not be the trailer that arrived — at the ingest trust boundary. `blob()`
  in the shared package had the same fallback and its own postcondition was
  false for a pooled `Buffer`. Both fixed; a grep for an ownership `.slice()` is
  now the check.
- 2026-09-08 — Re-review of WU1 confirmed `schema_version` cannot move without
  the nested closure doing it: the outer `BEGIN IMMEDIATE` owns the write lock,
  and the cookie reverts on rollback. Two latent residuals, neither reachable in
  source: `temp`-schema DDL is invisible (`pragma_schema_version()` reads `main`),
  and a hand-set negative cookie fails closed as `ECORRUPT` at nested entry.
- 2026-09-08 — Contract wording corrected again: "leave nothing committed" was
  absolute, and the local composition deliberately breaks it — an observation
  lease commits on its own connection so an outer rollback cannot make it
  reusable. The clause is now scoped to the transaction's own database.
- 2026-09-08 — The disk-only witness added after review is coverage, not a fix:
  the `diskEffects` comparison shipped working in WU1 and nothing exercised the
  branch where a nested scope's disk writes succeed and it then fails for another
  reason.
