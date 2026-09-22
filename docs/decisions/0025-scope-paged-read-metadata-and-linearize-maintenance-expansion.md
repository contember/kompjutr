---
id: 0025
title: Scope paged read metadata and linearize maintenance expansion
status: accepted
date: 2026-09-22
---

# 0025 — Scope paged read metadata and linearize maintenance expansion

## Context

Two packed-dependency paths kept work proportional to the shape of the graph
rather than to its edges.

A paged packed read accumulated its whole discovery state in the isolate heap:
one page descriptor per step and one checkpoint set per origin, growing as
`origins x depth` with origins bounded by 4,096 and depth by 50,000. The pages
themselves were already bounded; what grew was the metadata that drove them.

Maintenance re-derived the *entire remaining delta suffix* of an object for each
expansion and then enqueued only its immediate base. For a chain of N edges that
is on the order of N² delivered rows across the run, even though every edge is
identical work.

Both are reachable through ordinary reads and public `maintenance()` calls, with
no out-of-band database mutation ([backlog 63](../backlog/63-bound-packed-dependency-graph-traversal.md)).

The second path was only expensive because it duplicated a guarantee the store
already owns: [ADR-0023](0023-validate-canonical-pack-dependencies-at-source-changes.md)
validates the affected canonical graph — type consistency, termination, and at
most 50,000 delta edges — inside *every* publication and deletion transaction.
What maintenance lacked was not the validation but a durable way to tell that
the graph it is traversing is still the graph admission accepted.

## Decision

**We give the repository a source generation.** `git_repositories.source_generation`
identifies the set of sources an ordinary complete read sees: for every OID,
which loose row or which complete pack serves it and which canonical delta edge
it carries. Exactly four owners bump it, each inside the transaction that makes
the change visible: pack publication, pack storage deletion, loose object
writes, and loose object deletion. Pack deletion is conditional — a deletion that
neither removes a complete pack owning canonical rows nor promotes a fallback
changes nothing a complete read can observe, and a pending-only reclamation must
not restart in-flight maintenance. Pending sources are covered by ingest
*ownership*, not by the generation: only the owning ingest can write a pending
pack's rows, and only that owner reads with its pack id.

**We move a paged read's discovery frontier into owner-scoped scratch rows.**
`git_pack_read_scopes`, `git_pack_read_pages` and `git_pack_read_frontier` hold
the page list and the per-origin frontier. The frontier's
`UNIQUE (repo_id, read_id, origin_id, oid)` index *is* the per-origin checkpoint
set: an insert that returns no row is a cycle. The scope is **paged-only** — an
ordinary non-paged packed read opens no transaction, writes no scratch and issues
no extra statement. The scope snapshots the source generation (and, for a pending
read, that pack's state) on entry and re-asserts it immediately before releasing
its owner row.

**We replace the recursive suffix walk with one non-recursive single-row
statement per expansion.** `/* maintenance-pack-base */` returns the object's
type, its canonical `base_oid`, and the base's type resolved with explicit
packed-over-loose precedence. Cycle and depth validation for the maintenance
traversal moves to ADR-0023's admission and is no longer re-derived per queued
object; source checks, physical-only bases, promises, restart ownership and epoch
invalidation are preserved and independently enforced.

**A maintenance run records two identities.** Alongside the root epoch it stores
`git_maintenance_runs.observed_source_generation`. A step that changes sources
adopts its own bump as the **last statement of that step's transaction**; a step
that does not change sources compares the recorded value against the repository's,
and a mismatch settles the owned repack batch and restarts discovery before any
further destruction.

## Consequences

- Live metadata across a paged read's pages is O(1). The `origins x depth`
  product is **relocated, not reduced**: it now costs rows in a `WITHOUT ROWID`
  table whose `UNIQUE` index makes each frontier row roughly two index entries.
- A paged read now issues scratch inserts and seeks, and on the local adapter it
  becomes a `BEGIN IMMEDIATE` write transaction with real WAL traffic. On a
  Durable Object it writes and deletes billable rows. Ordinary non-paged reads
  are unaffected.
- One extra `UPDATE` per loose write or batch flush, gated on actually writing a
  `git_objects` row.
- Maintenance dependency work for a chain of N edges drops from order N² over two
  to at most 3N + O(1) delivered rows. The constant is 3, not 2: a physical-only
  expansion can precede a logical requeue whose semantic page then defers the
  packed base across an exact 256-edge boundary.
- Drift inside a synchronous read scope is `ECORRUPT`
  ("packed read observed a source change"), not `ESTALE`: a read scope holds no
  durable ownership another writer can take, so a change there means a store seam
  mutated sources reentrantly. It is never retried.
- The base *type* verdict is now deferred to the child's own expansion rather
  than raised at the origin's. It is never lost — `finishMark` refuses to leave
  `mark` while any `expanded = 0` row remains — but a multi-edge fixture fails on
  a later `maintenance()` call than it did before.
- Cycle and depth coverage now depends on admission alone. If ADR-0023 has a gap,
  maintenance no longer provides a second line of defence; the ingest-level
  witnesses are what keep that honest.
- A source change now restarts maintenance the way a root change does, so a
  write-heavy repository can delay collection. That is the pre-existing root-epoch
  behaviour, on a second axis.

## Alternatives considered

- **Open the read scope on every packed read.** Simple and uniform, but it makes
  an ordinary scalar read a write transaction on the local adapter and adds a
  snapshot plus an exit check to the hottest path. Under the paged-only rule
  nothing changes for reads that already fit one bounded page.
- **Drop the per-origin checkpoint rows and rely on the depth cap.** Loses the
  `cyclic delta chain` verdict on the pending-visible graph, which ADR-0023 does
  not cover because admission runs after the state flip, and replaces an O(1)
  conflict check with up to 50,000 extra page queries before the cap fires.
- **Keep the recursive suffix walk as a second line of defence.** Retains a
  quadratic path forever to re-derive a guarantee that ADR-0023 already enforces
  in the transaction of every source change.
- **Bump the generation for pending writes too.** `PackObjectBatch.flush` runs
  per batch during a fetch; every concurrent maintenance run would restart for
  rows no reader can see.
- **Reset only the drifted part of a run.** Cheaper than restarting discovery,
  but it needs a second reset mechanism with its own correctness argument.
