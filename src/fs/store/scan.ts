// P1 from §7.0: the bulk reads. `scan` is one statement per page and `glob`
// is one statement, both an indexed range scan on the `fs_paths` primary key
// — no recursion, no CTE, no traversal.
//
// BINARY collation over the whole path is UTF-8 byte order, which is what
// `comparePaths` defines and what every merge join above this layer consumes,
// so the physical scan order IS the output order and `ORDER BY path` costs
// nothing.

import { readBlob, type SqlDatabase } from "../../sqlite/db.js";
import { MAX_ROUTING_CHECKOUTS, MAX_ROUTING_ROOTS_UTF8_BYTES } from "../../sqlite/schema.js";
import { comparePaths, dirname, normalize, subtreeSuccessor } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import {
  type DiscoverFilesOptions,
  type DiscoverFilesPage,
  type EntryType,
  type GlobOptions,
  type GlobPage,
  type ListItem,
  type ListOptions,
  type ListPage,
  type RealPath,
  type RegularFileHandle,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  type ScanEntry,
  type ScanOptions,
} from "../types.js";

/** The DO SQLite ceiling on a GLOB/LIKE pattern. */
export const GLOB_PATTERN_MAX_BYTES = 50;
export const DISCOVERY_PAGE_MAX = 1_000;
export const DISCOVERY_EXCLUDE_ROOTS_MAX = MAX_ROUTING_CHECKOUTS;
export const DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX = MAX_ROUTING_CHECKOUTS + 1;
export const DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES = MAX_ROUTING_ROOTS_UTF8_BYTES;
const DISCOVERY_EXCLUDE_ROOT_CODE_UNITS_MAX = 4_096;
const DISCOVERY_EXCLUDE_ITEM_JSON_MAX_BYTES = DISCOVERY_EXCLUDE_ROOT_CODE_UNITS_MAX * 6 + 2;
/** Every input byte can expand to a six-byte JSON escape, plus quotes and separators. */
const DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES =
  DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES * 6 + DISCOVERY_EXCLUDE_ROOTS_MAX * 3 + 2;
export const DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES = 1_500_000;
/** A completed segment can leave less than one maximum-sized item of slack. */
export const DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS = Math.ceil(
  DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES /
    (DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES - DISCOVERY_EXCLUDE_ITEM_JSON_MAX_BYTES - 1),
);
/** Splitting replaces each inter-item comma with two array brackets. */
export const DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES =
  DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES + DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS - 1;
export const DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS = DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS + 6;
const DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES = 64;
const DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES = 8;
const DISCOVERY_EXCLUDE_STRING_FIXED_BYTES = 48;
export const DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES =
  2 * DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES +
  3 * DISCOVERY_EXCLUDE_ROOTS_MAX * DISCOVERY_EXCLUDE_STRING_FIXED_BYTES +
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS * DISCOVERY_EXCLUDE_STRING_FIXED_BYTES +
  2 * DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES +
  2 *
    (DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES +
      DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX * DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES) +
  DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES +
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS * DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES +
  DISCOVERY_EXCLUDE_STRING_FIXED_BYTES +
  2 * DISCOVERY_EXCLUDE_ITEM_JSON_MAX_BYTES;

const PERMISSION_BITS = 0o7777;

const TYPE_BITS: Record<EntryType, number> = {
  file: S_IFREG,
  dir: S_IFDIR,
  symlink: S_IFLNK,
};

const ENCODER = new TextEncoder();

if (DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES >= 100 * 1024 * 1024) {
  throw new Error("discovery excluded-root retained bound exceeds 100 MiB");
}
if (
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES >= 2_000_000 ||
  DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS >= 100
) {
  throw new Error("discovery excluded-root SQL bindings exceed the platform limit");
}

function boundedUtf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

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

const DISCOVER_FILES_PREFIX = `WITH candidates AS MATERIALIZED (
       SELECT fs_paths.path AS path,
              fs_paths.inode AS inode,
              fs_nodes.size AS size,
              fs_nodes.rev AS rev
         FROM fs_paths
         JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode
        WHERE fs_paths.path > ? AND fs_paths.path < ?
          AND fs_paths.path GLOB ?
          AND fs_nodes.type = 'file'`;

const DISCOVER_FILES_EXCLUDED_SOURCES = Array.from(
  { length: DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS },
  (_, index) => `${index === 0 ? "" : "       UNION ALL "}SELECT value FROM json_each(?)`,
).join("\n");

