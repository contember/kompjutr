import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import { expectSafeInteger } from "../../common/rows.js";
import type { SharedRepoStore } from "../index.js";
import { booleanInteger, oidField, treeModeEdge } from "./semantic-codecs.js";
import {
  EDGE_PAGE,
  type ObjectExpansion,
  type QueueObject,
  type ReachabilityEdge,
  type ReachabilityObjectInfo,
} from "./semantic-contracts.js";
import { scanHeaders } from "./semantic-headers.js";
import { type TreeObjectReads, treeObjectExpansion } from "./semantic-tree-object.js";

export function headerExpansion(
  store: SharedRepoStore,
  object: QueueObject,
  info: ReachabilityObjectInfo,
): ObjectExpansion {
  if (info.type === "blob") {
    if (object.edgeCursor !== 0) throw new CorruptError("blob retained a semantic edge cursor");
    return { edges: [], nextCursor: 0, nextOffset: null, complete: true };
  }
  if (info.type === "tag") {
    if (object.edgeCursor !== 0) throw new CorruptError("tag retained a semantic edge cursor");
    const parsed = scanHeaders(store, info, "tag", 0, 0);
    if (parsed.tagOid === null) throw new CorruptError("tag is missing its object header");
    if (parsed.tagType === null) throw new CorruptError("tag is missing its type header");
    const edges: ReachabilityEdge[] = [
      {
        oid: parsed.tagOid,
        type: parsed.tagType,
        optionalMissing: false,
        allowPromisedMissing: false,
      },
    ];
    return { edges, nextCursor: 0, nextOffset: null, complete: true };
  }
  if (info.type !== "commit") {
    throw new CorruptError(`header expansion received unexpected ${info.type} object`);
  }
  if (object.shallowBoundary && object.edgeCursor > 1) {
    throw new CorruptError("shallow commit retained a parent cursor");
  }
  const parentStart = Math.max(0, object.edgeCursor - 1);
  const semanticCapacity = EDGE_PAGE - (object.edgeCursor === 0 ? 1 : 0);
  const parsed = scanHeaders(store, info, "commit", parentStart, semanticCapacity + 1);
  if (parsed.treeOid === null) throw new CorruptError("commit is missing its tree header");
  const semanticCount = 1 + (object.shallowBoundary ? 0 : parsed.parentCount);
  if (object.edgeCursor > semanticCount) {
    throw new CorruptError("commit edge cursor exceeds its header edges");
  }
  const edges: ReachabilityEdge[] = [];
  if (object.edgeCursor === 0) {
    edges.push({
      oid: parsed.treeOid,
      type: "tree",
      optionalMissing: false,
      allowPromisedMissing: false,
    });
  }
  if (!object.shallowBoundary) {
    for (const parent of parsed.parentOids) {
      if (edges.length >= EDGE_PAGE) break;
      edges.push({
        oid: parent,
        type: "commit",
        optionalMissing: false,
        allowPromisedMissing: false,
      });
    }
  }
  const nextCursor = Math.min(semanticCount, object.edgeCursor + edges.length);
  return { edges, nextCursor, nextOffset: null, complete: nextCursor === semanticCount };
}

function treeEdge(
  row: Record<string, unknown>,
  sourceKey: number,
  ordinal: number,
): ReachabilityEdge {
  if (row.source_key !== sourceKey) throw new CorruptError("tree edge crossed source boundaries");
  if (row.ordinal !== ordinal) throw new CorruptError("tree edge ordinals are not contiguous");
  return treeModeEdge(row.mode, oidField(row.oid, "tree edge OID"));
}

export function treeExpansion(
  db: SqlDatabase,
  store: SharedRepoStore,
  object: QueueObject,
  info: ReachabilityObjectInfo,
  trees: TreeObjectReads,
): ObjectExpansion {
  const source = db.one<Record<string, unknown>>(
    `SELECT source_key, complete, entry_count
       FROM git_tree_sources WHERE repo_id = ? AND tree_oid = ?`,
    store.repoId,
    object.oid,
  );
  // Marking all of history must not project it: an unprojected tree is parsed and left so.
  if (source === undefined || !booleanInteger(source.complete, "tree source completion marker")) {
    return treeObjectExpansion(store, object, info, trees);
  }
  const sourceKey = expectSafeInteger(
    source.source_key,
    1,
    Number.MAX_SAFE_INTEGER,
    "tree source key",
  );
  const entryCount = expectSafeInteger(
    source.entry_count,
    0,
    Number.MAX_SAFE_INTEGER,
    "tree source entry count",
  );
  if (object.edgeCursor > entryCount) throw new CorruptError("tree edge cursor exceeds its marker");

  const edges: ReachabilityEdge[] = [];
  let rows = 0;
  for (const row of db.iterate(
    `SELECT /* maintenance-tree-edges */ source_key, ordinal, mode, oid
       FROM git_tree_entries WHERE source_key = ? AND ordinal >= ?
      ORDER BY ordinal LIMIT ${EDGE_PAGE + 1}`,
    sourceKey,
    object.edgeCursor,
  )) {
    const edge = treeEdge(row, sourceKey, object.edgeCursor + rows);
    if (rows < EDGE_PAGE) edges.push(edge);
    rows++;
    if (object.edgeCursor + rows > entryCount) {
      throw new CorruptError("tree source has rows beyond its completion marker");
    }
  }
  const remaining = entryCount - object.edgeCursor;
  if (rows !== Math.min(remaining, EDGE_PAGE + 1)) {
    throw new CorruptError("tree source rows are incomplete");
  }
  const nextCursor = object.edgeCursor + Math.min(remaining, EDGE_PAGE);
  return { edges, nextCursor, nextOffset: null, complete: nextCursor === entryCount };
}
