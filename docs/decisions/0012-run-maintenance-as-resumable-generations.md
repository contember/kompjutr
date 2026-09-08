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
mark, repack, and sweep that state inside one bounded Durable Object invocation.

Maintenance also competes with normal repository mutations. A long write lock
would make foreground Git operations unavailable, while sweeping against a stale
root set could delete authoritative data.

## Decision

We run one durable maintenance generation per repository. Each public
`maintenance()` call advances one bounded phase and persists its keyset cursor,
marks, exact shallow snapshot, counters, and repack batch membership. A cold
reopen resumes the same run without caller-owned tokens.

Root-changing mutations increment a repository epoch in their own transaction.
Maintenance records the observed epoch, restarts root discovery when it drifts,
and rechecks the epoch before every destructive transaction. Normal Git
mutations stay available; sustained churn may delay collection safely.

Fulfilling a promised blob also advances that epoch atomically with physical
publication and promise removal. A previous mark may have omitted the absent
leaf even though its tree remains reachable. Promise rows themselves are not
roots, so fulfilled blobs with no surviving references remain collectible.

An object, or a wholly unreachable complete pack, becomes a candidate only after
a complete stable mark. Collection starts 14 days after its first unreachable
observation, and retained reflog expiry happens before that clock starts. There
is no zero-grace public option.

Maintenance repacks reachable loose objects into independently validated packs
containing full objects, and publishes a pack before deleting its loose sources.
Garbage collection deletes only wholly unreachable packs; it does not evacuate
live objects from mixed packs.

## Consequences

- Each invocation has a fixed cost envelope, and every durable boundary is
  restartable.
- Foreground writes never wait for a repository-wide maintenance lock.
- Root churn can repeat bounded marking work but cannot make a stale mark safe
  for deletion.
- `nextEligibleAt` tells a scheduler when grace is the only remaining work.
- Full-object maintenance packs use more bytes than delta-compressed packs, but
  keep publication and recovery simple and independently verifiable.
- Mixed packs can retain unreachable objects until a later compaction design.

## Alternatives considered

- **Hold a write lock through the whole run.** Predictable cost, but it blocks
  normal repository work across multiple invocations.
- **Sweep immediately after one mark.** Gives deleted history no recovery margin
  beyond reflog retention and amplifies any clock or classification defect.
- **Rewrite mixed packs in the first collector.** Combines loose repacking, pack
  compaction, and source switching into one larger destructive mechanism.
- **Resume a partially generated compressed stream.** Batch-level retry is
  simpler and keeps every published pack independently valid.
