---
id: 0013
title: Publish clones through provisional ownership
status: accepted
date: 2026-08-28
---

# 0013 — Publish clones through provisional ownership

## Context

Clone used to register a routable repository before its first network await.
The live call removed that repository on a caught failure, but an isolate restart
could leave a half-cloned checkout that ordinary calls could observe and a retry
could not safely replace. The HTTP exchange itself is not durable or resumable.
Coordination must stay scoped to the destination root and must preserve unrelated
repositories and untracked files.

## Decision

We will create clones as provisional repositories with an exact monotonic owner
generation and a five-minute renewable lease. Provisional roots remain routing
barriers but are hidden from ordinary repository lookup and public store opens.
An active same-root claimant receives `EBUSY`; an exact-expiry claimant removes
the abandoned owner's tracked index/worktree state and repository rows before it
allocates new, never-reused repository, checkout, and clone identities.

The clone renews ownership at its real asynchronous checkpoints. A stale owner
receives `ESTALE` and cannot publish or delete its replacement. The repository
becomes ready in one exact-owner transaction only after refs, configuration,
index, and initial worktree materialization are complete. Caught failure uses the
same exact-owner contract to remove only its own provisional clone.

The native empty-worktree materializer remains one create-only transaction. A
fallback clone first rejects any exact or structural collision with an existing
path, then updates the index and SQLite worktree in one shared transaction. This
ensures that a failed fallback write cannot leave an unindexed clone path that a
cold cleanup would mistake for caller-owned data.

## Consequences

Public operations cannot observe a half-clone, and a cold retry can deterministically
restart the transfer after lease expiry. Different roots remain independent, and
cleanup preserves untracked files because it removes only paths authenticated by
the provisional index. Existing paths that would become clone targets fail with
`EEXIST` instead of being overwritten; unrelated untracked paths remain intact.
A crashed clone may block the same root for at most one lease interval. Retry
repeats network work instead of resuming it, and monotonic identity counters grow
across deletion. The development-only version-1 schema contains this lifecycle
directly and has no compatibility migration.

## Alternatives considered

- Keep catch-only cleanup. It cannot run after isolate eviction and leaves an
  observable, unrecoverable partial repository.
- Route provisional repositories and make every operation inspect readiness.
  This widens the partial-state contract to every caller and permits accidental
  observation.
- Persist and resume the HTTP exchange. Transport and parser state are not a
  stable replay boundary, so this adds a second recovery protocol without
  eliminating stale ownership.
- Lock the whole repository database. Clone ownership only needs one destination
  root; a global lock would unnecessarily serialize independent repositories.
