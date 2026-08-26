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
the same bytes in `name_bytes` and `raw_entry`. This made the parsed-tree index
substantially larger than the tree objects it represented.

The natural identity still carries important trust semantics. Loose objects
must shadow packed duplicates even before parsing succeeds, pending packs must
remain invisible, and readers must authenticate every projection against the
exact authoritative source. Narrowing keys cannot merge sources or let an
invalid loose object borrow a valid packed projection.

## Decision

We will assign each loose or complete packed tree source an integer
`source_key`. Parsed entries use `(source_key, ordinal)`, and the effective
`(repo_id, tree_oid)` row points to the selected surrogate through a composite
foreign key that also matches its natural repository and tree identity.

An explicit incomplete source marker represents a visible authoritative source
whose projection is not yet valid. This preserves fail-closed loose-over-pack
shadowing. `name_bytes` is the only stored name representation and remains the
canonical BINARY value for Git ordering and exact lookup; bounded readers derive
TEXT names. `raw_entry` remains stored as an independent witness for mode, name,
and OID cross-validation.

Schema v12 rebuilds these projections from authoritative loose objects and
complete packs. It never copies the legacy derived rows.

## Consequences

- Entry primary keys and the name index no longer repeat the wide natural source
  identity or a duplicate TEXT name.
- The representative fixture's combined tree-schema storage, including the two
  added source indexes, falls by 2,572,288 bytes or 25.8649%.
- Loose shadowing, pack fallback, traversal order, and exact-name lookup retain
  their source-qualified semantics.
- Writers must create or resolve a source marker before inserting entries, and
  readers must validate both the surrogate and natural source identity.
- Migration cost is bounded but higher than copying old rows because every
  projection is reconstructed and authenticated.

## Alternatives considered

- Keep the wide natural keys. This avoids a migration but preserves the measured
  storage overhead in every entry and secondary-index row.
- Keep only `raw_entry` and derive names with offsets and `substr`. This removes
  more bytes but complicates exact indexed lookup and weakens the independent
  cross-field corruption witness.
- Copy v11 derived rows into the narrow layout. This is cheaper but can preserve
  corruption that authoritative reconstruction is meant to remove.
