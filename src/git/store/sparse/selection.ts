import { readBlob, type SqlDatabase } from "../../../db/db.js";
import { CorruptError, hasErrorCode } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSource,
  SelectedPathSpec,
  SelectedWorktreeFact,
} from "../contracts.js";
import type { IndexEntry } from "../index.js";
import { validatedSparseIndexEntry, validStoredIndexPath } from "./index-rows.js";
import {
  encoder,
  inputError,
  jsonQuotedSize,
  MAX_PATHS,
  MAX_SELECTED_EXACT_ANCESTORS,
  MAX_SELECTED_ROWS,
  parseRelativePath,
  ROW_RETAINED_BYTES,
  SELECTED_EXACT_ARRAY_RETAINED_BYTES,
  SELECTED_EXACT_ARRAY_SLOT_BYTES,
  SELECTED_EXACT_SET_ENTRY_BYTES,
  SELECTED_EXACT_SET_RETAINED_BYTES,
  SELECTED_INDEX_RETAINED_BYTES,
  SELECTED_WORKTREE_RETAINED_BYTES,
  SPARSE_WORKSPACE_STATE_BYTES,
  tooLarge,
  validateRoot,
} from "./shared.js";
import { numberField } from "./tree-resolution.js";

export interface ValidatedSelectedPathRequest {
  request: SelectedPathRequest;
  json: string;
  retainedBytes: number;
  retainedLimit: number;
}

interface SelectedExactAncestors {
  json: string;
  retainedBytes: number;
}

interface SelectedExactAncestorBound {
  count: number;
  chars: number;
  jsonChars: number;
  jsonBytes: number;
}

interface JsonCodePointSize {
  chars: number;
  bytes: number;
  units: number;
}

function jsonCodePointSize(value: string, index: number): JsonCodePointSize {
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
    return { chars: 2, bytes: 2, units: 1 };
  }
  if (unit < 0x20) return { chars: 6, bytes: 6, units: 1 };
  if (unit < 0x80) return { chars: 1, bytes: 1, units: 1 };
  if (unit < 0x800) return { chars: 1, bytes: 2, units: 1 };
  if (unit >= 0xd800 && unit <= 0xdbff) return { chars: 2, bytes: 4, units: 2 };
  return { chars: 1, bytes: 3, units: 1 };
}

function addExactAncestorBound(
  bound: SelectedExactAncestorBound,
  chars: number,
  quotedChars: number,
  quotedBytes: number,
): boolean {
  const separator = bound.count === 0 ? 0 : 1;
  if (
    bound.count === MAX_SELECTED_EXACT_ANCESTORS ||
    chars < 1 ||
    quotedChars < 2 ||
    quotedBytes < 2 ||
    bound.chars > Number.MAX_SAFE_INTEGER - chars ||
    bound.jsonChars > Number.MAX_SAFE_INTEGER - quotedChars - separator ||
    bound.jsonBytes > Number.MAX_SAFE_INTEGER - quotedBytes - separator
  ) {
    return false;
  }
  bound.count++;
  bound.chars += chars;
  bound.jsonChars += quotedChars + separator;
  bound.jsonBytes += quotedBytes + separator;
  return true;
}

function selectedExactAncestorUpperBound(
  request: SelectedPathRequest,
  retainedHeadroom: number,
): SelectedExactAncestorBound | null {
  const bound = { count: 0, chars: 0, jsonChars: 2, jsonBytes: 2 };
  let rootJsonChars = 0;
  let rootJsonBytes = 0;
  for (let index = 0; index < request.root.length; ) {
    if (request.root.charCodeAt(index) === 0x2f) {
      if (index > 0 && !addExactAncestorBound(bound, index, rootJsonChars + 2, rootJsonBytes + 2)) {
        return null;
      }
      rootJsonChars++;
      rootJsonBytes++;
      index++;
      continue;
    }
    const encoded = jsonCodePointSize(request.root, index);
    rootJsonChars += encoded.chars;
    rootJsonBytes += encoded.bytes;
    index += encoded.units;
  }
  if (request.root !== "/") {
    if (!addExactAncestorBound(bound, request.root.length, rootJsonChars + 2, rootJsonBytes + 2)) {
      return null;
    }
  }

  const rootChars = request.root === "/" ? 0 : request.root.length;
  const rootPrefixJsonChars = request.root === "/" ? 1 : rootJsonChars + 1;
  const rootPrefixJsonBytes = request.root === "/" ? 1 : rootJsonBytes + 1;
  for (const spec of request.specs) {
    let relativeJsonChars = 0;
    let relativeJsonBytes = 0;
    for (let index = 0; index < spec.path.length; ) {
      if (spec.path.charCodeAt(index) === 0x2f) {
        if (
          !addExactAncestorBound(
            bound,
            rootChars + 1 + index,
            rootPrefixJsonChars + relativeJsonChars + 2,
            rootPrefixJsonBytes + relativeJsonBytes + 2,
          )
        ) {
          return null;
        }
        relativeJsonChars++;
        relativeJsonBytes++;
        index++;
        continue;
      }
      const encoded = jsonCodePointSize(spec.path, index);
      relativeJsonChars += encoded.chars;
      relativeJsonBytes += encoded.bytes;
      index += encoded.units;
    }
  }

  const retainedBytes =
    SELECTED_EXACT_SET_RETAINED_BYTES +
    SELECTED_EXACT_ARRAY_RETAINED_BYTES +
    bound.count * (SELECTED_EXACT_SET_ENTRY_BYTES + SELECTED_EXACT_ARRAY_SLOT_BYTES) +
    bound.chars * 2 +
    bound.jsonChars * 2;
  if (!Number.isSafeInteger(retainedBytes) || retainedBytes > retainedHeadroom) {
    return null;
  }
  return bound;
}

