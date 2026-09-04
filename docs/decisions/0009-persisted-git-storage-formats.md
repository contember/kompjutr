---
id: 0009
title: Choose the persisted Git storage formats
status: accepted
date: 2026-08-26
---

# 0009 — Choose the persisted Git storage formats

## Context

Three identities dominate the Git schema's stored bytes: object IDs, the
filesystem content identity that maps a file body to a blob, and the parsed tree
projection that makes tree traversal a SQL join. Each had an obviously cheaper
encoding, and each cheaper encoding moved cost somewhere else — to a conversion
at every API boundary, to a lost abstraction, or to an unbounded table.

They are recorded as one decision because they trade the same currency and were
measured the same way: bytes on disk against work at the boundary. Reopening any
one of them means re-running that comparison, not arguing from key size alone.

## Decision

**Object IDs stay lowercase hexadecimal `TEXT`.** Core Git APIs use hex strings,
so a 20-byte `BLOB` would encode a string on every write and decode bytes on
every read unless the core representation changed too. The representative
[OID encoding measurement](../reference/oid-encoding-measurement.md) compared
real BLOB bindings against TEXT over both a packed and a loose-shaped workload,
after proving identical row counts, decoded OID sets and order, and traversal
results. BLOB reduced the packed database by 7.6% and the loose-shaped database
by 24.3%, but with conversion to the hex-string API included, point lookups were
14.5–16.7% slower, tree traversal 60.0–75.6% slower, and representative
multi-parent commit traversal 42.1% slower. Boundary encoding alone cost about
4.5 times the TEXT validation.

`git_commits.parents` remains an ordered, space-separated list of hex OIDs. It is
not a scalar OID column and must not be changed mechanically alongside the key
columns.

**Filesystem content identities stay opaque, and their Git mapping is a bounded
disposable cache.** The filesystem mints `contentId` as a writer-owned identity;
checkout normally writes the blob OID bytes, but imports and external writers may
choose another representation. Git must never infer an object ID from those
bytes, because that would make the public filesystem boundary false.
`git_blob_ids` maps identity to blob OID only to avoid re-reading unchanged file
bodies, and every consumer recovers from a miss by hashing the authoritative
bytes.

Each repository retains at most 65,536 mappings, and an identity is cacheable up
to 256 bytes, which bounds stored identity payload at 16 MiB. Lookups and updates
run in bounded pages; a writer publishes each page as one generation and
transactionally evicts older generations, so an update larger than the cache
keeps its newest pages. An oversized or evicted identity is a cache miss, and a
miss produces the same Git-visible result.

**Parsed trees are keyed by an integer source surrogate.** Repeating the natural
identity `(repo_id, tree_oid, storage, source_id)` in every entry primary key,
every name-index row, and every trigger made the projection substantially larger
than the tree objects it represents. Each loose or complete packed tree source
now gets an integer `source_key`; entries use `(source_key, ordinal)`, and the
effective `(repo_id, tree_oid)` row points at the selected surrogate through a
composite foreign key that also matches its natural repository and tree identity.

Narrowing the key must not merge sources, so the semantics the traversal depends
on are preserved explicitly: an explicit incomplete-source marker represents a
visible authoritative source whose projection is not yet valid, which keeps
loose-over-pack shadowing fail-closed; pending packs stay invisible; and a packed
delta base cannot resolve through an unrelated loose entry. `name_bytes` is the
only stored name representation and remains the canonical BINARY value for Git
ordering and exact lookup; bounded readers derive TEXT names.

Under [ADR-0004](0004-trust-stored-rows-validate-at-the-boundary.md), projection
rows are trusted at read time. Source qualification exists for shadowing and
delta-base correctness, not as a corruption witness, and columns kept purely as
read-time cross-validation witnesses were retired.

## Consequences

- Git operations avoid byte-to-hex conversion at every SQLite boundary, at the
  cost of rows and B-trees larger than a binary representation. Ad hoc SQLite
  inspection stays readable and matches the values the public API exposes.
- The filesystem stays Git-agnostic, and external writers may keep their own
  stable identity format.
- Cache storage and update memory have explicit structural limits. Current
  mappings keep the zero-body-read fast path; older or oversized identities cost
  a file read and a hash. Eviction can affect performance but never correctness.
- Every new mapping writer must use the shared generational update path; direct
  unbounded writes are outside the storage contract.
- Entry primary keys and the name index no longer repeat the wide natural source
  identity or a duplicate TEXT name. The representative fixture's combined
  tree-schema storage fell by 25.9%.
- Writers must create or resolve a source marker before inserting entries.

Reopen the OID encoding if the core API adopts binary OIDs, if database size
becomes a measured production constraint, or if an operation-level probe shows an
end-to-end benefit after conversion. A reopened comparison must retain the
equivalence checks and cover compound parent lists; key size alone is not enough.
Any such migration must rebuild the parsed-tree keys in the same pass, so the
keyed tables migrate once.

## Alternatives considered

- **Store every scalar OID and packed parent list as `BLOB`.** Materially lowers
  storage, especially without pack payload, but regressed every measured
  operation while the core consumes strings.
- **Store key OIDs as BLOB and leave payload OIDs as TEXT.** Avoids some
  conversion but creates two boundary representations and still rebuilds the most
  connected tables, with no measured operation-level benefit.
- **Define `contentId` as the raw blob OID and drop `git_blob_ids`.** Removes the
  indirection but breaks the filesystem abstraction and invalidates foreign
  identities the API already permits.
- **Prune only identities no longer referenced by `fs_nodes`.** Preserves the
  abstraction but still leaves a live repository with an unbounded cache and
  needs a potentially large reachability sweep.
- **Fail a valid clone that produces more mappings than the cap.** The mapping is
  optional, so refusing the Git operation would turn a performance optimization
  into a correctness dependency.
- **Keep the wide natural tree keys.** Avoids a migration but keeps the measured
  overhead in every entry and secondary-index row.
- **Store only raw entry bytes and derive names with offsets and `substr`.**
  Removes more bytes but complicates exact indexed lookup.
