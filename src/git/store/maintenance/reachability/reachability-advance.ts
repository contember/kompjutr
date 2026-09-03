import type { SqlDatabase } from "../../../../db/db.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { SharedRepoStore } from "../../index.js";
import { reconcileMaintenanceMark } from "../state/state-transitions.js";
import { expectPhase, expectRootsSettled, readMaintenanceRunView } from "../state/state-view.js";
import { booleanInteger, oidField, safeInteger } from "./reachability-codecs.js";
import {
  MARK_EXPANSIONS_PER_CALL,
  type MaintenanceReachabilityProgress,
  type ObjectExpansion,
  type QueueObject,
  type RunState,
} from "./reachability-contracts.js";
import { headerExpansion, physicalExpansion, treeExpansion } from "./reachability-expand.js";
import { requireObjectInfo } from "./reachability-headers.js";
import { publishExpansion } from "./reachability-publish.js";

function readRun(db: SqlDatabase, repoId: number): RunState {
  const run = readMaintenanceRunView(db, repoId);
  if (run === null) throw new GitError("ENOTFOUND", "maintenance run does not exist");
  expectRootsSettled(run);
  return run;
}

function initializeCounters(db: SqlDatabase, repoId: number, run: RunState): RunState {
  if (run.reachableObjects !== 0 || run.queuedObjects === 0) return run;
  const logical = reconcileMaintenanceMark(db, run, "initial");
  const updated = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET reachable_objects = ?
      WHERE repo_id = ? AND run_id = ? AND phase = 'mark'
        AND reachable_objects = 0 AND queued_objects = ?
      RETURNING repo_id, run_id, reachable_objects, queued_objects`,
    logical,
    repoId,
    run.runId,
    run.queuedObjects,
  );
  if (
    updated === undefined ||
    updated.repo_id !== repoId ||
    updated.run_id !== run.runId ||
    updated.reachable_objects !== logical ||
    updated.queued_objects !== run.queuedObjects
  ) {
    throw new CorruptError("maintenance root counters were not initialized atomically");
  }
  return { ...run, reachableObjects: logical };
}

function readNextObject(db: SqlDatabase, repoId: number, runId: number): QueueObject | null {
  let result: QueueObject | null = null;
  let previous: { oid: string; physicalOnly: boolean } | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `SELECT object.repo_id, object.run_id, object.oid, object.source_mask,
            object.expanded, object.shallow_boundary, object.physical_only,
            object.edge_cursor,
            EXISTS (
              SELECT 1 FROM git_maintenance_shallow shallow
               WHERE shallow.repo_id = object.repo_id AND shallow.run_id = object.run_id
                 AND shallow.oid = object.oid
            ) AS stored_shallow
       FROM git_maintenance_objects object
      WHERE object.repo_id = ? AND object.run_id = ? AND object.expanded = 0
      ORDER BY object.physical_only ASC, object.oid COLLATE BINARY LIMIT 2`,
    repoId,
    runId,
  )) {
    rows++;
    if (row.repo_id !== repoId || row.run_id !== runId) {
      throw new CorruptError("maintenance mark queue crossed run boundaries");
    }
    const oid = oidField(row.oid, "maintenance queued OID");
    const physicalOnly = booleanInteger(row.physical_only, "maintenance physical-only marker");
    const expanded = booleanInteger(row.expanded, "maintenance expanded marker");
    const shallowBoundary = booleanInteger(row.shallow_boundary, "maintenance shallow marker");
    const storedShallow = booleanInteger(row.stored_shallow, "maintenance shallow membership");
    if (expanded || shallowBoundary !== storedShallow || (physicalOnly && shallowBoundary)) {
      throw new CorruptError("maintenance queued object has inconsistent state");
    }
    const edgeCursor = safeInteger(row.edge_cursor, "maintenance edge cursor", 0);
    if (physicalOnly && edgeCursor !== 0) {
      throw new CorruptError("physical-only maintenance object retained a semantic cursor");
    }
    if (
      previous !== null &&
      ((previous.physicalOnly === physicalOnly && oid <= previous.oid) ||
        (previous.physicalOnly && !physicalOnly))
    ) {
      throw new CorruptError("maintenance mark queue is not in deterministic order");
    }
    previous = { oid, physicalOnly };
    if (result === null) {
      result = {
        oid,
        sourceMask: safeInteger(row.source_mask, "maintenance source mask", 0),
        shallowBoundary,
        physicalOnly,
        edgeCursor,
      };
    }
  }
  if (rows > 2) throw new CorruptError("maintenance mark queue exceeded its sentinel");
  return result;
}

function finishMark(db: SqlDatabase, repoId: number, run: RunState): void {
  reconcileMaintenanceMark(db, run, "complete");
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET phase = 'classify-loose'
      WHERE repo_id = ? AND run_id = ? AND phase = 'mark' AND observed_root_epoch = ?
        AND NOT EXISTS (
          SELECT 1 FROM git_maintenance_objects object
           WHERE object.repo_id = ? AND object.run_id = ? AND object.expanded = 0
        )
      RETURNING repo_id, run_id, phase, reachable_objects, queued_objects`,
    repoId,
    run.runId,
    run.observedRootEpoch,
    repoId,
    run.runId,
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.phase !== "classify-loose" ||
    row.reachable_objects !== run.reachableObjects ||
    row.queued_objects !== run.queuedObjects
  ) {
    throw new CorruptError("maintenance mark completion was not published atomically");
  }
}

