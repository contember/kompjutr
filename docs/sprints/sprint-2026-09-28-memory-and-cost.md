# Sprint — Memory and cost (2026-09-28)

**Goal.** Meet the missed memory gates or replace a wrong gate with evidence. Remove the
repeated full-tree passes from the rebase step, and remove checkout's modeled byte charges.

**Theme.** Backlog 86, 95 and 97 all concern what an operation retains or reads again.
The batch succeeds under these conditions:

- `core.sparse-selected-add` passes both memory stages over three leased runs.
- The workerd clone has a gate that measures the production isolate limit, and the clone
  meets that gate.
- The clone runs at most 1,000 statements.
- The Next.js rebase phase reads far fewer rows with no more statements.
- Checkout keeps only real payload limits and count caps.

## Refs re-verified at HEAD (2026-09-28, `932d3b9`)

Three read-only grounding agents checked these facts. Their probes are in the session
scratchpad and are not committed.

### Backlog 86 — sparse add and the workerd clone

- ✔ `core.sparse-selected-add` adds 178–203 MiB in leased probes with no cgroup cap. The
  child throws in the uncapped calibration stage: `bench/child.ts:241` and
  `bench/memory-run.ts:264,267`.
- ⚠ The scenario can never pass as specified.
  - The workload is 1,000 × `MAX_INDEX_PATH_BYTES` = 8,192,000 bytes.
  - `formerLimitBytes` is 64 MiB, the retired `SPARSE_WORKSPACE_STATE_BYTES` modeled
    ledger (`bench/memory-protocol.ts:173-181`).
  - `parseMemoryRun` rejects a workload that does not exceed its former limit
    (`memory-protocol.ts:582`).
  - This has been true since `3662b92`. The memory failure hid it.
- ✔ The baseline is read after setup, right after `clear_refs` (`bench/child.ts:232-234`).
- ⚠ The sparse peak is transient copy amplification, not retention, and not page cache.
  - Heap sampling: `heapUsed` returns to baseline after the operation.
  - About 200 MiB is allocated in total, as repeated 8 MiB path copies:
    - `packages/do/src/fs/store/resolve.ts:150,156,196`
    - node:sqlite row objects
    - the ignore matcher through `ops/staging/staging-add.ts:73`
    - `common/paths.ts:16`
    - `do/src/fs/store/read.ts:226`
  - `TextEncoder` backing stores come from `encoder.encode(part).length`, which is used
    only to count bytes (`do-fs/sparse/selection.ts:107`, `do-fs/sparse/shared.ts`).
    `utf8ByteLength` already exists (`store/core/json-pages.ts:20`).
  - The page cache is 1.5 MiB (`cache_size = -2000`).
  - The test storage idle-statement cache keeps the bound 8 MiB JSON parameter alive, about
    24.6 MiB of native heap (`tests/helpers/storage.ts:185-195`).
- ✔ The workerd clone adds 472,645,632 bytes of RSS in a leased run. The run makes 1,012
  statements and reads 145,777 rows, and all 24,252 files verify.
- ⚠ The workerd gate measures more than the clone (`bench/workerd/run.ts:185,203,225`).
  - The baseline is `VmRSS` right after `miniflare.ready`, before the Durable Object exists.
  - The peak is the lifetime `VmHWM`, which is never reset.
  - The measured region includes Durable Object instantiation, bundle evaluation,
    `Workspace` construction, and the `validateCheckout` oracle (`bench/workerd/worker.ts:181`).
- ⚠ The SQLite page cache does not explain the workerd RSS. That claim appears in backlog 86
  and `docs/reference/benchmark-current.md:83`.
  - workerd keeps SQLite's default cache of about 2 MiB and does not mmap.
  - `--trace-gc` shows at most about 50 MB used and 86 MB committed V8 heap, so at least
    380 MiB is outside the V8 heap.
  - Caveat: the trace may be truncated before the end of the clone.
- ✔ The clone makes 1,012 statements in Node and in workerd.
  - `fs_nodes` and `fs_paths` inserts take 114 statements each.
  - They flush at `METADATA_JSON_FLUSH_BYTES = 128 KiB`
    (`packages/do/src/fs/store/initial-write/initial-write-session.ts:31,332-357`).

### Backlog 95 — Next.js rebase passes

- ✔ The Next.js rebase row reads 942 statements, 1,061,270 rows, and adds 96.6 MiB
  (`docs/reference/benchmark-current.md:48`).
