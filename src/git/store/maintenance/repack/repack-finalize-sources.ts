import type { SqlDatabase } from "../../../../db/db.js";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { FullObjectPackInput } from "../../pack/full-object-stream.js";
import { type FinalizedObject, MAX_REPACK_OBJECTS, type RepackBatch } from "./repack-contracts.js";
import { objectType, oidField, safeInteger } from "./repack-helpers.js";

export function verifyCompletePack(
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

export function finalizedPackedSources(
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

export function verifyFinalizedSources(
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

export function deleteExactLooseObjects(
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
