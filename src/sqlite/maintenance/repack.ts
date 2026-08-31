import { isOid } from "../../core/bytes.js";
import { CorruptError, GitError } from "../../core/errors.js";
import type { ObjectType, RawObject } from "../../core/objects.js";
import {
  type FullObjectPackInput,
  type FullObjectPackReader,
  streamFullObjectPack,
} from "../../core/pack/full-object-stream.js";
import type { SqlDatabase } from "../db.js";
import { PACK_BLOB_BATCH_TARGET_BYTES, type PackIngestResult } from "../packs.js";
import type { SharedRepoStore } from "../store.js";
import {
  expectPhase,
  expectRootsSettled,
  type MaintenanceRunView,
  readMaintenanceRunView,
} from "./state.js";

const MAX_REPACK_OBJECTS = 2_048;
const MAX_REPACK_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_REPACK_STORED_BYTES = 64 * 1024 * 1024;

export type MaintenanceRepackStatus = "progress" | "complete" | "root-changed";
export type MaintenanceRepackBoundary = "selected" | "published" | "finalized" | null;

export interface MaintenanceRepackProgress {
  runId: number;
  status: MaintenanceRepackStatus;
  boundary: MaintenanceRepackBoundary;
  batchId: number | null;
  packId: number | null;
  objectCount: number;
}

export interface MaintenanceRepackOptions {
  maxObjects?: number;
  maxInflatedBytes?: number;
  maxStoredBytes?: number;
  readBatchBytes?: number;
  nowMs: number;
  yieldNow?: () => Promise<void>;
}

interface RepackLimits {
  maxObjects: number;
  maxInflatedBytes: number;
  maxStoredBytes: number;
  readBatchBytes: number;
}

type RepackRun = MaintenanceRunView & { phase: "repack" };

interface RepackBatch {
  batchId: number;
  state: "selected" | "pending" | "published";
  packId: number | null;
  objectCount: number;
  inflatedBytes: number;
  storedBytes: number;
  objects: FullObjectPackInput[];
}

interface LooseCandidate extends FullObjectPackInput {
  packId: number | null;
  baseOid: string | null;
}

interface FinalizedObject extends FullObjectPackInput {
  packId: number;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

function objectType(value: unknown, label: string): ObjectType {
  if (value !== "blob" && value !== "tree" && value !== "commit" && value !== "tag") {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

function oidField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) throw new CorruptError(`${label} is invalid`);
  return value;
}

function packIdField(value: unknown, label: string): number {
  return safeInteger(value, label, 0);
}

function optionLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
    throw new RangeError(`${label} must be an integer from 1 to ${fallback}`);
  }
  return selected;
}

function limits(options: MaintenanceRepackOptions): RepackLimits {
  return {
    maxObjects: optionLimit(options.maxObjects, MAX_REPACK_OBJECTS, "repack object limit"),
    maxInflatedBytes: optionLimit(
      options.maxInflatedBytes,
      MAX_REPACK_INFLATED_BYTES,
      "repack inflated-byte limit",
    ),
    maxStoredBytes: optionLimit(
      options.maxStoredBytes,
      MAX_REPACK_STORED_BYTES,
      "repack stored-byte limit",
    ),
    readBatchBytes: optionLimit(
      options.readBatchBytes,
      PACK_BLOB_BATCH_TARGET_BYTES,
      "repack read-batch limit",
    ),
  };
}

function readRun(db: SqlDatabase, repoId: number): RepackRun {
  const run = readMaintenanceRunView(db, repoId);
  if (run === null) {
    throw new GitError("ENOTFOUND", "maintenance repack run does not exist");
  }
  expectPhase(run, ["repack"], `maintenance repack cannot advance phase ${run.phase}`);
  expectRootsSettled(run);
  return run;
}

