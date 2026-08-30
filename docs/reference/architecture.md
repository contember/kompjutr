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

Several shared Git stores can live in one workspace, and each store can own
several checkouts. The nearest registered checkout ancestor of a requested
directory selects a checkout-bound `Repository` view. Nested checkout roots are
excluded from parent working-tree scans.

Repository state is relational rather than a fake `.git` tree:

- Global `git_meta` stores the schema version. `git_identity_control` allocates
  monotonic repository, checkout, and provisional-clone identities.
- Shared-store-owned tables cover repository lifecycle, fetch generations, and
  exact tracking-ref revisions (`git_repositories`, `git_fetch_namespaces`,
  `git_tracking_ref_revisions`), refs/config/shallow state, reflogs, loose
  objects and lifecycle, packs and ingest ownership, disposable blob/tree/commit
  projections, and resumable maintenance state and GC candidates. They use
  `repo_id`, except that `git_tree_entries` is owned through its source surrogate.
- Checkout-owned tables are `git_checkouts`, `git_index`, `git_index_state`,
  `git_index_dirty`, `git_operation_state`, `git_operation_steps`,
  `git_operation_touched`, and `git_checkout_reflog_entries`. Rows below
  `git_checkouts` use `checkout_id`.
- `git_scratch_indexes` and `git_scratch_index_entries` are repository-scoped
  transaction-local rows. They never survive a public scratch callback and are
  therefore neither checkout state nor maintenance roots.

`git_repositories` owns the shared identity, provisional-clone lifecycle, fetch
generation, and shallow revision. `git_checkouts` owns the immutable canonical
root, raw `HEAD`, and primary marker. Checkout views of the same store use one
shared object, pack, ref, config, shallow, fetch, maintenance, and cache
namespace. Their working trees, indexes, tracker state, operation journals, and
raw `HEAD` remain independent.

`src/sqlite/store.ts` is the compatibility facade for this model. Internal
contracts, database routing, shared-repository state, and checkout-bound state
live under `src/sqlite/store/`; production consumers continue to import only the
facade so internal table-family boundaries do not become package contracts.

The native `readTree()` and `writeTree()` methods target the selected checkout
index. `withScratchIndex({ name }, callback)` instead creates one named index
inside a synchronous outer transaction and passes a revoked-on-return handle
with `readTree`, `add`, `writeTree`, `commitTree`, and `replaySnapshot`. Nested
operations join the outer transaction. A throw, a returned thenable, or a caught
nested operation failure poisons and rolls back the whole session, including
newly written objects. Successful cleanup deletes the scratch header and
cascades its entries before the callback result becomes visible. The handle
cannot be reused after return, and no new maintenance lifecycle is required.

`replaySnapshot({ snapshot, onto })` accepts exactly one parent on the snapshot
commit. It plans the snapshot-parent/snapshot delta against `onto`, rejects
gitlinks, and projects structural conflicts to the physical paths Git uses. A
conflict returns ordered path/kind/stage rows without changing the selected
scratch index or object store. A clean result atomically seeds the scratch index
from `onto`, authenticates and writes merged blobs, applies only stage-zero
entries, and returns the bounded result-tree oid. The worktree, checkout index,
HEAD, refs, reflogs, tracker, and operation journal remain outside that scratch
transaction.

No operation depends on a `.git` directory.

Every Git-visible direct-ref or raw `HEAD` movement passes through one store
mutation seam. The seam captures raw and resolved old/new endpoints, applies the
ref change, assigns store-wide ordinals, appends the reflog rows, and prunes
retention in the same synchronous transaction. Moving a branch attached to any
checkout records the shared direct ref before that checkout's causal `HEAD`
entry, even when another checkout initiated the mutation. Failed, stale, no-op,
and rolled-back mutations record nothing.

A checkpoint restore composes separate public transactions: inspect the
snapshot, replay and optionally commit it through a scratch callback, apply the
clean tree with `readTree({ updateWorktree: true })`, then publish a direct ref
with `updateRef({ expected })`. This sequence is deliberately not atomic. If the
ref changes after tree application, publication throws `ESTALEHEAD`; the
checkout index and worktree keep the replayed tree, the tracker keeps its dirty
overlay, the rival ref and raw HEAD remain unchanged, replay-created objects
remain, no failed-publication reflog is appended, scratch rows are gone, and the
operation journal is unchanged. The caller must resynchronise or retry from that
explicit state.

