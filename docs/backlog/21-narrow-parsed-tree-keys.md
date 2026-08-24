---
id: 21
title: Narrow the parsed-tree table keys and remove the duplicated entry name
blocked-by: []
---

# 21 — Narrow the parsed-tree table keys and remove the duplicated entry name

**Summary.** `git_tree_entries` carries a five-column primary key and stores each
entry name three times; a surrogate source id and one canonical name column would
cut the per-entry footprint substantially. Decide before repositories with large
trees make the migration expensive.

## Problem

`git_tree_sources`, `git_tree_entries`, and `git_tree_effective` are keyed on
`(repo_id, tree_oid, storage, source_id)` (`src/sqlite/schema.ts`).

- `git_tree_entries` is `WITHOUT ROWID` with PK `(repo_id, tree_oid, storage,
  source_id, ordinal)`. On a `WITHOUT ROWID` table every secondary-index entry
  carries the whole primary key, so `git_tree_entries_by_name_bytes` stores
  `repo_id + 40-byte tree_oid + storage + source_id + name_bytes` per entry. The
  `FOREIGN KEY` and all five `git_tree_effective_*` triggers repeat the same
  four-column identity.
- Each entry stores `name TEXT COLLATE BINARY`, `name_bytes BLOB`, and
  `raw_entry BLOB`, and `raw_entry` already contains mode, name, and OID.
  `validateParsedTreeEntry` requires `name` and `name_bytes` to round-trip UTF-8
  exactly, so they are the same bytes under two affinities. The likely reason is
  that a TEXT column never compares equal to a BLOB parameter in SQLite, but the
  schema does not say so, and the stored tree is roughly three times the size of
  the git object.

## Approach / acceptance

- Give `git_tree_sources` an `id INTEGER PRIMARY KEY` surrogate and a `UNIQUE`
  on the current four-column identity. Key `git_tree_entries` on
  `(source, ordinal)` and `git_tree_effective` on `(repo_id, tree_oid) → source`.
  Rewrite the five triggers and the FK against the surrogate.
- Keep exactly one name representation per entry. Candidates: keep
  `name_bytes` and derive the TEXT form at read time with `CAST`, or keep
  `raw_entry` plus a name offset/length and use `substr` for lookups. Measure
  before choosing; the merge-join traversal (`src/core/CLAUDE.md`) must keep
  its ordered range scan on the BINARY name order.
- Write the reason for whichever name form survives into the schema comment.
- Migrate in place: rebuild the three tables from their authoritative sources
  (loose objects and complete packs), never from the old derived rows.

Acceptance:

- A benchmark row in `docs/reference/benchmark-current.md` shows the per-entry
  storage before and after on the standard fixture.
- Traversal statement counts and ordering tests in `tests/` are unchanged.
- Schema-migration tests cover a repository holding both loose and packed copies
  of the same tree, and the shadowing invariant still holds after migration.

## Touch points

`src/sqlite/schema.ts` (tables, index, triggers, `TreeIndexBatch`),
`src/sqlite/store.ts`, `src/sqlite/packs.ts`, `src/core/ops/tree-stream.ts`,
migrations, `tests/schema-migration.test.ts`, `bench/`

<!-- Origin: git schema architecture review, 2026-08-24. Related: ./22-oid-column-encoding.md -->
