> **OUTCOME — shipped 2026-10-07.** The full-history `blob:none` clone of
> Next.js v15.5.2 dropped from 428.8 s / 31,881 statements / 4,918,725 rows
> returned (`eb89b3d`) to 197.0 s / 6,414 / 537,989 (`2d3bde0`): same harness,
> fresh persistence, one leased run each (`cpu-lease run -n 2 --no-smt`), exact
> HEAD, 24,252 files and a clean worktree verified. Native git on the same
> origin (`file://`, `--no-local`, same lease) takes 17.2–18.9 s, of which
> 6.5–8.0 s is metadata. A clean whole-tree `add` over a complete tracker now
> costs 11 statements / 9 rows on 5,000 files; the first add after an initial
> checkout writes no index rows. Commit map: WU1 → e72f6cc, WU3 → 98b0a48 and
> 7517f70, WU4 → 8b74380, WU2 → b6975d4, WU5 → 2d3bde0. Verification: every WU
> passed its witness and an independent review to clean; `npm run typecheck`,
> `npm run check`, `npm test` (160/160), `bench:statements -- --check` and
> `npm run test:full` (second run green after the 7517f70 test fix) pass.
> Backlog filed: 116, 117, 118. Deferred: proposal §6 duplicate work, native
> SHA-1 and Wasm (→ 118); WU3 temp B-tree memory is unmeasured (→ 118);
> WU5 narrowed to initial checkout by user decision.

# Sprint — full-history import and staging performance (2026-10-07)

**Goal.** Cut the measured SQL and row work of a full-history `blob:none` clone
and of `git add` on a large checkout, without changing stored data or Git
semantics.

**Theme.** The [measured proposal](../ideas/full-history-import-performance.md)
attributes ~76% of clone CPU to native SQL execution and cursor advancement.
These WUs remove repeated row work in the four regions it names: pack range
reads, tree projection writes, promise registration plus connectivity, and
staging. Success: each WU lands with byte/state parity and a measured drop in
its own region; the closure re-profile states the end-to-end result honestly.
Codec, native SHA-1 and Rust/Wasm work waits for that re-profile.

## Refs re-verified at HEAD `eb89b3d` (2026-10-07)

Paths are relative to `packages/git/src/` unless prefixed.

- ✔ `PackDataReader.readRangeBatch` joins and `substr`s one `git_pack_data` row
  per 256 KiB slice of every request — `store/pack/read/read-data.ts:151-261`
  (SQL at `:183-210`). It bypasses the pack row cache. It rejects a short
  fragment (`:241`); `readRaw` does not (`:279-292`), so `readRaw` is no oracle.
- ⚠ Its only caller is deferred-delta ingest — `store/pack/ingest/ingest-pending.ts:188`.
  Ordinary object reads already read whole chunks through the resolver
  (`store/pack/read/read-resolver.ts:264-298`). The proposal implied a wider
  reader; the change is ingest-only.
- ✔ Range requests are built for every pending row of a page, not only rows
  whose bases were admitted — `ingest-pending.ts:156-188`.
- ✔ Pack row cache: one database-wide `ByteLru`, at most 4 MiB
  (`MAX_PACK_ROW_CACHE_BYTES`), keyed by `cacheGeneration` —
  `store/database/database-state.ts:67`, `store/pack/shared.ts:76-77`,
  `read-data.ts:99-108`. The resolver already loads cache misses for many
  chunks in one statement — `store/pack/read/read-resolver.ts:262-298`.
- ✔ Range ceiling `PACK_RANGE_BATCH_BYTES` = 1 MiB, slice 256 KiB, max 4,096
  requests — `store/pack/shared.ts:80-82`, `read-data.ts:152,168`.
- ✔ Tree entry flush resolves `(repo_id, tree_oid)` per entry through 8–9
  `json_extract` calls — `store/trees/tree-index-batch.ts:170,264-273`.
- ⚠ Identity is resolved about four times per batch, not once: completed-source
  lookup `store/trees/tree-index.ts:29-38`, seed `tree-index-batch.ts:361-368`,
  entry join, marker upsert `tree-index-batch.ts:318-330`.
