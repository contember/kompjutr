---
id: 0013
title: Publish clones through provisional ownership
status: accepted
date: 2026-08-28
---

# 0013 — Publish clones through provisional ownership

## Context

Clone originally registered a routable repository before its first network
await. The live call removed that repository when it caught a failure, but an
isolate restart could leave a half-cloned checkout that ordinary calls could
observe and a retry could not safely replace. The HTTP exchange itself is
neither durable nor resumable.

Coordination must stay scoped to the destination root, and it must preserve
unrelated repositories and untracked files.

## Decision

Clones are created as provisional repositories with an exact monotonic owner
generation and a five-minute renewable lease. A provisional root remains a
routing barrier but is hidden from ordinary repository lookup and from public
store opens. An active same-root claimant receives `EBUSY`. A claimant that
observes exact expiry removes the abandoned owner's tracked index and worktree
state and its repository rows before allocating new, never-reused repository,
checkout, and clone identities.

The clone renews ownership at its real asynchronous checkpoints. A stale owner
receives `ESTALE` and can neither publish nor delete its replacement. The
repository becomes ready in one exact-owner transaction, only after refs,
configuration, index, and initial worktree materialization are complete. A caught
failure uses the same exact-owner contract to remove only its own provisional
clone.

The native empty-worktree materializer remains one create-only transaction. A
fallback clone first rejects any exact or structural collision with an existing
path, then updates the index and the SQLite worktree in one shared transaction,
so a failed fallback write cannot leave an unindexed clone path that a cold
cleanup would mistake for caller-owned data.

## Consequences

- Public operations cannot observe a half-clone, and a cold retry can
  deterministically restart the transfer after lease expiry.
- Different roots stay independent, and cleanup preserves untracked files
  because it removes only paths authenticated by the provisional index.
- An existing path that would become a clone target fails with `EEXIST` instead
  of being overwritten.
- A crashed clone can block the same root for at most one lease interval.
- A retry repeats network work instead of resuming it, and the monotonic
  identity counters grow across deletion.
- The development-only version-1 schema contains this lifecycle directly and has
  no compatibility migration.

## Alternatives considered

- **Keep catch-only cleanup.** It cannot run after isolate eviction and leaves an
  observable, unrecoverable partial repository.
- **Route provisional repositories and make every operation check readiness.**
  Widens the partial-state contract to every caller and permits accidental
  observation.
- **Persist and resume the HTTP exchange.** Transport and parser state are not a
  stable replay boundary, so this adds a second recovery protocol without
  eliminating stale ownership.
- **Lock the whole repository database.** Clone ownership needs one destination
  root; a global lock would serialize independent repositories for nothing.
