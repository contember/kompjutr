import { isOid } from "../core/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../core/errors.js";
import type {
  CommitTreeSnapshotDirectory,
  CommitTreeSnapshotRequest,
  CommitTreeSnapshotResult,
  CommitTreeSnapshotSource,
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSource,
  SelectedPathSpec,
  SelectedWorktreeFact,
  SparseIndexAncestorRequest,
  SparseIndexAncestorResult,
  SparseTreeLeaf,
  SparseWorkspaceDirty,
  SparseWorkspaceRequest,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorkspaceSource,
  SparseWorktreeLeaf,
} from "../core/sparse-workspace.js";
import { comparePaths } from "../core/streams.js";
import { readBlob, type SqlDatabase } from "./db.js";
import { iterateIndexTrackerDirty, readIndexTrackerState } from "./index-tracker.js";
import { TREE_QUEUE_ROW_FIXED_BYTES } from "./schema.js";
import type { IndexEntry } from "./store.js";

const MAX_PATHS = 1_000;
const SPARSE_WORKSPACE_STATE_BYTES = 64 * 1024 * 1024;
const MAX_ROOT_SEGMENTS = 128;
const MAX_DEPTH = 64;
const MAX_EDGE_STEPS = 32_768;
const MAX_INDEX_ANCESTORS = 32_768;
const MAX_INDEX_ANCESTOR_ROWS = 32_768;
const MAX_EXACT_INDEX_ANCESTORS = 1_000;
const MAX_EXACT_INDEX_ANCESTOR_ROWS = MAX_EXACT_INDEX_ANCESTORS * 6;
const MAX_SELECTED_ROWS = 32_768;
const MAX_SELECTED_EXACT_ANCESTORS = 32_768;
const MAX_SNAPSHOT_DIRECTORIES = 1_000;
const MAX_SOURCE_ENTRIES = 8_192;
const ROW_RETAINED_BYTES = 1_024;
const INDEX_ENTRY_RETAINED_BYTES = 320;
const INDEX_ANCESTOR_RETAINED_BYTES = 192;
const SELECTED_INDEX_RETAINED_BYTES = 320;
const SELECTED_WORKTREE_RETAINED_BYTES = 512;
const SELECTED_EXACT_SET_RETAINED_BYTES = 128;
const SELECTED_EXACT_SET_ENTRY_BYTES = 96;
const SELECTED_EXACT_ARRAY_RETAINED_BYTES = 64;
const SELECTED_EXACT_ARRAY_SLOT_BYTES = 8;
const SNAPSHOT_ARRAY_RETAINED_BYTES = 64;
const SNAPSHOT_ARRAY_SLOT_BYTES = 8;
const SNAPSHOT_MIN_DIRTY_ROW_RETAINED_BYTES =
  ROW_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES + 4 + 1;
const SNAPSHOT_MAP_RETAINED_BYTES = 128;
const SNAPSHOT_MAP_ENTRY_BYTES = 96;
const SNAPSHOT_REQUEST_RETAINED_BYTES = 512;
const SNAPSHOT_DIRECTORY_RETAINED_BYTES = 256;
const SNAPSHOT_ENTRY_RETAINED_BYTES = 256;
const SNAPSHOT_SOURCE_RETAINED_BYTES = 512;
const SEGMENT_RETAINED_BYTES = 40;
const CURSOR_RETAINED_BYTES = 256;
const OID_RETAINED_BYTES = 112;
const RESOLUTION_RETAINED_BYTES = 192;
const SOURCE_RETAINED_BYTES = 512;
const SNAPSHOT_TREE_PART_JSON_CHARS = 96;
const SNAPSHOT_TREE_RESOLUTION_RETAINED_BYTES =
  SNAPSHOT_MAP_ENTRY_BYTES +
  RESOLUTION_RETAINED_BYTES +
  SNAPSHOT_ENTRY_RETAINED_BYTES +
  OID_RETAINED_BYTES +
  64;
const encoder = new TextEncoder();

interface TreeCursor {
  ordinal: number;
  side: "b" | "c";
  treeOid: string;
  segment: string;
  final: boolean;
  validated: boolean;
  ancestry: string[];
}

interface TreeResolution {
  leaf: SparseTreeLeaf | null;
  treeOid: string | null;
}

interface ValidatedRequest {
  json: string;
  segments: string[][];
  retainedBytes: number;
}

interface ValidatedTreeSource {
  sourceKey: number;
  storage: "loose" | "pack";
  sourceId: number;
  objectSize: number;
  entryCount: number;
  baseCost: number;
}

interface SourceBudget {
  entries: number;
  bytes: number;
  limit: number;
}

interface SnapshotRetainedBudget {
  limit: number;
  used: number;
  peak: number;
}

function reserveSnapshot(budget: SnapshotRetainedBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.limit - budget.used) {
    return false;
  }
  budget.used += bytes;
  budget.peak = Math.max(budget.peak, budget.used);
  return true;
}

function releaseSnapshot(budget: SnapshotRetainedBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.used) {
    throw new CorruptError("commit tree snapshot retained accounting is invalid");
  }
  budget.used -= bytes;
}

function inputError(message: string): GitError {
  return new GitError("EINVAL", message);
}

function tooLarge(message: string): GitError {
  return new GitError("E2BIG", message);
}

function validateRoot(root: string): void {
  if (root.charCodeAt(0) !== 0x2f) throw inputError("sparse workspace root is invalid");
  if (root === "/") return;
  if (root.charCodeAt(root.length - 1) === 0x2f) {
    throw inputError("sparse workspace root is invalid");
  }
  let bytes = 1;
  let segments = 0;
  let start = 1;
  for (let index = 1; index <= root.length; index++) {
    const unit = root.charCodeAt(index);
    if (index === root.length || unit === 0x2f) {
      const length = index - start;
      if (
        length === 0 ||
        (length === 1 && root.charCodeAt(start) === 0x2e) ||
        (length === 2 && root.charCodeAt(start) === 0x2e && root.charCodeAt(start + 1) === 0x2e)
      ) {
        throw inputError("sparse workspace root is invalid");
      }
      segments++;
      if (segments > MAX_ROOT_SEGMENTS) {
        throw tooLarge(`sparse workspace root exceeds ${MAX_ROOT_SEGMENTS} segments`);
      }
      start = index + 1;
      if (index !== root.length) bytes++;
    } else if (unit === 0) {
      throw inputError("sparse workspace root is invalid");
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = root.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) throw inputError("sparse workspace root is invalid");
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw inputError("sparse workspace root is invalid");
    } else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) throw tooLarge("sparse workspace root size overflows");
  }
}

function relativePathShape(path: string): { bytes: number; segments: number } {
  if (path === "" || path.startsWith("/") || path.endsWith("/")) {
    throw inputError("sparse workspace path is invalid");
  }
  let segments = 0;
  let bytes = 0;
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    const unit = path.charCodeAt(index);
    if (index === path.length || unit === 0x2f) {
      const length = index - start;
      if (
        length === 0 ||
        (length === 1 && path.charCodeAt(start) === 0x2e) ||
        (length === 2 && path.charCodeAt(start) === 0x2e && path.charCodeAt(start + 1) === 0x2e)
      ) {
        throw inputError("sparse workspace path is invalid");
      }
      segments++;
      start = index + 1;
      if (index !== path.length) bytes++;
    } else if (unit === 0) {
      throw inputError("sparse workspace path is invalid");
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) {
        throw inputError("sparse workspace path is invalid");
      }
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw inputError("sparse workspace path is invalid");
    } else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) throw tooLarge("sparse workspace path size overflows");
  }
  return { bytes, segments };
}

function parseRelativePath(path: string): { bytes: number; segments: string[] } {
  const shape = relativePathShape(path);
  return { bytes: shape.bytes, segments: path.split("/") };
}

