# Concurrency and restart model

kompjutr relies on SQLite transactions for local mutations and explicit durable
checkpoints for work that must cross an asynchronous boundary. Supported public
Git mutation boundaries acquire one uncommitted `git_meta` guard row inside the
outer `transactionSync()`. A nested public mutation on the same database fails
with `EREENTRANT`; internal owned seams compose without reacquiring the guard.
The successful owner deletes the row before commit, and rollback leaves no
committed guard.

A returned `Promise` does not by itself make an operation concurrent. `clone`,
`fetch`, `push`, `pull`, the repack phase of `maintenance`, and content
operations that hydrate promised blobs await after they have opened repository
state. No guarded repository, index, or worktree publication phase holds the
local mutation guard across `await`; a later guarded phase reacquires it and
repeats its durable authorization checks. Fetch generations and namespaces,
pack-stream checkpoints, and similar async ownership instead use their own
transactions, epochs, CAS, or leases.

All other public Git methods finish their core mutation synchronously before
their async wrapper returns. They can run while an asynchronous owner is paused,
but they cannot interleave inside another local transaction. See
[ADR-0022](../decisions/0022-own-local-git-mutations-with-sqlite-transactions.md).

## Outcomes

The conformance suite uses these outcomes:

- **`coexist`** — both owners complete because their durable writes are
  disjoint or commute.
- **`stale-reject`** — the delayed owner detects changed expected state before
  its conflicting publication. Safe completed work, such as a complete fetched
  pack, remains available.
- **`active-reject`** — an existing operation journal rejects a public caller
  before network work or another integration starts.
- **`root-restart`** — a foreground mutation advances the maintenance root
  epoch. Maintenance discards stale traversal results and restarts the same run.
- **`busy/fenced`** — an exact durable owner excludes a competing claimant
  without blocking unrelated repository work.
- **`unfenced`** — a durable checkpoint has no expected-state or ownership
  guard for the named overlap. It is a current limitation, not a supported
  interleaving outcome.

## Durable boundaries

| Owner | Durable checkpoints |
|---|---|
| `clone` | Repository creation and routing; fetch pack and shallow state; ref/HEAD/config publication; initial index and worktree materialization. |
| `fetch` | Advertisement followed by a durable namespace generation and exact tracking/tag/shallow snapshot; pending pack reservation and streamed checkpoints; complete pack; atomic tracking/tag/prune/shallow publication. |
| `push` | Tracking-derived lease snapshot; discovery and per-destination lease comparison; local OID snapshot; remote receive-pack side effect; configured-remote tracking publication. |
| `pull` | HEAD, upstream, and strategy snapshot; all fetch checkpoints; snapshot revalidation; synchronous merge publication or captured-OID rebase journal and final branch CAS. |
| `maintenance` | Run allocation; root pages; mark pages; repack selection, pack publication, and finalization; sweep pages; finish or rollover. |
| promised blob hydration | Pinned promisor discovery; exact non-thin pack ingest; atomic physical publication and promise removal; synchronous operation retry. |

Pack data and index checkpoints are durable but invisible to object reads until
the pack becomes complete. Ref, HEAD, reflog, checkout, operation-journal, and
individual maintenance transitions publish through synchronous database
transactions. An operation plan and its anchors are immutable after creation;
replay changes only bounded mutable transition state. Its legal transition
predicates and branch publication CAS are concurrency checks, not read-time row
authentication.

Clone reserves its destination as a provisional repository with a renewable
five-minute owner generation. The root blocks traversal into a parent repository
but is absent from ordinary lookup and public store opens. A live same-root clone
gets `EBUSY`; exact expiry lets a cold retry remove only the abandoned tracked
state and allocate new monotonic identities. Each network and pack resumption
renews or validates the lease. A fenced owner gets `ESTALE` and cannot publish or
discard its replacement. Readiness publishes only after refs, configuration,
index, and initial worktree materialization are complete. The fallback
materializer rejects existing target-path collisions, then changes its index and
SQLite worktree in one transaction, so a failed write cannot leave an unindexed
clone path. Unrelated untracked paths remain outside cleanup ownership.

Ordinary pack leases last five minutes and renew only near half-life, so source
chunking does not add one SQL statement per chunk. Every async resumption checks
the local expiry before its next durable write; after takeover, the old owner
cannot write or publish. Pack IDs are monotonic across reclaim and deletion, so
a stale cache key cannot refer to replacement bytes.

