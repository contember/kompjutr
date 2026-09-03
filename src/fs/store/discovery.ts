import type { SqlDatabase } from "../../db/db.js";
import { MAX_ROUTING_CHECKOUTS, MAX_ROUTING_ROOTS_UTF8_BYTES } from "../../db/routing.js";
import { comparePaths, normalize } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type {
  DiscoverFilesOptions,
  DiscoverFilesPage,
  RealPath,
  RegularFileHandle,
} from "../types.js";
import { DISCOVERY_PAGE_MAX, subtreeBounds, validatePattern } from "./scan-shared.js";

export const DISCOVERY_EXCLUDE_ROOTS_MAX = MAX_ROUTING_CHECKOUTS;
export const DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX = MAX_ROUTING_CHECKOUTS + 1;
/** Every input byte can expand to a six-byte JSON escape, plus quotes and separators. */
const DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES =
  MAX_ROUTING_ROOTS_UTF8_BYTES * 6 + DISCOVERY_EXCLUDE_ROOTS_MAX * 3 + 2;
export const DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES = 1_500_000;
/** Next-fit uses at most two segments per target-sized portion, including large singletons. */
export const DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS =
  Math.ceil(
    (2 * DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES) /
      DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES,
  ) + 1;
/** Splitting replaces each inter-item comma with two array brackets. */
export const DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES =
  DISCOVERY_EXCLUDE_ROOTS_SINGLE_JSON_MAX_BYTES + DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS - 1;
export const DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS = DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS + 6;
const DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES = 64;
const DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES = 8;
const DISCOVERY_EXCLUDE_STRING_FIXED_BYTES = 48;
export const DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES =
  2 * MAX_ROUTING_ROOTS_UTF8_BYTES +
  3 * DISCOVERY_EXCLUDE_ROOTS_MAX * DISCOVERY_EXCLUDE_STRING_FIXED_BYTES +
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS * DISCOVERY_EXCLUDE_STRING_FIXED_BYTES +
  2 * DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES +
  2 *
    (DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES +
      DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX * DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES) +
  DISCOVERY_EXCLUDE_ARRAY_FIXED_BYTES +
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS * DISCOVERY_EXCLUDE_ARRAY_SLOT_BYTES +
  DISCOVERY_EXCLUDE_STRING_FIXED_BYTES +
  4 * DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES;

if (DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES >= 100 * 1024 * 1024) {
  throw new Error("discovery excluded-root retained bound exceeds 100 MiB");
}
if (
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES >= 2_000_000 ||
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

function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes++;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

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
    if (retainedUtf8Bytes <= MAX_ROUTING_ROOTS_UTF8_BYTES) {
      const remaining = MAX_ROUTING_ROOTS_UTF8_BYTES - retainedUtf8Bytes;
      const pathBytes = boundedUtf8Bytes(path, remaining);
      retainedUtf8Bytes =
        pathBytes > remaining ? MAX_ROUTING_ROOTS_UTF8_BYTES + 1 : retainedUtf8Bytes + pathBytes;
    }
  }
  if (coalesced.length > DISCOVERY_EXCLUDE_ROOTS_MAX) {
    throw new Error(
      `discoverFiles: at most ${DISCOVERY_EXCLUDE_ROOTS_MAX} effective excluded roots may be supplied`,
    );
  }
  if (retainedUtf8Bytes > MAX_ROUTING_ROOTS_UTF8_BYTES) {
    throw new Error(
      `discoverFiles: excluded roots exceed ${MAX_ROUTING_ROOTS_UTF8_BYTES} UTF-8 bytes`,
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
    const itemBytes = jsonStringUtf8Bytes(path);
    if (itemBytes + 2 > DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES) {
      if (segmentBytes > 1) segments.push(`${segment}]`);
      const singleton = JSON.stringify([path]);
      if (singleton === undefined) throw new Error("discoverFiles: excluded root is not JSON text");
      segments.push(singleton);
      if (segments.length > DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS) {
        throw new Error("discoverFiles: excluded-root segmentation invariant failed");
      }
      segment = "[";
      segmentBytes = 1;
      continue;
    }
    const item = JSON.stringify(path);
    if (item === undefined) throw new Error("discoverFiles: excluded root is not JSON text");
    const delimiter = segmentBytes === 1 ? "" : ",";
    if (
      segmentBytes > 1 &&
      segmentBytes + delimiter.length + itemBytes + 1 >
        DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_TARGET_BYTES
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
  if (segmentBytes > 1 || segments.length === 0) segments.push(`${segment}]`);
  if (segments.length > DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS) {
    throw new Error("discoverFiles: excluded-root segmentation invariant failed");
  }
  while (segments.length < DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS) segments.push("[]");
  return segments;
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
