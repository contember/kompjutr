import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { array, expectText, RowShape, text } from "../../common/rows.js";
import {
  COMMIT_GRAPH_WALK_BYTES,
  COMMIT_ROW_MAX_BYTES,
  type CommitCacheEntry,
  type CommitCacheRow,
  decodeCommitCacheRow,
  MAX_LOG_COMMITS,
} from "./commits-cache.js";

/** Parsed-commit wrapper, map, heap, and result slots, charged per commit and per parent. */
const COMMIT_FIXED_GRAPH_BYTES = 512;
const COMMIT_PARENT_GRAPH_BYTES = 64;

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
  NULL AS message, NULL AS gpgsig, NULL AS object_size`;

const REACHABLE_COMMITS_SQL = `
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
  )`;

/**
 * One recursive graph cursor. Every commit has a row, so a reachable oid without one is
 * corruption. Retained state is charged from `object_size`, capped at the row ceiling a
 * message-less row stays under, since parsed strings take at most two bytes per source byte;
 * payload columns are projected only after every bound passes.
 */
export const WALK_COMMIT_GRAPH_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, count_cap, byte_cap, shallow_json) AS (VALUES (?, ?, ?, ?, ?)),
  ${REACHABLE_COMMITS_SQL},
  summary AS (
    SELECT count(*) AS rows,
           COALESCE(sum(c.oid IS NULL), 0) AS missing,
           COALESCE(sum(
             ${COMMIT_FIXED_GRAPH_BYTES} + 2 * min(c.object_size, ${COMMIT_ROW_MAX_BYTES})
             + ${COMMIT_PARENT_GRAPH_BYTES} * json_array_length(c.parents)
           ), 0) AS bytes
      FROM reachable r
      CROSS JOIN params p
      LEFT JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
  ),
  verdict AS (
    SELECT CASE
      WHEN rows > p.count_cap THEN 'E2BIG'
      WHEN missing > 0 THEN 'ECORRUPT'
      WHEN bytes > p.byte_cap THEN 'E2BIG'
      ELSE NULL
    END AS error_code,
    CASE
      WHEN rows > p.count_cap THEN 'commit graph exceeds the 50000 commit limit'
      WHEN missing > 0 THEN 'commit graph references a commit without a row'
      WHEN bytes > p.byte_cap THEN 'commit graph exceeds its fixed state capacity'
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
       c.message, c.gpgsig, c.object_size
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

const WALK_COMMIT_TREE_ROOTS_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, count_cap, shallow_json) AS (VALUES (?, ?, ?, ?)),
  ${REACHABLE_COMMITS_SQL},
  summary AS (
    SELECT count(*) AS rows, COALESCE(sum(c.oid IS NULL), 0) AS missing
      FROM reachable r
      CROSS JOIN params p
      LEFT JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
  ),
  verdict AS (
    SELECT CASE
      WHEN rows > p.count_cap THEN 'E2BIG'
      WHEN missing > 0 THEN 'ECORRUPT'
      ELSE NULL
    END AS error_code,
    CASE
      WHEN rows > p.count_cap THEN 'commit graph exceeds the 50000 commit limit'
      WHEN missing > 0 THEN 'commit graph references a commit without a row'
      ELSE NULL
    END AS error
    FROM summary CROSS JOIN params p
  )
SELECT 'error' AS kind, verdict.error_code, verdict.error, NULL AS oid, NULL AS tree
  FROM verdict WHERE error_code IS NOT NULL
UNION ALL
SELECT 'commit' AS kind, NULL AS error_code, NULL AS error, c.oid, c.tree
  FROM verdict
  CROSS JOIN params p
  CROSS JOIN reachable r
  JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
 WHERE verdict.error_code IS NULL`;

function requireCommitGraphRoot(repoId: number, rootOid: string): void {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("commit graph has an invalid repository id");
  }
  if (!isOid(rootOid)) throw new CorruptError("commit graph has an invalid root oid");
}