- ⚠ The step makes 43 full passes, not about 34:
  - 17 passes over `git_index`
  - 15 recursive tree walks (leaf rows only)
  - 11 worktree path walks
- ⚠ The line references in backlog 95 drifted:
  - `rebase.ts:64` is the bounded-index check.
  - `rebase.ts:65-66` are the clean-index and clean-worktree checks.
  - `rebase.ts:73,75` are the two baseline preflights.
- ✔ The same decision, "index and worktree are clean against tree X", runs three times: at
  start (`rebase.ts:64-66`), at step start (`rebase-lifecycle-step.ts:87` →
  `requireCurrentBaseline`, `rebase-lifecycle-baseline.ts:538`), and at publish
  (`rebase-lifecycle-drive.ts:31`). Each time costs 3 index passes, 1 tree walk and
  2 worktree walks.
- ✔ The start `materializeTree` (`rebase.ts:77`) runs `checkoutBlockers` and
  `checkoutTreeInternal` over the whole tree, which is 5 T + 4 I + 3 F. The known baseline
  makes this a diff-bounded checkout. `trySparseCleanCheckout`
  (`ops/checkout/sparse-checkout-operation.ts:22`) already implements that shape.
- ✔ A synthetic fixture reproduces the shape: 1 upstream file, 100 touched files, one pick.
  - 2,000 files: 94,608 rows.
  - 10,000 files: 456,868 rows.
  - About 45.7 rows per tracked file; Next.js reads 43.8.
- ✔ No gate row covers a rebase at scale.
  - The `rebase.transition*` rows use trees of 2–8 files (`bench/statements.ts:1910`).
  - `core.rebase.baseline-hash` is a single-file fast-forward (`bench/memory.ts:571`).

### Backlog 97 — checkout modeled charges

- ✔ The constants are declared in `ops/checkout/checkout-support.ts:43-50`.
- ✔ Checkout charges 96 bytes plus `2 × path.length` in two files:
  - `checkout-operation.ts:118`
  - `checkout-structure.ts:45,116,143,182,247`
- ✔ The tracker seed is charged in `initial-checkout.ts:18-20,111-121`.
  - The seed holds only gitlinks.
  - An overflow drops the reseal and never refuses the checkout.
- ⚠ The exclusion charge counts real UTF-8 bytes (`checkout-support.ts:62-71`).
  - Rebase already dropped its copy of this cap (`rebase-lifecycle-baseline.ts:45-64`).
  - A probe showed that rebase start and abort with 64 roots of 17,000 characters fail with
    `E2BIG checkout exclusions exceed 1048576 bytes`.
- ⚠ The removal charge refuses valid work.
  - A probe materialized 1,100 paths of about 8 KB, then checked out the empty tree. The
    checkout failed with `E2BIG checkout removal state exceeds 16777216 bytes`, and the
    rollback held.
  - With about 60-character paths, the charge trips near 77,000 removals. Clone cleanup
    (`ops/remote/network-clone.ts:86`) goes through the same path.
- ✔ Only the unmerged and exclusion charges fire before the first mutation. The others fire
  after `discardUnmergedPaths` or `restoreStructuralConflicts` has already changed files, so
  the caller's transaction provides atomicity. All checked callers run checkout inside
  `transactionSync` or `runMutation`: `refs.ts:108`, `staging-reset.ts:70`,
  `plumbing.ts:114`, `rebase.ts:60,124,165,188`.
- ✔ A schema CHECK caps index paths at 8 KiB (`schema-worktree-statements.ts:12`).
- ✔ Existing count caps:
  - unmerged: 10,000 (`checkout-structure.ts:42`)
  - prune: 50,000 (`checkout-structure.ts:241`)
  - exclusion roots: 64 (`checkout-support.ts:57`)
- ✔ The `removed` list (`checkout-operation.ts:118`) and the structural sets
  `activeLeaves`, `preservedRemovals` and `removals` (`checkout-structure.ts:116,143,182`)
  have no count cap.
- ✔ No test covers the first excess item of any modeled checkout charge.

## Work units

### WU1 — Clone statement target (S) — backlog 86

- **Problem.** The Next.js clone runs 1,012 statements. The ADR-0005 target is 1,000.
- **Verify first.** Take the statement histogram of the clone before the change. Confirm the
  Durable Object limit on the size of one bound TEXT parameter. Confirm that the metadata
  JSON binding is parsed with `json_each` and never kept as a row.