const DISCOVER_FILES_EXCLUDED_PREFIX = `WITH excluded(path) AS MATERIALIZED (
${DISCOVER_FILES_EXCLUDED_SOURCES}
     ),
candidates AS MATERIALIZED (
       SELECT fs_paths.path AS path,
              fs_paths.inode AS inode,
              fs_nodes.size AS size,
              fs_nodes.rev AS rev
         FROM fs_paths
         JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode
        WHERE fs_paths.path > ? AND fs_paths.path < ?
          AND fs_paths.path GLOB ?
          AND fs_nodes.type = 'file'
          AND NOT EXISTS (
                SELECT 1 FROM excluded
                 WHERE fs_paths.path >= CASE
                         WHEN excluded.path = '/' THEN '/'
                         ELSE excluded.path || '/'
                       END
                   AND fs_paths.path < CASE
                         WHEN excluded.path = '/' THEN '0'
                         ELSE excluded.path || '0'
                       END
              )`;

const DISCOVER_FILES_SUFFIX = `
        ORDER BY fs_paths.path
        LIMIT ?
     )
SELECT candidates.path AS path,
       candidates.inode AS inode,
       candidates.size AS size,
       candidates.rev AS rev,
       count(fs_chunks.idx) AS chunk_count,
       coalesce(sum(length(fs_chunks.bytes)), 0) AS chunk_bytes,
       min(fs_chunks.idx) AS first_idx,
       max(fs_chunks.idx) AS last_idx,
       coalesce(sum(CASE
         WHEN fs_chunks.idx IS NOT NULL AND typeof(fs_chunks.idx) <> 'integer' THEN 1
         ELSE 0
       END), 0) AS non_integer_indices,
       coalesce(sum(CASE
         WHEN fs_chunks.idx IS NOT NULL AND typeof(fs_chunks.bytes) <> 'blob' THEN 1
         ELSE 0
       END), 0) AS non_blob_chunks,
       coalesce(sum(CASE
         WHEN fs_chunks.idx IS NOT NULL
          AND length(fs_chunks.bytes) <> min(?, candidates.size - fs_chunks.idx * ?)
         THEN 1
         ELSE 0
       END), 0) AS invalid_chunk_sizes
  FROM candidates
  LEFT JOIN fs_chunks ON fs_chunks.inode = candidates.inode
 GROUP BY candidates.path, candidates.inode, candidates.size, candidates.rev
 ORDER BY candidates.path`;

const DISCOVER_FILES_SQL = `${DISCOVER_FILES_PREFIX}${DISCOVER_FILES_SUFFIX}`;
const DISCOVER_FILES_EXCLUDED_SQL = `${DISCOVER_FILES_EXCLUDED_PREFIX}${DISCOVER_FILES_SUFFIX}`;

