// P1 from §7.0: the bulk reads. `scan` is one statement per page and `glob`
// is one statement, both an indexed range scan on the `fs_paths` primary key
// — no recursion, no CTE, no traversal.
//
// BINARY collation over the whole path is UTF-8 byte order, which is what
// `comparePaths` defines and what every merge join above this layer consumes,
// so the physical scan order IS the output order and `ORDER BY path` costs
// nothing.

import { readBlob, type SqlDatabase } from "../../db/db.js";
import { comparePaths, dirname, normalize, subtreeSuccessor } from "../path.js";
import {
  type EntryType,
  type GlobOptions,
  type GlobPage,
  type ListItem,
  type ListOptions,
  type ListPage,
  type RealPath,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  type ScanEntry,
  type ScanOptions,
} from "../types.js";
import { DISCOVERY_PAGE_MAX, subtreeBounds, validatePattern } from "./scan-shared.js";

const PERMISSION_BITS = 0o7777;
const TYPE_BITS: Record<EntryType, number> = {
  file: S_IFREG,
  dir: S_IFDIR,
  symlink: S_IFLNK,
};

export {
  DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX,
  DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES,
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES,
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS,
  DISCOVERY_EXCLUDE_ROOTS_MAX,
  DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES,
  DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS,
  discoverFiles,
  discoveryExcludeRootsJsonSegments,
  validateDiscoveryExcludeRoots,
} from "./discovery.js";
export { DISCOVERY_PAGE_MAX, GLOB_PATTERN_MAX_BYTES } from "./scan-shared.js";

// Written without table aliases on purpose: the query plan then names the
// tables, so the gate can assert on the plan the design specifies.
//
// `rev` is selected on top of §7.0's column list because `ScanEntry` carries
// it; a column costs nothing, and six inherited cases assert on it.
const SELECT_PAGE = `SELECT fs_paths.path AS path,
       fs_paths.inode AS inode,
       CASE
         WHEN typeof(fs_nodes.type) = 'text' AND fs_nodes.type = 'dir' THEN 'dir'
         WHEN typeof(fs_nodes.type) = 'text' AND fs_nodes.type = 'file' THEN 'file'
         WHEN typeof(fs_nodes.type) = 'text' AND fs_nodes.type = 'symlink' THEN 'symlink'
         ELSE ''
       END AS type,
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

const SCAN_INCLUSIVE_SQL = `${SELECT_PAGE}
   AND fs_paths.path >= ?
 ORDER BY fs_paths.path
 LIMIT ?`;

const SCAN_FILES_INCLUSIVE_SQL = `${SELECT_PAGE}
   AND fs_paths.path >= ?
   AND fs_nodes.type <> 'dir'
 ORDER BY fs_paths.path
 LIMIT ?`;

const GLOB_SQL = `SELECT fs_paths.path AS path
  FROM fs_paths
 WHERE fs_paths.path > ? AND fs_paths.path < ? AND fs_paths.path GLOB ?
 ORDER BY fs_paths.path
 LIMIT ?`;

const LIST_SELECT = `SELECT groups.directory AS directory,
       fs_paths.path AS path,
       fs_paths.inode AS inode,
       fs_nodes.type AS type,
       fs_nodes.mode AS mode,
       fs_nodes.mtime AS mtime,
       fs_nodes.size AS size,
       fs_nodes.rev AS rev,
       fs_nodes.nlink AS nlink,
       fs_nodes.link_target AS link_target,
       fs_nodes.content_id AS content_id
  FROM groups
  LEFT JOIN fs_paths ON fs_paths.parent = groups.directory
  LEFT JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode`;

const LIST_AFTER = ` WHERE (groups.directory > ?
          OR (groups.directory = ? AND coalesce(fs_paths.path, '') > ?))
 ORDER BY groups.directory, fs_paths.path
 LIMIT ?`;

const LIST_DIRECTORY_SQL = `WITH groups(directory) AS (VALUES (?))
${LIST_SELECT}
${LIST_AFTER}`;

const LIST_RECURSIVE_SQL = `WITH groups(directory) AS (
       SELECT ?
       UNION ALL
       SELECT fs_paths.path
         FROM fs_paths
         JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode
        WHERE fs_paths.path > ? AND fs_paths.path < ? AND fs_nodes.type = 'dir'
     )
