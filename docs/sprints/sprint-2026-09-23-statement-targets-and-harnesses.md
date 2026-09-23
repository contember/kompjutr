<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Statement targets and harnesses (2026-09-23)

> **PAUSED 2026-09-23 at `22a265f`.** Landed: WU3 (`4c333ce`), WU2
> (`2e20f45`), WU1 `clone-storage` half (`ce701af`). Decided by the user after
> the run-log escalations below:
> - **WU1 reachability → retire the scenario.** Not started. Remove the
>   `sqlite.maintenance.reachability` spec in `bench/memory-protocol.ts`
>   (`LARGE_HEADER_BYTES`, the union members), `maintenanceReachabilityScenario`
>   and its registration in `bench/memory.ts`, and `largeHeaderChunks` /
>   `streamedObjectOid` if nothing else uses them; then typecheck and
>   `npm run bench:memory -- --runtime-check`.
> - **WU4 → deferred.** Partial outcome; backlog 87 is rescoped as an ADR-0024
>   design question. No code change in this sprint.
> - **WU5 → do the small cuts.** Not started. Batch the clone's four config
>   writes, read the user identity once per operation, and dedupe full ref
>   listings; each with its own witness and independent review. Re-measure
>   with `bench:nextjs` then `bench:statements -- --check`, update
>   `FROZEN_NEXTJS_REFERENCES`. Estimated −10 to −15 of the −29 needed; if
>   that falls short, the next candidates are the two ref-mutation transactions
>   and the mutation-guard pairs, which need their own decision.
>
> Not yet run since WU2/WU1 landed: `npm test`, typecheck. Closure still owes
> `test:full`, the OUTCOME header, archiving, and deleting backlog 83, 85
> (once reachability is retired), 88 and 89. Nothing is pushed.

**Goal.** Every row that `bench:statements` and the Next.js workflow report meets
the 1,000-statement target, and every benchmark harness runs again.

**Theme.** The 2026-09-10 sprint closed with measured debt instead of estimates.
Four items are statement cost in the store and integration layers
([87](../backlog/87-bring-rebase-transition-under-the-statement-target.md),
[88](../backlog/88-elide-the-operation-journal-keyset-probe.md),
[89](../backlog/89-trust-staged-commit-promotion.md),
[90](../backlog/90-bring-the-nextjs-clone-under-the-statement-target.md)).
[85](../backlog/85-restore-broken-benchmark-harnesses.md) restores two
harnesses that have reported nothing since 2026-09-08; it touches only `bench/`
files outside the statement gate and runs in parallel with the rest.
[83](../backlog/83-order-unmerged-status-rows-after-changed-rows.md) is a small
silent divergence from Git (parity tier S) with no dependency on the rest; it
rides along so it does not wait for a parity sprint. Success: `bench:statements
-- --check` exits 0 with every row, including the Next.js clone reference,
reporting `pass`; no frozen statement count rises; and both repaired harnesses
produce a report. If a target proves unreachable within its WU's contract, the
miss is recorded with its histogram and filed as backlog, not forced (see WU4).

## Refs re-verified at HEAD (2026-09-23, `8d6ebd6`; plan review at `37980d3`)

- ⚠ **83 lives in the v2 formatter, not in `status()`.** The backlog item
  cites `buildStatusRows` in `status-core.ts`; that name does not exist. The
  shared sort is `sortStatusDetails`
  (`packages/git/src/ops/status/status-core.ts:26-36`), and it is correct for
  porcelain v1: Git 2.54.0 prints v1 in path order (`UU a_conflict.txt` before
  `M  z_clean.txt`) and v2 in class order (`1 … z_clean.txt` before
  `u UU … a_conflict.txt`), reproduced on 2026-09-23 by the author and again
  by the plan reviewer. `formatPorcelainV2`
  (`packages/git/src/ops/status/status-format.ts:64-111`) already emits `?` and
  `!` in separate passes but interleaves `u` with `1`/`2` in one loop
  (`:73-104`). Changing the shared sort would break v1 and short output; the
  human formatter already groups by section (`status-format-human.ts:67`).
- ✔ `preflightPorcelainV2` walks the same entries in the same single loop
  (`packages/git/src/ops/status/status-format-budget.ts:165+`). It sums record
  metrics, so the order is not observable there; verify before relying on it.