- ✔ A new 704 KiB + 192 KiB arena pair per `TreeIndexBatch` and a new batch per
  flush — `tree-index-batch.ts:12-13,140-141`, `tree-index.ts:141,149`,
  `store/pack/pack-ingest-index.ts:263`.
- ⚠ The "flat raw-tree copy" is `PackTreeIndex.addChunked` copying chunks for a
  delayed parse — `pack-ingest-index.ts:250-251`. `addBuffered` does not copy.
  Parse-while-live fits inside `PackTreeIndex`; nothing under `ingest/` or
  `read/` must change.
- ✔ Promise insert has no deduplication; both `NOT EXISTS` probes and
  `ON CONFLICT` run per tree edge — `store/fetch/promisor.ts:122-160`.
- ✔ Connectivity deduplicates trees (`UNION`) but returns one row per blob edge
  (`UNION ALL`); JS validates each row, re-batches and asks SQLite for presence,
  promises and types again — `store/trees/connectivity.ts:7-65`,
  `ops/network/network-connectivity.ts:20-121`.
- ✔ Hydration calls `missing(wants)`, then `typeAndSize` per blob —
  `ops/network/network-promisor.ts:107-117`. The batched `objectInfo`
  (≤4,096 OIDs) already exists — `store/objects/objects-query.ts:91`.
- ✔ `git add .` never consults the complete dirty tracker: the `""` spec makes
  `selectAddPaths` give up — `ops/staging/staging-add.ts:69,146-165,244`,
  `ops/staging/staging-selected.ts:29`.
- ✔ Candidate hashing refreshes from the root to each path —
  `ops/worktree/worktree-io-hash.ts:258-273`; an exact variant exists at `:195`.
- ✔ `SELECTED_EXACT_INDEX_SQL` joins `git_index` on `(checkout_id, path)` with
  `ORDER BY path, stage` — `do-fs/sparse/selection.ts:151-159`; the recursive
  variant at `:136-149` has the same shape. `CROSS JOIN` precedent:
  `store/trees/connectivity.ts:17`.
- ✔ Initial and ordinary checkout write `mtime`/`ino` NULL —
  `ops/checkout/initial-checkout.ts:66-74`, `ops/checkout/checkout-writes.ts:59-66`;
  `indexMatchesStat` fails on NULL — `worktree-io-hash.ts:348-349`. The DO
  initial-write session already knows inode, mtime and revision —
  `packages/do/src/fs/store/initial-write/initial-write-session.ts:58,326,344`.
- ⚠ Not in the proposal: refreshing those stat fields while the tracker is
  complete marks each row `WORKTREE_DIRTY` —
  `do-fs/indexes/index-tracker-triggers.ts:131-137`.
- ✔ Ordinary checkout writes through `GitDrive.writeFiles`, which returns
  `void` — `packages/drive/src/index.ts:198`, `ops/worktree/worktree.ts:10-36`.
  Implementations: `packages/do/src/fs/store/write.ts:163`,
  `packages/do/src/fs/compat/node-operations.ts:190`,
  `packages/do/src/fs/ops.ts:101,162`, `packages/local/src/drive/write.ts:179`,
  `packages/local/src/drive/disk-drive.ts:364`.
- ✔ Local `rev` changes on every observation and local `mtime` has millisecond
  resolution — `packages/local/src/drive/disk-drive.ts:187,212`,
  `packages/local/src/drive/read.ts:66,69`. `indexMatchesStat` has no racy-git
  guard (`worktree-io-hash.ts:348-353`).
- ✔ `add -f` bypasses the ignore filter — `ops/staging/staging-add.ts:183`;
  `add -A`/`-u` skip `selectAddPaths` — `staging-add.ts:120-124`.
- ✔ Tree entry insert filters `s.complete = 0` (duplicate skipping) and the
  entry FK is `DEFERRABLE INITIALLY DEFERRED` —
  `tree-index-batch.ts:269-273`, `store/schema/schema-tree-statements.ts:38-40`.
  `TreeIndexBatch` serves four caller modes, including loose
  `requireSeededSources` — `tree-index.ts:55,141,149,162`.
