import { isOid, utf8Decoder } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { type Commit, hashObject, parseCommit } from "../core/objects.js";
import type { MemoryReservation } from "../memory.js";
import { readBlob, type SqlDatabase } from "./db.js";

export const MAX_INDEXED_COMMIT_BYTES = 1024 * 1024;
export const MAX_COMMIT_CACHE_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_COMMITS = 50_000;
export const MAX_LOG_STATE_BYTES = 32 * 1024 * 1024;
const COMMIT_BATCH_ROWS = 2048;
const COMMIT_BATCH_JSON_BYTES = 1024 * 1024;
/** Commit wrappers plus graph map, set, heap, DFS and result slots. */
const COMMIT_FIXED_CACHE_BYTES = 512;
const COMMIT_PARENT_CACHE_BYTES = 64;
const JSON_ENCODER = new TextEncoder();

function retainedStringUnits(units: number): number {
  return 48 + 2 * units;
}

function jsonStringShape(value: string): { units: number; bytes: number } {
  let units = 2;
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      units += 2;
      bytes += 2;
    } else if (unit < 0x20) {
      units += 6;
      bytes += 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        units += 2;
        bytes += 4;
        index++;
      } else {
        units += 6;
        bytes += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      units += 6;
      bytes += 6;
    } else {
      units++;
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return { units, bytes };
}

/** Pre-parse allocations structurally derived from one authoritative commit body. */
export function commitPreparationTransientBytes(objectBytes: number): number {
  if (!Number.isSafeInteger(objectBytes) || objectBytes < 0) {
    throw new GitError("E2BIG", "commit preparation memory accounting overflow");
  }
  const parentSlots = Math.floor(objectBytes / 48);
  const decodedSource = retainedStringUnits(objectBytes);
  const parsedCommit = 1_024 + 2 * objectBytes + parentSlots * COMMIT_PARENT_CACHE_BYTES;
  const jsonUnits = 512 + 6 * objectBytes;
  const jsonBytes = 512 + 6 * objectBytes;
  const retained = 512 + decodedSource + parsedCommit + retainedStringUnits(jsonUnits) + jsonBytes;
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "commit preparation memory accounting overflow");
  }
  return retained;
}
const COMMIT_CACHE_ENTRY: unique symbol = Symbol("CommitCacheEntry");

export interface CommitCacheSource {
  repoId: number;
  oid: string;
  data: Uint8Array;
}

export interface CommitCacheEntry {
  readonly [COMMIT_CACHE_ENTRY]: true;
  readonly repoId: number;
  readonly oid: string;
  readonly commit: Commit;
  readonly objectSize: number;
  readonly cacheBytes: number;
}

function commitCacheJsonShape(entry: CommitCacheEntry): { units: number; bytes: number } {
  const { commit } = entry;
  let units = 512 + 7 * 24;
  let bytes = units;
  const add = (value: string): void => {
    const shape = jsonStringShape(value);
    units += shape.units;
    bytes += shape.bytes;
  };
  add(entry.oid);
  add(commit.tree);
  add(commit.author.name);
  add(commit.author.email);
  add(commit.committer.name);
  add(commit.committer.email);
  add(commit.message);
  if (commit.gpgsig !== undefined) add(commit.gpgsig);
  else {
    units += 4;
    bytes += 4;
  }
  const parentJsonUnits = commit.parent.length === 0 ? 2 : 1 + 43 * commit.parent.length;
  const quotedParentJsonUnits = 2 + parentJsonUnits + 2 * commit.parent.length;
  units += quotedParentJsonUnits;
  bytes += quotedParentJsonUnits;
  if (!Number.isSafeInteger(units) || !Number.isSafeInteger(bytes)) {
    throw new GitError("E2BIG", "commit cache JSON memory accounting overflow");
  }
  return { units, bytes };
}

