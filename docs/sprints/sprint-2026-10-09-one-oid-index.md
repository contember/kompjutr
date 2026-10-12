# Sprint — One OID index for pack objects (2026-10-09)

**Goal.** Pack ingest writes each object once, to `git_pack_entries`, and every
reader derives the canonical copy from it
([ADR-0031](../decisions/0031-derive-the-canonical-pack-copy-from-pack-entries.md),
proposed).

**Theme.** The full-history `blob:none` Next.js clone spends 12.5–14.2 s of
58.8–64.4 s busy CPU on pack-row inserts and 1.4–1.9 s on the publication audit
(CDP, `c373b41`, six leased runs). Half of the insert work and all of the audit
belong to `git_pack_objects`. The sprint succeeds when that table is gone, the
clone is measurably faster, and no read, deletion or sweep changes its answer.

## Refs re-verified at HEAD (2026-10-09)

- ✔ Ingest inserts both tables from one JSON batch in one transaction, entries
  first, then `INSERT OR IGNORE INTO git_pack_objects` —
  `packages/git/src/store/pack/pack-ingest-index.ts:104-136`.
- ✔ Schema: `git_pack_objects` is a rowid table with `PRIMARY KEY (repo_id, oid)`
  and the `git_pack_objects_loc` index; `git_pack_entries` is `WITHOUT ROWID`
  with `PRIMARY KEY (repo_id, pack_id, offset)` and
  `git_pack_entries_by_oid (repo_id, oid, pack_id, offset)`, which does not
  cover `type` or `size` —
  `packages/git/src/store/schema/schema-object-statements.ts:126-171`.
- ✔ Publication audit: per entry of the publishing pack, a canonical row in a
  complete pack, else `ESTALE` —
  `packages/git/src/store/pack/lifecycle/lifecycle-ingest.ts:238-259`, called
  inside the publish transaction at `packages/git/src/store/pack/ingest.ts:153`.
- ✔ Deletion promotes the earliest complete copy (lowest `pack_id`, then
  `offset`) outside the deleting set, and bumps the source generation when the
  deleted packs owned a visible canonical row or anything was promoted —
  `packages/git/src/store/pack/lifecycle/lifecycle-delete.ts:58-140`.
- ✔ Only one ordinary ingest holds the lease; a reservation reclaims expired
  pending packs before allocating the next monotonic id —
  `lifecycle-ingest.ts:56-205`. So the first claimer is always the lowest
  `pack_id`, the same order as promotion.
- ✔ The audit's only witnessed purpose is the orphan case: a pending pack's
  duplicate copy loses the claim, the complete owner is deleted meanwhile, and
  publication fails with `ESTALE` — `tests/concurrency-pack.test.ts:367-402`.
- ✔ The pack-graph start already picks a pending pack's own lowest-offset copy
  and otherwise the canonical row —
  `packages/git/src/store/pack/read/read-graph-sql.ts:11-34`.
- ✔ The pack sweep counts a pack as marked only through its canonical rows,
  in the page query and the finish assertion; `git_blob_ids` deletion also
  uses canonical membership —
  `packages/git/src/store/maintenance/sweep/sweep-packs.ts:16-23,104-119,121-135`.
- ✔ 30 SQL statements in 19 TypeScript files (schema included) reference
  `git_pack_objects`, `git_pack_objects_loc` or `git_pack_entries_by_oid`; the
  inventory below lists 35 sites: 32 runtime reference sites (the promotion
  statement references the table twice) and 3 DDL statements. Five reads `LEFT JOIN` the table and rely on at
  most one row per OID: four throw `CorruptError` on a second row
  (`objects-query.ts:132`, `objects-read.ts:69`, `root-advance.ts:152`,
  `reachability-publish.ts:67`), and `reachability-headers.ts:143` can read a
  pending copy as missing. `completePackedEntry`
  (`lifecycle-membership.ts:23`) uses an inner `JOIN` with `LIMIT 2` and
  throws on a second row.
- ✔ `stageCommitCaches` already names `INDEXED BY git_pack_entries_by_oid` —
  `packages/git/src/store/trees/commits-staging.ts:23`.
- ✔ The schema is checked by exact definition text and has no migrations
  (`schema/schema.ts:168`, `SCHEMA_VERSION = 1`). The project has no
  production users, so the DDL changes in place.