function currentRootEpoch(db: SqlDatabase, repoId: number): number {
  const row = db.one<Record<string, unknown>>(
    "SELECT repo_id, root_epoch FROM git_maintenance_control WHERE repo_id = ?",
    repoId,
  );
  if (row === undefined || row.repo_id !== repoId) {
    throw new CorruptError("maintenance root epoch is missing");
  }
  return safeInteger(row.root_epoch, "maintenance root epoch", 0);
}

function rootChanged(runId: number): MaintenanceRepackProgress {
  return {
    runId,
    status: "root-changed",
    boundary: null,
    batchId: null,
    packId: null,
    objectCount: 0,
  };
}

function readBatch(db: SqlDatabase, repoId: number, expectedRunId: number): RepackBatch | null {
  let header: RepackBatch | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `SELECT repo_id, run_id, batch_id, state, pack_id, object_count,
            inflated_bytes, stored_bytes
       FROM git_maintenance_repack_batches
      WHERE repo_id = ? LIMIT 2`,
    repoId,
  )) {
    rows++;
    if (rows > 1 || row.repo_id !== repoId || row.run_id !== expectedRunId) {
      throw new CorruptError("maintenance repack batch crossed run boundaries");
    }
    if (row.state !== "selected" && row.state !== "pending" && row.state !== "published") {
      throw new CorruptError("maintenance repack batch state is invalid");
    }
    const packId = row.pack_id === null ? null : packIdField(row.pack_id, "repack pack id");
    const objectCount = safeInteger(
      row.object_count,
      "repack batch object count",
      1,
      MAX_REPACK_OBJECTS,
    );
    const inflatedBytes = safeInteger(row.inflated_bytes, "repack batch inflated bytes", 0);
    const storedBytes = safeInteger(
      row.stored_bytes,
      "repack batch stored bytes",
      0,
      MAX_REPACK_STORED_BYTES,
    );
    if (
      (row.state === "selected" && (packId !== null || storedBytes !== 0)) ||
      (row.state === "pending" && (packId === null || storedBytes !== 0)) ||
      (row.state === "published" && (packId === null || storedBytes === 0)) ||
      (inflatedBytes > MAX_REPACK_INFLATED_BYTES && objectCount !== 1)
    ) {
      throw new CorruptError("maintenance repack batch header is inconsistent");
    }
    header = {
      batchId: safeInteger(row.batch_id, "repack batch id", 1),
      state: row.state,
      packId,
      objectCount,
      inflatedBytes,
      storedBytes,
      objects: [],
    };
  }
  if (header === null) return null;
  let ordinal = 0;
  let inflatedBytes = 0;
  let previousOid: string | null = null;
  for (const row of db.iterate(
    `SELECT repo_id, run_id, batch_id, oid, ordinal, type, size
       FROM git_maintenance_repack_objects
      WHERE repo_id = ? AND run_id = ? AND batch_id = ?
      ORDER BY ordinal LIMIT ?`,
    repoId,
    expectedRunId,
    header.batchId,
    header.objectCount + 1,
  )) {
    const oid = oidField(row.oid, "repack batch OID");
    if (
      row.repo_id !== repoId ||
      row.run_id !== expectedRunId ||
      row.batch_id !== header.batchId ||
      row.ordinal !== ordinal ||
      (previousOid !== null && oid <= previousOid)
    ) {
      throw new CorruptError("maintenance repack object order is invalid");
    }
    const type = objectType(row.type, "repack batch type");
    const size = safeInteger(row.size, "repack batch size", 0);
    if (size > Number.MAX_SAFE_INTEGER - inflatedBytes) {
      throw new CorruptError("maintenance repack inflated size is not representable");
    }
    inflatedBytes += size;
    header.objects.push({ oid, type, size });
    previousOid = oid;
    ordinal++;
  }
  if (
    ordinal !== header.objectCount ||
    header.objects.length !== header.objectCount ||
    inflatedBytes !== header.inflatedBytes
  ) {
    throw new CorruptError("maintenance repack batch membership is incomplete");
  }
  return header;
}