- ✔ `iterateOperationTouched` is the unelided keyset loop
  (`packages/git/src/store/operations/operation-journal-read.ts:146-188`):
  `ORDER BY ordinal LIMIT ${INTEGRATION_PAGE_ROWS}`, exit only on
  `page.length === 0`.
- ⚠ **88 is more than the backlog's "three-line change".** The journal loop
  has two byte-cap exits — before adding a row that would overflow (`:163`)
  and after reaching the cap (`:184`) — and tracks neither `scanned` nor
  `byteCapped`. The integration sites track both and set `byteCapped` at both
  exits (`integration-workspace/touched.ts:163-167`, `:187-190`;
  `storage.ts:192`, `:200`). The journal needs the same shape, or a page cut by
  the pre-add break is taken as final and rows are lost.
- ✔ `isFinalKeysetPage(scanned, byteCapped)` is exported from
  `packages/git/src/store/operations/integration-workspace/storage.ts:59`.
- ✔ The journal is read by `replay-lifecycle.ts`, `merge-journal.ts`,
  `checkout-operation.ts`, `checkout-mutations.ts`, and `operation-journal.ts`.
- ✔ `promoteCommitCaches` brackets its `INSERT … ON CONFLICT DO NOTHING` with
  two `count(*)` probes and throws `CorruptError` on a mismatch
  (`packages/git/src/store/trees/commits-staging.ts:53-77`). Its only caller is
  pack ingest (`packages/git/src/store/pack/pack-ingest-index.ts:381`), so
  removing the probes moves every ingest row, the Next.js clone included.
