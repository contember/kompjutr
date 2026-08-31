import { readBlob, type SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SparseIndexAncestorRequest,
  SparseIndexAncestorResult,
  SparseWorkspaceDirty,
  SparseWorkspaceRequest,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorkspaceSource,
  SparseWorktreeLeaf,
} from "../contracts.js";
import type { IndexEntry } from "../index.js";
import { iterateIndexTrackerDirty, readIndexTrackerState } from "../index-tracker.js";
import { validatedSparseIndexEntry } from "./index-rows.js";
import {
  INDEX_ENTRY_RETAINED_BYTES,
  inputError,
  MAX_EXACT_INDEX_ANCESTOR_ROWS,
  MAX_EXACT_INDEX_ANCESTORS,
  MAX_INDEX_ANCESTOR_ROWS,
  SPARSE_WORKSPACE_STATE_BYTES,
  tooLarge,
  validateIndexAncestorRequest,
  validateRequest,
} from "./shared.js";
import { numberField, resolveTrees } from "./tree-resolution.js";

const INDEX_SQL = `WITH wanted(ordinal, path) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
), preflight AS MATERIALIZED (
  SELECT wanted.*,
         (SELECT count(*) FROM (
            SELECT 1 FROM git_index candidate
             WHERE candidate.checkout_id = ? AND candidate.path = wanted.path
             ORDER BY candidate.stage LIMIT 5
          )) AS bounded_count,
         (SELECT count(*) FROM git_index candidate
           WHERE candidate.checkout_id = ? AND candidate.path = wanted.path
             AND candidate.stage IN (0, 1, 2, 3)) AS valid_count
    FROM wanted
)
SELECT preflight.ordinal,
       entry.path, typeof(entry.path) AS path_type,
       length(CAST(entry.path AS BLOB)) AS path_bytes,
       entry.stage, typeof(entry.stage) AS stage_type,
       entry.mode, typeof(entry.mode) AS mode_type,
       entry.oid, typeof(entry.oid) AS oid_type,
       entry.size, entry.mtime, entry.ino, entry.rev,
       typeof(entry.size) AS size_type, typeof(entry.mtime) AS mtime_type,
       typeof(entry.ino) AS ino_type, typeof(entry.rev) AS rev_type
       , 0 AS malformed
  FROM preflight
  JOIN git_index entry ON entry.checkout_id = ? AND entry.path = preflight.path
   AND entry.stage IN (0, 1, 2, 3)
UNION ALL
SELECT ordinal, NULL, 'null', NULL, NULL, 'null', NULL, 'null', NULL, 'null',
       NULL, NULL, NULL, NULL, 'null', 'null', 'null', 'null', 1
  FROM preflight WHERE bounded_count != valid_count OR bounded_count > 4
ORDER BY ordinal, stage`;

function readIndex(
  db: SqlDatabase,
  checkoutId: number,
  pathsJson: string,
  count: number,
  retainedLimit: number,
): { available: boolean; rows: IndexEntry[][]; retainedBytes: number } {
  const result: IndexEntry[][] = Array.from({ length: count }, () => []);
  let available = true;
  let retainedBytes = 0;
  for (const row of db.iterate(INDEX_SQL, pathsJson, checkoutId, checkoutId, checkoutId)) {
    if (row.malformed === 1) {
      throw new CorruptError("sparse index lookup returned malformed stages");
    }
    const ordinal = numberField(row.ordinal);
    if (ordinal === null || ordinal < 0 || ordinal >= result.length) {
      throw new CorruptError("sparse index lookup returned a malformed row");
    }
    const entry = validatedSparseIndexEntry(row);
    const entries = result[ordinal];
    if (entries === undefined || entries.some((candidate) => candidate.stage === entry.stage)) {
      throw new CorruptError("sparse index lookup returned duplicate stages");
    }
    if (retainedBytes > retainedLimit - INDEX_ENTRY_RETAINED_BYTES) {
      available = false;
      continue;
    }
    const nextRetainedBytes = retainedBytes + INDEX_ENTRY_RETAINED_BYTES;
    retainedBytes = nextRetainedBytes;
    entries.push(entry);
  }
  return { available, rows: result, retainedBytes };
}

