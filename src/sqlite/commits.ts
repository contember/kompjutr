import { isOid, utf8Decoder } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { type Commit, hashObject, parseCommit } from "../core/objects.js";
import { readBlob, type SqlDatabase } from "./db.js";

const JSON_ENCODER = new TextEncoder();

/** Non-refusing target for flushing retained cache projections. */
export const COMMIT_CACHE_FLUSH_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_COMMITS = 50_000;
// The recursive CTE otherwise accumulates graph state proportional to history size.
const COMMIT_GRAPH_WALK_BYTES = 64 * 1024 * 1024;
const COMMIT_BATCH_ROWS = 2048;
const COMMIT_BATCH_JSON_BYTES = 1024 * 1024;
/** Commit wrappers plus graph map, set, heap, DFS and result slots. */
const COMMIT_FIXED_CACHE_BYTES = 512;
const COMMIT_PARENT_CACHE_BYTES = 64;
const COMMIT_SQL_ROW_FIXED_BYTES = 1_024;

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
    throw new GitError("E2BIG", "commit cache JSON size accounting overflow");
  }
  return { units, bytes };
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
  /** Optional caller-selected sub-limit within the fixed graph cap. */
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
            c.oid IS NOT NULL
              AND typeof(c.cache_bytes) = 'integer'
              AND c.cache_bytes BETWEEN 0 AND p.cache_cap AS eligible,
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
              AND c.object_size BETWEEN 0 AND 9007199254740991
             AND typeof(c.cache_bytes) = 'integer'
              AND c.cache_bytes BETWEEN 0 AND 9007199254740991
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
           END AS actual_bytes,
           CASE WHEN c.oid IS NULL THEN p.byte_cap + 1
                WHEN typeof(c.parents) != 'text' THEN p.byte_cap + 1
                WHEN length(CAST(c.parents AS BLOB)) > p.parent_cap THEN p.byte_cap + 1
                WHEN NOT json_valid(c.parents) THEN p.byte_cap + 1
                WHEN json_type(c.parents) != 'array' THEN p.byte_cap + 1 ELSE
             min(
               p.byte_cap + 1,
               ${COMMIT_SQL_ROW_FIXED_BYTES}
               + 2 * (length(CAST(c.tree AS BLOB)) + length(CAST(c.parents AS BLOB)))
               + length(c.author_name) + length(c.author_email)
               + length(c.committer_name) + length(c.committer_email)
               + length(c.message) + COALESCE(length(c.gpgsig), 0)
             )
           END AS payload_bytes
      FROM reachable r
      CROSS JOIN params p
      LEFT JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
  ),
  summary AS (
    SELECT count(*) AS rows,
           COALESCE(sum(actual_bytes), 0) AS bytes,
           min(
             p.byte_cap + 1,
             COALESCE(sum(actual_bytes), 0) + COALESCE(max(payload_bytes), 0)
           ) AS admission_bytes,
            COALESCE(sum(CASE
              WHEN cached = 0 AND commit_source != 0 THEN 1
              WHEN cached != 0 AND valid != 0 AND eligible = 0 THEN 1
              ELSE 0 END), 0)
             AS incomplete,
           COALESCE(sum(CASE WHEN cached = 0 AND commit_source = 0 THEN 1 ELSE 0 END), 0)
             AS missing,
           COALESCE(sum(CASE WHEN cached != 0 AND valid = 0 THEN 1 ELSE 0 END), 0)
             AS invalid
      FROM metadata CROSS JOIN params p
  ),
  verdict AS (
    SELECT CASE
      WHEN rows > p.count_cap THEN 'E2BIG'
      WHEN missing > 0 OR invalid > 0 THEN 'ECORRUPT'
      WHEN incomplete > 0 THEN 'ECACHEMISS'
      WHEN admission_bytes > p.byte_cap THEN 'E2BIG'
      ELSE NULL
    END AS error_code,
    CASE
      WHEN rows > p.count_cap THEN 'commit graph exceeds the 50000 commit limit'
      WHEN missing > 0 THEN 'commit graph references a missing commit source'
      WHEN invalid > 0 THEN 'commit graph cache is corrupt'
      WHEN incomplete > 0 THEN 'commit graph cache is unavailable'
      WHEN admission_bytes > p.byte_cap THEN 'commit graph exceeds its fixed state capacity'
      ELSE NULL
    END AS error,
    summary.bytes AS graph_bytes,
    summary.admission_bytes AS admission_bytes
    FROM summary CROSS JOIN params p
  )
SELECT 'error' AS kind, verdict.error_code, verdict.error, NULL AS oid,
       ${COMMIT_GRAPH_COLUMNS}
  FROM verdict WHERE verdict.error_code IS NOT NULL
