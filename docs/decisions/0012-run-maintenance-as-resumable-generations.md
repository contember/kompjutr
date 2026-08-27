---
id: 0012
title: Run maintenance as resumable generations
status: accepted
date: 2026-08-27
---

# 0012 — Run maintenance as resumable generations

## Context

Reachability spans refs, checkouts, retained reflogs, indexes, shallow
boundaries, and active operation journals. Large repositories cannot snapshot,
mark, repack, and sweep that state within one Durable Object invocation while
staying below 1,000 SQL statements and 100 MiB retained memory.

Maintenance also competes with normal repository mutations. A long write lock
would make foreground Git operations unavailable, while sweeping against a
stale root set could delete authoritative data.

## Decision

We will run one durable maintenance generation per repository. Each public
`maintenance()` call advances one bounded phase and persists its keyset cursor,
marks, exact shallow snapshot, counters, and repack batch membership. A cold
reopen resumes the same run without caller-owned tokens.

Root-changing mutations increment a repository epoch in their own transaction.
Maintenance records the observed epoch and restarts root discovery when it
drifts. It rechecks the epoch before every destructive transaction. Normal Git
mutations remain available; sustained churn may delay collection safely.

An object or wholly unreachable complete pack becomes a candidate only after a
complete stable mark. Collection starts 14 days after its first unreachable
observation. Retained reflog expiry occurs before this clock starts. There is no
zero-grace public option.

Maintenance repacks reachable loose objects into independently validated packs
containing full objects. It publishes a pack before deleting its loose sources.
Garbage collection deletes only wholly unreachable packs; it does not evacuate
live objects from mixed packs.

## Consequences

- Each invocation has a fixed cost envelope and every durable boundary is
  restartable.
- Foreground writes do not wait for a repository-wide maintenance lock.
- Root churn can repeat bounded marking work but cannot make stale marks safe for
  deletion.
- `nextEligibleAt` can tell schedulers when grace is the only remaining work.
- Full-object maintenance packs use more bytes than delta-compressed packs, but
  keep publication and recovery simple and independently verifiable.
- Mixed packs can retain unreachable objects until a later compaction design.

## Alternatives considered

- Hold a write lock through the whole run. This makes the cost predictable but
  blocks normal repository work across multiple invocations.
- Sweep immediately after one mark. This gives deleted history no recovery
  margin beyond reflog retention and amplifies clock or classification defects.
- Rewrite mixed packs during the first collector. This combines loose repacking,
  pack compaction, and source switching into one larger destructive mechanism.
- Resume a partially generated compressed stream. Batch-level retry is simpler
  and keeps every published pack independently valid.