/** Peak JSON page allocations while prepared entries remain owned by their caller. */
export function commitCacheFlushTransientBytes(entries: Iterable<CommitCacheEntry>): number {
  let totalUnits = 2;
  let totalBytes = 2;
  let maximumEntryUnits = 0;
  let maximumEntryBytes = 0;
  let entryCount = 0;
  for (const entry of entries) {
    const shape = commitCacheJsonShape(entry);
    const separator = totalUnits === 2 ? 0 : 1;
    totalUnits += separator + shape.units;
    totalBytes += separator + shape.bytes;
    maximumEntryUnits = Math.max(maximumEntryUnits, shape.units);
    maximumEntryBytes = Math.max(maximumEntryBytes, shape.bytes);
    entryCount++;
  }
  if (entryCount === 0) return 0;
  const pageBytes = Math.min(COMMIT_BATCH_JSON_BYTES, totalBytes);
  const pageEntries = Math.min(COMMIT_BATCH_ROWS, entryCount);
  const pendingStrings = pageEntries * 48 + 2 * pageBytes;
  const joinedPage = retainedStringUnits(pageBytes);
  const currentString = retainedStringUnits(maximumEntryUnits);
  const retained =
    512 + pageEntries * 64 + pendingStrings + joinedPage + currentString + maximumEntryBytes;
  if (
    !Number.isSafeInteger(totalUnits) ||
    !Number.isSafeInteger(totalBytes) ||
    !Number.isSafeInteger(retained)
  ) {
    throw new GitError("E2BIG", "commit cache JSON memory accounting overflow");
  }
  return retained;
}

export interface CommitCacheWriteResult {
  eligible: number;
  skipped: number;
  written: number;
  statements: number;
}

function immutableCacheEntry(
  repoId: number,
  oid: string,
  commit: Commit,
  objectSize: number,
  cacheBytes: number,
): CommitCacheEntry {
  const entry: CommitCacheEntry = {
    [COMMIT_CACHE_ENTRY]: true,
    repoId,
    oid,
    commit,
    objectSize,
    cacheBytes,
  };
  return Object.freeze(entry);
}

interface CommitCacheRow {
  parents: unknown;
  tree: unknown;
  author_name: unknown;
  author_email: unknown;
  author_time: unknown;
  author_timezone: unknown;
  committer_name: unknown;
  committer_email: unknown;
  committer_time: unknown;
  committer_timezone: unknown;
  message: unknown;
  gpgsig: unknown;
  object_size: unknown;
  cache_bytes: unknown;
}

interface CommitGraphRow extends CommitCacheRow {
  kind: unknown;
  error_code: unknown;
  error: unknown;
  oid: unknown;
}

export interface CommitGraphLimits {
  /** Test seam. Production callers cannot raise the absolute ceiling. */
  maxCommits?: number;
  /** Test seam. Production callers cannot raise the retained-state ceiling. */
  maxBytes?: number;
}

const COMMIT_GRAPH_COLUMNS = `NULL AS parents, NULL AS tree,
  NULL AS author_name, NULL AS author_email, NULL AS author_time, NULL AS author_timezone,
  NULL AS committer_name, NULL AS committer_email,
  NULL AS committer_time, NULL AS committer_timezone,
  NULL AS message, NULL AS gpgsig, NULL AS object_size, NULL AS cache_bytes`;

