import type { SqlDatabase } from "../../../../db/db.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { SharedRepoStore } from "../../index.js";
import { readBatch } from "./repack-batch.js";
import type {
  FinalizedObject,
  LooseCandidate,
  MaintenanceRepackProgress,
  RepackBatch,
  RepackRun,
} from "./repack-contracts.js";
import {
  deleteExactLooseObjects,
  finalizedPackedSources,
  verifyCompletePack,
  verifyFinalizedSources,
} from "./repack-finalize-sources.js";
import { requireRepackedCapacity } from "./repack-helpers.js";

function incrementRepacked(
  db: SqlDatabase,
  repoId: number,
  run: RepackRun,
  objectCount: number,
): void {
  requireRepackedCapacity(run, objectCount);
  const next = run.repackedObjects + objectCount;
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET repacked_objects = ?
      WHERE repo_id = ? AND run_id = ? AND phase = 'repack' AND repacked_objects = ?
        AND observed_root_epoch = ?
        AND EXISTS (
          SELECT 1 FROM git_maintenance_control control
           WHERE control.repo_id = ? AND control.root_epoch = ?
        )
      RETURNING repo_id, run_id, repacked_objects`,
    next,
    repoId,
    run.runId,
    run.repackedObjects,
    run.observedRootEpoch,
    repoId,
    run.observedRootEpoch,
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.repacked_objects !== next
  ) {
    throw new CorruptError("maintenance repacked counter was not updated atomically");
  }
}

export function finalizePublished(
  store: SharedRepoStore,
  run: RepackRun,
  batch: RepackBatch,
): MaintenanceRepackProgress {
  const packId = batch.packId;
  if (packId === null) throw new CorruptError("published repack batch has no pack id");
  store.db.transactionSync(() => {
    requireRepackedCapacity(run, batch.objectCount);
    if (!store.packs.completePackMatches(packId, batch.objects)) {
      throw new CorruptError("maintenance published pack does not match its batch");
    }
    verifyCompletePack(store.db, store.repoId, batch, packId);
    const finalized = finalizedPackedSources(store.db, store.repoId, batch.objects);
    store.packs.authenticateCompleteSources(finalized);
    deleteExactLooseObjects(store.db, store.repoId, batch.objects);
    store.packs.authenticateCompleteSources(finalized);
    verifyFinalizedSources(store.db, store.repoId, finalized);
    incrementRepacked(store.db, store.repoId, run, batch.objectCount);
    if (finalized.every((object) => object.packId !== packId)) {
      const discarded = store.packs.discardOwnedComplete(packId, (ownedPackId) => {
        if (ownedPackId !== packId) {
          throw new CorruptError("maintenance finalization received another complete pack");
        }
        releaseBatchRow(store.db, store.repoId, run.runId, batch, "published", packId);
      });
      if (!discarded) throw new CorruptError("redundant maintenance pack is missing");
      verifyFinalizedSources(store.db, store.repoId, finalized);
    } else {
      releaseBatchRow(store.db, store.repoId, run.runId, batch, "published", packId);
    }
  });
  return {
    runId: run.runId,
    status: "progress",
    boundary: "finalized",
    batchId: batch.batchId,
    packId,
    objectCount: batch.objectCount,
  };
}

export function finalizeShadows(
  store: SharedRepoStore,
  run: RepackRun,
  candidates: readonly LooseCandidate[],
): MaintenanceRepackProgress {
  const finalized: FinalizedObject[] = candidates.map((candidate) => {
    if (candidate.packId === null) throw new CorruptError("maintenance shadow has no pack id");
    return {
      oid: candidate.oid,
      type: candidate.type,
      size: candidate.size,
      packId: candidate.packId,
    };
  });
  store.db.transactionSync(() => {
    requireRepackedCapacity(run, finalized.length);
    store.packs.authenticateCompleteSources(finalized);
    deleteExactLooseObjects(store.db, store.repoId, finalized);
    store.packs.authenticateCompleteSources(finalized);
    verifyFinalizedSources(store.db, store.repoId, finalized);
    incrementRepacked(store.db, store.repoId, run, finalized.length);
  });
  return {
    runId: run.runId,
    status: "progress",
    boundary: "finalized",
    batchId: null,
    packId: null,
    objectCount: finalized.length,
  };
}

export function finalizeSelectedShadows(
  store: SharedRepoStore,
  run: RepackRun,
  batch: RepackBatch,
  shadows: readonly FinalizedObject[],
): MaintenanceRepackProgress {
  store.db.transactionSync(() => {
    requireRepackedCapacity(run, shadows.length);
    store.packs.authenticateCompleteSources(shadows);
    deleteExactLooseObjects(store.db, store.repoId, shadows);
    store.packs.authenticateCompleteSources(shadows);
    verifyFinalizedSources(store.db, store.repoId, shadows);
    incrementRepacked(store.db, store.repoId, run, shadows.length);
    releaseBatchRow(store.db, store.repoId, run.runId, batch, "selected", null);
  });
  return {
    runId: run.runId,
    status: "progress",
    boundary: "finalized",
    batchId: batch.batchId,
    packId: null,
    objectCount: shadows.length,
  };
}

export function transitionToClassifyPacks(db: SqlDatabase, repoId: number, run: RepackRun): void {
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET phase = 'classify-packs'
      WHERE repo_id = ? AND run_id = ? AND phase = 'repack'
        AND observed_root_epoch = ?
        AND EXISTS (
          SELECT 1 FROM git_maintenance_control control
           WHERE control.repo_id = ? AND control.root_epoch = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM git_maintenance_objects mark
          JOIN git_objects loose ON loose.repo_id = mark.repo_id AND loose.oid = mark.oid
           WHERE mark.repo_id = ? AND mark.run_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM git_maintenance_repack_batches batch
           WHERE batch.repo_id = ? AND batch.run_id = ?
        )
      RETURNING repo_id, run_id, phase, repacked_objects`,
    repoId,
    run.runId,
    run.observedRootEpoch,
    repoId,
    run.observedRootEpoch,
    repoId,
    run.runId,
    repoId,
    run.runId,
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.phase !== "classify-packs" ||
    row.repacked_objects !== run.repackedObjects
  ) {
    throw new CorruptError("maintenance repack completion was not published atomically");
  }
}