function validateRequest(request: SparseWorkspaceRequest, retainedLimit: number): ValidatedRequest {
  if (!Number.isSafeInteger(request.repoId) || request.repoId <= 0) {
    throw inputError("sparse workspace repository id is invalid");
  }
  if (!Number.isSafeInteger(request.checkoutId) || request.checkoutId <= 0) {
    throw inputError("sparse workspace checkout id is invalid");
  }
  validateRoot(request.root);
  if (
    (request.baselineTreeOid !== null && !isOid(request.baselineTreeOid)) ||
    (request.currentTreeOid !== null && !isOid(request.currentTreeOid))
  ) {
    throw inputError("sparse workspace tree oid is invalid");
  }
  if (request.paths.length > MAX_PATHS) {
    throw tooLarge(`sparse workspace request exceeds ${MAX_PATHS} paths`);
  }

  let retainedBytes = 0;
  let jsonBytes = 2;
  let jsonChars = 2;
  let previous: string | null = null;
  for (const path of request.paths) {
    const parsed = relativePathShape(path);
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse workspace paths are not in strict Git order");
    }
    if (parsed.segments > MAX_DEPTH) {
      return { json: "", segments: [], retainedBytes: -1 };
    }
    const quoted = jsonQuotedSize(path);
    jsonBytes += quoted.bytes + (previous === null ? 0 : 1);
    jsonChars += quoted.chars + (previous === null ? 0 : 1);
    if (!Number.isSafeInteger(jsonBytes) || !Number.isSafeInteger(jsonChars)) {
      throw tooLarge("sparse workspace request JSON size overflows");
    }
    retainedBytes +=
      ROW_RETAINED_BYTES +
      path.length * 4 +
      parsed.bytes +
      parsed.segments * SEGMENT_RETAINED_BYTES;
    if (retainedBytes > retainedLimit) {
      return { json: "", segments: [], retainedBytes: -1 };
    }
    previous = path;
  }
  if (retainedBytes > retainedLimit - jsonChars * 2) {
    return { json: "", segments: [], retainedBytes: -1 };
  }
  retainedBytes += jsonChars * 2;
  const segments = request.paths.map((path) => path.split("/"));
  const json = JSON.stringify(request.paths);
  if (json.length !== jsonChars) {
    throw new CorruptError("sparse workspace request JSON size changed during construction");
  }
  return { json, segments, retainedBytes };
}

function validateIndexAncestorRequest(input: unknown): {
  request: SparseIndexAncestorRequest;
  pathBytes: number[];
  json: string;
  retainedBytes: number;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw inputError("sparse index ancestor request is invalid");
  }
  const checkoutId = Reflect.get(input, "checkoutId");
  const ancestorsInput = Reflect.get(input, "ancestors");
  if (!Number.isSafeInteger(checkoutId) || typeof checkoutId !== "number" || checkoutId <= 0) {
    throw inputError("sparse index ancestor checkout id is invalid");
  }
  if (!Array.isArray(ancestorsInput)) {
    throw inputError("sparse index ancestor paths are invalid");
  }
  if (ancestorsInput.length > MAX_INDEX_ANCESTORS) {
    throw tooLarge(`sparse index ancestor request exceeds ${MAX_INDEX_ANCESTORS} paths`);
  }
  const ancestors: string[] = [];
  for (let index = 0; index < ancestorsInput.length; index++) {
    if (!Object.hasOwn(ancestorsInput, index)) {
      throw inputError("sparse index ancestor paths are not dense");
    }
    const path: unknown = Reflect.get(ancestorsInput, String(index));
    if (typeof path !== "string") {
      throw inputError("sparse index ancestor path is invalid");
    }
    ancestors.push(path);
  }
  const request: SparseIndexAncestorRequest = {
    checkoutId,
    ancestors,
  };
  const retainedLimit = SPARSE_WORKSPACE_STATE_BYTES;

  const parts: string[] = [];
  const pathBytes: number[] = [];
  let retainedBytes = 0;
  let jsonBytes = 2;
  let jsonChars = 2;
  let previous: string | null = null;
  for (const path of request.ancestors) {
    const parsed = parseRelativePath(path);
    if (parsed.segments.length > MAX_DEPTH) {
      throw tooLarge(`sparse index ancestor path exceeds ${MAX_DEPTH} segments`);
    }
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse index ancestor paths are not in strict Git order");
    }
    const part = JSON.stringify(path);
    const separatorBytes = previous === null ? 0 : 1;
    const nextJsonBytes = jsonBytes + encoder.encode(part).length + separatorBytes;
    const nextJsonChars = jsonChars + part.length + separatorBytes;
    const nextRetainedBytes = retainedBytes + INDEX_ANCESTOR_RETAINED_BYTES + path.length * 4;
    if (!Number.isSafeInteger(nextJsonBytes) || !Number.isSafeInteger(nextJsonChars)) {
      throw tooLarge("sparse index ancestor request JSON size overflows");
    }
    if (nextRetainedBytes > retainedLimit - nextJsonChars * 2) {
      throw tooLarge(`sparse index ancestor retained state exceeds ${retainedLimit} bytes`);
    }
    parts.push(part);
    pathBytes.push(parsed.bytes);
    jsonBytes = nextJsonBytes;
    jsonChars = nextJsonChars;
    retainedBytes = nextRetainedBytes;
    previous = path;
  }
  const totalRetainedBytes = retainedBytes + jsonChars * 2;
  return {
    request,
    pathBytes,
    json: `[${parts.join(",")}]`,
    retainedBytes: totalRetainedBytes,
  };
}

