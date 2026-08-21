# Architecture

## Runtime boundary

One `Workspace` owns one SQLite adapter. Its filesystem and Git client share
that adapter:

```text
Workspace
├── Database                         Durable Object SQLite adapter
├── Filesystem                       raw synchronous filesystem
│   └── NodeFsCompat                 Node-style facade
├── Git                              lazy native client
│   ├── command operations
│   ├── repository and object store
│   └── Smart HTTP client
└── ProcessHost?                     optional exec seam, not wired to the shell
```

The root package exports the native runtime. `kompjutr/fs` exposes the database
and filesystem without Git. `kompjutr/git` exposes the native Git interface and
factory. `kompjutr/shell` exposes the command surface over a `Filesystem`; it is
constructed separately and is not reachable from `Workspace`.
`kompjutr/compat/computer` is the only production entry point allowed to depend
on `@cloudflare/computer`.

Dependencies run one way. `shell` and `git` may depend on `fs`; neither may be
depended on by it, and `shell` never imports `git` — a consumer that wants
`git` in the shell registers it as a command.

## Filesystem

The working tree is stored directly in Durable Object SQLite:

```text
fs_paths   canonical path, inode, revision
fs_nodes   type, mode, size, timestamps, link count
fs_chunks  bounded file-content chunks
```

Paths are resolved component by component. Symlink traversal preserves POSIX
ordering, detects cycles, enforces a follow limit, and rejects oversized paths
before constructing large prefix sets. Mutations update path, node, and chunk
state in one synchronous transaction and bump one revision.

Bulk operations are part of the public seam. Scans use keyset cursors. File
discovery returns revision-bearing regular-file handles without following final
symlinks. Handle reads revalidate the whole batch before exposing any BLOB, so a
stale or corrupt handle cannot amplify a result or allocate from forged size
metadata.

## Repository model

Several repositories can share one workspace. The nearest registered ancestor
of a requested directory selects the repository. Nested repositories are
excluded from parent working-tree scans.

Repository state is relational rather than a fake `.git` tree:

- `git_repositories` stores the root and HEAD.
- `git_refs`, `git_config`, and `git_shallow` store repository metadata.
- `git_index` stores one row per path and stage.
- `git_objects` and `git_object_chunks` store locally created objects.
- `git_pack_*` stores received pack bytes and their index.
- `git_tree_*` stores source-qualified parsed tree edges.
- `git_commits` stores validated parsed commit projections.

No operation depends on a `.git` directory.

## Objects and packs

Small loose objects are stored raw. Larger loose objects are zlib-compressed and
chunked. A write hashes the exact bytes that become visible; streaming writes
reject content that changes between the hash and storage passes.

Incoming packs remain compressed. Pack ingestion is provisional:

```text
pending pack metadata
  → bounded pack chunks
  → object and delta index
  → parsed tree and commit projections
  → trailer and graph validation
  → complete state and ref updates
```

Only complete packs are readable. Interrupted or rejected ingest cannot move a
ref. Packed object reads schedule compressed ranges in physical order, resolve
delta chains iteratively, preserve packed-base precedence, and use
provenance-qualified cache keys.

The modeled packed-read peak is below 100 MiB. It includes delta inputs and
result, compressed rows, chunk and object caches, parser batches, and inflater
headroom. Inputs that cannot fit the model fail before allocation.

## Tree traversal

Tree objects are parsed when they become visible. The index records exact raw
entry bytes, source identity, ordinal order, and cumulative queue accounting.
A single recursive SQLite cursor performs a depth-first traversal through
primary-key lookups. It does not read object BLOBs and has no outer sort.

The cursor accounts for every live queued row. Completed sibling state is
reclaimed. A directory is expanded only when the exact conservative suffix plus
the complete child group fits the 16 MiB traversal budget. The emitted path cap
is 2,200 UTF-8 bytes. Both limits fail closed.

Loose sources shadow packed sources. Parsed rows remain source-qualified, so a
corrupt loose duplicate cannot borrow a valid packed projection and a packed
delta base cannot accidentally resolve through an unrelated loose cache entry.

## Commits and log

New commit objects must produce a valid cache projection atomically with object
visibility. Malformed, oversized, unsafe-numeric, or otherwise uncacheable new
commits are rejected. The cache stores identities and messages as bytes so NUL
and Unicode content round-trip exactly.

Short bounded logs retain the lazy point-read path. Larger logs use one
source-validated recursive graph cursor, validate the collected graph for
cycles, then reproduce Git's stable timestamp order in bounded JavaScript
state. Shallow boundaries and DAG convergence are handled explicitly.

## Ordered operations

Tree, index, and filesystem sources use the same UTF-8/Git path order. Hot
operations merge their streams instead of issuing scalar reads per path:

- `status` merges HEAD, one bounded index snapshot, and filesystem metadata.
- `diff` batches unresolved working-tree hashes and loose or packed blob reads.
- `checkout` batches removals, object reads, writes, and index mutations.
- `add`, `reset`, and `commit` use bounded index and object sinks.

`comparePaths` is the shared comparator. JavaScript string order is not valid
because it compares UTF-16 code units rather than Git's byte order.

## Ignore matching

Ignore files are discovered as regular-file handles, so a symlink named
`.gitignore` is never followed. Loading is paged and fail-closed. Raw rules,
file count, pattern count, compiled bytes, source index, and dynamic matcher work
all have explicit caps.

Patterns compile to byte-oriented deterministic matchers. Git wildmatch edge
cases, UTF-8 byte semantics, malformed classes, escapes, and globstars are
checked against real Git. Rule lookup uses a bounded exact source index and
charges collision comparisons by bytes examined.

## Transactions and trust boundaries

`Database.transactionSync()` delegates every nesting level to Durable Object
storage. It never emits SQL transaction statements, which the platform rejects.
SQL cursors must be truly iterable; traversal never falls back to materializing
`toArray()`.

Every SQL row is untrusted. Numeric, text, BLOB, source, size, revision, ordinal,
and cumulative fields are validated before use. Derived tree and commit rows are
validated against an authoritative loose object or complete packed source.

## Resource limits and open performance work

Operations have explicit statement, binding, BLOB-result, retained-state, and
cache gates. The target is at most 1,000 SQL statements and less than 100 MiB for
every accepted operation. Operations that exceed an accepted structural limit
throw a stable error instead of truncating or continuing unbounded.

The separate wall target is below 0.1 seconds for operations touching at most
1,000 changed paths. Full-repository `status` and `checkout` do not yet meet it:
even when only 1,000 paths changed, exact semantics still traverse the full HEAD
tree, index, and working tree, and checkout must perform physical writes. These
are current release blockers, not hidden exceptions.

Other deliberate limits include the 2,200-byte emitted Git path cap, bounded
commit projections, bounded ignore inputs, bounded protocol negotiation, and
fail-closed oversized materialization. `RpcHost` is a declared future seam only.

## Shell

`kompjutr/shell` applies the same cost model to a command surface: a command is
a bounded query over `Filesystem`, not a walk over a tree. Parsing and planning
are pure — `src/shell/plan/` imports nothing from `src/fs/` — and every
filesystem call the executor makes is counted against an operation ceiling, so a
command written without a limiter still returns a bounded result. The command
set, the ceilings, and the deliberate divergences from bash are specified in
[`plans/shell.md`](plans/shell.md).
