// P1 from §7.0: the bulk reads. `scan` is one statement per page and `glob`
// is one statement, both an indexed range scan on the `fs_paths` primary key
// — no recursion, no CTE, no traversal.
//
// BINARY collation over the whole path is UTF-8 byte order, which is what
// `comparePaths` defines and what every merge join above this layer consumes,
// so the physical scan order IS the output order and `ORDER BY path` costs
// nothing.

import { readBlob, type SqlDatabase } from "../../sqlite/db.js";
import { comparePaths, subtreeSuccessor } from "../path.js";
import {
  type EntryType,
  type RealPath,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  type ScanEntry,
  type ScanOptions,
} from "../types.js";

/** The DO SQLite ceiling on a GLOB/LIKE pattern. */
export const GLOB_PATTERN_MAX_BYTES = 50;

const PERMISSION_BITS = 0o7777;

const TYPE_BITS: Record<EntryType, number> = {
  file: S_IFREG,
  dir: S_IFDIR,
  symlink: S_IFLNK,
};

const ENCODER = new TextEncoder();

// Written without table aliases on purpose: the query plan then names the
// tables, so the gate can assert on the plan the design specifies.
//
// `rev` is selected on top of §7.0's column list because `ScanEntry` carries
// it; a column costs nothing, and six inherited cases assert on it.
const SELECT_PAGE = `SELECT fs_paths.path AS path,
       fs_paths.inode AS inode,
       fs_nodes.type AS type,
       fs_nodes.mode AS mode,
       fs_nodes.mtime AS mtime,
       fs_nodes.size AS size,
       fs_nodes.rev AS rev,
       fs_nodes.nlink AS nlink,
       fs_nodes.link_target AS link_target,
       fs_nodes.content_id AS content_id
  FROM fs_paths
  JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode
 WHERE fs_paths.path > ? AND fs_paths.path < ?`;

const SCAN_SQL = `${SELECT_PAGE}
 ORDER BY fs_paths.path
 LIMIT ?`;

const SCAN_FILES_SQL = `${SELECT_PAGE}
   AND fs_nodes.type <> 'dir'
 ORDER BY fs_paths.path
 LIMIT ?`;

const GLOB_SQL = `SELECT fs_paths.path AS path
  FROM fs_paths
 WHERE fs_paths.path > ? AND fs_paths.path < ? AND fs_paths.path GLOB ?
 ORDER BY fs_paths.path
 LIMIT ?`;

interface ScanRow {
  path: string;
  inode: number;
  type: string;
  mode: number;
  mtime: number;
  size: number;
  rev: number;
  nlink: number;
  link_target: string | null;
  content_id: Uint8Array | ArrayBuffer | null;
}

/** The CHECK constraint guarantees this; the throw keeps the type honest. */
function entryType(value: string): EntryType {
  if (value === "file" || value === "dir" || value === "symlink") return value;
  throw new Error(`fs_nodes.type is not a known entry type: ${value}`);
}

function toEntry(row: ScanRow): ScanEntry {
  const type = entryType(row.type);
  return {
    path: row.path,
    ino: row.inode,
    type,
    // `fs_nodes.mode` holds permission bits; `Stat.mode` is full st_mode.
    mode: TYPE_BITS[type] | (row.mode & PERMISSION_BITS),
    size: row.size,
    mtime: row.mtime,
    nlink: row.nlink,
    rev: row.rev,
    target: row.link_target,
    contentId: row.content_id === null ? null : readBlob(row.content_id),
  };
}

/**
 * The half-open key range holding exactly the subtree under `root`, root row
 * excluded.
 *
 * The lower bound is `root + "/"`, not `root`. `'-'` is 0x2D and `'.'` is
 * 0x2E, both below `'/'` at 0x2F, so `path > "/repo/src"` would also admit
 * `/repo/src-extra` and `/repo/src.txt` — which is the same mistake a naive
 * `LIKE 'prefix%'` makes. The upper bound is `subtreeSuccessor`, `root + "0"`,
 * because `'0'` is 0x30 and therefore the immediate successor of `'/'`.
 */
function subtreeBounds(root: RealPath): { lower: string; upper: string } {
  return { lower: root === "/" ? "/" : `${root}/`, upper: subtreeSuccessor(root) };
}

/**
 * One page of everything under `root`, in path byte order.
 *
 * ONE statement per page. `root` is a `RealPath` rather than a string because
 * the caller pages: resolving inside would cost a `realpath` statement per
 * page and turn a 13-statement walk into a 26-statement one. It is also the
 * §3.6 invariant — only real paths reach `fs_paths`.
 *
 * Paging is keyset. The caller resumes at the last path returned; to skip an
 * ignored subtree it resumes at `subtreeSuccessor(dir)` instead. There is no
 * server-side prune list because only the caller can evaluate a `.gitignore`.
 */
export function scan(db: SqlDatabase, root: RealPath, options: ScanOptions): ScanEntry[] {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`scan: limit must be a positive integer, got ${limit}`);
  }

  const { lower, upper } = subtreeBounds(root);
  // A resume cursor from outside the subtree must not widen the range.
  const after =
    options.after !== undefined && comparePaths(options.after, lower) > 0 ? options.after : lower;

  const sql = options.filesOnly === true ? SCAN_FILES_SQL : SCAN_SQL;
  return db.all<ScanRow>(sql, after, upper, limit).map(toEntry);
}

/**
 * Every path under `root` matching a GLOB pattern, in path order. One
 * statement.
 *
 * The pattern is matched against the whole stored path, not a suffix relative
 * to `root`, so pattern and result speak the same language and no `substr`
 * is involved — `substr` counts bytes over a BLOB and characters over TEXT,
 * and mixing the two corrupts silently.
 *
 * `options.limit` is unbounded when omitted; SQLite reads a negative LIMIT as
 * no limit, so the query text stays single.
 */
export function glob(
  db: SqlDatabase,
  root: RealPath,
  pattern: string,
  options: { limit?: number } = {},
): string[] {
  const bytes = ENCODER.encode(pattern).length;
  if (bytes > GLOB_PATTERN_MAX_BYTES) {
    throw new Error(
      `glob: pattern is ${bytes} bytes; the platform caps a GLOB pattern at ${GLOB_PATTERN_MAX_BYTES}`,
    );
  }

  const { lower, upper } = subtreeBounds(root);
  return db
    .all<{ path: string }>(GLOB_SQL, lower, upper, pattern, options.limit ?? -1)
    .map((row) => row.path);
}