export const SPARSE_TREE_DEPTH_SQL = `WITH
  wanted(ordinal, side, tree_oid, segment, final, validated) AS MATERIALIZED (
    SELECT CAST(json_extract(value, '$.i') AS INTEGER),
           json_extract(value, '$.s'), json_extract(value, '$.t'),
           json_extract(value, '$.n'), CAST(json_extract(value, '$.f') AS INTEGER),
           CAST(json_extract(value, '$.v') AS INTEGER)
      FROM json_each(?)
  ),
  selected AS MATERIALIZED (
    SELECT w.ordinal, w.side, w.segment, w.final, w.validated, w.tree_oid,
           x.repo_id, x.source_key,
           s.storage, s.source_id, s.object_size, s.entry_count, s.base_cost
      FROM wanted w
      LEFT JOIN git_tree_effective x
        ON x.repo_id = ? AND x.tree_oid = w.tree_oid
      LEFT JOIN git_tree_sources s
        ON s.source_key = x.source_key
       AND s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.complete = 1
  ),
  distinct_sources AS MATERIALIZED (
    SELECT DISTINCT repo_id, tree_oid, source_key, storage, source_id,
                    object_size, entry_count, base_cost
      FROM selected WHERE validated = 0 AND storage IS NOT NULL
  ),
  metadata_budget AS MATERIALIZED (
    SELECT distinct_sources.*,
           sum(entry_count) OVER (
             ORDER BY source_key ROWS UNBOUNDED PRECEDING
           ) AS cumulative_entries,
           sum(object_size) OVER (
             ORDER BY source_key ROWS UNBOUNDED PRECEDING
           ) AS cumulative_object_bytes
      FROM distinct_sources
     WHERE typeof(tree_oid) = 'text' AND length(tree_oid) = 40
       AND tree_oid NOT GLOB '*[^0-9a-f]*'
       AND typeof(repo_id) = 'integer' AND repo_id >= 1
       AND typeof(source_key) = 'integer' AND source_key >= 1
       AND storage IN ('loose','pack')
       AND typeof(source_id) = 'integer' AND source_id >= 0
       AND typeof(object_size) = 'integer' AND object_size >= 0
       AND typeof(entry_count) = 'integer' AND entry_count >= 0
         AND entry_count <= ${MAX_SOURCE_ENTRIES}
       AND typeof(base_cost) = 'integer'
       AND base_cost = object_size + (${TREE_QUEUE_ROW_FIXED_BYTES} + 18) * entry_count
  ),
  preflight AS MATERIALIZED (
    SELECT source.*,
           (SELECT count(*) FROM (
              SELECT 1 FROM git_tree_entries entry
               WHERE entry.source_key = source.source_key
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS bounded_count,
           (SELECT coalesce(sum(length(raw_entry)), 0) FROM (
              SELECT entry.raw_entry FROM git_tree_entries entry
               WHERE entry.source_key = source.source_key
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS raw_bytes,
           (SELECT coalesce(sum(length(raw_entry) + length(name_bytes)), 0) FROM (
              SELECT entry.raw_entry, entry.name_bytes FROM git_tree_entries entry
               WHERE entry.source_key = source.source_key
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS validation_bytes
      FROM metadata_budget source
     WHERE source.cumulative_entries <= ? AND source.cumulative_object_bytes <= ?
  ),
  validation_budget AS MATERIALIZED (
    SELECT preflight.*,
           sum(validation_bytes) OVER (
             ORDER BY source_key ROWS UNBOUNDED PRECEDING
           ) AS cumulative_validation_bytes
      FROM preflight
  ),
  admitted AS MATERIALIZED (
    SELECT * FROM validation_budget
     WHERE bounded_count = entry_count AND raw_bytes = object_size
       AND cumulative_validation_bytes <= ?
  ),
  entry_checks AS MATERIALIZED (
    SELECT source.source_key,
           count(entry.ordinal) AS actual_count,
           min(entry.ordinal) AS min_ordinal,
           max(entry.ordinal) AS max_ordinal,
           coalesce(sum(length(entry.raw_entry) + length(entry.name_bytes)), 0) AS validation_bytes,
           coalesce(sum(CASE
             WHEN entry.ordinal IS NULL THEN 0
             WHEN typeof(entry.ordinal) <> 'integer'
               OR entry.ordinal < 0 OR entry.ordinal >= source.entry_count
               OR typeof(entry.mode) <> 'text'
               OR entry.mode NOT IN ('40000','040000','100644','100755','120000','160000')
               OR typeof(entry.name_bytes) <> 'blob'
               OR length(entry.name_bytes) = 0
               OR instr(entry.name_bytes, X'00') != 0
               OR instr(CAST(entry.name_bytes AS TEXT), '/') != 0
               OR CAST(CAST(entry.name_bytes AS TEXT) AS BLOB) != entry.name_bytes
               OR EXISTS (
                 SELECT 1 FROM git_tree_entries duplicate
                  WHERE duplicate.source_key = entry.source_key
                    AND duplicate.name_bytes = entry.name_bytes
                    AND typeof(duplicate.name_bytes) = 'blob'
                    AND duplicate.ordinal < entry.ordinal
               )
               OR typeof(entry.oid) <> 'text' OR length(entry.oid) != 40
               OR entry.oid GLOB '*[^0-9a-f]*'
               OR typeof(entry.raw_entry) <> 'blob'
               OR length(entry.raw_entry) != length(CAST(entry.mode AS BLOB))
                    + length(entry.name_bytes) + 22
               OR CAST(substr(entry.raw_entry, 1, length(CAST(entry.mode AS BLOB))) AS BLOB)
                    != CAST(entry.mode AS BLOB)
               OR hex(substr(entry.raw_entry, length(CAST(entry.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(entry.raw_entry, length(CAST(entry.mode AS BLOB)) + 2,
                    length(entry.name_bytes)) AS BLOB) != entry.name_bytes
               OR hex(substr(entry.raw_entry, length(CAST(entry.mode AS BLOB))
                    + length(entry.name_bytes) + 2, 1)) != '00'
               OR lower(hex(substr(entry.raw_entry, -20))) != entry.oid
               OR typeof(entry.cumulative_base) <> 'integer'
               OR entry.cumulative_base != ${TREE_QUEUE_ROW_FIXED_BYTES}
                    + length(entry.name_bytes) + length(CAST(entry.mode AS BLOB))
                    + length(CAST(entry.oid AS BLOB)) + coalesce((
                      SELECT previous.cumulative_base FROM git_tree_entries previous
                       WHERE previous.source_key = entry.source_key
                         AND previous.ordinal = entry.ordinal - 1
                    ), 0)
             THEN 1 ELSE 0 END), 0) AS invalid_entries
      FROM admitted source
      LEFT JOIN git_tree_entries entry ON entry.source_key = source.source_key
     GROUP BY source.source_key
  )
SELECT selected.ordinal, selected.side, selected.final, selected.validated,
       CASE WHEN selected.tree_oid IS NULL OR length(selected.tree_oid) > 40
            THEN NULL ELSE selected.tree_oid END AS tree_oid,
       CASE WHEN selected.storage IN ('loose','pack') THEN selected.storage END AS storage,
       CASE WHEN typeof(selected.source_key) = 'integer' THEN selected.source_key END AS source_key,
       CASE WHEN typeof(selected.source_id) = 'integer' THEN selected.source_id END AS source_id,
       CASE WHEN typeof(selected.object_size) = 'integer' THEN selected.object_size END AS object_size,
       CASE WHEN typeof(selected.entry_count) = 'integer' THEN selected.entry_count END AS entry_count,
       CASE WHEN typeof(selected.base_cost) = 'integer' THEN selected.base_cost END AS base_cost,
       CASE WHEN typeof(preflight.bounded_count) = 'integer'
            THEN preflight.bounded_count END AS bounded_count,
       CASE WHEN typeof(preflight.raw_bytes) = 'integer'
            THEN preflight.raw_bytes END AS raw_bytes,
       CASE WHEN typeof(preflight.validation_bytes) = 'integer'
            THEN preflight.validation_bytes END AS preflight_validation_bytes,
       CASE WHEN admitted.tree_oid IS NULL THEN 0 ELSE 1 END AS admitted,
       coalesce(checks.actual_count, 0) AS actual_count,
       CASE WHEN typeof(checks.min_ordinal) = 'integer' THEN checks.min_ordinal END AS min_ordinal,
       CASE WHEN typeof(checks.max_ordinal) = 'integer' THEN checks.max_ordinal END AS max_ordinal,
       typeof(checks.min_ordinal) AS min_ordinal_type,
       typeof(checks.max_ordinal) AS max_ordinal_type,
       coalesce(checks.validation_bytes, 0) AS validation_bytes,
       coalesce(checks.invalid_entries, 0) AS invalid_entries,
       CASE WHEN edge.mode IN ('40000','040000','100644','100755','120000','160000')
            THEN edge.mode END AS edge_mode,
       CASE WHEN typeof(edge.oid) = 'text' AND length(edge.oid) = 40 THEN edge.oid END AS edge_oid,
       CASE WHEN typeof(edge.ordinal) = 'integer' THEN edge.ordinal END AS edge_ordinal,
       CASE WHEN selected.storage = 'loose' THEN EXISTS (
              SELECT 1 FROM git_objects object
               WHERE object.repo_id = selected.repo_id AND object.oid = selected.tree_oid
                 AND object.type = 'tree' AND object.size = selected.object_size)
            WHEN selected.storage = 'pack' THEN EXISTS (
              SELECT 1 FROM git_pack_objects object
              JOIN git_pack_meta pack ON pack.repo_id = object.repo_id
               AND pack.pack_id = object.pack_id AND pack.state = 'complete'
               WHERE object.repo_id = selected.repo_id AND object.oid = selected.tree_oid
                 AND object.pack_id = selected.source_id AND object.type = 'tree'
                 AND object.size = selected.object_size)
            ELSE 0 END AS authoritative,
       EXISTS (SELECT 1 FROM git_objects loose
                WHERE loose.repo_id = selected.repo_id AND loose.oid = selected.tree_oid) AS has_loose
  FROM selected
  LEFT JOIN preflight
    ON preflight.source_key = selected.source_key
  LEFT JOIN admitted
    ON admitted.source_key = selected.source_key
  LEFT JOIN entry_checks checks
    ON checks.source_key = selected.source_key
  LEFT JOIN git_tree_entries edge
    ON edge.source_key = selected.source_key
   AND edge.name_bytes = CAST(selected.segment AS BLOB)
   AND typeof(edge.name_bytes) = 'blob'
   AND edge.ordinal = (
     SELECT min(candidate.ordinal)
       FROM git_tree_entries candidate
      WHERE candidate.source_key = selected.source_key
        AND candidate.name_bytes = CAST(selected.segment AS BLOB)
        AND typeof(candidate.name_bytes) = 'blob'
   )
 ORDER BY selected.ordinal, selected.side`;

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validateSourceRow(
  row: Record<string, unknown>,
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
  retainSource?: (treeOid: string) => boolean,
): "available" | "unavailable" {
  if (
    typeof row.tree_oid !== "string" ||
    !isOid(row.tree_oid) ||
    (row.storage !== "loose" && row.storage !== "pack")
  ) {
    throw new CorruptError("sparse tree source is missing or invalid");
  }
  const treeOid = row.tree_oid;
  const storage = row.storage;
  const sourceKey = numberField(row.source_key);
  const sourceId = numberField(row.source_id);
  const objectSize = numberField(row.object_size);
  const entryCount = numberField(row.entry_count);
  const baseCost = numberField(row.base_cost);
  const cached = sources.get(treeOid);
  const validated = row.validated;
  if (validated !== 0 && validated !== 1) {
    throw new CorruptError("sparse tree lookup returned invalid validation state");
  }
  if (validated === 1) {
    if (
      cached === undefined ||
      cached.sourceKey !== sourceKey ||
      cached.storage !== storage ||
      cached.sourceId !== sourceId ||
      cached.objectSize !== objectSize ||
      cached.entryCount !== entryCount ||
      cached.baseCost !== baseCost
    ) {
      throw new CorruptError("sparse tree source changed during hydration");
    }
    return "available";
  }
  if (
    sourceKey === null ||
    sourceKey < 1 ||
    sourceId === null ||
    sourceId < 0 ||
    objectSize === null ||
    objectSize < 0 ||
    entryCount === null ||
    entryCount < 0 ||
    baseCost === null ||
    baseCost < 0 ||
    row.authoritative !== 1 ||
    (storage === "loose" && sourceId !== 0) ||
    (storage === "pack" && row.has_loose !== 0) ||
    baseCost !== objectSize + (TREE_QUEUE_ROW_FIXED_BYTES + 18) * entryCount
  ) {
    throw new CorruptError("sparse tree source metadata is inconsistent");
  }
  if (entryCount > MAX_SOURCE_ENTRIES || objectSize > budget.limit) return "unavailable";
  const boundedCount = numberField(row.bounded_count);
  const rawBytes = numberField(row.raw_bytes);
  const preflightValidationBytes = numberField(row.preflight_validation_bytes);
  if (boundedCount === null || rawBytes === null || preflightValidationBytes === null) {
    return "unavailable";
  }
  if (boundedCount !== entryCount || rawBytes !== objectSize) {
    throw new CorruptError("sparse tree source entries disagree with its marker");
  }
  if (row.admitted !== 1 || preflightValidationBytes > budget.limit - budget.bytes) {
    return "unavailable";
  }
  const actualCount = numberField(row.actual_count);
  const validationBytes = numberField(row.validation_bytes);
  const invalidEntries = numberField(row.invalid_entries);
  if (
    actualCount === null ||
    validationBytes === null ||
    invalidEntries === null ||
    (entryCount === 0
      ? row.min_ordinal_type !== "null" || row.max_ordinal_type !== "null"
      : row.min_ordinal_type !== "integer" || row.max_ordinal_type !== "integer") ||
    actualCount !== entryCount ||
    invalidEntries !== 0 ||
    (entryCount === 0
      ? row.min_ordinal !== null || row.max_ordinal !== null
      : row.min_ordinal !== 0 || row.max_ordinal !== entryCount - 1)
  ) {
    throw new CorruptError("sparse tree source entries are inconsistent");
  }
  if (validationBytes > budget.limit) return "unavailable";
  if (cached === undefined) {
    if (
      budget.entries > MAX_SOURCE_ENTRIES - entryCount ||
      budget.bytes > budget.limit - validationBytes
    ) {
      return "unavailable";
    }
    if (retainSource !== undefined && !retainSource(treeOid)) return "unavailable";
    budget.entries += entryCount;
    budget.bytes += validationBytes;
  }
  sources.set(treeOid, { sourceKey, storage, sourceId, objectSize, entryCount, baseCost });
  return "available";
}

