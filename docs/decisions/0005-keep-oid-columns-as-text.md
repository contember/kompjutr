---
id: 0005
title: Keep persisted OIDs as hexadecimal text
status: accepted
date: 2026-08-25
---

# 0005 — Keep persisted OIDs as hexadecimal text

## Context

Schema v11 persists SHA-1 OIDs as 40-character lowercase `TEXT` in object, pack,
commit, ref, index, and parsed-tree tables. Core Git APIs also use hex strings.
A 20-byte `BLOB` makes keys smaller, but every SQLite write would encode a string
and every read would decode bytes unless the core representation changed too.

The representative [OID encoding measurement](../reference/oid-encoding-measurement.md)
compared real BLOB bindings with TEXT. It retained the standard Next.js pack and
also used a loose-object-shaped workload so pack payload could not hide key
overhead. The prototype mirrored production rowid organization, indexes, and
representative unchanged payload. Both variants proved identical row counts,
decoded OID sets and order, and commit/tree traversal results before timings were
accepted.

BLOB reduced the packed database by 7.6% and the loose-shaped database by 24.3%.
With conversion to the current hex-string API included, BLOB point lookups were
14.5–16.7% slower, tree traversal was 60.0–75.6% slower, and the representative
multi-parent commit traversal was 42.1% slower. BLOB boundary encoding alone was
about 4.5–4.6 times the TEXT validation cost.

## Decision

We will keep persisted OID columns as lowercase hexadecimal `TEXT`. We will not
add a schema v12 OID migration, and backlog 22 can close.

`git_commits.parents` remains an ordered, space-separated list of hex OIDs. It is
not a scalar OID column and must not be changed mechanically with key columns.

## Consequences

- SQLite rows and B-trees remain larger than a binary representation.
- Git operations avoid adding byte-to-hex conversion at every SQLite boundary.
- Schema v11 repositories need no coordinated rebuild of every OID-keyed table.
- Ad hoc SQLite inspection stays readable and matches values exposed by the core
  API.
- A future BLOB proposal must coordinate with parsed-tree key rebuilding so the
  keyed tables migrate once, as described by backlog 21.

Reopen this decision if the core API adopts binary OIDs, database size becomes a
measured production constraint, or a Durable Object operation-level probe shows
an end-to-end benefit after conversion. A reopened comparison must retain the
equivalence checks and cover compound parent lists; key size alone is not enough.

## Alternatives considered

- Store every scalar OID and packed parent list as `BLOB`. This materially lowers
  storage, especially without pack payload, but regressed the measured operations
  while the core consumes strings. It would also require a schema-wide bounded
  migration.
- Store key OIDs as BLOB but leave payload-only OIDs and parents as TEXT. This
  avoids some conversion but creates two boundary representations and still
  requires rebuilding the most connected tables. The prototype did not show an
  operation-level benefit that justifies that complexity.
