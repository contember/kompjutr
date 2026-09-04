# Architecture

## Runtime composition

One `Workspace` creates one `Database` over Durable Object storage. The
filesystem is available immediately; the Git database and client are created on
first access. Both domains use the same SQLite database.

```text
DurableObjectStorageLike
└── db/Database                    SQL adapter and transaction boundary
    ├── fs/Filesystem              fs_* schema and bulk filesystem operations
    │   └── NodeFsCompat           synchronous Node-shaped facade
    └── git/SqliteGitDatabase      git_* schema and repository registry
        └── Git client             operations, CLI adapter, Smart HTTP

shell/                             separate query surface over Filesystem
runtime/Workspace                  composition and optional ProcessHost
```

`src/db/` is the shared storage kernel. It defines the structural SQLite
interfaces, normalizes rows and SQLite size failures, delegates synchronous
transactions to Durable Object storage, and owns routing limits shared by the
filesystem and Git. `GitError` originates there because SQLite error
normalization is below the Git domain; `git/common/errors.ts` re-exports it and
adds Git-specific subclasses.

The package exports `kompjutr`, `/fs`, `/git`, `/git/shell`, `/shell`, and
`/testing`. The shell is not a `Workspace` property. A
consumer injects Git into the shell through the explicit `kompjutr/git/shell`
adapter.

## Domains and dependency direction

The source tree has three behavior domains over the database kernel:

- `fs/` owns POSIX-shaped paths, nodes, content chunks, handles, and bulk file
  operations.
- `shell/` parses, plans, and executes bounded commands over `Filesystem`.
- `git/` owns Git objects, packs, refs, checkouts, protocol, operations, and
  public Git surfaces.

Git is layered bottom-up:

```text
common → diff | ignore | protocol → store → ops → client / cli / exports
```

`diff`, `ignore`, and `protocol` are independent peers. The store never imports
ops. Persisted journal codecs and capability contracts therefore live in the
store. Cross-domain dependencies also point down: `db` imports no domain, `fs`
uses only `fs` and `db`, and `shell` uses only `shell`, `fs`, and `db`.

Within a layer, cohesive command and table families live in semantic
subdirectories. These folders do not add dependency ranks. No source directory
contains more than 20 direct TypeScript files.

## Filesystem storage

The working tree is relational:

| Table | Owner | Purpose |
| --- | --- | --- |
| `fs_paths` | filesystem | canonical real path to inode |
| `fs_nodes` | filesystem | type, mode, size, timestamps, revision, link count |
| `fs_chunks` | filesystem | file content in 512 KiB rows |

Paths are resolved component by component before store access. Mutations update
path, node, and chunk state in one `transactionSync()` call and bump one
filesystem revision per public mutation. Scans use indexed path ranges and
keyset cursors. Discovery returns revision-bearing regular-file handles; batched
reads revalidate every handle before exposing content.

## Git storage and ownership

Several repositories can share one database. Each repository can have several
checkout-bound views. The nearest registered checkout ancestor selects the
view, and nested checkout roots are excluded from parent worktree scans.

| Owner | State |
| --- | --- |
| Repository (`repo_id`) | objects, packs, refs, ordinary config, shallow, fetch and promisor state, direct-ref reflogs, tree/commit projections, blob-ID cache, maintenance |
| Checkout (`checkout_id`) | canonical root, raw `HEAD`, index, tracker state, operation journal, checkout `HEAD` reflog |
| Source surrogate | `git_tree_entries` for one exact loose or packed tree source |
| Synchronous scratch transaction | named scratch indexes; rows never survive the callback and are not maintenance roots |

`git/store/index.ts` is the facade. `store/database/` owns schema initialization
and repository/checkout routing. `store/repository/` composes repository-owned
families. `store/checkout/` composes a checkout-bound store. Other table-family
directories own objects, refs, config, shallow state, fetch publication,
indexes, reflogs, operation plans, packs, sparse projections, and maintenance.
Operation plans are immutable after creation. A transition may change only `phase`,
`empty_reason`, the `current_step` cursor, `current_parent_oid`,
`replayed_count` and `skipped_count`, `committer_name` and `committer_email`,
the current step's `outcome` and `result_oid`, and the bounded conflict
snapshot.

