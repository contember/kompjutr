# src/core — the Git engine

Pure Git over a `Repository` and a `Worktree`. Nothing here knows about
Durable Objects, HTTP transport wiring, or `@cloudflare/computer`.

## Layout

```
ops/         one file per command family; each takes (repo, worktree, options)
repository.ts  objects and refs reachable from the store
worktree.ts    the working-tree interface ops write through
objects.ts     parse/serialise blobs, trees, commits, tags
pack/          delta resolution and pack writing
protocol/      Smart HTTP: pkt-line, negotiation, transport
diff/          LGPL-2.1-or-later port of git's xdiff — see below
ignore/        gitignore discovery and byte-oriented matchers
streams.ts     comparePaths, joinSorted, joinSorted3 — the merge-join primitives
```

`src/git/client.ts` is the only place that assembles ops into a public API. An op
throws `UnsupportedOperationError` rather than falling back to another
implementation.

## Cost model — this is the point of the module

A hot op merges **sorted streams**; it never issues a read per path.

- `status` merges the HEAD tree stream, one bounded index snapshot, and
  filesystem metadata through `joinSorted3`.
- `diff` batches unresolved working-tree hashes and blob reads.
- `checkout` batches removals, object reads, writes, and index mutations.
- `add`, `reset`, `commit` write through bounded index and object sinks.

A file is hashed only when the stat data cached in `git_index` no longer holds,
so a repeated `status` over an untouched tree reads no content at all. Adding a
per-path `readFile` or a scalar SQL lookup inside a loop is the regression this
module exists to prevent.

## Rules

- **Tree traversal reads no object BLOBs.** `ops/tree-stream.ts` walks the parsed
  edge index (`git_tree_*`) through primary-key lookups in one recursive cursor.
- **Loose sources shadow packed sources, and rows stay source-qualified.** A
  corrupt loose duplicate must not borrow a valid packed projection, and a packed
  delta base must not resolve through an unrelated loose cache entry.
- **Pack ingest is provisional.** Only a complete, trailer-validated pack is
  readable, and an interrupted or rejected ingest can never move a ref.
- **A new commit must produce a valid cache projection atomically with object
  visibility.** Reject malformed, oversized, or unsafe-numeric commits instead of
  storing an object the cache cannot represent.
- Emitted git paths cap at 2,200 UTF-8 bytes; the tree traversal budget is
  16 MiB. Both fail closed.

## diff/ is not MIT

`src/core/diff/` is LGPL-2.1-or-later, ported from git's xdiff. Keep the SPDX
headers, keep `src/core/diff/LICENSE`, and do not move this code into an
MIT-licensed directory.
