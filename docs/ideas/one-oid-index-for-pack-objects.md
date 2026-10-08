# One OID index for pack objects

**Summary.** Pack ingest writes every object into two B-trees keyed by a random
OID: the `git_pack_objects` primary key and `git_pack_entries_by_oid`. On the
full-history Next.js clone the two inserts are the largest SQL cost. Keeping
only `git_pack_entries` roughly halves the insert work, but every canonical
read and pack deletion must change.

## Evidence

Profile of the full-history `blob:none` Next.js clone on workerd at `2768f53`
(CDP, `cpu-lease run -n 2 --no-smt`): `PackObjectBatch.flush` spends about
15 s inside SQLite. That is the largest single item; total busy CPU is 47 s.
Per object, ingest writes five B-tree rows: the `git_pack_objects` rowid
table, its primary-key index, `git_pack_objects_loc`, the `git_pack_entries`
primary key, and `git_pack_entries_by_oid`. Only the two OID-keyed rows
land on random pages.

Local `node:sqlite` insert of 357,000 random-OID rows in 2,048-row JSON
batches, two repetitions, `synchronous=OFF`:

| Schema | Insert ms |
| --- | ---: |
| Today (both tables, both OID indexes) | 9,937 / 10,530 |
| A: `git_pack_entries` with a covering OID index, no `git_pack_objects` | 5,719 / 5,545 |
| A: `git_pack_entries` with today's OID index, no `git_pack_objects` | 4,987 / 4,863 |
| B: both tables, no `git_pack_entries_by_oid` | 5,961 / 5,934 |
| C: slim `git_pack_objects` `WITHOUT ROWID`, no `loc` index | 9,295 / 9,246 |

Durable Object SQLite does not allow `PRAGMA cache_size`, so a larger page
cache is not an option. Sorting each 2,048-row batch by OID saved about 5 %.

## Candidates

There are 33 query sites. Most only ask whether an OID is in some complete
pack and what its type and size are. Any complete copy answers that. Only
`lookup()`, the pack-graph start, the publish-time membership audit
(`auditPublishedMembership`), and the pack-scoped canonical checks in deletion
and sweep need a single canonical copy.

- **A — drop `git_pack_objects`.** The canonical copy becomes the earliest
  complete copy: `git_pack_entries JOIN git_pack_meta ... ORDER BY pack_id,
  offset LIMIT 1`. Re-homing in `lifecycle-delete.ts` (`#promoteFallbacks`)
  disappears.
  - Costs:
    - About 25 queries are rewritten.
    - `count`, `findPrefix` and `oids` need `DISTINCT oid`.
    - Type and size need a primary-key lookup, or a wider covering index.
    - Two things that today come from the first-flush claim need a new
      mechanism: the claim guard that detects a concurrent ingest, and the
      bump of the canonical copy's source generation when a lower pack
      completes later.
    - Sweep must keep its "earliest complete holder" meaning, or redundant
      packs are never collected.
  - Touches ADR-0003 (row ownership) and ADR-0013 (provisional ownership).
- **B — drop `git_pack_entries_by_oid`.** About seven queries lose their
  index. The fix is an index on `(repo_id, pack_id, oid)`. A fresh clone holds
  one large pack, so that index is just as random and saves nothing. B helps
  only incremental fetches.
- **C — slim `git_pack_objects`.** It still writes two random trees, and
  locally it saves 7 %. Not worth it alone.

## Recommendation

Use A, but only as a planned sprint (effort L) with its own ADR, not as an
ad-hoc change. Expected gain: about 45 % of the pack-row insert. That is
roughly 5–7 s of the 47 s busy CPU, plus a smaller database.

Before planning:

1. Run `EXPLAIN QUERY PLAN` for the rewritten canonical lookup and the three
   `DISTINCT` scans on the full-history store.
2. Measure the read-side cost: `typeAndSize`, `objectInfo` and `readObjects`
   on the Next.js workflow bench (`bench:statements -- --check`).
3. Design the concurrent-ingest guard that replaces the first-flush claim.