- ✔ `objectInfo` counts only `complete` packs (`store/objects/objects-query.ts:133-135`);
  a tree source survives while any pack entry exists
  (`schema-tree-statements.ts:59-68`).
- ✔ `bench:statements -- --check` fails on any statement rise and only notes
  a drop — `bench/CLAUDE.md`, baselines in `bench/statements.ts:~260-316`.

## Work units

### WU1 — Read each physical pack chunk once for deferred deltas (M)

- **Problem.** `readRangeBatch` loads the same 1 MiB row once per requested
  slice (`read-data.ts:183-210`); the CPU profile attributes 151 s inclusive to
  it. Ranges are also fetched for rows whose bases were not admitted
  (`ingest-pending.ts:171-188`).
- **Verify first.** Record statements and native rows read of the three range
  tests in `tests/pack.test.ts:1723,1772,1814` before the change.
- **Scope.**
  1. Group requested ranges by physical `seq`; take hits from the existing
     pack row cache (`getCachedChunk`/`cacheChunk`) and load all misses of the
     batch in **one** statement, reusing the resolver's batched miss loader
     (extracting it into a shared helper is allowed and is not an escalation).
     Scatter slices into the caller's bounded output. No second cache.
  2. Keep the 1 MiB output ceiling, 4,096-request cap, fragment completeness
     check and `CorruptError` on a short, truncated or missing chunk.
  3. Request ranges only for rows whose bases were admitted.
- **Acceptance / witness.** New `tests/pack-range-read.test.ts`: cross-chunk
  ranges, ranges sharing a chunk, a range ending exactly on a chunk boundary,
  a missing chunk and a truncated chunk (both `CorruptError`), output bytes
  equal to the source pack bytes written by real `git`; a statement/row
  assertion of at most one range statement per batch and each chunk read at
  most once. Existing range tests in `tests/pack.test.ts` are updated to assert
  the new cost, not deleted. `tests/pack.test.ts`,
  `tests/pack-read-lifetime.test.ts`, `tests/pack-physical-membership.test.ts`
  pass. Measured: `git.clone` statements and rows read in `bench:statements`
  do not rise; rows read for the deferred-delta range test drops.
- **Touch points.** `store/pack/read/read-data.ts`,
  `store/pack/read/read-resolver.ts` (loader extraction only),
  `store/pack/read.ts`, `store/pack/ingest/ingest-pending.ts`,
  `store/pack/shared.ts`, `store/pack/shared-delta.ts`; tests above.

### WU2 — Resolve tree source identity once per batch (L)

- **Problem.** Projection writes serialize repository/tree identity into every
  entry and resolve it again in four statements; arenas and parsers are
  reallocated per flush; `addChunked` copies tree bytes for a delayed parse.
  98 s inclusive in the profile.
- **Verify first.** Run `tests/tree-index-stream.test.ts` and record its
  `ObservedDatabase` counters as the before state.
- **Scope.**
  1. Seed/select `source_key`s once per batch; carry the integer key into entry
     and marker rows; drop per-entry repository/OID JSON fields. The entry
     insert keeps joining `git_tree_sources` on `source_key` **and**
     `complete = 0`, so duplicate skipping still happens in SQL and a stale key
     fails immediately rather than at the deferred FK check on COMMIT.
  2. Keep all duplicate-tree skipping, malformed-tree rejection, oversize
     handling and the seeded-loose-source requirement in all four
     `TreeIndexBatch` caller modes.
  3. Reuse the entry and marker arenas across batches with a fixed size. One
     named owner holds them (the `PackTreeIndex` for pack ingest, the batch
     itself for loose callers); disposal is defined for every mode.
  4. Parse chunked trees in `PackTreeIndex` while their bytes are live; keep
     database writes after `objects.flush()`.
  5. Before choosing between JSON and another binding encoding, measure binding
     cost versus insert cost and record it in the run log.
