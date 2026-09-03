import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, hasErrorCode } from "../../common/errors.js";
import { int, RowShape, text } from "../../common/rows.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSource,
  SelectedPathSpec,
  SelectedWorktreeFact,
} from "../core/contracts.js";
import type { IndexEntry } from "../index.js";
import { decodeSparseWorktreeRow, validatedSparseIndexEntry } from "./index-rows.js";
import { bindSparseSource } from "./receipt.js";
import {
  encoder,
  inputError,
  MAX_PATHS,
  MAX_SELECTED_EXACT_ANCESTORS,
  MAX_SPARSE_BINDING_BYTES,
  parseRelativePath,
  tooLarge,
  validateRoot,
} from "./shared.js";

const MAX_SELECTED_INDEX_ROWS = MAX_PATHS * 4;

export interface ValidatedSelectedPathRequest {
  request: SelectedPathRequest;
  json: string;
}

interface SelectedExactAncestors {
  json: string;
}

function selectedExactAncestors(
  validated: ValidatedSelectedPathRequest,
): SelectedExactAncestors | null {
  const unique = new Set<string>();
  let jsonBytes = 2;
  const add = (path: string): boolean => {
    if (unique.has(path)) return true;
    if (unique.size === MAX_SELECTED_EXACT_ANCESTORS) return false;
    const encoded = encoder.encode(JSON.stringify(path)).length;
    if (jsonBytes > MAX_SPARSE_BINDING_BYTES - encoded - (unique.size === 0 ? 0 : 1)) {
      return false;
    }
    jsonBytes += encoded + (unique.size === 0 ? 0 : 1);
    unique.add(path);
    return true;
  };
  const root = validated.request.root;
  for (let index = 1; index < root.length; index++) {
    if (root.charCodeAt(index) === 0x2f && !add(root.slice(0, index))) return null;
  }
  if (root !== "/" && !add(root)) return null;
  for (const spec of validated.request.specs) {
    for (let index = 1; index < spec.path.length; index++) {
      if (spec.path.charCodeAt(index) !== 0x2f) continue;
      const prefix = spec.path.slice(0, index);
      if (!add(root === "/" ? `/${prefix}` : `${root}/${prefix}`)) return null;
    }
  }
  return { json: JSON.stringify([...unique].sort(comparePaths)) };
}

export function validateSelectedPathRequest(input: unknown): ValidatedSelectedPathRequest | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw inputError("selected path request is invalid");
  }
  const repoId = Reflect.get(input, "repoId");
  const checkoutId = Reflect.get(input, "checkoutId");
  const root = Reflect.get(input, "root");
  const specsInput = Reflect.get(input, "specs");
  if (typeof repoId !== "number" || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw inputError("selected path repository id is invalid");
  }
  if (typeof checkoutId !== "number" || !Number.isSafeInteger(checkoutId) || checkoutId <= 0) {
    throw inputError("selected path checkout id is invalid");
  }
  if (typeof root !== "string") throw inputError("selected path root is invalid");
  validateRoot(root);
  if (!Array.isArray(specsInput)) throw inputError("selected path specs are invalid");
  if (specsInput.length > MAX_PATHS) {
    throw tooLarge(`selected path request exceeds ${MAX_PATHS} specs`);
  }
  const specs: SelectedPathSpec[] = [];
  const parts: string[] = [];
  let jsonBytes = 2;
  let previous: string | null = null;
  for (let ordinal = 0; ordinal < specsInput.length; ordinal++) {
    if (!Object.hasOwn(specsInput, ordinal)) throw inputError("selected path specs are not dense");
    const candidate: unknown = Reflect.get(specsInput, String(ordinal));
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw inputError("selected path spec is invalid");
    }
    const path = Reflect.get(candidate, "path");
    const recursive = Reflect.get(candidate, "recursive");
    if (typeof path !== "string" || typeof recursive !== "boolean") {
      throw inputError("selected path spec is invalid");
    }
    parseRelativePath(path);
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("selected path specs are not in strict Git order");
    }
    const part = JSON.stringify({ p: path, r: recursive ? 1 : 0 });
    jsonBytes += encoder.encode(part).length + (previous === null ? 0 : 1);
    if (!Number.isSafeInteger(jsonBytes))
      throw tooLarge("selected path request JSON size overflows");
    if (jsonBytes > MAX_SPARSE_BINDING_BYTES) return null;
    parts.push(part);
    specs.push({ path, recursive });
    previous = path;
  }
  return {
    request: { repoId, checkoutId, root, specs },
    json: `[${parts.join(",")}]`,
  };
}