function selectedExactAncestors(
  validated: ValidatedSelectedPathRequest,
): SelectedExactAncestors | null {
  const retainedHeadroom = validated.retainedLimit - validated.retainedBytes;
  const bound = selectedExactAncestorUpperBound(validated.request, retainedHeadroom);
  if (bound === null) return null;

  const unique = new Set<string>();
  const root = validated.request.root;
  for (let index = 1; index < root.length; index++) {
    if (root.charCodeAt(index) === 0x2f) unique.add(root.slice(0, index));
  }
  if (root !== "/") unique.add(root);
  for (const spec of validated.request.specs) {
    for (let index = 1; index < spec.path.length; index++) {
      if (spec.path.charCodeAt(index) !== 0x2f) continue;
      const prefix = spec.path.slice(0, index);
      unique.add(root === "/" ? `/${prefix}` : `${root}/${prefix}`);
    }
  }

  const ancestors = [...unique].sort(comparePaths);
  let ancestorChars = 0;
  let jsonChars = 2 + Math.max(0, ancestors.length - 1);
  let jsonBytes = jsonChars;
  for (const ancestor of ancestors) {
    ancestorChars += ancestor.length;
    const quoted = jsonQuotedSize(ancestor);
    jsonChars += quoted.chars;
    jsonBytes += quoted.bytes;
  }
  const retainedBytes =
    SELECTED_EXACT_SET_RETAINED_BYTES +
    SELECTED_EXACT_ARRAY_RETAINED_BYTES +
    ancestors.length * (SELECTED_EXACT_SET_ENTRY_BYTES + SELECTED_EXACT_ARRAY_SLOT_BYTES) +
    ancestorChars * 2 +
    jsonChars * 2;
  if (
    !Number.isSafeInteger(jsonBytes) ||
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes > retainedHeadroom
  ) {
    return null;
  }
  return { json: JSON.stringify(ancestors), retainedBytes };
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
  const retainedLimit = SPARSE_WORKSPACE_STATE_BYTES;
  const specs: SelectedPathSpec[] = [];
  const parts: string[] = [];
  let retainedBytes = 0;
  let jsonBytes = 2;
  let jsonChars = 2;
  let previous: string | null = null;
  for (let ordinal = 0; ordinal < specsInput.length; ordinal++) {
    if (!Object.hasOwn(specsInput, ordinal)) {
      throw inputError("selected path specs are not dense");
    }
    const candidate: unknown = Reflect.get(specsInput, String(ordinal));
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw inputError("selected path spec is invalid");
    }
    const path = Reflect.get(candidate, "path");
    const recursive = Reflect.get(candidate, "recursive");
    if (typeof path !== "string" || typeof recursive !== "boolean") {
      throw inputError("selected path spec is invalid");
    }
    const parsed = parseRelativePath(path);
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("selected path specs are not in strict Git order");
    }
    const part = JSON.stringify({ p: path, r: recursive ? 1 : 0 });
    const separator = previous === null ? 0 : 1;
    jsonBytes += encoder.encode(part).length + separator;
    jsonChars += part.length + separator;
    retainedBytes += ROW_RETAINED_BYTES + path.length * 4 + parsed.bytes;
    if (!Number.isSafeInteger(jsonBytes) || !Number.isSafeInteger(jsonChars)) {
      throw tooLarge("selected path request JSON size overflows");
    }
    if (retainedBytes > retainedLimit - jsonChars * 2) return null;
    parts.push(part);
    specs.push({ path, recursive });
    previous = path;
  }
  const request: SelectedPathRequest = {
    repoId,
    checkoutId,
    root,
    specs,
  };
  const totalRetainedBytes = retainedBytes + jsonChars * 2;
  return {
    request,
    json: `[${parts.join(",")}]`,
    retainedBytes: totalRetainedBytes,
    retainedLimit,
  };
}