const INDEX_ANCESTOR_FACTS_SQL = `WITH wanted(ordinal, path) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
), index_ancestor_rows(
  ordinal, association, checkout_id, path, stage, mode, oid, size, mtime, ino, rev
) AS MATERIALIZED (
  SELECT wanted.ordinal, 0, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    JOIN git_index candidate
      ON candidate.checkout_id = ? AND candidate.path = wanted.path
  UNION ALL
  SELECT wanted.ordinal, 1, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    JOIN git_index candidate
      ON candidate.checkout_id = ?
     AND candidate.path COLLATE BINARY >= wanted.path || '/'
     AND candidate.path COLLATE BINARY < wanted.path || '0'
  UNION ALL
  SELECT wanted.ordinal, 0, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    JOIN git_index candidate
      ON candidate.checkout_id = ? AND candidate.path = CAST(wanted.path AS BLOB)
  UNION ALL
  SELECT wanted.ordinal, 1, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    JOIN git_index candidate
      ON candidate.checkout_id = ?
     AND candidate.path >= CAST(wanted.path || '/' AS BLOB)
     AND candidate.path < CAST(wanted.path || '0' AS BLOB)
  LIMIT ${MAX_INDEX_ANCESTOR_ROWS + 1}
)
SELECT wanted.ordinal, wanted.path AS wanted_path,
       typeof(wanted.path) AS wanted_path_type,
       length(CAST(wanted.path AS BLOB)) AS wanted_path_bytes,
       index_ancestor_rows.association,
       CASE WHEN index_ancestor_rows.checkout_id IS NULL THEN 0 ELSE 1 END AS row_present,
       index_ancestor_rows.path,
       typeof(index_ancestor_rows.path) AS path_type,
       length(CAST(index_ancestor_rows.path AS BLOB)) AS path_bytes,
       index_ancestor_rows.stage, typeof(index_ancestor_rows.stage) AS stage_type,
       index_ancestor_rows.mode, typeof(index_ancestor_rows.mode) AS mode_type,
       index_ancestor_rows.oid, typeof(index_ancestor_rows.oid) AS oid_type,
       index_ancestor_rows.size, index_ancestor_rows.mtime,
       index_ancestor_rows.ino, index_ancestor_rows.rev,
       typeof(index_ancestor_rows.size) AS size_type,
       typeof(index_ancestor_rows.mtime) AS mtime_type,
       typeof(index_ancestor_rows.ino) AS ino_type,
       typeof(index_ancestor_rows.rev) AS rev_type
  FROM wanted
  LEFT JOIN index_ancestor_rows ON index_ancestor_rows.ordinal = wanted.ordinal
 ORDER BY wanted.ordinal, index_ancestor_rows.association,
          index_ancestor_rows.path, index_ancestor_rows.stage`;

