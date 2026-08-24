---
id: 19
title: Align foreign-key enforcement between tests and production
blocked-by: []
---

# 19 — Align foreign-key enforcement between tests and production

**Summary.** The one `FOREIGN KEY` in the git schema is enforced under the test
harness and inert in Durable Objects; pick one behaviour and make both
environments run it.

## Problem

`git_tree_entries` declares `FOREIGN KEY (repo_id, tree_oid, storage, source_id)
REFERENCES git_tree_sources … ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`
(`src/sqlite/schema.ts`, the `git_tree_entries` statement). Nothing in `src/`
issues `PRAGMA foreign_keys = ON`. SQLite defaults the pragma to off, and workerd
only allowlists it (`util/sqlite.c++`, `ALLOWED_PRAGMAS`); it does not enable it.
The test harness opens `node:sqlite` `DatabaseSync` with default options
(`tests/helpers/storage.ts`), which enables foreign-key enforcement.

Consequences today:

- Tests validate insert ordering and cascade behaviour that production never
  checks. `DEFERRABLE INITIALLY DEFERRED` exists only so the entry batch can be
  flushed before its marker under enforcement.
- Production relies on the explicit deletes in the
  `git_tree_effective_loose_delete` trigger and in `src/sqlite/packs.ts`
  (`DELETE FROM git_tree_entries … DELETE FROM git_tree_sources …`), so nothing is
  broken — but a future change that leans on the cascade would pass tests and
  leak rows in production, and a future test could fail on a constraint that
  production does not have.

## Approach / acceptance

Decide one of:

1. **Enforce everywhere.** Run `PRAGMA foreign_keys = ON` when the database is
   opened (`src/sqlite/db.ts` / `src/runtime/workspace.ts`), in every
   environment. Keep the constraint; the explicit deletes stay as belt and braces.
2. **Enforce nowhere.** Drop the `FOREIGN KEY` clause in a schema migration and
   open the test database with `enableForeignKeyConstraints: false` so the
   harness matches workerd.

Either way, record the choice in a short decision (`docs/decisions/`) because it
constrains every future schema edit.

Acceptance:

- A test asserts the pragma state the project has chosen, on the same adapter
  the suite uses, so a harness upgrade cannot silently flip it.
- Under option 1, a test deletes a complete pack and a loose tree and verifies no
  orphan `git_tree_entries` rows remain with the cascade as the only mechanism.
- Under option 2, `PRAGMA foreign_key_list(git_tree_entries)` is empty after
  migration, and the explicit-delete paths keep their existing tests.
- Backlog 11 (production probe) includes `PRAGMA foreign_keys` in its recorded
  platform facts.

## Touch points

`src/sqlite/schema.ts`, `src/sqlite/db.ts`, `src/runtime/workspace.ts`,
`tests/helpers/storage.ts`, `tests/schema-migration.test.ts`, `docs/decisions/`

<!-- Origin: git schema architecture review, 2026-08-24. -->
