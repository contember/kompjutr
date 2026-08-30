# src/core — the Git engine

> **Direction change (2026-08-30).** ADR-0018 replaced the untrusted-row
> doctrine and ADR-0017 (rewritten) removes the memory-reservation ledger; the
> layout moves into `src/git/` per ADR-0019. Where the rules below conflict
> with those ADRs or root `CLAUDE.md`, the ADRs win.

Git operations and Smart HTTP over a `Repository` and a `Worktree`. Nothing here
knows about Durable Objects or `@cloudflare/computer`; HTTP stays behind `GitHttpClient`.

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

`src/git/client.ts` alone assembles ops into the public API. Ops throw
`UnsupportedOperationError` instead of falling back.

## Cost model — this is the point of the module

A hot op merges **sorted streams**; it never issues a read per path.

- `status` merges the HEAD tree stream, one bounded index snapshot, and
  filesystem metadata through `joinSorted3`.
- `diff` batches unresolved working-tree hashes and blob reads.
- three-way integration joins three tree streams, then batch-reads only divergent regular files.
- `checkout` batches removals, object reads, writes, and index mutations.
- `add`, `reset`, `commit` write through bounded index and object sinks.

A file is hashed only when the stat data cached in `git_index` no longer holds,
so a repeated `status` over an untouched tree reads no content at all. Adding a
per-path `readFile` or a scalar SQL lookup inside a loop is the regression this
module exists to prevent.

SQL cost is measured in `bench/`. At most 1,000 statements is a performance
target, not admission: a miss is optimization evidence and never a reason to
project, reserve, or refuse query work. Runtime failures protect only real
memory, format, platform, corruption, or structural limits.

## Rules

- **Tree traversal reads no object BLOBs.** `ops/tree-stream.ts` walks the parsed
  edge index (`git_tree_*`) through primary-key lookups in one recursive cursor.
- **Loose sources shadow packed sources, and rows stay source-qualified.** A
  corrupt loose duplicate must not borrow a valid packed projection, and a packed
  delta base must not resolve through an unrelated loose cache entry.
- **Pack ingest is provisional.** Only a complete, trailer-validated pack is
  readable; interrupted or rejected ingest never moves a ref.
- **Push preflights both pack passes before POST.** Reopen a pack only for a 401
  auth retry; never replay a network-failed POST. Move tracking refs only after
  complete `report-status`; uncertain results leave them untouched.
- **A new commit must produce a valid cache projection atomically with object
  visibility.** Reject malformed, oversized, or unsafe-numeric commits instead of
  storing an object the cache cannot represent.
- Give Git paths and traversals no component byte ceiling. Validate grammar,
  charge simultaneously live values to the shared operation owner
  (`MemoryCoordinator` in `src/memory.ts`, reached through `context.ts`), and
  surface only real memory, format, platform, corruption, or structural failures.

## diff/ is not MIT

`src/core/diff/` is LGPL-2.1-or-later, ported from git's xdiff. Keep the SPDX
headers, keep `src/core/diff/LICENSE`, and do not move this code into an
MIT-licensed directory.
