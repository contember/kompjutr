---
id: 0025
title: Bound packed reads by chain depth and restart maintenance on source drift
status: accepted
date: 2026-09-24
---

# 0025 — Bound packed reads by chain depth and restart maintenance on source drift

## Context

Two paths had to keep packed-object work bounded without leaning on a guarantee
the store does not own.

A packed read resolves each wanted OID through its delta chain. One read graph
holds a bounded number of entries, but a batch of wanted OIDs, or one long chain,
can need more. The store used to cap chains at 50,000 edges, so a single object
could need a graph far larger than one bounded query. It paged such reads
through owner-scoped scratch tables (`git_pack_read_*`), which turned a read into
a write transaction with its own source snapshot.

Maintenance marks reachable objects over many `maintenance()` calls and sweeps
afterwards. Between two calls, new sources can appear and old ones can go: a
pack is published or deleted, a loose object is written or swept. A sweep that
acts on a mark computed against a different source set can remove storage that a
reader still needs.

Packs are self-contained: every delta base is an entry of the same pack, found
by `git_pack_entries.base_offset`.

## Decision

**We cap every stored delta chain at 4,095 edges and read every batch with one
bounded graph query.** `MAX_DELTA_DEPTH` is 4,095, Git's `pack-objects` limit, so
no pack that Git produces is refused. Ingest carries each entry's depth while
deltas resolve and rejects a deeper chain with `ECORRUPT` before publication. A
read discovers its batch's delta closure in one recursive query limited to
`MAX_DELTA_DEPTH + 1` entries. When the closure is larger, the resolver halves
the wanted batch and reads each half the same way. A single OID's chain always
fits one graph, so the split always terminates. A read opens no transaction and
writes nothing.

**We give the repository a source generation.** `git_repositories.source_generation`
identifies the set of sources an ordinary complete read sees: for every OID,
which loose row or which complete pack serves it. The owners that change that set
bump it inside the transaction that makes the change visible: pack publication,
pack storage deletion, loose object writes, and loose object deletion. Pack
deletion is conditional — a deletion that neither removes a complete pack owning
canonical rows nor promotes a fallback changes nothing a complete read can
observe, and a pending-only reclamation must not restart in-flight maintenance.
Pending sources are covered by ingest *ownership*, not by the generation: only
the owning ingest can write a pending pack's rows, and only that owner reads
with its pack id.

**A maintenance run records two identities.** Alongside the root epoch it stores
`git_maintenance_runs.observed_source_generation`. A step that changes sources
adopts its own bump as the **last statement of that step's transaction**; a step
that does not change sources compares the recorded value against the
repository's, and a mismatch restarts discovery before any further destruction.

## Consequences

- A pack from a non-Git producer with a chain deeper than 4,095 edges fails at
  ingest with `ECORRUPT`.
- A packed read never writes, so on `@kompjutr/local` a read-only caller never
  takes the writer reservation, and on a Durable Object it bills no row writes.
- A wide batch whose closure exceeds one graph costs one extra graph query per
  split, and each failed query reads up to 4,097 rows. The halving caps the split
  depth at log₂ of the 4,096-input batch limit: one maximal chain among 4,096
  wanted OIDs costs about 12 failed queries, roughly 49,000 rows.
- One extra `UPDATE` per loose write or batch flush, gated on actually writing a
  `git_objects` row.
- A source change restarts maintenance the way a root change does, so a
  write-heavy repository can delay collection. That is the root-epoch behaviour
  on a second axis.

## Alternatives considered

- **Keep the 50,000-edge cap and page long reads through scratch tables.** It
  accepted deeper foreign packs, but every paged read became a write
  transaction with its own snapshot and scratch schema, for chains Git never
  writes.
- **Fail a batch whose closure exceeds one graph.** Pushes batch sizing onto
  every caller, although the store can always split a batch down to one chain.
- **Bump the generation for pending writes too.** `PackObjectBatch.flush` runs
  per batch during a fetch; every concurrent maintenance run would restart for
  rows no reader can see.
- **Reset only the drifted part of a run.** Cheaper than restarting discovery,
  but it needs a second reset mechanism with its own correctness argument.
