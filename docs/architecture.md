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

### Ops read in streams, not in maps

Every op used to open its sources as maps and arrays: the HEAD tree, the target
tree, the index, the working-tree walk. Four of them were live at once in
`checkout`, three in `status` and in `diff`. Peak memory followed the number of
tracked files, and it followed it several times over.

All four sources are ordered by the same key. `git_index` has `(path, stage)` as
its primary key and SQLite orders TEXT by UTF-8 bytes; git's tree order, where a
subtree sorts as `name/`, makes a depth-first tree walk emit full paths in that
same order; the working-tree walk sorts its siblings by the same rule. So they
can be merged directly, one item of state per side:

| Op | Sources merged |
| --- | --- |
| `status` | HEAD tree x index x working tree |
| `checkout` | target tree x index (blockers also join the HEAD tree) |
| `add` | working tree x index x HEAD tree (for `commit -a`) |
| `reset`, `diff` | tree x index, or tree x tree |
| `commit` | the index alone, straight into the tree builder |

`comparePaths` is the one comparator all of them use. JavaScript's `<` is not
it: `<` compares UTF-16 code units, so an astral code point sorts before U+E000
by its leading surrogate, while its UTF-8 encoding sorts after. Getting that
wrong would desynchronise a merge rather than merely misorder output.

The index is read through `RepoStore.indexScan()`, which pages on `(path,
stage)` — on the path alone, a page boundary between stage 0 and stage 2 of one
path silently drops a row. Writes go through `indexApply`, a sink that flushes
in batches. A scan and a sink can run together as long as mutations stay at or
behind the frontier the scan has already handed out, which is what every op here
does.

### What is still proportional to something

Nothing claims constant memory. The honest bound for an optimised op is:

    O(page + widest live directory + output + largest single object)

- **page** — 512 index rows by default.
- **widest live directory** — `readTree` and `readdir` each hand back one whole
  directory. A flat tree of 10,000 entries is still 10,000 entries live. Fixing
  that needs an incremental tree parser and a paged `readdir`, and neither
  exists here.
- **output** — `status` returns its rows, `diff` returns its patch. That is the
  caller's data, not bookkeeping.
- **largest single object** — a packed delta cannot be reconstructed without its
  full base in memory. Loose objects stream through `readChunks`; packed ones
  yield whole, and `readBlob` materialises either. Working-tree files above
  512 KiB are hashed and stored through `writeStream` without ever being held;
  below that they are read in one go, because streaming costs a second pass over
  the content and buys nothing for a small file.
- **`status` collapsing** — `-unormal` must know which directories hold
  something tracked before it meets the first untracked file, and the answer can
  lie later in path order. That set is bounded by directories, not by files.

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