- **Scope.** Raise `METADATA_JSON_FLUSH_BYTES`, or merge the node and path flushes.
  - Stay inside the Durable Object parameter limit.
  - Keep the flush bounded by bytes.
  - Leave `MAX_CHUNK_JSON_BYTES` unchanged unless the first change is not enough.
- **Acceptance / witness.**
  - `npx vitest run tests/clone-initial.test.ts tests/checkout-initial.test.ts tests/clone.test.ts`
  - `cpu-lease run -n 2 -- npm run bench:nextjs`: clone SQL ≤ 1,000 and rows unchanged or
    lower.
  - `npm run bench:statements -- --check --nextjs bench/results/nextjs-workflow.json`
  - `cpu-lease run -n 2 -- npm run bench:workerd:nextjs`: the statement count also falls in
    the Durable Object.
- **Touch points.** `packages/do/src/fs/store/initial-write/initial-write-session.ts`.

### WU2 — Sparse selected add peak (M) — backlog 86

- **Problem.** One 1,000-path window copies an 8 MiB path set about 20 times. The peak is
  transient garbage, and it crosses the <100 MiB gate.
- **Verify first.** Rerun the grounding probe and keep the top allocation sites as the
  baseline. Check whether the harness idle-statement cache keeps a bound parameter alive
  longer than Durable Object `SqlStorage` does.
- **Scope,** in priority order. Stop once the gate holds over three runs.
  1. Protocol: drop the former-limit crossing check for this row (see Decisions). Keep the
     <100 MiB peak gate and the 512 MiB runaway cap.
  2. Count bytes with `utf8ByteLength` instead of `encoder.encode(part).length` in
     `do-fs/sparse/selection.ts` and `do-fs/sparse/shared.ts`.
  3. Build the binding JSON once, not as `parts` + `join` + template.
  4. Remove the path copies from the add window in the owning modules:
     `do/src/fs/store/resolve.ts`, `do/src/fs/store/read.ts`, the ignore matcher input in
     `ops/staging/staging-add.ts`, and `common/paths.ts` `joinPath`.
  5. Harness: change the harness only if the verify-first check shows the idle cache
     outlives what `SqlStorage` retains. Commit that separately with its evidence.
- **Acceptance / witness.**
  - Run `npm run bench:memory -- --scenarios=core.sparse-selected-add` three times. Both
    stages must pass, and every peak must be recorded with `memory.max`.
  - `npx vitest run tests/staging.test.ts tests/sparse-workspace.test.ts tests/status-sparse.test.ts tests/bench-memory-protocol.test.ts`
  - `npm run bench:statements -- --check`: the `staging.add-selected` and `status.sparse-*`
    rows show no statement rise.
- **Touch points.**
  - `bench/memory-protocol.ts`
  - `tests/bench-memory-protocol.test.ts`
  - `packages/git/src/do-fs/sparse/`
  - `packages/do/src/fs/store/resolve.ts` and `read.ts`
  - `packages/git/src/ops/staging/staging-add.ts`
  - `packages/git/src/common/paths.ts`
  - possibly `tests/helpers/storage.ts`

### WU3 — workerd harness fidelity and attribution (M) — backlog 86

- **Problem.** The workerd gate measures Durable Object startup, the oracle and the clone
  together, from a lifetime high-water mark. Nobody has split the 472 MiB into V8 heap,
  external memory and allocator retention.
- **Verify first.** Confirm that the `--trace-gc` capture reaches the end of the clone, for
  example with `--trace-gc-nvp` and a final forced GC line.
- **Scope.** This WU changes the harness only. It changes no production code.
  1. Warm the Durable Object with a no-op request before the baseline.
  2. Reset `VmHWM` through `/proc/<pid>/clear_refs` before the clone.
  3. Move the `validateCheckout` oracle out of the measured region. Keep it as a hard
     correctness check.
  4. Record the V8 heap from the trace, and a host-side `smaps_rollup` sampler for
     anonymous and file memory.
  5. Record the cgroup `memory.max` with every number.
- **Acceptance / witness.**
  - Run `cpu-lease run -n 2 -- npm run bench:workerd:nextjs` three times. The output
    separates V8 used and committed, external memory, and process RSS for the clone alone.
  - The oracle still verifies 24,252 files.
  - Write the attribution in the run log.