- ⚠ `docs/reference/concurrency.md:275` describes maintenance-owned packs with
  a canonical stale-reject. `packages/git/src/store/CLAUDE.md` says maintenance
  owns no pack, and no code path creates one. The row is stale; WU4 rewrites it.
- ✔ A forward REF delta can precede a full copy of the same OID in one pack.
  The full copy is indexed in the first pass (`pack/ingest/ingest-index.ts:118`)
  and claims the row; the delta is indexed later (`ingest-index.ts:235`). The
  stored canonical offset is then the higher one, the derived offset the lower.
- ✔ `ExpectedPackMembership` already enforces exactly-once indexing of every
  parsed entry (`pack/shared.ts:236`).
- ✔ `PackReadEngine.oids` materialises every packed OID with `db.all()`
  (`pack/read.ts:130`); only tests call it.
- ⚠ Planner trap, measured on the clone database (`node:sqlite`, leased): the
  derived type-and-size lookup with `ORDER BY pack_id, offset LIMIT 1` plans as
  `SEARCH c USING PRIMARY KEY (repo_id=?)` and takes 16 ms per OID, against
  12 µs today. With `INDEXED BY git_pack_entries_by_oid` it takes 12–14 µs.

### Measured read cost of the derived shapes

Clone database at `c373b41` (357,637 objects, one large pack), 100,000 random
OIDs in 2,048-OID batches, three rounds:

| Statement shape | Today, ms | Derived, ms |
| --- | ---: | ---: |
| `readObjects` metadata batch | 647–719 | 794–798 |
| pack-graph start | 509–572 | 421–422 |
| `typeAndSize`, 20,000 single lookups, `INDEXED BY` | 205–238 | 232–278 |

### Statement inventory

`E` = existence or metadata (any complete copy answers; type and size come from
the canonical copy). `C` = needs the canonical copy. `W` = write. Lines are at
HEAD under `packages/git/src/store/`.

| # | Site | Class | WU |
| --- | --- | --- | --- |
| 1 | `pack/read.ts:57` `lookup` | C | 1 |
| 2 | `pack/read.ts:85` `typeAndSize` | E, returns canonical type and size | 1 |
| 3 | `pack/read.ts:100` `count` | E, `DISTINCT` | 1 |
| 4 | `pack/read.ts:114` `findPrefix` | E, `DISTINCT` (prefix ambiguity) | 1 |
| 5 | `pack/read.ts:133` `oids` | E, `DISTINCT` | 1 |
| 6 | `pack/lifecycle/lifecycle-membership.ts:23` `completePackedEntry` | C | 1 |
| 14 | `objects/objects-query.ts:53` `hasAllObjects` | E | 1 |
| 15 | `objects/objects-query.ts:132` `objectInfo` | E, one row per OID | 1 |
| 16 | `objects/objects-read.ts:69` `readObjects` metadata | E, one row per OID | 1 |
| 17 | `objects/objects-batch.ts:144` `flushObjects` | E | 1 |
| 18 | `trees/commits-cache.ts:276` `insertCommitCacheJson` | E (type, size) | 1 |
| 23 | `pack/read/read-graph-sql.ts:25` pack-graph start | C | 1 |
| 29 | `pack/ingest/ingest-references-external.ts:50` `readStoredObjects` | E, returns canonical type (`requireType`, :93) | 1 |
| 19 | `trees/commits-staging.ts:23` `stageCommitCaches`, `INDEXED BY git_pack_entries_by_oid` | pending-pack membership; keeps the index | — |
| 30–32 | `fetch/promisor.ts:105,143,201` | E | 1 |
| 20, 21 | `maintenance/sweep/sweep-loose.ts:114,127` | E | 2 |
| 22, 25 | `maintenance/sweep/sweep-packs.ts:19,130` marked holder | C | 2 |
| 24 | `maintenance/sweep/sweep-packs.ts:108` `git_blob_ids` | C | 2 |
| 26 | `maintenance/roots/root-advance.ts:152` | E, one row per OID | 2 |
| 27 | `maintenance/reachability/reachability-publish.ts:67` | E, one row per OID | 2 |
| 28 | `maintenance/reachability/reachability-headers.ts:143` | E, complete only | 2 |
| 7 | `pack/pack-ingest-index.ts:122` claim insert | W | 3 |
| 8 | `pack/lifecycle/lifecycle-ingest.ts:247` audit | C | 3 |
| 9–11 | `pack/lifecycle/lifecycle-delete.ts:77,94,107` ownership probe, promotion | C, W | 3 |
| 12, 13 | `pack/lifecycle/lifecycle-delete.ts:147,184` commit cleanup, table delete | C, W | 3 |
| S1–S3 | `schema/schema-object-statements.ts:126,142,170` | DDL | 3 |