Reflog reads are newest-first and page strictly before a store-wide ordinal.
Direct-ref retention is per shared ref; `HEAD` retention is per checkout. An
entry is active only while it is both at most 90 days old and among the newest
1,024 entries in its scope. `HEAD@{0}` through `HEAD@{1023}` select active
new-OID endpoints only from the checkout selected by the operation's directory.
`recoverRef()` selects an active old or new endpoint, verifies the object, and
moves one direct `refs/*` destination with expected-current CAS. Ref deletion
keeps its history for the active window. The internal active-root cursor combines
direct and checkout `HEAD` rows, validates them, streams distinct old/new OIDs in
byte order through one `db.iterate()` traversal, and accepts at most 9,727
physical rows. Its SQL state, 8 MiB object cache, 4 MiB pack-row cache, and 4 MiB
JS headroom total at most 100 MiB minus one byte.

Each store has exactly one primary checkout and at most 1,024 live checkouts.
Checkout roots are globally unique canonical absolute paths of at most 4,096
UTF-8 bytes; raw `HEAD` is at most 1,024 bytes. Listing is ordered by UTF-8 path
bytes and retains at most 6 MiB. A raw `HEAD` exactly attached to
`refs/heads/*`, including an unborn branch, owns that branch exclusively.
Retargeting releases and acquires ownership atomically, and another owner fails
with `EBRANCHINUSE`.

`worktreeAdd()` accepts a missing or empty root and an existing branch, new
branch, or detached target. Checkout registration, optional branch creation,
index initialization, and filesystem population commit or roll back together.
`worktreeRemove()` refuses the primary checkout, a live operation, and, unless
`force` is true, a dirty checkout. Force bypasses only dirtiness. Removal deletes
the filesystem root and checkout-owned rows while shared objects, refs, and
direct-ref history survive. `worktreePrune()` atomically removes only non-primary
checkouts whose exact roots are missing and fails the whole call if an eligible
checkout has a live operation.

`divergence()` resolves two caller-selected revision expressions and traverses
one shared reachable graph. It returns exact `ahead` and `behind` counts plus
`identical`, `ahead`, `behind`, `diverged`, `unrelated`, or `shallow`. The graph
retains at most 50,000 commits and 32 MiB. `readRef()` accepts exact `HEAD` or a
nonempty full `refs/...` name of at most 1,024 UTF-8 bytes and returns a
`symbolic`, `direct`, or `absent` result. It does not follow a symbolic target or
check object existence. `HEAD` reads the selected checkout; ordinary refs read
the shared store.

The blob-identity mapping is a disposable optimization, not an identity
contract. Filesystem writers may mint arbitrary content identities; Git never
interprets their bytes as object IDs. Each repository retains at most 65,536
cache rows. An identity longer than 256 bytes is not cached, so stored identity
payload is at most 16 MiB. Lookup and update callers have separate 16 MiB
retained-state limits that include row accounting. Writers publish each bounded
page as one generation and evict older generations transactionally. A miss or
eviction only makes the caller hash the authoritative file bytes again; it
cannot change the Git result. When a write contains more mappings than the cache
can retain, the newest pages survive and older mappings become misses.

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

Ordinary ingest holds one durable five-minute generation lease per repository.
An unexpired concurrent claimant gets `EBUSY`; exact expiry permits takeover and
the fenced owner gets `ESTALE` before another write. Pack IDs never repeat.
Maintenance keeps its separate exact batch ownership and does not use the
ordinary lease.

`git_pack_entries` records every physical entry per pack. `git_pack_objects`
selects one canonical readable owner per OID. A pack publishes only when all of
its entries have a complete canonical owner and exactly match the in-memory
digest produced while parsing the pack. Duplicate complete packs remain
authenticated. Deleting a canonical owner revalidates uncached fallback bytes,
promotes a complete source, and hashes each promoted object before old rows
disappear. The deletion audit includes delta children in every surviving
physical pack entry, not only canonical owners, and authenticates an exact loose
base when that is the surviving source. Full entries whose compressed form is
larger than the bulk-read limit are inflated and hashed through bounded uncached
windows. One authentication pass admits at most 48 MiB of output, 64 MiB of
compressed source, and 180 uncached pack-row reads across all pages and recursive
delta dependencies. Deletion rejects if the fallback's full delta-base closure
would not survive or the bounded audit cannot finish below the operation limits.