UNION ALL
SELECT 'admission' AS kind, NULL AS error_code, NULL AS error, NULL AS oid,
       NULL AS parents, NULL AS tree,
       NULL AS author_name, NULL AS author_email, NULL AS author_time, NULL AS author_timezone,
       NULL AS committer_name, NULL AS committer_email,
       NULL AS committer_time, NULL AS committer_timezone,
       NULL AS message, NULL AS gpgsig,
       verdict.graph_bytes AS object_size, verdict.admission_bytes AS cache_bytes
  FROM verdict WHERE verdict.error_code IS NULL
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

/** Conservative state-size charge for one parsed commit. */
export function commitCacheBytes(commit: Commit): number {
  return (
    COMMIT_FIXED_CACHE_BYTES +
    stringsBytes(commit) +
    commit.parent.length * COMMIT_PARENT_CACHE_BYTES
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
  if (objectSize < 0) {
    throw new CorruptError("commit cache has invalid object size");
  }
  const cacheBytes = integerField(row.cache_bytes, "cache byte charge");
  if (cacheBytes !== commitCacheBytes(commit)) {
    throw new CorruptError("commit cache has invalid byte charge");
  }
  return immutableCacheEntry(repoId, oid, commit, objectSize, cacheBytes);
}

function boundedCountLimit(value: number | undefined, ceiling: number, name: string): number {
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
  yield* readCommitGraphOwned(db, repoId, rootOid, limits);
}

/** Internal graph path with a fixed bound on recursive state. */
export function* readCommitGraphOwned(
  db: SqlDatabase,
  repoId: number,
  rootOid: string,
  limits: CommitGraphLimits = {},
): Generator<CommitCacheEntry> {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("commit graph has an invalid repository id");
  }
  if (!isOid(rootOid)) throw new CorruptError("commit graph has an invalid root oid");
  const maxCommits = boundedCountLimit(
    limits.maxCommits,
    MAX_LOG_COMMITS,
    "commit graph count limit",
  );
  const requestedBytes = limits.maxBytes;
  if (
    requestedBytes !== undefined &&
    (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1)
  ) {
    throw new RangeError("commit graph byte limit must be a positive safe integer");
  }
  const maxBytes = Math.min(requestedBytes ?? COMMIT_GRAPH_WALK_BYTES, COMMIT_GRAPH_WALK_BYTES);
  let graphStateBytes = 0;
  let admittedBytes: number | undefined;
  let graphBytes: number | undefined;
  for (const value of db.iterate(
    WALK_COMMIT_GRAPH_SQL,
    repoId,
    rootOid,
    maxCommits,
    maxBytes,
    COMMIT_CACHE_FLUSH_BYTES,
    maxBytes,
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
    if (row.kind === "admission") {
      if (admittedBytes !== undefined) {
        throw new CorruptError("commit graph yielded duplicate state admission");
      }
      graphBytes = integerField(row.object_size, "graph state bytes");
      admittedBytes = integerField(row.cache_bytes, "graph state bytes");
      if (graphBytes < 0 || graphBytes > admittedBytes || admittedBytes > maxBytes) {
        throw new CorruptError("commit graph yielded invalid state admission");
      }
      continue;
    }
    if (row.kind !== "commit" || typeof row.oid !== "string" || !isOid(row.oid)) {
      throw new CorruptError("commit graph yielded an invalid commit row");
    }
    if (admittedBytes === undefined || graphBytes === undefined) {
      throw new CorruptError("commit graph payload preceded state admission");
    }
    const entry = decodeCommitCacheRow(repoId, row.oid, row);
    if (entry.cacheBytes > graphBytes - graphStateBytes) {
      throw new CorruptError("commit graph payload exceeds its admitted state");
    }
    graphStateBytes += entry.cacheBytes;
    yield entry;
  }
  if (admittedBytes === undefined || graphBytes === undefined) {
    throw new CorruptError("commit graph omitted state admission");
  }
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
  return prepareCommitCacheOwned(source);
}

/** Authenticate and parse one commit while all parser allocations are admitted. */
export function prepareCommitCacheOwned(source: CommitCacheSource): CommitCacheEntry {
  if (!Number.isSafeInteger(source.repoId) || source.repoId < 1) {
    throw new CorruptError("commit cache source has an invalid repository id");
  }
  if (!isOid(source.oid)) throw new CorruptError("commit cache source has an invalid oid");
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

/** Insert derived rows in targeted pages, using a singleton when one row exceeds the target. */
export function insertCommitCaches(
  db: SqlDatabase,
  entries: Iterable<CommitCacheEntry>,
): CommitCacheWriteResult {
  let pending: string[] = [];
  let pendingBytes = 2;
  let eligible = 0;
  let skipped = 0;
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
    const shape = commitCacheJsonShape(entry);
    if (entry.cacheBytes > COMMIT_CACHE_FLUSH_BYTES) {
      flush();
      skipped++;
      continue;
    }
    const { json, bytes } = serializeCommitCache(entry);
    if (shape.bytes + 2 > COMMIT_BATCH_JSON_BYTES) {
      flush();
      written += insertCommitCacheJson(db, `[${json}]`);
      eligible++;
      statements++;
      continue;
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
  return { eligible, skipped, written, statements };
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