Tests and benches that read or seed `git_pack_objects` directly: 17 test files
(including `tests/helpers/pack-store.ts:32`, `tests/commit-cache.test.ts:500`
and `tests/maintenance-reachability.test.ts:736`), `bench/oid-encoding.ts`,
`bench/clone-storage.ts` and `bench/statements.ts`. Each fixture changes in the
WU that switches its consumer; until WU3 a fixture seeds both tables
consistently (same state, type and size).

## Work units

### WU1 — Read the canonical copy from pack entries (L)

- **Problem.** Every object read, connectivity check and loose write asks
  `git_pack_objects` (inventory rows 1–6, 14–18, 23, 29–32).
- **Verify first.**
  - Write the shared canonical fragment and run `EXPLAIN QUERY PLAN` for each
    rewritten statement on a full-history clone database. Every OID seek uses
    `git_pack_entries_by_oid`; none plans `SEARCH ... USING PRIMARY KEY
    (repo_id=?)` or a scan of `git_pack_entries`.
- **Scope.**
  - One module in `pack/` owns the canonical rule: the complete copy with the
    lowest `(pack_id, offset)`. It exports the SQL fragments the reads embed;
    no call site restates the rule.
  - Rows 1, 6 and 23 select that copy. Row 6 keeps its single-row contract
    and drops the uniqueness throw. Row 23 keeps the pending pack's own
    lowest-offset start (`read-graph-sql.ts:13`) unchanged.
  - Metadata rows return the canonical copy's type and size and keep their
    return and error contracts: 2 (`typeAndSize`), 18 (type and size match),
    29 (`requireType` rejects a wrong-type reference), and 15 and 16 (exactly
    one row per requested OID).
  - Rows 3–5 count and list distinct OIDs. Row 4 still finds every matching
    OID within its limit, so a prefix shared by two OIDs stays ambiguous when
    one of them has several copies. Row 5 iterates with `db.iterate()`.
  - Pure existence rows (14, 17, 30–32) use `EXISTS` over complete entries.
  - `git_pack_objects` is still written and promoted in this WU. The derived
    rule picks the same pack as the stored row, so object bytes and pack
    ownership do not change. It intentionally changes the offset of an in-pack
    duplicate (the forward REF delta above); a test that asserts that offset
    changes in this WU.
  - Fixtures whose consumer changes here seed `git_pack_entries` as well:
    `tests/commit-cache.test.ts:500` (row 18),
    `tests/maintenance-reachability.test.ts:736` (row 6 via
    `completePackedEntry`, :743), and any other seeding of
    `git_pack_objects` read by rows 1–6, 14–18, 23 or 29–32. A later mutation
    in the same test (for example the size change at
    `tests/commit-cache.test.ts:521`) updates both tables.
- **Acceptance / witness.**
  - New `tests/pack-canonical.test.ts`:
    - two complete packs hold one OID: `lookup`, `completePackedEntry`,
      `typeAndSize`, `objectInfo`, `readObjects`, `count`, `oids` and the
      pack-graph start each return one row from the lower pack;
    - one pack holds an OID twice, as a forward REF delta before a full copy:
      `lookup().offset` and the graph start name the lower offset, and a cold
      read with caches disabled returns the object;
    - two distinct OIDs share a prefix and the first has copies in two packs:
      `findPrefix` with the production limit still returns both OIDs;
    - a pending pack's copy is invisible to every row above, and a pending
      pack's own read still starts at its own entry;
    - query-plan assertions for rows 2, 15, 16 and 23 in the style of
      `tests/pack.test.ts:2063-2074`.
  - `npx vitest run tests/pack.test.ts tests/reads.test.ts
    tests/objects-query-growth.test.ts tests/concurrency-pack.test.ts
    tests/promisor-store.test.ts tests/commit-cache.test.ts
    tests/pack-cold-admission.test.ts tests/fetch-pack-connectivity.test.ts
    tests/pack-canonical.test.ts tests/maintenance-reachability.test.ts`.
  - `cpu-lease run -n 4 -- npm run bench:statements -- --check`: no statement
    rise.
