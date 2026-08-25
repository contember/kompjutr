---
id: 0004
title: Enforce SQLite foreign keys at the Git store boundary
status: accepted
date: 2026-08-25
---

# 0004 — Enforce SQLite foreign keys at the Git store boundary

## Context

The Git schema has a deferred cascading foreign key from parsed tree entries to
their source marker. The runtime previously relied on each SQLite build's
default `foreign_keys` setting. This made test results sensitive to adapter and
runtime upgrades even though the schema was identical.

The Node 24.4.0 test runtime reports `foreign_keys=1` by default and accepts
explicit `OFF` and `ON` transitions. Local adapter tests also show that the
standalone Durable Object adapter and the Computer provider accept explicit
enforcement. A Miniflare Durable Object witness running `workerd 2026-08-20`
reports `1`, accepts explicit enforcement during initialization, and reports
`1` again after actor eviction while preserving its SQLite rows. This matches
the checked workerd revision `8ae9e49a5`, which defines
`SQLITE_DEFAULT_FOREIGN_KEYS=1`, allowlists the boolean `foreign_keys` pragma,
and tests changing it in its Durable Object SQL suite.

## Decision

We will set `PRAGMA foreign_keys = ON` and verify that it reports `1` whenever a
`SqliteGitDatabase` is opened. This happens before schema initialization because
SQLite ignores changes to this pragma inside a transaction. An adapter that
cannot honor the setting fails before the Git schema is created or migrated.

The schema version does not change because enforcement is a connection setting,
not a persisted schema change. Existing explicit tree-entry deletion remains as
defense in depth.

Enabling the pragma governs subsequent writes and deletes. It does not validate
or repair violations that already exist in a database. Opening a store does not
run an unbounded `foreign_key_check`; persisted-row validation remains the
responsibility of bounded migration and read paths.

## Consequences

- Fresh, reopened, migrated, standalone, and Computer-backed Git stores use the
  same enforcement mode independently of SQLite build defaults.
- Orphan parsed-tree entries fail closed, and deleting either a loose or packed
  source cascades to its entries.
- Every future supported SQLite adapter must permit this pragma and return its
  enabled state before kompjutr can initialize Git storage.
- A future production probe must record `PRAGMA foreign_keys` alongside the
  runtime and schema versions.

## Alternatives considered

- Rely on the current Node and workerd defaults. This preserves today's behavior
  but does not protect against a build-option or adapter change.
- Remove the foreign key and disable enforcement everywhere. This discards a
  useful integrity check, requires a schema migration, and was not justified
  because every locally testable adapter accepts explicit enforcement.

Reopen this decision if a supported production SQLite runtime cannot set and
read the pragma before a transaction, or if measured production evidence shows
that enforced cascades violate the operation budget.