Fetch allocates a repository-wide generation after discovery and records it as
the latest owner for every overlapping remote-tracking prefix. Publication
requires that generation, the namespace revision, and the exact tracking-ref
snapshot to remain current. Generic tracking mutations advance the revision,
including cross-store ABA changes. A stale owner gets `ESTALEFETCH` before any
ref or shallow mutation, while its complete pack remains readable. Disjoint
tracking namespaces commute unless they select a conflicting global tag or
both carry shallow deltas. Tags compare only the names the fetch actually
publishes; an identical concurrent winner is idempotent, while a different
target rejects the whole publication. On retry, an existing local tag is part
of the new snapshot, so auto-follow skips it and tracking publication can
proceed. Shallow boundaries are repository-wide,
so their authoritative discovery snapshot and durable revision serialize
otherwise disjoint depth fetches. Tracking refs, prune, remote HEAD, selected
tags, and shallow deltas commit in one transaction. A retry after a lost result
is a no-op and does not allocate new reflog ordinals. A depth retry whose
boundary was not published renegotiates shallow state even when the prior pack
already made the advertised tip complete.

Relative deepening and unshallow use the same shallow-revision CAS. Their
proposed boundary is authenticated before publication, and an aborted or stale
owner moves neither refs nor shallow rows. A successful retry negotiates from
the last published boundary even when an earlier attempt left a complete,
unreachable pack.

`git_pack_entries` authenticates every physical entry of each pack, including
duplicate OIDs. `git_pack_objects` remains the single canonical read location
for each OID. Publication compares the exact ordered rows with the digest made
while parsing and requires every entry's canonical owner to be complete.
Deleting that owner promotes one complete fallback entry atomically before the
old rows disappear. The structural closure check covers canonical and
non-canonical physical delta entries and requires every surviving dependency to
retain a base. Publication trusts the parse-time membership digests; deletion
does not re-hash stored objects. Page and read sizes shape the work, but
accumulated pages or projected reads do not reject it. Deletion rejects when a
surviving delta chain would lose its base or a real pack-cardinality, format,
delta, corruption, or structural bound is exhausted.

Promise rows do not become maintenance roots. A missing blob reached through a
tree is a valid terminal leaf only while the same repository owns its promise.
Hydration publishes a complete pack and removes matching promises in one
transaction; an interrupted pack leaves every promise intact. A mutable
`remote.<name>.url` must still match the pinned promisor URL before discovery.

## Current compatibility matrix

This matrix is organized by shared durable seam. It avoids duplicating every
public method that reaches the same synchronous transaction.