The modeled packed-read peak is below 100 MiB. It includes delta inputs and
result, compressed rows, chunk and object caches, parser batches, and inflater
headroom. Inputs that cannot fit the model fail before allocation.

## Repository maintenance

Each shared repository owns at most one durable maintenance run. The run moves
through root discovery, reachability marking, loose classification, repacking,
pack classification, loose and pack sweeping, and a terminal finish phase. One
public `maintenance()` call advances one bounded durable action and then reports
the validated stored phase and counters. Linked checkouts address the same run.

Root-changing transactions increment a repository epoch. Drift during root or
mark work reuses the root-discovery restart seam. Drift in a later phase first
settles any owned repack batch, then resets the same run to roots without
advancing a root page. Marks, shallow snapshots, reachability counters, and the
eligibility time are cleared; already published complete packs, candidate ages,
and destructive counters remain durable.

Reachable loose objects are published in validated full-object packs before
their exact loose and lifecycle rows are deleted. Unreachable loose objects and
wholly unreachable complete packs become candidates after a stable mark. Sweep
eligibility is fixed at 14 days after first classification. While the root epoch
is stable, a finished run with a future eligibility time remains terminal until
that exact time. Root drift rolls it over immediately. Rollover allocates a fresh
run ID and zeroed counters while preserving candidates.

## Tree traversal

Tree objects are parsed when they become visible. The index records exact raw
entry bytes, source identity, ordinal order, and cumulative queue accounting.
A single recursive SQLite cursor performs a depth-first traversal through
primary-key lookups. It does not read object BLOBs and has no outer sort.

Each loose or packed tree source has one integer `source_key`.
Entries use `(source_key, ordinal)` as their primary key, and the effective
`(repo_id, tree_oid)` row points to that exact source through a matching
composite foreign key. An explicit incomplete source marker preserves
fail-closed loose-over-pack shadowing before parsing succeeds. `name_bytes` is
the canonical BINARY lookup and ordering value; bounded readers derive the TEXT
name. `raw_entry` remains an independent cross-field corruption witness.

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

`writeTree()` preflights the selected ordered index before materialization and
rejects conflicts, corrupt rows, missing objects, and structural limits without
leaving partial objects. `commitTree()` authenticates an exact tree and up to two
ordered exact commit parents, resolves bounded identity precedence, preserves the
message bytes exactly, and writes one detached commit without changing any ref,
reflog, index, tracker, journal, worktree, or maintenance root.

Short bounded logs retain the lazy point-read path. Larger logs use one
source-validated recursive graph cursor, validate the collected graph for
cycles, then reproduce Git's stable timestamp order in bounded JavaScript
state. Shallow boundaries and DAG convergence are handled explicitly.

## Ordered operations

Tree, index, and filesystem sources use the same UTF-8/Git path order. Hot
operations merge their streams instead of issuing scalar reads per path:

- Full `status` shares one authoritative HEAD/index prepass with rename
  detection and prunes clean ignored directories only when its repair seed does
  not require their leaves.
- `diff` batches unresolved working-tree hashes and loose or packed blob reads.
- `checkout` traverses only active tree differences when its sparse guards hold,
  then batches removals, object reads, writes, and index mutations.
- Explicit `add` classifies exact files before requesting recursive directory
  facts. Its native selected-path source uses indexed equality lookups for the
  common exact case and retains the bounded generic fallback.
- `commit` snapshots the selected index once and reuses unchanged authenticated
  HEAD subtrees. `reset` and every commit path use bounded index and object
  sinks.

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
structural state, and 32 MiB of retained plan state. Blob reads continue through
progressing bounded batches; their accumulated call count does not reject the
plan. Caller-owned state stays within the packed reader's 8 MiB headroom. A
shared 64 MiB exclusion reservation is acquired before any tree cursor opens,
then reduced to conservative live-state and xdiff peaks. Capacity and corruption
fail closed before exposing a partial plan. The `merge.apply` benchmark records
statement cost against the at-most-1,000 target without turning a miss into a
runtime error.

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
There is no projected SQL admission across graph selection, virtual-base work,
planning, or apply. Benchmarks measure those operations against the
at-most-1,000-statement target; a miss is optimization evidence. The transaction
fails only for its real memory, format, corruption, CAS, or structural bounds.

