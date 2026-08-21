// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import pako from "pako";

import { concat, isOid, toHex } from "../core/bytes.js";
import { CorruptError, GitError, ObjectNotFoundError } from "../core/errors.js";
import { ByteLru } from "../core/lru.js";
import { hashObject, type ObjectType, objectHeader, type RawObject } from "../core/objects.js";
import { Sha1 } from "../core/sha1.js";
import { deflate, InflateInto, InflateSizeError, InflateStream, inflate } from "../core/zlib.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  indexCommitSource,
  insertCommitCaches,
  MAX_INDEXED_COMMIT_BYTES,
  prepareCommitCache,
  readCommitCache,
  readCommitGraph,
} from "./commits.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
import {
  MAX_PACK_BLOB_BATCH_BYTES,
  MAX_PACK_DELTA_WORKING_BYTES,
  type PackCacheOptions,
  PackStore,
} from "./packs.js";
import {
  indexTreeSource,
  indexTreeSources,
  initializeGitSchema,
  TREE_QUEUE_ROW_FIXED_BYTES,
} from "./schema.js";

/** Bytes per `git_object_chunks` row. */
const OBJECT_CHUNK = 1024 * 1024;

/** Small loose objects cost more to deflate than storing their bytes directly. */
const RAW_OBJECT_MAX = 4 * 1024;

/** Deflate output chunk, and one row, for a streamed write. Smaller than
 *  OBJECT_CHUNK so a streamed object's peak is a chunk, not a megabyte. */
const STREAM_CHUNK = 64 * 1024;

/** Compressed bytes fed to the inflater at a time when streaming a read. */
const INFLATE_FEED = 16 * 1024;

/** Compressed bytes gathered into one `substr()` payload, and the trigger
 *  that flushes a batch. Well under the 2 MB ceiling on a bound value. */
const OBJECT_PAYLOAD = 1024 * 1024;

/** Objects buffered before a batch flushes. The JSON arrays are bound
 *  values too, so the row count is capped as well as the byte count. */
const DEFAULT_OBJECT_FLUSH = 4096;

/** Oids per existence-probe statement, bounding the same JSON parameter. */
const OID_PROBE_PAGE = 4096;

/** Opaque content ids encoded into one SQL BLOB parameter per statement. */
const CONTENT_ID_PAYLOAD = 1024 * 1024;
const CONTENT_ID_PAGE = 4096;

/** A blob batch shares the pack reader's conservative memory budget. */
export const MAX_BLOB_BATCH_BYTES = MAX_PACK_BLOB_BATCH_BYTES;
const MAX_BLOB_BATCH_OIDS = 4096;

/** Index rows per round trip. This is the memory bound of a scan. */
const DEFAULT_INDEX_PAGE = 512;

/** Index mutations buffered before a batch is applied. */
const DEFAULT_INDEX_FLUSH = 512;

/** Bound JSON stays below the Durable Object SQLite 2 MiB value ceiling. */
const INDEX_MUTATION_PAYLOAD = 1024 * 1024;

/** Parsed commits staged beside encoded object bytes before a batch flush. */
const COMMIT_STAGE_CACHE_BYTES = 16 * 1024 * 1024;

const DEFAULT_OBJECT_CACHE_BYTES = 16 * 1024 * 1024;
const TREE_WALK_STATE_BYTES = 8 * 1024 * 1024;
const TREE_WALK_PATH_BYTES = 2_200;
const TREE_WALK_QUEUE_BYTES = 16 * 1024 * 1024;

export interface StoreOptions extends PackCacheOptions {
  /** Bytes of inflated objects held hot across reads. */
  objectCacheBytes?: number;
  now?: () => number;
}

export interface RepositoryRow {
  id: number;
  root: string;
  head: string;
}

export interface RefRow {
  name: string;
  target: string;
}

export interface IndexEntry {
  path: string;
  stage: number;
  /** Full git mode, e.g. 0o100644. */
  mode: number;
  oid: string;
  /** Working-tree facts recorded when the entry was written, for status. */
  size: number | null;
  mtime: number | null;
  ino: number | null;
  /** Monotonic filesystem revision, absent on indexes created before schema v5. */
  rev?: number | null;
}

export interface IndexScanOptions {
  /** Resume strictly after this (path, stage). */
  after?: { path: string; stage: number };
  /** Only the path equal to, or under, this repo-relative prefix. */
  prefix?: string;
  /** Rows per round trip. This is the memory bound of the scan. */
  pageSize?: number;
}

export interface IndexApplyOptions {
  /** Mutations buffered before a batch is written. */
  flushEvery?: number;
}

export interface ObjectBatchOptions {
  /** Stored bytes buffered before a flush, and the cap on one payload. */
  payloadBytes?: number;
  /** Objects buffered before a flush. */
  flushEvery?: number;
}

export interface BlobIdMapping {
  contentId: Uint8Array;
  oid: string;
}

export interface BlobReadBatch {
  /** Complete blob contents, keyed by oid in first-occurrence input order. */
  blobs: Map<string, Uint8Array>;
  /** Deduplicated oids deferred to the next call. */
  remaining: string[];
  /** Sum of the returned blob sizes. */
  bytes: number;
}

/** Stable, collision-free key for an opaque binary content id. */
export function contentIdKey(contentId: Uint8Array): string {
  return toHex(contentId);
}

/**
 * A bounded sink for loose object writes. `write` hashes and encodes, so
 * the oid it returns is final, but no row exists until `flush`: a staged
 * object is invisible to `read`, `has` and `readChunks` until then.
 */
export interface ObjectBatch {
  write(type: ObjectType, data: Uint8Array): string;
  /** Write whatever is staged. Called for you when `writeObjects` returns. */
  flush(): void;
}

export interface WalkTreeEntry {
  path: string;
  mode: string;
  oid: string;
}