| Durable seam | Owners | Current behavior |
|---|---|---|
| Repository route and readiness | `clone` × clone/public calls | One exact provisional owner hides partial state while its root remains a traversal barrier. An active same-root clone gets `EBUSY`; exact-expiry cold retry replaces only the abandoned owner, and a fenced owner gets `ESTALE`. Different roots `coexist`. Ready publication follows complete refs, index, and worktree; fallback target collisions get `EEXIST`, and fallback index/worktree writes are atomic. |
| Ordinary pack ownership | `clone`/`fetch` × `clone`/`fetch` | One durable generation lease fences ordinary ingest per repository. An unexpired competitor gets `EBUSY`; expiry fences the old owner with `ESTALE`, reclaims only its pending pack, and allocates a never-reused pack ID. Unrelated local work still `coexist`s. |
| Maintenance pack ownership | `maintenance` × pack owners | Selected, pending, published, and finalized maintenance packs keep exact durable ownership and bypass the ordinary lease. Disjoint packs `coexist`; a publication whose canonical OID is still owned by another pending pack gets `stale-reject` and remains pending for exact recovery. If an ordinary complete owner wins first, maintenance finalizes against it and atomically discards its fully redundant pack. |
| Tracking refs, tags, prune, and shallow boundaries | `fetch`/`pull` × fetch/local mutation | The latest discovery fences each overlapping tracking namespace. Same-namespace drift and tracking ABA `stale-reject`; complete fetched objects remain. Disjoint namespaces `coexist` when selected global tags and shallow state do not conflict. Selected tags use exact CAS with an idempotent same-target winner. Repository-wide shallow deltas use a durable revision, so the first valid publisher wins and the loser retries. Local branches, index changes, and journals `coexist`. |
| Remote push leases and CAS | `push` × push/remote writer | Every explicit or pre-discovery tracking-derived lease is compared with discovery before hydration or pack planning. Any mismatch is `ESTALELEASE` with no receive-pack POST. A matching lease does not imply force. The discovered OID remains the wire CAS and produces `stale-reject` for a later remote writer. Before POST, confirmed cancellation is `EABORTED`; after invocation, every failure that leaves remote status unconfirmed is `EPUSHUNCERTAIN`. Fully consumed 401 responses and known-local pack failures retain their safe classifications. |
| Local push tracking ref | configured `push` × fetch/push | Push snapshots the raw tracking ref and its exact durable revision before POST. A fetch observation advances only exact revision rows inside its tracking prefix. After confirmed success push cold-reads, hashes, and parses the rediscovered or confirmed commit, then publishes only when the exact pre-POST snapshot is unchanged. Any later relevant fetch or push observation wins, including same-OID ABA; an idempotent push advances the exact revision and relevant namespace revisions to fence older owners. Explicit-URL push does not publish a local tracking ref. |
| Pull snapshot | `pull` × HEAD/upstream/journal/index/worktree mutation | Changed HEAD, upstream configuration, or strategy produces `stale-reject` after fetched state is retained. An active journal at invocation produces `active-reject`; pull rechecks state after fetch. Pull-rebase journals capture the fetched OID rather than a moving tracking ref. Overlapping staged or dirty paths reject integration; unrelated changes `coexist` with merge pull but rebase still requires its clean-worktree baseline. |
| Local refs, index, worktree, and operation journals | paused async owner × synchronous local call, or public mutation re-entry | Disjoint state normally `coexist`s. Each synchronous public mutation owns one outer transaction; same-stack public re-entry rejects with `EREENTRANT` before state changes. Ref and journal transitions publish atomically. Journal plans are immutable, and each replay step conditionally advances O(1) journal rows plus its bounded conflict snapshot. Interrupted add, path reset, and full index replacement may expose a valid page prefix; cold retry deterministically converges. Active merge, cherry-pick, revert, and rebase journals reject competing operation starts, preserve exact recovery state on stale branch CAS, and remain recoverable after reopen. A pull-created completed rebase journal survives final branch CAS failure and retries against its original branch OID. |
| Maintenance roots | `maintenance` × root mutation | Refs, index, checkout lifecycle, shallow state, commits, and operation journals advance the root epoch and produce `root-restart`. Each source is decoded from one bounded keyset page, including operation-root pages; epoch drift restarts before destructive work. Read-only work and config-only changes `coexist`. |
| Concurrent maintenance | `maintenance` × maintenance | One live `Workspace` keeps exact in-memory ownership of its durable pending pack. A rival call gets `EBUSY`; finalization and counters publish once. A cold `Workspace` denotes replacement after isolate eviction and therefore reclaims selected, pending, or published abandoned ownership exactly. |

One live `Workspace` models one Durable Object isolate. Two simultaneously live
`Workspace` facades over the same storage would conflict with the platform's
eviction boundary: the second facade is used only as a cold replacement, after
the old asynchronous owner can no longer resume.

## Network cancellation

Clone, fetch, pull, and push propagate one `AbortSignal` through discovery,
authentication retry, transfer, and their cooperative synchronous phases.
Clone and fetch check cancellation immediately before synchronous local
publication. Once that publication starts it runs to completion and the call
returns success. Before that point, `EABORTED` exposes no provisional clone,
new ref, shallow boundary, or incomplete readable pack.

Pull cancellation before fetch publication has the same `EABORTED` boundary.
After fetch publication, local merge or rebase runs synchronously; cancellation
does not roll back the fetched refs or interrupt a journal transaction.

Push distinguishes remote certainty from local tracking. Before receive-pack
POST invocation, cancellation is `EABORTED`. After invocation, cancellation,
transport loss, non-401 HTTP failure, malformed response, or invalid or
incomplete `report-status` is `EPUSHUNCERTAIN` because the remote side effect
may have happened. Known-local pack generation and authentication failures keep
their own codes. A fully consumed 401 is safe to authenticate and retry, and
cancellation before that retry remains `EABORTED`. Complete status fixes the
remote outcome. Cancellation during later tracking reconciliation is then
reported only as a failed `tracking` member of that confirmed `PushResult`; it
never changes the remote outcome into an exception. A cancelled POST is never
replayed.

