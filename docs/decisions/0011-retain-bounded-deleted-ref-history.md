---
id: 0011
title: Retain bounded deleted-ref history
status: accepted
date: 2026-08-26
---

# 0011 — Retain bounded deleted-ref history

## Context

Ref history is both a user recovery record and a future garbage-collection root.
Git commonly expires reachable and unreachable entries under different policies,
and it removes a branch's per-ref log when that branch is deleted. This runtime
has no maintenance configuration and no reachability-dependent expiry. Deleting
the only recovery log would also defeat the main reason to add reflogs before
branch-deletion checks and object reclamation.

The policy has to be deterministic, bounded per ref, usable from one lazy SQLite
traversal, and independent of wall-clock ordering, because timestamps may repeat
or move backward.

## Decision

An entry is active only while it is both at most 90 days old and among the newest
1,024 entries for its ref, ordered by a repository-wide monotonic ordinal. Reads,
`HEAD@{n}`, recovery, and active object-root traversal all apply that same
predicate.

Deleting a direct ref keeps its history within the active window. Recovery may
select either non-null endpoint and must move a direct destination with an
expected-current compare-and-swap. Physical pruning happens transactionally on
later mutations, but no consumer treats an inactive row as recoverable or as an
object root.

## Consequences

- A deleted branch or tag stays recoverable for a fixed bounded window.
- Future garbage collection has one exact stream of active old/new OID roots.
- The count and time boundaries compose: satisfying only one does not retain an
  entry.
- Ordinals, not timestamps, define stable pagination and the per-ref count cap.
- This deliberately differs from Git, which discards deleted-ref history.
- Expiry is not configurable and does not distinguish reachability. Changing the
  policy requires a new decision and new recovery and root witnesses.

## Alternatives considered

- **Delete per-ref history with the ref, as Git does.** Removes the recovery path
  at the exact destructive transition the feature exists to protect.
- **Use only 90-day expiry.** A hot ref could retain unbounded rows and roots.
- **Use only the newest 1,024 entries.** An inactive ref could protect
  unreachable objects indefinitely.
- **Implement Git's reachability-dependent, configurable expiry now.** There is
  no garbage collector or maintenance configuration surface to supply reliable
  evidence for that complexity.