function requireCommitGraphRow(row: { kind: unknown; error_code: unknown; error: unknown }): void {
  const kind = expectText(row.kind, "commit graph row kind");
  if (kind === "error") {
    throw new GitError(
      expectText(row.error_code, "commit graph error code"),
      expectText(row.error, "commit graph error message"),
    );
  }
  if (kind !== "commit") throw new CorruptError("commit graph yielded an invalid commit row");
}

export interface CommitTreeRoot {
  oid: string;
  tree: string;
}

// Connectivity streams roots; it never retains parsed messages or author metadata.
export function* readCommitTreeRoots(
  db: SqlDatabase,
  repoId: number,
  rootOid: string,
  shallow?: readonly string[],
): Generator<CommitTreeRoot> {
  requireCommitGraphRoot(repoId, rootOid);
  for (const row of db.iterate(
    WALK_COMMIT_TREE_ROOTS_SQL,
    repoId,
    rootOid,
    MAX_LOG_COMMITS,
    shallow === undefined ? null : JSON.stringify(shallow),
  )) {
    requireCommitGraphRow({ kind: row.kind, error_code: row.error_code, error: row.error });
    yield {
      oid: expectText(row.oid, "commit graph commit oid"),
      tree: expectText(row.tree, "commit graph tree oid"),
    };
  }
}

/**
 * Commits reachable from `seeds` with their parents, stopping at shallow
 * boundaries, whose parents come back empty. Rows stream in breadth-first
 * order, so a caller may stop once it has what it needs. CROSS JOIN pins each
 * commit lookup to its primary key; otherwise the planner scans the
 * repository's commits per step.
 */
export const REACHABLE_ANCESTRY_SQL = `WITH RECURSIVE
  params(repo_id) AS (VALUES (?)),
  boundaries(oid) AS MATERIALIZED (
    SELECT s.oid FROM params p CROSS JOIN git_shallow s WHERE s.repo_id = p.repo_id
  ),
  reachable(oid, parents) AS (
    SELECT c.oid, c.parents
      FROM params p
      CROSS JOIN json_each(?) seed
      CROSS JOIN git_commits c
     WHERE c.repo_id = p.repo_id AND c.oid = seed.value
    UNION
    SELECT c.oid, c.parents
      FROM reachable r
      CROSS JOIN params p
      CROSS JOIN json_each(r.parents) parent
      CROSS JOIN git_commits c
     WHERE c.repo_id = p.repo_id AND c.oid = parent.value
       AND r.oid NOT IN (SELECT oid FROM boundaries)
  )
SELECT oid, CASE WHEN oid IN (SELECT oid FROM boundaries) THEN '[]' ELSE parents END AS parents
  FROM reachable`;

const ANCESTRY_ROW = new RowShape(
  { oid: text("commit ancestry has an invalid oid"), parents: text() },
  "commit ancestry has an invalid row",
);
const ANCESTRY_PARENTS = new RowShape(
  { parents: array(text(), "commit ancestry has invalid parents") },
  "commit ancestry has invalid parents",
);

export interface CommitAncestry {
  oid: string;
  parents: string[];
}

/** Stream the commits reachable from `seeds`; seeds without a commit row contribute nothing. */
export function* readReachableAncestry(
  db: SqlDatabase,
  repoId: number,
  seeds: readonly string[],
): Generator<CommitAncestry> {
  for (const value of db.iterate(REACHABLE_ANCESTRY_SQL, repoId, JSON.stringify(seeds))) {
    const row = ANCESTRY_ROW.decode(value);
    let parents: unknown;
    try {
      parents = JSON.parse(row.parents);
    } catch {
      throw new CorruptError("commit ancestry has invalid parents");
    }
    yield { oid: row.oid, parents: ANCESTRY_PARENTS.decode({ parents }).parents };
  }
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
  requireCommitGraphRoot(repoId, rootOid);
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
    };
    requireCommitGraphRow(row);
    const oid = expectText(row.oid, "commit graph commit oid");
    yield decodeCommitCacheRow(repoId, oid, row);
  }
}
