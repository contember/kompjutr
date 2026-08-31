# src/git/store — the Git SQLite store

The Git-owned schema and table families. The Durable Object adapter and shared
routing limits live below the domains in `src/db/`; the filesystem owns its own
`fs_*` schema.

## Module map

```text
index.ts             internal compatibility facade; consumers use this seam
contracts.ts         shared store contracts, tokens, and row value types
database.ts          schema ownership and repository/checkout registry
shared.ts            repository-scoped facade and scratch transactions
checkout.ts          composition root for one checkout-bound store
objects.ts           loose objects and object batching
config.ts            repository configuration
shallow.ts           shallow boundaries
blob-ids.ts          disposable filesystem-content to Git-OID cache
reflog.ts            shared ref and checkout HEAD histories
refs.ts              ref mutation, validation, and CAS publication
fetch-publication.ts discovery snapshots and atomic fetch publication
index-table.ts       checkout and scratch indexes
operation-journal.ts restartable merge/replay/rebase state
lifecycle.ts         identities, checkout lifecycle, provisional clones
json-pages.ts        shared bounded JSON-page helpers
pack/                pack read, ingest, publication, deletion, delta workspace
sparse/              sparse snapshots, selection, index rows, tree resolution
maintenance/         roots, reachability, repack, sweep, durable run control
tree-index.ts        parsed tree projections
tree-walk.ts         streaming tree and tree-diff traversals
commits.ts           commit projections and bounded graph reads
schema.ts            editable schema version 1; no migrations
../../db/            Database adapter, GitError base, routing limits
```

## Row ownership

`repo_id` owns shared objects, packs, refs, ordinary config, shallow state,
fetch state, direct-ref reflogs, projections, blob IDs, and maintenance.
`checkout_id` owns the root, raw `HEAD`, index and tracker state, operation
journals, and `HEAD` reflog. `git_tree_entries` is owned through its source
surrogate. `git_scratch_index*` rows are transaction-local and never become
maintenance roots. This boundary is ADR-0009.

## Trust and cost rules

- Validate caller input before storage and untrusted network bytes at ingest.
  Schema `CHECK`s and write-path validation establish the stored-row premise.
- Reads trust rows. Decode driver values through `common/rows.ts`; a shape
  mismatch is `CorruptError`. Do not add SQL `typeof` witnesses, two-phase
  metadata preflights, or read-time re-authentication. Out-of-band mutation is
  undefined behavior (ADR-0018).
- Caller mistakes are `GitError`, never corruption. Keep that distinction when
  moving validation between a family and its facade.
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
days after stable classification.

Pack code derives from dgit (MIT). Keep the attribution headers when splitting
or moving it. `src/git/diff/` is a separate LGPL boundary.
