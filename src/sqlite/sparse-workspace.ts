import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import type {
  SparseTreeLeaf,
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
const MAX_PATH_BYTES = 2_200;
const MAX_ROOT_BYTES = 4_096;
const MAX_ROOT_SEGMENTS = 128;
const MAX_REQUEST_JSON_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_EDGE_STEPS = 32_768;
const MAX_SOURCE_ENTRIES = 8_192;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_WORKTREE_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const ROW_RETAINED_BYTES = 1_024;
const INDEX_ENTRY_RETAINED_BYTES = 320;
const SEGMENT_RETAINED_BYTES = 40;
const CURSOR_RETAINED_BYTES = 256;
const OID_RETAINED_BYTES = 112;
const RESOLUTION_RETAINED_BYTES = 192;
const SOURCE_RETAINED_BYTES = 512;
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
  storage: "loose" | "pack";
  sourceId: number;
}

interface SourceBudget {
  entries: number;
  bytes: number;
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
    if (bytes > MAX_ROOT_BYTES) {
      throw tooLarge(`sparse workspace root exceeds ${MAX_ROOT_BYTES} bytes`);
    }
  }
}

function parseRelativePath(path: string): { bytes: number; segments: string[] } {
  if (path === "" || path.startsWith("/") || path.endsWith("/")) {
    throw inputError("sparse workspace path is invalid");
  }
  const segments: string[] = [];
  let bytes = 0;
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    const unit = path.charCodeAt(index);
    if (index === path.length || unit === 0x2f) {
      const part = path.slice(start, index);
      if (part === "" || part === "." || part === "..") {
        throw inputError("sparse workspace path is invalid");
      }
      segments.push(part);
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
    if (bytes > MAX_PATH_BYTES) {
      throw tooLarge(`sparse workspace path exceeds ${MAX_PATH_BYTES} bytes`);
    }
  }
  return { bytes, segments };
}