const EXACT_INDEX_ANCESTOR_FACTS_SQL = `WITH wanted(ordinal, path) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
), settings(checkout_id) AS (
  VALUES (?)
), exact_index_ancestor_rows(
  ordinal, association, checkout_id, path, stage, mode, oid, size, mtime, ino, rev
) AS MATERIALIZED (
  SELECT wanted.ordinal, 0, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    CROSS JOIN settings
    CROSS JOIN git_index candidate
   WHERE candidate.rowid IN (
       SELECT exact_candidate.rowid FROM git_index exact_candidate
        WHERE exact_candidate.checkout_id = settings.checkout_id
          AND exact_candidate.path = wanted.path
        ORDER BY exact_candidate.path, exact_candidate.stage LIMIT 5
     )
  UNION ALL
  SELECT wanted.ordinal, 0, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    CROSS JOIN settings
    CROSS JOIN git_index candidate
   WHERE candidate.rowid IN (
       SELECT exact_candidate.rowid FROM git_index exact_candidate
        WHERE exact_candidate.checkout_id = settings.checkout_id
          AND exact_candidate.path = CAST(wanted.path AS BLOB)
        ORDER BY exact_candidate.path, exact_candidate.stage LIMIT 1
     )
  UNION ALL
  SELECT wanted.ordinal, 1, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    CROSS JOIN settings
    CROSS JOIN git_index candidate
   WHERE candidate.rowid IN (
       SELECT descendant_candidate.rowid FROM git_index descendant_candidate
        WHERE descendant_candidate.checkout_id = settings.checkout_id
          AND descendant_candidate.path COLLATE BINARY >= wanted.path || '/'
          AND descendant_candidate.path COLLATE BINARY < wanted.path || '0'
        ORDER BY descendant_candidate.path, descendant_candidate.stage
        LIMIT ${MAX_EXACT_INDEX_ANCESTOR_ROWS + 1}
     )
  UNION ALL
  SELECT wanted.ordinal, 1, candidate.checkout_id, candidate.path, candidate.stage,
         candidate.mode, candidate.oid, candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted
    CROSS JOIN settings
    CROSS JOIN git_index candidate
   WHERE candidate.rowid IN (
       SELECT descendant_candidate.rowid FROM git_index descendant_candidate
        WHERE descendant_candidate.checkout_id = settings.checkout_id
          AND descendant_candidate.path >= CAST(wanted.path || '/' AS BLOB)
          AND descendant_candidate.path < CAST(wanted.path || '0' AS BLOB)
        ORDER BY descendant_candidate.path, descendant_candidate.stage
        LIMIT ${MAX_EXACT_INDEX_ANCESTOR_ROWS + 1}
     )
  LIMIT ${MAX_EXACT_INDEX_ANCESTOR_ROWS + 1}
)
SELECT wanted.ordinal, wanted.path AS wanted_path,
       typeof(wanted.path) AS wanted_path_type,
       length(CAST(wanted.path AS BLOB)) AS wanted_path_bytes,
       exact_index_ancestor_rows.association,
       CASE WHEN exact_index_ancestor_rows.checkout_id IS NULL THEN 0 ELSE 1 END AS row_present,
       exact_index_ancestor_rows.path,
       typeof(exact_index_ancestor_rows.path) AS path_type,
       length(CAST(exact_index_ancestor_rows.path AS BLOB)) AS path_bytes,
       exact_index_ancestor_rows.stage, typeof(exact_index_ancestor_rows.stage) AS stage_type,
       exact_index_ancestor_rows.mode, typeof(exact_index_ancestor_rows.mode) AS mode_type,
       exact_index_ancestor_rows.oid, typeof(exact_index_ancestor_rows.oid) AS oid_type,
       exact_index_ancestor_rows.size, exact_index_ancestor_rows.mtime,
       exact_index_ancestor_rows.ino, exact_index_ancestor_rows.rev,
       typeof(exact_index_ancestor_rows.size) AS size_type,
       typeof(exact_index_ancestor_rows.mtime) AS mtime_type,
       typeof(exact_index_ancestor_rows.ino) AS ino_type,
       typeof(exact_index_ancestor_rows.rev) AS rev_type
  FROM wanted
  LEFT JOIN exact_index_ancestor_rows
    ON exact_index_ancestor_rows.ordinal = wanted.ordinal
 ORDER BY wanted.ordinal, exact_index_ancestor_rows.association,
          exact_index_ancestor_rows.path, exact_index_ancestor_rows.stage`;