const SELECTED_INDEX_SQL = `WITH wanted(path, recursive) AS MATERIALIZED (
  SELECT json_extract(value, '$.p'), json_extract(value, '$.r') FROM json_each(?)
), checkout AS MATERIALIZED (
  SELECT id, repo_id, root, typeof(repo_id) AS repo_type, typeof(root) AS root_type,
         length(CAST(root AS BLOB)) AS root_bytes,
         EXISTS (
           SELECT 1 FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
            WHERE path.path = git_checkouts.root AND typeof(path.inode) = 'integer'
              AND typeof(node.inode) = 'integer' AND path.inode = node.inode
              AND node.type = 'dir' AND typeof(node.mode) = 'integer'
              AND typeof(node.size) = 'integer' AND node.size = 0
              AND typeof(node.mtime) = 'integer'
              AND typeof(node.rev) = 'integer' AND node.rev >= 0
              AND typeof(node.nlink) = 'integer' AND node.nlink > 0
              AND node.link_target IS NULL AND node.content_id IS NULL
         ) AS root_valid
    FROM git_checkouts WHERE id = ?
), candidates AS MATERIALIZED (
  SELECT DISTINCT candidate.path, candidate.stage, candidate.mode, candidate.oid,
         candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted JOIN git_index candidate
      ON candidate.checkout_id = ?
     AND (CAST(candidate.path AS BLOB) = CAST(wanted.path AS BLOB)
       OR (wanted.recursive = 1
         AND CAST(candidate.path AS BLOB) >= CAST(wanted.path || '/' AS BLOB)
         AND CAST(candidate.path AS BLOB) < CAST(wanted.path || '0' AS BLOB)))
   LIMIT ${MAX_SELECTED_ROWS + 1}
), totals AS (SELECT count(*) AS candidate_count FROM candidates)
SELECT 0 AS kind, checkout.id AS checkout_id, checkout.repo_id, checkout.root,
       checkout.repo_type, checkout.root_type, checkout.root_bytes, checkout.root_valid,
       totals.candidate_count,
       NULL AS path, 'null' AS path_type, NULL AS path_bytes,
       NULL AS stage, 'null' AS stage_type, NULL AS mode, 'null' AS mode_type,
       NULL AS oid, 'null' AS oid_type, NULL AS size, NULL AS mtime, NULL AS ino, NULL AS rev,
       'null' AS size_type, 'null' AS mtime_type, 'null' AS ino_type, 'null' AS rev_type
  FROM totals LEFT JOIN checkout ON 1 = 1
UNION ALL
SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       path, typeof(path), length(CAST(path AS BLOB)),
       stage, typeof(stage), mode, typeof(mode), oid, typeof(oid),
       size, mtime, ino, rev, typeof(size), typeof(mtime), typeof(ino), typeof(rev)
  FROM candidates
ORDER BY kind, path, stage`;

const SELECTED_EXACT_INDEX_SQL = `WITH wanted(path) AS MATERIALIZED (
  SELECT json_extract(value, '$.p') FROM json_each(?)
), wanted_keys(path, key) AS MATERIALIZED (
  SELECT path, path FROM wanted
  UNION ALL
  SELECT path, CAST(path AS BLOB) FROM wanted
), checkout AS MATERIALIZED (
  SELECT id, repo_id, root, typeof(repo_id) AS repo_type, typeof(root) AS root_type,
         length(CAST(root AS BLOB)) AS root_bytes,
         EXISTS (
           SELECT 1 FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
            WHERE path.path = git_checkouts.root AND typeof(path.inode) = 'integer'
              AND typeof(node.inode) = 'integer' AND path.inode = node.inode
              AND node.type = 'dir' AND typeof(node.mode) = 'integer'
              AND typeof(node.size) = 'integer' AND node.size = 0
              AND typeof(node.mtime) = 'integer'
              AND typeof(node.rev) = 'integer' AND node.rev >= 0
              AND typeof(node.nlink) = 'integer' AND node.nlink > 0
              AND node.link_target IS NULL AND node.content_id IS NULL
         ) AS root_valid
    FROM git_checkouts WHERE id = ?
), candidates AS MATERIALIZED (
  SELECT DISTINCT candidate.path, candidate.stage, candidate.mode, candidate.oid,
         candidate.size, candidate.mtime, candidate.ino, candidate.rev
    FROM wanted_keys wanted CROSS JOIN git_index candidate
   WHERE candidate.checkout_id = ? AND candidate.path = wanted.key
   LIMIT ${MAX_SELECTED_ROWS + 1}
), totals AS (SELECT count(*) AS candidate_count FROM candidates)
SELECT 0 AS kind, checkout.id AS checkout_id, checkout.repo_id, checkout.root,
       checkout.repo_type, checkout.root_type, checkout.root_bytes, checkout.root_valid,
       totals.candidate_count,
       NULL AS path, 'null' AS path_type, NULL AS path_bytes,
       NULL AS stage, 'null' AS stage_type, NULL AS mode, 'null' AS mode_type,
       NULL AS oid, 'null' AS oid_type, NULL AS size, NULL AS mtime, NULL AS ino, NULL AS rev,
       'null' AS size_type, 'null' AS mtime_type, 'null' AS ino_type, 'null' AS rev_type
  FROM totals LEFT JOIN checkout ON 1 = 1
UNION ALL
SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       path, typeof(path), length(CAST(path AS BLOB)),
       stage, typeof(stage), mode, typeof(mode), oid, typeof(oid),
       size, mtime, ino, rev, typeof(size), typeof(mtime), typeof(ino), typeof(rev)
  FROM candidates
ORDER BY kind, path, stage`;