## Direct witness map

Every supported matrix row has a deterministic witness. Test names below are
part of the qualification contract; a renamed or replaced test must preserve
the named schedule, cold checks, and bounds.

Statement figures in focused tests are coarse regression alarms. Representative
SQL and returned-row cost lives in `bench/`, where at most 1,000 statements is a
target. A target miss is optimization evidence, not a runtime refusal or a
reason to invalidate an otherwise correct durable outcome.

| Durable seam | Direct evidence | Cold and cost evidence |
|---|---|---|
| Repository route and readiness | [`concurrency-clone.test.ts`](../../tests/concurrency-clone.test.ts): “fences the real clone flow at every durable publication checkpoint”, “keeps reservation, complete pack, refs, and worktree private until the ready CAS”, and exact-expiry/collision/identity witnesses. | The real-flow witness replaces the evicted owner with a fresh `Workspace`; clone statement and composed-memory cost are measured separately. |
| Ordinary pack ownership | [`concurrency-pack.test.ts`](../../tests/concurrency-pack.test.ts): same-store overlap, separate-store active rejection, failed-owner retry, exact-expiry takeover, and duplicate/canonical ownership witnesses. | Reopened stores prove readable winner and fallback objects; pack statement and composed-memory cost are measured separately. |
| Maintenance pack ownership | [`concurrency-pack.test.ts`](../../tests/concurrency-pack.test.ts): pending dependency rejection; [`maintenance-repack.test.ts`](../../tests/maintenance-repack.test.ts): ordinary-winner finalization, selected/pending/published settlement, and local guard release/reacquisition around the asynchronous pack phase; [`maintenance-qualification.test.ts`](../../tests/maintenance-qualification.test.ts): pending fetch preservation. | Cold finalization tests authenticate every retained object and counter transition; the maintenance benchmark reports statement-target status and process-memory evidence. |
| Tracking refs, tags, prune, and shallow boundaries | [`concurrency-fetch.test.ts`](../../tests/concurrency-fetch.test.ts): both same-remote orders, prune, local tracking ABA, response loss, disjoint namespaces, selected tags, and both shallow orders. | Every terminal schedule reopens and runs the shared repository oracle. [`store.test.ts`](../../tests/store.test.ts) exercises 9,329 tracking refs and the real memory/input bounds; `fetch.publication` owns representative query cost. |
| Remote push leases, CAS, and local tracking | [`concurrency-network.test.ts`](../../tests/concurrency-network.test.ts): both push/fetch orders, same-OID fetch ABA, a buffered refresh losing to a post-snapshot fetch, a no-op push fencing an older fetch, both same-ref push orders, lease snapshots and remote races, authoritative refreshed/no-op commit reads, refresh failure, and preservation of HEAD/index/journal/maintenance state; [`push.test.ts`](../../tests/push.test.ts): rejection, response loss, abort certainty, leases, delete, no-op, and explicit URL; [`network-safety.test.ts`](../../tests/network-safety.test.ts): integrated real-backend abort/retry deepening and stale/fresh multi-ref leases. | Every concurrency schedule cold-reopens through the shared oracle; [`store.test.ts`](../../tests/store.test.ts) directly proves exact revision creation, prefix-scoped fetch observations, idempotent fencing, historical narrow/broad disjointness, maximal namespaces, and token ownership. `transport.push` measures configured and no-op push query cost without reserving a statement currency. |
| Pull snapshot | [`concurrency-network.test.ts`](../../tests/concurrency-network.test.ts): merge/rebase overlapping staged/dirty rejection and merge unrelated negative control; [`pull.test.ts`](../../tests/pull.test.ts): HEAD, branch OID, upstream, strategy, cancellation, captured target, and pull-created final-CAS recovery. | Concurrency schedules retain the fetch then cold-reopen through the shared oracle. The fetched pack and synchronous merge/rebase integration use the pack, checkout, journal, and branch-CAS publication bounds. |
| Local refs, index, worktree, and journals | [`concurrency-operations.test.ts`](../../tests/concurrency-operations.test.ts): every directed active merge/cherry-pick/revert cell, same-client/second-client/CLI/scratch/low-level re-entry, guard retention after a caught rejection, rollback, and stale branch CAS; [`operation-state.test.ts`](../../tests/operation-state.test.ts): immutable journal transitions and recovery. | Every schedule runs the shared oracle after reopen; merge, replay, rebase, and ref benchmark rows own representative query cost, including linear N/2N rebase transition rows. |
| Maintenance roots | [`maintenance-roots.test.ts`](../../tests/maintenance-roots.test.ts): every public root mutation shape and one-projection source pages; [`maintenance-qualification.test.ts`](../../tests/maintenance-qualification.test.ts): index, journal, commit, and fetch drift; [`concurrency-maintenance.test.ts`](../../tests/concurrency-maintenance.test.ts): push, exact ref, and sibling checkout drift. | Each principal concurrent schedule ends with cold `cat-file` and `status`; [`maintenance-cost.test.ts`](../../tests/maintenance-cost.test.ts) supplies the large-input memory envelope and the maintenance benchmark owns query cost. |
| Concurrent maintenance | [`concurrency-maintenance.test.ts`](../../tests/concurrency-maintenance.test.ts): selected owner to pending barrier, same-runtime `EBUSY`, once-only finalization, and cold selected/pending/published settlement. | Owner prefix/tail and rival calls are measured separately; every settled state is read through a fresh `Workspace`. |

