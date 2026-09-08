import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { int, oneOf, RowShape, text } from "../../common/rows.js";
import type {
  SparseIndexAncestorRequest,
  SparseIndexAncestorResult,
  SparseWorkspaceDirty,
  SparseWorkspaceRequest,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorkspaceSource,
  SparseWorktreeLeaf,
} from "../../store/core/contracts.js";
import type { IndexEntry } from "../../store/index.js";
import { bindSparseSource } from "../../store/sparse/receipt.js";
import { iterateIndexTrackerDirty, readIndexTrackerState } from "../indexes/index-tracker.js";
import { decodeSparseWorktreeRow, validatedSparseIndexEntry } from "./index-rows.js";
import { inputError, MAX_PATHS, validateIndexAncestorRequest, validateRequest } from "./shared.js";
import { numberField, resolveTrees } from "./tree-resolution.js";

const INDEX_SQL = `WITH wanted(ordinal, path) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
)
SELECT wanted.ordinal, entry.path, entry.stage, entry.mode, entry.oid,
       entry.size, entry.mtime, entry.ino, entry.rev
  FROM wanted
  LEFT JOIN git_index entry
    ON entry.checkout_id = ? AND entry.path = wanted.path
 ORDER BY wanted.ordinal, entry.stage`;

function readIndex(
  db: SqlDatabase,
  checkoutId: number,
  pathsJson: string,
  count: number,
): { available: boolean; rows: IndexEntry[][] } {
  const result: IndexEntry[][] = Array.from({ length: count }, () => []);
  let available = true;
  let retainedRows = 0;
  let previousOrdinal = -1;
  let previousStage = -1;
  for (const row of db.iterate(INDEX_SQL, pathsJson, checkoutId)) {
    const ordinal = numberField(row.ordinal);
    if (
      ordinal === null ||
      ordinal < previousOrdinal ||
      ordinal > previousOrdinal + 1 ||
      ordinal >= result.length
    ) {
      throw new CorruptError("sparse index lookup returned invalid request metadata");
    }
    if (ordinal !== previousOrdinal) previousStage = -1;
    previousOrdinal = ordinal;
    if (row.stage === null) continue;
    const entry = validatedSparseIndexEntry(row);
    if (entry.stage <= previousStage) {
      throw new CorruptError("sparse index lookup returned duplicate or unordered stages");
    }
    previousStage = entry.stage;
    if (retainedRows === MAX_PATHS) {
      available = false;
      continue;
    }
    result[ordinal]?.push(entry);
    retainedRows++;
  }
  if (count > 0 && previousOrdinal !== count - 1) {
    throw new CorruptError("sparse index lookup lost requested paths");
  }
  return { available, rows: result };
}

const INDEX_ANCESTOR_FACTS_SQL = `WITH wanted(ordinal, path) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
)
SELECT wanted.ordinal, wanted.path,
       EXISTS (
         SELECT 1 FROM git_index entry
          WHERE entry.checkout_id = ? AND entry.path = wanted.path
       ) AS exact,
       EXISTS (
         SELECT 1 FROM git_index entry
          WHERE entry.checkout_id = ?
            AND entry.path >= wanted.path || '/'
            AND entry.path < wanted.path || '0'
       ) AS descendant
  FROM wanted
 ORDER BY wanted.ordinal`;

const INDEX_ANCESTOR_FACT_ROW = new RowShape({
  ordinal: int(0),
  path: text(),
  exact: oneOf([0, 1]),
  descendant: oneOf([0, 1]),
});

