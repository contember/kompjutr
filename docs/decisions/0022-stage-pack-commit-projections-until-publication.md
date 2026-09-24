---
id: 0022
title: Stage pack commit projections until publication
status: accepted
date: 2026-09-11
---

# 0022 — Stage pack commit projections until publication

## Context

Pack ingest crosses asynchronous checkpoints. Its validated commit projections
must survive those checkpoints without becoming readable before pack publication.
Temporarily marking a pack complete to insert ordinary `git_commits` rows, then
restoring pending state, leaves those rows visible to trusted commit and graph
reads after the transaction commits.

Ordinary reads trust published rows under
[ADR-0004](0004-trust-stored-rows-validate-at-the-boundary.md). Holding every
projection in memory until publication would violate the bounded-lifetime model
in [ADR-0005](0005-bound-real-failures-and-measure-cost.md).

## Decision

Persist every pending commit's projection in `git_pack_commit_staging`, keyed by
repository, pack, and OID. The exact pack owns them through a cascading foreign
key. Admission checks validated projection input against that pack's physical
commit membership; canonical OID ownership can belong to another complete pack.
Repeated physical occurrences produce one staging row for that pack and OID.

Flush bounded projection batches while the pack remains pending. Promote staged
rows into `git_commits` only inside the pack's final publication transaction,
after the existing complete-membership audit. Preserve already-published
projections for duplicate OIDs. Promotion and staging deletion share the
transaction with the publication callback and ingest lease release.

Promotion uses SQL over stored rows rather than reconstructing the pack's commit
payloads in JavaScript. Ordinary commit and graph reads continue to read only
published `git_commits` rows. Every packed commit gets a row; one whose message
would exceed the platform row ceiling stores message and signature as NULL.

## Consequences

- Pending-only projections are unavailable through ordinary reads, including
  after interruption and reopen.
- Failed publication rolls back promotion and retains invisible staging for
  the pending pack. Pack discard, reclaim, and repository deletion remove it
  through ownership; live pack leases protect it from competing reclaim.
- Projection staging adds temporary SQLite storage and a final promotion pass.
  It avoids pack-sized JavaScript retention and per-read source validation.
- Staging and published projections share column definitions and constraints.
  Physical membership counts and distinct projection counts have separate roles.

## Alternatives considered

- **Qualify every ordinary commit and graph read against physical availability.**
  Adds repeated work to trusted reads and spreads provisional-state handling
  across consumers instead of establishing published-row validity at the writer.
- **Keep all projections in memory until publication.** Makes retained payload
  grow with the incoming pack, despite bounded parsing and write batches.
- **Temporarily publish the pack during a cache flush.** Transactional visibility
  hides only the transient state change; it does not hide ordinary projection
  rows left behind after the pack returns to pending.