- **Touch points.** `pack/read.ts`, `pack/read/read-graph-sql.ts`,
  `pack/lifecycle/lifecycle-membership.ts`, `objects/objects-{query,read,batch}.ts`,
  `trees/commits-cache.ts`, `pack/ingest/ingest-references-external.ts`,
  `fetch/promisor.ts`, a new canonical-rule module under `pack/`.

### WU2 — Maintenance reads use the same rule (M)

- **Problem.** Roots, reachability and the loose and pack sweeps read
  `git_pack_objects` (rows 20–22, 24–28). Rows 22, 24 and 25 decide what
  maintenance reclaims.
- **Verify first.**
  - List the maintenance tests that create a duplicate pack:
    `grep -n "deleteCompletePacks\|duplicate" tests/maintenance-*.test.ts`.
- **Scope.**
  - Rows 22 and 25 count a pack as marked only when it holds the canonical
    copy of a marked OID, through the WU1 fragment. Both use one shared
    expression, so the page query and the finish assertion cannot disagree.
  - Row 24 deletes `git_blob_ids` only for OIDs whose canonical copy is in the
    swept pack, as today.
  - Rows 26–28 return one row per OID from complete copies only.
  - Fixtures whose consumer changes here, and that WU1 did not already
    convert, seed `git_pack_entries` as well.
- **Acceptance / witness.**
  - New cases in `tests/maintenance-sweep.test.ts`:
    - a reachable OID has copies in an earlier and a later pack, and the later
      pack holds nothing else: the later pack is swept, the earlier stays, and
      the object stays readable (an "any marked copy" rule keeps both);
    - deleting the earlier pack moves canonical ownership, and the later pack
      becomes marked in the next run;
    - `git_blob_ids`: sweeping a redundant pack keeps the mappings; sweeping
      the canonical holder removes its mappings even when a fallback copy
      survives; a loose copy keeps the mapping.
  - `npx vitest run tests/maintenance-sweep.test.ts
    tests/maintenance-sweep-continuation.test.ts
    tests/maintenance-reachability.test.ts tests/maintenance-qualification.test.ts
    tests/maintenance-cost.test.ts tests/concurrency-maintenance.test.ts`.
- **Touch points.** `maintenance/sweep/sweep-{packs,loose}.ts`,
  `maintenance/roots/root-advance.ts`,
  `maintenance/reachability/reachability-{publish,headers}.ts`.

### WU3 — Stop writing the canonical table (L)

- **Problem.** Ingest, publication and deletion still write and audit
  `git_pack_objects` (rows 7–13), and the schema still creates it.
- **Verify first.**
  - After WU1 and WU2, `grep -rn "git_pack_objects" packages/*/src
    --include=*.ts` lists only rows 7–13 and the DDL.
- **Scope.**
  - `PackObjectBatch.flush` inserts only `git_pack_entries`.
  - The audit becomes one count of the pack's entries against the parsed
    count, by primary-key prefix.
  - Deletion drops `#ownsVisibleCanonicalRows` and `#promoteFallbacks`, and
    bumps the source generation when any deleted pack was complete. The commit
    cleanup (row 12) deletes a `git_commits` row only when no complete copy
    survives outside the deleting set and no loose copy exists.
  - Remove `git_pack_objects`, `git_pack_objects_loc` and their comment from
    the schema. Remove the remaining fixture seeding, and update
    `tests/schema.test.ts`, the test helpers and the benches that read the
    table.
  - `tests/concurrency-pack.test.ts:367-402` changes its expectation: the
    pending pack publishes, and both objects read back without a retry.
- **Acceptance / witness.**
  - `grep -rn "git_pack_objects" packages/*/src tests bench --include=*.ts`
    finds nothing. Documentation is checked in WU4, after its update.
  - `tests/concurrency-pack.test.ts`, `tests/pack.test.ts`,
    `tests/pack-physical-membership.test.ts`, `tests/pack-cold-admission.test.ts`,
    `tests/concurrency-maintenance.test.ts`, `tests/schema.test.ts` and the
    WU1 and WU2 witnesses pass.
  - A source-generation witness: deleting a complete pack bumps the
    generation, and reclaiming a pending pack does not.
  - `npm test`; `cpu-lease run -n 4 -- npm run bench:statements -- --check`:
    no statement rise.
