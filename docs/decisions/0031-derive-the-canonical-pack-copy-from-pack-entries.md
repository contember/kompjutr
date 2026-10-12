---
id: 0031
title: Derive the canonical pack copy from pack entries
status: accepted
date: 2026-10-09
---

# 0031 — Derive the canonical pack copy from pack entries

## Context

Pack ingest writes every object twice. `git_pack_entries` holds one row per
physical entry of each pack, keyed by `(repo_id, pack_id, offset)` with the OID
index `git_pack_entries_by_oid`. `git_pack_objects` holds one canonical row per
`(repo_id, oid)` and names the copy that reads start from. Per object that is
five B-tree rows, and two of them are keyed by a random OID.

On the full-history `blob:none` Next.js clone (357,637 objects, CDP profile at
`c373b41`, `cpu-lease run -n 2 --no-smt`), the pack-row inserts cost
12.5–14.2 s of 58.8–64.4 s busy CPU, the largest single item. The publication
audit that checks the canonical rows costs another 1.4–1.9 s. A local
`node:sqlite` insert of the same row count fell from about 10.0 s to about 4.9 s
without `git_pack_objects`. The table and its two indexes hold 52.7 MB of the
472 MB clone database.

The canonical row is maintained by three mechanisms:

- **Claim.** Ingest inserts it with `INSERT OR IGNORE` while the pack is still
  pending. The first writer wins.
- **Audit.** Publication requires every entry's canonical row to exist and to
  belong to a complete pack, or fails with `ESTALE`.
- **Promotion.** Pack deletion re-homes canonical rows to the earliest complete
  copy, by lowest `pack_id`, then lowest `offset`.

Only one ordinary ingest runs per repository, and pack ids are monotonic. The
claim therefore always lands on the earliest pack, which is the same order
promotion uses. The claim can still orphan an OID: a pending pack whose copy
lost the claim to a complete pack has no canonical row once that complete pack
is deleted. The audit exists to turn that orphan into a retryable `ESTALE`.

## Decision

We derive the canonical copy instead of storing it.

- **The rule.** The canonical copy of an OID is its `git_pack_entries` row in a
  complete pack with the lowest `(pack_id, offset)`. One shared SQL fragment
  expresses it, and every read that needs a specific copy uses that fragment:
  the chain start of the pack graph, `lookup`, `completePackedEntry`, and the
  maintenance "canonical holder" tests.
- **Existence and metadata reads** ask whether a complete copy exists and take
  type and size from the canonical copy. They never multiply rows per OID.
- **`git_pack_objects` and `git_pack_objects_loc` are removed.** Ingest writes
  only `git_pack_entries`. Pack deletion no longer promotes anything.
- **The audit becomes a count check.** Publication still requires the pack's
  stored entry count to equal the parsed count. The orphan case cannot occur,
  because a pending pack's copy becomes canonical when the pack publishes.
- **Source generation.** Deleting a complete pack always bumps
  `git_repositories.source_generation`. Deleting only pending packs does not.
- **Plans are pinned.** Every rewritten statement that seeks by OID names
  `git_pack_entries_by_oid` where the planner would otherwise choose the
  primary key, and a test asserts its query plan.

## Consequences

- Ingest writes two B-tree rows per physical entry instead of five for a
  new OID. One random-OID tree remains.
- The clone database loses the table and its two indexes. Three paired
  workerd clones save a median 52,703,232 bytes and 8.231 s wall time. All
  pairs are faster; SQL and returned-row gates pass. The measured runtime,
  fixture and sampled live-set results are in
  [the benchmark snapshot](../reference/benchmark-current.md#full-history-nextjs-clone-on-workerd--2026-10-12).
- Reads by OID seek `git_pack_entries_by_oid` and then the primary key for type
  and size. Locally, a single type-and-size lookup costs about 15 % more, a
  2,048-OID metadata batch about 10–20 % more, and the pack-graph start is
  faster.
- A planner trap becomes a standing rule. `ORDER BY pack_id, offset` matches
  the primary-key order, and without the index hint SQLite scans the pack:
  16 ms per lookup instead of 12 µs on the clone database.
- Within one pack, the canonical copy of a duplicate OID is the lowest offset.
  Before, it was the first row inserted, which could be a later deferred delta.
  Both copies hold the same object.
- The `ESTALE` retry after a concurrent deletion of the canonical owner
  disappears. The pending pack publishes and its copy becomes canonical.
- A redundant pack, whose every entry has an earlier complete copy, is still
  swept, because the maintenance holder test uses the same rule.
- [ADR-0003](0003-split-the-shared-git-store-from-checkouts.md) row ownership,
  [ADR-0022](0022-stage-pack-commit-projections-until-publication.md) commit
  promotion after the membership audit,
  [ADR-0025](0025-scope-paged-read-metadata-and-linearize-maintenance-expansion.md)
  generation bumps and `docs/reference/concurrency.md` follow this derived
  ownership rule.

## Alternatives considered

- **Drop `git_pack_entries_by_oid` and keep `git_pack_objects`.** A fresh clone
  holds one large pack, so the `(repo_id, pack_id, oid)` index that would replace
  it is just as random. It saves about as much locally but helps only
  incremental fetches.
- **Slim `git_pack_objects` (`WITHOUT ROWID`, no `loc` index).** It still writes
  two random-OID trees and saved 7 % locally.
- **Cover type and size in `git_pack_entries_by_oid`.** It removes the
  primary-key seek from metadata reads, but the local insert rose from 4.9 s to
  5.6 s. Revisit if the read witnesses regress.
- **Keep the claim and drop only the audit.** It keeps both random-OID inserts
  and leaves the orphan case without its guard.