function treeDepth(
  db: SqlDatabase,
  repoId: number,
  cursors: TreeCursor[],
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
  retainedBytes: number,
  retainedLimit: number,
  retainSource?: (treeOid: string) => boolean,
): { available: boolean; resolutions: Map<string, TreeResolution> } {
  const parts: string[] = [];
  let jsonBytes = 2;
  let jsonChars = 2;
  for (const cursor of cursors) {
    const part = JSON.stringify({
      i: cursor.ordinal,
      s: cursor.side,
      t: cursor.treeOid,
      n: cursor.segment,
      f: cursor.final ? 1 : 0,
      v: cursor.validated ? 1 : 0,
    });
    parts.push(part);
    jsonBytes += encoder.encode(part).length + (parts.length === 1 ? 0 : 1);
    jsonChars += part.length + (parts.length === 1 ? 0 : 1);
    if (
      !Number.isSafeInteger(jsonBytes) ||
      !Number.isSafeInteger(jsonChars) ||
      retainedBytes + jsonChars * 4 + parts.length * 8 > retainedLimit
    ) {
      return { available: false, resolutions: new Map() };
    }
  }
  const json = `[${parts.join(",")}]`;
  const resolutions = new Map<string, TreeResolution>();
  let rows = 0;
  for (const row of db.iterate(
    SPARSE_TREE_DEPTH_SQL,
    json,
    repoId,
    MAX_SOURCE_ENTRIES - budget.entries,
    budget.limit - budget.bytes,
    budget.limit - budget.bytes,
  )) {
    rows++;
    if (rows > cursors.length) throw new CorruptError("sparse tree lookup returned duplicate rows");
    if (validateSourceRow(row, sources, budget, retainSource) === "unavailable") {
      return { available: false, resolutions };
    }
    const ordinal = numberField(row.ordinal);
    const side = row.side;
    const final = row.final;
    if (
      ordinal === null ||
      ordinal < 0 ||
      ordinal >= MAX_PATHS ||
      (side !== "b" && side !== "c") ||
      (final !== 0 && final !== 1)
    ) {
      throw new CorruptError("sparse tree lookup returned invalid request metadata");
    }
    const key = `${side}:${ordinal}`;
    if (resolutions.has(key)) throw new CorruptError("sparse tree lookup returned duplicate paths");
    if (row.edge_ordinal === null) {
      resolutions.set(key, { leaf: null, treeOid: null });
      continue;
    }
    const edgeOrdinal = numberField(row.edge_ordinal);
    const mode = row.edge_mode;
    const oid = row.edge_oid;
    if (
      edgeOrdinal === null ||
      typeof mode !== "string" ||
      typeof oid !== "string" ||
      !isOid(oid)
    ) {
      throw new CorruptError("sparse tree lookup returned an invalid edge");
    }
    const tree = mode === "40000" || mode === "040000";
    resolutions.set(key, {
      leaf: final === 1 && !tree ? { mode, oid } : null,
      treeOid: tree ? oid : null,
    });
  }
  if (rows !== cursors.length) throw new CorruptError("sparse tree lookup lost requested paths");
  return { available: true, resolutions };
}

function resolveTrees(
  db: SqlDatabase,
  request: SparseWorkspaceRequest,
  segments: string[][],
  retainedRequestBytes: number,
  retainedLimit: number,
): {
  available: boolean;
  baseline: Array<SparseTreeLeaf | null>;
  current: Array<SparseTreeLeaf | null>;
} {
  const baseline: Array<SparseTreeLeaf | null> = request.paths.map(() => null);
  const current: Array<SparseTreeLeaf | null> = request.paths.map(() => null);
  const sources = new Map<string, ValidatedTreeSource>();
  const budget: SourceBudget = {
    entries: 0,
    bytes: 0,
    limit: Math.max(0, retainedLimit - retainedRequestBytes),
  };
  const sharedTrees =
    request.baselineTreeOid !== null && request.baselineTreeOid === request.currentTreeOid;
  let cursors: TreeCursor[] = [];
  for (let ordinal = 0; ordinal < segments.length; ordinal++) {
    const first = segments[ordinal]?.[0];
    if (first === undefined) continue;
    if (request.baselineTreeOid !== null)
      cursors.push({
        ordinal,
        side: "b",
        treeOid: request.baselineTreeOid,
        segment: first,
        final: segments[ordinal]?.length === 1,
        validated: sources.has(request.baselineTreeOid),
        ancestry: [request.baselineTreeOid],
      });
    if (request.currentTreeOid !== null && !sharedTrees)
      cursors.push({
        ordinal,
        side: "c",
        treeOid: request.currentTreeOid,
        segment: first,
        final: segments[ordinal]?.length === 1,
        validated: sources.has(request.currentTreeOid),
        ancestry: [request.currentTreeOid],
      });
  }
  let edgeSteps = 0;
  for (let depth = 0; cursors.length !== 0; depth++) {
    if (depth >= MAX_DEPTH || edgeSteps > MAX_EDGE_STEPS - cursors.length) {
      return { available: false, baseline, current };
    }
    edgeSteps += cursors.length;
    for (const cursor of cursors) cursor.validated = sources.has(cursor.treeOid);
    const cursorBytes = cursors.reduce(
      (bytes, cursor) =>
        bytes + CURSOR_RETAINED_BYTES + cursor.ancestry.length * OID_RETAINED_BYTES,
      0,
    );
    const newSourceOids = new Set<string>();
    for (const cursor of cursors) {
      if (!sources.has(cursor.treeOid)) newSourceOids.add(cursor.treeOid);
    }
    const retainedBeforeQuery =
      retainedRequestBytes +
      cursorBytes +
      cursors.length * RESOLUTION_RETAINED_BYTES +
      cursors.length * 64 +
      (sources.size + newSourceOids.size) * SOURCE_RETAINED_BYTES;
    if (retainedBeforeQuery > retainedLimit) {
      return { available: false, baseline, current };
    }
    const resolved = treeDepth(
      db,
      request.repoId,
      cursors,
      sources,
      budget,
      retainedBeforeQuery,
      retainedLimit,
      undefined,
    );
    if (!resolved.available) return { available: false, baseline, current };
    const next: TreeCursor[] = [];
    let nextBytes = 0;
    for (const cursor of cursors) {
      const resolution = resolved.resolutions.get(`${cursor.side}:${cursor.ordinal}`);
      if (resolution === undefined) throw new CorruptError("sparse tree resolution is incomplete");
      if (resolution.leaf !== null) {
        if (cursor.side === "b") baseline[cursor.ordinal] = resolution.leaf;
        else current[cursor.ordinal] = resolution.leaf;
      }
      if (resolution.treeOid !== null && !cursor.final) {
        if (cursor.ancestry.includes(resolution.treeOid)) {
          throw new CorruptError(`sparse tree cycle at ${resolution.treeOid}`);
        }
        const pathSegments = segments[cursor.ordinal];
        const segment = pathSegments?.[depth + 1];
        if (segment === undefined)
          throw new CorruptError("sparse tree traversal exceeded its path");
        next.push({
          ordinal: cursor.ordinal,
          side: cursor.side,
          treeOid: resolution.treeOid,
          segment,
          final: depth + 2 === pathSegments?.length,
          validated: sources.has(resolution.treeOid),
          ancestry: [...cursor.ancestry, resolution.treeOid],
        });
        nextBytes += CURSOR_RETAINED_BYTES + (cursor.ancestry.length + 1) * OID_RETAINED_BYTES;
        const nextRetainedBytes =
          retainedRequestBytes +
          cursorBytes +
          cursors.length * RESOLUTION_RETAINED_BYTES +
          nextBytes +
          sources.size * SOURCE_RETAINED_BYTES;
        if (nextRetainedBytes > retainedLimit) {
          return { available: false, baseline, current };
        }
      }
    }
    cursors = next;
  }
  if (sharedTrees) {
    for (let ordinal = 0; ordinal < baseline.length; ordinal++) {
      current[ordinal] = baseline[ordinal] ?? null;
    }
  }
  return { available: true, baseline, current };
}

