# Offload large objects to R2

## Idea

Objects above the materialisation ceiling (see the limits in
[`reference/git-support.md`](../reference/git-support.md)) are the one class of
Git content a Durable Object cannot hold as a single buffer, so the store
refuses them at `add` and at pack ingest, and a clone of a repository that
contains one fails with `E2BIG`. Instead of refusing, keep the object's
identity, type and size in the store and stream its bytes to an R2 object keyed
by OID. The row becomes a pointer; content moves R2 ↔ pack ↔ working tree in
bounded chunks and never materialises inside the isolate.

```text
git_objects(oid, type, size, source = 'external')   -> r2://<bucket>/<oid>
```

## Why the boundary is promising

- Objects are immutable and content-addressed. The R2 key is the OID: write
  once, never invalidate, delete only under maintenance's reachability rule.
- Chunked storage and chunked reads already exist on both sides: 1 MiB
  `git_object_chunks` and `git_pack_data` rows, `readChunks()` on the store,
  512 KiB `fs_chunks` in the filesystem. A large object can stream R2 →
  `fs_chunks` page by page.
- Promised blobs ([ADR-0020](../decisions/0020-model-partial-clone-blobs-as-durable-promises.md))
  are the precedent for "the object is in the graph but its bytes are
  elsewhere": a promise row, `EPROMISED` on synchronous reads, asynchronous
  hydration. An offloaded object is a promise whose remote is R2.
- Loose-shadows-packed and source-qualified projections mean a third source
  kind can be added without touching tree or commit projections; trees and
  commits are never large.

## What is genuinely new

1. **A third object source**, `external`, carrying the R2 key. Type and size
   reads stay local and synchronous; content reads become asynchronous.
2. **Ingest.** A pack entry above the ceiling is inflated in chunks and streamed
   to R2 instead of being refused. The compressed pack bytes still land in
   `git_pack_data`; only the inflated object is too big for memory.
3. **Checkout.** Materialising the working tree streams R2 → `fs_chunks`. This
   needs a chunked writer on the filesystem bulk API, which the object store
   read path (`readChunks`) already has on its side.
4. **Outbound.** Push and any future serving path stream the object out of R2
   into `PackWriter`, which already pages large blobs from SQLite.
5. **Maintenance.** R2 deletion under the same reachability and grace rules;
   an R2 object left behind by an interrupted ingest is garbage, never a wrong
   read, and needs the provisional-ownership treatment packs already get.

## The difficult parts

### Synchronous reads

`read()` and `readBlobs()` are synchronous; R2 is not. The shape is the one
`EPROMISED` already has: a synchronous read of an offloaded object fails with a
stable code and asynchronous operations hydrate. Which operations need the
bytes synchronously has to be decided per command; diff and merge over a
48 MiB blob are almost certainly a refusal, not a hydration.

### Delta chains over an offloaded base

Applying a delta needs its base in memory, which is exactly what the ceiling
forbids. Either refuse deltas whose base is offloaded at ingest (a thin pack
from a server may deliver them) or apply copy/insert delta ops against ranged
R2 reads. The second is feasible and new; the first is safe and loses fetch
compatibility for some repositories.

### Two systems, one publication

An R2 write and a SQLite row are not one transaction. Writing R2 first
(idempotent by OID) and the row second means the only failure mode is an
orphan R2 object, never a row without bytes. Cleanup belongs to maintenance.

### Testing

Node tests have no R2. The suite needs an in-memory `R2Bucket`-shaped stub
behind the same seam the runtime injects.

## Options

| Option | Covers | Main cost or risk | Rough scope |
| --- | --- | --- | --- |
| Keep the ceiling (current) | Honest `E2BIG` at the boundary | Repositories with a file above the ceiling cannot be cloned | None |
| Raise the ceiling | A few more repositories | Isolate memory; meaningless past ~100 MiB | Trivial, not a fix |
| Stream inside SQLite, no R2 | Any object size in 1 MiB rows | Durable Object storage size and cost; every consumer must go chunked | Medium |
| R2 for objects above the ceiling | Any size; DO storage stays small | Two-system publication, asynchronous reads, delta bases | Medium-large |
| R2 for all blobs above a low threshold | Media-heavy repositories, tiny DO storage | R2 operations on hot paths | Large |

The third and fourth rows share a first step: a chunked checkout writer. Even
with R2, the working tree has to be written from a chunk stream, and that step
alone lifts the ceiling for loose and non-delta packed objects without any new
storage system.

## Suggested feasibility spike

1. Make checkout accept a chunk stream from `readChunks()` for objects above a
   threshold, with no R2 involved. Measure a clone of a repository holding one
   200 MiB zero-filled blob and one 200 MiB random blob under the memory
   harness (`bench/CLAUDE.md` rules apply).
2. Prototype the `external` source with an in-memory R2 stub on the ingest path
   only, checking out through step 1.
3. Decide the synchronous-read semantics per command from what step 2 shows.

## Open questions

- Where does the bucket come from: `Workspace` composition, the compat adapter,
  or both?
- Threshold: the isolate ceiling, or a lower storage-cost threshold?
- Should offloaded objects be excluded from repack and never serve as delta
  bases?
- Is streaming inside SQLite enough on its own, making R2 unnecessary? The
  Durable Object storage limit and per-row cost decide this, not memory.

## Graduation criteria

- The chunked-checkout spike shows a 200 MiB blob cloning and checking out
  under the 100 MiB process target.
- A written decision on synchronous-read semantics for offloaded objects.
- A test-side R2 stub and one measured ingest → checkout path.

When those hold, this graduates to a backlog item; otherwise it is deleted.