function validateRequest(request: SparseWorkspaceRequest): ValidatedRequest {
  if (!Number.isSafeInteger(request.repoId) || request.repoId <= 0) {
    throw inputError("sparse workspace repository id is invalid");
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

  const segments: string[][] = [];
  let retainedBytes = 0;
  let jsonBytes = 2;
  let jsonChars = 2;
  let previous: string | null = null;
  for (const path of request.paths) {
    const parsed = parseRelativePath(path);
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse workspace paths are not in strict Git order");
    }
    if (parsed.segments.length > MAX_DEPTH) {
      return { json: "", segments: [], retainedBytes: -1 };
    }
    const pathJson = JSON.stringify(path);
    const encodedPathJson = encoder.encode(pathJson).length;
    jsonBytes += encodedPathJson + (previous === null ? 0 : 1);
    jsonChars += pathJson.length + (previous === null ? 0 : 1);
    if (jsonBytes > MAX_REQUEST_JSON_BYTES) {
      throw tooLarge(`sparse workspace request exceeds ${MAX_REQUEST_JSON_BYTES} JSON bytes`);
    }
    segments.push(parsed.segments);
    retainedBytes +=
      ROW_RETAINED_BYTES +
      path.length * 4 +
      parsed.bytes +
      parsed.segments.length * SEGMENT_RETAINED_BYTES;
    if (retainedBytes > MAX_RETAINED_BYTES) {
      return { json: "", segments: [], retainedBytes: -1 };
    }
    previous = path;
  }
  if (retainedBytes > MAX_RETAINED_BYTES - jsonChars * 2) {
    return { json: "", segments: [], retainedBytes: -1 };
  }
  const json = JSON.stringify(request.paths);
  retainedBytes += json.length * 2;
  return { json, segments, retainedBytes };
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
           x.storage, x.source_id, s.object_size, s.entry_count, s.base_cost
      FROM wanted w
      LEFT JOIN git_tree_effective x
        ON x.repo_id = ? AND x.tree_oid = w.tree_oid
      LEFT JOIN git_tree_sources s
        ON s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.storage = x.storage AND s.source_id = x.source_id
  ),
  distinct_sources AS MATERIALIZED (
    SELECT DISTINCT tree_oid, storage, source_id, object_size, entry_count, base_cost
      FROM selected WHERE validated = 0 AND storage IS NOT NULL
  ),
  metadata_budget AS MATERIALIZED (
    SELECT distinct_sources.*,
           sum(entry_count) OVER (
             ORDER BY tree_oid, storage, source_id ROWS UNBOUNDED PRECEDING
           ) AS cumulative_entries,
           sum(object_size) OVER (
             ORDER BY tree_oid, storage, source_id ROWS UNBOUNDED PRECEDING
           ) AS cumulative_object_bytes
      FROM distinct_sources
     WHERE typeof(tree_oid) = 'text' AND length(tree_oid) = 40
       AND tree_oid NOT GLOB '*[^0-9a-f]*'
       AND storage IN ('loose','pack')
       AND typeof(source_id) = 'integer' AND source_id >= 0
       AND typeof(object_size) = 'integer' AND object_size >= 0
         AND object_size <= ${MAX_SOURCE_BYTES}
       AND typeof(entry_count) = 'integer' AND entry_count >= 0
         AND entry_count <= ${MAX_SOURCE_ENTRIES}
       AND typeof(base_cost) = 'integer'
       AND base_cost = object_size + (${TREE_QUEUE_ROW_FIXED_BYTES} + 18) * entry_count
  ),
  preflight AS MATERIALIZED (
    SELECT source.*,
           (SELECT count(*) FROM (
              SELECT 1 FROM git_tree_entries entry
               WHERE entry.repo_id = ? AND entry.tree_oid = source.tree_oid
                 AND entry.storage = source.storage AND entry.source_id = source.source_id
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS bounded_count,
           (SELECT coalesce(sum(length(raw_entry)), 0) FROM (
              SELECT entry.raw_entry FROM git_tree_entries entry
               WHERE entry.repo_id = ? AND entry.tree_oid = source.tree_oid
                 AND entry.storage = source.storage AND entry.source_id = source.source_id
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS raw_bytes,
           (SELECT coalesce(sum(length(raw_entry) + length(name_bytes)), 0) FROM (
              SELECT entry.raw_entry, entry.name_bytes FROM git_tree_entries entry
               WHERE entry.repo_id = ? AND entry.tree_oid = source.tree_oid
                 AND entry.storage = source.storage AND entry.source_id = source.source_id
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS validation_bytes
      FROM metadata_budget source
     WHERE source.cumulative_entries <= ? AND source.cumulative_object_bytes <= ?
  ),
  validation_budget AS MATERIALIZED (
    SELECT preflight.*,
           sum(validation_bytes) OVER (
             ORDER BY tree_oid, storage, source_id ROWS UNBOUNDED PRECEDING
           ) AS cumulative_validation_bytes
      FROM preflight
  ),
  admitted AS MATERIALIZED (
    SELECT * FROM validation_budget
     WHERE bounded_count = entry_count AND raw_bytes = object_size
       AND cumulative_validation_bytes <= ?
  ),
  entry_checks AS MATERIALIZED (
    SELECT source.tree_oid, source.storage, source.source_id,
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
               OR typeof(entry.name) <> 'text' OR typeof(entry.name_bytes) <> 'blob'
               OR length(entry.name_bytes) = 0 OR length(entry.name_bytes) > ${MAX_PATH_BYTES}
               OR instr(entry.name_bytes, X'00') != 0
               OR instr(CAST(entry.name_bytes AS TEXT), '/') != 0
               OR CAST(entry.name_bytes AS TEXT) != entry.name
               OR EXISTS (
                 SELECT 1 FROM git_tree_entries duplicate
                  WHERE duplicate.repo_id = ? AND duplicate.tree_oid = entry.tree_oid
                    AND duplicate.storage = entry.storage
                    AND duplicate.source_id = entry.source_id
                    AND duplicate.name_bytes = entry.name_bytes
                    AND typeof(duplicate.name_bytes) = 'blob'
                    AND length(duplicate.name_bytes) <= ${MAX_PATH_BYTES}
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
                       WHERE previous.repo_id = ? AND previous.tree_oid = entry.tree_oid
                         AND previous.storage = entry.storage
                         AND previous.source_id = entry.source_id
                         AND previous.ordinal = entry.ordinal - 1
                    ), 0)
             THEN 1 ELSE 0 END), 0) AS invalid_entries
      FROM admitted source
      LEFT JOIN git_tree_entries entry
        ON entry.repo_id = ? AND entry.tree_oid = source.tree_oid
       AND entry.storage = source.storage AND entry.source_id = source.source_id
     GROUP BY source.tree_oid, source.storage, source.source_id
  )
SELECT selected.ordinal, selected.side, selected.final, selected.validated,
       CASE WHEN selected.tree_oid IS NULL OR length(selected.tree_oid) > 40
            THEN NULL ELSE selected.tree_oid END AS tree_oid,
       CASE WHEN selected.storage IN ('loose','pack') THEN selected.storage END AS storage,
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
               WHERE object.repo_id = ? AND object.oid = selected.tree_oid
                 AND object.type = 'tree' AND object.size = selected.object_size)
            WHEN selected.storage = 'pack' THEN EXISTS (
              SELECT 1 FROM git_pack_objects object
              JOIN git_pack_meta pack ON pack.repo_id = object.repo_id
               AND pack.pack_id = object.pack_id AND pack.state = 'complete'
               WHERE object.repo_id = ? AND object.oid = selected.tree_oid
                 AND object.pack_id = selected.source_id AND object.type = 'tree'
                 AND object.size = selected.object_size)
            ELSE 0 END AS authoritative,
       EXISTS (SELECT 1 FROM git_objects loose
                WHERE loose.repo_id = ? AND loose.oid = selected.tree_oid) AS has_loose
  FROM selected
  LEFT JOIN preflight
    ON preflight.tree_oid = selected.tree_oid AND preflight.storage = selected.storage
   AND preflight.source_id = selected.source_id
  LEFT JOIN admitted
    ON admitted.tree_oid = selected.tree_oid AND admitted.storage = selected.storage
   AND admitted.source_id = selected.source_id
  LEFT JOIN entry_checks checks
    ON checks.tree_oid = selected.tree_oid AND checks.storage = selected.storage
   AND checks.source_id = selected.source_id
  LEFT JOIN git_tree_entries edge INDEXED BY git_tree_entries_by_name_bytes
    ON edge.repo_id = ? AND edge.tree_oid = selected.tree_oid
   AND edge.storage = selected.storage AND edge.source_id = selected.source_id
   AND edge.name_bytes = CAST(selected.segment AS BLOB)
   AND typeof(edge.name_bytes) = 'blob' AND length(edge.name_bytes) <= ${MAX_PATH_BYTES}
   AND edge.ordinal = (
     SELECT min(candidate.ordinal)
       FROM git_tree_entries candidate INDEXED BY git_tree_entries_by_name_bytes
      WHERE candidate.repo_id = ? AND candidate.tree_oid = selected.tree_oid
        AND candidate.storage = selected.storage AND candidate.source_id = selected.source_id
        AND candidate.name_bytes = CAST(selected.segment AS BLOB)
        AND typeof(candidate.name_bytes) = 'blob'
        AND length(candidate.name_bytes) <= ${MAX_PATH_BYTES}
   )
 ORDER BY selected.ordinal, selected.side`;

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validateSourceRow(
  row: Record<string, unknown>,
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
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
    if (cached === undefined || cached.storage !== storage || cached.sourceId !== sourceId) {
      throw new CorruptError("sparse tree source changed during hydration");
    }
    return "available";
  }
  if (
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
  if (entryCount > MAX_SOURCE_ENTRIES || objectSize > MAX_SOURCE_BYTES) return "unavailable";
  const boundedCount = numberField(row.bounded_count);
  const rawBytes = numberField(row.raw_bytes);
  const preflightValidationBytes = numberField(row.preflight_validation_bytes);
  if (boundedCount === null || rawBytes === null || preflightValidationBytes === null) {
    return "unavailable";
  }
  if (boundedCount !== entryCount || rawBytes !== objectSize) {
    throw new CorruptError("sparse tree source entries disagree with its marker");
  }
  if (row.admitted !== 1 || preflightValidationBytes > MAX_SOURCE_BYTES - budget.bytes) {
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
  if (validationBytes > MAX_SOURCE_BYTES) return "unavailable";
  if (cached === undefined) {
    if (
      budget.entries > MAX_SOURCE_ENTRIES - entryCount ||
      budget.bytes > MAX_SOURCE_BYTES - validationBytes
    ) {
      return "unavailable";
    }
    budget.entries += entryCount;
    budget.bytes += validationBytes;
  }
  sources.set(treeOid, { storage, sourceId });
  return "available";
}

function treeDepth(
  db: SqlDatabase,
  repoId: number,
  cursors: TreeCursor[],
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
  retainedBytes: number,
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
      jsonBytes > MAX_REQUEST_JSON_BYTES ||
      retainedBytes + jsonChars * 4 + parts.length * 8 > MAX_RETAINED_BYTES
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
    repoId,
    repoId,
    repoId,
    MAX_SOURCE_ENTRIES - budget.entries,
    MAX_SOURCE_BYTES - budget.bytes,
    MAX_SOURCE_BYTES - budget.bytes,
    repoId,
    repoId,
    repoId,
    repoId,
    repoId,
    repoId,
    repoId,
    repoId,
  )) {
    rows++;
    if (rows > cursors.length) throw new CorruptError("sparse tree lookup returned duplicate rows");
    if (validateSourceRow(row, sources, budget) === "unavailable") {
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
      treeOid: final === 0 && tree ? oid : null,
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
): {
  available: boolean;
  baseline: Array<SparseTreeLeaf | null>;
  current: Array<SparseTreeLeaf | null>;
} {
  const baseline: Array<SparseTreeLeaf | null> = request.paths.map(() => null);
  const current: Array<SparseTreeLeaf | null> = request.paths.map(() => null);
  const sources = new Map<string, ValidatedTreeSource>();
  const budget: SourceBudget = { entries: 0, bytes: 0 };
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
    if (request.currentTreeOid !== null)
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
    if (retainedBeforeQuery > MAX_RETAINED_BYTES) {
      return { available: false, baseline, current };
    }
    const resolved = treeDepth(db, request.repoId, cursors, sources, budget, retainedBeforeQuery);
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
      if (resolution.treeOid !== null) {
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
        if (
          retainedRequestBytes +
            cursorBytes +
            cursors.length * RESOLUTION_RETAINED_BYTES +
            nextBytes +
            sources.size * SOURCE_RETAINED_BYTES >
          MAX_RETAINED_BYTES
        ) {
          return { available: false, baseline, current };
        }
      }
    }
    cursors = next;
  }
  return { available: true, baseline, current };
}

const INDEX_SQL = `WITH wanted(ordinal, path) AS MATERIALIZED (
  SELECT CAST(key AS INTEGER), value FROM json_each(?)
), preflight AS MATERIALIZED (
  SELECT wanted.*,
         (SELECT count(*) FROM (
            SELECT 1 FROM git_index candidate
             WHERE candidate.repo_id = ? AND candidate.path = wanted.path
             ORDER BY candidate.stage LIMIT 5
          )) AS bounded_count,
         (SELECT count(*) FROM git_index candidate
           WHERE candidate.repo_id = ? AND candidate.path = wanted.path
             AND candidate.stage IN (0, 1, 2, 3)) AS valid_count
    FROM wanted
)
SELECT preflight.ordinal,
       CASE WHEN typeof(entry.path) = 'text' AND length(CAST(entry.path AS BLOB)) <= ${MAX_PATH_BYTES}
            THEN entry.path END AS path,
       CASE WHEN typeof(entry.stage) = 'integer' THEN entry.stage END AS stage,
       CASE WHEN typeof(entry.mode) = 'integer' THEN entry.mode END AS mode,
       CASE WHEN typeof(entry.oid) = 'text' AND length(entry.oid) = 40 THEN entry.oid END AS oid,
       CASE WHEN entry.size IS NULL OR typeof(entry.size) = 'integer' THEN entry.size END AS size,
       CASE WHEN entry.mtime IS NULL OR typeof(entry.mtime) = 'integer' THEN entry.mtime END AS mtime,
       CASE WHEN entry.ino IS NULL OR typeof(entry.ino) = 'integer' THEN entry.ino END AS ino,
       CASE WHEN entry.rev IS NULL OR typeof(entry.rev) = 'integer' THEN entry.rev END AS rev,
       typeof(entry.size) AS size_type, typeof(entry.mtime) AS mtime_type,
       typeof(entry.ino) AS ino_type, typeof(entry.rev) AS rev_type
       , 0 AS malformed
  FROM preflight
  JOIN git_index entry ON entry.repo_id = ? AND entry.path = preflight.path
   AND entry.stage IN (0, 1, 2, 3)
UNION ALL
SELECT ordinal, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       'null', 'null', 'null', 'null', 1
  FROM preflight WHERE bounded_count != valid_count OR bounded_count > 4
ORDER BY ordinal, stage`;

function readIndex(
  db: SqlDatabase,
  repoId: number,
  pathsJson: string,
  count: number,
  retainedLimit: number,
): { available: boolean; rows: IndexEntry[][]; retainedBytes: number } {
  const result: IndexEntry[][] = Array.from({ length: count }, () => []);
  let available = true;
  let retainedBytes = 0;
  for (const row of db.iterate(INDEX_SQL, pathsJson, repoId, repoId, repoId)) {
    if (row.malformed === 1) {
      throw new CorruptError("sparse index lookup returned malformed stages");
    }
    const ordinal = numberField(row.ordinal);
    const stage = numberField(row.stage);
    const mode = numberField(row.mode);
    const oid = row.oid;
    const path = row.path;
    if (
      ordinal === null ||
      ordinal < 0 ||
      ordinal >= result.length ||
      typeof path !== "string" ||
      stage === null ||
      stage < 0 ||
      stage > 3 ||
      mode === null ||
      ![0o100644, 0o100755, 0o120000, 0o160000].includes(mode) ||
      typeof oid !== "string" ||
      !isOid(oid) ||
      !["null", "integer"].includes(typeof row.size_type === "string" ? row.size_type : "") ||
      !["null", "integer"].includes(typeof row.mtime_type === "string" ? row.mtime_type : "") ||
      !["null", "integer"].includes(typeof row.ino_type === "string" ? row.ino_type : "") ||
      !["null", "integer"].includes(typeof row.rev_type === "string" ? row.rev_type : "") ||
      (row.size !== null && numberField(row.size) === null) ||
      (row.mtime !== null && numberField(row.mtime) === null) ||
      (row.ino !== null && numberField(row.ino) === null) ||
      (row.rev !== null && numberField(row.rev) === null) ||
      (row.size !== null && (numberField(row.size) ?? -1) < 0) ||
      (row.ino !== null && (numberField(row.ino) ?? 0) <= 0) ||
      (row.rev !== null && (numberField(row.rev) ?? -1) < 0)
    ) {
      throw new CorruptError("sparse index lookup returned a malformed row");
    }
    const entries = result[ordinal];
    if (entries === undefined || entries.some((entry) => entry.stage === stage)) {
      throw new CorruptError("sparse index lookup returned duplicate stages");
    }
    if (retainedBytes > retainedLimit - INDEX_ENTRY_RETAINED_BYTES) {
      available = false;
      continue;
    }
    retainedBytes += INDEX_ENTRY_RETAINED_BYTES;
    entries.push({
      path,
      stage,
      mode,
      oid,
      size: numberField(row.size),
      mtime: numberField(row.mtime),
      ino: numberField(row.ino),
      rev: numberField(row.rev),
    });
  }
  return { available, rows: result, retainedBytes };
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
), budgeted AS MATERIALIZED (
  SELECT metadata.*,
         sum(coalesce(link_target_bytes, 0) + coalesce(content_id_bytes, 0)) OVER (
           ORDER BY ordinal ROWS UNBOUNDED PRECEDING
         ) AS cumulative_payload_bytes
    FROM metadata
)
SELECT budgeted.*,
       CASE WHEN budgeted.cumulative_payload_bytes <= limits.payload_cap
                 AND typeof(payload.link_target) = 'text'
            THEN payload.link_target END AS link_target,
       CASE WHEN budgeted.cumulative_payload_bytes <= limits.payload_cap
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
  payloadLimit: number,
): { available: boolean; rows: Array<SparseWorktreeLeaf | null>; payloadBytes: number } {
  const result: Array<SparseWorktreeLeaf | null> = Array.from({ length: count }, () => null);
  let returned = 0;
  let payloadBytes = 0;
  for (const row of db.iterate(WORKTREE_SQL, pathsJson, payloadLimit, root, root)) {
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
    const cumulativePayloadBytes = numberField(row.cumulative_payload_bytes);
    if (cumulativePayloadBytes === null || cumulativePayloadBytes > payloadLimit) {
      return { available: false, rows: result, payloadBytes };
    }
    if (type === "dir") continue;
    if (
      (row.link_target_type === "text" &&
        targetBytes !== null &&
        targetBytes > MAX_WORKTREE_PAYLOAD_BYTES) ||
      (row.content_id_type === "blob" &&
        contentBytes !== null &&
        contentBytes > MAX_WORKTREE_PAYLOAD_BYTES)
    ) {
      return { available: false, rows: result, payloadBytes };
    }
    if (
      (type === "file" && row.link_target !== null) ||
      (type === "symlink" && typeof row.link_target !== "string")
    ) {
      throw new CorruptError("sparse worktree lookup returned malformed payload metadata");
    }
    payloadBytes += (targetBytes ?? 0) + (contentBytes ?? 0);
    if (payloadBytes > MAX_WORKTREE_PAYLOAD_BYTES)
      return { available: false, rows: result, payloadBytes };
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
  return { available: true, rows: result, payloadBytes };
}

function hydrate(db: SqlDatabase, request: SparseWorkspaceRequest): SparseWorkspaceResult {
  const validated = validateRequest(request);
  if (validated.retainedBytes < 0 || validated.retainedBytes > MAX_RETAINED_BYTES) {
    return { available: false };
  }
  if (request.paths.length === 0) return { available: true, rows: [] };

  const repository = db.one<Record<string, unknown>>(
    `SELECT typeof(root) AS root_type, length(CAST(root AS BLOB)) AS root_bytes,
            root = ? AS matches,
            EXISTS (
              SELECT 1 FROM fs_paths path
              JOIN fs_nodes node ON node.inode = path.inode
               WHERE path.path = git_repositories.root
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
       FROM git_repositories WHERE id = ?`,
    request.root,
    request.repoId,
  );
  if (repository === undefined) throw inputError("sparse workspace repository does not exist");
  if (repository.root_type !== "text" || numberField(repository.root_bytes) === null) {
    throw new CorruptError("sparse workspace repository root is malformed");
  }
  if (repository.matches !== 1) throw inputError("sparse workspace root does not match repository");
  if (repository.root_valid !== 1) {
    throw new CorruptError("sparse workspace repository root is malformed");
  }

  const trees = resolveTrees(db, request, validated.segments, validated.retainedBytes);
  if (!trees.available) return { available: false };
  const index = readIndex(
    db,
    request.repoId,
    validated.json,
    request.paths.length,
    MAX_RETAINED_BYTES - validated.retainedBytes,
  );
  if (!index.available) return { available: false };
  const payloadLimit = Math.min(
    MAX_WORKTREE_PAYLOAD_BYTES,
    MAX_RETAINED_BYTES - validated.retainedBytes - index.retainedBytes,
  );
  if (payloadLimit < 0) return { available: false };
  const worktree = readWorktree(
    db,
    request.root,
    validated.json,
    request.paths.length,
    payloadLimit,
  );
  if (!worktree.available) return { available: false };
  if (validated.retainedBytes + index.retainedBytes > MAX_RETAINED_BYTES - worktree.payloadBytes) {
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
  return { available: true, rows };
}

export function createSqliteSparseWorkspaceSource(db: SqlDatabase): SparseWorkspaceSource {
  return {
    readState: (repoId) => readIndexTrackerState(db, repoId),
    dirtyPaths: (repoId) => iterateIndexTrackerDirty(db, repoId),
    hydrate: (request) => hydrate(db, request),
  };
}
