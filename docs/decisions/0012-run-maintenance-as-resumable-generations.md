---
id: 0012
title: Run maintenance as resumable generations
status: accepted
date: 2026-08-27
---

# 0012 — Run maintenance as resumable generations

## Context

Reachability spans refs, checkouts, retained reflogs, indexes, shallow
boundaries, and active operation journals. A large repository cannot snapshot,
mark, and sweep that state inside one bounded Durable Object invocation.

Maintenance also competes with normal repository mutations. A long write lock
would make foreground Git operations unavailable, while sweeping against a stale
root set could delete authoritative data.

## Decision

We run one durable maintenance generation per repository. Each public
`maintenance()` call synchronously advances one bounded phase and persists its
keyset cursor, marks, exact shallow snapshot, and counters. A cold reopen
resumes the same run without caller-owned tokens.

Root-changing mutations increment a repository epoch in their own transaction.
Maintenance records the observed epoch, restarts root discovery when it drifts,
and rechecks the epoch before every destructive transaction. Normal Git
mutations stay available; sustained churn may delay collection safely.

A run records **two** identities, not one: the root epoch and the repository
source generation ([ADR-0025](0025-scope-paged-read-metadata-and-linearize-maintenance-expansion.md)).
It restarts on either. A maintenance step that changes sources adopts its own
bump as the last statement of that step's transaction, so a run can never
restart itself; only a foreign writer's bump survives the comparison.

Fulfilling a promised blob also advances that epoch atomically with physical
publication and promise removal. A previous mark may have omitted the absent
leaf even though its tree remains reachable. Promise rows themselves are not
roots, so fulfilled blobs with no surviving references remain collectible.

An object, or a wholly unreachable complete pack, becomes a candidate only after
a complete stable mark. Collection starts 14 days after its first unreachable
observation, and retained reflog expiry happens before that clock starts. There
is no zero-grace public option.

Maintenance does not repack. Reachable loose objects stay loose: every loose
object is already zlib-deflated at write, so a full-object pack would save no
bytes and cost more statements to read. Garbage collection deletes unreachable
loose objects and wholly unreachable packs; it does not evacuate live objects
from mixed packs.

Pack sweeping persists its last examined pack ID and a sticky deletion marker
in the existing phase-specific cursor fields. Each call examines one bounded
candidate page and deletes at most one pack. A pass that deleted a pack must
restart, because that deletion may unblock an earlier candidate. Only an
exhausted deletion-free pass completes. Epoch restart and phase exit clear the
cursor. Prospective dependency checks use metadata and the actual canonical
fallback order, including dependencies held by pending packs.

## Consequences

- Each invocation has bounded pages and candidate checks, and every durable
  boundary is restartable. A candidate's dependency analysis remains proportional
  to its SQLite metadata graph; the page bound does not make that graph fixed-size.
- Foreground writes never wait for a repository-wide maintenance lock.
- Root churn can repeat bounded marking work but cannot make a stale mark safe
  for deletion. Source churn — loose writes, pack publication, pack and loose
  deletion — now does the same, on the second identity.
- `nextEligibleAt` tells a scheduler when grace is the only remaining work.
- Loose storage is not delta-compressed. A repository that writes many
  revisions of large files locally stores each revision whole until a future
  delta-producing compaction exists.
- No maintenance step owns a pack, so ordinary ingest's pending-pack cleanup
  and pack sweeping need no maintenance exclusions.
- Mixed packs can retain unreachable objects until a later compaction design.

## Alternatives considered

- **Hold a write lock through the whole run.** Predictable cost, but it blocks
  normal repository work across multiple invocations.
- **Sweep immediately after one mark.** Gives deleted history no recovery margin
  beyond reflog retention and amplifies any clock or classification defect.
- **Rewrite mixed packs in the first collector.** Combines pack compaction and
  source switching into one larger destructive mechanism.
- **Repack reachable loose objects into full-object packs.** Measured on a
  30-commit source-file fixture: once loose objects are always deflated, the
  pack stores the same bytes (329 KB vs 328 KB) while `cat-file` costs 18% more
  statements. The repack phase also needed durable batch ownership, an
  asynchronous pack stream, and pins in ingest and sweep. Removed in the
  2026-09-23 simplification sprint.
