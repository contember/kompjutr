---
id: 0030
title: Project trees on demand as a downward-closed set
status: accepted
date: 2026-10-07
---

# 0030 — Project trees on demand as a downward-closed set

## Context

Tree walks run as one recursive SQL statement over `git_tree_sources` and
`git_tree_entries` ([ADR-0009](0009-persisted-git-storage-formats.md)). Pack
ingest projects every received tree. On the full-history `blob:none` clone of
Next.js v15.5.2 that is 6,689,426 entry rows and 43.6 s of writes plus 22.5 s
of parsing, a third of the 197 s clone. The `HEAD` checkout reads 34,746 of
those rows (0.52 %). Native Git keeps no projection; it parses a tree object
whenever it reads it.

Until [ADR-0029](0029-check-fetched-connectivity-per-pack.md), fetch
connectivity and promise registration also read every received tree's
projection. After it, only tree walks, sparse snapshots and maintenance
expansion read projections.

## Decision

Pack ingest no longer projects trees. A tree is projected when a reader first
needs it, and loose tree writes keep projecting eagerly.

A tree OID has one of three projection states:

- **no row** — not projected yet;
- **`complete = 0`** — unprojectable (an oversized tree), terminal;
- **`complete = 1`** — projected.

A loose tree's insert trigger also seeds a `complete = 0` row that the same
transaction completes; that placeholder is transaction-local and never
committed as such, so it is not a fourth committed state.

**Invariant: the projected set is downward-closed.** If a tree is projected,
every subtree it names is projected or unprojectable. A walk therefore needs
only its root to be projected; it meets an unprojectable subtree exactly where
it does today.

- `ensureTreeClosure(roots)` projects every tree of the roots' closures that
  has no row. It reads the tree objects through the ordinary object
  reader, parses them, and writes sources and entries level by level. It stops
  at subtrees that are projected or unprojectable, because the invariant
  guarantees their closure. The subtrees of a tree that turns out to be
  unprojectable are not visited. A missing tree object is `ObjectNotFoundError`; an
  object of another type is `CorruptError`. All of it runs in one `transactionSync`, nested as a savepoint when a
  caller already holds one, so a fault leaves no partial closure.
- A tree walk starts without a check. If the walk reports a structured
  `missing_root` error (its root has no row) before it yields any row, the
  wrapper closes the cursor, ensures the root's closure and runs the walk once
  more. A walk over a projected tree costs no extra statement. Any other
  missing source stays `ECORRUPT`, including an unprojectable root. The walk
  API takes the object reader the closure needs; a fetch's connectivity
  check passes the repository's.
- A loose tree write projects the new tree and ensures the closure of its
  subtrees in the same transaction, so a written tree never names an
  unprojected subtree. The statement that completes the projection also
  reports whether the tree names a subtree without a row, so a write whose
  subtrees are projected runs no extra statement. Blob entries are not
  checked.
- Maintenance expands a tree from its projection when it is complete, and
  otherwise parses the object bytes without writing a projection. Marking all
  of history must not project all of history. The fallback accepts entry
  names the projection path refuses (non-UTF-8), because marking must
  over-approximate reachability.
- Sparse snapshot readers keep their existing fallback: a commit tree without a
  complete projection makes the snapshot unavailable, and the caller uses the
  full path.
- Projections are derived data: creating one does not bump
  `source_generation` ([ADR-0025](0025-scope-paged-read-metadata-and-linearize-maintenance-expansion.md))
  or the maintenance root epoch. Deletion is unchanged: a projection is deleted
  with the tree's last copy.

[ADR-0004](0004-trust-stored-rows-validate-at-the-boundary.md) still holds. A
projection is written from object bytes that were authenticated when they
entered the store, and reads trust it. A tree object that does not parse is
`CorruptError` when it is projected. An oversized tree that cannot be projected
fails its walk as before.

## Consequences

- A clone writes projection rows only for the trees its checkout reaches.
  Reading another tree for the first time (`log -p`, `show`, a diff against an
  old commit, push planning) pays a one-off parse and write for the trees that
  are not projected yet. Unchanged subtrees are shared, so walking history
  commit by commit projects each tree once.
- **Changed error.** A walk whose closure meets a missing tree object fails
  with `ENOTFOUND` from `ensureTreeClosure`. It used to fail as `ECORRUPT`
  ("no valid parsed source"). The walk already reports a subtree without a
  source row as `ENOTFOUND` through its `missing_source` error kind; an
  unprojectable subtree stays `ECORRUPT`.
- **Changed error.** Writing a loose tree whose subtree object is absent
  fails with `ENOTFOUND` and writes nothing. Otherwise a missing row would no
  longer mean a missing tree, and a subtree that arrived later would be
  misreported. Blob entries may still name absent or promised blobs.
- **Moved error.** Pack ingest no longer parses trees, except through a
  fetch's reference collector, which checks structure but not names. A tree
  whose entry name is not UTF-8 is published and refused with `EUNSUPPORTED`
  when it is first projected, as a loose write of it is refused; an unchecked
  ingest of a malformed tree is refused with `CorruptError` at the same point.
- A read can write. Every walk entry point must run where a `transactionSync`
  is legal, and an open cursor must be closed before the closure is written.
  Interleaved streams (status, three-way integration) are safe: a closure
  runs in a nested scope in which no other open cursor is advanced, so its
  rollback invalidates none of them.
- The first projection of a deep chain costs statements per level: each level
  is one probe and one object read. A 1,099-level packed chain costs several
  thousand statements once; later walks cost one.
- Deleting the last copy of a tree still deletes its projection. Maintenance
  sweeps unreachable trees across pages in OID order, so a child can go before
  its parent. If the parent later became reachable again and the child came
  back in a pack, the parent's projection would name a child without a row,
  and its walk would fail forever. So every sweep transaction that deletes
  storage first deletes the projection of every tree the run did not mark.
  A marked tree's subtrees are marked and never deleted, so every projection
  that remains stays downward-closed. The strip is one statement over the
  projection table; it bumps no generation or epoch. It also drops the
  projections of recent unmarked trees, which a later read projects again.
  Each destructive page scans the whole projection table, which on-demand
  projection keeps small.
- Promisor hydration ingests packs without the reference collector, so no
  tree content is checked there. A malformed tree such a pack publishes is
  unreachable from any ref, fails only if walked by OID, and is swept.
- Repositories that are never read deeply never pay for their history's
  projections, and the database is smaller by the unread projections.

## Alternatives considered

- **Keep eager projection and make it cheaper.** The previous sprint already
  removed repeated identity work. What remains is one entry row per tree edge
  of history, which a cheaper encoding cannot avoid.
- **Project in the background after the clone.** It spends the same work and
  storage later, and readers would still need the on-demand path for the trees
  that are not done yet.
- **Walk trees by parsing objects instead of projections.** It discards the
  single-statement SQL walks and their cost model, which every hot operation
  relies on.
- **Check every subtree on every walk.** A frontier query per walk would add
  statements to every hot read. The downward-closed invariant makes one root
  check sufficient, and the retry makes even that free.
