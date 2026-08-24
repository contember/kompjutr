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

## Three-way integration planning

The internal integration engine accepts base, current, and incoming tree OIDs
and returns a mutation-free delta relative to the current tree. It does not
write objects, refs, index rows, or worktree files. Clean entries either reuse
an existing identity or retain the bounded bytes and computed OID of a new
merged blob. Conflicts carry exact base/current/incoming identities; text
conflicts also carry marker bytes, while binary conflicts retain current bytes.

The structural phase merge-joins three authoritative tree cursors. It resolves
identity and mode dimensions independently, recognizes file/directory prefixes
without materializing directory trees, and leaves symlink and gitlink conflicts
structural. Equal-root pruning still validates object metadata and the effective
tree source. File/directory conflicts use logical paths; label-derived relocation
is handled by the merge lifecycle that owns index and worktree writes.

Only divergent regular files reach the content phase. Their OIDs are read in
bounded prefixes rather than through scalar path lookups. Each returned prefix
must preserve request order and object hashes are recomputed before use. The
byte-oriented xdiff port handles merge, diff3, and zdiff3 markers without UTF-8
decoding; NUL-bearing inputs become binary conflicts.

An integration plan admits at most 1,000 entries, 200,000 source rows, 4 MiB of
structural state, 32 MiB of retained plan state, and 16 bulk blob-read calls.
The SQL model is at most 134 statements: six tree statements plus eight for each
bulk read. Caller-owned state stays within the packed reader's 8 MiB headroom.
A shared 64 MiB exclusion reservation is acquired before any tree cursor opens,
then reduced to conservative live-state and xdiff peaks. Capacity and corruption
fail closed before exposing a partial plan.

## Merge lifecycle

Local merge targets the checked-out symbolic branch and accepts two commit heads.
A bounded graph pass distinguishes already-merged, fast-forward, divergent,
unrelated, and shallow histories. Multiple best bases are recursively combined
through clean synthetic commits inside the enclosing transaction. Their temporary
trees use Git-compatible conflict markers and never update a ref.

The final integration plan is projected to physical index and worktree paths.
Text and binary conflicts write stages 1–3 and marker/current bytes. Structural
file/directory conflicts relocate the file side to a collision-checked
`~<label>` path. One outer `transactionSync()` covers temporary objects, output
objects, worktree changes, index stages, merge state, and the final ref update.
The composed SQL estimate includes graph selection, virtual-base work, final
planning, and apply; an operation that cannot remain below 1,000 statements
fails before its transaction becomes visible.

Merge preflights the current, projected, and final index shape before tree
construction. The operation accepts at most 10,000 leaf paths, 4 MiB of full
path bytes, 4,096 tree objects, and 16 MiB of serialized tree data. Worktree
overwrite checks scan at most 50,000 rows and hash at most one 1,000-path batch
or 30 large-file range reads. The retained integration plan stays reserved with
24 MiB of execution headroom through projection, application, and commit.

Clean divergent merges create a commit with ordered current/incoming parents.
`commit: false` and conflicts persist schema-v9 merge metadata plus bounded
snapshots for only merge-owned paths. A deterministic integrity identity binds
every saved parent, option, and snapshot row; unauthenticated v8 pending state is
cleared during migration. Native `mergeContinue()` and ordinary `commit()`
finalize the saved parents after all stages are resolved.
`mergeAbort()` first reconstructs ownership from the authoritative parents, then
restores those index/worktree paths and their structural ancestors. Unrelated
worktree content is preserved, and a structural blocker makes abort fail closed.
Compatibility clients expose only single-shot merge, so a conflict is rolled
back and reported as `EMERGEFAIL` instead of leaving unreachable pending state.

## Pull composition

Pull is a two-phase composition rather than a second integration engine. Before
network work, it validates the checked-out symbolic branch and reads bounded
`branch.<name>.remote`, `branch.<name>.merge`, remote URL, `pull.ff`, and
`pull.rebase` values. Explicit remote and branch selectors take precedence over
lower-priority configuration. Rebase requests fail explicitly; supported pull
integration delegates every graph, index, worktree, and commit decision to merge.

Fetch publishes a complete validated pack and the selected remote-tracking ref in
its existing transaction. Pull then revalidates the captured symbolic HEAD, local
OID, and upstream configuration before invoking merge. A concurrent HEAD change
fails with `ESTALEHEAD`; an upstream change fails with `ESTALEUPSTREAM`. These
checks happen after the fetch because no SQLite transaction spans an HTTP await.
Consequently, a successful fetch remains visible after a later fast-forward-only
refusal, dirty-worktree refusal, stale-state error, or integration conflict, while
the local branch, index, worktree, and merge state retain merge's atomicity.

Native pull returns `MergeResult`. Conflicts and `commit: false` use the same
schema-v9 journal as local merge and can be continued or aborted after a restart.
The Computer compatibility contract returns `void` and exposes no recovery
methods, so compatibility pull uses single-shot merge: conflicts roll back local
integration and report `EMERGEFAIL`, but do not discard fetched objects or the
tracking ref.