function indexAncestorFacts(
  db: SqlDatabase,
  request: SparseIndexAncestorRequest,
): SparseIndexAncestorResult {
  const validated = validateIndexAncestorRequest(request);
  if (validated.request.ancestors.length === 0) {
    return { facts: [] };
  }

  const facts: SparseIndexAncestorResult["facts"] = validated.request.ancestors.map((path) => ({
    path,
    exact: false,
    descendant: false,
  }));
  const exactRequest = validated.request.ancestors.length <= MAX_EXACT_INDEX_ANCESTORS;
  const query = exactRequest ? EXACT_INDEX_ANCESTOR_FACTS_SQL : INDEX_ANCESTOR_FACTS_SQL;
  const bindings = exactRequest
    ? [validated.json, validated.request.checkoutId]
    : [
        validated.json,
        validated.request.checkoutId,
        validated.request.checkoutId,
        validated.request.checkoutId,
        validated.request.checkoutId,
      ];
  const candidateLimit = exactRequest ? MAX_EXACT_INDEX_ANCESTOR_ROWS : MAX_INDEX_ANCESTOR_ROWS;
  let candidateRows = 0;
  let lastOrdinal = -1;
  let previousAssociation = -1;
  let previousPath: string | null = null;
  let previousStage = -1;
  for (const row of db.iterate(query, ...bindings)) {
    const ordinal = numberField(row.ordinal);
    const wantedPathBytes = numberField(row.wanted_path_bytes);
    const expected = ordinal === null ? undefined : validated.request.ancestors[ordinal];
    const expectedPathBytes = ordinal === null ? undefined : validated.pathBytes[ordinal];
    if (
      ordinal === null ||
      ordinal < lastOrdinal ||
      ordinal > lastOrdinal + 1 ||
      expected === undefined ||
      expectedPathBytes === undefined ||
      row.wanted_path_type !== "text" ||
      typeof row.wanted_path !== "string" ||
      row.wanted_path !== expected ||
      wantedPathBytes === null ||
      wantedPathBytes < 0 ||
      expectedPathBytes !== wantedPathBytes
    ) {
      throw new CorruptError("sparse index ancestor lookup returned a malformed row");
    }
    const present = numberField(row.row_present);
    if (present !== 0 && present !== 1) {
      throw new CorruptError("sparse index ancestor lookup returned invalid row presence");
    }
    if (ordinal !== lastOrdinal) {
      previousAssociation = -1;
      previousPath = null;
      previousStage = -1;
    }
    lastOrdinal = ordinal;
    if (present === 0) {
      if (row.association !== null || previousAssociation !== -1) {
        throw new CorruptError("sparse index ancestor lookup returned invalid cardinality");
      }
      continue;
    }

    const entry = validatedSparseIndexEntry(row);
    candidateRows++;
    if (candidateRows > candidateLimit) {
      throw tooLarge(`sparse index ancestor lookup exceeds ${candidateLimit} rows`);
    }
    const association = numberField(row.association);
    const fact = facts[ordinal];
    if (
      fact === undefined ||
      (association !== 0 && association !== 1) ||
      (association === 0 && entry.path !== expected) ||
      (association === 1 && !entry.path.startsWith(`${expected}/`)) ||
      association < previousAssociation ||
      (association === previousAssociation &&
        previousPath !== null &&
        (comparePaths(previousPath, entry.path) > 0 ||
          (previousPath === entry.path && previousStage >= entry.stage)))
    ) {
      throw new CorruptError("sparse index ancestor lookup returned an unrelated index row");
    }
    previousAssociation = association;
    previousPath = entry.path;
    previousStage = entry.stage;
    if (association === 0) fact.exact = true;
    else fact.descendant = true;
  }
  if (lastOrdinal !== validated.request.ancestors.length - 1) {
    throw new CorruptError("sparse index ancestor lookup lost requested paths");
  }
  return { facts };
}