const SELECTED_WORKTREE_SQL = `WITH wanted(relative, recursive) AS MATERIALIZED (
  SELECT json_extract(value, '$.p'), json_extract(value, '$.r') FROM json_each(?)
), checkout AS MATERIALIZED (
  SELECT id, repo_id, root, typeof(repo_id) AS repo_type, typeof(root) AS root_type,
         length(CAST(root AS BLOB)) AS root_bytes,
         EXISTS (
           SELECT 1 FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
            WHERE path.path = git_checkouts.root AND typeof(path.inode) = 'integer'
              AND typeof(node.inode) = 'integer' AND path.inode = node.inode
              AND node.type = 'dir' AND typeof(node.mode) = 'integer'
              AND typeof(node.size) = 'integer' AND node.size = 0
              AND typeof(node.mtime) = 'integer'
              AND typeof(node.rev) = 'integer' AND node.rev >= 0
              AND typeof(node.nlink) = 'integer' AND node.nlink > 0
              AND node.link_target IS NULL AND node.content_id IS NULL
         ) AS root_valid
    FROM git_checkouts WHERE id = ?
), absolute AS MATERIALIZED (
  SELECT relative, recursive,
         CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END AS path
    FROM wanted
), ancestor_rows AS MATERIALIZED (
  SELECT ancestor.path, ancestor.inode AS path_inode, node.inode, node.type,
         node.mode, node.size, node.mtime, node.rev, node.nlink,
         typeof(ancestor.path) AS path_type, typeof(ancestor.inode) AS path_inode_type,
         typeof(node.inode) AS inode_type, typeof(node.type) AS node_type,
         typeof(node.mode) AS mode_type, typeof(node.size) AS size_type,
         typeof(node.mtime) AS mtime_type, typeof(node.rev) AS rev_type,
         typeof(node.nlink) AS nlink_type, typeof(node.link_target) AS target_type,
         typeof(node.content_id) AS content_type,
         length(CAST(node.link_target AS BLOB)) AS target_bytes
    FROM absolute wanted_path
    JOIN fs_paths ancestor
      ON length(ancestor.path) < length(wanted_path.path)
     AND substr(wanted_path.path, 1, length(ancestor.path) + 1) = ancestor.path || '/'
    LEFT JOIN fs_nodes node ON node.inode = ancestor.inode
), ancestor_summary AS MATERIALIZED (
  SELECT coalesce(sum(CASE WHEN type = 'symlink' THEN 1 ELSE 0 END), 0) AS symlinks,
         coalesce(sum(CASE
           WHEN path_type <> 'text' OR path_inode_type <> 'integer'
             OR inode_type <> 'integer' OR path_inode <> inode
             OR node_type <> 'text' OR type NOT IN ('dir','symlink')
             OR mode_type <> 'integer' OR mode < 0 OR mode > 4095
             OR size_type <> 'integer' OR size < 0
             OR mtime_type <> 'integer'
             OR rev_type <> 'integer' OR rev < 0
             OR nlink_type <> 'integer' OR nlink <= 0
             OR (type = 'dir' AND (size <> 0 OR target_type <> 'null' OR content_type <> 'null'))
             OR (type = 'symlink' AND (target_type <> 'text' OR target_bytes <> size
                                       OR content_type <> 'null'))
           THEN 1 ELSE 0 END), 0) AS invalid
    FROM ancestor_rows
), candidates AS MATERIALIZED (
  SELECT DISTINCT paths.path, paths.inode AS path_inode,
         CASE WHEN ? = '/' THEN substr(paths.path, 2)
              ELSE substr(paths.path, length(?) + 2) END AS relative
    FROM absolute wanted_path JOIN fs_paths paths
      ON CAST(paths.path AS BLOB) = CAST(wanted_path.path AS BLOB)
      OR (wanted_path.recursive = 1
        AND CAST(paths.path AS BLOB) >= CAST(wanted_path.path || '/' AS BLOB)
        AND CAST(paths.path AS BLOB) < CAST(wanted_path.path || '0' AS BLOB))
   LIMIT ${MAX_SELECTED_ROWS + 1}
), totals AS (SELECT count(*) AS candidate_count FROM candidates), metadata AS MATERIALIZED (
  SELECT candidates.*, nodes.inode, nodes.type, nodes.mode, nodes.size, nodes.mtime,
         nodes.rev, nodes.nlink,
         typeof(candidates.path) AS path_type, length(CAST(candidates.path AS BLOB)) AS path_bytes,
         typeof(candidates.path_inode) AS path_inode_type, typeof(nodes.inode) AS inode_type,
         typeof(nodes.type) AS node_type, typeof(nodes.mode) AS mode_type,
         typeof(nodes.size) AS size_type, typeof(nodes.mtime) AS mtime_type,
         typeof(nodes.rev) AS rev_type, typeof(nodes.nlink) AS nlink_type,
         typeof(nodes.link_target) AS target_type, typeof(nodes.content_id) AS content_type,
         length(CAST(nodes.link_target AS BLOB)) AS target_bytes,
         length(nodes.content_id) AS content_bytes
    FROM candidates LEFT JOIN fs_nodes nodes ON nodes.inode = candidates.path_inode
), charged AS MATERIALIZED (
  SELECT metadata.*,
         coalesce(target_bytes, 0) * 2 + coalesce(content_bytes, 0) AS payload_bytes,
         sum(coalesce(target_bytes, 0) * 2 + coalesce(content_bytes, 0)) OVER (
           ORDER BY path COLLATE BINARY ROWS UNBOUNDED PRECEDING
         ) AS cumulative_payload_bytes
    FROM metadata
)
SELECT 0 AS kind, checkout.id AS checkout_id, checkout.repo_id, checkout.root,
       checkout.repo_type, checkout.root_type, checkout.root_bytes, checkout.root_valid,
       totals.candidate_count, ancestor_summary.symlinks AS symlink_ancestors,
       ancestor_summary.invalid AS invalid_ancestors,
       NULL AS path, NULL AS relative, NULL AS path_inode, NULL AS inode,
       NULL AS type, NULL AS mode,
       NULL AS size, NULL AS mtime, NULL AS rev, NULL AS nlink,
       NULL AS path_type, NULL AS path_bytes, NULL AS path_inode_type, NULL AS inode_type,
       NULL AS node_type, NULL AS mode_type, NULL AS size_type, NULL AS mtime_type,
       NULL AS rev_type, NULL AS nlink_type, NULL AS target_type, NULL AS content_type,
       NULL AS target_bytes, NULL AS content_bytes, NULL AS payload_bytes,
       NULL AS cumulative_payload_bytes, NULL AS target, NULL AS content_id
  FROM totals CROSS JOIN ancestor_summary LEFT JOIN checkout ON 1 = 1
UNION ALL
SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       charged.path, charged.relative, charged.path_inode, charged.inode,
       charged.type, charged.mode,
       charged.size, charged.mtime, charged.rev, charged.nlink,
       charged.path_type, charged.path_bytes, charged.path_inode_type, charged.inode_type,
       charged.node_type, charged.mode_type, charged.size_type, charged.mtime_type,
       charged.rev_type, charged.nlink_type, charged.target_type, charged.content_type,
       charged.target_bytes, charged.content_bytes, charged.payload_bytes,
       charged.cumulative_payload_bytes,
       CASE WHEN charged.cumulative_payload_bytes <= ? THEN payload.link_target END,
       CASE WHEN charged.cumulative_payload_bytes <= ? THEN payload.content_id END
  FROM charged LEFT JOIN fs_nodes payload ON payload.inode = charged.inode
ORDER BY kind, path COLLATE BINARY`;

