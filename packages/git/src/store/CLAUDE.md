# @kompjutr/git store — the Git SQLite store

The Git-owned schema and table families. SQLite contracts and routing limits
come from `@kompjutr/sqlite`; the DO filesystem owns its own `fs_*` schema.

## Module map

```text
index.ts       internal compatibility facade; consumers use this seam
core/          shared contracts, JSON paging, mutation guard, and the
               checkout mutation registry
database/      schema ownership, identities, lifecycle, and checkout registry
repository/    repository-scoped facade and scratch transactions
checkout/      composition root for one checkout-bound store
objects/       loose objects, object batching, and filesystem-content OID cache
refs/          refs, reflogs, configuration, and shallow boundaries
fetch/         promisor metadata and atomic fetch publication
indexes/       checkout/scratch indexes and filesystem change tracker
operations/    restartable merge, replay, and rebase state
schema/        editable schema version 1; no migrations
trees/         tree/commit projections and streaming walks
pack/          pack read, ingest, publication, deletion, and delta workspace
sparse/        sparse snapshots, selection, index rows, and tree resolution
maintenance/   roots, reachability, repack, sweep, and durable run control
@kompjutr/sqlite  database contract, GitError base, and routing limits
```

## Row ownership

`repo_id` owns shared objects, packs, refs, ordinary config, shallow state,
fetch state, direct-ref reflogs, projections, blob IDs, and maintenance.
`checkout_id` owns the root, raw `HEAD`, index and tracker state, operation
journals, and `HEAD` reflog. `git_tree_entries` is owned through its source
surrogate. `git_scratch_index*` rows are transaction-local and never become
maintenance roots. This boundary is ADR-0003.

## Trust and cost rules

- Validate caller input before storage and untrusted network bytes at ingest.
  Schema `CHECK`s and write-path validation establish the stored-row premise.
- Reads trust rows. Decode driver values through `common/rows.ts`; a shape
  mismatch is `CorruptError`. Do not add SQL `typeof` witnesses, two-phase
  metadata preflights, or read-time re-authentication. Out-of-band mutation is
  undefined behavior (ADR-0004).
- Caller mistakes are `GitError`, never corruption. Keep that distinction when
  moving validation between a family and its facade.
- Promised blobs are metadata, not physical objects or maintenance roots. Only
  complete object publication removes their promise rows.
- Traversals use `db.iterate()`. `db.all()` is only for bounded result sets.
- Bound allocation with fixed page, batch, cache, queue, and structural caps.
  Do not introduce projected statement admission or a byte-accounting ledger.

## Packs and maintenance

Received packs stay compressed in 1 MiB `git_pack_data` rows. The delta
workspace separately uses operation-local 64 KiB chunks. Publication validates
the trailer and compares stored membership with digests recorded during parse;
it does not re-read and re-inflate the pack. Only complete packs are readable.

Ordinary ingest uses a renewable five-minute repository lease and monotonic pack
IDs. Maintenance has exact batch ownership instead. One `maintenance()` call
advances one bounded durable action. Root mutations bump the repository epoch;
epoch drift restarts discovery before destructive work. Sweep eligibility is 14
days after stable classification. A loose object that a surviving pack still
names as a delta base is never nominated and never swept.

Pack code derives from dgit (MIT). Keep the attribution headers when splitting
or moving it. `../diff/` is a separate LGPL boundary.
