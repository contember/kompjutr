// Removal and rename over the path-keyed store (§3.7).
//
// Both operations are range work on the `fs_paths` primary key, which is
// what the path key buys and what it costs: a recursive removal is a range
// delete and is therefore a constant number of statements no matter how
// deep the tree, while a directory rename has to rewrite every descendant's
// key — one row per descendant, but still two statements.
//
// Neither function resolves symlinks. `fs_paths.path` is always a real path
// (§3.6), so callers pass paths that already came through `realpath`.

import type { SqlDatabase } from "../../sqlite/db.js";
import { codePointLength, dirname, normalize, subtreeSuccessor } from "../path.js";
import type { RemoveOptions } from "../types.js";

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// removeFiles
// ---------------------------------------------------------------------------

/**
 * The `fs_paths` rows a call removes: every named path that exists, plus
 * every descendant of every named directory.
 *
 * `UNION`, not `UNION ALL`: overlapping requests (`/a` and `/a/b`) would
 * otherwise name the same row twice, and the compound select also forces
 * SQLite to materialise the result, so `DELETE FROM fs_paths WHERE path IN
 * (…)` is not reading the table it is deleting from.
 *
 * The descendant bound is `[dir || '/', dir || '0')` — `'0'` is 0x30 and
 * `'/'` is 0x2F, so it stops exactly at the subtree edge. A `LIKE 'dir%'`
 * would also swallow `dir-extra`, `dir0` and `dirx`.
 */
const TARGETS = `SELECT p.path AS path, p.inode AS inode
       FROM json_each(?) r JOIN fs_paths p ON p.path = r.value
      UNION
     SELECT p.path, p.inode
       FROM json_each(?) r JOIN fs_paths p
            ON p.path >= r.value || '/' AND p.path < r.value || '0'`;

/**
 * Whether the path of `alias` is one of the rows this call removes.
 *
 * The named list is an `IN (SELECT … json_each)` and not a correlated
 * `EXISTS`: SQLite builds the right-hand side of `IN` once and binary
 * searches it, where the `EXISTS` form re-runs `json_each` per candidate
 * row and turns a 5,000-path call into 25M virtual-table steps.
 */
function inTargets(alias: string): string {
  return `(${alias}.path IN (SELECT value FROM json_each(?))
        OR EXISTS (SELECT 1 FROM json_each(?) r
                    WHERE ${alias}.path >= r.value || '/' AND ${alias}.path < r.value || '0'))`;
}

/**
 * Inodes losing their last name: as many rows in this call's target set as
 * they have path rows at all. Counted against `fs_paths` rather than against
 * `nlink`, so a drifted counter can neither strand content nor delete it
 * early.
 */
const ORPHANS = `SELECT t.inode FROM (${TARGETS}) t
      GROUP BY t.inode
      HAVING count(*) = (SELECT count(*) FROM fs_paths q WHERE q.inode = t.inode)`;

interface RequestedRow {
  path: string;
  type: string | null;
  child: number;
}

/** One row per requested path: what it is, and whether it has children. */
const CLASSIFY = `SELECT r.value AS path, n.type AS type,
       EXISTS (SELECT 1 FROM fs_paths c
                WHERE c.path >= r.value || '/' AND c.path < r.value || '0') AS child
  FROM json_each(?) r
  LEFT JOIN fs_paths p ON p.path = r.value
  LEFT JOIN fs_nodes n ON n.inode = p.inode`;

const BUMP_REV = "UPDATE fs_meta SET v = v + 1 WHERE k = 'rev'";

const DELETE_CHUNKS = `DELETE FROM fs_chunks WHERE inode IN (${ORPHANS})`;

const DELETE_NODES = `DELETE FROM fs_nodes WHERE inode IN (${ORPHANS})`;

/**
 * Survivors only — the orphans are already gone, so this writes nothing
 * unless a hardlink is losing one of several names. `nlink` is recomputed
 * from the rows that remain rather than decremented, so it cannot drift.
 */
const RELINK = `UPDATE fs_nodes
   SET nlink = (SELECT count(*) FROM fs_paths q
                 WHERE q.inode = fs_nodes.inode AND NOT ${inTargets("q")}),
       rev = (SELECT v FROM fs_meta WHERE k = 'rev')
 WHERE inode IN (SELECT t.inode FROM (${TARGETS}) t)`;

const DELETE_PATHS = `DELETE FROM fs_paths WHERE path IN (SELECT t.path FROM (${TARGETS}) t)`;

