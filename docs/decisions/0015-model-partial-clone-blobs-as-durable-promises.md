---
id: 0015
title: Model partial-clone blobs as durable promises
status: accepted
date: 2026-08-31
---

# 0015 — Model partial-clone blobs as durable promises

## Context

`blob:none` keeps the complete commit and tree graph but deliberately omits blob
bytes. The physical object store previously had only present and absent states,
while every store read is synchronous and HTTP hydration is asynchronous. Fake
object rows would violate the trusted-store contract, and credentials retained
from one clone call would not survive Durable Object eviction.

## Decision

We store promisor remotes and promised blob OIDs as repository-owned metadata,
separate from loose and packed objects. A promise never makes a physical `has`,
`read`, or object-metadata query report an object as present. A complete loose
object or pack publication removes the matching promises in the same
transaction.

A filtered fetch records every absent blob referenced by authenticated tree
projections before it publishes refs. Shallow boundaries stay independent:
shallow controls commit ancestry, partial clone controls blob presence.
Maintenance treats an explicitly promised missing blob as a terminal leaf, not as
a root and not as corruption; every other missing reachable object still fails.

Asynchronous operations hydrate bounded exact OID batches before retrying
synchronous work, under one aggregate operation cap that prevents a
network-per-object loop. Hydration uses the pinned promisor URL, a fresh
binding-level credential provider, and a non-thin pack. The public client
transparently hydrates current clone and checkout targets, `catFile`, diff reads,
and push closure batches. Synchronous repository and CLI paths return `EPROMISED`
when they need omitted content, and a changed or removed promisor URL fails with
`EPROMISORREMOTE` before an outbound pack is sent.

## Consequences

- Metadata-only history and tree reads do not fetch blob bytes.
- Credentials are not persisted; `promisorHeaders` and `promisorAuth` reacquire
  them after a restart.
- Backfill uses fixed OID pages, streaming pack ingest, and the protocol entry
  ceiling. It invents no admission currency
  ([ADR-0005](0005-bound-real-failures-and-measure-cost.md)).
- An operation without a safe asynchronous preflight fails explicitly rather
  than hiding network I/O inside the synchronous store.
- Promisor identity is pinned independently of mutable Git config, so repointing
  a remote cannot make a later read or push fetch bytes from the wrong source.
- One promised OID has one pinned source. If filtered fetches overlap, the first
  surviving promise stays authoritative until physical publication removes it.

## Alternatives considered

- **Placeholder physical objects.** Lost because they would make trusted reads
  claim bytes exist when they do not.
- **Mark whole packs as promisor.** Lost because it complicates repack ownership
  and cannot identify an omitted blob without traversing projections again.
- **Persist clone credentials.** Lost because secrets do not belong in SQLite and
  short-lived credentials would be stale after eviction.
- **Catch one missing blob at a time.** Lost because it creates an unbounded
  network-per-object loop and can discover absence after a mutation has started.