- **Acceptance / witness.** `tests/tree-index-stream.test.ts` keeps every
  semantic case; its SQL-text counters are rewritten to the new statement
  shape with a lower lookup count. New `tests/tree-projection-parity.test.ts`:
  for a pinned real-git fixture with duplicate, nested, gitlink and
  >2,048-entry trees, every projected tree's entries equal `git ls-tree -z`
  output, through both pack ingest and loose writes. `tests/pack.test.ts`,
  `tests/pack-projection-publication.test.ts`, `tests/schema.test.ts` pass.
  No schema change. Measured: `git.clone` statements and rows read do not
  rise; the tree test's exact-source lookup count drops.
- **Touch points.** `store/trees/tree-index-batch.ts`,
  `store/trees/tree-index.ts`, new files under `store/trees/` if the 500-line
  cap needs a split, `store/pack/pack-ingest-index.ts` (`PackTreeIndex` only);
  tests above.

### WU3 — Set-based promises, failures-only connectivity, batched hydration (L)

- **Problem.** Promise insert probes availability per tree edge (39 s,
  4 statements). Connectivity exports 3.36 M successful rows and re-asks SQLite
  about them (55.8 s, 35 M native rows read). Hydration issues one `typeAndSize`
  per blob (~19,585 statements, ~0.44 s).
- **Verify first.** `EXPLAIN QUERY PLAN` of the promise insert and the
  connectivity SELECT on a fixture; confirm where the probes sit.
- **Scope.**
  1. Promise insert: materialize distinct candidate blob OIDs first, then run
     availability probes and insert. Confirm with the plan and native rows read
     that probes run per distinct OID.
  2. Connectivity: deduplicate tree and blob identities; join loose objects,
     complete packs and permitted promises inside SQLite; return only failure
     rows, bounded. Existence means a loose object or an entry in a `complete`
     pack, as in `objectInfo`; `git_tree_sources.complete = 1` alone is not
     proof. Preserve missing parent/tree/blob, wrong type, shallow boundary,
     gitlink exclusion, promises exempting blobs only, annotated tag peeling,
     and the current error codes (`EFETCHFAIL`, `CorruptError`).
  3. Hydration: replace `missing` + per-blob `typeAndSize` with paged
     `objectInfo` or an equivalent existing batched API.
- **Acceptance / witness.** `tests/network-integrity.test.ts`,
  `tests/promisor-store.test.ts`, `tests/clone.test.ts`,
  `tests/fetch-refspec.test.ts` pass unchanged. New
  `tests/network-connectivity.test.ts` adds the uncovered cases: wrong-type
  connectivity failure, hydration of a non-blob want, a hydration response
  missing a want, a tree present only in an incomplete pack, a promised OID
  that is physically a tree, one blob shared by many trees (statement/row
  assertion that probes do not scale with edges). Measured: `git.clone`
  statements and rows read do not rise; `cpu-lease`-run `npm run bench:memory`
  stays within its target, because blob deduplication builds a temp B-tree.
- **Touch points.** `store/fetch/promisor.ts`, `store/trees/connectivity.ts`,
  `store/trees/commits-graph.ts` (only if commit roots join the query),
  `ops/network/network-connectivity.ts`, `ops/network/network-promisor.ts`;
  tests above.

### WU4 — Tracker-driven `git add` and exact candidate hashing (M)

- **Problem.** `git add .` scans the whole index and filesystem even when the
  complete tracker proves the tree clean; candidate hashing scans from the root;
  the exact selected-index query reads 48,505 rows to return one.
- **Verify first.** `EXPLAIN QUERY PLAN` of `SELECTED_EXACT_INDEX_SQL` under
  `node:sqlite`; confirm the `checkout_id`-only lookup and that `CROSS JOIN`
  selects the full key.
- **Scope.**
  1. Exact selected-index queries use the full `(checkout_id, path)` key.
  2. Candidate hashing uses exact paths, not a root-to-path scan.
  3. When the tracker is complete, a whole-tree add (`add .`, `add -A`,
     `add -u`) takes candidates from the dirty rows plus the baseline-to-HEAD
     diff, as sparse status does; otherwise the current full scan runs.
     `add -f` with a whole-tree spec always takes the full scan: ignored files
     that existed at reseal have no dirty row. Never reseal the tracker from a
     partial selection.