const WORKTREE_SQL = `WITH wanted(ordinal, relative) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
), limits(payload_cap) AS (
  VALUES (?)
), absolute AS MATERIALIZED (
  SELECT ordinal, relative,
         CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END AS path
    FROM wanted
), metadata AS MATERIALIZED (
  SELECT absolute.ordinal, paths.path AS stored_path,
         CASE WHEN typeof(paths.inode) = 'integer' THEN paths.inode END AS path_inode,
         CASE WHEN typeof(nodes.inode) = 'integer' THEN nodes.inode END AS inode,
         CASE WHEN nodes.type IN ('file','dir','symlink') THEN nodes.type END AS type,
         CASE WHEN typeof(nodes.mode) = 'integer' THEN nodes.mode END AS mode,
         CASE WHEN typeof(nodes.size) = 'integer' THEN nodes.size END AS size,
         CASE WHEN typeof(nodes.mtime) = 'integer' THEN nodes.mtime END AS mtime,
         CASE WHEN typeof(nodes.rev) = 'integer' THEN nodes.rev END AS rev,
         CASE WHEN typeof(nodes.nlink) = 'integer' THEN nodes.nlink END AS nlink,
         typeof(paths.inode) AS path_inode_type, typeof(nodes.inode) AS inode_type,
         typeof(nodes.type) AS node_type, typeof(nodes.mode) AS mode_type,
         typeof(nodes.size) AS size_type, typeof(nodes.mtime) AS mtime_type,
         typeof(nodes.rev) AS rev_type, typeof(nodes.nlink) AS nlink_type,
         typeof(nodes.link_target) AS link_target_type,
         typeof(nodes.content_id) AS content_id_type,
         length(CAST(nodes.link_target AS BLOB)) AS link_target_bytes,
         length(nodes.content_id) AS content_id_bytes
    FROM absolute
    LEFT JOIN fs_paths paths ON paths.path = absolute.path
    LEFT JOIN fs_nodes nodes ON nodes.inode = paths.inode
), charged AS MATERIALIZED (
  SELECT metadata.*,
         CASE
           WHEN coalesce(link_target_bytes, 0) > limits.payload_cap / 2
                 OR coalesce(content_id_bytes, 0) > limits.payload_cap
             THEN limits.payload_cap + 1
           WHEN coalesce(link_target_bytes, 0) * 2
                  > limits.payload_cap - coalesce(content_id_bytes, 0)
             THEN limits.payload_cap + 1
           ELSE coalesce(link_target_bytes, 0) * 2 + coalesce(content_id_bytes, 0)
         END AS retained_payload_bytes
    FROM metadata
    CROSS JOIN limits
), budgeted AS MATERIALIZED (
  SELECT charged.*,
         sum(retained_payload_bytes) OVER (
           ORDER BY ordinal ROWS UNBOUNDED PRECEDING
         ) AS cumulative_retained_bytes
    FROM charged
)
SELECT budgeted.*,
       CASE WHEN budgeted.cumulative_retained_bytes <= limits.payload_cap
                 AND typeof(payload.link_target) = 'text'
            THEN payload.link_target END AS link_target,
       CASE WHEN budgeted.cumulative_retained_bytes <= limits.payload_cap
                 AND typeof(payload.content_id) = 'blob'
            THEN payload.content_id END AS content_id
  FROM budgeted
  CROSS JOIN limits
  LEFT JOIN fs_nodes payload ON payload.inode = budgeted.inode
 ORDER BY budgeted.ordinal`;

