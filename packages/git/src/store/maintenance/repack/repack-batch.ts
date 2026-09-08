import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { expectSafeInteger } from "../../../common/rows.js";
import {
  type LooseCandidate,
  MAX_REPACK_INFLATED_BYTES,
  MAX_REPACK_OBJECTS,
  MAX_REPACK_STORED_BYTES,
  type RepackBatch,
  type RepackLimits,
  type RepackRun,
} from "./repack-contracts.js";
import { objectType, oidField, packIdField, requireRepackedCapacity } from "./repack-helpers.js";

export function readBatch(
  db: SqlDatabase,
  repoId: number,
  expectedRunId: number,
): RepackBatch | null {
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
    const objectCount = expectSafeInteger(
      row.object_count,
      1,
      MAX_REPACK_OBJECTS,
      "repack batch object count",
    );
    const inflatedBytes = expectSafeInteger(
      row.inflated_bytes,
      0,
      Number.MAX_SAFE_INTEGER,
      "repack batch inflated bytes",
    );
    const storedBytes = expectSafeInteger(
      row.stored_bytes,
      0,
      MAX_REPACK_STORED_BYTES,
      "repack batch stored bytes",
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
      batchId: expectSafeInteger(row.batch_id, 1, Number.MAX_SAFE_INTEGER, "repack batch id"),
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
    const size = expectSafeInteger(row.size, 0, Number.MAX_SAFE_INTEGER, "repack batch size");
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
  const size = expectSafeInteger(
    row.size,
    0,
    Number.MAX_SAFE_INTEGER,
    "maintenance repack candidate size",
  );
  const chunkRows = expectSafeInteger(
    row.chunk_rows,
    1,
    Number.MAX_SAFE_INTEGER,
    "maintenance repack loose chunk count",
  );
  const largestChunk = expectSafeInteger(
    row.largest_chunk,
    0,
    Number.MAX_SAFE_INTEGER,
    "maintenance repack loose chunk size",
  );
  const storedBytes = expectSafeInteger(
    row.stored_bytes,
    0,
    Number.MAX_SAFE_INTEGER,
    "maintenance repack loose stored size",
  );
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
    if (
      expectSafeInteger(
        row.complete_size,
        0,
        Number.MAX_SAFE_INTEGER,
        "maintenance shadow size",
      ) !== size
    ) {
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

export function selectCandidates(
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

export function createBatch(
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