There is no `.git` directory and no external filesystem runtime.

## Trusted-store contract

Validation happens at trust boundaries:

- Caller grammar, ranges, and options fail with `GitError`.
- Network framing, advertised values, pack trailers, object hashes, and pack
  membership are validated during ingest.
- Schema version and exact schema shape are validated when the Git store opens.
- Write paths and schema `CHECK` constraints validate values before they become
  stored state.

Reads trust rows written under that contract. `git/common/rows.ts` refines
driver values through `RowShape`, `expectText`, `expectSafeInteger`, and
`expectBlob`. A failed stored-row decode is `CorruptError`; it is not an
invitation to re-prove the row. Reads do not use SQL storage-class witnesses,
two-phase metadata preflights, or projection-to-object re-authentication.
Same-database sparse sources carry an internal receipt bound to the exact
`Database` instance; structural copies, wrappers, custom sources, and sources
from another database take the generic path. Out-of-band mutation of `git_*` or
`fs_*` tables is undefined behavior.

Algorithm and concurrency checks remain. These include traversal cycle and
termination guards, arbitrary-iterable ordering checks, conditional transition
predicates, compare-and-swap checks, maintenance epochs, ingest leases,
provisional visibility, and the pack-deletion delta-closure check.

## Structural cost bounds

There is no projected statement admission rule and no accounting ledger threaded
through signatures. Work is bounded by construction:

- traversals and loose-object payload decoding use lazy `db.iterate()` cursors;
- merge joins retain only bounded lookahead;
- object, index, filesystem, protocol, journal, sparse, and maintenance-root
  work uses fixed pages and batch flush points;
- native selected-path projection retains at most 1,000 distinct paths, each
  with up to four conflict-stage index rows; native workspace hydration bounds
  its 1,000-path request and retained index rows; commit-tree snapshot uses one
  global 1,000-item counter across its materialized results. An unavailable fast
  path falls back to the generic streaming implementation without truncation;
- caches and queues have fixed capacities;
- a single-value or enumeration cap survives only when it names a real format,
  platform, memory, or structural failure;
- caller-unbounded materialized results fail instead of truncating.

A byte budget is legitimate only when it charges bytes an operation actually
retains: the shell's intermediate pipeline buffers, and the caller-declared
integration plan ceiling. Five Git operations — push planning, full status,
rename detection, rebase planning, and selected-path staging — still charge a
hand-computed estimate of a JavaScript object's footprint on top of a structural
count cap that already bounds the same structure — except full status and
`clean`, where the byte charge is currently the only bound on the tracked-path
set. They are known exceptions tracked in [backlog 66](../backlog/66-retire-modeled-retained-byte-charges.md),
and no new one may be added
([ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md)).

At most 1,000 SQL statements and less than 100 MiB of process-transient memory
per representative operation are benchmark targets. A target miss is
optimization evidence, not a runtime refusal.

The memory harness runs each scenario twice under a CPU lease: calibration and
a capped run. The capped run uses an independent 512 MiB cgroup as a runaway
witness. Process memory is the reset `VmHWM` minus the immediate same-run
baseline, not the cgroup total. The current suite has 12 scenarios. All 12
capped scenarios pass the sub-100 MiB process target; the largest recorded
capped transient is 54,423,552 bytes.

## Objects, packs, and projections

Small loose objects are stored raw. Larger loose objects are compressed and
split into 1 MiB `git_object_chunks` rows. A loose read joins metadata and
ordered payload rows in one cursor, retains only the final output plus the
current payload feed and fixed inflater state, and checks sequence, encoded
size, inflate progress, and final size while decoding. Incoming packs stay
compressed and are split into 1 MiB `git_pack_data` rows. The pack delta
workspace uses a separate operation-local pool of 64 KiB chunks; that size is
not the database row size. No object above 48 MiB is ever stored: reads
materialise one object as a single buffer, so the worktree stat, loose write
paths, pack ingest, and the `size` `CHECK`s all refuse it with `E2BIG` at the
boundary.

Pack ingest is provisional:

```text
pending metadata
→ streamed 1 MiB pack rows
→ object and delta indexes
→ tree and commit projections
→ trailer and parse-time membership validation
→ complete pack and ref publication
```