function validateLooseCandidate(row: Record<string, unknown>, repoId: number): LooseCandidate {
  if (row.repo_id !== repoId || row.run_id === null) {
    throw new CorruptError("maintenance repack candidate crossed repository boundaries");
  }
  if (row.expanded !== 1 || (row.physical_only !== 0 && row.physical_only !== 1)) {
    throw new CorruptError("maintenance repack candidate has invalid mark state");
  }
  const oid = oidField(row.oid, "maintenance repack candidate OID");
  const type = objectType(row.type, "maintenance repack candidate type");
  const size = safeInteger(row.size, "maintenance repack candidate size", 0);
  const chunkRows = safeInteger(row.chunk_rows, "maintenance repack loose chunk count", 1);
  const largestChunk = safeInteger(row.largest_chunk, "maintenance repack loose chunk size", 0);
  const storedBytes = safeInteger(row.stored_bytes, "maintenance repack loose stored size", 0);
  if (
    (row.stored !== "raw" && row.stored !== "zlib") ||
    row.first_chunk !== 0 ||
    row.last_chunk !== chunkRows - 1 ||
    largestChunk > 1024 * 1024 ||
    (row.stored === "raw" && storedBytes !== size) ||
    (row.stored === "zlib" && storedBytes === 0)
  ) {
    throw new CorruptError("maintenance repack candidate has invalid loose metadata");
  }
  let packId: number | null = null;
  let baseOid: string | null = null;
  if (row.complete_pack_id !== null) {
    packId = packIdField(row.complete_pack_id, "maintenance shadow pack id");
    if (objectType(row.complete_type, "maintenance shadow type") !== type) {
      throw new CorruptError("maintenance packed shadow has the wrong type");
    }
    if (safeInteger(row.complete_size, "maintenance shadow size", 0) !== size) {
      throw new CorruptError("maintenance packed shadow has the wrong size");
    }
    baseOid =
      row.complete_base_oid === null ? null : oidField(row.complete_base_oid, "shadow base");
  } else if (
    row.complete_type !== null ||
    row.complete_size !== null ||
    row.complete_base_oid !== null
  ) {
    throw new CorruptError("absent maintenance packed shadow returned metadata");
  }
  return { oid, type, size, packId, baseOid };
}

function requireRepackedCapacity(run: RepackRun, objectCount: number): void {
  if (
    !Number.isSafeInteger(objectCount) ||
    objectCount < 0 ||
    objectCount > Number.MAX_SAFE_INTEGER - run.repackedObjects
  ) {
    throw new GitError("E2BIG", "maintenance repacked counter is exhausted");
  }
}

