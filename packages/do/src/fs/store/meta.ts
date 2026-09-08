// `fs_meta` accessors: the revision counter and the inode allocator.

import type { SqlDatabase } from "../../db/db.js";

/**
 * The current revision. Bumped once per mutating *call*, not per row, so a
 * poller can use it to decide whether anything changed at all.
 */
export function currentRev(db: SqlDatabase): number {
  return db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'") ?? 0;
}

/** Bump and return the new revision in one statement. */
export function bumpRev(db: SqlDatabase): number {
  const revision = db.scalar<number>("UPDATE fs_meta SET v = v + 1 WHERE k = 'rev' RETURNING v");
  if (revision === undefined) throw new Error("fs schema not initialised");
  return revision;
}

/**
 * Reserve `count` consecutive inodes and return the first.
 *
 * Explicit rather than AUTOINCREMENT because a bulk write has to know every
 * inode before it can build its payload — and AUTOINCREMENT would also write
 * a `sqlite_sequence` row per insert.
 */
export function allocateInodes(db: SqlDatabase, count: number): number {
  if (count <= 0) throw new Error("allocateInodes: count must be positive");
  const first = db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'");
  if (first === undefined) throw new Error("fs schema not initialised");
  db.run("UPDATE fs_meta SET v = v + ? WHERE k = 'next_inode'", count);
  return first;
}
