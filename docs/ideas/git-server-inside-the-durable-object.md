# Serve the Durable Object repository as a Git remote

## Idea

Let a workspace answer Smart HTTP itself, so an ordinary `git` client can
`clone`, `fetch`, and `push` against the Durable Object that holds the
repository. The DO stops being only a Git *client* and becomes a remote:

```text
git clone https://<worker>/<repo>.git
git push  origin main            # -> receive-pack inside the DO
```

No new storage layer. The refs, objects, and packs the server has to serve are
already rows in the same database; what is missing is the other half of the
wire protocol.

## Why the boundary is promising

Both expensive halves of Smart HTTP already exist in this repository, written
from the client side. The server is the same machinery driven in the opposite
direction.

| Server responsibility | What already covers it |
| --- | --- |
| Emit a packfile without assembling it | [`PackWriter`](../../src/core/pack/writer.ts) streams bytes through `emit`, hashing the trailer as it goes |
| Decide which objects a peer is missing | [`planPushObjects`](../../src/core/ops/push-plan.ts) computes the closure of `newOid` minus a set of remote oids — the same computation as `want` minus `have` |
| Stream those objects out of SQLite | [`openPushPack`](../../src/core/ops/push-plan.ts) pages large blobs through the writer in bounded chunks |
| Accept and index an incoming pack | `PackStore.ingest` ([`src/sqlite/packs.ts:1170`](../../src/sqlite/packs.ts)), already the fetch path via [`ingestPack`](../../src/core/ops/network.ts) |
| Frame the conversation | [`pktline.ts`](../../src/core/protocol/pktline.ts) encodes, [`stream.ts`](../../src/core/protocol/stream.ts) parses strictly and bounded |
| Move a ref safely under a concurrent writer | `updateRefExpected` ([`src/sqlite/store.ts:3078`](../../src/sqlite/store.ts)) is a compare-and-swap |
| Enumerate what to advertise | `Repository.branches()`, `tags()`, `resolveRef()`, `head()` |

The client also already *consumes* every capability the server would want to
advertise: `side-band-64k`, `report-status`, `thin-pack`, `shallow`
([`remote.ts:351`](../../src/core/protocol/remote.ts),
[`receive-pack.ts:78`](../../src/core/protocol/receive-pack.ts)). The decoders
exist; the encoders do not.

## What is genuinely new

1. **Ref advertisement.** `GET /info/refs?service=…` returns the service line, a
   pkt-line ref list, capabilities, and a `symref=HEAD:…`. This is
   [`discover()`](../../src/core/protocol/remote.ts) inverted.
2. **`upload-pack`, server side.** Read `want`/`have`/`done`, answer
   `NAK`/`ACK`, then stream the pack. Protocol v0 with a single round ending in
   `done` is sufficient — the client computes nothing the server needs.
3. **`receive-pack`, server side.** Parse the ref commands, ingest the pack,
   prove connectivity of the new tips against what the store now holds, apply
   the ref updates by CAS, and report `unpack ok` / per-ref status.
4. **The HTTP shell.** Correct content types
   (`application/x-git-upload-pack-advertisement`, `…-result`),
   `Cache-Control: no-cache`, and a streamed `Response` body.

Only (2) and (3) carry real design; (1) and (4) are mechanical.

## The difficult parts

### Connectivity of a received push

A client may send a thin pack whose deltas reference bases the server already
has. Ingest resolves that today because fetch depends on it. What a server
additionally owes is the check fetch never needed: **the advertised new tip must
be fully reachable** once the pack is indexed, or the ref update is refused and
the pack discarded. Half-applied history is the one outcome a remote must never
produce. This has to fail closed and leave no ref moved.

### Cost of serving a clone

A full clone is the largest single operation the store would ever perform. Two
knobs matter and neither is a hard wall:

- The `MAX_PUSH_*` ceilings in `push-plan.ts` (512 commits, 100k objects, and a
  1,000-statement budget) are an **optimisation barrier chosen for push**, not a
  property of the storage. Serving needs its own budget, derived from what a
  clone actually costs to stream, and probably a different shape: a clone reads
  a lot and writes nothing.