- **Touch points.** `pack/pack-ingest-index.ts`,
  `pack/lifecycle/lifecycle-{ingest,delete}.ts`, `pack/ingest.ts`,
  `schema/schema-object-statements.ts`, tests and benches above.

### WU4 — Measure, document and close (M)

- **Problem.** The gain is a claim until the clone is profiled, and four docs
  describe the stored canonical row.
- **Scope.**
  - **Paired runs.** Three rounds, each one run at `c373b41` and one at the
    WU3 commit in alternating order, of
    `cpu-lease run -n 2 --no-smt -- npm run bench:workerd:nextjs -- --history=full`
    (committed harness; fixture `vercel/next.js` v15.5.2 history, the pinned
    `workerd` and `miniflare` versions it records). Record wall time,
    statements and rows of each run.
  - **Attribution.** Two CDP profiles per commit with the same scratch harness
    as the baseline (Miniflare inspector, 1 ms sampling, phase attribution by
    stack). Keep each profile's summary table in the run log.
  - Run `cpu-lease run -n 2 -- npm run bench:clone-storage` and record the
    database size.
  - Run `bench:workerd:nextjs -- --live-set` for both histories.
  - Mark ADR-0031 accepted. Update ADR-0003, ADR-0022 (its "existing
    complete-membership audit" becomes the count check), ADR-0025,
    `docs/reference/concurrency.md` (including the stale row at :275),
    `docs/reference/architecture.md`, `docs/reference/git-support.md`
    (:1104), `packages/git/src/store/CLAUDE.md`,
    `docs/decisions/README.md` and `docs/INDEX.md`.
  - Delete `docs/ideas/one-oid-index-for-pack-objects.md` and its entry in
    `docs/ideas/README.md`.
- **Acceptance / witness.**
  - Wall-time floor: record the difference of each pair (baseline minus
    WU3). The median of the three differences is at least 4 s, and no pair is
    slower at WU3. The CDP profiles are separate evidence that attribute the
    CPU drop to the `pack object rows` phase and the audit. A smaller gain is
    reported, not hidden, and escalates (review strategy).
  - Statements and rows returned (the harness counts returned rows,
    `bench/workerd/worker.ts:55-62`) of the depth-1 and full-history workerd
    clones do not rise; the live-set gates pass.
  - `grep -rn "git_pack_objects" docs packages/git/src --include=*.md` finds
    only ADR-0031, this sprint once archived, `docs/archive/`, and the
    historical measurement report `docs/reference/oid-encoding-measurement.md`,
    which records the schema as measured and stays as is.
  - `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true cpu-lease run -n 4 -- npm run
    test:full` passes once.
- **Touch points.** `docs/`, `packages/git/src/store/CLAUDE.md`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Changes the identity every packed read starts from, and what maintenance deletes. A wrong rule returns a wrong copy silently or reclaims a needed pack. | After each WU: `npm run typecheck`, `npm run check`, `npm test`, the WU witnesses, `bench:statements -- --check`. Independent review of the integrated diff after WU3, repeated until clean. `npm run test:full` at closure. | Any statement rise, any parity failure, any query plan that scans `git_pack_entries` |
| WU1 | Fundamental: every read path; the planner trap is real | Independent review of the diff against the inventory, repeated until clean | A read needs a second canonical rule, or a plan cannot be pinned |
| WU2 | Fundamental: decides what maintenance reclaims | Independent review, repeated until clean | The holder test and the finish assertion cannot share one expression |
| WU3 | Fundamental: removes a concurrency guard and changes an `ESTALE` contract | Independent review, repeated until clean | Any other test depends on the claim or on promotion |
| WU4 | Measurement and docs | Witness numbers recorded in the run log; an independent review of the WU4 docs after they are written | The gain is below the acceptance floor |

## Test cadence

- **Per WU.** Run the exact acceptance witness above. Add `npm run test:e2e`
  for WU1 and WU3; they change clone and fetch paths.
- **Routine integration.** Run `npm test`; keep this smoke gate below
  30 seconds.
- **Leases.** Benchmarks, `bench:statements`, `test:e2e` and `test:full` run
  under `cpu-lease`.
- **Sprint closure.** Run `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true npm run
  test:full` once, under `cpu-lease`, after final review and focused fixes
  have settled.
- **Failure loop.** Reproduce a full-suite failure with its exact file or
  domain slice. Rerun the full suite only after the focused witness is stable.

## Out of scope (explicit)

- A covering `(repo_id, oid, pack_id, offset, type, size)` index. Revisit only
  if a WU1 read witness regresses.
- The `pako` inflate in the first pass (about 2 s): workerd's native `info`
  path retains zlib state until a major GC, so the reused pako decoder stays.
- Larger cache budgets: leased variants (pack-row cache ×4, base budget ×4,
  range batch ×8) moved deferred-delta CPU by less than the run-to-run spread.
- Backlog 119 (slicing the clone under the request CPU limit).

## Decisions

- The canonical copy is derived, not stored —
  [ADR-0031](../decisions/0031-derive-the-canonical-pack-copy-from-pack-entries.md).
- The canonical rule is the lowest `(pack_id, offset)` among complete copies.
  It matches promotion today and differs only for in-pack duplicates.
- The schema changes in place without a migration; the project has no
  production users.
- WU1 and WU2 land while `git_pack_objects` is still written, so each WU
  is independently green and revertible.

## Sequencing

WU1 → WU2 → WU3 → WU4, strictly in order. WU2 depends on the WU1 fragment;
WU3 removes the table that WU1 and WU2 stop reading.

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
whether the review strategy is proportionate to each WU and the integrated
sprint risk. Resolve blocking findings before implementation.

- **Reviewer:** GPT-6.1 (Codex harness), read-only review at `c373b41`.
- **Verdict:** blocked on the first pass; **approved with changes** on the
  re-review of the revision. The re-review's six non-blocking findings are
  applied: explicit WU1 fixture ownership and mutations, the new witness in
  the WU1 gate, `git-support.md` and the historical measurement report in
  WU4, "rows returned" instead of "rows read", a paired-difference wall-time
  floor, and corrected inventory totals.
- **Material findings:**
  1. Blocking: rows 2 and 29 return type metadata, not existence. Resolved:
     WU1 separates metadata rows from existence rows.
  2. Blocking: WU1 was not independently green, because fixtures seeding
     only `git_pack_objects` (`tests/commit-cache.test.ts:500`,
     `tests/maintenance-reachability.test.ts:736`) were deferred to WU3.
     Resolved: each fixture changes in the WU that switches its consumer.
  3. Blocking: the WU3 absence greps matched docs and `dist/`. Resolved:
     TypeScript-only greps in WU3; a docs grep in WU4.
  4. Inventory: the `stageCommitCaches` index reference, statement versus
     site counts, the schema citation, and the inner `JOIN` of row 6. Fixed.
  5. In-pack duplicate offsets change in WU1. Stated, with an exact fixture.
  6. Stronger witnesses: prefix ambiguity with duplicates, the pending
     own-start branch, a rooted duplicate for the sweep, three `git_blob_ids`
     cases, and the continuation, concurrency and cold-admission suites.
     Added.
  7. Performance acceptance: named harness, paired runs, reconciled baseline.
     Fixed.
  8. Project rules: `db.iterate()` for `oids`, `cpu-lease`, the full-suite
     editor environment, ADR-0022 and the docs indexes. Added.

## Run log

- Baseline profiles (CDP, `c373b41`, `cpu-lease run -n 2 --no-smt`, six runs
  on 2026-10-09): busy CPU 61.1, 58.8, 59.0, 63.3, 64.1, 64.4 s;
  `pack object rows` 12.5–14.2 s; membership audit 1.4–1.9 s. The machine was
  about 12 % slower than on 2026-10-08 in every phase, so WU4 compares only
  interleaved runs. Raw output stays in the session scratchpad.

### WU1 — Derived reads (2026-10-12)

- Plan and proposed ADR committed as `09993cf`; WU1 is implemented and
  verified. All 16 WU1 statement sites use complete physical membership or
  the shared canonical fragment. Lifecycle writes and maintenance reads remain
  assigned to WU2/WU3.
- `EXPLAIN QUERY PLAN` checked all 16 issued statements against the full-history
  clone database (357,637 objects). OID probes use `git_pack_entries_by_oid`,
  physical lookups use all three primary-key columns, and enumeration uses the
  OID index. The new witness captures every statement shape.
- Planner discovery: correlating the canonical subquery to the entry being
  joined can leave a repository-only primary-key search, even with the OID
  index pinned inside the subquery. Metadata LEFT JOINs bind the repository
  directly; commit-cache insertion takes it from the input JSON row. Regression
  assertions reject repository-only primary-key searches.
- Independent read-only review against `09993cf`: clean across
  correctness/security, completeness/tests/docs, and
  architecture/simplicity/SQL performance. The initially missing batch-write
  query-plan capture was added; all 16 plans were reviewed. Reviewers ran no
  tests. No unresolved review findings.
- Passed: typecheck, Biome check, diff whitespace check; smoke 160/160 in
  15.25 s; e2e 137/137; canonical witness 5/5; pack suite 85/85; import graph
  3/3; integration structure 23/23; source ceilings 3/3. The other focused WU1
  suites passed their assertions in the combined run.
- `bench:statements -- --check` passed under a CPU lease, with no statement
  increases and no returned-row regression. No timing claim is made for WU1;
  the paired workerd measurements remain WU4.
- The maintenance reachability file originally passed all 30 assertions but
  exited with Vitest's `onTaskUpdate` RPC timeout. The isolated 50,001-commit
  test at `09993cf` reproduced the same error. After user approval, the test
  yields between completed maintenance calls every 512 iterations; no timeout
  or assertion changed. Its independent review is clean, and the entire file
  now passes 30/30 with exit 0 (106.80 s). The test fix is a separate commit.

### WU2 — Maintenance (2026-10-12)

- WU1 committed as `6840774`. Roots, reachability, loose sweep and pack sweep
  now derive complete membership and canonical ownership from physical entries.
  Page classification and finish validation share the marked-holder predicate.
- All eight rewritten statement shapes have query-plan witnesses. A read-only
  full-history bytecode probe confirmed that an absent reachability mark skips
  the canonical subquery entirely; the mark correlation prevents unnecessary
  canonical lookups for unmarked entries.
- Independent correctness, coverage/architecture and SQL-performance reviews
  are clean. No unresolved findings.
- Passed under CPU leases: seven maintenance suites (89 tests), the expanded
  sweep suite (23 tests), smoke (160 tests), typecheck and the statement-budget
  gate. Biome and diff whitespace checks passed. Added witnesses cover redundant
  pack deletion, ownership transfer and blob-ID retention with surviving copies.

### WU3 — Remove stored canonical ownership (2026-10-12)

- WU2 committed as `dd352c8`. Ingest now writes only physical entries;
  publication audits their count. Complete-pack deletion advances source
  generation, and pending-only reclamation does not. Commit projections survive
  only with a loose source or a complete copy outside the entire deletion set.
- The former canonical-owner-deletion `ESTALE` schedule now publishes and reads
  both objects cold without retry. Added generation and commit-cache witnesses
  cover redundant/empty packs, absent retries, pending copies and batch deletion.
- All TypeScript references to the removed table/index are gone. The OID
  prototype now retains all 30,901 physical fixture entries, including duplicate
  OIDs, and checks count and same-pack bases. TEXT/BLOB correctness checks pass.
- Independent WU3 and integrated WU1–WU3 reviews are clean after two fixes:
  cold cache tests reopen the existing checkout; the benchmark preserves all
  physical copies instead of its previous one-location-per-OID population.
  Production SQL plans use physical ranges and indexed OID probes.
- Passed: typecheck, Biome, diff whitespace; smoke 160/160 (15.41 s), e2e
  137/137 (97.28 s), pack/schema/concurrency/cold-admission witnesses, all WU1/WU2
  query-plan witnesses (the maintenance capture now includes nine statements),
  and the statement/row gate with no increase. Additional read/store/maintenance
  suites passed. The long store file reproduced the known forks RPC timeout;
  its existing full-suite threads-pool configuration passed 107/107 (64.46 s).
  The remaining WU1/WU2 witnesses passed 71/71 (100.35 s).
