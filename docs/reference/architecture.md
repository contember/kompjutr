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
compat/                            optional @cloudflare/computer adapter
```

`src/db/` is the shared storage kernel. It defines the structural SQLite
interfaces, normalizes rows and SQLite size failures, delegates synchronous
transactions to Durable Object storage, and owns routing limits shared by the
filesystem and Git. `GitError` originates there because SQLite error
normalization is below the Git domain; `git/common/errors.ts` re-exports it and
adds Git-specific subclasses.

The package exports `kompjutr`, `/fs`, `/git`, `/git/shell`, `/shell`,
`/compat/computer`, and `/testing`. The shell is not a `Workspace` property. A
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
`@cloudflare/computer` is confined to `compat`.

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

`git/store/index.ts` is the facade. `database.ts` owns schema initialization and
repository/checkout routing. `shared.ts` composes repository-owned families.
`checkout.ts` composes a checkout-bound store. Cohesive table families own
objects, refs, config, shallow state, fetch publication, indexes, reflogs,
operation journals, packs, sparse projections, and maintenance.

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
Out-of-band mutation of `git_*` tables is undefined behavior.

Algorithm and concurrency checks remain. These include traversal cycle and
termination guards, compare-and-swap checks, revisions, maintenance epochs,
ingest leases, provisional visibility, and the pack-deletion delta-closure
check.

## Structural cost bounds

There is no dynamic memory-accounting ledger and no projected statement
admission rule. Work is bounded by construction:

- traversals use lazy `db.iterate()` cursors;
- merge joins retain only bounded lookahead;
- object, index, filesystem, protocol, and journal work uses fixed pages and
  batch flush points;
- caches and queues have fixed capacities;
- a single-value or enumeration cap survives only when it names a real format,
  platform, memory, or structural failure;
- caller-unbounded materialized results fail instead of truncating.

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
split into 1 MiB `git_object_chunks` rows. Incoming packs stay compressed and
are split into 1 MiB `git_pack_data` rows. The pack delta workspace uses a
separate operation-local pool of 64 KiB chunks; that size is not the database
row size. No object above 48 MiB is ever stored: reads materialise one object as
a single buffer, so the worktree stat, the loose write paths, pack ingest, and
the `size` `CHECK`s all refuse it with `E2BIG` at the boundary.

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
SQL transaction statements. Clone, fetch, push, pull, maintenance repack, and
promise-hydrating content operations cross asynchronous boundaries after
repository state has opened.

- Clone hides partial state behind a renewable provisional owner generation.
- Ordinary pack ingest uses one renewable five-minute generation lease per
  repository. A live competitor gets `EBUSY`; an expired owner is fenced with
  `ESTALE`.
- Fetch publication uses durable namespace generations, exact ref snapshots,
  shallow revisions, and atomic publication.
- Ref updates and integration publication use expected-state CAS checks.
- Maintenance records a repository root epoch. Root drift restarts discovery
  before destructive work. Maintenance pack batches have their own exact owner.
- Pending packs are durable but invisible; complete packs may survive a stale
  publication and be reused.

One live `Workspace` represents one Durable Object isolate. A second facade over
the same storage is a cold replacement after eviction, not a concurrent peer.
The complete outcome matrix is in [concurrency.md](concurrency.md).

## Structural witnesses

Architecture rules are executable checks:

- `tests/import-graph.test.ts` parses every source import and enforces domain
  and Git-layer direction plus the compat-only optional dependency.
- `tests/public-exports.test.ts` keeps the root and Git entrypoint surfaces
  aligned through the restructure.
- The source-file ceiling witness rejects any `src/**/*.ts` file above 2,000
  lines.

Behavior remains covered by Git parity, filesystem conformance, end-to-end
journeys, and the focused store, pack, maintenance, and concurrency suites.
