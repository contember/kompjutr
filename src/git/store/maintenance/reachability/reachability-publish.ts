import type { SqlDatabase } from "../../../../db/db.js";
import { isOid } from "../../../common/bytes.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import { expectSafeInteger } from "../../../common/rows.js";
import type { SharedRepoStore } from "../../index.js";
import { booleanInteger, objectType, oidField } from "./reachability-codecs.js";
import {
  EDGE_PAGE,
  type ExistingMark,
  type NormalizedEdge,
  type ObjectExpansion,
  type PublicationResult,
  type QueueObject,
  type ReachabilityEdge,
  type RunState,
} from "./reachability-contracts.js";

function normalizeAndValidateEdges(
  store: SharedRepoStore,
  edges: readonly ReachabilityEdge[],
): NormalizedEdge[] {
  if (edges.length > EDGE_PAGE)
    throw new CorruptError("reachability slice exceeded its edge bound");
  const unique = new Map<string, NormalizedEdge>();
  for (const edge of edges) {
    if (!isOid(edge.oid)) throw new CorruptError("reachable edge has an invalid OID");
    const previous = unique.get(edge.oid);
    if (previous !== undefined && previous.type !== edge.type) {
      throw new CorruptError(`reachable object ${edge.oid} has conflicting required types`);
    }
    unique.set(edge.oid, {
      oid: edge.oid,
      type: edge.type,
      optionalMissing: (previous?.optionalMissing ?? true) && edge.optionalMissing,
      allowPromisedMissing: (previous?.allowPromisedMissing ?? true) && edge.allowPromisedMissing,
      physicalOnly: (previous?.physicalOnly ?? true) && edge.physicalOnly,
      present: true,
    });
  }
  const normalized = [...unique.values()];
  const optional = normalized.filter((edge) => edge.optionalMissing).map((edge) => edge.oid);
  if (optional.length > 0) {
    const present = store.hasAll(optional);
    for (const oid of present) {
      if (!optional.includes(oid)) {
        throw new CorruptError("optional object probe returned an unknown OID");
      }
    }
    for (const edge of normalized) {
      if (edge.optionalMissing) edge.present = present.has(edge.oid);
    }
  }
  const wanted = normalized.filter((edge) => edge.present && !edge.physicalOnly);
  if (wanted.length === 0) return normalized;
  validateEdgeTargets(store, wanted);
  return normalized;
}

