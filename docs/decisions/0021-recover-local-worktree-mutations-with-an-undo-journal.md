---
id: 0021
title: Recover local worktree mutations with an undo journal
status: accepted
date: 2026-09-07
---

# 0021 — Recover local worktree mutations with an undo journal

## Context

The Durable Object runtime commits Git, index, and filesystem rows in one SQLite
transaction. A local runtime stores Git state in SQLite but materializes files on
the host filesystem, which has no atomic commit shared with SQLite. A process can
stop after changing files and before publishing the matching index or ref state,
or after SQLite commits but before temporary backups are removed.

Locking prevents two writers from interleaving, but it cannot repair a partial
checkout, reset, merge, replay, or rebase. Rewriting each Git operation around a
new distributed transaction would also put the existing DO path at risk.

## Decision

`LocalWorkspace` holds a coarse exclusive Unix process lock for its lifetime.
Its Node SQLite adapter and `DiskDrive` share one opaque mutation scope and one
recovery coordinator. The lock is an exclusive transaction in a root-keyed
SQLite database beside the worktree, so alternate state configurations contend,
process death releases ownership in the kernel, and stale-owner reclamation has
no user-space race.

The coordinator first creates and syncs its journal. Before application mutation,
it verifies device IDs and records, syncs, and executes a live crash-cleanable
rename probe for each source-parent/recovery pair. Equal `st_dev` values are not
sufficient because distinct mounts can still reject rename. It then writes and
syncs length- and checksum-framed application intents before renaming existing
targets into recovery storage. Backup moves sync both parent directories;
replacement files and their destination directories are synced before SQLite
publication. Disk writes become visible immediately. The outer SQLite
transaction advances a recovery generation with Git and index publication, then
commits before backups are discarded.

The lifetime lock is acquired before startup recovery. SQLite recovery runs
first. A manifest whose target generation was not committed is undone in reverse
order. A manifest whose generation was committed is rolled forward by retaining
the new files and deleting backups. Both paths, including cleanup and journal
removal, are synced and idempotent. An incomplete final frame is ignored because
its mutation could not have started; semantic corruption fails closed.

A reported `COMMIT` error is uncertain. The adapter closes and reopens SQLite,
reads the recovered generation under the same lock, and settles from that fact
rather than assuming commit or rollback.

Every coupled Git operation checks the shared mutation scope before its first
side effect. Unsupported database/drive combinations fail with `EUNSUPPORTED`.
Shared and Worker code continue to call only `transactionSync()`; transaction SQL
and filesystem durability operations live in `@kompjutr/local`.

Each nested SQL transaction owns a SQLite savepoint. On failure, close and
invalidate cursors created or advanced in that scope, then roll back and release
the savepoint. A successful child scope transfers cursor ownership to its parent;
an outer rollback must also invalidate cursors from successful children. Resuming
an invalidated cursor fails with `ESTALE`, including a cursor that had not started.

SQL rollback is immediate even when the outer closure catches the failure. If the
failed scope recorded disk effects, refuse the outer commit with `ERECOVERY` and
let the existing undo journal restore the whole disk transaction. A failed drive
operation may independently mark the transaction abort-only. Observation leases
remain outside this scope because they commit on their own connection.

A caught SQL-only failure leaves the outer transaction usable, matching Durable
Object savepoint behavior. In particular, a rejected Git mutation reentry must not
abort its successful owner. Use SQLite rollback rather than inferring SQL effects:
`total_changes()` misses unfinished `RETURNING` statements, and a main schema
cookie misses TEMP DDL and transactional header PRAGMAs. Manually assigned signed
schema cookies are not recovery counters and are not inspected at nested entry.

The exact protocol is specified in
[`scoped-packages-and-local-runtime.md`](../specs/scoped-packages-and-local-runtime.md#local-undo-protocol).

## Consequences

- A stopped local process converges to either the old database and worktree or
  the new database and worktree after reopen.
- Existing synchronous Git algorithms retain read-your-writes behavior and do
  not gain a per-operation recovery implementation.
- Failed nested SQL writes disappear before control returns to the outer closure;
  disk effects remain visible until the refused outer transaction is rolled back.
- Pending write cursors must finish before SQLite can release their savepoint or
  commit the transaction. Successful read cursors may outlive their scope.
- Local mutation pays backup, journal, rename, and fsync cost. Correct recovery
  is prioritized over matching the DO filesystem's write latency.
- Every target must share a filesystem with recovery storage. Nested mounts and
  unsupported filesystems fail with no committed operation effect.
- Rename probes may change parent-directory metadata and emit transient
  filesystem events. Recovery guarantees caller entry/content convergence, not
  invisible probing.
- External programs that ignore the workspace lock remain outside the atomicity
  guarantee; conservative stat revisions still prevent their metadata from being
  trusted as content identity.
- Path resolution rejects lexical and observed symlink escapes, but pure Node
  lacks descriptor-relative mutation calls. Containment therefore excludes a
  hostile process that ignores the lifetime lock and swaps a checked directory
  ancestor or fixed state artifact before the following filesystem call.
- Exact directory aliases are rejected. Portable Node APIs do not expose
  mount-aware ancestry, so pre-existing bind aliases of nested worktree, state,
  or recovery directories are unsupported.

## Alternatives considered

- Blanket abort-only for every nested exception breaks deliberate caught reentry.
  Detecting effects through counters is incomplete for public SQL callers.
- Independent disk savepoints require a separate nested undo protocol. SQL
  savepoints plus whole-transaction disk rollback retain one recovery generation
  and the existing first-touch journal ownership.
- Materializing a complete shadow worktree and swapping the root is attractive
  for disposable directories, but it mishandles untracked files, open paths,
  nested mounts, and roots that cannot be replaced.
- Operation-specific redo journals could resume individual Git commands, but
  they duplicate recovery logic across every mutation family and threaten the
  optimized DO transaction path.
- A process lock without recovery leaves disk and SQLite inconsistent after a
  crash.