function validStoredIndexPath(path: string, bytes: number): boolean {
  try {
    return parseRelativePath(path).bytes === bytes;
  } catch {
    return false;
  }
}

function validatedSparseIndexEntry(row: Record<string, unknown>): IndexEntry {
  const path = row.path;
  const pathBytes = numberField(row.path_bytes);
  const stage = numberField(row.stage);
  const mode = numberField(row.mode);
  const oid = row.oid;
  const size = numberField(row.size);
  const mtime = numberField(row.mtime);
  const ino = numberField(row.ino);
  const rev = numberField(row.rev);
  if (
    row.path_type !== "text" ||
    typeof path !== "string" ||
    pathBytes === null ||
    pathBytes < 0 ||
    !validStoredIndexPath(path, pathBytes) ||
    row.stage_type !== "integer" ||
    stage === null ||
    stage < 0 ||
    stage > 3 ||
    row.mode_type !== "integer" ||
    mode === null ||
    ![0o100644, 0o100755, 0o120000, 0o160000].includes(mode) ||
    row.oid_type !== "text" ||
    typeof oid !== "string" ||
    !isOid(oid) ||
    !["null", "integer"].includes(typeof row.size_type === "string" ? row.size_type : "") ||
    !["null", "integer"].includes(typeof row.mtime_type === "string" ? row.mtime_type : "") ||
    !["null", "integer"].includes(typeof row.ino_type === "string" ? row.ino_type : "") ||
    !["null", "integer"].includes(typeof row.rev_type === "string" ? row.rev_type : "") ||
    (row.size !== null && size === null) ||
    (row.mtime !== null && mtime === null) ||
    (row.ino !== null && ino === null) ||
    (row.rev !== null && rev === null) ||
    (size !== null && size < 0) ||
    (ino !== null && ino <= 0) ||
    (rev !== null && rev < 0)
  ) {
    throw new CorruptError("sparse index lookup returned a malformed row");
  }
  return { path, stage, mode, oid, size, mtime, ino, rev };
}

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

interface ValidatedSelectedPathRequest {
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

function jsonQuotedSize(value: string): { chars: number; bytes: number } {
  let chars = 2;
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
      chars += 2;
      bytes += 2;
    } else if (unit < 0x20) {
      chars += 6;
      bytes += 6;
    } else if (unit < 0x80) {
      chars++;
      bytes++;
    } else if (unit < 0x800) {
      chars++;
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      chars += 2;
      bytes += 4;
      index++;
    } else {
      chars++;
      bytes += 3;
    }
  }
  return { chars, bytes };
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