function readWorktree(
  db: SqlDatabase,
  root: string,
  pathsJson: string,
  count: number,
  retainedLimit: number,
): { available: boolean; rows: Array<SparseWorktreeLeaf | null>; retainedBytes: number } {
  const result: Array<SparseWorktreeLeaf | null> = Array.from({ length: count }, () => null);
  let returned = 0;
  let retainedBytes = 0;
  for (const row of db.iterate(WORKTREE_SQL, pathsJson, retainedLimit, root, root)) {
    returned++;
    const ordinal = numberField(row.ordinal);
    if (ordinal === null || ordinal < 0 || ordinal >= count) {
      throw new CorruptError("sparse worktree lookup returned invalid request metadata");
    }
    if (row.stored_path === null) continue;
    const inode = numberField(row.inode);
    const pathInode = numberField(row.path_inode);
    const mode = numberField(row.mode);
    const size = numberField(row.size);
    const mtime = numberField(row.mtime);
    const rev = numberField(row.rev);
    const nlink = numberField(row.nlink);
    const type = row.type;
    if (
      typeof row.stored_path !== "string" ||
      inode === null ||
      inode <= 0 ||
      pathInode !== inode ||
      row.path_inode_type !== "integer" ||
      row.inode_type !== "integer" ||
      row.node_type !== "text" ||
      row.mode_type !== "integer" ||
      row.size_type !== "integer" ||
      row.mtime_type !== "integer" ||
      row.rev_type !== "integer" ||
      row.nlink_type !== "integer" ||
      mode === null ||
      mode < 0 ||
      mode > 0o7777 ||
      size === null ||
      size < 0 ||
      mtime === null ||
      rev === null ||
      rev < 0 ||
      nlink === null ||
      nlink <= 0 ||
      (type !== "file" && type !== "dir" && type !== "symlink")
    ) {
      throw new CorruptError("sparse worktree lookup returned malformed metadata");
    }
    const targetBytes = numberField(row.link_target_bytes);
    const contentBytes = numberField(row.content_id_bytes);
    if (
      (type === "dir" && (row.link_target_type !== "null" || row.content_id_type !== "null")) ||
      (type === "file" && row.link_target_type !== "null") ||
      (type === "symlink" && row.link_target_type !== "text") ||
      (row.content_id_type !== "null" && row.content_id_type !== "blob") ||
      (row.link_target_type === "text" && targetBytes === null) ||
      (row.content_id_type === "blob" && contentBytes === null) ||
      (type === "symlink" && targetBytes !== size)
    ) {
      throw new CorruptError("sparse worktree lookup returned malformed payload metadata");
    }
    const cumulativeRetainedBytes = numberField(row.cumulative_retained_bytes);
    if (cumulativeRetainedBytes === null || cumulativeRetainedBytes > retainedLimit) {
      return { available: false, rows: result, retainedBytes };
    }
    if (type === "dir") continue;
    if (
      (type === "file" && row.link_target !== null) ||
      (type === "symlink" && typeof row.link_target !== "string")
    ) {
      throw new CorruptError("sparse worktree lookup returned malformed payload metadata");
    }
    const nextRetainedBytes = retainedBytes + (targetBytes ?? 0) * 2 + (contentBytes ?? 0);
    if (nextRetainedBytes !== cumulativeRetainedBytes) {
      return { available: false, rows: result, retainedBytes };
    }
    retainedBytes = nextRetainedBytes;
    const contentId = row.content_id === null ? null : readBlob(row.content_id);
    result[ordinal] = {
      type,
      mode,
      size,
      mtime,
      ino: inode,
      nlink,
      rev,
      target: type === "symlink" && typeof row.link_target === "string" ? row.link_target : null,
      contentId,
    };
  }
  if (returned !== count) throw new CorruptError("sparse worktree lookup lost requested paths");
  return { available: true, rows: result, retainedBytes };
}