function selectCandidates(
  db: SqlDatabase,
  repoId: number,
  run: RepackRun,
  selectedLimits: RepackLimits,
): { objects: LooseCandidate[]; shadows: boolean } {
  const objects: LooseCandidate[] = [];
  let inflatedBytes = 0;
  let previousOid: string | null = null;
  let shadows: boolean | null = null;
  for (const row of db.iterate(
    `SELECT mark.repo_id, mark.run_id, mark.oid, mark.expanded, mark.physical_only,
            loose.type, loose.size, loose.stored,
            (SELECT count(*) FROM git_object_chunks chunk
              WHERE chunk.repo_id = loose.repo_id AND chunk.oid = loose.oid) AS chunk_rows,
            (SELECT min(seq) FROM git_object_chunks chunk
              WHERE chunk.repo_id = loose.repo_id AND chunk.oid = loose.oid) AS first_chunk,
            (SELECT max(seq) FROM git_object_chunks chunk
              WHERE chunk.repo_id = loose.repo_id AND chunk.oid = loose.oid) AS last_chunk,
            coalesce((SELECT max(length(data)) FROM git_object_chunks chunk
              WHERE chunk.repo_id = loose.repo_id AND chunk.oid = loose.oid), 0) AS largest_chunk,
            coalesce((SELECT sum(length(data)) FROM git_object_chunks chunk
              WHERE chunk.repo_id = loose.repo_id AND chunk.oid = loose.oid), 0) AS stored_bytes,
            complete.pack_id AS complete_pack_id,
            CASE WHEN complete.pack_id IS NOT NULL THEN packed.type END AS complete_type,
            CASE WHEN complete.pack_id IS NOT NULL THEN packed.size END AS complete_size,
            CASE WHEN complete.pack_id IS NOT NULL THEN packed.base_oid END AS complete_base_oid
       FROM git_maintenance_objects mark
       JOIN git_objects loose ON loose.repo_id = mark.repo_id AND loose.oid = mark.oid
       LEFT JOIN git_pack_objects packed ON packed.repo_id = mark.repo_id AND packed.oid = mark.oid
       LEFT JOIN git_pack_meta complete
         ON complete.repo_id = packed.repo_id AND complete.pack_id = packed.pack_id
        AND complete.state = 'complete'
      WHERE mark.repo_id = ? AND mark.run_id = ?
      ORDER BY mark.oid COLLATE BINARY LIMIT ${MAX_REPACK_OBJECTS + 1}`,
    repoId,
    run.runId,
  )) {
    const candidate = validateLooseCandidate(row, repoId);
    if (row.run_id !== run.runId || (previousOid !== null && candidate.oid <= previousOid)) {
      throw new CorruptError("maintenance repack candidate order is invalid");
    }
    previousOid = candidate.oid;
    const candidateIsShadow = candidate.packId !== null;
    if (shadows === null) shadows = candidateIsShadow;
    if (candidateIsShadow !== shadows || objects.length >= selectedLimits.maxObjects) break;
    if (!candidateIsShadow) {
      if (candidate.size > Number.MAX_SAFE_INTEGER - inflatedBytes) {
        throw new GitError("E2BIG", "maintenance repack inflated size is not representable");
      }
      const nextBytes = inflatedBytes + candidate.size;
      if (objects.length > 0 && nextBytes > selectedLimits.maxInflatedBytes) break;
      inflatedBytes = nextBytes;
    }
    objects.push(candidate);
  }
  return { objects, shadows: shadows === true };
}

function createBatch(
  db: SqlDatabase,
  repoId: number,
  run: RepackRun,
  candidates: readonly LooseCandidate[],
): RepackBatch {
  if (candidates.length === 0) throw new CorruptError("maintenance selected an empty repack batch");
  requireRepackedCapacity(run, candidates.length);
  const batchId = run.repackedObjects + 1;
  const inflatedBytes = candidates.reduce((total, object) => total + object.size, 0);
  const objects = candidates.map(({ oid, type, size }) => ({ oid, type, size }));
  db.transactionSync(() => {
    const inserted = db.one<Record<string, unknown>>(
      `INSERT INTO git_maintenance_repack_batches
         (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
       SELECT ?, ?, ?, 'selected', NULL, ?, ?, 0
        WHERE EXISTS (
          SELECT 1 FROM git_maintenance_runs run
          JOIN git_maintenance_control control ON control.repo_id = run.repo_id
           WHERE run.repo_id = ? AND run.run_id = ? AND run.phase = 'repack'
             AND run.observed_root_epoch = ? AND control.root_epoch = ?
        )
       RETURNING repo_id, run_id, batch_id, state, object_count, inflated_bytes`,
      repoId,
      run.runId,
      batchId,
      objects.length,
      inflatedBytes,
      repoId,
      run.runId,
      run.observedRootEpoch,
      run.observedRootEpoch,
    );
    if (
      inserted === undefined ||
      inserted.repo_id !== repoId ||
      inserted.run_id !== run.runId ||
      inserted.batch_id !== batchId ||
      inserted.state !== "selected" ||
      inserted.object_count !== objects.length ||
      inserted.inflated_bytes !== inflatedBytes
    ) {
      throw new CorruptError("maintenance repack selection was not published atomically");
    }
    db.run(
      `INSERT INTO git_maintenance_repack_objects
         (repo_id, run_id, batch_id, oid, ordinal, type, size)
       SELECT ?, ?, ?, json_extract(value, '$.oid'), CAST(key AS INTEGER),
              json_extract(value, '$.type'), json_extract(value, '$.size')
         FROM json_each(?)`,
      repoId,
      run.runId,
      batchId,
      JSON.stringify(objects),
    );
    const count = db.one<Record<string, unknown>>(
      `SELECT count(*) AS object_count, coalesce(sum(object.size), 0) AS inflated_bytes,
              coalesce(sum(CASE WHEN loose.oid IS NULL OR loose.type != object.type
                                     OR loose.size != object.size OR mark.expanded != 1
                                THEN 1 ELSE 0 END), 0) AS invalid
         FROM git_maintenance_repack_objects object
         LEFT JOIN git_objects loose ON loose.repo_id = object.repo_id AND loose.oid = object.oid
         LEFT JOIN git_maintenance_objects mark
           ON mark.repo_id = object.repo_id AND mark.run_id = object.run_id
          AND mark.oid = object.oid
        WHERE object.repo_id = ? AND object.run_id = ? AND object.batch_id = ?`,
      repoId,
      run.runId,
      batchId,
    );
    if (
      count === undefined ||
      count.object_count !== objects.length ||
      count.inflated_bytes !== inflatedBytes ||
      count.invalid !== 0
    ) {
      throw new CorruptError("maintenance repack selection lost an authoritative loose object");
    }
  });
  return {
    batchId,
    state: "selected",
    packId: null,
    objectCount: objects.length,
    inflatedBytes,
    storedBytes: 0,
    objects,
  };
}

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