const SELECTED_EXACT_WORKTREE_SQL = `WITH wanted(relative) AS MATERIALIZED (
  SELECT json_extract(value, '$.p') FROM json_each(?)
), checkout AS MATERIALIZED (
  SELECT id, repo_id, root, typeof(repo_id) AS repo_type, typeof(root) AS root_type,
         length(CAST(root AS BLOB)) AS root_bytes,
         EXISTS (
           SELECT 1 FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
            WHERE path.path = git_checkouts.root AND typeof(path.inode) = 'integer'
              AND typeof(node.inode) = 'integer' AND path.inode = node.inode
              AND node.type = 'dir' AND typeof(node.mode) = 'integer'
              AND typeof(node.size) = 'integer' AND node.size = 0
              AND typeof(node.mtime) = 'integer'
              AND typeof(node.rev) = 'integer' AND node.rev >= 0
              AND typeof(node.nlink) = 'integer' AND node.nlink > 0
              AND node.link_target IS NULL AND node.content_id IS NULL
         ) AS root_valid
    FROM git_checkouts WHERE id = ?
), absolute AS MATERIALIZED (
  SELECT relative,
         CASE WHEN ? = '/' THEN '/' || relative ELSE ? || '/' || relative END AS path
    FROM wanted
), absolute_keys(relative, path, key) AS MATERIALIZED (
  SELECT relative, path, path FROM absolute
  UNION ALL
  SELECT relative, path, CAST(path AS BLOB) FROM absolute
), wanted_ancestors(path) AS MATERIALIZED (
  SELECT value FROM json_each(?)
), wanted_ancestor_keys(path, key) AS MATERIALIZED (
  SELECT path, path FROM wanted_ancestors
  UNION ALL
  SELECT path, CAST(path AS BLOB) FROM wanted_ancestors
), ancestor_rows AS MATERIALIZED (
  SELECT ancestor.path, ancestor.inode AS path_inode, node.inode, node.type,
         node.mode, node.size, node.mtime, node.rev, node.nlink,
         typeof(ancestor.path) AS path_type, typeof(ancestor.inode) AS path_inode_type,
         typeof(node.inode) AS inode_type, typeof(node.type) AS node_type,
         typeof(node.mode) AS mode_type, typeof(node.size) AS size_type,
         typeof(node.mtime) AS mtime_type, typeof(node.rev) AS rev_type,
         typeof(node.nlink) AS nlink_type, typeof(node.link_target) AS target_type,
         typeof(node.content_id) AS content_type,
         length(CAST(node.link_target AS BLOB)) AS target_bytes
    FROM wanted_ancestor_keys wanted
    CROSS JOIN fs_paths ancestor
    LEFT JOIN fs_nodes node ON node.inode = ancestor.inode
   WHERE ancestor.path = wanted.key
), ancestor_summary AS MATERIALIZED (
  SELECT coalesce(sum(CASE WHEN type = 'symlink' THEN 1 ELSE 0 END), 0) AS symlinks,
         coalesce(sum(CASE
           WHEN path_type <> 'text' OR path_inode_type <> 'integer'
             OR inode_type <> 'integer' OR path_inode <> inode
             OR node_type <> 'text' OR type NOT IN ('dir','symlink')
             OR mode_type <> 'integer' OR mode < 0 OR mode > 4095
             OR size_type <> 'integer' OR size < 0
             OR mtime_type <> 'integer'
             OR rev_type <> 'integer' OR rev < 0
             OR nlink_type <> 'integer' OR nlink <= 0
             OR (type = 'dir' AND (size <> 0 OR target_type <> 'null' OR content_type <> 'null'))
             OR (type = 'symlink' AND (target_type <> 'text' OR target_bytes <> size
                                       OR content_type <> 'null'))
           THEN 1 ELSE 0 END), 0) AS invalid
    FROM ancestor_rows
), candidates AS MATERIALIZED (
  SELECT DISTINCT paths.path, paths.inode AS path_inode, wanted_path.relative
    FROM absolute_keys wanted_path CROSS JOIN fs_paths paths
   WHERE paths.path = wanted_path.key
   LIMIT ${MAX_SELECTED_ROWS + 1}
), totals AS (SELECT count(*) AS candidate_count FROM candidates), metadata AS MATERIALIZED (
  SELECT candidates.*, nodes.inode, nodes.type, nodes.mode, nodes.size, nodes.mtime,
         nodes.rev, nodes.nlink,
         typeof(candidates.path) AS path_type, length(CAST(candidates.path AS BLOB)) AS path_bytes,
         typeof(candidates.path_inode) AS path_inode_type, typeof(nodes.inode) AS inode_type,
         typeof(nodes.type) AS node_type, typeof(nodes.mode) AS mode_type,
         typeof(nodes.size) AS size_type, typeof(nodes.mtime) AS mtime_type,
         typeof(nodes.rev) AS rev_type, typeof(nodes.nlink) AS nlink_type,
         typeof(nodes.link_target) AS target_type, typeof(nodes.content_id) AS content_type,
         length(CAST(nodes.link_target AS BLOB)) AS target_bytes,
         length(nodes.content_id) AS content_bytes
    FROM candidates LEFT JOIN fs_nodes nodes ON nodes.inode = candidates.path_inode
), charged AS MATERIALIZED (
  SELECT metadata.*,
         coalesce(target_bytes, 0) * 2 + coalesce(content_bytes, 0) AS payload_bytes,
         sum(coalesce(target_bytes, 0) * 2 + coalesce(content_bytes, 0)) OVER (
           ORDER BY path COLLATE BINARY ROWS UNBOUNDED PRECEDING
         ) AS cumulative_payload_bytes
    FROM metadata
)
SELECT 0 AS kind, checkout.id AS checkout_id, checkout.repo_id, checkout.root,
       checkout.repo_type, checkout.root_type, checkout.root_bytes, checkout.root_valid,
       totals.candidate_count, ancestor_summary.symlinks AS symlink_ancestors,
       ancestor_summary.invalid AS invalid_ancestors,
       NULL AS path, NULL AS relative, NULL AS path_inode, NULL AS inode,
       NULL AS type, NULL AS mode,
       NULL AS size, NULL AS mtime, NULL AS rev, NULL AS nlink,
       NULL AS path_type, NULL AS path_bytes, NULL AS path_inode_type, NULL AS inode_type,
       NULL AS node_type, NULL AS mode_type, NULL AS size_type, NULL AS mtime_type,
       NULL AS rev_type, NULL AS nlink_type, NULL AS target_type, NULL AS content_type,
       NULL AS target_bytes, NULL AS content_bytes, NULL AS payload_bytes,
       NULL AS cumulative_payload_bytes, NULL AS target, NULL AS content_id
  FROM totals CROSS JOIN ancestor_summary LEFT JOIN checkout ON 1 = 1
UNION ALL
SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       charged.path, charged.relative, charged.path_inode, charged.inode,
       charged.type, charged.mode,
       charged.size, charged.mtime, charged.rev, charged.nlink,
       charged.path_type, charged.path_bytes, charged.path_inode_type, charged.inode_type,
       charged.node_type, charged.mode_type, charged.size_type, charged.mtime_type,
       charged.rev_type, charged.nlink_type, charged.target_type, charged.content_type,
       charged.target_bytes, charged.content_bytes, charged.payload_bytes,
       charged.cumulative_payload_bytes,
       CASE WHEN charged.cumulative_payload_bytes <= ? THEN payload.link_target END,
       CASE WHEN charged.cumulative_payload_bytes <= ? THEN payload.content_id END
  FROM charged LEFT JOIN fs_nodes payload ON payload.inode = charged.inode
ORDER BY kind, path COLLATE BINARY`;