export const WALK_TREE_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, path_cap, state_cap, queue_cap, queue_fixed)
    AS (VALUES (?, ?, ?, ?, ?, ?)),
  source_valid(repo_id, tree_oid, storage, source_id, object_size,
               entry_count, base_cost) AS NOT MATERIALIZED (
    SELECT x.repo_id, x.tree_oid, x.storage, x.source_id, s.object_size,
           s.entry_count, s.base_cost
      FROM git_tree_effective x
      CROSS JOIN params p
      CROSS JOIN git_tree_sources s
     WHERE x.repo_id = p.repo_id
       AND length(x.tree_oid) = 40 AND x.tree_oid NOT GLOB '*[^0-9a-f]*'
       AND s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.storage = x.storage AND s.source_id = x.source_id
       AND s.entry_count >= 0 AND s.object_size >= 0
       AND s.base_cost = s.object_size + (p.queue_fixed + 18) * s.entry_count
       AND (
         (x.storage = 'loose' AND x.source_id = 0 AND EXISTS (
           SELECT 1 FROM git_objects o
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.type = 'tree' AND o.size = s.object_size
         ))
         OR
         (x.storage = 'pack' AND EXISTS (
           SELECT 1
             FROM git_pack_objects o
             JOIN git_pack_meta m
               ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND m.state = 'complete'
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.pack_id = x.source_id AND o.type = 'tree'
              AND o.size = s.object_size
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM git_tree_entries e
          WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
            AND e.storage = s.storage AND e.source_id = s.source_id
            AND e.ordinal IN (-1, s.entry_count)
       )
       AND (
         (s.entry_count = 0 AND s.base_cost = 0)
         OR EXISTS (
           SELECT 1 FROM git_tree_entries e
            WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
              AND e.storage = s.storage AND e.source_id = s.source_id
              AND e.ordinal = s.entry_count - 1
              AND e.cumulative_base = s.base_cost
         )
       )
  ),
  walk(path, mode, oid, ancestry, sort_key, error, error_code,
       path_bytes, state_bytes, descend, reserved_bytes) AS (
    SELECT CASE
             WHEN length(e.name_bytes) <= p.path_cap
               AND length(CAST(e.name AS BLOB)) <= p.path_cap THEN e.name
             ELSE NULL
           END,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           '/' || p.root_oid || '/', printf('%08x', e.ordinal),
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree path exceeds 2200 bytes'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             WHEN length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal state exceeds 8 MiB'
             ELSE NULL
           END,
           CASE WHEN length(e.name_bytes) > p.path_cap
                  OR length(CAST(e.name AS BLOB)) > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           length(e.name_bytes), length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND length(e.oid) = 40 AND e.oid NOT GLOB '*[^0-9a-f]*'
                  AND EXISTS (
                    SELECT 1 FROM source_valid child
                     WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  )
             THEN CASE WHEN EXISTS (
               SELECT 1 FROM source_valid child
                WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  AND s.base_cost - e.cumulative_base
                        + (s.entry_count - e.ordinal - 1) * 50
                        + child.base_cost
                        + child.entry_count * (length(e.name_bytes) + 49 + 51)
                      > p.queue_cap
             ) THEN 2 ELSE 1 END
             ELSE 0
           END,
           s.base_cost - e.cumulative_base
             + (s.entry_count - e.ordinal - 1) * 50
      FROM params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
       AND s.base_cost + s.entry_count * 50 <= p.queue_cap
       AND e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
    UNION ALL
    SELECT NULL, NULL, NULL, '/', '',
           'tree traversal queue exceeds 16 MiB', 'E2BIG', 0, 0, 0, 0
      FROM params p CROSS JOIN source_valid s
     WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
       AND s.base_cost + s.entry_count * 50 > p.queue_cap
    UNION ALL
    SELECT NULL, NULL, NULL, '/', '',
           CASE WHEN length(p.root_oid) = 40 AND p.root_oid NOT GLOB '*[^0-9a-f]*'
                THEN 'tree source is invalid; reimport or reclone'
                ELSE 'tree oid is invalid'
           END,
           'ECORRUPT', 0, 0, 0, 0
      FROM params p
     WHERE NOT EXISTS (
       SELECT 1 FROM source_valid s
        WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
     )
    UNION ALL
    SELECT CASE
             WHEN w.path_bytes + 1 + length(e.name_bytes) <= p.path_cap
               AND length(CAST(w.path AS BLOB)) + 1 + length(CAST(e.name AS BLOB))
                     <= p.path_cap
               THEN w.path || '/' || e.name
             ELSE NULL
           END,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           w.ancestry || w.oid || '/', w.sort_key || printf('%08x', e.ordinal),
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree entry name exceeds the path limit'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
               THEN 'tree path exceeds 2200 bytes'
             WHEN w.state_bytes + 1 + length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal state exceeds 8 MiB'
             ELSE NULL
           END,
           CASE WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
                  OR length(CAST(w.path AS BLOB)) + 1 + length(CAST(e.name AS BLOB))
                       > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           w.path_bytes + 1 + length(e.name_bytes),
           w.state_bytes + 1 + length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND length(e.oid) = 40 AND e.oid NOT GLOB '*[^0-9a-f]*'
                  AND EXISTS (
                    SELECT 1 FROM source_valid child
                     WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  )
             THEN CASE WHEN EXISTS (
               SELECT 1 FROM source_valid child
                WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  AND w.reserved_bytes + s.base_cost - e.cumulative_base
                        + (s.entry_count - e.ordinal - 1) * (w.state_bytes + 51)
                        + child.base_cost
                        + child.entry_count
                          * (w.state_bytes + 1 + length(e.name_bytes) + 49 + 51)
                      > p.queue_cap
             ) THEN 2 ELSE 1 END
             ELSE 0
           END,
           w.reserved_bytes + s.base_cost - e.cumulative_base
             + (s.entry_count - e.ordinal - 1) * (w.state_bytes + 51)
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE w.error IS NULL AND w.descend = 1
       AND instr(w.ancestry, '/' || w.oid || '/') = 0
       AND s.repo_id = p.repo_id AND s.tree_oid = w.oid
       AND e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
     ORDER BY 5
  )
SELECT path, mode, oid,
       CASE
         WHEN error IS NOT NULL THEN error
         WHEN mode IN ('40000', '040000') AND instr(ancestry, '/' || oid || '/') != 0
           THEN 'tree cycle at ' || oid
         WHEN mode IN ('40000', '040000') AND descend = 2
           THEN 'tree traversal queue exceeds 16 MiB'
         WHEN mode IN ('40000', '040000') AND descend = 0
           THEN 'tree ' || oid || ' has no valid v3 parsed source; reimport or reclone'
         ELSE NULL
       END AS error,
       CASE WHEN error_code = 'E2BIG' OR descend = 2 THEN 'E2BIG'
            ELSE 'ECORRUPT' END AS error_code
  FROM walk
 WHERE error IS NOT NULL
    OR mode NOT IN ('40000', '040000')
    OR instr(ancestry, '/' || oid || '/') != 0
    OR (mode IN ('40000', '040000') AND descend != 1)`;

type LooseEncoding = "raw" | "zlib";

/** One object staged in a batch, already hashed and encoded for storage. */
interface StagedObject {
  oid: string;
  type: ObjectType;
  size: number;
  stored: LooseEncoding;
  storedData: Uint8Array;
  treeData?: Uint8Array;
  commitEntry?: CommitCacheEntry;
}

/** One `substr()` payload: the bytes, and the rows cut out of them. */
interface ChunkPayload {
  parts: Uint8Array[];
  length: number;
  rows: { o: string; q: number; a: number; n: number }[];
}

interface ContentIdPage {
  payload: Uint8Array;
  rows: { a: number; n: number }[];
}

interface ExpectedContentIdPage {
  payload: Uint8Array;
  rows: { i: number; a: number; n: number; o: string }[];
}

export const MAX_BLOB_ID_MISMATCH_RETAINED_BYTES = 16 * 1024 * 1024;
const BLOB_ID_MISMATCH_ROW_BYTES = 384;

export function blobIdMismatchRetainedBytes(mapping: BlobIdMapping): number {
  return BLOB_ID_MISMATCH_ROW_BYTES + mapping.contentId.length + mapping.oid.length * 2;
}

function contentIdPages(contentIds: Iterable<Uint8Array>): ContentIdPage[] {
  const unique = new Map<string, Uint8Array>();
  for (const contentId of contentIds) {
    if (contentId.length > CONTENT_ID_PAYLOAD) {
      throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
    }
    unique.set(contentIdKey(contentId), contentId);
  }
  const pages: ContentIdPage[] = [];
  let parts: Uint8Array[] = [];
  let rows: { a: number; n: number }[] = [];
  let length = 0;
  const flush = (): void => {
    if (rows.length === 0) return;
    pages.push({ payload: concat(parts), rows });
    parts = [];
    rows = [];
    length = 0;
  };
  for (const contentId of unique.values()) {
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      flush();
    }
    rows.push({ a: length + 1, n: contentId.length });
    parts.push(contentId);
    length += contentId.length;
  }
  flush();
  return pages;
}

/** Expected mappings in pages whose BLOB and JSON inputs stay bounded. */
function* expectedContentIdPages(
  mappings: readonly BlobIdMapping[],
): Generator<ExpectedContentIdPage> {
  let parts: Uint8Array[] = [];
  let rows: { i: number; a: number; n: number; o: string }[] = [];
  let length = 0;

  for (let ordinal = 0; ordinal < mappings.length; ordinal++) {
    const mapping = mappings[ordinal];
    if (mapping === undefined) continue;
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      yield { payload: concat(parts), rows };
      parts = [];
      rows = [];
      length = 0;
    }
    rows.push({ i: ordinal, a: length + 1, n: mapping.contentId.length, o: mapping.oid });
    parts.push(mapping.contentId);
    length += mapping.contentId.length;
  }
  if (rows.length > 0) yield { payload: concat(parts), rows };
}

function requireCommitCacheWrites(result: CommitCacheWriteResult, expected: number): void {
  if (result.written !== expected || result.eligible !== expected || result.skipped !== 0) {
    throw new CorruptError(`commit cache wrote ${result.written} of ${expected} required rows`);
  }
}

interface BufferedIndexMutation {
  kind: "p" | "r";
  json: string;
  bytes: number;
}

function looseEncoding(size: number): LooseEncoding {
  return size <= RAW_OBJECT_MAX ? "raw" : "zlib";
}

function encodeLoose(data: Uint8Array, stored: LooseEncoding): Uint8Array {
  return stored === "raw" ? data : deflate(data);
}

function parseLooseEncoding(stored: string): LooseEncoding {
  if (stored === "raw" || stored === "zlib") return stored;
  throw new CorruptError(`loose object has unknown storage encoding '${stored}'`);
}

function isObjectType(value: string | null): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

const JSON_ENCODER = new TextEncoder();
const JSON_BATCH_ROWS = 2_048;
const JSON_BATCH_BYTES = 1024 * 1024;

function* jsonPages<T>(items: Iterable<T>, label: string): Generator<string> {
  let rows: string[] = [];
  let bytes = 2;
  for (const item of items) {
    const row = JSON.stringify(item);
    const rowBytes = JSON_ENCODER.encode(row).byteLength;
    const separator = rows.length === 0 ? 0 : 1;
    if (
      rows.length > 0 &&
      (rows.length >= JSON_BATCH_ROWS || bytes + separator + rowBytes > JSON_BATCH_BYTES)
    ) {
      yield `[${rows.join(",")}]`;
      rows = [];
      bytes = 2;
    }
    if (2 + rowBytes > JSON_BATCH_BYTES) {
      throw new GitError("E2BIG", `one ${label} exceeds the 1 MiB JSON batch limit`);
    }
    bytes += (rows.length === 0 ? 0 : 1) + rowBytes;
    rows.push(row);
  }
  if (rows.length > 0) yield `[${rows.join(",")}]`;
}

function serializeIndexMutation(
  item: IndexEntry | string,
  sequence: number,
): BufferedIndexMutation {
  const kind = typeof item === "string" ? "r" : "p";
  const json = JSON.stringify(
    typeof item === "string"
      ? { q: sequence, k: kind, p: item }
      : {
          q: sequence,
          k: kind,
          p: item.path,
          g: item.stage,
          m: item.mode,
          o: item.oid,
          s: item.size,
          t: item.mtime,
          i: item.ino,
          r: item.rev ?? null,
        },
  );
  return { kind, json, bytes: JSON_ENCODER.encode(json).byteLength };
}

class IndexMutationBuffer {
  #pending: BufferedIndexMutation[] = [];
  #bytes = 2;

  constructor(
    private readonly flushEvery: number,
    private readonly apply: (pending: readonly BufferedIndexMutation[]) => void,
  ) {}

  add(item: IndexEntry | string): void {
    let mutation = serializeIndexMutation(item, this.#pending.length);
    const separator = this.#pending.length === 0 ? 0 : 1;
    if (
      this.#pending.length > 0 &&
      this.#bytes + separator + mutation.bytes > INDEX_MUTATION_PAYLOAD
    ) {
      this.flush();
      mutation = serializeIndexMutation(item, 0);
    }
    if (2 + mutation.bytes > INDEX_MUTATION_PAYLOAD) {
      throw new GitError("E2BIG", "one index mutation exceeds the 1 MiB JSON batch limit");
    }
    this.#bytes += (this.#pending.length === 0 ? 0 : 1) + mutation.bytes;
    this.#pending.push(mutation);
    if (this.#pending.length >= this.flushEvery) this.flush();
  }

  flush(): void {
    if (this.#pending.length === 0) return;
    this.apply(this.#pending);
    this.#pending = [];
    this.#bytes = 2;
  }
}

/** A bounded, ordered mutation sink over the index. */
export interface IndexSink {
  put(entry: IndexEntry): void;
  remove(path: string): void;
  /** Apply whatever is buffered. Called for you when `indexApply` returns. */
  flush(): void;
}

/** Normalise an absolute workspace path: no trailing slash, always leading. */
export function normalizeRoot(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Every ancestor of `path`, nearest first, ending at "/". */
export function ancestors(path: string): string[] {
  const normalized = normalizeRoot(path);
  const out: string[] = [];
  let current = normalized;
  while (current !== "/") {
    out.push(current);
    const slash = current.lastIndexOf("/");
    current = slash <= 0 ? "/" : current.slice(0, slash);
  }
  out.push("/");
  return out;
}

/**
 * Owns the schema and the repository registry. One instance per
 * workspace database; `open()` hands out per-repository stores, cached so
 * their object and chunk caches survive across calls.
 */
export class SqliteGitDatabase {
  readonly #db: SqlDatabase;
  readonly #options: StoreOptions;
  readonly #stores = new Map<number, RepoStore>();

  constructor(db: SqlDatabase, options: StoreOptions = {}) {
    this.#db = db;
    this.#options = options;
    initializeGitSchema(db);
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  /** The repository whose root is the nearest registered ancestor of `dir`. */
  find(dir: string): RepositoryRow | null {
    for (const candidate of ancestors(dir)) {
      const row = this.#db.one<RepositoryRow>(
        "SELECT id, root, head FROM git_repositories WHERE root = ?",
        candidate,
      );
      if (row !== undefined) return row;
    }
    return null;
  }

  at(root: string): RepositoryRow | null {
    return (
      this.#db.one<RepositoryRow>(
        "SELECT id, root, head FROM git_repositories WHERE root = ?",
        normalizeRoot(root),
      ) ?? null
    );
  }

  list(): RepositoryRow[] {
    return this.#db.all<RepositoryRow>("SELECT id, root, head FROM git_repositories ORDER BY root");
  }

  create(root: string, head: string): RepositoryRow {
    const normalized = normalizeRoot(root);
    return this.#db.transactionSync(() => {
      const nextId =
        (this.#db.scalar<number | null>("SELECT MAX(id) FROM git_repositories") ?? 0) + 1;
      this.#db.run(
        "INSERT INTO git_repositories (id, root, head) VALUES (?, ?, ?)",
        nextId,
        normalized,
        head,
      );
      return { id: nextId, root: normalized, head };
    });
  }

  open(repository: RepositoryRow): RepoStore {
    const existing = this.#stores.get(repository.id);
    if (existing !== undefined) return existing;
    // Destroying a repository evicts its store, so a reused id can never
    // hand back the previous repository's caches.
    const store = new RepoStore(this.#db, repository, this.#options, () =>
      this.#stores.delete(repository.id),
    );
    this.#stores.set(repository.id, store);
    return store;
  }
}

/** Objects, refs, config and index for one repository. */
export class RepoStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #root: string;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packs: PackStore;
  #hasLoose: boolean;
  readonly #onDestroy: (() => void) | undefined;

  constructor(
    db: SqlDatabase,
    repository: RepositoryRow,
    options: StoreOptions = {},
    onDestroy?: () => void,
  ) {
    this.#onDestroy = onDestroy;
    this.#db = db;
    this.#repoId = repository.id;
    this.#root = repository.root;
    this.#objects = new ByteLru(
      Math.min(options.objectCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES, DEFAULT_OBJECT_CACHE_BYTES),
      (object) => object.data.length,
    );
    this.#packs = new PackStore(
      db,
      repository.id,
      this.#objects,
      (oid) => this.#readLoose(oid),
      (oids) => this.#readLooseObjects(oids),
      (oids) => this.#looseObjectMetadata(oids),
      options,
    );
    this.#hasLoose =
      (this.#db.scalar<number>(
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)",
        this.#repoId,
      ) ?? 0) > 0;
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  get repoId(): number {
    return this.#repoId;
  }

  get root(): string {
    return this.#root;
  }

  get packs(): PackStore {
    return this.#packs;
  }

  /** Bytes currently held by the two bounded caches. */
  cacheBytes(): { objects: number; chunks: number } {
    return { objects: this.#objects.bytes, chunks: this.#packs.cachedChunkBytes };
  }

  // -- objects --------------------------------------------------------

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    const found = new Map<string, string>();
    for (const page of contentIdPages(contentIds)) {
      for (const row of this.#db.all<{ content_key: string; oid: string }>(
        `WITH ids(content_id) AS MATERIALIZED (
           SELECT CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                   END
             FROM json_each(?)
         )
         SELECT lower(hex(ids.content_id)) AS content_key, b.oid
           FROM ids
           JOIN git_blob_ids b ON b.repo_id = ? AND b.content_id = ids.content_id`,
        blob(page.payload),
        JSON.stringify(page.rows),
        this.#repoId,
      )) {
        if (typeof row.content_key !== "string" || !isOid(row.oid)) {
          throw new CorruptError("blob id lookup returned an invalid mapping");
        }
        found.set(row.content_key, row.oid);
      }
    }
    return found;
  }

  /**
   * Return the ordinals of expected mappings that are absent or disagree.
   *
   * An absent result proves the stored mapping equals the expected oid. A
   * `null` value means there is no stored mapping, so callers must identify
   * the content instead of trusting it.
   */
  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    const retained: BlobIdMapping[] = [];
    let retainedBytes = 0;
    for (const mapping of expected) {
      if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > CONTENT_ID_PAYLOAD) {
        throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
      }
      const bytes = blobIdMismatchRetainedBytes(mapping);
      if (bytes > MAX_BLOB_ID_MISMATCH_RETAINED_BYTES - retainedBytes) {
        throw new GitError(
          "E2BIG",
          `blob id comparison state exceeds ${MAX_BLOB_ID_MISMATCH_RETAINED_BYTES} bytes`,
        );
      }
      retainedBytes += bytes;
      retained.push(mapping);
    }

    const mismatches = new Map<number, string | null>();
    for (const page of expectedContentIdPages(retained)) {
      for (const row of this.#db.all<{ ordinal: number; oid: string | null }>(
        `WITH expected(ordinal, content_id, expected_oid) AS MATERIALIZED (
           SELECT json_extract(value, '$.i'),
                  CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                   END,
                  json_extract(value, '$.o')
             FROM json_each(?)
         )
         SELECT expected.ordinal, b.oid
           FROM expected
           LEFT JOIN git_blob_ids b
             ON b.repo_id = ? AND b.content_id = expected.content_id
          WHERE b.oid IS NULL OR b.oid <> expected.expected_oid`,
        blob(page.payload),
        JSON.stringify(page.rows),
        this.#repoId,
      )) {
        if (
          !Number.isSafeInteger(row.ordinal) ||
          row.ordinal < 0 ||
          row.ordinal >= retained.length ||
          (row.oid !== null && !isOid(row.oid))
        ) {
          throw new CorruptError("blob id comparison returned an invalid mapping");
        }
        if (mismatches.has(row.ordinal)) {
          throw new CorruptError("blob id comparison returned a duplicate ordinal");
        }
        mismatches.set(row.ordinal, row.oid);
      }
    }
    return mismatches;
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    const unique = new Map<string, BlobIdMapping>();
    for (const mapping of mappings) {
      if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > CONTENT_ID_PAYLOAD) {
        throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
      }
      unique.set(contentIdKey(mapping.contentId), mapping);
    }
    if (unique.size === 0) return;
    this.#db.transactionSync(() => {
      let parts: Uint8Array[] = [];
      let rows: { a: number; n: number; o: string }[] = [];
      let length = 0;
      const flush = (): void => {
        if (rows.length === 0) return;
        this.#db.run(
          `INSERT INTO git_blob_ids (repo_id, content_id, oid)
         SELECT ?,
                CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                     ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                 END,
                json_extract(value, '$.o')
           FROM json_each(?)
          WHERE true
         ON CONFLICT(repo_id, content_id) DO UPDATE SET oid = excluded.oid`,
          this.#repoId,
          blob(concat(parts)),
          JSON.stringify(rows),
        );
        parts = [];
        rows = [];
        length = 0;
      };
      for (const mapping of unique.values()) {
        if (
          rows.length > 0 &&
          (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
        ) {
          flush();
        }
        rows.push({ a: length + 1, n: mapping.contentId.length, o: mapping.oid });
        parts.push(mapping.contentId);
        length += mapping.contentId.length;
      }
      flush();
    });
  }

  has(oid: string): boolean {
    if (this.#hasLoose && this.#looseRow(oid) !== null) return true;
    return this.#packs.typeAndSize(oid) !== null;
  }

  /**
   * Which of `oids` this repository already holds, in one statement per
   * page. Both tables, deliberately: an `ON CONFLICT` on `git_objects`
   * alone cannot see a packed object, so after a clone an unchanged tree
   * would be re-written loose and shadow the packed copy.
   */
  hasAll(oids: Iterable<string>): Set<string> {
    const found = new Set<string>();
    let page: string[] = [];
    const probe = (): void => {
      if (page.length === 0) return;
      for (const row of this.#db.all<{ oid: string }>(
        `SELECT j.value AS oid FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM git_objects o WHERE o.repo_id = ? AND o.oid = j.value)
             OR EXISTS (
               SELECT 1 FROM git_pack_objects p
               JOIN git_pack_meta m
                 ON m.repo_id = p.repo_id AND m.pack_id = p.pack_id AND m.state = 'complete'
                WHERE p.repo_id = ? AND p.oid = j.value
             )`,
        JSON.stringify(page),
        this.#repoId,
        this.#repoId,
      )) {
        found.add(row.oid);
      }
      page = [];
    };
    for (const oid of oids) {
      page.push(oid);
      if (page.length >= OID_PROBE_PAGE) probe();
    }
    probe();
    return found;
  }

  /** The oids this repository does not hold, in input order, deduplicated. */
  missing(oids: Iterable<string>): string[] {
    const wanted = [...new Set(oids)];
    const present = this.hasAll(wanted);
    return wanted.filter((oid) => !present.has(oid));
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    if (this.#hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return { type: row.type, size: row.size };
    }
    return this.#packs.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    const cached = this.#objects.get(`loose:${oid}`);
    if (cached !== undefined) return cached;
    return this.#readLoose(oid) ?? this.#packs.read(oid);
  }

  /** Read a deduplicated prefix of blobs under an explicit byte budget. */
  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    const budget = options.budgetBytes ?? MAX_BLOB_BATCH_BYTES;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > MAX_BLOB_BATCH_BYTES) {
      throw new RangeError(`blob read budget must be an integer from 1 to ${MAX_BLOB_BATCH_BYTES}`);
    }
    const wanted = [...new Set(oids)];
    if (wanted.length > MAX_BLOB_BATCH_OIDS) {
      throw new GitError("E2BIG", `blob batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
    }
    for (const oid of wanted) {
      if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    }
    if (wanted.length === 0) return { blobs: new Map(), remaining: [], bytes: 0 };

    const metadata = this.#db.all<{
      ordinal: number;
      oid: string;
      source: string | null;
      type: string | null;
      size: number | null;
      stored: string | null;
    }>(
      `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.ordinal, w.oid,
              CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                   WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
              CASE WHEN loose.oid IS NOT NULL THEN loose.type
                   WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
              CASE WHEN loose.oid IS NOT NULL THEN loose.size
                   WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size,
              loose.stored
         FROM wanted w
         LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
         LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
          AND pack.state = 'complete'
        ORDER BY w.ordinal`,
      JSON.stringify(wanted),
      this.#repoId,
      this.#repoId,
    );
    if (metadata.length !== wanted.length) {
      throw new CorruptError("blob metadata lookup returned the wrong row count");
    }

    const selected: typeof metadata = [];
    let bytes = 0;
    for (let index = 0; index < metadata.length; index++) {
      const row = metadata[index]!;
      if (
        row.ordinal !== index ||
        row.oid !== wanted[index] ||
        (row.source !== "loose" && row.source !== "pack")
      ) {
        if (row.source === null) throw new ObjectNotFoundError(wanted[index]!);
        throw new CorruptError("blob metadata lookup returned an invalid source");
      }
      if (row.type !== "blob") throw new CorruptError(`${row.oid} is a ${row.type}, not a blob`);
      const size = row.size;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new CorruptError(`blob ${row.oid} has an invalid indexed size`);
      }
      if (bytes + size > budget) {
        if (selected.length === 0) {
          throw new GitError("EFBIG", `blob ${row.oid} exceeds the ${budget}-byte read budget`);
        }
        break;
      }
      selected.push(row);
      bytes += size;
    }

    const looseRows = selected.filter((row) => row.source === "loose");
    const packedOids = selected.filter((row) => row.source === "pack").map((row) => row.oid);
    const looseObjects = this.#readLooseObjectRows(looseRows);
    const loose = new Map<string, Uint8Array>();
    for (const [oid, object] of looseObjects) {
      if (object.type !== "blob") throw new CorruptError(`${oid} is not a blob`);
      loose.set(oid, object.data);
    }
    const packed = this.#packs.readBlobs(packedOids);
    const blobs = new Map<string, Uint8Array>();
    for (const row of selected) {
      const data = (row.source === "loose" ? loose : packed).get(row.oid);
      if (data === undefined || data.length !== row.size) {
        throw new CorruptError(`blob ${row.oid} did not produce its indexed bytes`);
      }
      blobs.set(row.oid, data);
    }
    return { blobs, remaining: wanted.slice(selected.length), bytes };
  }

  /** Stream every non-tree entry in raw Git DFS order with one SQL statement. */
  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    for (const row of this.#db.iterate(
      WALK_TREE_SQL,
      this.#repoId,
      treeOid,
      TREE_WALK_PATH_BYTES,
      TREE_WALK_STATE_BYTES,
      TREE_WALK_QUEUE_BYTES,
      TREE_QUEUE_ROW_FIXED_BYTES,
    )) {
      const error = row.error;
      if (typeof error === "string") {
        if (row.error_code === "E2BIG") throw new GitError("E2BIG", error);
        throw new CorruptError(error);
      }
      const path = row.path;
      const mode = row.mode;
      const oid = row.oid;
      if (typeof path !== "string" || typeof mode !== "string" || typeof oid !== "string") {
        throw new CorruptError("tree traversal yielded an invalid row");
      }
      yield { path, mode, oid };
    }
  }

  write(type: ObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    const commitEntry =
      type === "commit" ? prepareCommitCache({ repoId: this.#repoId, oid, data }) : undefined;
    if (this.has(oid)) {
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
      return oid;
    }
    const stored = looseEncoding(data.length);
    const storedData = encodeLoose(data, stored);
    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, ?)",
        this.#repoId,
        oid,
        type,
        data.length,
        stored,
      );
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      );
      for (
        let seq = 0, offset = 0;
        offset < storedData.length || seq === 0;
        seq++, offset += OBJECT_CHUNK
      ) {
        const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
        if (part.length === 0) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, zeroblob(0))",
            this.#repoId,
            oid,
            seq,
          );
        } else {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
            this.#repoId,
            oid,
            seq,
            blob(part),
          );
        }
      }
      if (type === "tree") {
        indexTreeSource(
          this.#db,
          {
            repoId: this.#repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: data.length,
          },
          [data],
        );
      }
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
    });
    this.#hasLoose = true;
    this.#objects.set(`loose:${oid}`, { type, data });
    return oid;
  }

  /**
   * Write a loose object from a stream of chunks. `chunks` is a factory
   * because the content is read twice: once to hash it, which is how the oid
   * is known and how `has` can short-circuit before a single row is written,
   * and once to deflate and store it. Nothing larger than one chunk is ever
   * live, so the peak does not follow the object's size.
   */
  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    if (type === "commit" && size > MAX_INDEXED_COMMIT_BYTES) {
      throw new GitError("E2BIG", "commit exceeds the 1 MiB cache limit");
    }
    const hash = new Sha1().update(objectHeader(type, size));
    const commitData =
      type === "commit" && size <= MAX_INDEXED_COMMIT_BYTES ? new Uint8Array(size) : undefined;
    let hashed = 0;
    for (const chunk of chunks()) {
      if (hashed + chunk.length <= size) commitData?.set(chunk, hashed);
      hashed += chunk.length;
      hash.update(chunk);
    }
    if (hashed !== size) {
      throw new CorruptError(`streamed ${hashed} bytes for a ${type} declared as ${size}`);
    }
    const oid = toHex(hash.digest());
    const commitEntry =
      commitData === undefined
        ? undefined
        : prepareCommitCache({ repoId: this.#repoId, oid, data: commitData });
    if (this.has(oid)) {
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
      return oid;
    }

    const stored = looseEncoding(size);
    if (stored === "raw") {
      const data = commitData ?? new Uint8Array(size);
      const storageHash = new Sha1().update(objectHeader(type, size));
      let offset = 0;
      for (const chunk of chunks()) {
        if (offset + chunk.length > size) {
          throw new CorruptError(`stream changed after hashing ${oid}`);
        }
        data.set(chunk, offset);
        storageHash.update(chunk);
        offset += chunk.length;
      }
      if (offset !== size) throw new CorruptError(`stream changed after hashing ${oid}`);
      if (toHex(storageHash.digest()) !== oid) {
        throw new CorruptError(`stream changed after hashing ${oid}`);
      }
      this.#db.transactionSync(() => {
        this.#db.run(
          "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'raw')",
          this.#repoId,
          oid,
          type,
          size,
        );
        this.#db.run(
          "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
          this.#repoId,
          oid,
        );
        if (data.length === 0) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, zeroblob(0))",
            this.#repoId,
            oid,
          );
        } else {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
            this.#repoId,
            oid,
            blob(data),
          );
        }
        if (type === "tree") {
          indexTreeSource(
            this.#db,
            {
              repoId: this.#repoId,
              treeOid: oid,
              storage: "loose",
              sourceId: 0,
              objectSize: size,
            },
            [data],
          );
        }
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
      });
      this.#hasLoose = true;
      return oid;
    }

    const rows: Uint8Array[] = [];
    const deflate = new pako.Deflate({ chunkSize: STREAM_CHUNK });
    deflate.onData = (chunk) => {
      if (!(chunk instanceof Uint8Array))
        throw new CorruptError("deflate produced a non-binary chunk");
      rows.push(chunk);
    };

    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'zlib')",
        this.#repoId,
        oid,
        type,
        size,
      );
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      );
      let seq = 0;
      const drain = (): void => {
        for (const row of rows) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
            this.#repoId,
            oid,
            seq++,
            blob(row),
          );
        }
        rows.length = 0;
      };
      const storageChunks = function* (): Generator<Uint8Array> {
        const storageHash = new Sha1().update(objectHeader(type, size));
        let streamed = 0;
        for (const chunk of chunks()) {
          const offset = streamed;
          streamed += chunk.length;
          if (streamed > size) throw new CorruptError(`stream changed after hashing ${oid}`);
          commitData?.set(chunk, offset);
          storageHash.update(chunk);
          deflate.push(chunk, false);
          if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
          drain();
          yield chunk;
        }
        deflate.push(new Uint8Array(0), true);
        if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
        drain();
        if (streamed !== size || toHex(storageHash.digest()) !== oid) {
          throw new CorruptError(`stream changed after hashing ${oid}`);
        }
      };
      const storage = storageChunks();
      if (type === "tree") {
        indexTreeSource(
          this.#db,
          {
            repoId: this.#repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: size,
          },
          storage,
        );
      } else {
        for (const _chunk of storage) {
          // Storage and hashing advance together without retaining the object.
        }
      }
      // An empty object still deserves one row, matching `write`.
      if (seq === 0) {
        this.#db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          this.#repoId,
          oid,
          0,
          blob(new Uint8Array(0)),
        );
      }
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
    });
    this.#hasLoose = true;
    return oid;
  }

  /**
   * Open a batch of loose object writes. However many objects go in, a
   * flush costs one existence probe, one delete, one insert per payload
   * budget and one metadata insert — not five statements per object.
   *
   * The caller owns the lifecycle; `writeObjects` is the scoped form that
   * cannot forget the final flush.
   */
  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
    const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
    // Keyed by oid: a tree build re-emits identical subtrees, and one
    // (oid, seq) may appear at most once in a payload.
    const staged = new Map<string, StagedObject>();
    let bytes = 0;
    let commitBytes = 0;
    const flush = (): void => {
      if (staged.size === 0) return;
      this.#flushObjects([...staged.values()], payloadBytes);
      staged.clear();
      bytes = 0;
      commitBytes = 0;
    };
    return {
      write: (type: ObjectType, data: Uint8Array): string => {
        const oid = hashObject(type, data);
        if (staged.has(oid)) return oid;
        const stored = looseEncoding(data.length);
        const storedData = stored === "raw" ? data.slice() : encodeLoose(data, stored);
        const object: StagedObject = { oid, type, size: data.length, stored, storedData };
        if (type === "tree") object.treeData = stored === "raw" ? storedData : data.slice();
        if (type === "commit") {
          const commitEntry = prepareCommitCache({ repoId: this.#repoId, oid, data });
          object.commitEntry = commitEntry;
        }
        staged.set(oid, object);
        bytes += storedData.length;
        if (object.treeData !== undefined && object.treeData !== storedData) {
          bytes += object.treeData.length;
        }
        if (object.commitEntry !== undefined) commitBytes += object.commitEntry.cacheBytes;
        // After staging, never before: an object's chunks and its metadata
        // row have to land in the same flush, whatever its size.
        if (
          bytes >= payloadBytes ||
          commitBytes >= COMMIT_STAGE_CACHE_BYTES ||
          staged.size >= flushEvery
        ) {
          flush();
        }
        return oid;
      },
      flush,
    };
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    const batch = this.writeBatch(options);
    const result = body(batch);
    batch.flush();
    return result;
  }

  #flushObjects(staged: StagedObject[], payloadBytes: number): void {
    const byOid = new Map(staged.map((object) => [object.oid, object]));
    const commitEntries = staged.flatMap((object) =>
      object.commitEntry === undefined ? [] : [object.commitEntry],
    );
    const meta = JSON.stringify(
      staged.map((object) => ({ o: object.oid, t: object.type, s: object.size, e: object.stored })),
    );
    let wroteLoose = false;
    this.#db.transactionSync(() => {
      const fresh: StagedObject[] = [];
      for (const row of this.#db.iterate(
        `INSERT INTO git_objects (repo_id, oid, type, size, stored)
         SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.t'),
                json_extract(j.value, '$.s'), json_extract(j.value, '$.e')
           FROM json_each(?) j
          WHERE NOT EXISTS (
            SELECT 1
              FROM git_pack_objects packed
              JOIN git_pack_meta pack
                ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
               AND pack.state = 'complete'
             WHERE packed.repo_id = ?
               AND packed.oid = json_extract(j.value, '$.o')
          )
         ON CONFLICT(repo_id, oid) DO NOTHING
         RETURNING oid`,
        this.#repoId,
        meta,
        this.#repoId,
      )) {
        if (typeof row.oid !== "string") {
          throw new CorruptError("object metadata insert returned an invalid oid");
        }
        const object = byOid.get(row.oid);
        if (object === undefined) {
          throw new CorruptError("object metadata insert returned an unknown oid");
        }
        fresh.push(object);
      }
      if (fresh.length === 0) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, commitEntries), commitEntries.length);
        return;
      }
      wroteLoose = true;

      const payloads: ChunkPayload[] = [{ parts: [], length: 0, rows: [] }];
      for (const object of fresh) {
        const storedData = object.storedData;
        for (
          let seq = 0, offset = 0;
          offset < storedData.length || seq === 0;
          seq++, offset += OBJECT_CHUNK
        ) {
          const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
          let current = payloads[payloads.length - 1]!;
          if (current.length > 0 && current.length + part.length > payloadBytes) {
            current = { parts: [], length: 0, rows: [] };
            payloads.push(current);
          }
          // `a` is a 1-based byte offset: substr() counts bytes over a BLOB.
          current.rows.push({ o: object.oid, q: seq, a: current.length + 1, n: part.length });
          current.parts.push(part);
          current.length += part.length;
        }
      }

      const oids = JSON.stringify(fresh.map((object) => object.oid));
      // The transaction keeps metadata invisible until all chunks and parsed
      // tree rows are ready, while RETURNING replaces a separate probe.
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
        this.#repoId,
        oids,
      );
      for (const payload of payloads) {
        this.#db.run(
          `INSERT INTO git_object_chunks (repo_id, oid, seq, data)
           SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.q'),
                  CASE WHEN json_extract(j.value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.n'))
                   END
             FROM json_each(?) j
            WHERE true
           ON CONFLICT(repo_id, oid, seq) DO UPDATE SET data = excluded.data`,
          this.#repoId,
          blob(concat(payload.parts)),
          JSON.stringify(payload.rows),
        );
      }
      indexTreeSources(
        this.#db,
        fresh.flatMap((object) => {
          if (object.type !== "tree" || object.treeData === undefined) return [];
          return [
            {
              repoId: this.#repoId,
              treeOid: object.oid,
              storage: "loose",
              sourceId: 0,
              objectSize: object.size,
              chunks: [object.treeData],
            },
          ];
        }),
      );
      requireCommitCacheWrites(insertCommitCaches(this.#db, commitEntries), commitEntries.length);
    });
    if (wroteLoose) this.#hasLoose = true;
  }

  /**
   * Inflated object bytes, chunk by chunk. A loose object really streams: its
   * rows are read one at a time and inflated incrementally. A packed object
   * yields exactly one chunk holding the whole thing, because a delta cannot
   * be reconstructed without its full base in memory. Null when unknown.
   */
  readChunks(oid: string): Iterable<Uint8Array> | null {
    const cached = this.#objects.get(`loose:${oid}`);
    if (cached !== undefined) return [cached.data];
    if (this.#hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return this.#looseChunks(oid, parseLooseEncoding(row.stored));
    }
    const packed = this.#packs.read(oid);
    return packed === null ? null : [packed.data];
  }

  *#looseChunks(oid: string, stored: LooseEncoding): Generator<Uint8Array> {
    if (stored === "raw") {
      for (let seq = 0; ; seq++) {
        const row = this.#db.one<{ data: unknown }>(
          "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
          this.#repoId,
          oid,
          seq,
        );
        if (row === undefined) return;
        yield readBlob(row.data);
      }
    }
    const ready: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => ready.push(chunk));
    for (let seq = 0; ; seq++) {
      const row = this.#db.one<{ data: unknown }>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
        this.#repoId,
        oid,
        seq,
      );
      if (row === undefined) break;
      const compressed = readBlob(row.data);
      for (let offset = 0; offset < compressed.length; offset += INFLATE_FEED) {
        stream.push(compressed.subarray(offset, offset + INFLATE_FEED));
        for (const chunk of ready) yield chunk;
        ready.length = 0;
      }
      if (compressed.length === 0) {
        for (const chunk of ready) yield chunk;
        ready.length = 0;
      }
    }
    for (const chunk of ready) yield chunk;
  }

  /** Resolve an abbreviated oid. Null when unknown or ambiguous. */
  resolvePrefix(prefix: string): string | null {
    if (prefix.length === 40) return this.has(prefix) ? prefix : null;
    const found = new Set<string>();
    if (this.#hasLoose) {
      const upper = nextPrefix(prefix);
      for (const row of this.#db.all<{ oid: string }>(
        "SELECT oid FROM git_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2",
        this.#repoId,
        prefix,
        upper,
      )) {
        found.add(row.oid);
      }
    }
    for (const oid of this.#packs.findPrefix(prefix, 2)) found.add(oid);
    return found.size === 1 ? [...found][0]! : null;
  }

  objectCount(): number {
    const loose =
      this.#db.scalar<number>("SELECT COUNT(*) FROM git_objects WHERE repo_id = ?", this.#repoId) ??
      0;
    return loose + this.#packs.count();
  }

  #looseRow(oid: string): { type: ObjectType; size: number; stored: string } | null {
    return (
      this.#db.one<{ type: ObjectType; size: number; stored: string }>(
        "SELECT type, size, stored FROM git_objects WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      ) ?? null
    );
  }

  #readLoose(oid: string): RawObject | null {
    if (!this.#hasLoose) return null;
    const row = this.#looseRow(oid);
    if (row === null) return null;
    const chunks = this.#db.all<{ data: unknown }>(
      "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? ORDER BY seq",
      this.#repoId,
      oid,
    );
    const object: RawObject = {
      type: row.type,
      data:
        parseLooseEncoding(row.stored) === "raw"
          ? concat(chunks.map((chunk) => readBlob(chunk.data)))
          : inflate(concat(chunks.map((chunk) => readBlob(chunk.data)))),
    };
    this.#objects.set(`loose:${oid}`, object);
    return object;
  }

  #readLooseObjects(oids: readonly string[]): Map<string, RawObject> {
    if (oids.length === 0) return new Map();
    const rows = this.#db.all<{
      oid: string;
      type: string;
      size: number;
      stored: string;
    }>(
      `SELECT wanted.value AS oid, object.type, object.size, object.stored
         FROM json_each(?) wanted
         JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.value`,
      JSON.stringify(oids),
      this.#repoId,
    );
    return this.#readLooseObjectRows(rows);
  }

  #looseObjectMetadata(oids: readonly string[]): Map<string, { type: ObjectType; size: number }> {
    if (oids.length === 0) return new Map();
    const result = new Map<string, { type: ObjectType; size: number }>();
    for (const row of this.#db.all<{ oid: string; type: string; size: number }>(
      `SELECT wanted.value AS oid, object.type, object.size
         FROM json_each(?) wanted
         JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.value`,
      JSON.stringify(oids),
      this.#repoId,
    )) {
      if (
        !isOid(row.oid) ||
        !isObjectType(row.type) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > MAX_PACK_DELTA_WORKING_BYTES ||
        result.has(row.oid)
      ) {
        throw new CorruptError("loose object metadata query returned an invalid row");
      }
      result.set(row.oid, { type: row.type, size: row.size });
    }
    return result;
  }

  #readLooseObjectRows(
    rows: readonly {
      oid: string;
      type: string | null;
      size: number | null;
      stored: string | null;
    }[],
  ): Map<string, RawObject> {
    if (rows.length === 0) return new Map();
    const wanted = rows.map((row) => row.oid);
    const gate = this.#db.all<{
      oid: string;
      chunks: number;
      first_seq: number | null;
      last_seq: number | null;
      largest_chunk: number;
      stored_bytes: number;
    }>(
      `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.oid, COUNT(c.seq) AS chunks, MIN(c.seq) AS first_seq,
              MAX(c.seq) AS last_seq, COALESCE(MAX(length(c.data)), 0) AS largest_chunk,
              COALESCE(SUM(length(c.data)), 0) AS stored_bytes
         FROM wanted w
         LEFT JOIN git_object_chunks c ON c.repo_id = ? AND c.oid = w.oid
        GROUP BY w.ordinal, w.oid
        ORDER BY w.ordinal`,
      JSON.stringify(wanted),
      this.#repoId,
    );
    let storedBytes = 0;
    let outputBytes = 0;
    if (gate.length !== rows.length) throw new CorruptError("loose blob gate lost an object");
    for (let index = 0; index < gate.length; index++) {
      const checked = gate[index]!;
      const source = rows[index]!;
      const chunks = Number(checked.chunks);
      const size = source.size;
      if (
        checked.oid !== source.oid ||
        !isObjectType(source.type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_PACK_DELTA_WORKING_BYTES ||
        !Number.isSafeInteger(chunks) ||
        chunks <= 0 ||
        checked.first_seq !== 0 ||
        checked.last_seq !== chunks - 1 ||
        !Number.isSafeInteger(checked.largest_chunk) ||
        checked.largest_chunk < 0 ||
        checked.largest_chunk > OBJECT_CHUNK ||
        !Number.isSafeInteger(checked.stored_bytes) ||
        checked.stored_bytes < 0
      ) {
        throw new CorruptError(`loose blob ${source.oid} has invalid chunk metadata`);
      }
      storedBytes += checked.stored_bytes;
      if (!Number.isSafeInteger(storedBytes) || storedBytes > MAX_BLOB_BATCH_BYTES + 64 * 1024) {
        throw new GitError("E2BIG", "loose blob storage exceeds the bounded batch limit");
      }
      outputBytes += size;
      if (
        !Number.isSafeInteger(outputBytes) ||
        (rows.length > 1 && outputBytes > MAX_BLOB_BATCH_BYTES)
      ) {
        throw new GitError("E2BIG", "loose object output exceeds the bounded batch limit");
      }
    }

    const parts = new Map<string, Uint8Array[]>();
    for (const row of this.#db.iterate(
      `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.oid, c.seq, c.data
         FROM wanted w
         JOIN git_object_chunks c ON c.repo_id = ? AND c.oid = w.oid
        ORDER BY w.ordinal, c.seq`,
      JSON.stringify(wanted),
      this.#repoId,
    )) {
      if (typeof row.oid !== "string" || !Number.isSafeInteger(row.seq)) {
        throw new CorruptError("loose blob query returned invalid chunk metadata");
      }
      const list = parts.get(row.oid);
      if (list === undefined) parts.set(row.oid, [readBlob(row.data)]);
      else list.push(readBlob(row.data));
    }

    const result = new Map<string, RawObject>();
    for (const row of rows) {
      if (!isObjectType(row.type)) throw new CorruptError(`${row.oid} has an invalid object type`);
      const size = row.size;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new CorruptError(`loose blob ${row.oid} has an invalid size`);
      }
      if (size > MAX_PACK_DELTA_WORKING_BYTES) {
        throw new GitError("E2BIG", `loose blob ${row.oid} exceeds the bounded inflate limit`);
      }
      const stored = parseLooseEncoding(row.stored ?? "");
      const encoded = concat(parts.get(row.oid) ?? []);
      let data: Uint8Array;
      if (stored === "raw") {
        data = encoded;
      } else {
        const stream = new InflateInto(size);
        let consumed = 0;
        while (!stream.ended && consumed < encoded.length) {
          const input = encoded.subarray(consumed, consumed + INFLATE_FEED);
          let used: number;
          try {
            used = stream.push(input);
          } catch (error) {
            if (error instanceof InflateSizeError) {
              throw new CorruptError(`loose object ${row.oid} exceeds its indexed size`, {
                cause: error,
              });
            }
            throw error;
          }
          consumed += used;
          if (!stream.ended && used !== input.length) {
            throw new CorruptError(`loose object ${row.oid} inflater made no progress`);
          }
        }
        if (!stream.ended || consumed !== encoded.length) {
          throw new CorruptError(`loose object ${row.oid} size does not match its metadata`);
        }
        try {
          data = stream.finish();
        } catch (error) {
          throw new CorruptError(`loose object ${row.oid} size does not match its metadata`, {
            cause: error,
          });
        }
      }
      if (data.length !== size) {
        throw new CorruptError(`loose blob ${row.oid} size does not match its metadata`);
      }
      const object: RawObject = { type: row.type, data };
      this.#objects.set(`loose:${row.oid}`, object);
      result.set(row.oid, object);
    }
    return result;
  }

  // -- refs -----------------------------------------------------------

  /** Raw ref value: an oid, or "ref: <name>" for a symbolic ref. */
  getRef(name: string): string | null {
    if (name === "HEAD") return this.head();
    return (
      this.#db.scalar<string>(
        "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
        this.#repoId,
        name,
      ) ?? null
    );
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") {
      this.setHead(target);
      return;
    }
    this.#db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?) ON CONFLICT(repo_id, name) DO UPDATE SET target = excluded.target",
      this.#repoId,
      name,
      target,
    );
  }

  deleteRef(name: string): void {
    this.#db.run("DELETE FROM git_refs WHERE repo_id = ? AND name = ?", this.#repoId, name);
  }

  /** Apply bounded ref deletions and updates atomically. */
  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    const checkedPuts = function* (): Generator<RefRow> {
      for (const row of puts) {
        if (row.name === "HEAD") throw new GitError("EINVAL", "HEAD is not a git_refs row");
        yield row;
      }
    };
    this.#db.transactionSync(() => {
      for (const page of jsonPages(deletes, "ref deletion")) {
        this.#db.run(
          `DELETE FROM git_refs
            WHERE repo_id = ? AND name IN (SELECT value FROM json_each(?))`,
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(checkedPuts(), "ref update")) {
        this.#db.run(
          `INSERT INTO git_refs (repo_id, name, target)
           SELECT ?, json_extract(value, '$.name'), json_extract(value, '$.target')
             FROM json_each(?)
            WHERE true
           ON CONFLICT(repo_id, name) DO UPDATE SET target = excluded.target`,
          this.#repoId,
          page,
        );
      }
    });
  }

  listRefs(prefix = ""): RefRow[] {
    if (prefix === "") {
      return this.#db.all<RefRow>(
        "SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
        this.#repoId,
      );
    }
    return this.#db.all<RefRow>(
      "SELECT name, target FROM git_refs WHERE repo_id = ? AND name >= ? AND name < ? ORDER BY name",
      this.#repoId,
      prefix,
      nextPrefix(prefix),
    );
  }

  head(): string {
    return (
      this.#db.scalar<string>("SELECT head FROM git_repositories WHERE id = ?", this.#repoId) ??
      "ref: refs/heads/main"
    );
  }

  setHead(value: string): void {
    this.#db.run("UPDATE git_repositories SET head = ? WHERE id = ?", value, this.#repoId);
  }

  // -- config ---------------------------------------------------------

  configGetAll(path: string): string[] {
    return this.#db
      .all<{ value: string }>(
        "SELECT value FROM git_config WHERE repo_id = ? AND path = ? ORDER BY seq",
        this.#repoId,
        path,
      )
      .map((row) => row.value);
  }

  configGet(path: string): string | undefined {
    // git's `--get` reports the last value for a multi-valued key.
    const values = this.configGetAll(path);
    return values.length === 0 ? undefined : values[values.length - 1];
  }

  configSet(path: string, value: string): void {
    this.#db.transactionSync(() => {
      this.#db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.#repoId, path);
      this.#db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, 0, ?)",
        this.#repoId,
        path,
        value,
      );
    });
  }

  configAdd(path: string, value: string): void {
    this.#db.transactionSync(() => {
      const seq =
        (this.#db.scalar<number | null>(
          "SELECT MAX(seq) FROM git_config WHERE repo_id = ? AND path = ?",
          this.#repoId,
          path,
        ) ?? -1) + 1;
      this.#db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, ?, ?)",
        this.#repoId,
        path,
        seq,
        value,
      );
    });
  }

  configUnset(path: string): void {
    this.#db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.#repoId, path);
  }

  /** Distinct config paths under a dotted prefix, e.g. "remote.". */
  configPaths(prefix: string): string[] {
    return this.#db
      .all<{ path: string }>(
        "SELECT DISTINCT path FROM git_config WHERE repo_id = ? AND path >= ? AND path < ? ORDER BY path",
        this.#repoId,
        prefix,
        nextPrefix(prefix),
      )
      .map((row) => row.path);
  }

  // -- index ----------------------------------------------------------

  indexEntries(): IndexEntry[] {
    return this.#db.all<IndexEntry>(
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE repo_id = ? ORDER BY path, stage",
      this.#repoId,
    );
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return (
      this.#db.one<IndexEntry>(
        "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE repo_id = ? AND path = ? AND stage = ?",
        this.#repoId,
        path,
        stage,
      ) ?? null
    );
  }

  indexPut(entry: IndexEntry): void {
    this.#db.run(
      `INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      this.#repoId,
      entry.path,
      entry.stage,
      entry.mode,
      entry.oid,
      entry.size,
      entry.mtime,
      entry.ino,
      entry.rev ?? null,
    );
  }

  /** Remove every stage of `path`. */
  indexRemove(path: string): void {
    this.#db.run("DELETE FROM git_index WHERE repo_id = ? AND path = ?", this.#repoId, path);
  }

  indexClear(): void {
    this.#db.run("DELETE FROM git_index WHERE repo_id = ?", this.#repoId);
  }

  #applyIndexMutations(pending: readonly BufferedIndexMutation[]): void {
    // Delete touched paths first, then retain only puts after their last remove.
    const hasRemoves = pending.some((item) => item.kind === "r");
    const hasPuts = pending.some((item) => item.kind === "p");
    const mutations = `[${pending.map((item) => item.json).join(",")}]`;
    if (hasRemoves) {
      this.#db.run(
        `DELETE FROM git_index
          WHERE repo_id = ?
            AND path IN (
              SELECT json_extract(value, '$.p') FROM json_each(?)
               WHERE json_extract(value, '$.k') = 'r'
            )`,
        this.#repoId,
        mutations,
      );
    }
    if (!hasPuts) return;
    this.#db.run(
      `WITH mutation AS (
         SELECT CAST(j.key AS INTEGER) AS q,
                json_extract(j.value, '$.k') AS kind,
                json_extract(j.value, '$.p') AS path,
                json_extract(j.value, '$.g') AS stage,
                json_extract(j.value, '$.m') AS mode,
                json_extract(j.value, '$.o') AS oid,
                json_extract(j.value, '$.s') AS size,
                json_extract(j.value, '$.t') AS mtime,
                json_extract(j.value, '$.i') AS ino,
                json_extract(j.value, '$.r') AS rev
           FROM json_each(?) j
       ), ranked AS (
         SELECT mutation.*,
                max(CASE WHEN kind = 'r' THEN q ELSE -1 END)
                  OVER (PARTITION BY path) AS last_remove,
                max(CASE WHEN kind = 'p' THEN q ELSE -1 END)
                  OVER (PARTITION BY path, stage) AS last_put
           FROM mutation
       )
       INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, current.path, current.stage, current.mode, current.oid,
              current.size, current.mtime, current.ino, current.rev
         FROM ranked current
        WHERE current.kind = 'p'
          AND current.q = current.last_put
          AND current.q > current.last_remove
        ORDER BY current.q
       ON CONFLICT(repo_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      mutations,
      this.#repoId,
    );
  }

  /**
   * Replace the whole index from a stream. Bounded by the flush size, not by
   * the length of `entries`, so a full reset never materialises the tree.
   */
  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    let first = true;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.#db.transactionSync(() => {
        if (first) this.indexClear();
        this.#applyIndexMutations(mutations);
      });
      first = false;
    });
    for (const entry of entries) pending.add(entry);
    pending.flush();
    if (first) this.#db.transactionSync(() => this.indexClear());
  }

  /**
   * Index rows in (path, stage) order, one bounded page at a time.
   *
   * Keyset paging must carry the stage: the key is (path, stage), so a page
   * boundary falling between stage 0 and stage 2 of one path would drop a row
   * if the cursor were the path alone.
   *
   * CONTRACT: a caller may mutate only paths at or behind the frontier it has
   * already been handed. Each page is a fresh query, so a row written ahead of
   * the frontier would be observed by this scan; a row written behind it would
   * not. `indexApply` is the shape that makes obeying this the easy path.
   */
  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    const pageSize = options.pageSize ?? DEFAULT_INDEX_PAGE;
    const prefix = options.prefix;
    let path = options.after?.path ?? "";
    let stage = options.after?.stage ?? -1;

    for (;;) {
      const page =
        prefix === undefined || prefix === ""
          ? this.#db.all<IndexEntry>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index
               WHERE repo_id = ? AND (path > ? OR (path = ? AND stage > ?))
               ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              path,
              path,
              stage,
              pageSize,
            )
          : this.#db.all<IndexEntry>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index
               WHERE repo_id = ? AND (path > ? OR (path = ? AND stage > ?))
                 AND (path = ? OR (path >= ? AND path < ?))
               ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              path,
              path,
              stage,
              prefix,
              `${prefix}/`,
              nextPrefix(`${prefix}/`),
              pageSize,
            );
      if (page.length === 0) return;
      for (const entry of page) yield entry;
      const last = page[page.length - 1]!;
      path = last.path;
      stage = last.stage;
      if (page.length < pageSize) return;
    }
  }

  /**
   * Run `body` with a bounded, ordered mutation sink. Mutations are buffered
   * and applied in batches of `flushEvery`, each batch one transaction, so a
   * staging pass over a large index never holds every change it made.
   */
  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.#db.transactionSync(() => {
        this.#applyIndexMutations(mutations);
      });
    });
    const sink: IndexSink = {
      put: (entry) => pending.add(entry),
      remove: (path) => pending.add(path),
      flush: () => pending.flush(),
    };
    const result = body(sink);
    pending.flush();
    return result;
  }

  /** True when any entry sits at a merge stage. */
  hasConflicts(): boolean {
    return (
      (this.#db.scalar<number>(
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_index WHERE repo_id = ? AND stage > 0 LIMIT 1)",
        this.#repoId,
      ) ?? 0) > 0
    );
  }

  /** Read a complete parsed commit while its exact raw source remains valid. */
  cachedCommit(oid: string): CommitCacheEntry | null {
    return readCommitCache(this.#db, this.#repoId, oid);
  }

  /** Validate raw bytes and prepare an opaque point-cache entry without writing it. */
  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return prepareCommitCache({ repoId: this.#repoId, oid, data });
  }

  /** Lazily add one derived commit row from bytes the caller already read. */
  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return indexCommitSource(this.#db, { repoId: this.#repoId, oid, data });
  }

  /** Insert prepared point misses with the shared row and JSON byte bounds. */
  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return insertCommitCaches(this.#db, entries);
  }

  /** Parsed commits reachable from `rootOid`, read by one bounded recursive cursor. */
  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return readCommitGraph(this.#db, this.#repoId, rootOid, limits);
  }

  // -- shallow --------------------------------------------------------

  shallow(): Set<string> {
    return new Set(
      this.#db
        .all<{ oid: string }>("SELECT oid FROM git_shallow WHERE repo_id = ?", this.#repoId)
        .map((row) => row.oid),
    );
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    const checked = function* (oids: Iterable<string>): Generator<string> {
      for (const oid of oids) {
        if (!isOid(oid)) throw new CorruptError(`invalid shallow object id ${oid}`);
        yield oid;
      }
    };
    this.#db.transactionSync(() => {
      for (const page of jsonPages(checked(remove), "shallow deletion")) {
        this.#db.run(
          "DELETE FROM git_shallow WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(checked(add), "shallow update")) {
        this.#db.run(
          `INSERT OR IGNORE INTO git_shallow (repo_id, oid)
           SELECT ?, value FROM json_each(?)`,
          this.#repoId,
          page,
        );
      }
    });
  }

  // -- lifecycle ------------------------------------------------------

  /** Drop every row belonging to this repository. */
  destroy(): void {
    this.#db.transactionSync(() => {
      for (const table of [
        "git_refs",
        "git_blob_ids",
        "git_config",
        "git_index",
        "git_shallow",
        "git_commits",
        "git_tree_effective",
        "git_tree_entries",
        "git_tree_sources",
        "git_objects",
        "git_object_chunks",
        "git_pack_meta",
        "git_pack_data",
        "git_pack_objects",
        "git_pack_pending",
      ]) {
        this.#db.run(`DELETE FROM ${table} WHERE repo_id = ?`, this.#repoId);
      }
      this.#db.run("DELETE FROM git_repositories WHERE id = ?", this.#repoId);
    });
    this.#objects.clear();
    this.#packs.clearCaches();
    this.#hasLoose = false;
    this.#onDestroy?.();
  }
}

/** The exclusive upper bound of a string prefix range. */
function nextPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}