const CHECKOUT_ROW = new RowShape({ id: int(1), repo_id: int(1), root: text() });

function validateSelectedCheckout(db: SqlDatabase, request: SelectedPathRequest): void {
  const raw = db.one(
    "SELECT id, repo_id, root FROM git_checkouts WHERE id = ?",
    request.checkoutId,
  );
  if (raw === undefined) throw inputError("selected path checkout does not exist");
  const row = CHECKOUT_ROW.decode(raw);
  if (row.repo_id !== request.repoId) {
    throw inputError("selected path checkout does not belong to the repository");
  }
  if (row.root !== request.root) throw inputError("selected path root does not match checkout");
}

const SELECTED_INDEX_SQL = `WITH wanted(path, recursive) AS MATERIALIZED (
  SELECT json_extract(value, '$.p'), json_extract(value, '$.r') FROM json_each(?)
)
SELECT DISTINCT candidate.path, candidate.stage, candidate.mode, candidate.oid,
       candidate.size, candidate.mtime, candidate.ino, candidate.rev
  FROM wanted
  JOIN git_index candidate
    ON candidate.checkout_id = ?
   AND (candidate.path = wanted.path
     OR (wanted.recursive = 1
       AND candidate.path >= wanted.path || '/'
       AND candidate.path < wanted.path || '0'))
 ORDER BY candidate.path, candidate.stage
 LIMIT ${MAX_SELECTED_INDEX_ROWS + 1}`;

const SELECTED_EXACT_INDEX_SQL = `WITH wanted(path) AS MATERIALIZED (
  SELECT json_extract(value, '$.p') FROM json_each(?)
)
SELECT candidate.path, candidate.stage, candidate.mode, candidate.oid,
       candidate.size, candidate.mtime, candidate.ino, candidate.rev
  FROM wanted
  JOIN git_index candidate ON candidate.checkout_id = ? AND candidate.path = wanted.path
 ORDER BY candidate.path, candidate.stage
 LIMIT ${MAX_SELECTED_INDEX_ROWS + 1}`;

export function readSelectedIndex(
  db: SqlDatabase,
  validated: ValidatedSelectedPathRequest,
  exact: boolean,
  retainEntry: (path: string) => boolean,
): { available: boolean; rows: IndexEntry[] } {
  const rows: IndexEntry[] = [];
  let previous: IndexEntry | null = null;
  let available = true;
  for (const raw of db.iterate(
    exact ? SELECTED_EXACT_INDEX_SQL : SELECTED_INDEX_SQL,
    validated.json,
    validated.request.checkoutId,
  )) {
    const entry = validatedSparseIndexEntry(raw);
    if (
      previous !== null &&
      (comparePaths(previous.path, entry.path) > 0 ||
        (previous.path === entry.path && previous.stage >= entry.stage))
    ) {
      throw new CorruptError("selected index lookup returned unordered rows");
    }
    previous = entry;
    if (!retainEntry(entry.path)) {
      available = false;
      continue;
    }
    rows.push(entry);
  }
  return { available, rows };
}

const SELECTED_WORKTREE_SQL = `WITH wanted(relative, recursive) AS MATERIALIZED (
  SELECT json_extract(value, '$.p'), json_extract(value, '$.r') FROM json_each(?)
), absolute AS MATERIALIZED (
  SELECT relative, recursive,
         CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END AS path
    FROM wanted
)
SELECT DISTINCT paths.path,
       CASE WHEN ? = '/' THEN substr(paths.path, 2)
            ELSE substr(paths.path, length(?) + 2) END AS relative,
       paths.inode AS path_inode, nodes.inode, nodes.type, nodes.mode, nodes.size,
       nodes.mtime, nodes.rev, nodes.nlink, nodes.link_target AS target,
       nodes.content_id
  FROM absolute wanted_path
  JOIN fs_paths paths
    ON paths.path = wanted_path.path
    OR (wanted_path.recursive = 1
      AND paths.path >= wanted_path.path || '/'
      AND paths.path < wanted_path.path || '0')
  JOIN fs_nodes nodes ON nodes.inode = paths.inode
 ORDER BY relative COLLATE BINARY
 LIMIT ${MAX_PATHS + 1}`;