function validateSelectedPathRequest(input: unknown): ValidatedSelectedPathRequest | null {
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

function readSelectedIndex(
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

function snapshotSelectedRequestBytes(
  dirty: readonly SparseWorkspaceDirty[],
  retainedLimit: number,
): number | null {
  let retainedBytes = SNAPSHOT_REQUEST_RETAINED_BYTES + SNAPSHOT_ARRAY_RETAINED_BYTES * 2;
  let jsonChars = 2;
  for (let index = 0; index < dirty.length; index++) {
    const path = dirty[index]?.path;
    if (path === undefined) throw new CorruptError("commit tree snapshot lost a dirty path");
    const parsed = parseRelativePath(path);
    const part = JSON.stringify({ p: path, r: 0 });
    const separator = index === 0 ? 0 : 1;
    const records =
      ROW_RETAINED_BYTES * 2 + SNAPSHOT_ARRAY_SLOT_BYTES * 2 + path.length * 4 + parsed.bytes;
    if (records > retainedLimit - retainedBytes) return null;
    retainedBytes += records;
    jsonChars += part.length + separator;
    if (jsonChars * 2 > retainedLimit - retainedBytes) return null;
  }
  return retainedBytes + jsonChars * 2;
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

interface ValidatedSnapshotRequest {
  request: CommitTreeSnapshotRequest;
  retainedLimit: number;
  retainedBytes: number;
}

function validateSnapshotRequest(input: unknown): ValidatedSnapshotRequest | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw inputError("commit tree snapshot request is invalid");
  }
  const repoId = Reflect.get(input, "repoId");
  const checkoutId = Reflect.get(input, "checkoutId");
  const root = Reflect.get(input, "root");
  const baselineTreeOid = Reflect.get(input, "baselineTreeOid");
  if (typeof repoId !== "number" || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw inputError("commit tree snapshot repository id is invalid");
  }
  if (typeof checkoutId !== "number" || !Number.isSafeInteger(checkoutId) || checkoutId <= 0) {
    throw inputError("commit tree snapshot checkout id is invalid");
  }
  if (typeof root !== "string") throw inputError("commit tree snapshot root is invalid");
  validateRoot(root);
  if (
    baselineTreeOid !== null &&
    (typeof baselineTreeOid !== "string" || !isOid(baselineTreeOid))
  ) {
    throw inputError("commit tree snapshot baseline is invalid");
  }
  const retainedLimit = SPARSE_WORKSPACE_STATE_BYTES;
  const retainedBytes =
    SNAPSHOT_REQUEST_RETAINED_BYTES + root.length * 4 + (baselineTreeOid === null ? 0 : 160);
  if (retainedBytes > retainedLimit) return null;
  return {
    request: {
      repoId,
      checkoutId,
      root,
      baselineTreeOid,
    },
    retainedLimit,
    retainedBytes,
  };
}

const SNAPSHOT_DIRTY_SQL = `WITH state AS (
  SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
         typeof(checkout.repo_id) AS repo_type, typeof(checkout.root) AS root_type,
         length(CAST(checkout.root AS BLOB)) AS root_bytes,
         tracker.baseline_tree_oid, typeof(tracker.baseline_tree_oid) AS baseline_type,
         length(CAST(tracker.baseline_tree_oid AS BLOB)) AS baseline_bytes,
         tracker.format, typeof(tracker.format) AS format_type,
         tracker.complete, typeof(tracker.complete) AS complete_type
    FROM git_checkouts checkout
    LEFT JOIN git_index_state tracker ON tracker.checkout_id = checkout.id
   WHERE checkout.id = ?
), dirty AS MATERIALIZED (
  SELECT path, flags FROM git_index_dirty WHERE checkout_id = ?
   ORDER BY path COLLATE BINARY LIMIT ?
)
SELECT 0 AS kind, state.*,
       NULL AS path, 'null' AS path_type, NULL AS path_bytes,
       NULL AS flags, 'null' AS flags_type
  FROM (SELECT 1) LEFT JOIN state ON 1 = 1
UNION ALL
SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       dirty.path, typeof(dirty.path), length(CAST(dirty.path AS BLOB)),
       dirty.flags, typeof(dirty.flags)
  FROM dirty
ORDER BY kind, path COLLATE BINARY`;

function readSnapshotDirty(
  db: SqlDatabase,
  validated: ValidatedSnapshotRequest,
  budget: SnapshotRetainedBudget,
): { available: boolean; dirty: SparseWorkspaceDirty[] } {
  if (!reserveSnapshot(budget, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false, dirty: [] };
  }
  const dirty: SparseWorkspaceDirty[] = [];
  const remaining = budget.limit - budget.used;
  const capacityRows = Math.floor(remaining / SNAPSHOT_MIN_DIRTY_ROW_RETAINED_BYTES);
  let metadata = false;
  let available = true;
  let previous: string | null = null;
  for (const row of db.iterate(
    SNAPSHOT_DIRTY_SQL,
    validated.request.checkoutId,
    validated.request.checkoutId,
    capacityRows + 1,
  )) {
    if (row.kind === 0) {
      if (metadata) throw new CorruptError("commit tree snapshot duplicated tracker state");
      metadata = true;
      if (row.checkout_id === null) return { available: false, dirty: [] };
      const rootBytes = numberField(row.root_bytes);
      if (
        row.checkout_id !== validated.request.checkoutId ||
        row.repo_type !== "integer" ||
        row.repo_id !== validated.request.repoId ||
        row.root_type !== "text" ||
        row.root !== validated.request.root ||
        rootBytes === null ||
        rootBytes < 1
      ) {
        throw new CorruptError("commit tree snapshot checkout is malformed");
      }
      if (row.complete === null) return { available: false, dirty: [] };
      if (row.complete_type !== "integer" || row.format_type !== "integer") {
        throw new CorruptError("commit tree snapshot tracker state is malformed");
      }
      if (row.complete !== 0 && row.complete !== 1) {
        throw new CorruptError("commit tree snapshot tracker completion is invalid");
      }
      if (row.complete === 0) return { available: false, dirty: [] };
      const baselineBytes = numberField(row.baseline_bytes);
      if (
        row.format !== 1 ||
        (row.baseline_type !== "null" && row.baseline_type !== "text") ||
        (row.baseline_tree_oid !== null &&
          (typeof row.baseline_tree_oid !== "string" ||
            baselineBytes !== 40 ||
            !isOid(row.baseline_tree_oid)))
      ) {
        throw new CorruptError("commit tree snapshot tracker baseline is malformed");
      }
      if (row.baseline_tree_oid !== validated.request.baselineTreeOid) available = false;
      continue;
    }
    if (row.kind !== 1 || !metadata) {
      throw new CorruptError("commit tree snapshot dirty rows are unordered");
    }
    const pathBytes = numberField(row.path_bytes);
    const flags = numberField(row.flags);
    if (
      row.path_type !== "text" ||
      typeof row.path !== "string" ||
      pathBytes === null ||
      pathBytes < 1 ||
      !validStoredIndexPath(row.path, pathBytes) ||
      row.flags_type !== "integer" ||
      flags === null ||
      (flags !== 1 && flags !== 2 && flags !== 3) ||
      (previous !== null && comparePaths(previous, row.path) >= 0)
    ) {
      throw new CorruptError("commit tree snapshot dirty row is malformed");
    }
    if (dirty.length === capacityRows) return { available: false, dirty: [] };
    previous = row.path;
    const bytes = ROW_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES + row.path.length * 4 + pathBytes;
    if (!reserveSnapshot(budget, bytes)) {
      return { available: false, dirty: [] };
    }
    dirty.push({ path: row.path, flags });
  }
  if (!metadata) throw new CorruptError("commit tree snapshot lost tracker state");
  return { available, dirty };
}

function snapshotDirectoryPaths(
  dirty: readonly SparseWorkspaceDirty[],
  budget: SnapshotRetainedBudget,
): string[] | null {
  if (
    !reserveSnapshot(
      budget,
      SNAPSHOT_MAP_RETAINED_BYTES + SNAPSHOT_MAP_ENTRY_BYTES + SNAPSHOT_DIRECTORY_RETAINED_BYTES,
    )
  ) {
    return null;
  }
  const paths = new Set<string>([""]);
  for (const entry of dirty) {
    let slash = entry.path.indexOf("/");
    while (slash >= 0) {
      const retained =
        SNAPSHOT_MAP_ENTRY_BYTES +
        SNAPSHOT_DIRECTORY_RETAINED_BYTES +
        slash * 4 +
        utf8PrefixLength(entry.path, slash);
      if (!reserveSnapshot(budget, retained)) return null;
      const directory = entry.path.slice(0, slash);
      if (paths.has(directory)) {
        releaseSnapshot(budget, retained);
      } else {
        if (paths.size === MAX_SNAPSHOT_DIRECTORIES) return null;
        paths.add(directory);
      }
      slash = entry.path.indexOf("/", slash + 1);
    }
  }
  if (
    !reserveSnapshot(budget, SNAPSHOT_ARRAY_RETAINED_BYTES + paths.size * SNAPSHOT_ARRAY_SLOT_BYTES)
  ) {
    return null;
  }
  return [...paths].sort(comparePaths);
}

function utf8PrefixLength(value: string, end: number): number {
  let bytes = 0;
  for (let index = 0; index < end; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

interface SnapshotTreeDepthReservation {
  requestBytes: number;
  resolutionBytes: number;
}

function reserveSnapshotTreeDepth(
  retained: SnapshotRetainedBudget,
  cursors: readonly TreeCursor[],
): SnapshotTreeDepthReservation | null {
  if (cursors.length > MAX_PATHS) return null;
  let jsonChars = 2;
  for (const cursor of cursors) {
    const partChars = SNAPSHOT_TREE_PART_JSON_CHARS + cursor.segment.length * 6;
    if (!Number.isSafeInteger(partChars)) {
      return null;
    }
    jsonChars += partChars + (jsonChars === 2 ? 0 : 1);
  }
  const requestBytes =
    SNAPSHOT_ARRAY_RETAINED_BYTES + cursors.length * SNAPSHOT_ARRAY_SLOT_BYTES + jsonChars * 6;
  const resolutionBytes =
    SNAPSHOT_MAP_RETAINED_BYTES + cursors.length * SNAPSHOT_TREE_RESOLUTION_RETAINED_BYTES;
  if (
    !Number.isSafeInteger(requestBytes) ||
    !Number.isSafeInteger(resolutionBytes) ||
    requestBytes > retained.limit - resolutionBytes ||
    !reserveSnapshot(retained, requestBytes + resolutionBytes)
  ) {
    return null;
  }
  return { requestBytes, resolutionBytes };
}

function snapshotTreeDepth(
  db: SqlDatabase,
  repoId: number,
  cursors: TreeCursor[],
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
  retained: SnapshotRetainedBudget,
  retainSource: (treeOid: string) => boolean,
): {
  available: boolean;
  resolutions: Map<string, TreeResolution>;
  resolutionBytes: number;
} {
  const allocation = reserveSnapshotTreeDepth(retained, cursors);
  if (allocation === null) {
    return { available: false, resolutions: new Map(), resolutionBytes: 0 };
  }
  const result = treeDepth(
    db,
    repoId,
    cursors,
    sources,
    budget,
    retained.used - allocation.requestBytes,
    retained.limit,
    retainSource,
  );
  releaseSnapshot(retained, allocation.requestBytes);
  return { ...result, resolutionBytes: allocation.resolutionBytes };
}

function resolveSnapshotDirectoryOids(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
  paths: readonly string[],
  retained: SnapshotRetainedBudget,
): {
  available: boolean;
  oids: Array<string | null>;
  sources: Map<string, ValidatedTreeSource>;
} {
  if (
    !reserveSnapshot(
      retained,
      SNAPSHOT_ARRAY_RETAINED_BYTES +
        paths.length * SNAPSHOT_ARRAY_SLOT_BYTES +
        SNAPSHOT_MAP_RETAINED_BYTES,
    )
  ) {
    return { available: false, oids: [], sources: new Map() };
  }
  const oids: Array<string | null> = paths.map(() => null);
  const sources = new Map<string, ValidatedTreeSource>();
  if (request.baselineTreeOid === null) return { available: true, oids, sources };
  const retainSource = (treeOid: string): boolean =>
    reserveSnapshot(
      retained,
      SNAPSHOT_MAP_ENTRY_BYTES + SNAPSHOT_SOURCE_RETAINED_BYTES + treeOid.length * 4,
    );
  const sourcePresent = db.scalar<unknown>(
    `SELECT EXISTS (
       SELECT 1 FROM git_tree_effective WHERE repo_id = ? AND tree_oid = ?
     )`,
    request.repoId,
    request.baselineTreeOid,
  );
  if (sourcePresent !== 0 && sourcePresent !== 1) {
    throw new CorruptError("commit tree source presence is malformed");
  }
  if (sourcePresent === 0) return { available: false, oids, sources };
  oids[0] = request.baselineTreeOid;
  const budget: SourceBudget = {
    entries: 0,
    bytes: 0,
    limit: Math.max(0, retained.limit - retained.used),
  };
  const rootCursorBytes =
    SNAPSHOT_ARRAY_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES + snapshotCursorRetainedBytes(1, 1);
  if (!reserveSnapshot(retained, rootCursorBytes)) {
    return { available: false, oids, sources };
  }
  const rootCursors: TreeCursor[] = [
    {
      ordinal: 0,
      side: "b",
      treeOid: request.baselineTreeOid,
      segment: "/",
      final: true,
      validated: false,
      ancestry: [request.baselineTreeOid],
    },
  ];
  const rootValidation = snapshotTreeDepth(
    db,
    request.repoId,
    rootCursors,
    sources,
    budget,
    retained,
    retainSource,
  );
  releaseSnapshot(retained, rootValidation.resolutionBytes);
  releaseSnapshot(retained, rootCursorBytes);
  if (!rootValidation.available) return { available: false, oids, sources };

  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false, oids, sources };
  }
  let cursors: TreeCursor[] = [];
  let cursorRetainedBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
  for (let ordinal = 1; ordinal < paths.length; ordinal++) {
    const path = paths[ordinal];
    if (path === undefined) continue;
    const bounds = pathSegmentBounds(path, 0);
    if (bounds === null) throw new CorruptError("commit tree directory path is malformed");
    const cursorBytes =
      SNAPSHOT_ARRAY_SLOT_BYTES + snapshotCursorRetainedBytes(bounds.end - bounds.start, 1);
    if (!reserveSnapshot(retained, cursorBytes)) {
      return { available: false, oids, sources };
    }
    cursorRetainedBytes += cursorBytes;
    const first = path.slice(bounds.start, bounds.end);
    cursors.push({
      ordinal: ordinal - 1,
      side: "b",
      treeOid: request.baselineTreeOid,
      segment: first,
      final: bounds.final,
      validated: true,
      ancestry: [request.baselineTreeOid],
    });
  }
  for (let depth = 0; cursors.length > 0; depth++) {
    if (depth >= MAX_DEPTH) return { available: false, oids, sources };
    for (const cursor of cursors) cursor.validated = sources.has(cursor.treeOid);
    const resolved = snapshotTreeDepth(
      db,
      request.repoId,
      cursors,
      sources,
      budget,
      retained,
      retainSource,
    );
    if (!resolved.available) {
      releaseSnapshot(retained, resolved.resolutionBytes);
      return { available: false, oids, sources };
    }
    if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
      return { available: false, oids, sources };
    }
    const next: TreeCursor[] = [];
    let nextRetainedBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
    for (const cursor of cursors) {
      const directoryOrdinal = cursor.ordinal + 1;
      const resolution = resolved.resolutions.get(`b:${cursor.ordinal}`);
      if (resolution === undefined)
        throw new CorruptError("commit tree directory lookup is incomplete");
      if (cursor.final) {
        oids[directoryOrdinal] = resolution.treeOid;
        continue;
      }
      if (resolution.treeOid === null) continue;
      const path = paths[directoryOrdinal];
      if (path === undefined) {
        throw new CorruptError("commit tree directory path is malformed");
      }
      const bounds = pathSegmentBounds(path, depth + 1);
      if (bounds === null) throw new CorruptError("commit tree directory path is malformed");
      const cursorBytes =
        SNAPSHOT_ARRAY_SLOT_BYTES +
        snapshotCursorRetainedBytes(bounds.end - bounds.start, cursor.ancestry.length + 1);
      if (!reserveSnapshot(retained, cursorBytes)) {
        return { available: false, oids, sources };
      }
      nextRetainedBytes += cursorBytes;
      const segment = path.slice(bounds.start, bounds.end);
      next.push({
        ordinal: cursor.ordinal,
        side: "b",
        treeOid: resolution.treeOid,
        segment,
        final: bounds.final,
        validated: sources.has(resolution.treeOid),
        ancestry: [...cursor.ancestry, resolution.treeOid],
      });
    }
    releaseSnapshot(retained, cursorRetainedBytes);
    releaseSnapshot(retained, resolved.resolutionBytes);
    cursors = next;
    cursorRetainedBytes = nextRetainedBytes;
  }
  releaseSnapshot(retained, cursorRetainedBytes);
  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false, oids, sources };
  }
  const unvalidated: string[] = [];
  let unvalidatedRetainedBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
  for (const oid of oids) {
    if (oid === null || sources.has(oid) || unvalidated.includes(oid)) continue;
    const bytes = SNAPSHOT_ARRAY_SLOT_BYTES + OID_RETAINED_BYTES;
    if (!reserveSnapshot(retained, bytes)) return { available: false, oids, sources };
    unvalidatedRetainedBytes += bytes;
    unvalidated.push(oid);
  }
  if (unvalidated.length > 0) {
    let validationCursorBytes = SNAPSHOT_ARRAY_RETAINED_BYTES;
    for (const oid of unvalidated) {
      validationCursorBytes +=
        SNAPSHOT_ARRAY_SLOT_BYTES + snapshotCursorRetainedBytes(1, 1) + oid.length * 4;
    }
    if (!reserveSnapshot(retained, validationCursorBytes)) {
      return { available: false, oids, sources };
    }
    const validation = snapshotTreeDepth(
      db,
      request.repoId,
      unvalidated.map((oid, ordinal) => ({
        ordinal,
        side: "b",
        treeOid: oid,
        segment: "/",
        final: true,
        validated: false,
        ancestry: [oid],
      })),
      sources,
      budget,
      retained,
      retainSource,
    );
    releaseSnapshot(retained, validationCursorBytes);
    releaseSnapshot(retained, validation.resolutionBytes);
    if (!validation.available) return { available: false, oids, sources };
  }
  releaseSnapshot(retained, unvalidatedRetainedBytes);
  return { available: true, oids, sources };
}