The implementation seams are
[`network.ts`](../../src/git/ops/network.ts),
[`push.ts`](../../src/git/ops/push.ts),
[`pull.ts`](../../src/git/ops/pull.ts),
[`maintenance.ts`](../../src/git/ops/maintenance.ts), and
[`packs.ts`](../../src/git/store/packs.ts), with durable ownership in the
[`store/`](../../src/git/store/) families.

## Deterministic test model

Tests expose real boundaries with named promise barriers and SQL-state
predicates. A buffered transport barrier may retain a discovery or
receive-pack payload only up to 960 KiB, leaving 64 KiB helper headroom below
1 MiB; pack bodies remain streamed. `awaitBarrierEntry` races entry against
owner settlement without timers, so an operation that misses or fails before a
checkpoint reports the original failure instead of hanging. Tests run both
completion orders for async-owner pairs. An async owner paired with a
synchronous operation uses pause, synchronous mutation, and resume plus a
sequential control.

A cold reopen constructs a new workspace and database graph over the same
`DurableObjectStorageLike`. Sleeps, randomized scheduling, timing assertions,
and in-memory state shared with the discarded workspace are not conformance
evidence.

The shared
[`interleaving.ts`](../../tests/helpers/interleaving.ts) harness provides the
barriers and completion-order runner. The
[`repository-invariants.ts`](../../tests/helpers/repository-invariants.ts)
helper reopens fresh handles over the same storage and validates readable refs,
non-gitlink index objects, tracker rows, operation journals, and maintenance
state. Its static payload reads admit at most 512 KiB per ref or baseline object
and 32 MiB in total, with 1,024-OID metadata pages. Schedule-specific tests add
worktree, larger-object, and exact-owner assertions at the boundary they
control.

## Repository invariants

Every supported outcome must preserve these invariants after the schedule and
after a cold reopen:

- Every visible direct ref resolves to a readable object, and every symbolic
  ref resolves or is deliberately unborn.
- Every non-gitlink index OID resolves.
- A complete index tracker baseline and its dirty journal describe the current
  index/worktree relationship; an unavailable tracker is never treated as a
  valid cache hit.
- An active operation journal has an immutable plan accepted at creation,
  bounded mutable transition state, and a documented continue, skip, or abort
  path. Ordinary reads decode trusted rows; only a newly introduced result is
  authenticated.
- Pending packs remain invisible and cleanup removes only an abandoned exact
  owner.
- Maintenance state is resumable, and a stale root snapshot never authorizes
  deletion of a newer root.
- Statement cost is observable in benchmarks against the at-most-1,000 target;
  a miss does not change the durable outcome or authorize a runtime refusal.
- Each public call remains subject to the fixed batch, cache, queue, format, and
  structural result caps at the seams it crosses.

The qualification record and direct witness map are maintained in the archived
[concurrency and restart sprint](../archive/sprint-2026-08-27-concurrency-and-restart-conformance.md).
