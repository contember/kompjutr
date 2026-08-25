---
id: 19
title: Align foreign-key enforcement between tests and production
blocked-by: []
---

# 19 — Align foreign-key enforcement between tests and production

**Summary.** The one `FOREIGN KEY` in the git schema relies on adapter defaults;
measure every supported adapter, pick one behaviour, and make the application
own it explicitly.

## Problem

`git_tree_entries` declares `FOREIGN KEY (repo_id, tree_oid, storage, source_id)
REFERENCES git_tree_sources … ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`
(`src/sqlite/schema.ts`, the `git_tree_entries` statement). Nothing in `src/`
issues `PRAGMA foreign_keys = ON`. The test harness opens `node:sqlite`
`DatabaseSync` with default options (`tests/helpers/storage.ts`), which enables
foreign-key enforcement.

The original review assumed workerd used SQLite's upstream off-by-default mode.
The currently checked workerd build instead defines
`SQLITE_DEFAULT_FOREIGN_KEYS=1` and allowlists changing the pragma. Production
may therefore already match tests, but only through a runtime build default that
kompjutr neither asserts nor owns. Verify the actual adapter state before making
any schema change.

Consequences today:

- Tests validate insert ordering and cascade behaviour under enforcement.
  `DEFERRABLE INITIALLY DEFERRED` exists only so the entry batch can be flushed
  before its marker under enforcement.
- The implementation also relies on explicit deletes in the
  `git_tree_effective_loose_delete` trigger and in `src/sqlite/packs.ts`
  (`DELETE FROM git_tree_entries … DELETE FROM git_tree_sources …`). Nothing is
  known broken today, but a future adapter default change could silently alter
  insert ordering, cascade, and cleanup behavior.

## Approach / acceptance

Decide one of:

1. **Enforce everywhere.** Run `PRAGMA foreign_keys = ON` before schema
   initialization in every adapter. Keep the constraint; the explicit deletes
   stay as belt and braces.
2. **Enforce nowhere.** Drop the `FOREIGN KEY` clause in a schema migration and
   open the test database with `enableForeignKeyConstraints: false` so the
   harness matches workerd.

Either way, record the choice in a short decision (`docs/decisions/`) because it
constrains every future schema edit.

Acceptance:

- A matrix asserts the chosen pragma state and behavior through the native,
  compatibility, test, and local workerd adapters, so an upgrade cannot silently
  flip it.
- Under option 1, a test deletes a complete pack and a loose tree and verifies no
  orphan `git_tree_entries` rows remain with the cascade as the only mechanism.
- Under option 2, `PRAGMA foreign_key_list(git_tree_entries)` is empty after
  migration, and the explicit-delete paths keep their existing tests.
- Backlog 11 (production probe) includes `PRAGMA foreign_keys` in its recorded
  platform facts.

## Touch points

`src/sqlite/store.ts`, `src/sqlite/schema.ts`, `src/sqlite/db.ts`,
`src/runtime/workspace.ts`, `src/compat/computer/client.ts`,
`tests/helpers/storage.ts`, `tests/schema-migration.test.ts`, local workerd
probe, `docs/decisions/`

<!-- Origin: git schema architecture review, 2026-08-24. -->
