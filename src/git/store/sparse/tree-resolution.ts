import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError } from "../../common/errors.js";
import { expectSafeInteger, expectText } from "../../common/rows.js";
import type { SparseTreeLeaf, SparseWorkspaceRequest } from "../contracts.js";
import {
  CURSOR_RETAINED_BYTES,
  encoder,
  MAX_DEPTH,
  MAX_EDGE_STEPS,
  MAX_PATHS,
  MAX_SOURCE_ENTRIES,
  OID_RETAINED_BYTES,
  RESOLUTION_RETAINED_BYTES,
  SOURCE_RETAINED_BYTES,
  type SourceBudget,
  type TreeCursor,
  type TreeResolution,
  type ValidatedTreeSource,
} from "./shared.js";

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
     WHERE entry_count <= ${MAX_SOURCE_ENTRIES}
  ),
  preflight AS MATERIALIZED (
    SELECT source.*,
           (SELECT count(*) FROM (
              SELECT 1 FROM git_tree_entries entry
               WHERE entry.source_key = source.source_key
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS bounded_count,
           source.object_size + (SELECT coalesce(sum(length(name_bytes)), 0) FROM (
              SELECT entry.name_bytes FROM git_tree_entries entry
               WHERE entry.source_key = source.source_key
               ORDER BY entry.ordinal LIMIT ${MAX_SOURCE_ENTRIES + 1}
            )) AS source_bytes
      FROM metadata_budget source
     WHERE source.cumulative_entries <= ? AND source.cumulative_object_bytes <= ?
  ),
  source_budget AS MATERIALIZED (
    SELECT preflight.*,
           sum(source_bytes) OVER (
             ORDER BY source_key ROWS UNBOUNDED PRECEDING
           ) AS cumulative_source_bytes
      FROM preflight
  ),
  admitted AS MATERIALIZED (
    SELECT * FROM source_budget
     WHERE bounded_count <= ${MAX_SOURCE_ENTRIES}
       AND cumulative_source_bytes <= ?
  )
SELECT selected.ordinal, selected.side, selected.final, selected.validated,
       selected.tree_oid, selected.storage, selected.source_key, selected.source_id,
       selected.object_size, selected.entry_count, selected.base_cost,
       preflight.bounded_count, preflight.source_bytes,
       CASE WHEN admitted.tree_oid IS NULL THEN 0 ELSE 1 END AS admitted,
       edge.mode AS edge_mode, edge.oid AS edge_oid, edge.ordinal AS edge_ordinal
  FROM selected
  LEFT JOIN preflight
    ON preflight.source_key = selected.source_key
  LEFT JOIN admitted
    ON admitted.source_key = selected.source_key
  LEFT JOIN git_tree_entries edge
    ON edge.source_key = selected.source_key
   AND edge.name_bytes = CAST(selected.segment AS BLOB)
   AND edge.ordinal = (
     SELECT min(candidate.ordinal)
       FROM git_tree_entries candidate
      WHERE candidate.source_key = selected.source_key
        AND candidate.name_bytes = CAST(selected.segment AS BLOB)
   )
 ORDER BY selected.ordinal, selected.side`;

export function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validateSourceRow(
  row: Record<string, unknown>,
  sources: Map<string, ValidatedTreeSource>,
  budget: SourceBudget,
  retainSource?: (treeOid: string) => boolean,
): "available" | "unavailable" {
  const treeOid = expectText(row.tree_oid, "sparse tree oid");
  if (row.storage !== "loose" && row.storage !== "pack") {
    throw new CorruptError("sparse tree source is missing or invalid");
  }
  const storage = row.storage;
  const sourceKey = expectSafeInteger(
    row.source_key,
    1,
    Number.MAX_SAFE_INTEGER,
    "sparse tree source key",
  );
  const sourceId = expectSafeInteger(
    row.source_id,
    0,
    Number.MAX_SAFE_INTEGER,
    "sparse tree source id",
  );
  const objectSize = expectSafeInteger(
    row.object_size,
    0,
    Number.MAX_SAFE_INTEGER,
    "sparse tree object size",
  );
  const entryCount = expectSafeInteger(
    row.entry_count,
    0,
    Number.MAX_SAFE_INTEGER,
    "sparse tree entry count",
  );
  const baseCost = expectSafeInteger(
    row.base_cost,
    0,
    Number.MAX_SAFE_INTEGER,
    "sparse tree base cost",
  );
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
  if (entryCount > MAX_SOURCE_ENTRIES || objectSize > budget.limit) return "unavailable";
  const boundedCount = numberField(row.bounded_count);
  const sourceBytes = numberField(row.source_bytes);
  if (boundedCount === null || sourceBytes === null) return "unavailable";
  if (
    boundedCount > MAX_SOURCE_ENTRIES ||
    row.admitted !== 1 ||
    sourceBytes > budget.limit - budget.bytes
  ) {
    return "unavailable";
  }
  if (cached === undefined) {
    if (
      budget.entries > MAX_SOURCE_ENTRIES - entryCount ||
      budget.bytes > budget.limit - sourceBytes
    ) {
      return "unavailable";
    }
    if (retainSource !== undefined && !retainSource(treeOid)) return "unavailable";
    budget.entries += entryCount;
    budget.bytes += sourceBytes;
  }
  sources.set(treeOid, { sourceKey, storage, sourceId, objectSize, entryCount, baseCost });
  return "available";
}

export function treeDepth(
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
    const mode = expectText(row.edge_mode, "sparse tree edge mode");
    const oid = expectText(row.edge_oid, "sparse tree edge oid");
    const tree = mode === "40000" || mode === "040000";
    resolutions.set(key, {
      leaf: final === 1 && !tree ? { mode, oid } : null,
      treeOid: tree ? oid : null,
    });
  }
  if (rows !== cursors.length) throw new CorruptError("sparse tree lookup lost requested paths");
  return { available: true, resolutions };
}

export function resolveTrees(
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