function releaseBatchRow(
  db: SqlDatabase,
  repoId: number,
  runId: number,
  batch: RepackBatch,
  state: "selected" | "pending" | "published",
  packId: number | null,
): void {
  const row = db.one<Record<string, unknown>>(
    `DELETE FROM git_maintenance_repack_batches
      WHERE repo_id = ? AND run_id = ? AND batch_id = ? AND state = ?
        AND ${packId === null ? "pack_id IS NULL" : "pack_id = ?"}
      RETURNING repo_id, run_id, batch_id`,
    repoId,
    runId,
    batch.batchId,
    state,
    ...(packId === null ? [] : [packId]),
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== runId ||
    row.batch_id !== batch.batchId
  ) {
    throw new CorruptError("maintenance restart did not release its exact repack batch");
  }
}

/** Settle an owned repack batch before a root-drift restart resets common run state. */
export function settleMaintenanceRepackForRestart(
  store: SharedRepoStore,
  expectedRunId: number,
): void {
  if (!Number.isSafeInteger(store.repoId) || store.repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId < 1) {
    throw new RangeError("maintenance restart run id must be a safe positive integer");
  }
  const batch = readBatch(store.db, store.repoId, expectedRunId);
  if (batch === null) return;
  if (batch.state === "selected") {
    store.db.transactionSync(() => {
      releaseBatchRow(store.db, store.repoId, expectedRunId, batch, "selected", null);
    });
    return;
  }
  const packId = batch.packId;
  if (packId === null) throw new CorruptError("owned maintenance pack has no pack id");
  if (batch.state === "pending") {
    const removed = store.packs.discardPending(packId, (ownedPackId) => {
      if (ownedPackId !== packId) {
        throw new CorruptError("maintenance restart received another pending pack");
      }
      releaseBatchRow(store.db, store.repoId, expectedRunId, batch, "pending", packId);
    });
    if (!removed) throw new CorruptError("maintenance restart pending pack is missing");
    return;
  }
  store.db.transactionSync(() => {
    if (!store.packs.completePackMatches(packId, batch.objects)) {
      throw new CorruptError("maintenance restart published pack does not match its batch");
    }
    verifyCompletePack(store.db, store.repoId, batch, packId);
    releaseBatchRow(store.db, store.repoId, expectedRunId, batch, "published", packId);
  });
}
