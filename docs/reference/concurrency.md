# Concurrency and restart model

kompjutr relies on SQLite transactions for local mutations and explicit durable
checkpoints for work that must cross an asynchronous boundary. A returned
`Promise` does not by itself make an operation concurrent: only `clone`,
`fetch`, `push`, `pull`, and the repack phase of `maintenance` await after they
have opened repository state.

All other public Git methods finish their core mutation synchronously before
their async wrapper returns. They can run while one of the five asynchronous
owners is paused, but they cannot interleave inside another local transaction.

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
| `push` | Local OID snapshot; remote receive-pack side effect; configured-remote tracking publication. |
| `pull` | HEAD and upstream snapshot; all fetch checkpoints; snapshot revalidation; synchronous merge publication. |
| `maintenance` | Run allocation; root pages; mark pages; repack selection, pack publication, and finalization; sweep pages; finish or rollover. |

Pack data and index checkpoints are durable but invisible to object reads until
the pack becomes complete. Ref, HEAD, reflog, checkout, journal, and individual
maintenance transitions publish through synchronous database transactions.

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

`git_pack_entries` authenticates every physical entry of each pack, including
duplicate OIDs. `git_pack_objects` remains the single canonical read location
for each OID. Publication compares the exact ordered rows with the digest made
while parsing and requires every entry's canonical owner to be complete.
Deleting that owner bypasses warm caches, validates the selected pack bytes,
promotes one complete fallback entry atomically, and hashes the promoted object
before the old pack disappears. The closure check covers canonical and
non-canonical physical delta entries and hashes any surviving loose base.
Oversized full entries are authenticated through bounded uncached inflate
windows instead of the bulk compressed-byte buffer. The uncached-row budget is
shared across pages and recursively discovered delta bases, so repeated access
to one oversized dependency cannot cross the statement ceiling. Deletion
rejects when any surviving delta chain would lose its base or when the bounded
pack, page, statement, or memory budget is exhausted.

## Current compatibility matrix

This matrix is organized by shared durable seam. It avoids duplicating every
public method that reaches the same synchronous transaction.

| Durable seam | Owners | Current behavior |
|---|---|---|
| Repository route and readiness | `clone` × clone/public calls | One exact provisional owner hides partial state while its root remains a traversal barrier. An active same-root clone gets `EBUSY`; exact-expiry cold retry replaces only the abandoned owner, and a fenced owner gets `ESTALE`. Different roots `coexist`. Ready publication follows complete refs, index, and worktree; fallback target collisions get `EEXIST`, and fallback index/worktree writes are atomic. |
| Ordinary pack ownership | `clone`/`fetch` × `clone`/`fetch` | One durable generation lease fences ordinary ingest per repository. An unexpired competitor gets `EBUSY`; expiry fences the old owner with `ESTALE`, reclaims only its pending pack, and allocates a never-reused pack ID. Unrelated local work still `coexist`s. |
| Maintenance pack ownership | `maintenance` × pack owners | Selected, pending, published, and finalized maintenance packs keep exact durable ownership and bypass the ordinary lease. Disjoint packs `coexist`; a publication whose canonical OID is still owned by another pending pack gets `stale-reject` and remains pending for exact recovery. If an ordinary complete owner wins first, maintenance finalizes against it and atomically discards its fully redundant pack. |
| Tracking refs, tags, prune, and shallow boundaries | `fetch`/`pull` × fetch/local mutation | The latest discovery fences each overlapping tracking namespace. Same-namespace drift and tracking ABA `stale-reject`; complete fetched objects remain. Disjoint namespaces `coexist` when selected global tags and shallow state do not conflict. Selected tags use exact CAS with an idempotent same-target winner. Repository-wide shallow deltas use a durable revision, so the first valid publisher wins and the loser retries. Local branches, index changes, and journals `coexist`. |
| Remote push CAS | `push` × push/remote writer | The remote receive-pack expected OID produces `stale-reject` for a losing writer. A lost response is reported as `EPUSHUNCERTAIN`. |
| Local push tracking ref | configured `push` × fetch/push | Publication follows the remote side effect. Competing newer local tracking publication is currently `unfenced`. Explicit-URL push does not publish a local tracking ref. |
| Pull snapshot | `pull` × HEAD/upstream/journal mutation | Changed HEAD or upstream configuration produces `stale-reject` after fetched state is retained. An active journal at invocation produces `active-reject`; pull rechecks merge state after fetch. |
| Local refs, index, worktree, and journals | paused async owner × synchronous local call | Disjoint state normally `coexist`s. Ref and journal transitions publish atomically. Interrupted add, path reset, and full index replacement may expose a valid page prefix; cold retry deterministically converges. Active merge, cherry-pick, and revert journals reject every other replay/merge start, preserve exact recovery state on stale branch CAS, and remain abortable after reopen. A journal created after a network owner starts can coexist until an owner-specific recheck. |
| Maintenance roots | `maintenance` × root mutation | Refs, index, checkout lifecycle, shallow state, commits, and operation journals advance the root epoch and produce `root-restart`. Read-only work and config-only changes `coexist`. |
| Concurrent maintenance | `maintenance` × maintenance | Each call advances the durable run. Concurrent repack admission is `unfenced`. |

The implementation seams are
[`network.ts`](../../src/core/ops/network.ts),
[`push.ts`](../../src/core/ops/push.ts),
[`pull.ts`](../../src/core/ops/pull.ts),
[`maintenance.ts`](../../src/core/ops/maintenance.ts), and
[`packs.ts`](../../src/sqlite/packs.ts), with durable ownership in
[`store.ts`](../../src/sqlite/store.ts).

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
- An active operation journal validates as a whole and retains its documented
  continue, skip, or abort path.
- Pending packs remain invisible and cleanup removes only an abandoned exact
  owner.
- Maintenance state is resumable, and a stale root snapshot never authorizes
  deletion of a newer root.
- Each public call uses fewer than 1,000 SQL statements and stays below the
  64 MiB operation memory limit.

The active qualification and direct witness map are maintained in the
[concurrency and restart sprint](../sprints/sprint-2026-08-27-concurrency-and-restart-conformance.md).
