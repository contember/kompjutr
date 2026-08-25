---
id: 22
title: Decide the OID column encoding before data volume locks it in
blocked-by: []
---

# 22 — Decide the OID column encoding before data volume locks it in

**Summary.** Every OID column is 40-byte hex `TEXT`; a 20-byte `BLOB` would halve
key storage and comparison cost across the object, pack, commit, and tree tables.
Make the decision explicitly now, while a schema-wide migration is still cheap.

## Problem

`oid`, `tree_oid`, `base_oid`, `target`, `parents`, and the operation-state OID
columns are all hex `TEXT` (`src/sqlite/schema.ts`). They form the primary key of
`git_objects`, `git_object_chunks`, `git_pack_objects`, `git_commits`,
`git_tree_sources`, `git_tree_entries`, and `git_shallow`. Hex is readable in ad
hoc queries and matches the JavaScript string representation used throughout
`src/core/`, so nothing is wrong today. But the choice is effectively permanent:
once production repositories hold large object sets, rewriting every keyed table
is a multi-hour maintenance operation under the per-operation budgets.

## Approach / acceptance

- Measure on the standard fixture: total database size and traversal statement
  wall time with hex `TEXT` versus a `BLOB` variant on a branch. Include the
  cost of converting at the `src/core/` boundary (every read decodes, every
  write encodes).
- Decide and record the result as a decision in `docs/decisions/`, whichever
  way it goes. "Keep hex" is a valid outcome; the point is that it is chosen.
- If the decision is `BLOB`: schedule it together with backlog 21 so the tree
  tables are rebuilt once, and add a migration that rebuilds every keyed table
  from authoritative sources in bounded steps.

Acceptance: the decision file exists and links the measurements; if migrating,
`tests/schema-migration.test.ts` covers a v11 database with loose objects, a
complete pack, a pending pack, and an active operation journal.

## Touch points

`docs/decisions/`, `bench/`; if migrating: `src/sqlite/schema.ts`,
`src/sqlite/store.ts`, `src/sqlite/packs.ts`, `src/sqlite/commits.ts`,
`src/core/bytes.ts`, `tests/`

<!-- Origin: git schema architecture review, 2026-08-24. Related: ./21-narrow-parsed-tree-keys.md -->