function validateSelectedCheckout(
  row: Record<string, unknown>,
  request: SelectedPathRequest,
): void {
  if (row.checkout_id === null) {
    throw inputError("selected path checkout does not exist");
  }
  const rootBytes = numberField(row.root_bytes);
  if (
    row.checkout_id !== request.checkoutId ||
    row.repo_type !== "integer" ||
    row.repo_id !== request.repoId ||
    row.root_type !== "text" ||
    row.root !== request.root ||
    rootBytes === null ||
    rootBytes < 1
  ) {
    throw new CorruptError("selected path checkout row is malformed or mismatched");
  }
  if (row.root_valid !== 1) {
    throw new CorruptError("selected path checkout root is malformed");
  }
}

export function readSelectedIndex(
  db: SqlDatabase,
  validated: ValidatedSelectedPathRequest,
  retainedHeadroom: number,
  exact: boolean,
  retainEntry?: () => boolean,
): { available: boolean; rows: IndexEntry[]; retainedBytes: number } {
  const rows: IndexEntry[] = [];
  let metadata = false;
  let available = true;
  let retainedBytes = 0;
  let previous: IndexEntry | null = null;
  for (const row of db.iterate(
    exact ? SELECTED_EXACT_INDEX_SQL : SELECTED_INDEX_SQL,
    validated.json,
    validated.request.checkoutId,
    validated.request.checkoutId,
  )) {
    if (row.kind === 0) {
      if (metadata) throw new CorruptError("selected index lookup duplicated metadata");
      metadata = true;
      validateSelectedCheckout(row, validated.request);
      const count = numberField(row.candidate_count);
      if (count === null || count < 0) {
        throw new CorruptError("selected index lookup returned invalid cardinality");
      }
      if (count > MAX_SELECTED_ROWS) available = false;
      continue;
    }
    if (row.kind !== 1 || !metadata) {
      throw new CorruptError("selected index lookup returned invalid row ordering");
    }
    const entry = validatedSparseIndexEntry(row);
    if (
      previous !== null &&
      (comparePaths(previous.path, entry.path) > 0 ||
        (previous.path === entry.path && previous.stage >= entry.stage))
    ) {
      throw new CorruptError("selected index lookup returned unordered rows");
    }
    previous = entry;
    if (retainedBytes > retainedHeadroom - SELECTED_INDEX_RETAINED_BYTES) {
      available = false;
      continue;
    }
    if (retainEntry !== undefined && !retainEntry()) {
      available = false;
      continue;
    }
    const nextRetainedBytes = retainedBytes + SELECTED_INDEX_RETAINED_BYTES;
    retainedBytes = nextRetainedBytes;
    rows.push(entry);
  }
  if (!metadata) throw new CorruptError("selected index lookup lost metadata");
  return { available, rows, retainedBytes };
}

