import type { SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { int, nullable, oneOf, RowShape, text } from "../../common/rows.js";
import type { SparseTreeLeaf, SparseWorkspaceRequest } from "../core/contracts.js";
import {
  encoder,
  MAX_DEPTH,
  MAX_EDGE_STEPS,
  MAX_PATHS,
  MAX_SPARSE_BINDING_BYTES,
  type TreeCursor,
  type TreeResolution,
  type ValidatedTreeSource,
} from "./shared.js";

export const SPARSE_TREE_DEPTH_SQL = `WITH wanted(ordinal, side, tree_oid, segment, final) AS MATERIALIZED (
  SELECT CAST(json_extract(value, '$.i') AS INTEGER),
         json_extract(value, '$.s'), json_extract(value, '$.t'),
         json_extract(value, '$.n'), CAST(json_extract(value, '$.f') AS INTEGER)
    FROM json_each(?)
)
SELECT wanted.ordinal, wanted.side, wanted.tree_oid, wanted.segment, wanted.final,
       source.source_key,
       edge.mode AS edge_mode, edge.oid AS edge_oid, edge.ordinal AS edge_ordinal
  FROM wanted
  LEFT JOIN git_tree_effective effective
    ON effective.repo_id = ? AND effective.tree_oid = wanted.tree_oid
  LEFT JOIN git_tree_sources source
    ON source.source_key = effective.source_key
   AND source.repo_id = effective.repo_id
   AND source.tree_oid = wanted.tree_oid
   AND source.complete = 1
  LEFT JOIN git_tree_entries edge
    ON edge.source_key = source.source_key
   AND edge.name_bytes = CAST(wanted.segment AS BLOB)
 ORDER BY wanted.ordinal, wanted.side`;

const TREE_DEPTH_ROW = new RowShape({
  ordinal: int(0),
  side: oneOf(["b", "c"]),
  tree_oid: text(),
  segment: text(),
  final: oneOf([0, 1]),
  source_key: nullable(int(1)),
  edge_mode: nullable(text()),
  edge_oid: nullable(text()),
  edge_ordinal: nullable(int(0)),
});

export function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function treeDepth(
  db: SqlDatabase,
  repoId: number,
  cursors: readonly TreeCursor[],
  sources: Map<string, ValidatedTreeSource>,
): { available: boolean; resolutions: Map<string, TreeResolution> } {
  const resolutions = new Map<string, TreeResolution>();
  const parts: string[] = [];
  let jsonBytes = 2;
  for (const cursor of cursors) {
    const part = JSON.stringify({
      i: cursor.ordinal,
      s: cursor.side,
      t: cursor.treeOid,
      n: cursor.segment,
      f: cursor.final ? 1 : 0,
    });
    const partBytes = encoder.encode(part).length + (parts.length === 0 ? 0 : 1);
    if (jsonBytes > MAX_SPARSE_BINDING_BYTES - partBytes) {
      return { available: false, resolutions };
    }
    jsonBytes += partBytes;
    parts.push(part);
  }
  const json = `[${parts.join(",")}]`;
  const expected = new Map<string, TreeCursor>();
  for (const cursor of cursors) {
    const key = `${cursor.side}:${cursor.ordinal}`;
    if (expected.has(key)) throw new CorruptError("sparse tree lookup received duplicate paths");
    expected.set(key, cursor);
  }
  let rows = 0;
  let previousOrdinal = -1;
  let previousSide: "b" | "c" | null = null;
  for (const raw of db.iterate(SPARSE_TREE_DEPTH_SQL, json, repoId)) {
    const row = TREE_DEPTH_ROW.decode(raw);
    const cursor = expected.get(`${row.side}:${row.ordinal}`);
    if (
      cursor === undefined ||
      row.tree_oid !== cursor.treeOid ||
      row.segment !== cursor.segment ||
      row.final !== (cursor.final ? 1 : 0) ||
      row.ordinal < previousOrdinal ||
      (row.ordinal === previousOrdinal && previousSide !== null && row.side <= previousSide)
    ) {
      throw new CorruptError("sparse tree lookup returned invalid request metadata");
    }
    previousOrdinal = row.ordinal;
    previousSide = row.side;
    rows++;
    if (rows > cursors.length) throw new CorruptError("sparse tree lookup returned duplicate rows");
    const key = `${row.side}:${row.ordinal}`;
    if (resolutions.has(key)) throw new CorruptError("sparse tree lookup returned duplicate paths");
    if (row.source_key === null) return { available: false, resolutions };
    const source = sources.get(row.tree_oid);
    if (source === undefined) {
      if (sources.size === MAX_PATHS) return { available: false, resolutions };
      sources.set(row.tree_oid, { sourceKey: row.source_key });
    } else if (source.sourceKey !== row.source_key) {
      throw new CorruptError("sparse tree source changed during hydration");
    }
    if (row.edge_ordinal === null) {
      if (row.edge_mode !== null || row.edge_oid !== null) {
        throw new CorruptError("sparse tree lookup returned an incomplete edge");
      }
      resolutions.set(key, { leaf: null, treeOid: null });
      continue;
    }
    if (
      row.edge_mode === null ||
      !["40000", "040000", "100644", "100755", "120000", "160000"].includes(row.edge_mode) ||
      row.edge_oid === null ||
      !isOid(row.edge_oid)
    ) {
      throw new CorruptError("sparse tree lookup returned a malformed edge");
    }
    const tree = row.edge_mode === "40000" || row.edge_mode === "040000";
    resolutions.set(key, {
      leaf: row.final === 1 && !tree ? { mode: row.edge_mode, oid: row.edge_oid } : null,
      treeOid: tree ? row.edge_oid : null,
    });
  }
  if (rows !== cursors.length) throw new CorruptError("sparse tree lookup lost requested paths");
  return { available: true, resolutions };
}

export function resolveTrees(
  db: SqlDatabase,
  request: SparseWorkspaceRequest,
  segments: readonly string[][],
): {
  available: boolean;
  baseline: Array<SparseTreeLeaf | null>;
  current: Array<SparseTreeLeaf | null>;
} {
  const baseline: Array<SparseTreeLeaf | null> = request.paths.map(() => null);
  const current: Array<SparseTreeLeaf | null> = request.paths.map(() => null);
  const sources = new Map<string, ValidatedTreeSource>();
  const sharedTrees =
    request.baselineTreeOid !== null && request.baselineTreeOid === request.currentTreeOid;
  let cursors: TreeCursor[] = [];
  for (let ordinal = 0; ordinal < segments.length; ordinal++) {
    const first = segments[ordinal]?.[0];
    if (first === undefined) continue;
    if (request.baselineTreeOid !== null) {
      cursors.push({
        ordinal,
        side: "b",
        treeOid: request.baselineTreeOid,
        segment: first,
        final: segments[ordinal]?.length === 1,
        validated: false,
        ancestry: [request.baselineTreeOid],
      });
    }
    if (request.currentTreeOid !== null && !sharedTrees) {
      cursors.push({
        ordinal,
        side: "c",
        treeOid: request.currentTreeOid,
        segment: first,
        final: segments[ordinal]?.length === 1,
        validated: false,
        ancestry: [request.currentTreeOid],
      });
    }
  }
  let edgeSteps = 0;
  for (let depth = 0; cursors.length !== 0; depth++) {
    if (depth >= MAX_DEPTH || edgeSteps > MAX_EDGE_STEPS - cursors.length) {
      return { available: false, baseline, current };
    }
    edgeSteps += cursors.length;
    const resolved = treeDepth(db, request.repoId, cursors, sources);
    if (!resolved.available) return { available: false, baseline, current };
    const next: TreeCursor[] = [];
    for (const cursor of cursors) {
      const resolution = resolved.resolutions.get(`${cursor.side}:${cursor.ordinal}`);
      if (resolution === undefined) throw new CorruptError("sparse tree resolution is incomplete");
      if (resolution.leaf !== null) {
        if (cursor.side === "b") baseline[cursor.ordinal] = resolution.leaf;
        else current[cursor.ordinal] = resolution.leaf;
      }
      if (resolution.treeOid === null || cursor.final) continue;
      if (cursor.ancestry.includes(resolution.treeOid)) {
        throw new CorruptError(`sparse tree cycle at ${resolution.treeOid}`);
      }
      const pathSegments = segments[cursor.ordinal];
      const segment = pathSegments?.[depth + 1];
      if (segment === undefined) throw new CorruptError("sparse tree traversal exceeded its path");
      next.push({
        ordinal: cursor.ordinal,
        side: cursor.side,
        treeOid: resolution.treeOid,
        segment,
        final: depth + 2 === pathSegments?.length,
        validated: false,
        ancestry: [...cursor.ancestry, resolution.treeOid],
      });
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
