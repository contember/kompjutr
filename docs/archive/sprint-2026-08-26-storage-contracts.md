> **OUTCOME — shipped 2026-08-26.** Schema v12 keeps filesystem content
> identities opaque while bounding their Git blob cache, keys parsed trees by a
> source surrogate, reconstructs derived projections from authoritative loose
> objects and complete packs, and rejects malformed projection writes. Commit
> map: WU1–WU4 → `f327434`; WU5 benchmark → `6890f53`. Verification: leased full
> suite — 96 files and 1,719 tests passed, 5 skipped; leased `npm run build`;
> leased `npm run typecheck`; `npm run check`; docs lint; tree-schema
> correctness and leased measurement. The representative layout shrank by
> 2,572,288 bytes, or 25.8649%. Backlog closed: 20, 21, and 23. Deferred:
> production Durable Object evidence remains backlog 11; no production
> wall-time or memory claim was made.

# Sprint — Storage contracts and derived-table hardening (2026-08-26)

**Goal.** Ship one bounded Git schema migration that gives content identities a
finite lifecycle, narrows parsed-tree storage, and rejects malformed derived rows
at write time without weakening authoritative-source validation.

**Theme.** These changes all alter durable storage contracts and otherwise require
separate table rebuilds. They belong in one schema-v12 migration while the package
still has no release version and before repositories make the migration more
expensive. Success means existing repositories rebuild derived projections from
authoritative loose objects and complete packs, hot reads retain their statement
and ordering properties, and every new retained structure has an explicit bound.

Consumes backlog items 20, 21, and 23. All three closed with this sprint.

## Refs re-verified at HEAD (2026-08-26, `0499ada`)

- ✔ `git_blob_ids` is an opaque content-id-to-blob-OID cache used by status,
  staging, diff, and checkout, but only repository destruction removes rows —
  `src/sqlite/schema.ts:244`, `src/sqlite/store.ts:1295`,
  `src/sqlite/store.ts:1385`, `src/sqlite/store.ts:3848`.
- ✔ The filesystem contract is deliberately Git-agnostic: `contentId` is an
  opaque writer-minted identity, and the dependency runs from Git to the
  filesystem — `src/fs/types.ts:1`, `src/fs/types.ts:34`.
- ✔ `git_tree_entries` repeats the four-column source identity in its primary
  key and name index and stores both TEXT and BLOB copies of each name —
  `src/sqlite/schema.ts:344`, `src/sqlite/schema.ts:355`,
  `src/sqlite/schema.ts:373`.
- ✔ Loose objects become effective before a parsed marker exists. This fail-
  closed shadowing prevents a corrupt loose duplicate from borrowing a valid
  packed projection — `src/sqlite/schema.ts:377`, `src/core/CLAUDE.md:41`.
- ✔ Commit and tree readers validate derived rows against exact loose objects or
  complete packs; the new checks are only a second write-side defence —
  `src/sqlite/commits.ts:441`, `src/sqlite/commits.ts:502`,
  `src/sqlite/schema.ts:1004`, `src/core/CLAUDE.md:45`.
- ✔ Schema initialization is one synchronous transaction at version 11, and
  structural migration currently runs after current-shape `CREATE IF NOT
  EXISTS` statements — `src/sqlite/schema.ts:46`, `src/sqlite/schema.ts:950`.
- ✔ The targeted negative-control suite passes at HEAD: 6 files and 152 tests,
  including the 24,252-file status and initial-clone witnesses.
- ⚠ The backlog suggested dropping `git_blob_ids` if content identity equals the
  blob OID. That would silently couple the public filesystem boundary to Git and
  make arbitrary 20-byte external identities unsafe. This sprint retains the
  opaque mapping and bounds it instead.
- ⚠ `git_tree_effective` currently points at a natural source identity even when
  no parsed source row exists. The surrogate schema therefore needs an explicit
  incomplete source marker; a simple foreign key to completed sources would
  break loose-over-pack shadowing.

## Work units

### WU1 — Bound the opaque blob-identity cache (effort M)

- **Problem.** `git_blob_ids` grows forever, and lookup/upsert helpers retain
  caller-sized maps without one shared cache bound.
- **Verify first.** Prove every producer treats a missing mapping as "hash the
  bytes" and that eviction cannot change Git-visible results. Confirm initial
  clone uses the same lifecycle as ordinary upserts.