/** One recursive graph cursor. Payload columns are projected only after every bound passes. */
export const WALK_COMMIT_GRAPH_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, count_cap, byte_cap, cache_cap, parent_cap,
         fixed_bytes, parent_bytes)
    AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?)),
  reachable(oid) AS (
    SELECT root_oid FROM params
    UNION
    SELECT parent.value
      FROM reachable r
      JOIN params p
      JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
      JOIN json_each(
        CASE WHEN typeof(c.parents) != 'text' THEN '[]'
             WHEN length(CAST(c.parents AS BLOB)) > p.parent_cap THEN '[]'
             WHEN NOT json_valid(c.parents) THEN '[]'
             WHEN json_type(c.parents) != 'array' THEN '[]'
             ELSE c.parents END
      ) parent
     WHERE NOT EXISTS (
       SELECT 1 FROM git_shallow s WHERE s.repo_id = p.repo_id AND s.oid = r.oid
     )
       AND parent.type = 'text'
       AND length(parent.value) = 40
       AND parent.value NOT GLOB '*[^0-9a-f]*'
     LIMIT (SELECT count_cap + 1 FROM params)
  ),
  metadata AS MATERIALIZED (
    SELECT r.oid,
           c.oid IS NOT NULL AS cached,
           EXISTS (
             SELECT 1 FROM git_objects o
              WHERE o.repo_id = p.repo_id AND o.oid = r.oid AND o.type = 'commit'
             UNION ALL
             SELECT 1 FROM git_pack_objects o
               JOIN git_pack_meta m ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              WHERE o.repo_id = p.repo_id AND o.oid = r.oid AND o.type = 'commit'
                AND m.state = 'complete'
           ) AS commit_source,
           c.oid IS NOT NULL
             AND length(c.oid) = 40 AND c.oid NOT GLOB '*[^0-9a-f]*'
             AND CASE WHEN typeof(c.parents) != 'text' THEN 0
                      WHEN length(CAST(c.parents AS BLOB)) > p.parent_cap THEN 0
                      WHEN NOT json_valid(c.parents) THEN 0
                      WHEN json_type(c.parents) != 'array' THEN 0 ELSE 1 END
             AND NOT EXISTS (
               SELECT 1 FROM json_each(
                 CASE WHEN typeof(c.parents) != 'text' THEN '[]'
                      WHEN length(CAST(c.parents AS BLOB)) > p.parent_cap THEN '[]'
                      WHEN NOT json_valid(c.parents) THEN '[]'
                      WHEN json_type(c.parents) != 'array' THEN '[]'
                      ELSE c.parents END
               ) parent
                WHERE parent.type != 'text' OR length(parent.value) != 40
                   OR parent.value GLOB '*[^0-9a-f]*'
             )
             AND typeof(c.tree) = 'text' AND length(c.tree) = 40
             AND c.tree NOT GLOB '*[^0-9a-f]*'
             AND typeof(c.author_name) = 'blob' AND typeof(c.author_email) = 'blob'
             AND typeof(c.committer_name) = 'blob' AND typeof(c.committer_email) = 'blob'
             AND typeof(c.message) = 'blob'
             AND (c.gpgsig IS NULL OR typeof(c.gpgsig) = 'blob')
             AND typeof(c.author_time) = 'integer'
             AND c.author_time BETWEEN -9007199254740991 AND 9007199254740991
             AND typeof(c.author_timezone) = 'integer'
             AND c.author_timezone BETWEEN -9007199254740991 AND 9007199254740991
             AND typeof(c.committer_time) = 'integer'
             AND c.committer_time BETWEEN -9007199254740991 AND 9007199254740991
             AND typeof(c.committer_timezone) = 'integer'
             AND c.committer_timezone BETWEEN -9007199254740991 AND 9007199254740991
             AND typeof(c.object_size) = 'integer'
             AND c.object_size BETWEEN 0 AND 1048576
             AND typeof(c.cache_bytes) = 'integer'
             AND c.cache_bytes BETWEEN 0 AND p.cache_cap
             AND (
               EXISTS (
                 SELECT 1 FROM git_objects o
                  WHERE o.repo_id = p.repo_id AND o.oid = r.oid
                    AND o.type = 'commit' AND o.size = c.object_size
               ) OR EXISTS (
                 SELECT 1 FROM git_pack_objects o
                   JOIN git_pack_meta m
                     ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
                  WHERE o.repo_id = p.repo_id AND o.oid = r.oid
                    AND o.type = 'commit' AND o.size = c.object_size
                    AND m.state = 'complete'
               )
             ) AS valid,
           CASE WHEN c.oid IS NULL THEN p.byte_cap + 1
                WHEN typeof(c.parents) != 'text' THEN p.byte_cap + 1
                WHEN length(CAST(c.parents AS BLOB)) > p.parent_cap THEN p.byte_cap + 1
                WHEN NOT json_valid(c.parents) THEN p.byte_cap + 1
                WHEN json_type(c.parents) != 'array' THEN p.byte_cap + 1 ELSE
             min(
               p.byte_cap + 1,
               p.fixed_bytes
               + 2 * (length(CAST(c.tree AS BLOB)) + length(CAST(c.parents AS BLOB))
                 + length(c.author_name) + length(c.author_email)
                 + length(c.committer_name) + length(c.committer_email)
                 + length(c.message) + COALESCE(length(c.gpgsig), 0))
               + p.parent_bytes * COALESCE(json_array_length(c.parents), 0)
             )
           END AS actual_bytes
      FROM reachable r
      CROSS JOIN params p
      LEFT JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
  ),
  summary AS (
    SELECT count(*) AS rows,
           COALESCE(sum(actual_bytes), 0) AS bytes,
           COALESCE(sum(CASE WHEN cached = 0 AND commit_source != 0 THEN 1 ELSE 0 END), 0)
             AS incomplete,
           COALESCE(sum(CASE WHEN cached = 0 AND commit_source = 0 THEN 1 ELSE 0 END), 0)
             AS missing,
           COALESCE(sum(CASE WHEN cached != 0 AND valid = 0 THEN 1 ELSE 0 END), 0)
             AS invalid
      FROM metadata
  ),
  verdict AS (
    SELECT CASE
      WHEN rows > p.count_cap THEN 'E2BIG'
      WHEN incomplete > 0 THEN 'E2BIG'
      WHEN missing > 0 OR invalid > 0 THEN 'ECORRUPT'
      WHEN bytes > p.byte_cap THEN 'E2BIG'
      ELSE NULL
    END AS error_code,
    CASE
      WHEN rows > p.count_cap THEN 'commit graph exceeds the 50000 commit limit'
      WHEN incomplete > 0 THEN 'commit graph cache is incomplete; reindex or reclone the repository'
      WHEN missing > 0 THEN 'commit graph references a missing commit source'
      WHEN invalid > 0 THEN 'commit graph cache is corrupt'
      WHEN bytes > p.byte_cap THEN 'commit graph exceeds the 32 MiB retained-state limit'
      ELSE NULL
    END AS error
    FROM summary CROSS JOIN params p
  )