export function validateDiscoveryExcludeRoots(root: RealPath, input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("discoverFiles: excludeRoots must be an array");
  if (input.length > DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX) {
    throw new Error(
      `discoverFiles: at most ${DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX} excluded root inputs may be supplied`,
    );
  }
  const prefix = root === "/" ? "/" : `${root}/`;
  const ordered: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const path = Reflect.get(input, index);
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.length > DISCOVERY_EXCLUDE_ROOT_CODE_UNITS_MAX ||
      path.includes("\0") ||
      normalize(path) !== path ||
      (path !== root && !path.startsWith(prefix))
    ) {
      throw new Error(`discoverFiles: excluded root ${index} is not canonical under '${root}'`);
    }
    ordered.push(path);
  }
  ordered.sort(comparePaths);
  const coalesced: string[] = [];
  let retainedUtf8Bytes = 0;
  for (const path of ordered) {
    const parent = coalesced[coalesced.length - 1];
    if (parent !== undefined && (path === parent || path.startsWith(`${parent}/`))) continue;
    coalesced.push(path);
    if (retainedUtf8Bytes <= DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES) {
      const remaining = DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES - retainedUtf8Bytes;
      const pathBytes = boundedUtf8Bytes(path, remaining);
      retainedUtf8Bytes =
        pathBytes > remaining
          ? DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES + 1
          : retainedUtf8Bytes + pathBytes;
    }
  }
  if (coalesced.length > DISCOVERY_EXCLUDE_ROOTS_MAX) {
    throw new Error(
      `discoverFiles: at most ${DISCOVERY_EXCLUDE_ROOTS_MAX} effective excluded roots may be supplied`,
    );
  }
  if (retainedUtf8Bytes > DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES) {
    throw new Error(
      `discoverFiles: excluded roots exceed ${DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return coalesced;
}

export function discoveryExcludeRootsJsonSegments(
  excludeRoots: readonly string[],
): readonly string[] {
  const segments: string[] = [];
  let segment = "[";
  let segmentBytes = 1;
  for (const path of excludeRoots) {
    const item = JSON.stringify(path);
    if (item === undefined) throw new Error("discoverFiles: excluded root is not JSON text");
    const itemBytes = boundedUtf8Bytes(item, DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES);
    if (itemBytes + 2 > DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES) {
      throw new Error("discoverFiles: one excluded root exceeds the JSON segment bound");
    }
    const delimiter = segmentBytes === 1 ? "" : ",";
    if (
      segmentBytes + delimiter.length + itemBytes + 1 >
      DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES
    ) {
      segments.push(`${segment}]`);
      if (segments.length >= DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS) {
        throw new Error(
          `discoverFiles: excluded roots exceed ${DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS} JSON segments`,
        );
      }
      segment = `[${item}`;
      segmentBytes = 1 + itemBytes;
      continue;
    }
    segment += `${delimiter}${item}`;
    segmentBytes += delimiter.length + itemBytes;
  }
  segments.push(`${segment}]`);
  while (segments.length < DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS) segments.push("[]");
  return segments;
}

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

interface FileHandleRow {
  path: RealPath;
  inode: number;
  size: number;
  rev: number;
  chunk_count: number;
  chunk_bytes: number;
  first_idx: number | null;
  last_idx: number | null;
  non_integer_indices: number;
  non_blob_chunks: number;
  invalid_chunk_sizes: number;
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

function validatePattern(pattern: string, operation: string): void {
  const bytes = ENCODER.encode(pattern).length;
  if (bytes > GLOB_PATTERN_MAX_BYTES) {
    throw new Error(
      `${operation}: pattern is ${bytes} bytes; the platform caps a GLOB pattern at ${GLOB_PATTERN_MAX_BYTES}`,
    );
  }
}

function corrupt(inode: number, detail: string): Error {
  return Object.assign(new Error(`EIO: corrupt chunks for inode ${inode}: ${detail}`), {
    code: "EIO",
  });
}

function validateFileHandle(row: FileHandleRow): RegularFileHandle {
  const chunks = Math.ceil(row.size / CHUNK_SIZE);
  if (
    !Number.isSafeInteger(row.inode) ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    !Number.isSafeInteger(row.rev) ||
    row.chunk_count !== chunks ||
    row.chunk_bytes !== row.size ||
    row.non_integer_indices !== 0 ||
    row.non_blob_chunks !== 0 ||
    row.invalid_chunk_sizes !== 0 ||
    (chunks === 0
      ? row.first_idx !== null || row.last_idx !== null
      : row.first_idx !== 0 || row.last_idx !== chunks - 1)
  ) {
    throw corrupt(row.inode, "metadata does not describe contiguous file content");
  }
  return { path: row.path, ino: row.inode, size: row.size, rev: row.rev };
}

/** Discover validated regular files without returning content BLOBs. */
export function discoverFiles(
  db: SqlDatabase,
  root: RealPath,
  pattern: string,
  options: DiscoverFilesOptions = {},
): DiscoverFilesPage {
  validatePattern(pattern, "discoverFiles");
  const { lower, upper } = subtreeBounds(root);
  const limit = options.limit ?? DISCOVERY_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
    throw new Error(
      `discoverFiles: limit must be an integer from 1 to ${DISCOVERY_PAGE_MAX}, got ${limit}`,
    );
  }
  const after =
    options.after !== undefined && comparePaths(options.after, lower) > 0 ? options.after : lower;
  const excludeRoots = validateDiscoveryExcludeRoots(root, options.excludeRoots);
  const bindings: unknown[] = [];
  if (excludeRoots.length > 0) bindings.push(...discoveryExcludeRootsJsonSegments(excludeRoots));
  bindings.push(after, upper, pattern, limit + 1, CHUNK_SIZE, CHUNK_SIZE);
  const found = db
    .all<FileHandleRow>(
      excludeRoots.length === 0 ? DISCOVER_FILES_SQL : DISCOVER_FILES_EXCLUDED_SQL,
      ...bindings,
    )
    .map(validateFileHandle);
  const handles = found.slice(0, limit);
  return {
    handles,
    next: found.length > limit ? (handles[handles.length - 1]?.path ?? null) : null,
  };
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