/**
 * Remove many paths. Six statements regardless of how many paths are named
 * or how deep the trees under them are: the descendants are found by a
 * range scan on the `fs_paths` primary key, never enumerated in JS.
 *
 * `fs_nodes` and `fs_chunks` rows go with their inode, but only when no
 * surviving path still names it — `nlink` may be greater than one.
 *
 * Bumps `fs_meta.rev` once, and only when something is actually removed.
 * Note the asymmetry with `rename`, which cannot afford the statement.
 */
export function removeFiles(
  db: SqlDatabase,
  paths: readonly string[],
  options: RemoveOptions = {},
): void {
  const recursive = options.recursive ?? false;
  const force = options.force ?? true;
  if (paths.length === 0) return;

  const requested = paths.map(normalize);
  for (const path of requested) {
    // A range delete of '/' would take the root row with it and leave the
    // filesystem without a mount point.
    if (path === "/") throw fsError("EBUSY", "EBUSY: resource busy or locked, rm '/'");
  }

  const rows = db.all<RequestedRow>(CLASSIFY, JSON.stringify(requested));

  const exact: string[] = [];
  const subtrees: string[] = [];
  for (const row of rows) {
    if (row.type === null) {
      if (!force) {
        throw fsError("ENOENT", `ENOENT: no such file or directory, rm '${row.path}'`);
      }
      continue;
    }
    if (row.type === "dir") {
      if (!recursive) {
        if (row.child !== 0) {
          throw fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty, rm '${row.path}'`);
        }
      } else {
        subtrees.push(row.path);
      }
    }
    exact.push(row.path);
  }
  if (exact.length === 0) return;

  const named = JSON.stringify(exact);
  const roots = JSON.stringify(subtrees);

  db.transactionSync(() => {
    db.run(BUMP_REV);
    db.run(DELETE_CHUNKS, named, roots);
    db.run(DELETE_NODES, named, roots);
    db.run(RELINK, named, roots, named, roots);
    db.run(DELETE_PATHS, named, roots);
  });
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

/**
 * The subtree key rewrite, §3.7 verbatim.
 *
 * `?oldLen` is code points, not bytes: this is a TEXT `substr()`, and the
 * byte form mis-slices every descendant of a non-ASCII directory without
 * raising (§7.0).
 */
const RENAME_SUBTREE = `UPDATE fs_paths
   SET path   = ? || substr(path, ? + 1),
       parent = CASE WHEN parent = ? THEN ?
                     ELSE ? || substr(parent, ? + 1) END
 WHERE path >= ? || '/' AND path < ?`;

/** The root row, whose `parent` also moves when the destination differs. */
const RENAME_ROOT = "UPDATE fs_paths SET path = ?, parent = ? WHERE path = ?";

/**
 * Move `oldPath` to `newPath`, subtree included. Two statements at every
 * size; `fs_nodes` and `fs_chunks` are untouched, because no content moves.
 *
 * A raw primitive: it does not check that `oldPath` exists, that the
 * destination's parent does, or that the destination is free — a collision
 * surfaces as the primary key's own UNIQUE failure. The single-path layer
 * above adds POSIX's checks. It also does not bump `fs_meta.rev`, which
 * would be a third statement; the composing layer owns that.
 */
export function rename(db: SqlDatabase, oldPath: string, newPath: string): void {
  const oldRoot = normalize(oldPath);
  const newRoot = normalize(newPath);
  if (oldRoot === "/" || newRoot === "/") {
    throw fsError("EBUSY", `EBUSY: resource busy or locked, rename '${oldRoot}' -> '${newRoot}'`);
  }
  // Free to check, and the one destination the range rewrite cannot express:
  // the rewritten rows would land back inside their own scan range.
  if (newRoot.startsWith(`${oldRoot}/`)) {
    throw fsError(
      "EINVAL",
      `EINVAL: invalid argument, rename '${oldRoot}' -> '${newRoot}' is inside itself`,
    );
  }

  const oldLen = codePointLength(oldRoot);
  db.transactionSync(() => {
    db.run(
      RENAME_SUBTREE,
      newRoot,
      oldLen,
      oldRoot,
      newRoot,
      newRoot,
      oldLen,
      oldRoot,
      subtreeSuccessor(oldRoot),
    );
    db.run(RENAME_ROOT, newRoot, dirname(newRoot), oldRoot);
  });
}
