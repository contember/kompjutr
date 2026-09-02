> **OUTCOME - shipped 2026-09-02.** `ls-files --others` now preserves Git path
> order, add-all and commit-all stream the index beyond the former modeled-byte
> refusal, repeated worktree hash windows resume instead of rescanning from the
> root, live cache clears keep loose objects visible, ref and reflog headers no
> longer scan all retained history, and tree construction has no repository-wide
> tree-object admission cap. Commit map: plan -> `ec2464b`; WU1 -> `aa587d3`;
> WU2 -> `e37e4e9`; WU3 -> `46ea08f`; WU4 -> `cb0c980`. Verification: all
> issue-derived witnesses passed; smoke passed 165/165; typecheck, Biome check,
> and build passed; the exhaustive runner passed 3,377 tests with 405 skipped
> across 174 files. Backlog closed: ARCH-4/CORR-5, CORR-7/ARCH-7, CORR-8,
> CORR-9, CORR-10, and ARCH-31 were removed from backlog 65. Deferred: the
> remaining verified findings stay in backlog 65 and 63; unverified claims stay
> in ideas.

# Sprint - Git correctness and scale (2026-09-02)

**Goal.** Remove the first verified wrong-result and artificial-scale failures
left by the Git-in-SQLite architecture review.

**Theme.** These findings are independently reproducible at HEAD, affect ordinary
Git operations or live store reads, and have direct acceptance witnesses. The
sprint stops before trust-model, schema-shape, and broad facade cleanup.

## Refs re-verified at HEAD (2026-09-02)

- Confirmed: separately ordered literal-prefix index scans are concatenated and
  passed to `joinSorted`, which requires global order -
  `src/git/ops/staging.ts:1775-1854`, `src/git/common/streams.ts:120-127`.
- Confirmed: worktree hash refresh starts each caller window from the root -
  `src/git/ops/worktree-io.ts:444-459`, `src/git/ops/worktree-io.ts:586-609`.
- Confirmed: `add -A` snapshots the complete index and refuses it through modeled
  retained bytes - `src/git/ops/staging.ts:1001-1047`.
- Confirmed: `clearCaches()` sets the loose-object availability hint to false,
  causing a live read to skip loose storage - `src/git/store/shared.ts:374-381`,
  `src/git/store/objects.ts:1148-1152`.
- Confirmed: ref mutation and reflog read headers aggregate the maximum ordinal
  across both complete repository histories - `src/git/store/refs.ts:234-275`,
  `src/git/store/reflog.ts:268-319`, `src/git/store/reflog.ts:359-376`.
- Confirmed: tree preflight refuses the 4,097th tree object even though object
  writes flush in bounded batches - `src/git/ops/tree-build.ts:621-635`,
  `src/git/store/objects.ts:849-908`.

## Work units

### WU1 - Stream staging and worktree inputs (effort L)

- **Problem.** CORR-8 can report a tracked path as untracked; CORR-10 retains and
  caps the whole index for `add -A` and `commit -a`; CORR-7 restarts every hash
  window's worktree refresh from the root.
- **Verify first.** Reproduce interleaving literal prefixes, the former add-index
  threshold, and repeated undefined `after` cursors across hash windows.
- **Scope.** First restore global index ordering for untracked selection, then
  stream grouped index rows through add, then carry an ordered refresh cursor
  across hash windows while preserving re-stat and vanished-path behavior.
- **Acceptance / witness.** Real-Git pathspec parity passes for interleaving
  prefixes; add and commit cross the former whole-index threshold with exact
  staged content; status hash refresh starts from the root only once and existing
  disappearance/large-file race tests remain green.
- **Commands.** `npx vitest run tests/pathspec.test.ts -t "matches real Git when literal prefix scans interleave"`; `npx vitest run tests/staging.test.ts -t "streams add all past the former whole-index threshold"`; `npx vitest run tests/git-cli-write.test.ts -t "streams commit all past the former whole-index threshold"`; `npx vitest run tests/status.test.ts -t "resumes hash refreshes across status windows"`; `npx vitest run tests/worktree.test.ts -t "does not trust a symlink target after the path disappears|reports a .* large file dirty without throwing"`.
- **Touch points.** `src/git/ops/staging.ts`, `src/git/ops/worktree-io.ts`,
  `src/git/ops/status-rows.ts`, `src/git/ops/status.ts`, `src/git/ops/diff.ts`,
  `src/git/ops/refs.ts`, `src/git/ops/pathspec.ts`, and the named test files.

### WU2 - Keep loose objects visible after cache invalidation (effort S)

- **Problem.** ARCH-31 makes live loose objects unreadable after `clearCaches()`.
- **Verify first.** Write and warm-read a loose blob, clear caches, and observe
  that the second read returns absent at HEAD.
- **Scope.** Make SQL-free invalidation conservative about loose-object
  availability; do not add a database probe to `clearCaches()`.
- **Acceptance / witness.** A loose object remains readable through a fresh
  storage lookup after a live cache clear.
- **Command.** `npx vitest run tests/pack.test.ts -t "keeps loose objects readable after a live cache clear"`.
- **Touch points.** `src/git/store/shared.ts`, `tests/pack.test.ts`.

### WU3 - Remove full-history reflog preflights (effort M)

- **Problem.** ARCH-4/CORR-5 scans every retained direct and checkout reflog row
  before ref mutations and exact reflog reads, only to re-authenticate stored
  allocator state.
- **Verify first.** Capture production query plans with unrelated retained
  histories and confirm both entry tables appear in each header plan.