function hydrate(db: SqlDatabase, request: SparseWorkspaceRequest): SparseWorkspaceResult {
  const retainedLimit = SPARSE_WORKSPACE_STATE_BYTES;
  const validated = validateRequest(request, retainedLimit);
  if (validated.retainedBytes < 0 || validated.retainedBytes > retainedLimit) {
    return { available: false };
  }
  const checkout = db.one<Record<string, unknown>>(
    `SELECT typeof(root) AS root_type, length(CAST(root AS BLOB)) AS root_bytes,
            root = ? AS matches, repo_id,
            EXISTS (
              SELECT 1 FROM fs_paths path
              JOIN fs_nodes node ON node.inode = path.inode
               WHERE path.path = git_checkouts.root
                 AND typeof(path.inode) = 'integer'
                 AND typeof(node.inode) = 'integer'
                 AND node.type = 'dir'
                 AND typeof(node.mode) = 'integer'
                 AND typeof(node.size) = 'integer' AND node.size = 0
                 AND typeof(node.mtime) = 'integer'
                 AND typeof(node.rev) = 'integer' AND node.rev >= 0
                 AND typeof(node.nlink) = 'integer' AND node.nlink > 0
                 AND node.link_target IS NULL AND node.content_id IS NULL
            ) AS root_valid
       FROM git_checkouts WHERE id = ? AND repo_id = ?`,
    request.root,
    request.checkoutId,
    request.repoId,
  );
  if (checkout === undefined) {
    throw inputError("sparse workspace checkout does not belong to the repository");
  }
  if (
    checkout.repo_id !== request.repoId ||
    checkout.root_type !== "text" ||
    numberField(checkout.root_bytes) === null
  ) {
    throw new CorruptError("sparse workspace checkout row is malformed");
  }
  if (checkout.matches !== 1) throw inputError("sparse workspace root does not match checkout");
  if (checkout.root_valid !== 1)
    throw new CorruptError("sparse workspace checkout root is malformed");
  if (request.paths.length === 0) {
    return { available: true, rows: [] };
  }

  const trees = resolveTrees(
    db,
    request,
    validated.segments,
    validated.retainedBytes,
    retainedLimit,
  );
  if (!trees.available) return { available: false };
  const index = readIndex(
    db,
    request.checkoutId,
    validated.json,
    request.paths.length,
    retainedLimit - validated.retainedBytes,
  );
  if (!index.available) return { available: false };
  const worktreeRetainedLimit = retainedLimit - validated.retainedBytes - index.retainedBytes;
  if (worktreeRetainedLimit < 0) return { available: false };
  const worktree = readWorktree(
    db,
    request.root,
    validated.json,
    request.paths.length,
    worktreeRetainedLimit,
  );
  if (!worktree.available) return { available: false };
  if (validated.retainedBytes + index.retainedBytes > retainedLimit - worktree.retainedBytes) {
    return { available: false };
  }

  const rows: SparseWorkspaceRow[] = [];
  for (let ordinal = 0; ordinal < request.paths.length; ordinal++) {
    const path = request.paths[ordinal];
    const indexEntries = index.rows[ordinal];
    if (path === undefined || indexEntries === undefined) {
      throw new CorruptError("sparse workspace hydration lost a requested path");
    }
    rows.push({
      path,
      baseline: trees.baseline[ordinal] ?? null,
      current: trees.current[ordinal] ?? null,
      index: indexEntries,
      worktree: worktree.rows[ordinal] ?? null,
    });
  }
  return {
    available: true,
    rows,
  };
}

/** Use the native seam without widening the public sparse source interface. */
export function sparseDirtyPathsOwned(
  source: SparseWorkspaceSource,
  checkoutId: number,
): Iterable<SparseWorkspaceDirty> {
  return source.dirtyPaths(checkoutId);
}

/** Use the native seam without widening the public sparse source interface. */
export function hydrateSparseWorkspaceOwned(
  source: SparseWorkspaceSource,
  request: SparseWorkspaceRequest,
): SparseWorkspaceResult {
  try {
    return source.hydrate(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

/** Use the native seam without widening the public sparse source interface. */
export function sparseIndexAncestorFactsOwned(
  source: SparseWorkspaceSource,
  request: SparseIndexAncestorRequest,
): SparseIndexAncestorResult {
  const result = source.indexAncestorFacts?.(request);
  if (result === undefined) {
    throw new GitError("EUNSUPPORTED", "sparse index ancestor source is unavailable");
  }
  return result;
}

export function createSqliteSparseWorkspaceSource(db: SqlDatabase): SparseWorkspaceSource {
  return {
    readState: (checkoutId) => readIndexTrackerState(db, checkoutId),
    dirtyPaths: (checkoutId) => iterateIndexTrackerDirty(db, checkoutId),
    hydrate: (request) => hydrate(db, request),
    indexAncestorFacts: (request) => indexAncestorFacts(db, request),
  };
}