${LIST_SELECT}
${LIST_AFTER}`;

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

interface ListRow {
  directory: unknown;
  path: unknown;
  inode: unknown;
  type: unknown;
  mode: unknown;
  mtime: unknown;
  size: unknown;
  rev: unknown;
  nlink: unknown;
  link_target: unknown;
  content_id: unknown;
}

function entryType(value: string): EntryType {
  if (value === "file" || value === "dir" || value === "symlink") return value;
  throw new Error("fs_nodes.type is not a known entry type");
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

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function toListItem(row: ListRow): ListItem {
  if (typeof row.directory !== "string" || normalize(row.directory) !== row.directory) {
    throw new Error("listEntries: directory is not an absolute canonical path");
  }
  if (row.path === null) {
    if (
      row.inode !== null ||
      row.type !== null ||
      row.mode !== null ||
      row.mtime !== null ||
      row.size !== null ||
      row.rev !== null ||
      row.nlink !== null ||
      row.link_target !== null ||
      row.content_id !== null
    ) {
      throw new Error("listEntries: empty directory row carries entry metadata");
    }
    return { directory: row.directory, entry: null };
  }
  if (
    typeof row.path !== "string" ||
    normalize(row.path) !== row.path ||
    dirname(row.path) !== row.directory ||
    !safeInteger(row.inode) ||
    row.inode < 1 ||
    typeof row.type !== "string" ||
    !safeInteger(row.mode) ||
    row.mode < 0 ||
    !safeInteger(row.mtime) ||
    !safeInteger(row.size) ||
    row.size < 0 ||
    !safeInteger(row.rev) ||
    row.rev < 0 ||
    !safeInteger(row.nlink) ||
    row.nlink < 1 ||
    (row.link_target !== null && typeof row.link_target !== "string")
  ) {
    throw new Error("listEntries: row contains invalid metadata");
  }
  const type = entryType(row.type);
  return {
    directory: row.directory,
    entry: {
      path: row.path,
      ino: row.inode,
      type,
      mode: TYPE_BITS[type] | (row.mode & PERMISSION_BITS),
      size: row.size,
      mtime: row.mtime,
      nlink: row.nlink,
      rev: row.rev,
      target: row.link_target,
      contentId: row.content_id === null ? null : readBlob(row.content_id),
    },
  };
}

/** Read one page through the native provider without widening its public contract. */
export function scanOwned(db: SqlDatabase, root: RealPath, options: ScanOptions): ScanEntry[] {
  return scan(db, root, options);
}

/**
 * One page of everything under `root`, in path byte order.
 *
 * ONE statement per page. `root` is a `RealPath` rather than a string because
 * the caller pages: resolving inside would cost a `realpath` statement per
 * page and turn a 13-statement walk into a 26-statement one. It is also the
 * §3.6 invariant — only real paths reach `fs_paths`.
 *
 * Paging is keyset. The caller resumes at the last path returned, or names a
 * pruned directory with `afterSubtree` so its exact successor remains visible.
 */
export function scan(db: SqlDatabase, root: RealPath, options: ScanOptions): ScanEntry[] {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`scan: limit must be a positive integer, got ${limit}`);
  }
  if (options.after !== undefined && options.afterSubtree !== undefined) {
    throw new Error("scan: after and afterSubtree are mutually exclusive");
  }

  const { lower, upper } = subtreeBounds(root);
  if (options.afterSubtree !== undefined) {
    const resume = subtreeSuccessor(options.afterSubtree);
    const inclusive = comparePaths(resume, lower) > 0 ? resume : lower;
    const sql = options.filesOnly === true ? SCAN_FILES_INCLUSIVE_SQL : SCAN_INCLUSIVE_SQL;
    return db.all<ScanRow>(sql, lower, upper, inclusive, limit).map(toEntry);
  }

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
  validatePattern(pattern, "glob");

  const { lower, upper } = subtreeBounds(root);
  return db
    .all<{ path: string }>(GLOB_SQL, lower, upper, pattern, options.limit ?? -1)
    .map((row) => row.path);
}

/** A completeness-bearing glob page, ordered by the path primary key. */
export function globPage(
  db: SqlDatabase,
  root: RealPath,
  pattern: string,
  options: GlobOptions = {},
): GlobPage {
  validatePattern(pattern, "globPage");
  const limit = options.limit ?? DISCOVERY_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
    throw new Error(
      `globPage: limit must be an integer from 1 to ${DISCOVERY_PAGE_MAX}, got ${limit}`,
    );
  }

  const { lower, upper } = subtreeBounds(root);
  const after =
    options.after !== undefined && comparePaths(options.after, lower) > 0 ? options.after : lower;
  const found = db
    .all<{ path: string }>(GLOB_SQL, after, upper, pattern, limit + 1)
    .map((row) => row.path);
  const paths = found.slice(0, limit);
  return {
    paths,
    next: found.length > limit ? (paths[paths.length - 1] ?? null) : null,
  };
}

/** Page directory groups with metadata, including one null row for an empty group. */
export function listEntries(db: SqlDatabase, root: RealPath, options: ListOptions = {}): ListPage {
  const limit = options.limit ?? DISCOVERY_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
    throw new Error(
      `listEntries: limit must be an integer from 1 to ${DISCOVERY_PAGE_MAX}, got ${limit}`,
    );
  }
  const afterDirectory = options.after?.directory ?? "";
  const afterPath = options.after?.path ?? "";
  const rows =
    options.recursive === true
      ? (() => {
          const { lower, upper } = subtreeBounds(root);
          return db.all<ListRow>(
            LIST_RECURSIVE_SQL,
            root,
            lower,
            upper,
            afterDirectory,
            afterDirectory,
            afterPath,
            limit + 1,
          );
        })()
      : db.all<ListRow>(
          LIST_DIRECTORY_SQL,
          root,
          afterDirectory,
          afterDirectory,
          afterPath,
          limit + 1,
        );
  const found = rows.map(toListItem);
  const items = found.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    next:
      found.length > limit && last !== undefined
        ? { directory: last.directory, path: last.entry?.path ?? null }
        : null,
  };
}