- **Scope.** Remove only the compound maximum and its read-time assertion. Keep
  allocator CAS, transaction boundaries, event ordering, payload limits, and
  per-entry ordinal guards unchanged.
- **Acceptance / witness.** Query plans for mutation headers and exact direct or
  HEAD reads do not traverse unrelated history; an injected allocator race still
  rolls back refs, entries, and ordinal state.
- **Command.** `npx vitest run tests/reflog-api.test.ts tests/store.test.ts tests/reflog-operations.test.ts`.
- **Touch points.** `src/git/store/refs.ts`, `src/git/store/reflog.ts`,
  `tests/reflog-api.test.ts`.

### WU4 - Remove the repository-wide tree-object admission cap (effort M)

- **Problem.** CORR-9 rejects `write-tree` and integration above 4,095
  directories although total tree count is not live retained state.
- **Verify first.** Keep the current first-over-limit test as a negative control.
- **Scope.** Remove `maxTreeObjects` admission from preflight and its production
  callers. Keep per-tree entry bounds, arithmetic checks, the 48 MiB object
  boundary, and object-sink flush thresholds.
- **Acceptance / witness.** Pure preflight, actual `writeTree()`, and a public
  non-fast-forward merge succeed beyond the former 4,096-tree-object boundary.
- **Command.** `cpu-lease run -n 2 -- npx vitest run --maxWorkers=1 tests/tree-build-preflight.test.ts tests/plumbing-write.test.ts tests/merge-lifecycle.test.ts -t "beyond the former 4,096-tree-object boundary"`.
- **Touch points.** `src/git/ops/tree-build.ts`, `src/git/ops/plumbing.ts`,
  `src/git/ops/integration-worktree.ts`, the named tests, and
  `docs/reference/git-support.md`.

## Review strategy

Per user direction on 2026-09-02, non-critical work uses its issue-derived
acceptance witness without independent peer review. A work unit escalates to peer
review before commit if it changes persisted schema, ref allocator CAS, atomic
publication, object identity, destructive maintenance, or another invariant with
data-loss or repository-corruption blast radius.

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Four disjoint implementation territories meet at public Git behavior. | All focused witnesses, `npm test`, typecheck, check, build, and one exhaustive closure run; no peer review unless escalated. | A focused fix crosses its named territory or changes a critical invariant. |
| WU1 | Public ordering, staging, and lazy refresh behavior; no persisted-format change. | Every named issue-derived witness plus `tests/pathspec.test.ts tests/status.test.ts tests/worktree.test.ts tests/diff.test.ts tests/staging.test.ts tests/refs.test.ts tests/git-cli-write.test.ts`. | The fix requires a new public API, weakens freshness, or changes transaction behavior. |
| WU2 | One conservative cache hint with a direct live-read witness. | Exact `tests/pack.test.ts` witness only. | The fix adds SQL or changes cache ownership/lifetime. |
| WU3 | Removes a read-only audit while retaining the publication CAS. | Query-plan, race rollback, and existing reflog semantic tests. | Allocator CAS, writer ordering, retention, or schema must change. |
| WU4 | Removes an artificial admission rule while preserving real object bounds. | Three exact old-boundary witnesses and existing tree/integration slices. | A replacement global cap, serializer contract, or persisted tree shape changes. |

## Test cadence

- **Per WU.** Run the exact acceptance command and the named stable slice only.
- **Routine integration.** Run `npm test` after all four units integrate.
- **Sprint closure.** Run `npm run typecheck`, `npm run check`, `npm run build`,
  then `cpu-lease run -n 4 -- npm run test:full` once.
- **Failure loop.** Reproduce a closure failure in its exact file or domain slice
  before another exhaustive run.

## Out of scope (explicit)

- ADR-0017/0018 conformance work and read-time witness removal outside WU3.
- Integration's separate 1,000 changed-path cap (ARCH-8).
- Whole-ref-table materialization (ARCH-18) and duplicate reflog-root streaming
  (ARCH-19).
- Pack, maintenance, schema-shape, facade, and helper cleanup from backlog 65.
- Unverified claims in `../ideas/git-sqlite-architecture-review-triage.md`.

## Decisions

- A single ordered index scan is acceptable for CORR-8; correctness takes
  precedence over prefix narrowing.
- Tree-object count is retained as a diagnostic statistic, not admission.
- `clearCaches()` remains SQL-free and uses conservative-positive availability.
- Reflog allocator correctness remains owned by write-time CAS, not a read-time
  repository-wide maximum.

## Sequencing

| Wave | Work | Isolation |
|---|---|---|
| 1 | WU1, WU2, WU3, and WU4 in parallel | One worktree; territories and test files are disjoint. |
| 2 | Integrate each passing unit independently and run its focused gate. | Explicit-path commits only. |
| 3 | Run routine and closure gates; update backlog, sprint outcome, and living indexes. | Serialized in the main worktree. |

## Plan review

- **Reviewer:** user scope gate
- **Verdict:** approved on 2026-09-02
- **Material findings:** Independent peer review is required only if a work unit
  escalates to a critical invariant; otherwise the exact acceptance witnesses are
  the review gate.

## Run log

- WU1 fix round removed the residual streamed-index row refusal and extended the
  acceptance fixture across an index page, buffered mutation flushes, conflict
  resolution, and a later-sorting inserted path.
- The combined reflog/store command exposed Vitest's worker RPC timeout after all
  103 store assertions passed. Focused reflog/store witnesses passed cleanly, and
  the batched exhaustive runner later passed the complete suite.