const SELECTED_EXACT_WORKTREE_SQL = `WITH wanted(relative) AS MATERIALIZED (
  SELECT json_extract(value, '$.p') FROM json_each(?)
), absolute AS MATERIALIZED (
  SELECT relative, CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END AS path
    FROM wanted
)
SELECT paths.path, wanted.relative, paths.inode AS path_inode, nodes.inode, nodes.type,
       nodes.mode, nodes.size, nodes.mtime, nodes.rev, nodes.nlink,
       nodes.link_target AS target, nodes.content_id
  FROM absolute wanted
  JOIN fs_paths paths ON paths.path = wanted.path
  JOIN fs_nodes nodes ON nodes.inode = paths.inode
 ORDER BY wanted.relative COLLATE BINARY
 LIMIT ${MAX_PATHS + 1}`;

function hasSymlinkAncestor(
  db: SqlDatabase,
  validated: ValidatedSelectedPathRequest,
  exactAncestors: SelectedExactAncestors | null,
): boolean {
  const value =
    exactAncestors === null
      ? db.scalar<unknown>(
          `WITH wanted(relative) AS MATERIALIZED (
             SELECT json_extract(value, '$.p') FROM json_each(?)
           ), absolute(path) AS MATERIALIZED (
             SELECT CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END
               FROM wanted
           )
           SELECT EXISTS (
             SELECT 1 FROM absolute wanted
             JOIN fs_paths path
               ON length(path.path) < length(wanted.path)
              AND substr(wanted.path, 1, length(path.path) + 1) = path.path || '/'
             JOIN fs_nodes node ON node.inode = path.inode
              WHERE node.type = 'symlink'
           )`,
          validated.json,
          validated.request.root,
          validated.request.root,
        )
      : db.scalar<unknown>(
          `SELECT EXISTS (
             SELECT 1 FROM fs_paths path
             JOIN fs_nodes node ON node.inode = path.inode
            WHERE path.path IN (SELECT value FROM json_each(?)) AND node.type = 'symlink'
           )`,
          exactAncestors.json,
        );
  if (value !== 0 && value !== 1) {
    throw new CorruptError("selected worktree ancestor lookup returned malformed state");
  }
  return value === 1;
}

function readSelectedWorktree(
  db: SqlDatabase,
  validated: ValidatedSelectedPathRequest,
  retainEntry: (path: string) => boolean,
  exactAncestors: SelectedExactAncestors | null,
): { available: boolean; rows: SelectedWorktreeFact[] } {
  if (hasSymlinkAncestor(db, validated, exactAncestors)) return { available: false, rows: [] };
  const cursor =
    exactAncestors === null
      ? db.iterate(
          SELECTED_WORKTREE_SQL,
          validated.json,
          validated.request.root,
          validated.request.root,
          validated.request.root,
          validated.request.root,
        )
      : db.iterate(
          SELECTED_EXACT_WORKTREE_SQL,
          validated.json,
          validated.request.root,
          validated.request.root,
        );
  const rows: SelectedWorktreeFact[] = [];
  let previous: string | null = null;
  let available = true;
  for (const raw of cursor) {
    const entry = decodeSparseWorktreeRow(raw, validated.request.root);
    if (previous !== null && comparePaths(previous, entry.path) >= 0) {
      throw new CorruptError("selected worktree lookup returned unordered rows");
    }
    previous = entry.path;
    if (!retainEntry(entry.path)) {
      available = false;
      continue;
    }
    rows.push(entry);
  }
  return { available, rows };
}

function selectPaths(db: SqlDatabase, request: SelectedPathRequest): SelectedPathResult {
  const validated = validateSelectedPathRequest(request);
  if (validated === null) return { available: false };
  validateSelectedCheckout(db, validated.request);
  if (validated.request.specs.length === 0) {
    return { available: true, index: [], worktree: [] };
  }
  const exactAncestors = validated.request.specs.every((spec) => !spec.recursive)
    ? selectedExactAncestors(validated)
    : null;
  const retainedPaths = new Set<string>();
  const retainEntry = (path: string): boolean => {
    if (retainedPaths.has(path)) return true;
    if (retainedPaths.size === MAX_PATHS) return false;
    retainedPaths.add(path);
    return true;
  };
  const index = readSelectedIndex(db, validated, exactAncestors !== null, retainEntry);
  const worktree = readSelectedWorktree(db, validated, retainEntry, exactAncestors);
  if (!index.available || !worktree.available) return { available: false };
  return { available: true, index: index.rows, worktree: worktree.rows };
}

export function selectSparsePathsOwned(
  source: SelectedPathSource,
  request: SelectedPathRequest,
): SelectedPathResult {
  try {
    return source.select(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

export function createSqliteSelectedPathSource(db: SqlDatabase): SelectedPathSource {
  return bindSparseSource(db, "selected-paths", {
    select: (request) => selectPaths(db, request),
  });
}