function selectedBatchShadows(
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

async function publishBatch(
  store: SharedRepoStore,
  run: RepackRun,
  batch: RepackBatch,
  selectedLimits: RepackLimits,
  options: MaintenanceRepackOptions,
  nowMs: number,
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
  let result: PackIngestResult;
  try {
    result = await store.packs.ingest(source, {
      maxBytes: selectedLimits.maxStoredBytes,
      reclaimPending: false,
      now: () => nowMs,
      yieldNow: options.yieldNow,
      lifecycle: {
        reserved: (packId) => {
          updateOwnedState(store.db, store.repoId, run, batch, "selected", "pending", packId, 0);
        },
        published: (published) => {
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
        },
      },
    });
  } catch (error) {
    if (currentRootEpoch(store.db, store.repoId) !== run.observedRootEpoch) {
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

function recoverPending(
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

function verifyCompletePack(
  db: SqlDatabase,
  repoId: number,
  batch: RepackBatch,
  packId: number,
): void {
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT object.repo_id, object.pack_id, object.oid, object.type, object.size,
            object.base_oid, pack.state, pack.count, pack.size AS stored_bytes
       FROM git_pack_entries object
       JOIN git_pack_meta pack
         ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
      WHERE object.repo_id = ? AND object.pack_id = ?
      ORDER BY object.oid COLLATE BINARY LIMIT ?`,
    repoId,
    packId,
    batch.objectCount + 1,
  )) {
    const expected = batch.objects[ordinal];
    if (
      expected === undefined ||
      row.repo_id !== repoId ||
      row.pack_id !== packId ||
      row.oid !== expected.oid ||
      row.type !== expected.type ||
      row.size !== expected.size ||
      row.base_oid !== null ||
      row.state !== "complete" ||
      row.count !== batch.objectCount ||
      row.stored_bytes !== batch.storedBytes
    ) {
      throw new CorruptError("maintenance complete pack membership is invalid");
    }
    ordinal++;
  }
  if (ordinal !== batch.objectCount) {
    throw new CorruptError("maintenance complete pack membership is incomplete");
  }
}

function finalizedPackedSources(
  db: SqlDatabase,
  repoId: number,
  objects: readonly FullObjectPackInput[],
): FinalizedObject[] {
  const finalized: FinalizedObject[] = [];
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT CAST(input.key AS INTEGER) AS ordinal,
            json_extract(input.value, '$.oid') AS expected_oid,
            json_extract(input.value, '$.type') AS expected_type,
            json_extract(input.value, '$.size') AS expected_size,
            packed.oid, packed.pack_id, packed.offset, packed.data_off, packed.data_len,
            packed.type, packed.size, packed.entry_size, packed.base_oid,
            pack.state, pack.size AS stored_bytes,
            EXISTS (
              SELECT 1 FROM git_pack_entries entry
               WHERE entry.repo_id = packed.repo_id AND entry.pack_id = packed.pack_id
                 AND entry.oid = packed.oid AND entry.offset = packed.offset
                 AND entry.data_off = packed.data_off AND entry.data_len = packed.data_len
                 AND entry.type = packed.type AND entry.size = packed.size
                 AND entry.entry_size = packed.entry_size
                 AND entry.base_oid IS packed.base_oid
            ) AS exact_source
       FROM json_each(?) input
       LEFT JOIN git_pack_objects packed
         ON packed.repo_id = ? AND packed.oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
      ORDER BY CAST(input.key AS INTEGER)`,
    JSON.stringify(objects),
    repoId,
  )) {
    const expected = objects[ordinal];
    const packId = row.pack_id;
    const offset = row.offset;
    const dataOff = row.data_off;
    const dataLen = row.data_len;
    const entrySize = row.entry_size;
    const storedBytes = row.stored_bytes;
    if (
      expected === undefined ||
      row.ordinal !== ordinal ||
      row.expected_oid !== expected.oid ||
      row.expected_type !== expected.type ||
      row.expected_size !== expected.size ||
      row.oid !== expected.oid ||
      typeof packId !== "number" ||
      !Number.isSafeInteger(packId) ||
      packId < 0 ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof dataOff !== "number" ||
      !Number.isSafeInteger(dataOff) ||
      dataOff < offset ||
      typeof dataLen !== "number" ||
      !Number.isSafeInteger(dataLen) ||
      dataLen < 0 ||
      typeof storedBytes !== "number" ||
      !Number.isSafeInteger(storedBytes) ||
      storedBytes < 0 ||
      dataOff > storedBytes - dataLen ||
      row.type !== expected.type ||
      row.size !== expected.size ||
      typeof entrySize !== "number" ||
      !Number.isSafeInteger(entrySize) ||
      entrySize < 0 ||
      (row.base_oid !== null && (typeof row.base_oid !== "string" || !isOid(row.base_oid))) ||
      row.state !== "complete" ||
      row.exact_source !== 1
    ) {
      throw new CorruptError("maintenance finalized object has no authenticated packed source");
    }
    finalized.push({ ...expected, packId });
    ordinal++;
  }
  if (ordinal !== objects.length) {
    throw new CorruptError("maintenance finalized packed source validation is incomplete");
  }
  return finalized;
}

function verifyFinalizedSources(
  db: SqlDatabase,
  repoId: number,
  objects: readonly FinalizedObject[],
): void {
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT CAST(input.key AS INTEGER) AS ordinal,
            json_extract(input.value, '$.oid') AS oid,
            json_extract(input.value, '$.type') AS type,
            json_extract(input.value, '$.size') AS size,
            json_extract(input.value, '$.packId') AS pack_id,
            loose.oid AS loose_oid,
            packed.type AS packed_type, packed.size AS packed_size,
            packed.base_oid, pack.state AS pack_state,
            effective.source_key AS effective_source_key,
            source.source_key, source.storage, source.source_id,
            source.complete AS source_complete, source.object_size AS source_size,
            cached.oid AS commit_oid, cached.object_size AS commit_size
       FROM json_each(?) input
       LEFT JOIN git_objects loose
         ON loose.repo_id = ? AND loose.oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_pack_objects packed
         ON packed.repo_id = ? AND packed.oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
       LEFT JOIN git_tree_effective effective
         ON effective.repo_id = ? AND effective.tree_oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_tree_sources source ON source.source_key = effective.source_key
       LEFT JOIN git_commits cached
         ON cached.repo_id = ? AND cached.oid = json_extract(input.value, '$.oid')
      ORDER BY CAST(input.key AS INTEGER)`,
    JSON.stringify(objects),
    repoId,
    repoId,
    repoId,
    repoId,
  )) {
    const expected = objects[ordinal];
    if (
      expected === undefined ||
      row.ordinal !== ordinal ||
      row.oid !== expected.oid ||
      row.type !== expected.type ||
      row.size !== expected.size ||
      row.pack_id !== expected.packId ||
      row.loose_oid !== null ||
      row.packed_type !== expected.type ||
      row.packed_size !== expected.size ||
      row.pack_state !== "complete"
    ) {
      throw new CorruptError("maintenance finalized object lost its packed source");
    }
    if (
      expected.type === "tree" &&
      (typeof row.effective_source_key !== "number" ||
        row.effective_source_key !== row.source_key ||
        row.storage !== "pack" ||
        row.source_id !== expected.packId ||
        row.source_complete !== 1 ||
        row.source_size !== expected.size)
    ) {
      throw new CorruptError("maintenance finalized tree lost its effective packed source");
    }
    if (
      expected.type === "commit" &&
      (row.commit_oid !== expected.oid || row.commit_size !== expected.size)
    ) {
      throw new CorruptError("maintenance finalized commit lost its packed projection");
    }
    ordinal++;
  }
  if (ordinal !== objects.length) {
    throw new CorruptError("maintenance finalized source validation is incomplete");
  }
}

function deleteExactLooseObjects(
  db: SqlDatabase,
  repoId: number,
  objects: readonly FullObjectPackInput[],
): void {
  if (objects.length < 1 || objects.length > MAX_REPACK_OBJECTS) {
    throw new CorruptError("maintenance loose deletion set is not bounded");
  }
  const encoded = JSON.stringify(objects);
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT CAST(input.key AS INTEGER) AS ordinal,
            json_extract(input.value, '$.oid') AS expected_oid,
            json_extract(input.value, '$.type') AS expected_type,
            json_extract(input.value, '$.size') AS expected_size,
            loose.oid, loose.type, loose.size,
            lifecycle.oid AS lifecycle_oid, lifecycle.created_ms
       FROM json_each(?) input
       LEFT JOIN git_objects loose
         ON loose.repo_id = ? AND loose.oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_loose_object_lifecycle lifecycle
         ON lifecycle.repo_id = loose.repo_id AND lifecycle.oid = loose.oid
      ORDER BY CAST(input.key AS INTEGER)`,
    encoded,
    repoId,
  )) {
    const expected = objects[ordinal];
    if (
      expected === undefined ||
      row.ordinal !== ordinal ||
      row.expected_oid !== expected.oid ||
      row.expected_type !== expected.type ||
      row.expected_size !== expected.size ||
      row.oid !== expected.oid ||
      row.type !== expected.type ||
      row.size !== expected.size ||
      row.lifecycle_oid !== expected.oid
    ) {
      throw new CorruptError("maintenance loose deletion set is incomplete");
    }
    safeInteger(row.created_ms, "maintenance loose lifecycle timestamp", 0);
    ordinal++;
  }
  if (ordinal !== objects.length) {
    throw new CorruptError("maintenance loose deletion set is incomplete");
  }

  const remaining = new Map<string, FullObjectPackInput>();
  for (const object of objects) {
    if (remaining.has(object.oid)) {
      throw new CorruptError("maintenance loose deletion set contains duplicate OIDs");
    }
    remaining.set(object.oid, object);
  }
  let deleted = 0;
  for (const row of db.iterate(
    `DELETE FROM git_objects
      WHERE repo_id = ?
        AND oid IN (SELECT json_extract(value, '$.oid') FROM json_each(?))
      RETURNING oid, type, size`,
    repoId,
    encoded,
  )) {
    const oid = oidField(row.oid, "deleted maintenance loose OID");
    const expected = remaining.get(oid);
    if (
      expected === undefined ||
      objectType(row.type, "deleted maintenance loose type") !== expected.type ||
      safeInteger(row.size, "deleted maintenance loose size", 0) !== expected.size
    ) {
      throw new CorruptError("maintenance loose deletion returned an unexpected object");
    }
    remaining.delete(oid);
    deleted++;
  }
  if (deleted !== objects.length || remaining.size !== 0) {
    throw new CorruptError("maintenance loose deletion was incomplete");
  }
  const absent = db.one<Record<string, unknown>>(
    `SELECT count(loose.oid) AS loose_count,
            count(lifecycle.oid) AS lifecycle_count
       FROM json_each(?) input
       LEFT JOIN git_objects loose
         ON loose.repo_id = ? AND loose.oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_loose_object_lifecycle lifecycle
         ON lifecycle.repo_id = ? AND lifecycle.oid = json_extract(input.value, '$.oid')`,
    encoded,
    repoId,
    repoId,
  );
  if (absent?.loose_count !== 0 || absent.lifecycle_count !== 0) {
    throw new CorruptError("maintenance loose deletion left authoritative rows behind");
  }
}

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

function finalizePublished(
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
  store.revalidateStorageCaches();
  return {
    runId: run.runId,
    status: "progress",
    boundary: "finalized",
    batchId: batch.batchId,
    packId,
    objectCount: batch.objectCount,
  };
}

function finalizeShadows(
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
  store.revalidateStorageCaches();
  return {
    runId: run.runId,
    status: "progress",
    boundary: "finalized",
    batchId: null,
    packId: null,
    objectCount: finalized.length,
  };
}

function finalizeSelectedShadows(
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
  store.revalidateStorageCaches();
  return {
    runId: run.runId,
    status: "progress",
    boundary: "finalized",
    batchId: batch.batchId,
    packId: null,
    objectCount: shadows.length,
  };
}

function transitionToClassifyPacks(db: SqlDatabase, repoId: number, run: RepackRun): void {
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

/** Advance one bounded durable repack boundary for the active repository run. */
export async function advanceMaintenanceRepack(
  store: SharedRepoStore,
  options: MaintenanceRepackOptions,
): Promise<MaintenanceRepackProgress> {
  if (!Number.isSafeInteger(store.repoId) || store.repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
  const nowMs = options.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("maintenance repack clock must be a non-negative safe integer");
  }
  const selectedLimits = limits(options);
  const run = readRun(store.db, store.repoId);
  if (run.observedRootEpoch !== run.rootEpoch) {
    return rootChanged(run.runId);
  }
  const batch = readBatch(store.db, store.repoId, run.runId);
  if (batch !== null) requireRepackedCapacity(run, batch.objectCount);
  if (batch?.state === "pending") return recoverPending(store, run, batch);
  if (batch?.state === "published") return finalizePublished(store, run, batch);
  if (batch?.state === "selected") {
    const shadows = selectedBatchShadows(store.db, store.repoId, run.runId, batch);
    if (shadows.length > 0) return finalizeSelectedShadows(store, run, batch, shadows);
    return publishBatch(store, run, batch, selectedLimits, options, nowMs);
  }

  const selected = selectCandidates(store.db, store.repoId, run, selectedLimits);
  if (selected.objects.length === 0) {
    transitionToClassifyPacks(store.db, store.repoId, run);
    return {
      runId: run.runId,
      status: "complete",
      boundary: null,
      batchId: null,
      packId: null,
      objectCount: 0,
    };
  }
  requireRepackedCapacity(run, selected.objects.length);
  if (selected.shadows) return finalizeShadows(store, run, selected.objects);
  const created = createBatch(store.db, store.repoId, run, selected.objects);
  return {
    runId: run.runId,
    status: "progress",
    boundary: "selected",
    batchId: created.batchId,
    packId: null,
    objectCount: created.objectCount,
  };
}