Merge preflights the current, projected, and final index shape before tree
construction. The operation accepts at most 10,000 entries in one materialized
tree object and 4,096 tree objects. Cumulative full-path and serialized-tree
bytes do not reject the operation. The shared operation owner instead charges
the live directory stack, current serialization, staged objects, integration
plan, and worktree state while they coexist. Worktree overwrite checks scan at
most 50,000 source rows and retain bounded candidate and hash state. Hash
batches and large-file range reads may continue while they make progress; their
accumulated count does not reject the operation.

Native SQLite worktree reads use a private registered capability: realpath
results and exact scan-page metadata are admitted before result materialization.
The Computer compatibility worktree keeps its legacy materializing fallback;
that adapter is not an owner-safe worktree scan source.

Clean divergent merges create a commit with ordered current/incoming parents.
`commit: false` and conflicts persist authenticated merge metadata plus bounded
snapshots for only merge-owned paths. A deterministic integrity identity binds
every saved parent, option, origin, and snapshot row. Native `mergeContinue()`
and ordinary `commit()` finalize the saved parents after all stages are resolved.
The saved origin determines whether continuation records `merge: commit` or
`pull: merge`; the caller cannot choose it after restart.
`mergeAbort()` first reconstructs ownership from the authoritative parents, then
restores those index/worktree paths and their structural ancestors. Unrelated
worktree content is preserved, and a structural blocker makes abort fail closed.
Compatibility clients expose only single-shot merge, so a conflict is rolled
back and reported as `EMERGEFAIL` instead of leaving unreachable pending state.

## Cherry-pick and revert lifecycle

Cherry-pick and revert share one bounded replay planner and one durable recovery
lifecycle. The planner resolves a full or abbreviated object ID, ref, annotated
tag, or bounded `^` and `~` suffix. It selects the commit parent, reverses the
tree mapping for revert, and delegates the resulting base/current/incoming trees
to the same integration engine as merge. Root commits use the empty tree. Merge
commits require an explicit valid mainline.

Clean replay creates one commit whose sole parent is the original checked-out
HEAD. Cherry-pick preserves the source author and message by default and creates
a new committer identity. Revert creates new author and committer identities and
uses Git-compatible default messages. A caller can override the supported
message and identity fields through the native `Git` methods.

Conflicts and cherry-pick empty results persist one operation-step row plus
bounded snapshots for only replay-owned paths. Continue validates the
authoritative source, selected parent, original HEAD, labels, step row, and saved
path ownership before committing. Skip and abort restore the original index and
worktree state for those paths and preserve unrelated content. Each recovery
method requires its matching operation kind; ordinary commit cannot bypass a
pending replay.

`ReplayResult` reports `committed`, `conflicted`, or `empty`. Empty reason
`source` means the source tree equals its selected parent tree. Empty reason
`result` means the projected integration tree equals the current tree.
Cherry-pick suspends both empty outcomes for explicit cancellation, matching
Git's active empty-pick state. Revert completes an empty operation immediately.
Planning, apply, recovery, and journal transitions have no projected query-work
admission. Their representative costs live in the replay and rebase benchmark
rows; runtime still fails closed on authenticated journal ownership, CAS,
corruption, memory, and structural limits.

## Rebase lifecycle

Native rebase targets the checked-out symbolic local branch and accepts one
upstream revision. A bounded graph plan requires one unique merge base and a
linear first-parent range of at most 4,096 commits. It rejects selected merge
commits, ambiguous bases, unrelated or incomplete shallow histories, oversized
revision input, and capacity failures before creating recovery state.

The complete oldest-first replay queue is stored in ordered
`git_operation_steps` rows. Its integrity identity binds the original branch and
OID, resolved upstream and base, current cursor and parent, every source and
selected parent, per-step outcome and result OID, and any suspended touched-path
snapshots. Journal reads validate row types, order, retained bytes, object
authority, result-parent continuity, and topology before resumed work uses the
state. Existing cherry-pick and revert journals use the same table as one-step
sequences.