- **Touch points.** `bench/workerd/run.ts`, `bench/workerd/worker.ts`.

### WU4 — workerd clone gate (S, plus code if needed) — backlog 86, after WU3

- **Problem.** An RSS gate on local workerd does not measure the production 128 MB isolate
  limit (`bench/CLAUDE.md` rule 8).
- **Verify first.** WU3's attribution must show that the V8 heap fits the proposed limit and
  that the non-V8 memory is allocator or runtime retention rather than kompjutr buffers. If
  either fails, stop and re-gate with the user.
- **Scope.**
  1. Write an ADR that replaces the RSS gate. The clone must complete under
     `MINIFLARE_WORKERD_V8_FLAGS=--max-old-space-size=100`, and the peak V8 heap used must
     stay below 100 MiB. Process RSS stays report-only as a regression signal.
  2. Implement the gate in the harness.
  3. Reduce kompjutr code only if the new gate fails, and only in the owners WU3 names.
     Such a change triggers a re-gate.
- **Acceptance / witness.**
  - Three leased `bench:workerd:nextjs` runs pass the new gate with an unchanged oracle.
  - `bench/CLAUDE.md` and `docs/reference/benchmark-current.md` state the new gate and
    correct the page-cache claim.
- **Touch points.**
  - `bench/workerd/`
  - `bench/CLAUDE.md`
  - `docs/decisions/0026-*.md`
  - `docs/reference/benchmark-current.md`

### WU5 — Checkout modeled charges (M) — backlog 97

Two commits in this order.

**Commit A — the charges that count caps already bound.**

- **Problem.** Modeled byte charges duplicate count caps. The exclusion charge refuses
  rebase roots that rebase itself accepts.
- **Verify first.** Rerun the grounding probes: removal, and exclusions with 64 roots of
  17,000 characters.
- **Scope.**
  - Drop the unmerged and prune byte charges. Keep the 10,000 and 50,000 count caps.
  - Drop the exclusion byte charge. Keep the 64-root cap.
    - Do not share the normalizer with `rebaseExclusions` in this sprint (see Out of scope).
  - Replace the tracker seed constants with a count cap and the 8 KiB path guard. Follow
    the status precedent in `ops/status/status-sparse-tracker.ts:11,78-85`.
- **Witnesses.**
  - The 10,001st conflict path fails with `E2BIG` and leaves the state unchanged.
  - 10,000 conflicts with paths of about 1 KiB succeed.
  - The 50,001st prune directory fails.
  - Rebase start and abort with 64 roots of 17,000 characters succeed.
  - Gitlinks past the seed cap skip the reseal, and the checkout still succeeds.

**Commit B — structural state and removals, streamed (option C1).**

- **Problem.** The `removed` list and the structural sets have no count cap. Their 16 MiB
  modeled charge refuses a checkout to the empty tree over about 77,000 typical paths.
- **Scope.**
  - Stream the removal windows during the join.
    - Retain only the count-capped directory map.
    - Walk the worktree for emptiness after the removals.
  - Replace the structural charge on `removals`, `preservedRemovals` and `activeLeaves`
    with one combined count cap of 50,000.
    - First confirm that no current witness exceeds it.
    - If a cap would refuse work that passes today, stop and re-gate.
  - Keep the real payload limits:
    - `CHECKOUT_REMOVE_FLUSH_BYTES`
    - `CHECKOUT_BLOB_BYTES`
    - `maxWriteBytes`
    - `INITIAL_BLOB_BYTES` and `INITIAL_SMALL_FILE_BYTES`
- **Witnesses.**
  - The grounding probe (1,100 × 8 KB paths, checkout to empty) succeeds.
  - A checkout to the empty tree over at least 80,000 short paths succeeds.
  - The first excess structural item fails with `E2BIG`, and the transaction rolls back.
    Drive it through hard reset, which runs `discardUnmerged` and `restoreStructure`.
- **Acceptance.**
  - `npx vitest run tests/plumbing-write.test.ts tests/reflog-operations.test.ts tests/checkout-initial.test.ts tests/rebase-restart.test.ts tests/checkout-sparse.test.ts tests/rebase.test.ts tests/checkout-lifecycle-store.test.ts`
  - Before the change, these 92 checkout tests passed in 94 s.
  - Local rollback: run one excess case through `LocalWorkspace` and show that disk and
    index are unchanged.
  - Measurement: add `core.checkout.tree-swap` to `bench/memory.ts`. It calls
    `checkoutTree` on a 24,252-file tree against the empty tree, bypassing the sparse path.
    Run it three times with `npm run bench:memory -- --scenarios=core.checkout.tree-swap`,
    before and after.
