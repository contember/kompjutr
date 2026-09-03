# src/fs — the filesystem

A POSIX-shaped filesystem whose entire state is three tables in Durable Object
SQLite: `fs_paths` (path → inode, revision), `fs_nodes` (type, mode, size,
times, link count), `fs_chunks` (bounded content chunks).

```
filesystem.ts   assembles the Filesystem from the store layer
types.ts        the public interface — read it before adding a method
path.ts         comparePaths, dirname, subtreeSuccessor, codePointLength
store/          resolve, scan, search, read, write, remove, ops, meta
store/{initial-write,read,scan,write}/  cohesive helpers behind store facades
compat/node.ts  NodeFsCompat — the synchronous Node-style facade
import.ts       bulk import of an external tree
```

## The bulk API is the product

Single-path calls exist for compatibility. The reason this layer was written is
`scan`, `globPage`, `listEntries`, `discoverFiles`,
`discoverFilesContaining`, `readFileHandles`, `readFiles`, `writeFiles`,
`copyFiles`, and `touchFiles`. Reads and discovery use indexed, bounded pages;
copy keeps content inside SQLite; touch changes metadata without reading file
bodies. `writeFileStream` is the atomic bounded sink for a chunk producer. A
checkout of 9,329 files costs ~420,000 statements through a per-path API and a
constant handful through this one.

When you add a capability, add it as a bulk, paged, budgeted operation. A
convenience wrapper that loops over a single-path call is a regression, however
readable it looks.

## Rules

- **`fs_paths.path` is always a real path.** If `/a` symlinks to `/b`, then
  `/a/c` is stored as `/b/c`. `store/resolve.ts` is the sole producer of a
  `RealPath`; a lexical path reaching the store shadows its own target. Never
  build a store query from an unresolved path.
- **`RealPath` is a type-level receipt that resolution happened.** Pass it
  through; do not re-derive it, and do not widen a parameter to `string` to
  avoid resolving.
- **Handle reads revalidate the whole batch before exposing any BLOB.** A stale
  or corrupt handle must not amplify a result or allocate from forged size
  metadata. Keep the revalidation ahead of the allocation.
- **Discovery does not follow a final symlink.** `discoverFiles` returns regular
  files only. This is what stops a `.gitignore` symlink from being followed.
- **`substr()` counts code points over TEXT and bytes over BLOB.** Mixing them
  is silent — right row count, every value sliced at the wrong boundary after
  the first non-ASCII byte. Use `codePointLength` for the TEXT side.
- **The platform caps a GLOB pattern at 50 bytes.** Longer patterns must be
  split or rejected, not silently truncated.
- One mutating *call* bumps the revision once, not once per row.
- Mutations land in a single `db.transactionSync()`: path, node, and chunk state
  together.