Each source delta reuses the replay planner and three-way integration engine.
Clean results create unpublished commits whose parent is the previous replay
result. The source author, author date, and exact valid UTF-8 message are
preserved; the committer is refreshed. Source-empty commits remain in the
rewritten history, while patches that become empty against the new parent are
skipped. Unsupported encoded or invalid-UTF-8 source messages fail before the
initial baseline or journal becomes visible.

The checked-out branch remains at its original OID while the index and worktree
track the current replay parent. Every cursor transition is its own bounded
transaction. Conflicts persist authenticated ownership for the current step;
`rebaseContinue()`, `rebaseSkip()`, and `rebaseAbort()` work after a cold reopen.
Abort restores the original tree, index, and worktree. After the last step, one
expected-old-OID update publishes the branch and clears the journal atomically.

`RebaseResult` distinguishes `up-to-date`, `conflicted`, and `completed` and
reports replayed and skipped counts where applicable. The native client exposes
the lifecycle methods; the Computer compatibility contract has no rebase
surface. While an operation is active, status, diff, add, and rm remain
available for conflict resolution. Ref-changing and network mutation methods
reject before writes, and hard reset atomically restores HEAD while clearing the
journal, including conflict-only paths absent from the target tree.

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
authenticated journal as local merge and can be continued or aborted after a
restart.
The Computer compatibility contract returns `void` and exposes no recovery
methods, so compatibility pull uses single-shot merge: conflicts roll back local
integration and report `EMERGEFAIL`, but do not discard fetched objects or the
tracking ref.

## Sparse workspace tracking

A source-qualified index over raw tree-entry name bytes lets sparse hydration
resolve selected paths in loose or complete packed trees without scanning either
full tree. The lookup still validates each parsed
source against its authoritative object and preserves loose-source precedence.

`git_index_state` and `git_index_dirty` form a conservative change journal. An
available state has the current tracker format, a valid nullable baseline tree
OID, and `complete = 1`. Completeness means that the dirty rows cover every
mutation since that baseline; it does not mean that the workspace is clean.
SQLite triggers OR index and worktree dirty flags for semantic index changes,
cached stat changes, and filesystem mutations. Changes that cannot be
represented safely, including ignore-file and repository-root topology changes,
invalidate the state instead of guessing.

The tracker becomes authoritative only through a bounded reseal. The shared
create-only initial materializer seeds it after atomically writing a missing or
empty worktree and an empty index; clone and eligible standalone checkout use
that path. Commit advances the baseline to the published tree while preserving
the dirty state that remains after publication. An unfiltered full `status` can
repair an unavailable tracker from the exact HEAD, index, and worktree merge. A
successful sparse `status` recomputes the retained dirty flags and advances the
baseline to the current HEAD. If the complete seed does not fit its limits, the
tracker remains unavailable.

Sparse operations use the journal differently:

- `status` combines dirty paths with the baseline-to-HEAD tree difference,
  resolves only those index and worktree leaves, and reseals after a successful
  exact result.
- working-tree `diff` uses the same candidate union without mutating the
  tracker; tree-to-tree `diff` can use the bounded relational tree difference
  directly.
- clean whole-tree `checkout` requires an available baseline equal to HEAD, an
  empty dirty journal, and no blocking index entries. A source-qualified
  active-frontier cursor produces only changed tree edges; an exact selected
  source then verifies the corresponding index and worktree leaves before the
  operation applies the difference, moves HEAD, and reseals an empty journal at
  the target tree.

Hydration admits at most 1,000 strict Git-ordered paths, 2,200 UTF-8 bytes per
path, 1 MiB of request JSON, and 8 MiB of retained result state. Tree depth,
edge work, parsed-source entries, source bytes, and worktree payloads have
separate caps. Sparse checkout budgets candidate, guard, and plan state within
the retained-state allowance. It does not reject a projected statement count;
the `sparse.prune` benchmark reports target status instead. Its retained caller
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

Every `lsRemote()`, fetch, or push call owns one fresh advertisement and one
root transport budget. `lsRemote()` validates and projects the advertisement
without mutation. Legacy fetch selection and compiled exact or one-star fetch
refspecs stream one `upload-pack` response into a provisional pack. Mapped fetch
authenticates every selected object root and publishes all exact destinations
in one fenced SQLite transaction; no failed member can leave a partial ref set.

