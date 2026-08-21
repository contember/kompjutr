import { isOid, utf8Decoder } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { type Commit, hashObject, parseCommit } from "../core/objects.js";
import { readBlob, type SqlDatabase } from "./db.js";

export const MAX_INDEXED_COMMIT_BYTES = 1024 * 1024;
export const MAX_COMMIT_CACHE_BYTES = 4 * 1024 * 1024;
const COMMIT_BATCH_ROWS = 2048;
const COMMIT_BATCH_JSON_BYTES = 1024 * 1024;
const COMMIT_FIXED_CACHE_BYTES = 512;
const COMMIT_PARENT_CACHE_BYTES = 64;
const JSON_ENCODER = new TextEncoder();
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