function indexAncestorFacts(
  db: SqlDatabase,
  request: SparseIndexAncestorRequest,
): SparseIndexAncestorResult {
  const validated = validateIndexAncestorRequest(request);
  const facts: SparseIndexAncestorResult["facts"] = [];
  for (const raw of db.iterate(
    INDEX_ANCESTOR_FACTS_SQL,
    validated.json,
    validated.request.checkoutId,
    validated.request.checkoutId,
  )) {
    const row = INDEX_ANCESTOR_FACT_ROW.decode(raw);
    const expected = validated.request.ancestors[facts.length];
    if (row.ordinal !== facts.length || expected === undefined || row.path !== expected) {
      throw new CorruptError("sparse index ancestor lookup returned invalid request metadata");
    }
    facts.push({ path: row.path, exact: row.exact === 1, descendant: row.descendant === 1 });
  }
  if (facts.length !== validated.request.ancestors.length) {
    throw new CorruptError("sparse index ancestor lookup lost requested paths");
  }
  return { facts };
}

const WORKTREE_SQL = `WITH wanted(ordinal, relative) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
), absolute AS MATERIALIZED (
  SELECT ordinal, relative,
         CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END AS path
    FROM wanted
)
SELECT absolute.ordinal, paths.path, absolute.relative, paths.inode AS path_inode,
       nodes.inode, nodes.type, nodes.mode, nodes.size, nodes.mtime, nodes.rev,
       nodes.nlink, nodes.link_target AS target, nodes.content_id
  FROM absolute
  LEFT JOIN fs_paths paths ON paths.path = absolute.path
  LEFT JOIN fs_nodes nodes ON nodes.inode = paths.inode
 ORDER BY absolute.ordinal`;

function readWorktree(
  db: SqlDatabase,
  root: string,
  pathsJson: string,
  count: number,
): Array<SparseWorktreeLeaf | null> {
  const result: Array<SparseWorktreeLeaf | null> = Array.from({ length: count }, () => null);
  let returned = 0;
  for (const row of db.iterate(WORKTREE_SQL, pathsJson, root, root)) {
    const ordinal = numberField(row.ordinal);
    if (ordinal === null || ordinal !== returned || ordinal >= count) {
      throw new CorruptError("sparse worktree lookup returned invalid request metadata");
    }
    returned++;
    if (row.path === null) continue;
    result[ordinal] = decodeSparseWorktreeRow(row, root).stat;
  }
  if (returned !== count) throw new CorruptError("sparse worktree lookup lost requested paths");
  return result;
}

const CHECKOUT_ROW = new RowShape({ id: int(1), repo_id: int(1), root: text() });

function hydrate(db: SqlDatabase, request: SparseWorkspaceRequest): SparseWorkspaceResult {
  const validated = validateRequest(request);
  const rawCheckout = db.one(
    "SELECT id, repo_id, root FROM git_checkouts WHERE id = ?",
    request.checkoutId,
  );
  if (rawCheckout === undefined) {
    throw inputError("sparse workspace checkout does not exist");
  }
  const checkout = CHECKOUT_ROW.decode(rawCheckout);
  if (checkout.repo_id !== request.repoId) {
    throw inputError("sparse workspace checkout does not belong to the repository");
  }
  if (checkout.root !== request.root) {
    throw inputError("sparse workspace root does not match checkout");
  }
  if (request.paths.length === 0) return { available: true, rows: [] };

  const trees = resolveTrees(db, request, validated.segments);
  if (!trees.available) return { available: false };
  const index = readIndex(db, request.checkoutId, validated.json, request.paths.length);
  if (!index.available) return { available: false };
  const worktree = readWorktree(db, request.root, validated.json, request.paths.length);
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
      worktree: worktree[ordinal] ?? null,
    });
  }
  return { available: true, rows };
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
  return bindSparseSource(db, "workspace", {
    readState: (checkoutId) => readIndexTrackerState(db, checkoutId),
    dirtyPaths: (checkoutId) => iterateIndexTrackerDirty(db, checkoutId),
    hydrate: (request) => {
      try {
        return hydrate(db, request);
      } catch (error) {
        if (hasErrorCode(error, "E2BIG")) return { available: false };
        throw error;
      }
    },
    indexAncestorFacts: (request) => indexAncestorFacts(db, request),
  });
}
