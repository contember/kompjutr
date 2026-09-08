import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { RawObject } from "../../../common/objects.js";
import type { SharedRepoStore } from "../../index.js";
import {
  type FullObjectPackInput,
  type FullObjectPackReader,
  streamFullObjectPack,
} from "../../pack/full-object-stream.js";
import type { PackIngestResult } from "../../pack/packs.js";
import {
  type FinalizedObject,
  MAX_REPACK_INFLATED_BYTES,
  MAX_REPACK_OBJECTS,
  type MaintenanceRepackOptions,
  type MaintenanceRepackProgress,
  type RepackBatch,
  type RepackLimits,
  type RepackRun,
  type RunMutationPhase,
} from "./repack-contracts.js";
import {
  currentRootEpoch,
  packIdField,
  requireRepackedCapacity,
  rootChanged,
} from "./repack-helpers.js";

class RepackReader implements FullObjectPackReader {
  constructor(
    private readonly store: SharedRepoStore,
    private readonly readBatchBytes: number,
  ) {}

  readBatch(objects: readonly FullObjectPackInput[]): ReadonlyMap<string, RawObject> {
    const expectedBytes = objects.reduce((total, object) => total + object.size, 0);
    const batch = this.store.readObjects(
      objects.map((object) => object.oid),
      { budgetBytes: this.readBatchBytes },
    );
    if (
      batch.remaining.length !== 0 ||
      batch.objects.size !== objects.length ||
      batch.bytes !== expectedBytes
    ) {
      throw new CorruptError("maintenance repack reader returned an incomplete batch");
    }
    return batch.objects;
  }

  readChunks(object: FullObjectPackInput): Iterable<Uint8Array> | null {
    return this.store.readChunks(object.oid);
  }
}

export function selectedBatchShadows(
  db: SqlDatabase,
  repoId: number,
  runId: number,
  batch: RepackBatch,
): FinalizedObject[] {
  const shadows: FinalizedObject[] = [];
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT object.repo_id, object.run_id, object.batch_id, object.ordinal,
            object.oid, object.type, object.size,
            loose.oid AS loose_oid, loose.type AS loose_type, loose.size AS loose_size,
            pack.pack_id,
            CASE WHEN pack.pack_id IS NOT NULL THEN packed.type END AS packed_type,
            CASE WHEN pack.pack_id IS NOT NULL THEN packed.size END AS packed_size,
            CASE WHEN pack.pack_id IS NOT NULL THEN packed.base_oid END AS base_oid,
            pack.state
       FROM git_maintenance_repack_objects object
       LEFT JOIN git_objects loose
         ON loose.repo_id = object.repo_id AND loose.oid = object.oid
       LEFT JOIN git_pack_objects packed
         ON packed.repo_id = object.repo_id AND packed.oid = object.oid
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
        AND pack.state = 'complete'
      WHERE object.repo_id = ? AND object.run_id = ? AND object.batch_id = ?
      ORDER BY object.ordinal LIMIT ?`,
    repoId,
    runId,
    batch.batchId,
    batch.objectCount + 1,
  )) {
    const expected = batch.objects[ordinal];
    if (
      expected === undefined ||
      row.repo_id !== repoId ||
      row.run_id !== runId ||
      row.batch_id !== batch.batchId ||
      row.ordinal !== ordinal ||
      row.oid !== expected.oid ||
      row.type !== expected.type ||
      row.size !== expected.size
    ) {
      throw new CorruptError("selected maintenance batch changed membership");
    }
    if (
      row.loose_oid !== null &&
      (row.loose_oid !== expected.oid ||
        row.loose_type !== expected.type ||
        row.loose_size !== expected.size)
    ) {
      throw new CorruptError("selected maintenance batch has stale loose metadata");
    }
    if (row.pack_id !== null) {
      const packId = packIdField(row.pack_id, "selected maintenance shadow pack id");
      if (
        row.packed_type !== expected.type ||
        row.packed_size !== expected.size ||
        (row.base_oid !== null && (typeof row.base_oid !== "string" || !isOid(row.base_oid))) ||
        row.state !== "complete"
      ) {
        throw new CorruptError("selected maintenance shadow metadata is invalid");
      }
      shadows.push({ ...expected, packId });
    } else if (
      row.packed_type !== null ||
      row.packed_size !== null ||
      row.base_oid !== null ||
      row.state !== null
    ) {
      throw new CorruptError("absent selected maintenance shadow returned metadata");
    }
    if (row.loose_oid === null && row.pack_id === null) {
      throw new CorruptError(`selected maintenance object ${expected.oid} disappeared`);
    }
    ordinal++;
  }
  if (ordinal !== batch.objectCount) {
    throw new CorruptError("selected maintenance shadow validation is incomplete");
  }
  return shadows;
}

function updateOwnedState(
  db: SqlDatabase,
  repoId: number,
  run: RepackRun,
  batch: RepackBatch,
  from: "selected" | "pending",
  to: "pending" | "published",
  packId: number,
  storedBytes: number,
): void {
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_repack_batches
        SET state = ?, pack_id = ?, stored_bytes = ?
      WHERE repo_id = ? AND run_id = ? AND batch_id = ? AND state = ?
        AND ${from === "selected" ? "pack_id IS NULL" : "pack_id = ?"}
        AND EXISTS (
          SELECT 1 FROM git_maintenance_runs run
          JOIN git_maintenance_control control ON control.repo_id = run.repo_id
           WHERE run.repo_id = ? AND run.run_id = ? AND run.phase = 'repack'
             AND run.observed_root_epoch = ? AND control.root_epoch = ?
        )
      RETURNING repo_id, run_id, batch_id, state, pack_id, stored_bytes`,
    to,
    packId,
    storedBytes,
    repoId,
    run.runId,
    batch.batchId,
    from,
    ...(from === "selected" ? [] : [packId]),
    repoId,
    run.runId,
    run.observedRootEpoch,
    run.observedRootEpoch,
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.batch_id !== batch.batchId ||
    row.state !== to ||
    row.pack_id !== packId ||
    row.stored_bytes !== storedBytes
  ) {
    throw new CorruptError(`maintenance repack ${to} state was not published atomically`);
  }
}

