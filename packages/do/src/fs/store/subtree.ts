// Subtree revisions: the global revision, scoped to one directory subtree.
//
// `fs_subtree_revs` holds two marks per path, both global revision values:
//
//   rev           — the last call that changed something at or below the path;
//   replaced_rev  — the last call that removed, renamed or replaced the path
//                   itself, which invalidates everything below it at once.
//
// A call marks the parent directory of every entry it creates or changes and
// all of that directory's ancestors: one upsert row per distinct directory,
// not one per file. The entry itself needs no row, because its own node
// revision already moved. So the revision of `root` is the maximum of its own
// `rev`, the `replaced_rev` of itself and every ancestor, and its node
// revision. Reading it is one statement whatever the subtree's size.
//
// A replaced root drops the rows strictly below it: its `replaced_rev` is
// newer than all of them, so the table stays bounded by the live directories
// plus the names removed or renamed away.

import type { SqlDatabase } from "../../db/db.js";
import { dirname, prefixesOf } from "../path.js";
import type { RealPath } from "../types.js";
import { jsonBatches, utf8Length } from "./write/write-batches.js";

export interface SubtreeChanges {
  /** Directories whose contents changed below them, when no single entry says so. */
  readonly directories?: Iterable<string>;
  /** Entries created under an existing or newly created parent. */
  readonly created?: Iterable<string>;
  /** Entries whose node changed in place. Every hard-link name is marked. */
  readonly changedInPlace?: Iterable<string>;
  /** Entries removed, renamed away, or renamed onto. Never `/`. */
  readonly replaced?: Iterable<ReplacedEntry>;
}

export interface ReplacedEntry {
  readonly path: string;
  /**
   * Whether rows below the entry may exist and must be dropped. Only a
   * directory leaves them, so a file removal skips the statement.
   */
  readonly directory: boolean;
}

const DROP_BELOW = `DELETE FROM fs_subtree_revs
 WHERE path IN (
   SELECT below.path
     FROM json_each(?) root
     JOIN fs_subtree_revs below
       ON below.path >= root.value || '/' AND below.path < root.value || '0'
 )`;

/**
 * Binds the entries changed in place, then `[[path, replaced], …]` already
 * expanded to every ancestor. The other names of a hard-linked entry are found
 * here and expanded through `fs_paths.parent`, since only SQL sees them.
 * `WHERE true` lets SQLite parse the upsert on a SELECT-fed INSERT.
 */
const MARK = `WITH RECURSIVE
  linked(path) AS (
    SELECT name.parent
      FROM json_each(?) changed
      JOIN fs_paths named ON named.path = changed.value
      JOIN fs_nodes node ON node.inode = named.inode AND node.nlink > 1
      JOIN fs_paths name ON name.inode = node.inode
     WHERE name.parent <> ''
    UNION
    SELECT up.parent
      FROM linked JOIN fs_paths up ON up.path = linked.path
     WHERE up.parent <> ''
  ),
  marked(path, replaced) AS (
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
    UNION ALL
    SELECT path, 0 FROM linked
  )
INSERT INTO fs_subtree_revs (path, rev, replaced_rev)
SELECT marked.path, current.v, CASE WHEN max(marked.replaced) = 1 THEN current.v ELSE 0 END
  FROM marked, (SELECT v FROM fs_meta WHERE k = 'rev') current
 WHERE true
 GROUP BY marked.path
ON CONFLICT(path) DO UPDATE SET
  rev = excluded.rev,
  replaced_rev = max(replaced_rev, excluded.replaced_rev)`;

const READ = `SELECT max(
  coalesce((SELECT rev FROM fs_subtree_revs WHERE path = ?), 0),
  coalesce((SELECT max(mark.replaced_rev)
              FROM json_each(?) prefix
              JOIN fs_subtree_revs mark ON mark.path = prefix.value), 0),
  coalesce((SELECT node.rev
              FROM fs_paths entry JOIN fs_nodes node ON node.inode = entry.inode
             WHERE entry.path = ?), 0)
) AS rev`;

function addAncestry(marks: Map<string, boolean>, directory: string): void {
  for (const prefix of prefixesOf(directory)) {
    if (!marks.has(prefix)) marks.set(prefix, false);
  }
}

function batchesOf(values: readonly string[]): string[] {
  const items = values.map((value) => JSON.stringify(value));
  return jsonBatches(items, items.map(utf8Length));
}

/**
 * Record one mutating call in the subtree marks. Runs inside the caller's
 * transaction, after its revision bump, and reads that revision from
 * `fs_meta`. One statement in the common case, plus one when the call
 * replaced a directory.
 */
export function recordSubtreeChanges(db: SqlDatabase, changes: SubtreeChanges): void {
  const marks = new Map<string, boolean>();
  for (const path of changes.directories ?? []) addAncestry(marks, path);
  for (const path of changes.created ?? []) addAncestry(marks, dirname(path));
  const inPlace = [...(changes.changedInPlace ?? [])];
  for (const path of inPlace) {
    if (path !== "/") addAncestry(marks, dirname(path));
  }
  const directories: string[] = [];
  for (const { path, directory } of changes.replaced ?? []) {
    if (path === "/") throw new Error("the filesystem root cannot be replaced");
    addAncestry(marks, dirname(path));
    marks.set(path, true);
    if (directory) directories.push(path);
  }
  if (marks.size === 0) return;

  for (const batch of batchesOf(directories)) db.run(DROP_BELOW, batch);
  const items = [...marks].map(([path, whole]) => `[${JSON.stringify(path)},${whole ? 1 : 0}]`);
  const markBatches = jsonBatches(items, items.map(utf8Length));
  const linkedBatches = batchesOf(inPlace);
  const statements = Math.max(markBatches.length, linkedBatches.length);
  for (let index = 0; index < statements; index++) {
    db.run(MARK, linkedBatches[index] ?? "[]", markBatches[index] ?? "[]");
  }
}

/** The revision of everything at and below `root`. One statement. */
export function subtreeRev(db: SqlDatabase, root: RealPath): number {
  return db.scalar<number>(READ, root, JSON.stringify(prefixesOf(root)), root) ?? 0;
}