## Sparse workspace tracking

Schema v7 adds a source-qualified index over raw tree-entry name bytes. Sparse
hydration can therefore resolve selected paths in loose or complete packed
trees without scanning either full tree. The lookup still validates each parsed
source against its authoritative object and preserves loose-source precedence.

`git_index_state` and `git_index_dirty` form a conservative change journal. An
available state has the current tracker format, a valid nullable baseline tree
OID, and `complete = 1`. Completeness means that the dirty rows cover every
mutation since that baseline; it does not mean that the workspace is clean.
SQLite triggers OR index and worktree dirty flags for semantic index changes,
cached stat changes, and filesystem mutations. Changes that cannot be
represented safely, including ignore-file and repository-root topology changes,
invalidate the state instead of guessing.

The tracker becomes authoritative only through a bounded reseal. The bulk
initial-clone path seeds it after writing the initial index and working tree. An
unfiltered full `status` can repair an unavailable tracker from the exact HEAD,
index, and worktree merge. A successful sparse `status` recomputes the retained
dirty flags and advances the baseline to the current HEAD. If the complete seed
does not fit its limits, the tracker remains unavailable.

Sparse operations use the journal differently:

- `status` combines dirty paths with the baseline-to-HEAD tree difference,
  hydrates only those leaves, and reseals after a successful exact result.
- working-tree `diff` uses the same candidate union without mutating the
  tracker; tree-to-tree `diff` can use the bounded relational tree difference
  directly.
- clean whole-tree `checkout` requires an available baseline equal to HEAD, an
  empty dirty journal, and no blocking index entries. It verifies the hydrated
  leaves and the current working tree before applying the leaf difference, then
  moves HEAD and reseals an empty journal at the target tree.

Hydration admits at most 1,000 strict Git-ordered paths, 2,200 UTF-8 bytes per
path, 1 MiB of request JSON, and 8 MiB of retained result state. Tree depth,
edge work, parsed-source entries, source bytes, and worktree payloads have
separate caps. Sparse checkout budgets candidate, guard, and plan state within
the retained-state allowance. It separately rejects a conservative SQL estimate
that would exceed the 1,000-statement operation ceiling. Its retained caller
state fits the packed-blob reader's 8 MiB headroom; the complete packed-read
model remains below 100 MiB.

Capacity exhaustion, unavailable or incompatible tracker state, and unsupported
sparse shapes return to the exact full operation. Malformed tracker state
metadata also makes that state unavailable. Malformed dirty or hydration rows,
inconsistent source markers, reordered or missing hydration results, and tree
disagreements are corruption and fail closed; they never silently select the
fallback path.

## Ignore matching

Ignore files are discovered as regular-file handles, so a symlink named
`.gitignore` is never followed. Loading is paged and fail-closed. Raw rules,
file count, pattern count, compiled bytes, source index, and dynamic matcher work
all have explicit caps.

Patterns compile to byte-oriented deterministic matchers. Git wildmatch edge
cases, UTF-8 byte semantics, malformed classes, escapes, and globstars are
checked against real Git. Rule lookup uses a bounded exact source index and
charges collision comparisons by bytes examined.

## Smart HTTP

Clone and fetch stream incoming `upload-pack` responses directly into a
provisional pack. Push discovers `receive-pack`, plans one branch update against
the freshly advertised refs, and streams a replayable full-object pack. A 401
opens a new body stream from the immutable OID plan; network failures never
automatically replay a POST.

The outbound planner walks validated commit projections and changed tree edges.
It subtracts locally known advertised remote closures, excludes gitlinks, and
reserves the worst-case two-pass SQL cost before starting the POST. The server's
advertised old OID is included in the ref command, so a concurrent remote update
is rejected by the server. Local remote-tracking refs move only after a complete
`report-status` success.

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
1,000 changed paths. Tracker-backed `status`, `diff`, and clean whole-tree
`checkout` avoid full-repository traversal when their sparse guards and budgets
hold. Cold or invalid tracker state, path-filtered status, local checkout
changes, and capacity fallback still use the exact full operation; checkout
must also perform the required physical writes.

Other deliberate limits include the 2,200-byte emitted Git path cap, bounded
commit projections, bounded ignore inputs, bounded protocol negotiation, and
fail-closed oversized materialization. `RpcHost` is a declared future seam only.

The current native Next.js workflow and its measurement caveats are recorded in
[`benchmark-current.md`](benchmark-current.md).

## Shell

`kompjutr/shell` applies the same cost model to a command surface: a command is
a bounded query over `Filesystem`, not a walk over a tree. Parsing and planning
are pure — `src/shell/plan/` imports nothing from `src/fs/` — and every
filesystem call the executor makes is counted against an operation ceiling, so a
command written without a limiter still returns a bounded result. The command
set, the ceilings, and the deliberate divergences from bash are specified in
[`shell.md`](shell.md).