SELECT 'error' AS kind, verdict.error_code, verdict.error, NULL AS oid,
       ${COMMIT_GRAPH_COLUMNS}
  FROM verdict WHERE verdict.error_code IS NOT NULL
UNION ALL
SELECT 'commit' AS kind, NULL AS error_code, NULL AS error, c.oid,
       c.parents, c.tree,
       c.author_name, c.author_email, c.author_time, c.author_timezone,
       c.committer_name, c.committer_email, c.committer_time, c.committer_timezone,
       c.message, c.gpgsig, c.object_size, c.cache_bytes
  FROM verdict
  CROSS JOIN params p
  CROSS JOIN reachable r
  JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
 WHERE verdict.error_code IS NULL`;

function stringsBytes(commit: Commit): number {
  let codeUnits =
    commit.tree.length +
    commit.author.name.length +
    commit.author.email.length +
    commit.committer.name.length +
    commit.committer.email.length +
    commit.message.length +
    (commit.gpgsig?.length ?? 0);
  for (const parent of commit.parent) codeUnits += parent.length;
  return codeUnits * 2;
}

/** Conservative retained-memory charge for one parsed commit. */
export function commitCacheBytes(commit: Commit): number {
  return (
    COMMIT_FIXED_CACHE_BYTES +
    stringsBytes(commit) +
    commit.parent.length * COMMIT_PARENT_CACHE_BYTES
  );
}

/** SQL-computable upper bound for the same graph row, including UTF-8 expansion. */
export function commitGraphBytes(commit: Commit): number {
  const textBytes =
    JSON_ENCODER.encode(commit.tree).byteLength +
    JSON_ENCODER.encode(JSON.stringify(commit.parent)).byteLength +
    JSON_ENCODER.encode(commit.author.name).byteLength +
    JSON_ENCODER.encode(commit.author.email).byteLength +
    JSON_ENCODER.encode(commit.committer.name).byteLength +
    JSON_ENCODER.encode(commit.committer.email).byteLength +
    JSON_ENCODER.encode(commit.message).byteLength +
    (commit.gpgsig === undefined ? 0 : JSON_ENCODER.encode(commit.gpgsig).byteLength);
  return (
    COMMIT_FIXED_CACHE_BYTES + 2 * textBytes + commit.parent.length * COMMIT_PARENT_CACHE_BYTES
  );
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string") throw new CorruptError(`commit cache has invalid ${name}`);
  return value;
}

function blobTextField(value: unknown, name: string): string {
  try {
    return utf8Decoder.decode(readBlob(value));
  } catch (error) {
    throw new CorruptError(`commit cache has invalid ${name}`, { cause: error });
  }
}

function integerField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CorruptError(`commit cache has invalid ${name}`);
  }
  return value;
}

function parentsField(value: unknown): string[] {
  if (typeof value !== "string") throw new CorruptError("commit cache has invalid parents");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new CorruptError("commit cache has invalid parents");
  }
  if (!Array.isArray(decoded)) throw new CorruptError("commit cache has invalid parents");
  const parents: string[] = [];
  for (const parent of decoded) {
    if (typeof parent !== "string" || !isOid(parent)) {
      throw new CorruptError("commit cache has invalid parents");
    }
    parents.push(parent);
  }
  return parents;
}

function immutableCommit(commit: Commit): Commit {
  Object.freeze(commit.parent);
  Object.freeze(commit.author);
  Object.freeze(commit.committer);
  return Object.freeze(commit);
}

function decodeCommitCacheRow(repoId: number, oid: string, row: CommitCacheRow): CommitCacheEntry {
  const tree = stringField(row.tree, "tree");
  if (!isOid(tree)) throw new CorruptError("commit cache has invalid tree");
  const gpgsig = row.gpgsig === null ? undefined : blobTextField(row.gpgsig, "gpgsig");
  const commit = immutableCommit({
    tree,
    parent: parentsField(row.parents),
    author: {
      name: blobTextField(row.author_name, "author name"),
      email: blobTextField(row.author_email, "author email"),
      timestamp: integerField(row.author_time, "author time"),
      timezoneOffset: integerField(row.author_timezone, "author timezone"),
    },
    committer: {
      name: blobTextField(row.committer_name, "committer name"),
      email: blobTextField(row.committer_email, "committer email"),
      timestamp: integerField(row.committer_time, "committer time"),
      timezoneOffset: integerField(row.committer_timezone, "committer timezone"),
    },
    message: blobTextField(row.message, "message"),
    ...(gpgsig === undefined ? {} : { gpgsig }),
  });
  const objectSize = integerField(row.object_size, "object size");
  if (objectSize < 0 || objectSize > MAX_INDEXED_COMMIT_BYTES) {
    throw new CorruptError("commit cache has invalid object size");
  }
  const cacheBytes = integerField(row.cache_bytes, "cache byte charge");
  if (cacheBytes !== commitCacheBytes(commit)) {
    throw new CorruptError("commit cache has invalid byte charge");
  }
  return immutableCacheEntry(repoId, oid, commit, objectSize, cacheBytes);
}

function commitGraphRowBlobBytes(row: CommitCacheRow): number {
  const blobBytes = (value: unknown, label: string): number => {
    try {
      return readBlob(value).byteLength;
    } catch (error) {
      throw new CorruptError(`commit cache has invalid ${label}`, { cause: error });
    }
  };
  let bytes =
    blobBytes(row.author_name, "author name") +
    blobBytes(row.author_email, "author email") +
    blobBytes(row.committer_name, "committer name") +
    blobBytes(row.committer_email, "committer email") +
    blobBytes(row.message, "message");
  if (row.gpgsig !== null) {
    try {
      bytes += readBlob(row.gpgsig).byteLength;
    } catch (error) {
      throw new CorruptError("commit cache has invalid gpgsig", { cause: error });
    }
  }
  if (typeof row.parents === "string") bytes += JSON_ENCODER.encode(row.parents).byteLength;
  if (typeof row.tree === "string") bytes += JSON_ENCODER.encode(row.tree).byteLength;
  return bytes;
}

function boundedLimit(value: number | undefined, ceiling: number, name: string): number {
  const selected = value ?? ceiling;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return Math.min(selected, ceiling);
}

/** Stream validated parsed commits reachable from one root without reading object payloads. */
export function* readCommitGraph(
  db: SqlDatabase,
  repoId: number,
  rootOid: string,
  limits: CommitGraphLimits = {},
): Generator<CommitCacheEntry> {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("commit graph has an invalid repository id");
  }
  if (!isOid(rootOid)) throw new CorruptError("commit graph has an invalid root oid");
  const maxCommits = boundedLimit(limits.maxCommits, MAX_LOG_COMMITS, "commit graph count limit");
  const maxBytes = boundedLimit(limits.maxBytes, MAX_LOG_STATE_BYTES, "commit graph byte limit");
  for (const value of db.iterate(
    WALK_COMMIT_GRAPH_SQL,
    repoId,
    rootOid,
    maxCommits,
    maxBytes,
    MAX_LOG_STATE_BYTES,
    MAX_INDEXED_COMMIT_BYTES,
    COMMIT_FIXED_CACHE_BYTES,
    COMMIT_PARENT_CACHE_BYTES,
  )) {
    const row: CommitGraphRow = {
      kind: value.kind,
      error_code: value.error_code,
      error: value.error,
      oid: value.oid,
      parents: value.parents,
      tree: value.tree,
      author_name: value.author_name,
      author_email: value.author_email,
      author_time: value.author_time,
      author_timezone: value.author_timezone,
      committer_name: value.committer_name,
      committer_email: value.committer_email,
      committer_time: value.committer_time,
      committer_timezone: value.committer_timezone,
      message: value.message,
      gpgsig: value.gpgsig,
      object_size: value.object_size,
      cache_bytes: value.cache_bytes,
    };
    if (row.kind === "error") {
      if (typeof row.error_code !== "string" || typeof row.error !== "string") {
        throw new CorruptError("commit graph yielded an invalid error row");
      }
      throw new GitError(row.error_code, row.error);
    }
    if (row.kind !== "commit" || typeof row.oid !== "string" || !isOid(row.oid)) {
      throw new CorruptError("commit graph yielded an invalid commit row");
    }
    yield decodeCommitCacheRow(repoId, row.oid, row);
  }
}

/** Internal graph path whose parsed rows remain charged to the supplied operation owner. */
export function* readCommitGraphOwned(
  db: SqlDatabase,
  repoId: number,
  rootOid: string,
  reservation: MemoryReservation,
  limits: CommitGraphLimits = {},
): Generator<CommitCacheEntry> {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("commit graph has an invalid repository id");
  }
  if (!isOid(rootOid)) throw new CorruptError("commit graph has an invalid root oid");
  const maxCommits = boundedLimit(limits.maxCommits, MAX_LOG_COMMITS, "commit graph count limit");
  const requestedBytes = limits.maxBytes;
  if (
    requestedBytes !== undefined &&
    (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1)
  ) {
    throw new RangeError("commit graph byte limit must be a positive safe integer");
  }
  const available = reservation.remainingBytes;
  const maxBytes = Math.min(requestedBytes ?? available, available);
  if (maxBytes < 1) {
    throw new GitError("E2BIG", "commit graph has no retained-memory capacity");
  }
  reservation.set("other", maxBytes);
  let retainedBytes = 0;
  for (const value of db.iterate(
    WALK_COMMIT_GRAPH_SQL,
    repoId,
    rootOid,
    maxCommits,
    maxBytes,
    MAX_LOG_STATE_BYTES,
    MAX_INDEXED_COMMIT_BYTES,
    COMMIT_FIXED_CACHE_BYTES,
    COMMIT_PARENT_CACHE_BYTES,
  )) {
    const row: CommitGraphRow = {
      kind: value.kind,
      error_code: value.error_code,
      error: value.error,
      oid: value.oid,
      parents: value.parents,
      tree: value.tree,
      author_name: value.author_name,
      author_email: value.author_email,
      author_time: value.author_time,
      author_timezone: value.author_timezone,
      committer_name: value.committer_name,
      committer_email: value.committer_email,
      committer_time: value.committer_time,
      committer_timezone: value.committer_timezone,
      message: value.message,
      gpgsig: value.gpgsig,
      object_size: value.object_size,
      cache_bytes: value.cache_bytes,
    };
    if (row.kind === "error") {
      if (typeof row.error_code !== "string" || typeof row.error !== "string") {
        throw new CorruptError("commit graph yielded an invalid error row");
      }
      throw new GitError(row.error_code, row.error);
    }
    if (row.kind !== "commit" || typeof row.oid !== "string" || !isOid(row.oid)) {
      throw new CorruptError("commit graph yielded an invalid commit row");
    }
    const rowBytes = commitGraphRowBlobBytes(row);
    const entry = decodeCommitCacheRow(repoId, row.oid, row);
    if (
      entry.cacheBytes > maxBytes - retainedBytes ||
      rowBytes > maxBytes - retainedBytes - entry.cacheBytes
    ) {
      throw new GitError("E2BIG", "commit graph exceeds its retained-memory capacity");
    }
    retainedBytes += entry.cacheBytes;
    yield entry;
  }
  reservation.set("other", retainedBytes);
}

function validateCommitNumbers(commit: Commit): void {
  for (const [name, value] of [
    ["author time", commit.author.timestamp],
    ["author timezone", commit.author.timezoneOffset],
    ["committer time", commit.committer.timestamp],
    ["committer timezone", commit.committer.timezoneOffset],
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new GitError("E2BIG", `commit has an unrepresentable ${name}`);
    }
  }
}

/** Build one opaque, immutable derived row or reject the source. */
export function prepareCommitCache(source: CommitCacheSource): CommitCacheEntry {
  if (!Number.isSafeInteger(source.repoId) || source.repoId < 1) {
    throw new CorruptError("commit cache source has an invalid repository id");
  }
  if (!isOid(source.oid)) throw new CorruptError("commit cache source has an invalid oid");
  if (source.data.length > MAX_INDEXED_COMMIT_BYTES) {
    throw new GitError("E2BIG", `commit ${source.oid} exceeds the 1 MiB cache limit`);
  }
  if (hashObject("commit", source.data) !== source.oid) {
    throw new CorruptError(`commit cache source ${source.oid} does not match its bytes`);
  }
  const commit = immutableCommit(parseCommit(source.data));
  validateCommitNumbers(commit);
  const entry = immutableCacheEntry(
    source.repoId,
    source.oid,
    commit,
    source.data.length,
    commitCacheBytes(commit),
  );
  if (!Number.isSafeInteger(entry.cacheBytes)) {
    throw new GitError("E2BIG", `commit ${source.oid} has an unrepresentable cache byte charge`);
  }
  if (entry.cacheBytes > MAX_COMMIT_CACHE_BYTES) {
    throw new GitError("E2BIG", `commit ${source.oid} exceeds the 4 MiB retained cache limit`);
  }
  if (serializeCommitCache(entry).bytes + 2 > COMMIT_BATCH_JSON_BYTES) {
    throw new GitError("E2BIG", `commit ${source.oid} exceeds the 1 MiB cache row limit`);
  }
  return entry;
}

interface SerializedCommitCache {
  json: string;
  bytes: number;
}

function serializeCommitCache(entry: CommitCacheEntry): SerializedCommitCache {
  const { commit } = entry;
  const json = JSON.stringify({
    r: entry.repoId,
    o: entry.oid,
    p: JSON.stringify(commit.parent),
    t: commit.tree,
    an: commit.author.name,
    ae: commit.author.email,
    at: commit.author.timestamp,
    az: commit.author.timezoneOffset,
    cn: commit.committer.name,
    ce: commit.committer.email,
    ct: commit.committer.timestamp,
    cz: commit.committer.timezoneOffset,
    m: commit.message,
    g: commit.gpgsig ?? null,
    s: entry.objectSize,
    b: entry.cacheBytes,
  });
  return { json, bytes: JSON_ENCODER.encode(json).byteLength };
}

function insertCommitCacheJson(db: SqlDatabase, json: string): number {
  let written = 0;
  for (const row of db.iterate(
    `INSERT INTO git_commits
       (repo_id, oid, parents, tree,
        author_name, author_email, author_time, author_timezone,
        committer_name, committer_email, committer_time, committer_timezone,
        message, gpgsig, object_size, cache_bytes)
     SELECT json_extract(j.value, '$.r'), json_extract(j.value, '$.o'),
            json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
            CAST(json_extract(j.value, '$.an') AS BLOB),
            CAST(json_extract(j.value, '$.ae') AS BLOB),
            json_extract(j.value, '$.at'), json_extract(j.value, '$.az'),
            CAST(json_extract(j.value, '$.cn') AS BLOB),
            CAST(json_extract(j.value, '$.ce') AS BLOB),
            json_extract(j.value, '$.ct'), json_extract(j.value, '$.cz'),
            CAST(json_extract(j.value, '$.m') AS BLOB),
            CASE WHEN json_type(j.value, '$.g') = 'null' THEN NULL
                 ELSE CAST(json_extract(j.value, '$.g') AS BLOB) END,
            json_extract(j.value, '$.s'), json_extract(j.value, '$.b')
       FROM json_each(?) j
      WHERE EXISTS (
        SELECT 1 FROM git_objects o
         WHERE o.repo_id = json_extract(j.value, '$.r')
           AND o.oid = json_extract(j.value, '$.o')
           AND o.type = 'commit'
           AND o.size = json_extract(j.value, '$.s')
        UNION ALL
        SELECT 1 FROM git_pack_objects o
          JOIN git_pack_meta m ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
         WHERE o.repo_id = json_extract(j.value, '$.r')
           AND o.oid = json_extract(j.value, '$.o')
           AND o.type = 'commit'
           AND o.size = json_extract(j.value, '$.s')
           AND m.state = 'complete'
      )
     ON CONFLICT(repo_id, oid) DO UPDATE SET
       parents = excluded.parents,
       tree = excluded.tree,
       author_name = excluded.author_name,
       author_email = excluded.author_email,
       author_time = excluded.author_time,
       author_timezone = excluded.author_timezone,
       committer_name = excluded.committer_name,
       committer_email = excluded.committer_email,
       committer_time = excluded.committer_time,
       committer_timezone = excluded.committer_timezone,
       message = excluded.message,
       gpgsig = excluded.gpgsig,
       object_size = excluded.object_size,
       cache_bytes = excluded.cache_bytes
     RETURNING repo_id, oid`,
    json,
  )) {
    if (!Number.isSafeInteger(row.repo_id) || typeof row.oid !== "string") {
      throw new CorruptError("commit cache insert returned an invalid row");
    }
    written++;
  }
  return written;
}

/** Insert derived rows in <=2,048-row, <=1 MiB JSON statements. */
export function insertCommitCaches(
  db: SqlDatabase,
  entries: Iterable<CommitCacheEntry>,
): CommitCacheWriteResult {
  let pending: string[] = [];
  let pendingBytes = 2;
  let eligible = 0;
  let written = 0;
  let statements = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    written += insertCommitCacheJson(db, `[${pending.join(",")}]`);
    pending = [];
    pendingBytes = 2;
    statements++;
  };
  for (const entry of entries) {
    if (entry[COMMIT_CACHE_ENTRY] !== true) {
      throw new CorruptError("commit cache received an unprepared entry");
    }
    const { json, bytes } = serializeCommitCache(entry);
    if (bytes + 2 > COMMIT_BATCH_JSON_BYTES) {
      throw new GitError("E2BIG", `commit ${entry.oid} exceeds the 1 MiB cache row limit`);
    }
    const separator = pending.length === 0 ? 0 : 1;
    if (
      pending.length >= COMMIT_BATCH_ROWS ||
      pendingBytes + separator + bytes > COMMIT_BATCH_JSON_BYTES
    ) {
      flush();
    }
    pending.push(json);
    pendingBytes += (pending.length === 1 ? 0 : 1) + bytes;
    eligible++;
  }
  flush();
  return { eligible, skipped: 0, written, statements };
}

/** Parse and lazily insert one commit cache row. The raw object stays authoritative. */
export function indexCommitSource(
  db: SqlDatabase,
  source: CommitCacheSource,
): CommitCacheEntry | null {
  const entry = prepareCommitCache(source);
  const result = insertCommitCaches(db, [entry]);
  return result.written === 1 ? entry : null;
}

/** Return a validated cache row only while an exact raw source still exists. */
export function readCommitCache(
  db: SqlDatabase,
  repoId: number,
  oid: string,
): CommitCacheEntry | null {
  const row = db.one<CommitCacheRow>(
    `SELECT c.parents, c.tree,
            c.author_name, c.author_email, c.author_time, c.author_timezone,
            c.committer_name, c.committer_email, c.committer_time, c.committer_timezone,
            c.message, c.gpgsig, c.object_size, c.cache_bytes
       FROM git_commits c
      WHERE c.repo_id = ? AND c.oid = ?
        AND (
          EXISTS (
            SELECT 1 FROM git_objects o
             WHERE o.repo_id = c.repo_id AND o.oid = c.oid
               AND o.type = 'commit' AND o.size = c.object_size
          ) OR EXISTS (
            SELECT 1 FROM git_pack_objects o
              JOIN git_pack_meta m ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
             WHERE o.repo_id = c.repo_id AND o.oid = c.oid
               AND o.type = 'commit' AND o.size = c.object_size
               AND m.state = 'complete'
          )
        )`,
    repoId,
    oid,
  );
  return row === undefined ? null : decodeCommitCacheRow(repoId, oid, row);
}