- **Acceptance / witness.** `tests/staging.test.ts`,
  `tests/index-tracker.test.ts`, `tests/status-sparse.test.ts`,
  `tests/sparse-workspace.test.ts` pass. New `tests/staging-tracker.test.ts`,
  built on `tests/helpers/e2e.ts` journeys (parity against the `git` binary),
  run with the tracker on and off (`initializeIndexTracker`,
  `resealIndexTracker` from the test helpers): deletions, conflicts, partially
  staged files, `rm --cached` then add, ignored untracked, `add -f .` with the
  ignored file created **before** the reseal, `-A` and `-u`, directory
  replaced by file and back, dirty paths outside a selection, invalid tracker
  fallback. A cost assertion that a clean whole-tree add over a complete
  tracker, after the index already holds stat data (second add), reads rows
  proportional to candidates.
- **Touch points.** `ops/staging/*`, `ops/worktree/worktree-io-hash.ts`,
  `do-fs/sparse/selection.ts`, `do-fs/indexes/index-tracker.ts` (read side);
  tests above. The new bench row is added by the leader. A change to
  `store/core/contracts.ts` or `ops/core/context.ts` is a seam change: report
  `blocked`.

### WU5 — Record stat data at initial checkout (S)

- **Problem.** Initial checkout writes NULL `mtime`/`ino`, so the first add
  after a clone refreshes all 24,252 index rows and, with a complete tracker,
  marks them dirty.
- **Verify first.** Count rows written by the first `git add .` after an
  initial checkout in `tests/checkout-initial.test.ts` setup.
- **Scope.** The DO initial-write session returns the written inode, mtime and
  revision for each file and symlink; initial checkout stores them in
  `git_index`. Ordinary checkout and `GitDrive.writeFiles` are unchanged
  (user decision, 2026-10-07): they keep NULL and rehash only the files they
  wrote. The session must return exactly what the drive's `stat` later
  reports; the DO session is the only implementation.
- **Acceptance / witness.** New `tests/checkout-stat.test.ts`, run with the
  tracker incomplete (otherwise WU4 already makes the add cheap): after an
  initial DO checkout, a clean `git add .` rehashes nothing and writes no index
  rows; a same-size edit within the same timestamp tick is still reported by
  status through `rev`. `tests/checkout-initial.test.ts`,
  `tests/clone-initial.test.ts`, `tests/status.test.ts`,
  `tests/fs/initial-write.test.ts`, `tests/workspace.test.ts` pass;
  `npm run test:fs`.
- **Touch points.** `ops/core/context.ts` (`InitialWorktreeSession` return
  types; WU5 runs alone, so it owns this seam), `ops/checkout/initial-checkout.ts`,
  `packages/do/src/fs/store/initial-write/*`, `packages/do/src/fs/store/initial-write.ts`,
  `packages/do/src/runtime/workspace.ts` (only if the writer wiring needs it);
  tests above.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Clone pipeline and staging are core paths; WUs share no files | After each WU: `npm run typecheck`, `npm run check`, `npm test`, `cpu-lease run -n 4 -- npm run bench:statements -- --check`. Closure: `npm run test:full`, full-history re-profile | Any statement or rows-read rise; any parity failure |
| WU1 | Fundamental: every deferred delta reads through it; byte corruption is silent | Witness above; independent review of the frozen diff; fixes re-reviewed until clean | Change to resolver behaviour beyond extracting the miss loader, or to the cache key scheme |
| WU2 | Fundamental: projections are trusted at read (ADR-0004); a wrong row is undetected corruption | Witness above; independent review; re-review until clean | Schema change needed; loose-object path behaviour changes |
| WU3 | Fundamental: connectivity is the fetch integrity check | Witness above; independent review; re-review until clean | Any accepted graph that the current code rejects |
| WU4 | Normal-high: staging semantics, tracker sealing | Witness above with git parity; independent review; one fix round then re-review | Seam change in `contracts.ts`/`context.ts`; tracker reseal path changes |
| WU5 | Normal-high: a wrong stat hides edits | Witness above; independent review; re-review after fixes | Any change to `indexMatchesStat`, `GitDrive`, or local stat semantics |