function snapshotCursorRetainedBytes(segmentLength: number, ancestryLength: number): number {
  return CURSOR_RETAINED_BYTES + segmentLength * 4 + ancestryLength * OID_RETAINED_BYTES;
}

function pathSegmentBounds(
  path: string,
  wanted: number,
): { start: number; end: number; final: boolean } | null {
  let segment = 0;
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index !== path.length && path.charCodeAt(index) !== 0x2f) continue;
    if (segment === wanted) return { start, end: index, final: index === path.length };
    segment++;
    start = index + 1;
  }
  return null;
}

const SNAPSHOT_ENTRIES_SQL = `WITH
wanted(ordinal, path, tree_oid, source_key, storage, source_id) AS MATERIALIZED (
  SELECT CAST(json_extract(value, '$.i') AS INTEGER), json_extract(value, '$.p'),
         json_extract(value, '$.t'), CAST(json_extract(value, '$.k') AS INTEGER),
         json_extract(value, '$.s'),
         CAST(json_extract(value, '$.x') AS INTEGER)
    FROM json_each(?)
), selected AS MATERIALIZED (
  SELECT wanted.*, source.repo_id, source.tree_oid AS source_tree_oid,
         source.source_key AS selected_source_key, source.storage AS source_storage,
         source.source_id AS selected_source_id, source.complete,
         effective.source_key AS effective_source_key
    FROM wanted
    LEFT JOIN git_tree_sources source ON source.source_key = wanted.source_key
    LEFT JOIN git_tree_effective effective
      ON effective.repo_id = source.repo_id AND effective.tree_oid = source.tree_oid
     AND effective.source_key = source.source_key
)
SELECT selected.ordinal AS wanted_ordinal, selected.path AS directory_path,
       selected.tree_oid AS wanted_tree_oid, selected.source_key AS wanted_source_key,
       selected.storage AS wanted_storage, selected.source_id AS wanted_source_id,
       selected.repo_id AS selected_repo_id, selected.source_tree_oid,
       selected.selected_source_key, selected.source_storage, selected.selected_source_id,
       selected.complete AS source_complete, selected.effective_source_key,
       entry.ordinal, entry.mode, entry.name, entry.oid
  FROM selected
  LEFT JOIN (
    SELECT source_key, ordinal, mode, CAST(name_bytes AS TEXT) AS name, oid
      FROM git_tree_entries
  ) entry ON entry.source_key = selected.source_key
 ORDER BY selected.ordinal, entry.ordinal`;