Only complete packs are readable. Parse records an ordered digest for every
physical membership row. Publication compares the stored rows with those
digests; it does not re-read and re-inflate the whole pack. Pack deletion keeps
the structural rule that every surviving delta dependency has a surviving
base. Loose objects shadow packed objects, and projections remain qualified by
their exact source.

Tree objects are parsed into source-qualified edge rows when they become
visible. Tree walks use one recursive SQLite cursor and read no object BLOBs.
Commit projections are written atomically with new commit visibility. Hot
status, diff, checkout, add, reset, and commit paths merge ordered streams and
batch unresolved content reads and writes. The successful eager tracker-backed
sparse status path hydrates only the bounded dirty and baseline-to-HEAD
candidates and classifies exact renames from those rows; fallback full status
and `statusStream()` retain the ordered HEAD/index/worktree merge.

`blob:none` partial clones keep the complete commit/tree graph and record absent
blob OIDs in `git_promised_blobs`. Promises are metadata, not physical objects:
ordinary object availability remains false until a complete loose object or pack
atomically removes the promise. Async content operations hydrate exact missing
OID batches under one aggregate operation cap and ingest self-contained backfill
packs; synchronous reads fail with `EPROMISED`. Maintenance accepts promised
missing blobs only as terminal leaves.

## Concurrency seams

Local mutations finish inside synchronous SQLite transactions. Code never emits
SQL transaction statements. A supported public Git mutation acquires an
uncommitted `git_meta` guard row inside its outer transaction; same-stack public
mutation re-entry fails with `EREENTRANT`, while internal owned seams compose
without reacquiring it. The owner removes the row before commit, and rollback
leaves none. This is local transaction serialization, not a lease or a
cross-process lock
([ADR-0006](../decisions/0006-own-local-git-mutations-with-sqlite-transactions.md)).

Clone, fetch, push, pull, maintenance repack, and promise-hydrating content
operations cross asynchronous boundaries after repository state has opened.
No guarded repository, index, or worktree publication phase holds the local
mutation guard across `await`; a later guarded publication phase reacquires it
and repeats its authoritative durable checks. Fetch generations and namespaces,
pack-stream checkpoints, and other async ownership use their own transactions,
epochs, CAS, or leases rather than the local mutation guard.

- Clone hides partial state behind a renewable provisional owner generation.
- Ordinary pack ingest uses one renewable five-minute generation lease per
  repository. A live competitor gets `EBUSY`; an expired owner is fenced with
  `ESTALE`.
- Fetch publication uses durable namespace generations, exact ref snapshots,
  shallow revisions, and atomic publication.
- Ref updates and integration publication use expected-state CAS checks.
- Maintenance consumes each root source as a single decoded keyset page and
  operation journals through bounded root pages. A repository root epoch
  restarts discovery before destructive work. Maintenance pack batches have
  their own exact owner.
- Pending packs are durable but invisible; complete packs may survive a stale
  publication and be reused.

One live `Workspace` represents one Durable Object isolate. A second facade over
the same storage is a cold replacement after eviction, not a concurrent peer.
The complete outcome matrix is in [concurrency.md](concurrency.md).

## Structural witnesses

Architecture rules are executable checks:

- `tests/import-graph.test.ts` parses every source import and enforces domain
  and Git-layer direction, and keeps the value-import graph acyclic.
- `tests/public-exports.test.ts` keeps the root and Git entrypoint surfaces
  aligned through the restructure.
- `tests/trusted-read-policy.test.ts` exhaustively classifies the changed
  ordinary-read scopes. It rejects storage-class, authentication-shaped BLOB
  casts, `length`/`hex` witnesses, metadata preflights, detached journal
  identity, and whole-journal topology/object authentication without banning
  schema, write, ingest, stale-handle, JSON-ordinal, or exact algorithmic
  boundaries.
- The source-file ceiling witness rejects any `src/**/*.ts` file at or above 500
  lines.
- The same source-structure witness rejects any directory under `src/` with more
  than 20 direct TypeScript files.

Behavior remains covered by Git parity, filesystem conformance, end-to-end
journeys, and the focused store, pack, maintenance, and concurrency suites.