- **Touch points.**
  - `packages/git/src/ops/checkout/`: `checkout-support.ts`, `checkout-structure.ts`,
    `checkout-operation.ts`, `initial-checkout.ts`
  - `tests/plumbing-write.test.ts`, `tests/checkout-initial.test.ts`, `tests/rebase.test.ts`
  - `bench/memory.ts` and `bench/memory-protocol.ts`, for the new scenario only

### WU6 — Rebase-owned full passes (L) — backlog 95, part a

- **Problem.** One pick makes 43 full passes. About 30 of them repeat a decision or could be
  bounded by the diff.
- **Verify first.**
  - Add the gate rows first, before any code change: `rebase.large-n` and `rebase.large-2n`
    in `bench/statements.ts`.
    - The fixture has at least 4,000 files at N, 1 upstream file, 100 touched files and one
      pick.
    - Add one variant with a sealed index tracker and one without.
    - Add a growth check like `statements.ts:2456`.
    - Commit the rows with their HEAD baseline.
  - Rerun the per-call-site probe at 10,000 files.
- **Scope,** in priority order:
  1. **P1 — carry the proven baseline within one `driveRebase` call.**
     - Skip `requireCurrentBaseline` at step start and at publish when the previous
       transaction of the same call established it.
     - Keep the check in `rebaseContinue`, `rebaseSkip` (`rebase.ts:131,139`) and after a
       restart.
     - The per-path guard at `rebase-lifecycle-step.ts:103` stays. It matches Git's per-pick
       rule.
  2. **P2 — answer the start preconditions from the index tracker when it exists.**
     - The tracker baseline must equal the HEAD tree, the dirty set must be empty, and
       `hasCheckoutBlockingIndexEntries` must be false.
     - Without a tracker, which is the local adapter, fuse `rebase.ts:64-66` into one joined
       pass.
     - Drop `:64` when the relation is `replay` only if the `:75` preflight proves the same
       bound.
  3. **P3 — diff-bounded `materializeTree`.** Use `trySparseCleanCheckout` from the original
     tree to upstream. Keep the full path when `excludeRoots` is non-empty or the fast path
     declines. Do not reseal the tracker.
- **Acceptance / witness.**
  - `npx vitest run tests/rebase.test.ts tests/rebase-large.test.ts tests/rebase-restart.test.ts tests/rebase-plan.test.ts tests/concurrency-operations.test.ts`
  - A new case: a worktree edit to a touched path between `rebase` and `rebaseContinue` is
    still refused.
  - `npm run bench:statements -- --check`: the new rows fall in rows, their statements do
    not rise, and every other row stays unchanged.
  - Run `cpu-lease run -n 2 -- npm run bench:nextjs` three times. The rebase phase must read
    fewer rows with no more than 942 statements, and its added peak must fall.
  - `core.rebase.baseline-hash` stays under 100 MiB.
- **Touch points.**
  - `packages/git/src/ops/rebase/`
  - `packages/git/src/ops/integration/integration-worktree.ts`, for the start checks only
  - `bench/statements.ts`
  - `tests/rebase*.test.ts`
  - It reads `ops/checkout/sparse-checkout-operation.ts` and does not edit it.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Six WUs in four areas. WU5 and WU6 both change what rebase runs in checkout. | `npm test`, `npm run typecheck` and `npm run check` after each commit. One `npm run test:full` at closure. `bench:statements -- --check`, `bench:memory` and three `bench:nextjs` runs at closure, all leased. | A focused witness fails after integration. A statement row rises. A memory gate that passed fails again. |