function validateEdgeTargets(store: SharedRepoStore, wanted: readonly NormalizedEdge[]): void {
  const expected = new Map(wanted.map((edge) => [edge.oid, edge]));
  const seen = new Set<string>();
  for (const row of store.db.iterate(
    `SELECT /* maintenance-edge-targets */ input.value AS oid,
             CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                  WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
             CASE WHEN loose.oid IS NOT NULL THEN loose.type ELSE packed.type END AS type,
             promised.oid AS promised_oid
       FROM json_each(?) input
       LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = input.value
       LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = input.value
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
         AND pack.state = 'complete'
       LEFT JOIN git_promised_blobs promised
         ON promised.repo_id = ? AND promised.oid = input.value`,
    JSON.stringify(wanted.map((edge) => edge.oid)),
    store.repoId,
    store.repoId,
    store.repoId,
  )) {
    const oid = oidField(row.oid, "reachable edge OID");
    const edge = expected.get(oid);
    if (edge === undefined || seen.has(oid)) {
      throw new CorruptError("reachable edge validation returned inconsistent rows");
    }
    if (row.source !== "loose" && row.source !== "pack") {
      if (edge.allowPromisedMissing && row.promised_oid === edge.oid) {
        edge.present = false;
        seen.add(oid);
        continue;
      }
      throw new CorruptError(`reachable edge references a missing object ${edge.oid}`);
    }
    const type = objectType(row.type, "reachable edge type");
    if (type !== edge.type) {
      throw new CorruptError(`reachable object ${edge.oid} is ${type}, expected ${edge.type}`);
    }
    seen.add(oid);
  }
  if (seen.size !== wanted.length) {
    throw new CorruptError("reachable edge validation returned an incomplete page");
  }
}
function existingMarks(
  db: SqlDatabase,
  repoId: number,
  runId: number,
  edges: readonly NormalizedEdge[],
): Map<string, ExistingMark> {
  const present = edges.filter((edge) => edge.present);
  if (present.length === 0) return new Map();
  const result = new Map<string, ExistingMark>();
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT CAST(input.key AS INTEGER) AS ordinal, input.value AS oid,
            object.oid AS stored_oid, object.physical_only, object.expanded, object.edge_cursor
       FROM json_each(?) input
       LEFT JOIN git_maintenance_objects object
         ON object.repo_id = ? AND object.run_id = ? AND object.oid = input.value
      ORDER BY CAST(input.key AS INTEGER)`,
    JSON.stringify(present.map((edge) => edge.oid)),
    repoId,
    runId,
  )) {
    const expected = present[ordinal];
    if (row.ordinal !== ordinal || expected === undefined || row.oid !== expected.oid) {
      throw new CorruptError("maintenance mark probe changed edge order");
    }
    if (row.stored_oid === null) {
      if (row.physical_only !== null || row.expanded !== null || row.edge_cursor !== null) {
        throw new CorruptError("absent maintenance mark returned stored state");
      }
      result.set(expected.oid, {
        exists: false,
        physicalOnly: false,
        expanded: false,
        edgeCursor: 0,
      });
    } else {
      if (row.stored_oid !== expected.oid) {
        throw new CorruptError("maintenance mark probe returned another OID");
      }
      result.set(expected.oid, {
        exists: true,
        physicalOnly: booleanInteger(row.physical_only, "existing physical marker"),
        expanded: booleanInteger(row.expanded, "existing expanded marker"),
        edgeCursor: expectSafeInteger(
          row.edge_cursor,
          0,
          Number.MAX_SAFE_INTEGER,
          "existing edge cursor",
        ),
      });
      const stored = result.get(expected.oid);
      if (stored?.physicalOnly === true && stored.edgeCursor !== 0) {
        throw new CorruptError("existing physical mark retained a semantic cursor");
      }
    }
    ordinal++;
  }
  if (ordinal !== present.length || result.size !== present.length) {
    throw new CorruptError("maintenance mark probe returned an incomplete page");
  }
  return result;
}

export function publishExpansion(
  db: SqlDatabase,
  store: SharedRepoStore,
  run: RunState,
  object: QueueObject,
  expansion: ObjectExpansion,
): PublicationResult {
  return publishExpansionOwned(db, store, run, object, expansion);
}

function publishExpansionOwned(
  db: SqlDatabase,
  store: SharedRepoStore,
  run: RunState,
  object: QueueObject,
  expansion: ObjectExpansion,
): PublicationResult {
  const edges = normalizeAndValidateEdges(store, expansion.edges);
  const marks = existingMarks(db, store.repoId, run.runId, edges);
  let discoveredObjects = 0;
  let discoveredLogicalObjects = 0;
  let requeuedObjects = 0;
  const rows: { o: string; p: number }[] = [];
  for (const edge of edges) {
    if (!edge.present) continue;
    const mark = marks.get(edge.oid);
    if (mark === undefined) throw new CorruptError("maintenance edge lost its mark probe");
    if (!mark.exists) {
      discoveredObjects++;
      if (!edge.physicalOnly) discoveredLogicalObjects++;
    } else if (mark.physicalOnly && !edge.physicalOnly) {
      discoveredLogicalObjects++;
      if (mark.expanded) requeuedObjects++;
    }
    rows.push({ o: edge.oid, p: edge.physicalOnly ? 1 : 0 });
  }
  if (
    run.queuedObjects > Number.MAX_SAFE_INTEGER - discoveredObjects - requeuedObjects ||
    run.reachableObjects > Number.MAX_SAFE_INTEGER - discoveredLogicalObjects
  ) {
    throw new GitError("E2BIG", "maintenance reachability counters are exhausted");
  }
  if (rows.length > 0) {
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
       SELECT ?, ?, json_extract(input.value, '$.o'), 0, 0,
              EXISTS (
                SELECT 1 FROM git_maintenance_shallow shallow
                 WHERE shallow.repo_id = ? AND shallow.run_id = ?
                   AND shallow.oid = json_extract(input.value, '$.o')
              ), json_extract(input.value, '$.p'), 0
         FROM json_each(?) input
        WHERE true
       ON CONFLICT(repo_id, run_id, oid) DO UPDATE SET
         physical_only = min(physical_only, excluded.physical_only),
         expanded = CASE WHEN physical_only = 1 AND excluded.physical_only = 0
                         THEN 0 ELSE expanded END,
         edge_cursor = CASE WHEN physical_only = 1 AND excluded.physical_only = 0
                            THEN 0 ELSE edge_cursor END`,
      store.repoId,
      run.runId,
      store.repoId,
      run.runId,
      JSON.stringify(rows),
    );
  }
  const updatedObject = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_objects
        SET expanded = ?, edge_cursor = ?
      WHERE repo_id = ? AND run_id = ? AND oid = ? AND expanded = 0
        AND physical_only = ? AND edge_cursor = ?
      RETURNING oid, expanded, physical_only, edge_cursor`,
    expansion.complete ? 1 : 0,
    expansion.nextCursor,
    store.repoId,
    run.runId,
    object.oid,
    object.physicalOnly ? 1 : 0,
    object.edgeCursor,
  );
  if (
    updatedObject === undefined ||
    updatedObject.oid !== object.oid ||
    updatedObject.expanded !== (expansion.complete ? 1 : 0) ||
    updatedObject.physical_only !== (object.physicalOnly ? 1 : 0) ||
    updatedObject.edge_cursor !== expansion.nextCursor
  ) {
    throw new CorruptError("maintenance object progress was not published atomically");
  }
  const queueDelta = discoveredObjects + requeuedObjects - (expansion.complete ? 1 : 0);
  if (run.queuedObjects + queueDelta < 0) {
    throw new CorruptError("maintenance queued count would become negative");
  }
  const nextQueued = run.queuedObjects + queueDelta;
  const nextReachable = run.reachableObjects + discoveredLogicalObjects;
  const updatedRun = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET queued_objects = queued_objects + ?,
            reachable_objects = reachable_objects + ?
      WHERE repo_id = ? AND run_id = ? AND phase = 'mark'
        AND queued_objects = ? AND reachable_objects = ?
      RETURNING repo_id, run_id, queued_objects, reachable_objects`,
    queueDelta,
    discoveredLogicalObjects,
    store.repoId,
    run.runId,
    run.queuedObjects,
    run.reachableObjects,
  );
  if (
    updatedRun === undefined ||
    updatedRun.repo_id !== store.repoId ||
    updatedRun.run_id !== run.runId ||
    updatedRun.queued_objects !== nextQueued ||
    updatedRun.reachable_objects !== nextReachable
  ) {
    throw new CorruptError("maintenance counters were not published atomically");
  }
  return {
    discoveredObjects,
    discoveredLogicalObjects,
    queuedObjects: nextQueued,
    reachableObjects: nextReachable,
  };
}