Push expands its compiled mappings from one bounded local-ref snapshot before
network access, joins them with one `receive-pack` advertisement, and plans one
deterministic union pack for every active destination. Ref commands and public
results use destination UTF-8 byte order. Same-OID updates are reported but do
not enter the command set; a wholly empty wildcard expansion performs no HTTP.
The planner authenticates commit, tree, blob, and tag roots, rejects unsafe
namespace changes before POST, and subtracts an advertised closure only when
the local boundary proves it.

One replayable request carries up to 1,024 commands, optional atomic capability,
bounded push options, and at most one union pack. A 401 opens a new body stream
from the immutable plan; network failures never automatically replay a POST.
Complete report status resolves ordered per-ref acceptance and rejection.
Missing, extra, malformed, or incomplete status after the request may have been
consumed is classified as uncertain.

A clone first reserves its destination as a provisional repository with a
five-minute renewable owner generation. The provisional root blocks parent
worktree traversal but ordinary routing and public store opens cannot observe it.
The owner renews at discovery, pack, ref, and worktree boundaries. Exact expiry
allows a cold retry to remove the abandoned indexed paths and repository rows,
while preserving untracked files and allocating new monotonic identities. The
old owner is fenced with `ESTALE`. Readiness is published atomically only after
refs, configuration, index, and worktree state are complete; caught cleanup can
delete only the same provisional generation. The native empty-worktree path is
create-only and atomic. The fallback rejects exact and structural collisions
with existing clone targets, then changes the index and SQLite worktree in one
transaction, so failed writes cannot leave unindexed clone paths while unrelated
untracked paths remain caller-owned.

The outbound planner preflights both deterministic pack passes before starting
the POST and retains their live state under the transport memory owner. It does
not reserve a projected SQL currency; `transport.push` measures the query cost.
Every command includes the freshly advertised old OID, so a concurrent remote
update is rejected by the server. After complete status, push performs one
best-effort rediscovery and atomically reconciles successful branch tracking
refs through the same fenced publication seam as fetch. A hook-changed target
must be locally authenticated; otherwise reconciliation is deferred. Stale or
failed local reconciliation is returned separately and never hides the
confirmed remote result. Custom namespaces and explicit push URLs do not mutate
remote-tracking refs.

## Transactions and trust boundaries

`Database.transactionSync()` delegates every nesting level to Durable Object
storage. It never emits SQL transaction statements, which the platform rejects.
SQL cursors must be truly iterable; traversal never falls back to materializing
`toArray()`.

Every SQL row is untrusted. Numeric, text, BLOB, source, size, revision, ordinal,
and cumulative fields are validated before use. Derived tree and commit rows are
validated against an authoritative loose object or complete packed source.
Cheap affinity, shape, range, and enum checks also reject malformed projection
writes, but they do not replace read-time source authentication.

The undeployed Git schema has one version-1 baseline and no upgrade chain.
Initialization creates the complete current shape in one `transactionSync()`.
Reopen accepts only version 1 and validates the exact name, type, and SQL of every
Git schema object before returning. Partial, aliased, oversized, unexpected, or
unsupported schemas fail closed before creation can mask them. Fresh
initialization is measured by `schema.init` against the statement target and is
never refused from that count; exact reopen keeps its named two-query validation
shape. Untrusted schema metadata is projected through byte bounds and retains
less than 100 MiB.

## Resource limits and performance paths

At most 1,000 SQL statements is a benchmark target, not a runtime gate.
Representative statement and returned-row costs live in `bench/`; a miss is
optimization evidence and never manufactures a refusal. Runtime gates protect
real binding, BLOB-result, retained-memory, cache, format, platform, corruption,
and structural limits. They throw a stable error instead of truncating or
continuing unbounded.

The separate wall target is below 0.1 seconds for operations touching at most
1,000 changed paths. Native selected-path lookups, authenticated commit
snapshots, tracker-backed `status` and `diff`, and active-frontier whole-tree
`checkout` avoid full-repository traversal when their guards and budgets hold.
Cold or invalid tracker state, path-filtered status, structural checkout
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
