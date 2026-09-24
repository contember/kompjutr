import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid, utf8Decoder } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { type Commit, hashObject, parseCommit } from "../../common/objects.js";
import { array, blob, int, nullable, RowShape, text } from "../../common/rows.js";

const JSON_ENCODER = new TextEncoder();

export const MAX_LOG_COMMITS = 50_000;
// The recursive CTE otherwise accumulates graph state proportional to history size.
export const COMMIT_GRAPH_WALK_BYTES = 64 * 1024 * 1024;
const COMMIT_BATCH_ROWS = 2048;
const COMMIT_BATCH_JSON_BYTES = 1024 * 1024;
// Durable Object SQLite refuses a value, row, or bound parameter above ~2 MB (limit 2,200,000).
export const COMMIT_ROW_MAX_BYTES = 2_000_000;
// JSON escapes at most six bytes per source byte, so smaller commits need no measurement.
const COMMIT_ROW_UNMEASURED_BYTES = Math.floor(COMMIT_ROW_MAX_BYTES / 6) - 1024;

const COMMIT_CACHE_ENTRY: unique symbol = Symbol("CommitCacheEntry");

export interface CommitCacheSource {
  repoId: number;
  oid: string;
  data: Uint8Array;
}

/** The fields every row keeps; message and signature stay in the object when the row would not fit. */
export type CommitHeaders = Omit<Commit, "message" | "gpgsig"> & {
  readonly message?: undefined;
  readonly gpgsig?: undefined;
};

interface CommitCacheEntryBase {
  readonly [COMMIT_CACHE_ENTRY]: true;
  readonly repoId: number;
  readonly oid: string;
  readonly objectSize: number;
}

export type CommitCacheEntry = CommitCacheEntryBase &
  (
    | { readonly messageStored: true; readonly commit: Commit }
    | { readonly messageStored: false; readonly commit: CommitHeaders }
  );

export interface CommitCacheWriteResult {
  written: number;
  statements: number;
}

export interface CommitCacheRow {
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
}

const COMMIT_CACHE_ROW = new RowShape(
  {
    parents: text("commit cache has invalid parents"),
    tree: text("commit cache has invalid tree"),
    author_name: blob("commit cache has invalid author name"),
    author_email: blob("commit cache has invalid author email"),
    author_time: int(undefined, undefined, "commit cache has invalid author time"),
    author_timezone: int(undefined, undefined, "commit cache has invalid author timezone"),
    committer_name: blob("commit cache has invalid committer name"),
    committer_email: blob("commit cache has invalid committer email"),
    committer_time: int(undefined, undefined, "commit cache has invalid committer time"),
    committer_timezone: int(undefined, undefined, "commit cache has invalid committer timezone"),
    message: nullable(blob("commit cache has invalid message")),
    gpgsig: nullable(blob("commit cache has invalid gpgsig")),
    object_size: int(undefined, undefined, "commit cache has invalid object size"),
  },
  "commit cache has an invalid row",
);

const COMMIT_CACHE_PARENTS = new RowShape(
  {
    parents: array(text("commit cache has invalid parents"), "commit cache has invalid parents"),
  },
  "commit cache has invalid parents",
);

function parentsField(value: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new CorruptError("commit cache has invalid parents");
  }
  return COMMIT_CACHE_PARENTS.decode({ parents: decoded }).parents;
}

function immutableCommit<T extends CommitHeaders | Commit>(commit: T): T {
  Object.freeze(commit.parent);
  Object.freeze(commit.author);
  Object.freeze(commit.committer);
  return Object.freeze(commit);
}

function headersOf(commit: Commit): CommitHeaders {
  return immutableCommit({
    tree: commit.tree,
    parent: commit.parent,
    author: commit.author,
    committer: commit.committer,
  });
}

