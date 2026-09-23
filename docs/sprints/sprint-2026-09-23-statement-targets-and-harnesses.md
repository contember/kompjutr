<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Statement targets and harnesses (2026-09-23)

**Goal.** Every row that `bench:statements` and the Next.js workflow report meets
the 1,000-statement target, and every benchmark harness runs again.

**Theme.** The 2026-09-10 sprint closed with measured debt instead of estimates.
Four items are statement cost in the store and integration layers
([87](../backlog/87-bring-rebase-transition-under-the-statement-target.md),
[88](../backlog/88-elide-the-operation-journal-keyset-probe.md),
[89](../backlog/89-trust-staged-commit-promotion.md),
[90](../backlog/90-bring-the-nextjs-clone-under-the-statement-target.md)).
[85](../backlog/85-restore-broken-benchmark-harnesses.md) restores the tools
that attribution depends on, so it goes first.
[83](../backlog/83-order-unmerged-status-rows-after-changed-rows.md) is a small
silent divergence from Git (parity tier S) with no dependency on the rest; it
rides along so it does not wait for a parity sprint. Success: `bench:statements
-- --check` reports `pass` for every row, `nextjs:git.clone` reports `pass`, no
frozen row moves up, and both repaired harnesses produce a report.

## Refs re-verified at HEAD (2026-09-23, `8d6ebd6`)

- ⚠ **83 lives in the v2 formatter, not in `status()`.** The backlog item
  cites `buildStatusRows` in `status-core.ts`; that name does not exist. The
  shared sort is `sortStatusDetails`
  (`packages/git/src/ops/status/status-core.ts:26-36`), and it is correct for
  porcelain v1: Git 2.54.0 prints v1 in path order (`UU a_conflict.txt` before
  `M  z_clean.txt`) and v2 in class order (`1 … z_clean.txt` before
  `u UU … a_conflict.txt`), reproduced on 2026-09-23. `formatPorcelainV2`
  (`packages/git/src/ops/status/status-format.ts:64-111`) already emits `?` and
  `!` in separate passes but interleaves `u` with `1`/`2` in one loop
  (`:73-104`). Changing the shared sort would break v1, short, and human output.
- ✔ `preflightPorcelainV2` walks the same entries in the same single loop
  (`packages/git/src/ops/status/status-format-budget.ts:165+`). It sums record
  metrics, so the order is not observable there; verify before relying on it.
- ✔ `iterateOperationTouched` is the unelided keyset loop
  (`packages/git/src/store/operations/operation-journal-read.ts:146-188`):
  `ORDER BY ordinal LIMIT ${INTEGRATION_PAGE_ROWS}`, exit only on
  `page.length === 0`.
- ⚠ **88's loop has two byte-cap exits, not one.** It breaks *before* adding a
  row that would overflow (`:163`) and *after* reaching the cap (`:184`). The
  integration sites set `byteCapped` at one exit only
  (`integration-workspace/touched.ts:185-199`). Both journal exits must set it,
  or a page cut by the pre-add break is taken as final and rows are lost.
- ✔ `isFinalKeysetPage(scanned, byteCapped)` is exported from
  `packages/git/src/store/operations/integration-workspace/storage.ts:59`.
- ✔ The journal is read by `replay-lifecycle.ts`, `merge-journal.ts`,
  `checkout-operation.ts`, `checkout-mutations.ts`, and `operation-journal.ts`.
- ✔ `promoteCommitCaches` brackets its `INSERT … ON CONFLICT DO NOTHING` with
  two `count(*)` probes and throws `CorruptError` on a mismatch
  (`packages/git/src/store/trees/commits-staging.ts:53-80`).