| WU1 | One constant, but it affects every initial write. | Focused witness, and the Durable Object parameter limit cited. No independent review unless the flush shape changes. | The limit is unknown, or the merged flush changes row contents. |
| WU2 | Hot add path. The protocol change could look like gate loosening. | Focused witness plus three memory runs. Independent review of the protocol change and of every removed copy. | The gate still fails after scope item 4. The harness change is the only thing that makes it pass. |
| WU3 | Harness only. A wrong harness gives a confident wrong number. | Three leased runs. Independent review of what the measured region contains. | The trace cannot reach the end of the clone. |
| WU4 | Replaces a gate, which the backlog forbids to widen without evidence. | An ADR citing WU3 numbers. User approval was given at the sprint gate on condition of that evidence. Independent review of the ADR. | The V8 heap exceeds 100 MiB. Code changes turn out to be needed. |
| WU5 | Changes refusal behaviour and removal order in checkout, which rebase, reset, clone and read-tree all use. | Focused witness, the local rollback case, and the tree-swap measurement. Independent review of each commit, then re-review after substantive fixes until clean. | A count cap refuses work that passes today. The streamed removal changes the order of observable results. |
| WU6 | Narrows safety checks inside rebase. This is the largest blast radius. | Gate rows first. Focused witness and the Next.js runs. Independent review of P1's safety argument and P3's equivalence, repeated until clean. | Any rebase semantics change. The statement count rises. A local-adapter test fails. |

## Test cadence

- **Per WU.** Run the exact acceptance witness above. WU2 and WU5 may cross into the
  filesystem domain, so also run `npm run test:fs`.
- **Routine integration.** Run `npm test` after each commit, and keep it under 30 seconds.
- **Benchmarks.** Every benchmark runs under `cpu-lease`. `bench:memory` reserves its own
  lease. Record `memory.max` with every memory number. Never compare numbers taken under
  different caps.
- **Sprint closure.** Run `cpu-lease run -n 4 -- npm run test:full` once, after final
  review. The last run took about 743 s.
- **Failure loop.** Reproduce a failure with its exact file, and stabilize that file before
  rerunning the full suite.
- Run `npm run format` and `npm run check` before each commit.

## Out of scope (explicit)

- **Backlog 95, part b** is filed as a new backlog item. It covers the shared integration
  step bounds that merge, cherry-pick and revert also use: pruning the three-tree walk,
  seeking selected ranges in the step guard, `snapshotDrafts`, the result-tree check, and a
  sparse tree plan in `writeUnpublishedCommit`.
- **P4 of backlog 95**, which limits the baseline preflight object checks to diff blobs. It
  is semantics-sensitive: gitlinks, promisor trees, and a local disk that is not
  transactional.
- **Sharing the exclusion normalizer** between checkout and `rebaseExclusions`. It would
  cross into WU6's territory. Record it in the 95b item.
- The [integration worktree reads idea](../ideas/read-integration-worktree-inputs-once.md).
- Node clone memory. It meets its <160 MiB gate under the 1 GiB cap.

## Decisions

- **The sparse-add row drops the former-limit crossing check.** Its input cannot legally
  exceed 64 MiB: `MAX_PATHS` is 1,000, paths are at most 8 KiB, and the binding is capped
  at 8 MiB. The row witnesses the maximum real workload. The <100 MiB peak gate stays.
- **The workerd clone gate becomes a V8 heap gate, if WU3's evidence holds.** RSS on local
  workerd stays report-only. The user approved this direction at the sprint gate, and the
  ADR in WU4 records it.
- **Checkout removals stream (option C1).** A prune `E2BIG` may then fire after some
  removals, and the caller's transaction rolls them back. That is how every other checkout
  charge already behaves. The alternative, an rm-style preflight, would add the full passes
  that backlog 95 removes.
- **Rebase P1 relies on the per-path step guard,** the same rule Git applies on each pick.
  The whole-tree check runs once per `driveRebase` call, and again after a continue, a skip
  or a restart.

## Sequencing

WU5 and WU6 both change what rebase runs in checkout, so WU6 starts after WU5 commit B lands.
WU4 needs WU3. WU2 and WU5 both edit `bench/memory-protocol.ts`, so wave 0 lands WU2
scope item 1 (the protocol decision) as a seam. After that, WU5 owns that file. WU1, WU2,
WU3 and WU5 then have disjoint write territories.

| Wave | WU | Note |
|---|---|---|
| 0 | WU2 item 1 | Protocol seam, landed by the leader |
| 1 | WU1, WU2, WU3, WU5 | Parallel, in one tree |
| 2 | WU4, WU6 | WU4 after WU3; WU6 after WU5 |
| 3 | Closure | Rebaseline statements, run benchmarks, run `test:full`, update docs |

## Plan review

- **Reviewer:** pending
- **Verdict:** pending
- **Material findings:** pending

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->