function readSelectedWorktree(
  db: SqlDatabase,
  validated: ValidatedSelectedPathRequest,
  retainedHeadroom: number,
  exactAncestors?: SelectedExactAncestors,
): { available: boolean; rows: SelectedWorktreeFact[]; retainedBytes: number } {
  const rows: SelectedWorktreeFact[] = [];
  let metadata = false;
  let available = true;
  let retainedBytes = 0;
  let payloadCumulative = 0;
  let previous: string | null = null;
  const cursor =
    exactAncestors === undefined
      ? db.iterate(
          SELECTED_WORKTREE_SQL,
          validated.json,
          validated.request.checkoutId,
          validated.request.root,
          validated.request.root,
          validated.request.root,
          validated.request.root,
          retainedHeadroom,
          retainedHeadroom,
        )
      : db.iterate(
          SELECTED_EXACT_WORKTREE_SQL,
          validated.json,
          validated.request.checkoutId,
          validated.request.root,
          validated.request.root,
          exactAncestors.json,
          retainedHeadroom,
          retainedHeadroom,
        );
  for (const row of cursor) {
    if (row.kind === 0) {
      if (metadata) throw new CorruptError("selected worktree lookup duplicated metadata");
      metadata = true;
      validateSelectedCheckout(row, validated.request);
      const count = numberField(row.candidate_count);
      const symlinks = numberField(row.symlink_ancestors);
      const invalidAncestors = numberField(row.invalid_ancestors);
      if (
        count === null ||
        count < 0 ||
        symlinks === null ||
        symlinks < 0 ||
        invalidAncestors === null ||
        invalidAncestors < 0
      ) {
        throw new CorruptError("selected worktree lookup returned invalid cardinality");
      }
      if (invalidAncestors > 0) {
        throw new CorruptError("selected worktree lookup found a malformed ancestor");
      }
      if (count > MAX_SELECTED_ROWS || symlinks > 0) available = false;
      continue;
    }
    if (row.kind !== 1 || !metadata) {
      throw new CorruptError("selected worktree lookup returned invalid row ordering");
    }
    const pathBytes = numberField(row.path_bytes);
    const pathInode = numberField(row.path_inode);
    const inode = numberField(row.inode);
    const mode = numberField(row.mode);
    const size = numberField(row.size);
    const mtime = numberField(row.mtime);
    const rev = numberField(row.rev);
    const nlink = numberField(row.nlink);
    const targetBytes = numberField(row.target_bytes);
    const contentBytes = numberField(row.content_bytes);
    const payloadBytes = numberField(row.payload_bytes);
    const cumulative = numberField(row.cumulative_payload_bytes);
    const type = row.type;
    if (
      row.path_type !== "text" ||
      typeof row.path !== "string" ||
      pathBytes === null ||
      pathBytes < 1 ||
      encoder.encode(row.path).length !== pathBytes ||
      typeof row.relative !== "string" ||
      !validStoredIndexPath(row.relative, encoder.encode(row.relative).length) ||
      row.path !==
        (validated.request.root === "/"
          ? `/${row.relative}`
          : `${validated.request.root}/${row.relative}`) ||
      row.path_inode_type !== "integer" ||
      pathInode === null ||
      pathInode <= 0 ||
      row.inode_type !== "integer" ||
      inode === null ||
      inode <= 0 ||
      pathInode !== inode ||
      row.node_type !== "text" ||
      (type !== "file" && type !== "dir" && type !== "symlink") ||
      row.mode_type !== "integer" ||
      mode === null ||
      mode < 0 ||
      mode > 0o7777 ||
      row.size_type !== "integer" ||
      size === null ||
      size < 0 ||
      row.mtime_type !== "integer" ||
      mtime === null ||
      row.rev_type !== "integer" ||
      rev === null ||
      rev < 0 ||
      row.nlink_type !== "integer" ||
      nlink === null ||
      nlink <= 0 ||
      (type === "dir" && size !== 0) ||
      !["null", "text"].includes(typeof row.target_type === "string" ? row.target_type : "") ||
      !["null", "blob"].includes(typeof row.content_type === "string" ? row.content_type : "") ||
      (row.target_type === "text" && targetBytes === null) ||
      (row.target_type === "null" && targetBytes !== null) ||
      (row.content_type === "blob" && contentBytes === null) ||
      (row.content_type === "null" && contentBytes !== null) ||
      (type === "dir" && (row.target_type !== "null" || row.content_type !== "null")) ||
      (type === "symlink" && row.content_type !== "null") ||
      (type === "symlink"
        ? row.target_type !== "text" || targetBytes !== size
        : row.target_type !== "null") ||
      payloadBytes === null ||
      cumulative === null
    ) {
      throw new CorruptError("selected worktree lookup returned malformed row");
    }
    const expectedPayload = (targetBytes ?? 0) * 2 + (contentBytes ?? 0);
    if (
      !Number.isSafeInteger(expectedPayload) ||
      expectedPayload < 0 ||
      payloadBytes !== expectedPayload ||
      payloadCumulative > Number.MAX_SAFE_INTEGER - payloadBytes
    ) {
      throw new CorruptError("selected worktree lookup returned invalid payload accounting");
    }
    payloadCumulative += payloadBytes;
    if (cumulative !== payloadCumulative) {
      throw new CorruptError("selected worktree lookup returned invalid cumulative payload");
    }
    if (previous !== null && comparePaths(previous, row.relative) >= 0) {
      throw new CorruptError("selected worktree lookup returned unordered rows");
    }
    previous = row.relative;
    if (
      cumulative > retainedHeadroom ||
      retainedBytes > retainedHeadroom - SELECTED_WORKTREE_RETAINED_BYTES - payloadBytes
    ) {
      available = false;
      continue;
    }
    if (
      (type === "symlink" && typeof row.target !== "string") ||
      (type !== "symlink" && row.target !== null) ||
      (row.content_id !== null && row.content_type !== "blob") ||
      (typeof row.target === "string" && encoder.encode(row.target).length !== targetBytes)
    ) {
      throw new CorruptError("selected worktree lookup returned malformed payload");
    }
    const nextRetainedBytes = retainedBytes + SELECTED_WORKTREE_RETAINED_BYTES + payloadBytes;
    const contentId = row.content_id === null ? null : readBlob(row.content_id);
    if (contentId !== null && contentId.length !== contentBytes) {
      throw new CorruptError("selected worktree lookup returned malformed content id");
    }
    retainedBytes = nextRetainedBytes;
    rows.push({
      path: row.relative,
      stat: {
        type,
        mode,
        size,
        mtime,
        ino: inode,
        nlink,
        rev,
        target: type === "symlink" && typeof row.target === "string" ? row.target : null,
        contentId,
      },
    });
  }
  if (!metadata) throw new CorruptError("selected worktree lookup lost metadata");
  return { available, rows, retainedBytes };
}

function selectPaths(db: SqlDatabase, request: SelectedPathRequest): SelectedPathResult {
  const validated = validateSelectedPathRequest(request);
  if (validated === null) return { available: false };
  if (validated.request.specs.length === 0) {
    return { available: true, index: [], worktree: [] };
  }
  const exactAncestors = validated.request.specs.every((spec) => !spec.recursive)
    ? selectedExactAncestors(validated)
    : null;
  const exactRetainedBytes = exactAncestors?.retainedBytes ?? 0;
  const index = readSelectedIndex(
    db,
    validated,
    validated.retainedLimit - validated.retainedBytes - exactRetainedBytes,
    exactAncestors !== null,
    undefined,
  );
  const headroom =
    validated.retainedLimit - validated.retainedBytes - exactRetainedBytes - index.retainedBytes;
  const worktree = readSelectedWorktree(
    db,
    validated,
    Math.max(0, headroom),
    exactAncestors ?? undefined,
  );
  if (!index.available || !worktree.available || headroom < 0) return { available: false };
  return {
    available: true,
    index: index.rows,
    worktree: worktree.rows,
  };
}

/** Use the native seam without widening the public selected-path source interface. */
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
  return { select: (request) => selectPaths(db, request) };
}
