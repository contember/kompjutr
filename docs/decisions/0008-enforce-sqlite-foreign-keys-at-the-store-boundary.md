---
id: 0008
title: Enforce SQLite foreign keys at the store boundary
status: accepted
date: 2026-08-25
---

# 0008 — Enforce SQLite foreign keys at the store boundary

## Context

The Git schema has a deferred cascading foreign key from parsed tree entries to
their source marker. The runtime originally relied on whatever `foreign_keys`
default each SQLite build shipped. That made results sensitive to an adapter or
runtime upgrade even though the schema was identical.

The evidence gathered before this decision: the Node 24.4.0 test runtime reports
`foreign_keys=1` by default and accepts explicit `OFF` and `ON` transitions; the
standalone Durable Object adapter accepts explicit enforcement; and a Miniflare
Durable Object witness running `workerd 2026-08-20` reports `1`, accepts
explicit enforcement during initialization, and reports `1` again after actor
eviction while preserving its SQLite rows. That matches the checked workerd
revision `8ae9e49a5`, which defines `SQLITE_DEFAULT_FOREIGN_KEYS=1`, allowlists
the boolean `foreign_keys` pragma, and tests changing it in its Durable Object
SQL suite.

## Decision

We set `PRAGMA foreign_keys = ON` and verify that it reports `1` whenever a Git
database is opened. This happens before schema initialization, because SQLite
ignores changes to this pragma inside a transaction. An adapter that cannot
honor the setting fails before the Git schema is created.

The schema version does not change, because enforcement is a connection setting
rather than a persisted schema change. Existing explicit tree-entry deletion
stays as defense in depth.

Enabling the pragma governs subsequent writes and deletes. It does not validate
or repair violations that already exist in a database. Opening a store does not
run an unbounded `foreign_key_check`: under
[ADR-0004](0004-trust-stored-rows-validate-at-the-boundary.md), the integrity of
existing rows is the write path's guarantee and the opt-in audit's job, not a
read-time concern.

## Consequences

- Fresh, reopened, and migrated Git stores use the same enforcement mode
  independently of SQLite build defaults.
- Orphan parsed-tree entries fail closed, and deleting either a loose or a
  packed source cascades to its entries.
- Every future supported SQLite adapter must permit this pragma and report its
  enabled state before Git storage can be initialized.
- A production probe records `PRAGMA foreign_keys` alongside the runtime and
  schema versions.

## Alternatives considered

- **Rely on current Node and workerd defaults.** Preserves today's behavior but
  offers no protection against a build-option or adapter change.
- **Remove the foreign key and disable enforcement everywhere.** Discards a
  useful integrity check, requires a schema change, and was not justified when
  every locally testable adapter accepts explicit enforcement.

Reopen this decision if a supported production SQLite runtime cannot set and
read the pragma before a transaction, or if measured production evidence shows
that enforced cascades violate the cost targets in
[ADR-0005](0005-bound-real-failures-and-measure-cost.md).
