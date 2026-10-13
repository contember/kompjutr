---
id: 0032
title: Scope filesystem revisions to subtrees with ancestor marks
status: accepted
date: 2026-10-13
---

# 0032 — Scope filesystem revisions to subtrees with ancestor marks

## Context

`Filesystem.rev()` is one counter that every mutating call bumps. A host that
keeps one checkout per editing session in a single workspace caches derived
state per checkout, such as a render snapshot. With one counter, a write in any
session invalidates the cache of every session. The cache asks for its revision
before every read, so the read must be cheap. Every mutating call already pays
for one revision bump and no more (the filesystem's cost rule), so the write
side must stay close to that.

The answer must move for every change a reader of the subtree could see:
content, metadata, a create, a removal, a rename in or out, and the removal or
rename of an ancestor. It must not move for a write elsewhere, and it must stay
monotonic across a Durable Object restart.

## Decision

We keep one global revision and add `fs_subtree_revs(path, rev, replaced_rev)`.
Both columns hold global revision values.

- A mutating call marks the parent directory of every entry it creates or
  changes in place, and every ancestor of that directory, with its revision.
  `rev` means "something at or below this path changed". There is one row per
  distinct directory, not per file, and one upsert statement per call.
- A call that removes or renames a path also sets `replaced_rev` on that path.
  This invalidates everything below it without visiting it. A replaced
  directory drops the rows below it in one more statement, because its
  `replaced_rev` is newer than all of them.
- An in-place change to a hard-linked inode also marks the parents of its
  other names. Only SQL can see those names, so the upsert finds them through
  `fs_paths_by_inode`.
- `subtreeRev(root)` is one statement: the maximum of the root's `rev`, the
  `replaced_rev` of the root and every ancestor, and the root's own node
  revision. The node revision covers a file or directory that changed itself,
  so a file needs no row of its own.

A mounted view answers with its mount source's value. Above the mounts, it
answers with the newest value of the mounts below. Outside every mount, it
answers 0.

## Consequences

- A read costs one statement whatever the subtree's size. A mutating call
  costs one more statement, and one more again when it removes or renames a
  directory. In the statement gate, 15 of 47 operations rose by 1 to 10
  statements (`rebase.transition-2n`: 1,118 to 1,128). Rows read stayed
  inside the gate's tolerance.
- The table holds the directories that changed, plus the names that were
  removed or renamed away. A removed name keeps its row until an ancestor is
  replaced, so a long-lived directory that churns unique file names grows by
  one small row per name.
- Every new mutation path must call `recordSubtreeChanges` inside its
  transaction, after its revision bump. A path that skips it leaves caches
  stale without any error. `tests/fs/subtree-rev.test.ts` compares the
  observable state of a subtree with its revision over a seeded walk.
- When only the link count of a surviving hard link changes, because another
  name was removed or replaced, the containing directory's revision does not
  move. The survivor's own node revision still moves.
- The schema version is now 2. A version-1 database is refused, as for any
  schema change.

## Alternatives considered

- **Compute the maximum node revision over the subtree at read time.** This
  needs no write cost, but the read scans the whole subtree. It also cannot
  see a removal or a rename out, because the row is gone.
- **Mark every changed path, files included.** This makes reads simpler, but
  it adds one row per written file to every checkout. The node revision
  already carries that information.
- **Use SQLite triggers on `fs_paths` and `fs_nodes`.** Triggers fire per row,
  so a bulk write would pay per file. A recursive removal would also have to
  visit every row it deletes.
- **Use a counter per registered checkout.** This would tie the filesystem to
  Git checkouts. A subtree is the filesystem's own unit, and a mounted view is
  one.