- **No outbound delta compression** (see [`backlog/09`](../backlog/09-outbound-delta-compression.md)).
  Every object goes out full. That is correct but fat, and it is the difference
  between a clone that is merely large and one that is embarrassing. This is the
  first thing to fix if serving becomes real.

### Concurrency and interleaving

A Durable Object is single-threaded but not single-request: awaits interleave,
so a streaming clone does not monopolise the object. The exposure is different
and narrower — **CPU-bound stretches between awaits**. Deflating a large object
or indexing a received pack runs to completion before anything else proceeds, so
the pack loops need deliberate yield points (the existing `yieldNow` seam in
`ingest` is the precedent) rather than a lock.

The semantics still need stating: what a clone in flight sees when a push lands
mid-stream. The simplest defensible answer is that the advertisement pins the
oids, and the pack is generated from those oids regardless of later ref
movement — objects are immutable, so a pinned set stays servable.

### Trust

Every byte a client sends is untrusted input, which is the existing rule for SQL
rows applied to a new surface. Ref names, oids, capability lines, and pack
contents all arrive from outside. `requireBranchRef`
([`receive-pack.ts:47`](../../src/core/protocol/receive-pack.ts)) already
encodes the accepted ref subset for pushes we send; the server side needs the
same validation applied to what it receives, plus a size ceiling on the request
body before anything is indexed.

Authentication and authorisation belong in the Worker in front of the DO, not in
the protocol code.

## Options

| Option | Covers | Main cost or risk | Rough scope |
| --- | --- | --- | --- |
| Do nothing | The current client-only model | The DO can never be a remote | None |
| `receive-pack` only — the DO as a push target | Push-to-deploy, mirroring, agents publishing work | Connectivity checking and CAS ref application must be right; no read path | Small; ingest and CAS both exist |
| `upload-pack` only — the DO as a read-only remote | Clone and fetch from the DO; distributing state | Needs a serving budget and hurts without delta compression | Medium |
| Both, full Smart HTTP v0 | A real remote | Sum of the above plus interleaving semantics | Medium-large |
| Protocol v2 | Better ref filtering on large ref sets | v0 is enough for every client that matters today | Not now |

The promising order is **`receive-pack` first**. It reuses the two pieces that
already work (pack ingest, ref CAS), it is useful standing alone — a DO you can
push to is a deploy target — and it does not depend on resolving the clone-cost
question at all.

## Suggested feasibility spike

1. Serve `GET /info/refs?service=git-receive-pack` from a workspace and confirm
   real `git push` reaches the negotiation.
2. Accept one branch push end to end: ingest, connectivity check, CAS update,
   `report-status`.
3. Push a thin pack whose bases are already stored, and a pack that is
   deliberately incomplete; the second must move no ref.
4. Only then add `upload-pack` and measure a clone of the existing benchmark
   fixture: bytes on the wire, statements, peak memory, longest uninterrupted
   CPU stretch.
5. Use (4) to set the serving budget and to decide whether delta compression is
   a prerequisite rather than an optimisation.

## Open questions

- Is the target a general Git remote, or a private transport between a DO and
  the agents that own it? The second permits shortcuts the first does not.
- One repository per DO, or many? Repository identity is URL routing, but it
  decides whether serving competes with a workspace's own work.
- Are tags and non-branch refs in scope, or is the branch-only subset in
  `requireBranchRef` sufficient at first?
- Does an ongoing clone need a consistent snapshot, or is a pinned oid set
  enough?
- Should the server advertise `shallow`, so a client can bound a clone the store
  would otherwise refuse to serve whole?

## Graduation criteria

Graduate into a backlog item or sprint once a spike demonstrates:

- a real `git push` from the `git` binary applied end to end, with an incomplete
  pack proven to move no ref;
- a measured clone cost on the benchmark fixture, with an explicit serving
  budget derived from it;
- a stated and tested answer for a push landing during a clone;
- no regression to the existing fetch and push paths from anything the server
  shares with them.
