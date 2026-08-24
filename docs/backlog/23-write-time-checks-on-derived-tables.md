---
id: 23
title: Add write-time CHECK constraints to the derived commit and tree tables
blocked-by: []
---

# 23 — Add write-time CHECK constraints to the derived commit and tree tables

**Summary.** Derived rows are validated only when read, inside every traversal
statement. Cheap `CHECK` constraints would reject malformed rows at insert time
as a second line of defence without changing the read-side trust rule.

## Problem

Invariant 4 (root `CLAUDE.md`) treats every SQL row as untrusted, so the
commit-graph SQL in `src/sqlite/commits.ts` guards `parents` with a
`typeof … / length … / json_valid … / json_type …` `CASE` chain in each recursive
step, and the tree traversal validates mode, name, and OID shape per row. That
is correct and must stay: a `CHECK` does not protect against storage corruption
after the write.

What is missing is the write side. `git_commits`, `git_tree_sources`, and
`git_tree_entries` accept any text in `oid`/`tree_oid`, any text in `parents`,
any `mode`, and any `storage` outside the two tables that already constrain it.
A bug in the projection writers lands garbage that the readers then silently
treat as an empty parent list or a skipped row, which is the failure mode the
read-side guards were built to survive, not to hide.

## Approach / acceptance

- Add constraints that are cheap and stable:
  - `git_commits`: `CHECK (length(oid) = 40 AND length(tree) = 40)`,
    `CHECK (json_valid(parents) AND json_type(parents) = 'array')`,
    `CHECK (object_size >= 0 AND cache_bytes >= 0)`.
  - `git_tree_entries`: `CHECK (length(oid) = 40)`, `CHECK (mode IN (…))` with
    the same set as `TREE_MODE` in `src/sqlite/schema.ts`,
    `CHECK (typeof(name_bytes) = 'blob' AND length(name_bytes) BETWEEN 1 AND 2200)`.
  - `git_tree_sources`: `CHECK (entry_count >= 0 AND object_size >= 0)`.
  - `git_objects` / `git_pack_objects`: `CHECK (type IN ('blob','tree','commit','tag'))`,
    `CHECK (stored IN ('zlib','raw'))`.
- Ship them through a migration that rebuilds the affected tables (SQLite cannot
  add a `CHECK` with `ALTER TABLE`), in bounded steps, from authoritative
  sources.
- Do not remove or weaken any read-side validation.

Acceptance: `tests/` inserts each malformed shape directly and expects the
`CHECK` to reject it; the existing corruption tests that insert bad rows under
`PRAGMA ignore_check_constraints = ON` still exercise the read-side guards;
statement counts in the benchmark are unchanged.

## Touch points

`src/sqlite/schema.ts`, migrations, `tests/schema-migration.test.ts`,
`tests/commit-cache.test.ts`, `tests/tree-index-stream.test.ts`

<!-- Origin: git schema architecture review, 2026-08-24. -->