function readSnapshotDirectories(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
  paths: readonly string[],
  oids: readonly (string | null)[],
  sources: Map<string, ValidatedTreeSource>,
  retained: SnapshotRetainedBudget,
): { available: boolean; directories: CommitTreeSnapshotDirectory[] } {
  const directoryBytes =
    SNAPSHOT_ARRAY_RETAINED_BYTES +
    paths.length *
      (SNAPSHOT_ARRAY_SLOT_BYTES +
        SNAPSHOT_DIRECTORY_RETAINED_BYTES +
        SNAPSHOT_ARRAY_RETAINED_BYTES);
  if (!reserveSnapshot(retained, directoryBytes)) {
    return { available: false, directories: [] };
  }
  const directories: CommitTreeSnapshotDirectory[] = paths.map((path, ordinal) => ({
    path,
    oid: oids[ordinal] ?? null,
    entries: [],
  }));
  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES + SNAPSHOT_MAP_RETAINED_BYTES)) {
    return { available: false, directories: [] };
  }
  const parts: string[] = [];
  const expectedCounts = new Map<number, number>();
  let requestJsonChars = 2;
  let requestJsonBytes = 2;
  for (let ordinal = 0; ordinal < paths.length; ordinal++) {
    const oid = oids[ordinal];
    if (oid === null || oid === undefined) continue;
    const source = sources.get(oid);
    if (source === undefined)
      throw new CorruptError("commit tree snapshot source is unauthenticated");
    const part = JSON.stringify({
      i: ordinal,
      p: paths[ordinal],
      t: oid,
      k: source.sourceKey,
      s: source.storage,
      x: source.sourceId,
    });
    const partBytes = SNAPSHOT_ARRAY_SLOT_BYTES + part.length * 2 + SNAPSHOT_MAP_ENTRY_BYTES;
    if (!reserveSnapshot(retained, partBytes)) {
      return { available: false, directories: [] };
    }
    const separator = parts.length === 0 ? 0 : 1;
    requestJsonChars += part.length + separator;
    requestJsonBytes += encoder.encode(part).length + separator;
    if (!Number.isSafeInteger(requestJsonBytes)) {
      return { available: false, directories: [] };
    }
    parts.push(part);
    expectedCounts.set(ordinal, source.entryCount);
  }
  if (parts.length === 0) return { available: true, directories };
  if (!reserveSnapshot(retained, requestJsonChars * 2)) {
    return { available: false, directories: [] };
  }
  const json = `[${parts.join(",")}]`;
  if (
    !reserveSnapshot(
      retained,
      SNAPSHOT_MAP_RETAINED_BYTES + expectedCounts.size * SNAPSHOT_MAP_ENTRY_BYTES,
    )
  ) {
    return { available: false, directories: [] };
  }
  const seen = new Map<number, number>();
  for (const row of db.iterate(SNAPSHOT_ENTRIES_SQL, json)) {
    const ordinal = numberField(row.wanted_ordinal);
    const sourceId = numberField(row.wanted_source_id);
    const sourceKey = numberField(row.wanted_source_key);
    const expectedOid = ordinal === null ? undefined : oids[ordinal];
    const expectedPath = ordinal === null ? undefined : paths[ordinal];
    const source = typeof expectedOid === "string" ? sources.get(expectedOid) : undefined;
    if (
      ordinal === null ||
      expectedPath === undefined ||
      typeof expectedOid !== "string" ||
      source === undefined ||
      row.directory_path !== expectedPath ||
      row.wanted_tree_oid !== expectedOid ||
      sourceKey !== source.sourceKey ||
      row.wanted_storage !== source.storage ||
      sourceId !== source.sourceId ||
      row.selected_repo_id !== request.repoId ||
      row.source_tree_oid !== expectedOid ||
      numberField(row.selected_source_key) !== source.sourceKey ||
      row.source_storage !== source.storage ||
      numberField(row.selected_source_id) !== source.sourceId ||
      row.source_complete !== 1 ||
      numberField(row.effective_source_key) !== source.sourceKey
    ) {
      throw new CorruptError("commit tree snapshot entry source is malformed");
    }
    if (row.ordinal === null) {
      if (source.entryCount !== 0 || (seen.get(ordinal) ?? 0) !== 0) {
        throw new CorruptError("commit tree snapshot lost source entries");
      }
      seen.set(ordinal, 0);
      continue;
    }
    const entryOrdinal = numberField(row.ordinal);
    if (
      entryOrdinal === null ||
      entryOrdinal !== (seen.get(ordinal) ?? 0) ||
      typeof row.mode !== "string" ||
      !["40000", "040000", "100644", "100755", "120000", "160000"].includes(row.mode) ||
      typeof row.name !== "string" ||
      row.name === "" ||
      row.name.includes("/") ||
      row.name.includes("\0") ||
      typeof row.oid !== "string" ||
      !isOid(row.oid)
    ) {
      throw new CorruptError("commit tree snapshot entry is malformed");
    }
    seen.set(ordinal, entryOrdinal + 1);
    const bytes =
      SNAPSHOT_ARRAY_SLOT_BYTES +
      SNAPSHOT_ENTRY_RETAINED_BYTES +
      row.name.length * 4 +
      row.oid.length * 4;
    if (!reserveSnapshot(retained, bytes)) {
      return { available: false, directories: [] };
    }
    directories[ordinal]?.entries.push({ mode: row.mode, name: row.name, oid: row.oid });
  }
  for (const [ordinal, expected] of expectedCounts) {
    if ((seen.get(ordinal) ?? -1) !== expected) {
      throw new CorruptError("commit tree snapshot entry cardinality is inconsistent");
    }
  }
  return { available: true, directories };
}

function snapshotCommitTreeNative(
  db: SqlDatabase,
  request: CommitTreeSnapshotRequest,
): CommitTreeSnapshotResult {
  const validated = validateSnapshotRequest(request);
  if (validated === null) return { available: false };
  const retained: SnapshotRetainedBudget = {
    limit: validated.retainedLimit,
    used: validated.retainedBytes,
    peak: validated.retainedBytes,
  };
  const dirty = readSnapshotDirty(db, validated, retained);
  if (!dirty.available) return { available: false };
  if (dirty.dirty.length === 0) {
    const rootPathsBytes = SNAPSHOT_ARRAY_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES;
    if (!reserveSnapshot(retained, rootPathsBytes)) return { available: false };
    const rootPaths = [""];
    const authenticated = resolveSnapshotDirectoryOids(db, validated.request, rootPaths, retained);
    if (!authenticated.available) return { available: false };
    return {
      available: true,
      baselineTreeOid: validated.request.baselineTreeOid,
      dirty: [],
      index: [],
      directories: [],
    };
  }
  if (dirty.dirty.length > MAX_PATHS) return { available: false };
  const selectedRequestBytes = snapshotSelectedRequestBytes(dirty.dirty, retained.limit);
  if (selectedRequestBytes === null || !reserveSnapshot(retained, selectedRequestBytes)) {
    return { available: false };
  }
  const selectedRequest: SelectedPathRequest = {
    repoId: validated.request.repoId,
    checkoutId: validated.request.checkoutId,
    root: validated.request.root,
    specs: dirty.dirty.map((entry) => ({ path: entry.path, recursive: false })),
  };
  const selectedValidated = validateSelectedPathRequest(selectedRequest);
  if (selectedValidated === null) return { available: false };
  if (!reserveSnapshot(retained, SNAPSHOT_ARRAY_RETAINED_BYTES)) {
    return { available: false };
  }
  const index = readSelectedIndex(db, selectedValidated, retained.limit - retained.used, true, () =>
    reserveSnapshot(retained, SELECTED_INDEX_RETAINED_BYTES),
  );
  if (!index.available) return { available: false };
  const paths = snapshotDirectoryPaths(dirty.dirty, retained);
  if (paths === null) return { available: false };
  const resolved = resolveSnapshotDirectoryOids(db, validated.request, paths, retained);
  if (!resolved.available) return { available: false };
  const directories = readSnapshotDirectories(
    db,
    validated.request,
    paths,
    resolved.oids,
    resolved.sources,
    retained,
  );
  if (!directories.available) return { available: false };
  return {
    available: true,
    baselineTreeOid: validated.request.baselineTreeOid,
    dirty: dirty.dirty,
    index: index.rows,
    directories: directories.directories,
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

/** Use the native seam without widening the public commit-tree source interface. */
export function snapshotCommitTreeOwned(
  source: CommitTreeSnapshotSource,
  request: CommitTreeSnapshotRequest,
): CommitTreeSnapshotResult {
  try {
    return source.snapshot(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

export function createSqliteSparseWorkspaceSource(db: SqlDatabase): SparseWorkspaceSource {
  return {
    readState: (checkoutId) => readIndexTrackerState(db, checkoutId),
    dirtyPaths: (checkoutId) => iterateIndexTrackerDirty(db, checkoutId),
    hydrate: (request) => hydrate(db, request),
    indexAncestorFacts: (request) => indexAncestorFacts(db, request),
  };
}

export function createSqliteSelectedPathSource(db: SqlDatabase): SelectedPathSource {
  return { select: (request) => selectPaths(db, request) };
}

export function createSqliteCommitTreeSnapshotSource(db: SqlDatabase): CommitTreeSnapshotSource {
  return {
    snapshot: (request) => snapshotCommitTreeNative(db, request),
  };
}