## Test cadence

- **Per WU.** Run the exact witness files with `npx vitest run <files>`. Add
  `npm run test:fs` for WU5 only.
- **Routine integration.** `npm test` after each WU lands; keep it below 30 s.
- **Sprint closure.** `cpu-lease run -n 4 -- npm run test:full` once after the
  last review settles.
- **Failure loop.** Reproduce a full-suite failure with its file; rerun the
  full suite only after the focused witness is stable.
- **Measurement.** Closure re-profile of the full Next.js history in fresh
  persistence under `cpu-lease run -n 2 --no-smt`, same harness and boundary as
  the proposal. The interactive demo state under `examples/playground/.state/`
  is not touched.

## Out of scope (explicit)

- Proposal §6 duplicate work: commit rehash in `PackCommitIndex`, delta header
  re-inflation, chunk pool churn, initial-checkout window replanning, real
  large-object streams, DO writer copies. Deferred until the re-profile ranks
  them; they overlap WU1/WU2 territory.
- Native SHA-1, codec replacement and Rust/Wasm: decided after the re-profile.
- Lazy historical projections: an architectural change, not proposed here.
- Memory reduction under a fixed cap: [backlog 106](../backlog/106-reduce-the-workerd-clone-external-memory.md).
- Merge-base/divergence paths that still parse full graphs.

## Decisions

- Two implementation agents at a time in one tree; disjoint territories; each
  WU committed by the leader after its gate passes (user, 2026-10-07).
- `pack-ingest-index.ts` belongs to WU2 only; WU1 does not touch it.
- No schema change in this sprint. A WU that needs one reports `blocked`.
- The leader owns `bench/statements.ts`: new rows and downward rebaselines go
  in each WU's commit, so stale baselines cannot hide a later rise.
- WU5 covers initial checkout only; ordinary checkout and the local drive keep
  NULL stat data (user decision, 2026-10-07).

## Sequencing

| Wave | WUs | Why |
|---|---|---|
| 1 | WU1 ∥ WU3 | Largest measured regions; disjoint files |
| 2 | WU2 ∥ WU4 | WU2 after WU1 lands in `store/pack/`; WU4 independent |
| 3 | WU5 | Runs alone and owns the `InitialWorktreeSession` seam |
| Closure | re-profile, `test:full`, archive | — |

## Plan review

- **Reviewer:** independent Claude agent (general-purpose), not the author. A
  Codex review was attempted twice and produced no output.
- **Verdict:** blocked, then **approved** on re-review of this revision
  (2026-10-07). Re-review added the remaining `writeFiles` implementers to WU5.
- **Material findings:**
  1. WU5 named the wrong seam; `GitDrive.writeFiles` returns `void` across
     drive/do/local → seam and territory corrected.
  2. Local stat semantics (counter `rev`, ms mtime, no racy-git guard) → local
     keeps NULL; same-tick same-size edit witness added.
  3. WU1 per-chunk reads would raise statements; `bench/statements.ts` was a
     shared write → one batched miss load; leader owns baselines.
  4. Tracker-driven `add -f .` would miss pre-existing ignored files → forced
     whole-tree add keeps the full scan; witness added.
  - Non-blocking, adopted: `readRaw` is no oracle (truncated chunk case);
    WU2 keeps `complete = 0` join and covers all four modes against
    `git ls-tree`; WU3 existence requires a complete pack, plus two new
    cases and a `bench:memory` check; WU4 uses `e2e.ts`, covers `-A`/`-u`,
    measures from a second add; WU5 witness runs with the tracker incomplete;
    per-WU measured figures named.

## Run log

- WU3: the plan wrongly required `tests/network-integrity.test.ts` to pass
  unchanged; three tests assert the old per-edge `objectInfo` export. Leader
  decision: rewrite only those cost-shape assertions (and the shared-tree
  expansion test) to the new shape; every acceptance/rejection test stays
  byte-identical.
