# src/git — the Git domain

Git operations and Smart HTTP over a `Repository` and a `Worktree`. Nothing in
this domain knows about Durable Objects or `@cloudflare/computer`; HTTP stays
behind `GitHttpClient`.

## Layers

```text
common/                      bytes, objects, errors, rows, paths, streams, hashes
diff/ | ignore/ | protocol/  independent algorithm and wire slices
store/                       SQLite tables, packs, projections, maintenance
ops/                         command families, Repository, Worktree, context
client.ts | cli/             public client and asynchronous argv surface
```

Dependencies point down this list. `diff`, `ignore`, and `protocol` may use
`common` but not one another. `store` never imports `ops`. `client.ts` assembles
ops into the public API; ops throw `UnsupportedOperationError` instead of
falling back.

`common/rows.ts` is the shared decoder kit. Stored-row shape failures become
`CorruptError`; caller-option failures become `GitError`. Reads decode only to
refine driver values: they do not re-authenticate stored data or add SQL
`typeof` witnesses. Write validation and schema `CHECK`s establish the trusted
store premise. Out-of-band database mutation is undefined behavior (ADR-0018).

`common/paths.ts` is the single home for Git-side path construction,
normalization, ancestry, prefix checks, and `comparePaths`. Do not add local
path kits in ops or store modules.

## Cost model

A hot op merges sorted streams; it never issues a read per path.

- `status` merges the HEAD tree stream, one bounded index snapshot, and
  filesystem metadata through `joinSorted3`.
- `diff` batches unresolved working-tree hashes and blob reads.
- Three-way integration joins three tree streams, then batch-reads only
  divergent regular files.
- `checkout` batches removals, object reads, writes, and index mutations.
- `add`, `reset`, and `commit` write through bounded index and object sinks.

A file is hashed only when its cached `git_index` stat data no longer holds, so
repeated status over an untouched tree reads no file content. A scalar SQL or
filesystem read inside a path loop is a regression.

SQL cost is measured in `bench/`. At most 1,000 statements is a performance
target, not admission. Memory is bounded structurally by streams, fixed batches,
caches, queues, and caps tied to real failures; there is no runtime byte ledger.

## Rules

- Tree traversal reads no object BLOBs. `ops/tree-stream.ts` walks parsed
  `git_tree_*` edges through the store cursor.
- Loose sources shadow packed sources, and projection rows stay
  source-qualified.
- Pack ingest is provisional. Only a complete, trailer-validated pack is
  readable; interrupted or rejected ingest never moves a ref.
- Push preflights both pack passes before POST. Reopen only for a 401 retry;
  never replay a network-failed POST. Move tracking refs only after complete
  `report-status`.
- A new commit must publish a valid cache projection atomically with object
  visibility.
- Do not add an arbitrary Git-path component ceiling. A path cap survives only
  when it names a real format, platform, memory, or structural failure.

## diff/ is not MIT

`src/git/diff/` is LGPL-2.1-or-later, ported from Git's xdiff. Keep the SPDX
headers and `src/git/diff/LICENSE`; never move this code into an MIT-only
directory.