export function decodeCommitCacheRow(
  repoId: number,
  oid: string,
  row: CommitCacheRow,
): CommitCacheEntry {
  const decoded = COMMIT_CACHE_ROW.decode(row);
  const headers: CommitHeaders = {
    tree: decoded.tree,
    parent: parentsField(decoded.parents),
    author: {
      name: utf8Decoder.decode(decoded.author_name),
      email: utf8Decoder.decode(decoded.author_email),
      timestamp: decoded.author_time,
      timezoneOffset: decoded.author_timezone,
    },
    committer: {
      name: utf8Decoder.decode(decoded.committer_name),
      email: utf8Decoder.decode(decoded.committer_email),
      timestamp: decoded.committer_time,
      timezoneOffset: decoded.committer_timezone,
    },
  };
  const base: CommitCacheEntryBase = {
    [COMMIT_CACHE_ENTRY]: true,
    repoId,
    oid,
    objectSize: decoded.object_size,
  };
  if (decoded.message === null) {
    return Object.freeze({ ...base, messageStored: false, commit: immutableCommit(headers) });
  }
  const gpgsig = decoded.gpgsig === null ? undefined : utf8Decoder.decode(decoded.gpgsig);
  const commit: Commit = {
    ...headers,
    message: utf8Decoder.decode(decoded.message),
    ...(gpgsig === undefined ? {} : { gpgsig }),
  };
  return Object.freeze({ ...base, messageStored: true, commit: immutableCommit(commit) });
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

/** Authenticate and parse one commit source into its row. */
export function prepareCommitCache(source: CommitCacheSource): CommitCacheEntry {
  const commit = parseAuthenticatedCommit(source);
  const base: CommitCacheEntryBase = {
    [COMMIT_CACHE_ENTRY]: true,
    repoId: source.repoId,
    oid: source.oid,
    objectSize: source.data.length,
  };
  const payloadUnits = commit.message.length + (commit.gpgsig?.length ?? 0);
  // Each UTF-16 unit encodes to at least one byte, so a larger payload cannot fit; skip
  // serializing it, which would briefly hold several copies of the message.
  if (payloadUnits <= COMMIT_ROW_MAX_BYTES) {
    const complete: CommitCacheEntry = Object.freeze({
      ...base,
      messageStored: true,
      commit: immutableCommit(commit),
    });
    if (source.data.length <= COMMIT_ROW_UNMEASURED_BYTES) return complete;
    if (serializeCommitCache(complete).bytes <= COMMIT_ROW_MAX_BYTES) return complete;
  }
  const headers: CommitCacheEntry = Object.freeze({
    ...base,
    messageStored: false,
    commit: headersOf(commit),
  });
  if (serializeCommitCache(headers).bytes > COMMIT_ROW_MAX_BYTES) {
    throw new GitError("E2BIG", `commit ${source.oid} headers exceed the storable row size`);
  }
  return headers;
}

/** Hash-check and parse one commit source. */
export function parseAuthenticatedCommit(source: CommitCacheSource): Commit {
  if (!Number.isSafeInteger(source.repoId) || source.repoId < 1) {
    throw new CorruptError("commit cache source has an invalid repository id");
  }
  if (!isOid(source.oid)) throw new CorruptError("commit cache source has an invalid oid");
  if (hashObject("commit", source.data) !== source.oid) {
    throw new CorruptError(`commit cache source ${source.oid} does not match its bytes`);
  }
  const commit = parseCommit(source.data);
  validateCommitNumbers(commit);
  return commit;
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
    m: commit.message ?? null,
    g: commit.gpgsig ?? null,
    s: entry.objectSize,
  });
  return { json, bytes: JSON_ENCODER.encode(json).byteLength };
}

/** The row columns projected from one `json_each(?) j` element. */
export const COMMIT_ROW_JSON_COLUMNS = `json_extract(j.value, '$.r'), json_extract(j.value, '$.o'),
  json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
  CAST(json_extract(j.value, '$.an') AS BLOB), CAST(json_extract(j.value, '$.ae') AS BLOB),
  json_extract(j.value, '$.at'), json_extract(j.value, '$.az'),
  CAST(json_extract(j.value, '$.cn') AS BLOB), CAST(json_extract(j.value, '$.ce') AS BLOB),
  json_extract(j.value, '$.ct'), json_extract(j.value, '$.cz'),
  CASE WHEN json_type(j.value, '$.m') = 'null' THEN NULL
       ELSE CAST(json_extract(j.value, '$.m') AS BLOB) END,
  CASE WHEN json_type(j.value, '$.g') = 'null' THEN NULL
       ELSE CAST(json_extract(j.value, '$.g') AS BLOB) END,
  json_extract(j.value, '$.s')`;

export const COMMIT_ROW_COLUMNS = `repo_id, oid, parents, tree,
  author_name, author_email, author_time, author_timezone,
  committer_name, committer_email, committer_time, committer_timezone,
  message, gpgsig, object_size`;

function insertCommitCacheJson(db: SqlDatabase, json: string): number {
  let written = 0;
  for (const _row of db.iterate(
    `INSERT INTO git_commits (${COMMIT_ROW_COLUMNS})
     SELECT ${COMMIT_ROW_JSON_COLUMNS}
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
       object_size = excluded.object_size
     RETURNING repo_id, oid`,
    json,
  ))
    written++;
  return written;
}

/** Insert rows in bounded JSON pages; a row above the page target goes alone. */
export function insertCommitCaches(
  db: SqlDatabase,
  entries: Iterable<CommitCacheEntry>,
): CommitCacheWriteResult {
  return writeCommitCachePages(entries, (json) => insertCommitCacheJson(db, json));
}

export function writeCommitCachePages(
  entries: Iterable<CommitCacheEntry>,
  insert: (json: string) => number,
): CommitCacheWriteResult {
  let pending: string[] = [];
  let pendingBytes = 2;
  let written = 0;
  let statements = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    written += insert(`[${pending.join(",")}]`);
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
      flush();
      written += insert(`[${json}]`);
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
  }
  flush();
  return { written, statements };
}

/** Return one trusted row by primary key. */
export function readCommitCache(
  db: SqlDatabase,
  repoId: number,
  oid: string,
): CommitCacheEntry | null {
  const row = db.one<CommitCacheRow>(
    `SELECT c.parents, c.tree,
            c.author_name, c.author_email, c.author_time, c.author_timezone,
            c.committer_name, c.committer_email, c.committer_time, c.committer_timezone,
            c.message, c.gpgsig, c.object_size
       FROM git_commits c
      WHERE c.repo_id = ? AND c.oid = ?`,
    repoId,
    oid,
  );
  return row === undefined ? null : decodeCommitCacheRow(repoId, oid, row);
}
