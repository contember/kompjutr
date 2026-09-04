import type { SqlDatabase } from "../../../../db/db.js";
import { CorruptError } from "../../../common/errors.js";
import { expectSafeInteger } from "../../../common/rows.js";
import type { SharedRepoStore } from "../../index.js";
import { booleanInteger, oidField } from "./reachability-codecs.js";
import {
  EDGE_PAGE,
  type ObjectExpansion,
  type QueueObject,
  type ReachabilityEdge,
  type ReachabilityObjectInfo,
} from "./reachability-contracts.js";
import { requireObjectInfo, scanHeaders } from "./reachability-headers.js";
import { packedBaseEdge, validatedPackedBaseChain } from "./reachability-packed.js";

export function headerExpansion(
  store: SharedRepoStore,
  object: QueueObject,
  info: ReachabilityObjectInfo,
): ObjectExpansion {
  if (info.type === "blob") {
    if (object.edgeCursor !== 0) throw new CorruptError("blob retained a semantic edge cursor");
    const base = packedBaseEdge(store, object.oid, info.type);
    return { edges: base === null ? [] : [base], nextCursor: 0, complete: true };
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
        physicalOnly: false,
      },
    ];
    const base = packedBaseEdge(store, object.oid, info.type);
    if (base !== null) edges.push(base);
    return { edges, nextCursor: 0, complete: true };
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
      physicalOnly: false,
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
        physicalOnly: false,
      });
    }
  }
  const nextCursor = Math.min(semanticCount, object.edgeCursor + edges.length);
  const semanticComplete = nextCursor === semanticCount;
  let complete = semanticComplete;
  if (semanticComplete) {
    const base = packedBaseEdge(store, object.oid, info.type);
    if (base !== null) {
      if (edges.length < EDGE_PAGE) edges.push(base);
      else complete = false;
    }
  }
  return { edges, nextCursor, complete };
}

function treeEdge(
  row: Record<string, unknown>,
  sourceKey: number,
  ordinal: number,
): ReachabilityEdge {
  if (row.source_key !== sourceKey) throw new CorruptError("tree edge crossed source boundaries");
  if (row.ordinal !== ordinal) throw new CorruptError("tree edge ordinals are not contiguous");
  const mode = row.mode;
  if (
    mode !== "40000" &&
    mode !== "040000" &&
    mode !== "100644" &&
    mode !== "100755" &&
    mode !== "120000" &&
    mode !== "160000"
  ) {
    throw new CorruptError("tree edge mode is invalid");
  }
  const type =
    mode === "40000" || mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
  return {
    oid: oidField(row.oid, "tree edge OID"),
    type,
    optionalMissing: mode === "160000",
    allowPromisedMissing: type === "blob",
    physicalOnly: false,
  };
}

export function treeExpansion(
  db: SqlDatabase,
  store: SharedRepoStore,
  object: QueueObject,
): ObjectExpansion {
  const source = db.one<Record<string, unknown>>(
    `SELECT effective.repo_id, effective.tree_oid, source.source_key,
            source.complete, source.entry_count
       FROM git_tree_effective effective
       JOIN git_tree_sources source ON source.source_key = effective.source_key
      WHERE effective.repo_id = ? AND effective.tree_oid = ?`,
    store.repoId,
    object.oid,
  );
  if (source === undefined) {
    throw new CorruptError(`tree ${object.oid} has no effective parsed source`);
  }
  if (source.repo_id !== store.repoId || source.tree_oid !== object.oid) {
    throw new CorruptError("effective tree source crossed object boundaries");
  }
  if (!booleanInteger(source.complete, "tree source completion marker")) {
    throw new CorruptError("tree source is incomplete");
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
  const semanticComplete = nextCursor === entryCount;
  let complete = semanticComplete;
  if (semanticComplete) {
    const base = packedBaseEdge(store, object.oid, "tree");
    if (base !== null) {
      if (edges.length < EDGE_PAGE) edges.push(base);
      else complete = false;
    }
  }
  return { edges, nextCursor, complete };
}
export function physicalExpansion(store: SharedRepoStore, object: QueueObject): ObjectExpansion {
  const packed = validatedPackedBaseChain(store, object.oid);
  if (packed === null) {
    requireObjectInfo(store, object.oid);
    return { edges: [], nextCursor: 0, complete: true };
  }
  if (packed.baseOid === null) return { edges: [], nextCursor: 0, complete: true };
  return {
    edges: [
      {
        oid: packed.baseOid,
        type: packed.sourceType,
        optionalMissing: false,
        allowPromisedMissing: false,
        physicalOnly: true,
      },
    ],
    nextCursor: 0,
    complete: true,
  };
}
