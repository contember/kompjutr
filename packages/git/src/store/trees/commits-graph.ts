import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { expectText } from "../../common/rows.js";
import {
  COMMIT_FIXED_CACHE_BYTES,
  COMMIT_GRAPH_WALK_BYTES,
  COMMIT_PARENT_CACHE_BYTES,
  COMMIT_SQL_ROW_FIXED_BYTES,
  type CommitCacheEntry,
  type CommitCacheRow,
  decodeCommitCacheRow,
  MAX_LOG_COMMITS,
} from "./commits-cache.js";

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
  params(repo_id, root_oid, count_cap, byte_cap, fixed_bytes, parent_bytes, shallow_json)
    AS (VALUES (?, ?, ?, ?, ?, ?, ?)),
  boundaries(oid) AS MATERIALIZED (
    SELECT value FROM params p, json_each(p.shallow_json)
    UNION ALL
    SELECT s.oid FROM git_shallow s, params p
     WHERE p.shallow_json IS NULL AND s.repo_id = p.repo_id
  ),
  reachable(oid) AS (
    SELECT root_oid FROM params
    UNION
    SELECT parent.value
      FROM reachable r
      JOIN params p
      JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
      JOIN json_each(c.parents) parent
     WHERE NOT EXISTS (
        SELECT 1 FROM boundaries s WHERE s.oid = r.oid
     )
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
           CASE WHEN c.oid IS NULL THEN p.byte_cap + 1
                ELSE
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
                ELSE
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
           COALESCE(sum(CASE WHEN cached = 0 AND commit_source != 0 THEN 1 ELSE 0 END), 0)
             AS incomplete,
           COALESCE(sum(CASE WHEN cached = 0 AND commit_source = 0 THEN 1 ELSE 0 END), 0)
             AS missing
      FROM metadata CROSS JOIN params p
  ),
  verdict AS (
    SELECT CASE
      WHEN rows > p.count_cap THEN 'E2BIG'
      WHEN missing > 0 THEN 'ECORRUPT'
      WHEN incomplete > 0 THEN 'ECACHEMISS'
      WHEN admission_bytes > p.byte_cap THEN 'E2BIG'
      ELSE NULL
    END AS error_code,
    CASE
      WHEN rows > p.count_cap THEN 'commit graph exceeds the 50000 commit limit'
      WHEN missing > 0 THEN 'commit graph references a missing commit source'
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
  shallow?: readonly string[],
): Generator<CommitCacheEntry> {
  yield* readCommitGraphOwned(db, repoId, rootOid, limits, shallow);
}

/** Internal graph path with a fixed bound on recursive state. */
export function* readCommitGraphOwned(
  db: SqlDatabase,
  repoId: number,
  rootOid: string,
  limits: CommitGraphLimits = {},
  shallow?: readonly string[],
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
  for (const value of db.iterate(
    WALK_COMMIT_GRAPH_SQL,
    repoId,
    rootOid,
    maxCommits,
    maxBytes,
    COMMIT_FIXED_CACHE_BYTES,
    COMMIT_PARENT_CACHE_BYTES,
    shallow === undefined ? null : JSON.stringify(shallow),
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
    const kind = expectText(row.kind, "commit graph row kind");
    if (kind === "error") {
      throw new GitError(
        expectText(row.error_code, "commit graph error code"),
        expectText(row.error, "commit graph error message"),
      );
    }
    if (kind === "admission") continue;
    if (kind !== "commit") {
      throw new CorruptError("commit graph yielded an invalid commit row");
    }
    const oid = expectText(row.oid, "commit graph commit oid");
    yield decodeCommitCacheRow(repoId, oid, row);
  }
}