- **Scope.** Keep `contentId` opaque. Add a per-repository generation and a hard
  row cap to `git_blob_ids`; bound retained lookup/upsert input; evict the oldest
  generations transactionally after every writer, including initial clone; and
  migrate existing rows into the bounded cache without changing filesystem
  bytes, metadata, or revisions.
- **Acceptance / witness.** An over-cap write leaves at most the documented row
  limit, hot current-generation mappings survive older ones, evicted mappings
  fall back to hashing with the same result, large inputs stay within the retained
  byte limit, initial clone cannot bypass eviction, and existing status/add/diff
  statement ceilings do not regress.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`, blob-identity
  callers only if the store contract requires it, `tests/store.test.ts`,
  `tests/status.test.ts`, `tests/staging.test.ts`, `tests/diff.test.ts`,
  `tests/clone-initial.test.ts`.

### WU2 — Narrow parsed-tree source identity and names (effort L)

- **Problem.** Each entry and secondary-index row carries the wide natural source
  key, while `name` duplicates `name_bytes` and raw tree bytes.
- **Verify first.** Compare the current and proposed layouts on the standard
  34,996-entry fixture. Confirm `(source, ordinal)` preserves traversal order and
  `(source, name_bytes)` serves exact sparse lookup without an outer sort.
- **Scope.** Give each source an integer surrogate with a unique natural identity;
  key entries by `(source, ordinal)` and effective trees by `(repo_id, tree_oid)`
  to the surrogate. Represent an unparsed loose or complete-pack tree as an
  explicit incomplete source marker. Retain `name_bytes` as the canonical BINARY
  lookup/order value, derive TEXT at read time, and retain `raw_entry` as an
  independent cross-field corruption witness.
- **Acceptance / witness.** Loose sources still shadow packed duplicates before
  and after parsing; deleting loose falls back to a complete pack; pending packs
  stay invisible; traversal remains one ordered cursor; non-BMP Git path order,
  sparse exact lookup, corruption detection, statement counts, and the 16 MiB
  traversal bound remain intact.
- **Touch points.** `src/sqlite/schema.ts`, `src/sqlite/store.ts`,
  `src/sqlite/packs.ts`, `src/sqlite/sparse-workspace.ts`,
  `src/core/ops/tree-stream.ts`, tree/store/read/sparse tests.

### WU3 — Rebuild authoritative projections in schema v12 (effort L)

- **Problem.** Copying old `git_commits` or `git_tree_*` rows would preserve the
  corruption that the migration is meant to remove, while current schema
  initialization has no structural-migration seam for reading object bytes.
- **Verify first.** Build a v11 fixture containing the same tree loose and in a
  complete pack, corrupt only its derived rows, and prove the existing raw sources
  remain readable. Count the maximum migration statements before publishing v12.
- **Scope.** Separate current-shape creation from existing-schema migration. In
  one `transactionSync()`, create the final tables, stream loose tree/commit
  objects and bounded batches from complete packs through existing parsers,
  reconstruct effective-source selection, and drop legacy derived tables only
  after every source validates. Validate/copy authoritative object and pack index
  metadata into their constrained tables; pending packs remain non-authoritative.
- **Acceptance / witness.** Corrupt derived rows are repaired from exact object
  bytes; corrupt authoritative data fails with `ECORRUPT` and rolls back to an
  intact v11 database; loose/pack shadowing survives; the migration is idempotent,
  stays below 1,000 SQL statements and 100 MiB retained memory, and records v12
  only as its last durable step.
- **Touch points.** `src/sqlite/schema.ts`, a dedicated migration module if needed,
  `src/sqlite/store.ts`, `src/sqlite/packs.ts`,
  `tests/schema-migration.test.ts`, pack and store fixtures.

### WU4 — Reject malformed derived writes (effort M)

- **Problem.** Projection writers can insert malformed shapes which readers then
  treat as corruption or skip, rather than rejecting the faulty write.
- **Verify first.** Enumerate every current writer and distinguish cheap shape
  checks from authoritative read-time checks that must remain.
- **Scope.** Add `typeof`-aware checks for 40-byte TEXT OIDs, JSON-array commit
  parents, nonnegative integer sizes/counts, the six tree modes, 1..2,200-byte
  BLOB names, object type enums, and loose encoding enums. Keep all read-side
  validation. Tests that intentionally bypass write checks must use
  `PRAGMA ignore_check_constraints = ON` only around the corrupting statement.
- **Acceptance / witness.** Each malformed affinity, enum, length, JSON, and
  negative-number shape fails at insertion; valid boundary values pass; existing
  valid-looking corruption tests still reach and exercise read-time guards; no
  benchmark statement count changes.
- **Touch points.** `src/sqlite/schema.ts`, `tests/schema-migration.test.ts`,
  `tests/commit-cache.test.ts`, `tests/tree-index-stream.test.ts`,
  `tests/reads.test.ts`.

### WU5 — Measure and publish the settled contract (effort M)

- **Problem.** The tree-key change is justified by storage reduction, but that
  claim needs a like-for-like measurement and the current reference must describe
  the final schema rather than the plan.
- **Verify first.** Reserve two physical cores with `cpu-lease --no-smt` and keep
  the fixture, filesystem mode, object layout, Node version, and SQL counters
  identical before and after.
- **Scope.** Measure combined `git_tree_sources`, `git_tree_entries`, name index,
  and `git_tree_effective` bytes per entry before/after. Run targeted witnesses,
  typecheck, check, the leased full suite, and the leased production build. Update
  current architecture and benchmark reference with only measured claims.
- **Acceptance / witness.** The curated reference records command, commit,
  fixture, raw page/byte totals, per-entry result, and statement/row profiles;
  every repository gate is green and docs lint passes.
- **Touch points.** `bench/`, `docs/reference/benchmark-current.md`,
  `docs/reference/architecture.md`, `docs/decisions/`, `README.md` only if its
  current claims change.

## Out of scope (explicit)

- Reflogs, branch-delete safety, repack, and garbage collection remain backlog
  12, 33, and 04; this sprint only gives `git_blob_ids` its own cache lifecycle.
- Filesystem API changes or interpreting arbitrary `contentId` bytes as Git OIDs.
- Changing OID columns from TEXT to BLOB; ADR 0005 remains authoritative.
- Removing `raw_entry`, expression-only name lookup, validating every parent OID
  element in SQL, or replacing read-time source authentication with `CHECK`s.
- Full pack format reindexing unrelated to reconstructing commit/tree projections.
- Production Durable Object deployment or performance claims; backlog 11 owns
  production evidence.

## Decisions

- Keep `contentId` opaque and keep `git_blob_ids` as a bounded, generational
  cache. This preserves the public filesystem and custom-worktree boundary.
- Use integer tree-source surrogates. Incomplete source markers preserve
  fail-closed loose-over-pack selection until parsing succeeds.
- Keep `name_bytes`; derive TEXT names at bounded read sites. Keep `raw_entry` as
  the independent integrity witness.
- Use one schema-v12 migration. Rebuild commit and tree projections from
  authoritative object bytes; never copy old derived rows.
- Add only cheap shape/affinity checks. Canonical value validation and source
  authentication remain mandatory on read.

## Sequencing

| Wave | Work | Dependency | Parallelism |
|---|---|---|---|
| 0 | Freeze v12 DDL, migration entry point, and fixtures | Sprint plan | One owner; shared seam |
| 1 | WU1 cache lifecycle | Wave 0 | Sequential; overlaps store/schema |
| 2 | WU2 tree readers/writers and WU3 authoritative rebuild | Wave 0 | Sequential where store/schema overlap |
| 3 | WU4 corruption witnesses | Final DDL | Can fan out read-only review, one writer |
| 4 | WU5 gates, benchmark, references | All implementation | Serialized under CPU lease |

Every implementation unit receives an independent diff review before its commit.
Any required public API change, dependency, weakened test, relaxed migration
source rule, or operation-budget exception stops the sprint for an owner decision.

## Run log

- 2026-08-26 — Sprint opened from backlog 20, 21, and 23. The approved direction
  was re-verified by three independent read-only specifications. Removal of
  `git_blob_ids` was rejected because it would couple the Git-agnostic filesystem
  contract to Git object identity; bounded eviction preserves the existing layer.
- 2026-08-26 — WU1–WU4 shipped in `f327434`. Independent migration, tree, and
  cache reviews found and verified fixes for migration bounds, source identity,
  newest-generation retention, invalid control rows, and statement-count
  regressions. → ADR-0006 and ADR-0007.
- 2026-08-26 — WU5 shipped in `6890f53`. The leased Next.js layout measurement
  proved equal logical rows and query profiles while reducing combined parsed-
  tree storage by 25.8649%. The full suite, build, typecheck, check, docs lint,
  and diff checks passed.