- ⚠ **85's constant lives in `memory-protocol.ts`.** `LARGE_HEADER_BYTES =
  48 MiB + 64 KiB` is at `bench/memory-protocol.ts:24`, not `bench/memory.ts`.
  `MAX_OBJECT_BYTES = 48 MiB` is at `packages/git/src/common/objects.ts:25`.
- ✔ `bench/clone-storage.ts:53` holds the fixed `TABLE_GROUPS` list and
  `:292-311` throws `unclassified tables`.
- ✔ Frozen baselines are the `BASELINE_STATEMENTS` / `BASELINE_ROWS_READ`
  maps in `bench/statements.ts` (`bench/results/` is gitignored and only holds
  the last run): `rebase.transition-n` 699 statements / 689 rows,
  `rebase.transition-2n` 1,279 / 1,273, target `miss`. `checkReport`
  (`bench/statements.ts:2384`) fails on *any* rows-read difference, so every
  row a WU moves must be rebaselined exactly, in the same commit.
- ⚠ **The Next.js verdict reads a gitignored file.** `loadNextjsReferences`
  (`bench/statements.ts:2334-2346`) reads `bench/results/nextjs-workflow.json`
  from the last `bench:nextjs` run and falls back to `FROZEN_NEXTJS_REFERENCES`
  (`:345`, 1,031 statements / 164,287 rows) only when the file is missing.
  `checkNextjsReference` (`:2354-2372`) fails on a statement rise or a
  rows-read change at three significant figures. `bench:nextjs` itself prints
  no verdict. Order is therefore always `bench:nextjs`, then
  `bench:statements -- --check`, and the frozen constant is updated with it.
- ✔ Histograms: `BENCH_QUERIES=1` works on the `bench/run.ts` → `bench/child.ts:219`
  path, and `nextjs-workflow` is a registered scenario (`bench/scenarios.ts:22`).
  `bench/statements.ts` has only an ad-hoc `storage.histogram` (`:1122`); a
  rebase histogram needs temporary instrumentation.
- ✔ `GRAPH_PAGE = 4_096` (`packages/git/src/store/pack/graph/graph-sql.ts:9`)
  equals `MAX_PACK_BLOB_GRAPH_ENTRIES` (`packages/git/src/store/pack/shared.ts:51`).
- ✔ The Next.js fixture is present in `bench/.fixtures/nextjs`.
- ✔ `PackGraphAdmission` is also used by pack deletion
  (`packages/git/src/store/pack/lifecycle/lifecycle-delete.ts:8`), and ADR-0023
  requires transaction-local, operation-scoped scratch that `cleanup()`
  cascades away.
- ✔ `bench:memory` and `bench:clone-storage` lease their own CPU
  (`bench/clone-storage.ts:832-846`); `bench:nextjs` and `bench:statements` do not.

## Work units

### WU1 — Restore the broken benchmark harnesses (effort S; 85)

- **Problem.** `sqlite.maintenance.reachability` fails in setup on the
  `size BETWEEN 0 AND 50331648` constraint because `LARGE_HEADER_BYTES`
  (`bench/memory-protocol.ts:24`) is 64 KiB above `MAX_OBJECT_BYTES`.
  `bench:clone-storage` throws `unclassified tables` on every clone because its
  classification is a fixed list.
- **Verify first.** Run both and capture the current failure. Read the
  reachability scenario's intent from its spec and history (`git log -S
  LARGE_HEADER_BYTES`) to learn whether it targets an object *at* the limit or
  the large-header streaming path.
- **Scope.** Derive `LARGE_HEADER_BYTES` from `MAX_OBJECT_BYTES` with the
  relation the scenario needs. Classify `clone-storage` tables by prefix rule;
  an unmatched table is an explicit `other` group reported by name, not an
  exception. Omit empty tables from the report.
- **Acceptance / witness.** `npm run bench:memory --
  --scenarios=sqlite.maintenance.reachability` runs to a verdict.
  `npm run bench:clone-storage -- express nextjs` reports on both fixtures. A table added to the schema lands in a group without editing
  the harness (demonstrated once by hand, not a committed test).
- **Touch points.** `bench/memory-protocol.ts`, `bench/memory.ts`,
  `bench/clone-storage.ts`.

### WU2 — Order unmerged porcelain v2 rows after changed rows (effort S; 83)

- **Problem.** `formatPorcelainV2` interleaves `u` rows with `1`/`2` rows in
  path order. Git prints every `1`/`2` row, then every `u` row, then `?`, then
  `!`. Porcelain v1, short, and human output are already correct.
- **Verify first.** Confirm no other v2 emitter exists (only `index.ts` and
  `status.ts` re-export it). Confirm the shell `git status --porcelain=v2` path
  goes through `formatPorcelainV2`.
- **Scope.** Split the first loop into a changed pass and an unmerged pass, the
  way `?` and `!` are already split. Leave `sortStatusDetails` alone.
- **Acceptance / witness.** A conflicted-merge journey that compares porcelain
  v2 against the `git` binary through the e2e world harness
  (`tests/helpers/e2e.ts:194`, `:1153`): one conflicted and one cleanly merged
  path, conflicted path sorting first. The natural case is the shape
  `tests/e2e/production-cold-workflow.test.ts` currently avoids; it must fail
  before the change. `tests/status-format.test.ts` has no merge setup and is not
  the witness. A porcelain v1 comparison of the same state is a regression guard
  only — it cannot fail, because the shared sort does not change.
- **Touch points.** `packages/git/src/ops/status/status-format.ts`,
  `tests/e2e/production-cold-workflow.test.ts` (or `tests/local/git-parity.test.ts`).

### WU3 — Elide the journal keyset probe and trust commit promotion (effort S; 88, 89)

- **Problem.** `iterateOperationTouched` issues one empty query at the end of
  every traversal. `promoteCommitCaches` re-counts rows it wrote in the same
  transaction, which invariant 4 forbids.
- **Verify first.** For 88: confirm no journal consumer appends to
  `git_operation_touched` while a traversal is live, per caller listed above.
  For 89: establish whether a staged key can lack a `git_commits` row after the
  insert. `ON CONFLICT(repo_id, oid) DO NOTHING` leaves an existing row in
  place, so the question is whether an existing row can disagree with the
  staged one; answer it from the write path and `CHECK` constraints.
- **Scope.** 88: add a `scanned` counter and a `byteCapped` flag set at both
  byte exits, mirroring `integration-workspace/touched.ts:146-199`, and return
  after yielding a page where `isFinalKeysetPage` holds, importing the shared
  predicate. 89: delete both probes if the write path already guarantees
  coverage; if it does not, move the guarantee into the write path. Update
  ADR-0004 only if the answer refines the trust rule. Rewrite both `BASELINE_*`
  maps exactly for every row that moves; run `bench:nextjs` and update
  `FROZEN_NEXTJS_REFERENCES`, since 89 changes every pack ingest.
- **Acceptance / witness.** 88: the three cases `e355936` added in
  `tests/integration-bounded-output.test.ts:393+`, ported to the journal in
  `tests/operation-state.test.ts`, counting statements with
  `db.storage.resetCounters()` and `statementCount`:
  - a short final page returns every row in exactly *pages* statements — fails
    at HEAD;
  - an exact page multiple returns every row in *pages + 1* statements —
    guards against over-elision;
  - a byte-capped page with fewer than `INTEGRATION_PAGE_ROWS` rows is followed
    and every row returns — fails on a naive `page.length < INTEGRATION_PAGE_ROWS`
    exit.

  89 cannot have a failing witness: the staging key is `(repo_id, pack_id,
  oid)`, `ON CONFLICT(repo_id, oid) DO NOTHING` keeps an existing row, and any
  other violation aborts, so `covered == staged` always holds. The commit
  message states that argument; the observable result is two fewer statements
  per ingest. `tests/pack-projection-publication.test.ts` stays green, including
  the cleanup-fault rollback and second-handle reads. Both: `bench:nextjs` then
  `bench:statements -- --check` exit 0 with no statement count rising.
- **Touch points.** `packages/git/src/store/operations/operation-journal-read.ts`,
  `packages/git/src/store/trees/commits-staging.ts`,
  `tests/operation-state.test.ts`, `tests/pack-projection-publication.test.ts`,
  `bench/statements.ts`.

### WU4 — Bring an eight-step rebase under the target (effort M; 87)

- **Problem.** `rebase.transition-2n` costs 1,279 statements. The marginal
  cost is (1,279 − 699) / 4 = 145 per step over a fixed ~119. Reaching 1,000 at
  8 steps needs ≤ ~110 per step, a cut of ≥ ~35 per step. `e355936` measured the
  probe tax at 46/95/191 for 2/4/8 steps, i.e. ~24 traversals per step, not the
  backlog's ~40. If most are single-page, removing *every* traversal saves
  ~192 and still leaves ~1,087, so collapsing traversals alone likely cannot
  reach the target.
- **Verify first.** Add temporary per-query instrumentation to the rebase rows
  in `bench/statements.ts` (only an ad-hoc `storage.histogram` exists, `:1122`)
  and histogram one step after WU3 lands. Name the consumer of every
  traversal *and* every non-traversal per-step statement. Do not change code
  until each has a named reader and purpose. Remove the instrumentation before
  commit.
- **Scope.** Collapse traversals that read the same plan for the same purpose.
  Hoist per-step work that does not depend on the step. Keep ADR-0024's
  contract: plans stay traversable and are not held in memory.
- **Acceptance / witness.** `bench:statements -- --check`: `rebase.transition-2n`
  reports `pass`; the three rebase rows' statement counts fall and both
  `BASELINE_*` maps are rewritten exactly. `GIT_EDITOR=true
  GIT_SEQUENCE_EDITOR=true` for `tests/e2e/rebase.test.ts`,
  `tests/replay.test.ts`, and `tests/local/git-parity.test.ts`, all green.
- **Partial outcome.** If the histogram shows the target needs a change to
  ADR-0024's contract, land the cuts that fit, rebaseline, record the residual
  with its histogram in the run log, and file a backlog item. Do not change
  ADR-0024 inside this sprint.
- **Touch points.** `packages/git/src/ops/rebase/`,
  `packages/git/src/ops/integration/`,
  `packages/git/src/store/operations/integration-workspace/`,
  `bench/statements.ts`.

### WU5 — Bring the Next.js clone under the target (effort M; 90)

- **Problem.** One 24,252-file clone costs 1,031 statements (≈1,029 after
  WU3's 89 change; re-measure), ~30 over target;
  the residue is ADR-0023 admission (six query shapes per page plus the scratch
  lifecycle) and ADR-0025's per-flush statement.
- **Verify first.** `BENCH_QUERIES=1 cpu-lease run -n 2 -- npm run bench --
  --scenarios=nextjs-workflow` after WU3 lands. Attribute the remainder before
  choosing a change. Candidates from the backlog: share one page between
  the reverse and forward passes; hoist the scratch create/delete pair out of
  the per-clone path.
  Hoisting the scratch pair must respect ADR-0023's transaction-local,
  operation-scoped scratch; if it cannot, drop that candidate.
- **Scope.** The change the histogram justifies. Do not raise `GRAPH_PAGE`.
- **Acceptance / witness.** `cpu-lease run -n 2 -- npm run bench:nextjs`, then
  `bench:statements -- --check`: `git.clone` reports `pass`, rows read equal at
  three significant figures or rebaselined with a stated reason, and
  `FROZEN_NEXTJS_REFERENCES` updated in the same commit; the fetch and
  maintenance rows stay green. Clone native oracles unchanged. Every admission
  rejection witness green (`tests/pack-graph-admission.test.ts`,
  `tests/pack-cold-admission.test.ts`) plus the pack lifecycle/delete tests,
  because pack deletion shares `PackGraphAdmission`.
- **Touch points.** `packages/git/src/store/pack/graph/`,
  `packages/git/src/store/pack/ingest.ts`,
  `packages/git/src/store/pack/lifecycle/`,
  `packages/git/src/store/schema/schema-pack-graph-statements.ts`,
  `bench/statements.ts` (`FROZEN_NEXTJS_REFERENCES`).

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Statement cuts in shared store paths can lose rows silently | All five witnesses, `bench:statements -- --check`, `bench:nextjs`, typecheck, check, then `test:full` once | Any frozen row moves up; any native oracle changes |
| WU1 | Bench-only; no shipped code | Both harnesses produce a report; direct inspection, no independent review | The repair changes what the reachability scenario measures in a way its spec does not support |
| WU2 | Output-format change, small, parity-pinned | Parity witness v1 + v2 against `git`; direct inspection | The fix needs to touch `sortStatusDetails` or the budget preflight |
| WU3 | 88 is a proven pattern; 89 changes a trust contract | Three journal paging witnesses + publication tests + statement gate; independent review of 89's reasoning only | 89 finds a real coverage gap in the write path |
| WU4 | Touches every integration consumer's traversal | Rebase/replay/parity tests + statements gate; independent review, re-review semantic fixes until clean | Target unreachable without changing ADR-0024's contract (→ partial outcome) |
| WU5 | Admission is a validation boundary shared with pack deletion | Admission rejection + pack lifecycle/delete witnesses, Next.js gate, full `bench:statements -- --check`; independent review | Reaching the target needs fewer validated objects, a page-size change, or any change to scratch ownership or lifecycle under ADR-0023 |

## Test cadence

- **Per WU.** `cpu-lease run -n 2 -- npx vitest run --maxWorkers=2 <files named
  by that WU>`. Statement gate: `cpu-lease run -n 2 -- npm run bench:statements
  -- --check`. `bench:memory` and `bench:clone-storage` lease themselves; do
  not nest them in a lease. `bench:nextjs` does not: `cpu-lease run -n 2 --
  npm run bench:nextjs`, always before `bench:statements -- --check`. Rebase,
  replay, and parity tests run with `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true`.
- **Routine integration.** `cpu-lease run -n 4 -- npm test` (target <30 s),
  then `npm run typecheck` and `npm run check` after each integrated WU.
  `npm run test:e2e` after WU2 and WU4.
- **Sprint closure.** `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run
  -n 4 -- npm run test:full` once, after review and fixes settle; then
  `bench:nextjs` followed by `bench:statements -- --check` for the final
  numbers.
- **Failure loop.** Reproduce a full-suite failure by exact file or slice.
  Rerun the full suite only after the focused witness is stable.

## Out of scope (explicit)

- [84](../backlog/84-read-integration-worktree-inputs-once.md) and
  [86](../backlog/86-bound-sparse-selected-add-and-workerd-clone-peaks.md) —
  memory and transfer volume, not statements. 86 needs a decomposition the
  harness cannot yet make (V8 heap versus SQLite page cache). Candidate for a
  following memory-and-transfer sprint with
  [81](../backlog/81-copy-object-bytes-only-when-retained.md).
- [65](../backlog/65-git-sqlite-architecture-review.md) remainder and
  [75](../backlog/75-bound-network-authentication-payloads.md)–[80](../backlog/80-restore-import-graph-domain-guarantees.md)
  — sequenced after the external integration gate.
- Other parity gaps. WU2 fixes only the v2 row order.

## Decisions

- 83 is fixed in `formatPorcelainV2`, not in the shared sort, because Git
  itself orders v1 and v2 differently (see refs).
- WU3 combines 88 and 89: both are small, both are store-level reads of rows
  the store wrote, and both feed WU4's histogram.
- WU4 and WU5 start from a histogram. A target reached by raising a page size
  or dropping validation is not accepted.

## Sequencing

1. WU1 runs in parallel with everything; it does not touch `bench/statements.ts`.
2. WU2 runs in parallel with WU3; disjoint files.
3. WU4 and WU5 after WU3: 88 changes the rebase rows and 89 changes the clone,
   so both histograms start from WU3's numbers.
4. WU4 and WU5 may run in parallel in code; they share the baselines in
   `bench/statements.ts`, so commit their rebaselines one at a time.

## Plan review

- **Reviewer:** independent Claude agent (general-purpose), at `37980d3`.
- **Verdict:** approved with changes; all findings applied in this revision.
- **Material findings:**
  1. 88 needs `scanned`/`byteCapped` tracking, not a three-line change → WU3 scope.
  2. The planned 88 witnesses could not fail at HEAD → ported the three
     statement-counting cases from `e355936`.
  3. The Next.js verdict reads a gitignored file and needs `bench:nextjs`
     first → refs, WU5, cadence.
  4. Rows-read baselines are exact; 89 moves every ingest row → WU3 rebaselines
     both maps and the Next.js reference.
  5. WU4's per-step numbers were wrong and traversal collapse alone likely
     misses → corrected, added partial outcome.
  6. Histogram tooling unnamed; WU1 had a false dependency → named, removed.
  7. WU5 lacked the pack-deletion gate and an ADR-0023 scratch escalation → added.
  8. WU2's witness file had no merge setup → moved to the e2e harness.
  9. 89 cannot have a failing witness → argument goes in the commit message.
  10–11. Cadence commands and small grounding slips → fixed.

## Run log

- **WU3 landed** (`4c333ce`). The journal's byte-cap witness needed JSON
  escaping to reach the cap: journal paths stop at 2,200 bytes, so plain rows
  fit 256 per page under `JSON_BATCH_BYTES`. Each U+0001 costs six bytes.
  Frozen rows moved down: `merge.recovery` 104 → 101, `merge.restore` 99 → 90,
  `replay.recovery` 118 → 115, `transport.fetch` 84/66 → 82/64, the Next.js
  clone 1,031/164,287 → 1,029/164,285. The rebase rows did not move, because
  rebase writes an empty touched journal.
- **WU2 landed** (`2e20f45`). The journey failed before the fix with exactly
  the class-order diff.
- **WU1: `clone-storage` landed** (`ce701af`). Every Next.js table lands in a
  named family. Empty tables stay in the group totals (one page each, which is
  real billed storage); the object table already hides tables under two pages.
- **WU1: reachability is escalated.** The scenario exists to witness a commit
  header *above* the former 48 MiB reachability ceiling, and `memory-protocol.ts:608`
  refuses any scenario whose workload does not cross its former limit. Since
  `b2cabed` the `git_objects` size CHECK caps every object at `MAX_OBJECT_BYTES`
  = 48 MiB, so that workload cannot be stored. Setting the header to the limit
  fails the crossing check. Repair needs a decision: retire the scenario, or
  redefine what it measures.
- **WU4: partial outcome.** Per-step histogram of `rebase.transition-n` vs
  `-2n`: 145 statements per step across ~80 query shapes. Integration plan
  traversals are the largest family at 21 per step (one statement each on this
  fixture), named by call site: planning (3), projection and collisions (3),
  worktree safety and prospective index (2), touched shapes (2), apply (7:
  validation, snapshot, materialize, oids, removals ×2, index), and the step
  itself (2). Next: index reads 9, `git_objects` type lookups 8, tree walks 7,
  worktree path walks 11, ref DWIM probes 6. Collapsing every plan traversal
  would still leave ~1,150; the target needs ≤ ~110 per step, which means
  fusing integration phases — a change to ADR-0024's traversal contract. No
  cut landed. → backlog 87 rescoped.
- **WU5: the residue is not admission.** Clone histogram at 1,029: pack graph
  admission is ~25 statements in total. The rest is data-proportional (worktree
  writes 383, pack reads 84 + 51 delta-chain resolutions, object batches) plus
  small per-mutation costs: 5 mutation-guard pairs (10), 4 config keys written
  as DELETE+INSERT each (8), user identity read twice per reflog writer (4),
  two ref-mutation transactions each listing all refs, pruning reflogs, bumping
  the root epoch and fetch namespaces (~10), full ref listings 5×. Reaching
  ≤1,000 means several small cuts across refs, config, and identity — not the
  admission changes the plan scoped. → backlog 90 rescoped.