interface MarkGate {
  kind: "root-changed" | "complete" | "mark";
  run: RunState;
}

function openMarkRun(store: SharedRepoStore): MarkGate {
  const run = readRun(store.db, store.repoId);
  if (run.observedRootEpoch !== run.rootEpoch) return { kind: "root-changed", run };
  expectPhase(
    run,
    ["mark", "classify-loose"],
    `maintenance reachability cannot advance phase ${run.phase}`,
  );
  if (run.phase === "classify-loose") return { kind: "complete", run };
  return { kind: "mark", run: initializeCounters(store.db, store.repoId, run) };
}

interface MarkExpansion {
  run: RunState;
  processedOid: string;
  discoveredObjects: number;
  discoveredLogicalObjects: number;
}

function expandNextMarkObject(store: SharedRepoStore, run: RunState): MarkExpansion | null {
  const object = readNextObject(store.db, store.repoId, run.runId);
  if (object === null) return null;
  if (run.queuedObjects === 0) {
    throw new CorruptError("maintenance queued count omitted an unexpanded mark");
  }
  let expansion: ObjectExpansion;
  if (object.physicalOnly) {
    expansion = physicalExpansion(store, object);
  } else {
    const info = requireObjectInfo(store, object.oid);
    if (object.shallowBoundary && info.type !== "commit") {
      throw new CorruptError("maintenance shallow boundary is not a commit");
    }
    expansion =
      info.type === "tree"
        ? treeExpansion(store.db, store, object)
        : headerExpansion(store, object, info);
  }
  const published = publishExpansion(store.db, store, run, object, expansion);
  return {
    run: {
      ...run,
      queuedObjects: published.queuedObjects,
      reachableObjects: published.reachableObjects,
    },
    processedOid: object.oid,
    discoveredObjects: published.discoveredObjects,
    discoveredLogicalObjects: published.discoveredLogicalObjects,
  };
}

function advanceMark(
  store: SharedRepoStore,
  expansionBudget: number,
): MaintenanceReachabilityProgress {
  if (!Number.isSafeInteger(store.repoId) || store.repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
  return store.db.transactionSync(() => {
    const gate = openMarkRun(store);
    let run = gate.run;
    if (gate.kind !== "mark") {
      return {
        runId: run.runId,
        status: gate.kind,
        processedOid: null,
        discoveredObjects: 0,
        discoveredLogicalObjects: 0,
      };
    }
    let processedOid: string | null = null;
    let discoveredObjects = 0;
    let discoveredLogicalObjects = 0;
    for (let expansions = 0; expansions < expansionBudget; expansions++) {
      const expansion = expandNextMarkObject(store, run);
      if (expansion === null) {
        // A call that expanded leaves the settled transition to the next one, as one step does.
        if (expansions > 0) break;
        finishMark(store.db, store.repoId, run);
        return {
          runId: run.runId,
          status: "complete",
          processedOid,
          discoveredObjects,
          discoveredLogicalObjects,
        };
      }
      run = expansion.run;
      processedOid = expansion.processedOid;
      discoveredObjects += expansion.discoveredObjects;
      discoveredLogicalObjects += expansion.discoveredLogicalObjects;
    }
    return {
      runId: run.runId,
      status: "progress",
      processedOid,
      discoveredObjects,
      discoveredLogicalObjects,
    };
  });
}

/** Advance one durable reachability edge page or the stable mark completion transition. */
export function advanceMaintenanceReachability(
  store: SharedRepoStore,
): MaintenanceReachabilityProgress {
  return advanceMark(store, 1);
}

/** Advance one bounded maintenance call: a fixed page budget of reachability expansions. */
export function advanceMaintenanceMark(store: SharedRepoStore): MaintenanceReachabilityProgress {
  return advanceMark(store, MARK_EXPANSIONS_PER_CALL);
}