export async function publishBatch(
  store: SharedRepoStore,
  run: RepackRun,
  batch: RepackBatch,
  selectedLimits: RepackLimits,
  options: MaintenanceRepackOptions,
  nowMs: number,
  runMutation: RunMutationPhase,
): Promise<MaintenanceRepackProgress> {
  requireRepackedCapacity(run, batch.objectCount);
  const reader = new RepackReader(store, selectedLimits.readBatchBytes);
  const source = streamFullObjectPack(batch.objects, reader, {
    maxObjects: MAX_REPACK_OBJECTS,
    maxInflatedBytes: MAX_REPACK_INFLATED_BYTES,
    maxStoredBytes: selectedLimits.maxStoredBytes,
    readBatchBytes: selectedLimits.readBatchBytes,
    allowOversizedObject: true,
  });
  const yieldNow = options.yieldNow;
  const guardedYieldNow =
    yieldNow === undefined
      ? undefined
      : (): Promise<void> => {
          let yielded: Promise<void> | undefined;
          runMutation(() => {
            yielded = yieldNow();
          });
          if (yielded === undefined) {
            throw new CorruptError("maintenance yield callback did not return a promise");
          }
          return yielded;
        };
  let result: PackIngestResult;
  try {
    result = await store.packs.ingest(source, {
      maxBytes: selectedLimits.maxStoredBytes,
      reclaimPending: false,
      now: () => nowMs,
      yieldNow: guardedYieldNow,
      lifecycle: {
        reserved: (packId) => {
          runMutation(() =>
            updateOwnedState(store.db, store.repoId, run, batch, "selected", "pending", packId, 0),
          );
        },
        published: (published) => {
          runMutation(() => {
            if (
              published.count !== batch.objectCount ||
              published.bytes < 1 ||
              published.bytes > selectedLimits.maxStoredBytes
            ) {
              throw new CorruptError("maintenance repack publication returned invalid bounds");
            }
            updateOwnedState(
              store.db,
              store.repoId,
              run,
              batch,
              "pending",
              "published",
              published.packId,
              published.bytes,
            );
          });
        },
      },
    });
  } catch (error) {
    if (runMutation(() => currentRootEpoch(store.db, store.repoId)) !== run.observedRootEpoch) {
      return rootChanged(run.runId);
    }
    throw error;
  }
  if (result.count !== batch.objectCount || result.bytes > selectedLimits.maxStoredBytes) {
    throw new CorruptError("maintenance repack ingest result disagrees with its batch");
  }
  return {
    runId: run.runId,
    status: "progress",
    boundary: "published",
    batchId: batch.batchId,
    packId: result.packId,
    objectCount: batch.objectCount,
  };
}

export function recoverPending(
  store: SharedRepoStore,
  run: RepackRun,
  batch: RepackBatch,
): MaintenanceRepackProgress {
  const packId = batch.packId;
  if (packId === null) throw new CorruptError("pending repack batch has no pack id");
  const state = store.db.one<Record<string, unknown>>(
    "SELECT repo_id, pack_id, state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
    store.repoId,
    packId,
  );
  if (state === undefined || state.repo_id !== store.repoId || state.pack_id !== packId) {
    throw new CorruptError("pending maintenance pack is missing");
  }
  if (state.state !== "pending") {
    if (state.state === "complete") {
      throw new CorruptError("pending maintenance owner references a complete pack");
    }
    throw new CorruptError("pending maintenance pack has an invalid state");
  }
  const removed = store.packs.discardPending(packId, (ownedPackId) => {
    const reset = store.db.one<Record<string, unknown>>(
      `UPDATE git_maintenance_repack_batches
          SET state = 'selected', pack_id = NULL, stored_bytes = 0
        WHERE repo_id = ? AND run_id = ? AND batch_id = ?
          AND state = 'pending' AND pack_id = ? AND stored_bytes = 0
          AND EXISTS (
            SELECT 1 FROM git_maintenance_runs run
            JOIN git_maintenance_control control ON control.repo_id = run.repo_id
             WHERE run.repo_id = ? AND run.run_id = ? AND run.phase = 'repack'
               AND run.observed_root_epoch = ? AND control.root_epoch = ?
          )
        RETURNING state, pack_id, stored_bytes`,
      store.repoId,
      run.runId,
      batch.batchId,
      ownedPackId,
      store.repoId,
      run.runId,
      run.observedRootEpoch,
      run.observedRootEpoch,
    );
    if (
      reset === undefined ||
      reset.state !== "selected" ||
      reset.pack_id !== null ||
      reset.stored_bytes !== 0
    ) {
      throw new CorruptError("pending maintenance ownership was not released atomically");
    }
  });
  if (!removed) throw new CorruptError("pending maintenance pack was not discarded");
  return {
    runId: run.runId,
    status: "progress",
    boundary: "selected",
    batchId: batch.batchId,
    packId: null,
    objectCount: batch.objectCount,
  };
}
