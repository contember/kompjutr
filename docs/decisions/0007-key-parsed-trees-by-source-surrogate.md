---
id: 0007
title: Key parsed trees by source surrogate
status: accepted
date: 2026-08-26
---

# 0007 — Key parsed trees by source surrogate

## Context

Schema v11 repeated the natural tree-source identity `(repo_id, tree_oid,
storage, source_id)` in every parsed entry primary key, every name-index row,
and every effective-source trigger. Entries also stored a TEXT name alongside
the same bytes in `name_bytes`. This made the parsed-tree index substantially
larger than the tree objects it represented.

The natural identity still carries semantics the traversal depends on: loose
objects must shadow packed duplicates even before parsing succeeds, pending
packs must remain invisible, and a packed delta base must not resolve through
an unrelated loose entry. Narrowing keys must not merge sources.

## Decision

We will assign each loose or complete packed tree source an integer
`source_key`. Parsed entries use `(source_key, ordinal)`, and the effective
`(repo_id, tree_oid)` row points to the selected surrogate through a composite
foreign key that also matches its natural repository and tree identity.

An explicit incomplete source marker represents a visible authoritative source
whose projection is not yet valid. This preserves fail-closed loose-over-pack
shadowing. `name_bytes` is the only stored name representation and remains the
canonical BINARY value for Git ordering and exact lookup; bounded readers derive
TEXT names.

Per ADR-0018, projection rows are trusted at read time; source qualification
exists for shadowing and delta-base correctness, not as a corruption witness.
Columns kept purely as read-time cross-validation witnesses are retired.

## Consequences

- Entry primary keys and the name index no longer repeat the wide natural source
  identity or a duplicate TEXT name.
- The representative fixture's combined tree-schema storage fell by 25.9%.
- Loose shadowing, pack fallback, traversal order, and exact-name lookup retain
  their source-qualified semantics.
- Writers must create or resolve a source marker before inserting entries.

## Alternatives considered

- Keep the wide natural keys. This avoids a migration but preserves the measured
  storage overhead in every entry and secondary-index row.
- Keep only raw entry bytes and derive names with offsets and `substr`. This
  removes more bytes but complicates exact indexed lookup.
