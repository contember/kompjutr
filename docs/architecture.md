# Architecture

## The rule

```
git objects / refs / index  →  SQLite (the Durable Object database)
working tree                →  DOFS
```

Never:

```
git objects → fake .git files → DOFS → SQLite
```

There is no `.git` directory. HEAD, refs, config, the index, loose objects and
received packfiles are rows. The working tree is ordinary files.

## Layers

```
        GitClient (Computer's interface)
                    │
        ┌───────────┴───────────┐
        │                       │
   Smart HTTP client      git commands
        │                       │
        └───────────┬───────────┘
                    │
                 Git core
             ┌──────┴──────┐
             │             │
          GitStore      Worktree
             │             │
          SQLite         DOFS
```

`src/core/` knows nothing about Computer. `src/sqlite/` is the store. Only
`src/computer/` names Computer at all, and it holds three things:
`createSqliteGitClient()`, `ComputerWorktree`, and the facade that maps the
`GitClient` interface onto the op functions.

## Repository model

A repository is a row:

```sql
CREATE TABLE git_repositories (
  id   INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  head TEXT NOT NULL          -- "ref: refs/heads/main", or an oid when detached
);
```

Several repositories can live in one workspace. A `cwd` resolves to the
repository whose `root` is its nearest registered ancestor — the walk in
`SqliteGitDatabase.find()`. `nestedRoots()` gives the inverse, so a working-tree
walk stops at a nested repository. That is the one job the `.git` directory used
to do for free.

`head` lives on the repository row rather than in `git_refs`, because HEAD is not
a ref: it is the one piece of state that is always exactly one value.

## Object database

Pack-native, following dgit. An incoming pack is written **verbatim and still
compressed** into 1 MiB chunk rows and indexed:

```
oid → git_pack_objects → (pack_id, offset, data_off, data_len, base_oid)
                       → read only the chunks that entry spans
                       → inflate, then resolve the delta chain
```

Delta chains are walked through index lookups *first* — bounding the chain length
and catching cycles before anything is inflated — then applied upward from the
base, holding at most two inflated buffers at a time.

Locally created objects start as loose rows (`git_objects` +
`git_object_chunks`, zlib-deflated and chunked). A future repack can fold them
into a pack; nothing depends on that happening.

### Bounded memory

Every cache is budgeted in **bytes**, never in entries and never proportional to
repository size:

| Cache | Default | Holds |
| --- | --- | --- |
| pack chunk LRU | 4 MiB | still-compressed `git_pack_data` rows |
| object LRU | 16 MiB | inflated objects, shared by loose and packed reads |
| single entry admission | 2 MiB | an object larger than this is never cached |
| buffered pack entry | 8 MiB | above this, an entry is streamed, never held |

An object too large to materialise is inflated incrementally and hashed as the
bytes go past, so its id is known without ever holding it. That is the one place
`node:zlib` cannot serve, because it cannot report how much of the input a
finished stream consumed — pako's incremental `Inflate` can, and is used for
exactly that.

## Crash safety

Network ingest is provisional until the whole pack is proven:

```
insert git_pack_meta with state='pending'
  → stream chunks, hashing all but the trailing 20 bytes
  → verify the trailer
  → index every entry, drain deferred deltas
  → mark the pack 'complete'
  → move refs, in one transactionSync
```

Reads only see complete packs. An interrupted fetch leaves every existing ref
valid and one pending pack, which the next ingest reclaims. A clone that fails
removes its own repository row, because the destination had none before the call.

Local atomic changes go through `Database.transactionSync()`. Computer's wrapper
reserves transaction handling for that method — a bare `BEGIN` would open a
transaction its resolve cache cannot see.

## Index

Git's *logical* index, not the `.git/index` binary format:

```sql
CREATE TABLE git_index (
  repo_id INTEGER NOT NULL,
  path    TEXT NOT NULL,
  stage   INTEGER NOT NULL,
  mode    INTEGER NOT NULL,
  oid     TEXT NOT NULL,
  size    INTEGER,        -- working-tree facts recorded when the entry
  mtime   INTEGER,        -- was written, so status can skip re-hashing
  ino     INTEGER,
  PRIMARY KEY (repo_id, path, stage)
);
```

This is the point of the whole experiment. Computer's `git.commit` exhausts the
isolate memory between 535 and 985 tracked files because isomorphic-git
materialises the entire index; optimising DOFS underneath did not move that
ceiling (see `benchmark-reference.md`). A row per path is never materialised
whole.

`size` / `mtime` / `ino` are a DOFS-shaped optimisation, deliberately kept out of
the generic core API: `indexMatchesStat()` consumes them, and everything above it
only knows that a path may or may not need re-hashing.

## Worktree

`Worktree` is a small synchronous interface — `stat`, `readFile`, `writeFile`,
`readlink`, `symlink`, `readdir`, `mkdirp`, `unlink`, `rmdir`, `chmod`. Synchronous
because status and checkout walk thousands of paths, and the DOFS provider already
offers a synchronous surface.

`ComputerWorktree` binds it to `SQLiteWorkspaceProvider` through the provider's
**public** filesystem methods only. No reaching into `vfs_*` tables: correctness
first, and a Computer-specific fast path for `status` is a later, measured
decision — not a starting assumption.

## Protocol

Smart HTTP, protocol v0, client side. One round trip that ends in `done` serves
both clone and incremental fetch: the server computes the common set from the
`have`s it was given, so nothing needs multi-ack.

Ingest is streaming end to end:

```
HTTP body → pkt-line reader → side-band demux → pack parser → SQLite chunks
```

The pkt-line reader never holds more than one frame. A full pack is never
assembled into a single `Uint8Array`.

The remote wire format is standard git. The local representation deliberately is
not.

## Known scaling limits

Two are worth stating plainly, because neither is solved here.

**Pack bytes sit in the Durable Object's SQLite.** `git_pack_data` chunk rows
are charged against the per-object database, so total pack storage is capped by
it. dgit hit the same wall from the server side and moved the pack bytes to R2
in v0.0.2, keeping only the index in SQLite — pack storage stops being capped,
and a cached clone streams from the Worker without loading the cell at all.
The same split would work here: `git_pack_objects` is already the only table a
read consults to locate an entry, so the bytes behind `readRaw` could come from
an R2 mount instead of a chunk row without anything above it noticing. Out of
scope for the first spike, and agent-scale workspaces are nowhere near the cap.

**Object ids are hashed in JavaScript.** `Sha1` runs at roughly 200 MB/s, which
is fine for the trailer and for locally created objects but is paid once per
object during ingest. `crypto.subtle.digest("SHA-1", …)` is native and much
quicker, and is byte-identical — dgit measured about 24x. It is async, so using
it means threading a promise through the buffered-entry path in `#indexPack`.
Worth doing when a clone benchmark says the hash is actually the cost; not
worth doing blind.