- WU3: the HEAD connectivity blob branch plans as
  `SCAN entry USING INDEX git_tree_entries_by_name_bytes` — a whole-repository
  entry scan, a likely main source of the 35 M native rows read.
- WU3: connectivity now ranks failures globally (sourceless tree → commit →
  missing → wrong type) instead of by HEAD's 4,096-object flush order. A graph
  with several different failures can report another code than HEAD; every
  graph HEAD rejects is still rejected (independent review, clean).
- WU3 follow-up: the commit branch of the connectivity CTE plans `SCAN c` over
  all of `git_commits` per hop and root page, at HEAD and after WU3. Candidate
  fix: drive it from `reachable` with `CROSS JOIN`. Verify on the bench fixture.
- Wave 1 gate (WU1 + WU3 together in the tree): `npm run typecheck`,
  `npm run check`, `npm test` (160/160), `cpu-lease run -n 4 -- npm run
  bench:statements -- --check` pass. `transport.fetch` dropped 77 → 73
  statements and 63 → 53 rows read; rebaselined in the WU3 commit (measured
  with both units present). `npm run bench:memory` passes, but none of its
  scenarios runs connectivity over a large history, so WU3's temp B-tree memory
  is unmeasured until the closure re-profile. The `nextjs:git.clone` row reads
  a stale 2026-09-24 result and is report-only.
- WU1: `runnableRows` returning `[]` for a page with no ready row has no test;
  it is a cost skip only (independent review accepted).
- WU2 first round: pack ingest 328 → 210 statements on a 683-tree fixture,
  but loose tree writes rose +1 statement per flush (separate key read);
  `bench:statements --check` failed on commit/merge/replay/rebase rows
  (e.g. rebase.transition-2n 1055 → 1063). Sent back: zero rise on the loose
  path. Binding vs insert per 2,048-row window: old JSON objects + OID join
  12.4–15.0 ms; JSON arrays + key 8.2–8.8 ms; fixed-width records 5.0–5.4 ms
  (not adopted; codebase convention is `json_each`).
- WU4: one shared sparse candidate collector now serves status, diff and
  tracker-driven add (`ops/worktree/sparse-candidates.ts`). Pre-existing,
  unchanged: `add -u` restricts to paths in HEAD, not the index (git stages a
  newly added then modified file; kompjutr does not) → backlog at closure.
- WU4 gate: independent review clean, verified on an isolated HEAD + WU4 copy
  where `bench:statements --check` passed. staging.add 17/26 → 16/23,
  staging.add-selected 24/33 → 23/28 (rebaselined); new row
  `staging.add-tracker` (5,000 files, clean second add) 11 statements / 9 rows.
  Witness 304/304. Pre-existing gap found: porcelain v2 shows a pending type
  change (file ↔ symlink) as `M` where git shows `T` → backlog at closure.
- WU2 deviation from scope item 1: instead of carrying integer `source_key`s,
  the entry statement resolves `(repo_id, tree_oid, complete = 0)` once per
  tree per 2,048-row window in a `MATERIALIZED` CTE (`CROSS JOIN`). Carrying
  keys needed a separate key read, which raised every loose tree write by one
  statement (first round). Second round: loose 600/600 and 326/326 statements
  unchanged; pack ingest of 683 trees ~326 → 202; `bench:statements --check`
  passes (independent review). workerd bundles SQLite 3.47.0.
- Closure `test:full` (4,677 passed in other batches): one failure,
  `tests/objects-query-growth.test.ts` "keeps unchanged legacy fetch metadata
  pages selective…" — passes at eb89b3d, fails at HEAD. It counted objectInfo
  pages over blobs that WU3 now checks inside the connectivity SQL; WU3's
  witness set missed this file. Fix: assert selectivity of the new path.
- Closure re-profile (fresh persistence, same harness for both sides, one run
  each, `cpu-lease run -n 2 --no-smt`, host wall time; exact HEAD, 24,252
  files, clean worktree checked): eb89b3d 428.8 s / 31,881 statements /
  4,918,725 rows returned → 2d3bde0 197.0 s / 6,414 / 537,989.