- ⚠ **85's constant lives in `memory-protocol.ts`.** `LARGE_HEADER_BYTES =
  48 MiB + 64 KiB` is at `bench/memory-protocol.ts:24`, not `bench/memory.ts`.
  `MAX_OBJECT_BYTES = 48 MiB` is at `packages/git/src/common/objects.ts:25`.
- ✔ `bench/clone-storage.ts:53` holds the fixed `TABLE_GROUPS` list and
  `:292-311` throws `unclassified tables`.
- ✔ Frozen baselines are the `BASELINE_STATEMENTS` / `BASELINE_ROWS_READ`
  maps in `bench/statements.ts` (`bench/results/` is gitignored and only holds
  the last run): `rebase.transition-n` 699 statements / 689 rows,
  `rebase.transition-2n` 1,279 / 1,273, target `miss`. The Next.js reference
  is `git.clone` 1,031 statements / 164,287 rows.
- ✔ `GRAPH_PAGE = 4_096` (`packages/git/src/store/pack/graph/graph-sql.ts:9`)
  equals `MAX_PACK_BLOB_GRAPH_ENTRIES` (`packages/git/src/store/pack/shared.ts:51`).
- ✔ The Next.js fixture is present in `bench/.fixtures/nextjs`.

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
- **Acceptance / witness.** `npm run bench:memory` runs the reachability case
  to a verdict. `npm run bench:clone-storage` reports on the `express` fixture
  and on Next.js. A table added to the schema lands in a group without editing
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
- **Acceptance / witness.** A parity case in `tests/status-format.test.ts` (or
  the existing parity harness it uses) compared against the `git` binary: one
  conflicted `a_conflict.txt` and one cleanly merged `z_clean.txt`, asserting
  byte-equal porcelain v2 *and* porcelain v1 output. The v2 case fails before
  the change. Then let `tests/e2e/production-cold-workflow.test.ts` compare the
  natural partially conflicted shape it currently avoids.
- **Touch points.** `packages/git/src/ops/status/status-format.ts`,
  `tests/status-format.test.ts`, `tests/e2e/production-cold-workflow.test.ts`.

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
- **Scope.** 88: set `byteCapped` at both byte exits and return after yielding
  a page where `isFinalKeysetPage` holds, importing the shared predicate. 89:
  delete both probes if the write path already guarantees coverage; if it does
  not, move the guarantee into the write path. Update ADR-0004 only if the
  answer refines the trust rule.
- **Acceptance / witness.** 88: two cases in `tests/operation-state.test.ts`
  against the journal — a traversal ending exactly on a page boundary, and a
  page cut by the pre-add byte break with fewer than a full page of rows. Each
  must fail against a naive `page.length < INTEGRATION_PAGE_ROWS` exit. 89:
  `tests/pack-projection-publication.test.ts` stays green, including the
  cleanup-fault rollback and second-handle reads. Both: `bench:statements --
  --check` exits 0 and every row that moves, moves down.
- **Touch points.** `packages/git/src/store/operations/operation-journal-read.ts`,
  `packages/git/src/store/trees/commits-staging.ts`,
  `tests/operation-state.test.ts`, `tests/pack-projection-publication.test.ts`,
  `bench/statements.ts`.

### WU4 — Bring an eight-step rebase under the target (effort M; 87)

- **Problem.** `rebase.transition-2n` costs 1,279 statements, ~184 per step,
  dominated by ~40 integration plan traversals per step since ADR-0024.
- **Verify first.** Produce a per-query histogram for one rebase step after
  WU3 lands, and name the consumer of each traversal. Do not change code until
  every traversal has a named reader and purpose.
- **Scope.** Collapse traversals that read the same plan for the same purpose.
  Hoist per-step work that does not depend on the step. Keep ADR-0024's
  contract: plans stay traversable and are not held in memory.
- **Acceptance / witness.** `bench:statements -- --check`: `rebase.transition-2n`
  reports `pass`; all three rebase rows' frozen baselines move down; rows read
  do not rise. `tests/e2e/rebase.test.ts`, `tests/replay.test.ts`, and
  `tests/local/git-parity.test.ts` stay green.
- **Touch points.** `packages/git/src/ops/rebase/`,
  `packages/git/src/ops/integration/`,
  `packages/git/src/store/operations/integration-workspace/`,
  `bench/statements.ts`.

### WU5 — Bring the Next.js clone under the target (effort M; 90)

- **Problem.** One 24,252-file clone costs 1,031 statements, 31 over target;
  the residue is ADR-0023 admission (six query shapes per page plus the scratch
  lifecycle) and ADR-0025's per-flush statement.
- **Verify first.** Per-query histogram of the clone at HEAD. Attribute the 31
  before choosing a change. Candidates from the backlog: share one page between
  the reverse and forward passes; hoist the scratch create/delete pair out of
  the per-clone path.
- **Scope.** The change the histogram justifies. Do not raise `GRAPH_PAGE`.
- **Acceptance / witness.** `npm run bench:nextjs`: `git.clone` reports `pass`
  with rows read ≤ 164,287; clone native oracles unchanged; every admission
  rejection witness green (`tests/pack-graph-admission.test.ts`,
  `tests/pack-cold-admission.test.ts`).
- **Touch points.** `packages/git/src/store/pack/graph/`,
  `packages/git/src/store/pack/ingest.ts`,
  `packages/git/src/store/schema/schema-pack-graph-statements.ts`,
  `bench/statements.ts` (the Next.js reference row).

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Statement cuts in shared store paths can lose rows silently | All five witnesses, `bench:statements -- --check`, `bench:nextjs`, typecheck, check, then `test:full` once | Any frozen row moves up; any native oracle changes |
| WU1 | Bench-only; no shipped code | Both harnesses produce a report; direct inspection, no independent review | The repair changes what the reachability scenario measures in a way its spec does not support |
| WU2 | Output-format change, small, parity-pinned | Parity witness v1 + v2 against `git`; direct inspection | The fix needs to touch `sortStatusDetails` or the budget preflight |
| WU3 | 88 is a proven pattern; 89 changes a trust contract | Boundary witnesses + publication tests; independent review of 89's reasoning | 89 finds a real coverage gap in the write path |
| WU4 | Touches every integration consumer's traversal | Rebase/replay/parity tests + statements gate; independent review, re-review semantic fixes until clean | Target unreachable without changing ADR-0024's contract |
| WU5 | Admission is a validation boundary | Admission rejection witnesses + Next.js gate; independent review | Reaching the target needs fewer validated objects, or a page-size change |

## Test cadence

- **Per WU.** `cpu-lease run -n 2 -- npx vitest run --maxWorkers=2 <files named
  by that WU>`. Statement gate: `cpu-lease run -n 2 -- npm run bench:statements
  -- --check`. The memory runner leases itself; do not nest it in a lease.
- **Routine integration.** `cpu-lease run -n 4 -- npm test` (target <30 s),
  then `npm run typecheck` and `npm run check` after each integrated WU.
  `npm run test:e2e` after WU2 and WU4.
- **Sprint closure.** `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run
  -n 4 -- npm run test:full` once, after review and fixes settle; then
  `bench:statements -- --check` and `bench:nextjs` for the final numbers.
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

1. WU1 and WU2 in parallel; disjoint files.
2. WU3 after WU1 (WU3 re-baselines `bench/statements.ts`).
3. WU4 after WU3, since 88 removes one statement per journal traversal and
   changes the rebase baseline.
4. WU5 is independent of WU3/WU4 in code but shares the baseline maps in `bench/statements.ts`; run it
   after WU3 to avoid baseline conflicts. WU4 and WU5 may run in parallel if
   baseline updates are committed one at a time.

## Plan review

- **Reviewer:** pending
- **Verdict:** pending
- **Material findings:** —

## Run log
