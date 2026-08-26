import { isOid } from "../core/bytes.js";
import { CorruptError, hasErrorCode } from "../core/errors.js";
import { hashObject, type ObjectType, type RawObject } from "../core/objects.js";
import { inflate } from "../core/zlib.js";
import { readBlob, type SqlDatabase } from "./db.js";

const MAX_MIGRATION_LOOSE_INPUTS = 4_096;
const MAX_MIGRATION_LOOSE_OBJECT_BYTES = 16 * 1024 * 1024;

interface LooseMetadataRow {
  oid: string;
  type: ObjectType;
  size: number;
  stored: string;
}

interface LooseDatabaseRow {
  oid: string;
  type: string;
  size: number;
  stored: string;
}

interface LooseAssembly {
  metadata: LooseMetadataRow;
  chunks: Uint8Array[];
  storedBytes: number;
}

function isObjectType(value: string): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

function requestedJson(oids: readonly string[]): string {
  if (oids.length > MAX_MIGRATION_LOOSE_INPUTS) {
    throw new CorruptError("schema v12 migration loose batch exceeds its input bound");
  }
  for (const oid of oids) {
    if (!isOid(oid)) throw new CorruptError("schema v12 migration requested an invalid loose oid");
  }
  return JSON.stringify(oids);
}

function readMetadata(
  db: SqlDatabase,
  repoId: number,
  oids: readonly string[],
): Map<string, LooseMetadataRow> {
  const rows = db.all<LooseDatabaseRow>(
    `SELECT object.oid, object.type, object.size, object.stored
       FROM json_each(?) requested
       JOIN git_objects object ON object.repo_id = ? AND object.oid = requested.value`,
    requestedJson(oids),
    repoId,
  );
  const metadata = new Map<string, LooseMetadataRow>();
  for (const row of rows) {
    if (
      !isOid(row.oid) ||
      !isObjectType(row.type) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > MAX_MIGRATION_LOOSE_OBJECT_BYTES ||
      (row.stored !== "raw" && row.stored !== "zlib") ||
      metadata.has(row.oid)
    ) {
      throw new CorruptError("schema v12 migration found invalid loose-object metadata");
    }
    metadata.set(row.oid, {
      oid: row.oid,
      type: row.type,
      size: row.size,
      stored: row.stored,
    });
  }
  return metadata;
}

function readLooseObjects(
  db: SqlDatabase,
  repoId: number,
  oids: readonly string[],
): Map<string, RawObject> {
  const json = requestedJson(oids);
  const metadata = readMetadata(db, repoId, oids);
  const assemblies = new Map<string, LooseAssembly>();
  for (const row of metadata.values()) {
    assemblies.set(row.oid, { metadata: row, chunks: [], storedBytes: 0 });
  }
  for (const row of db.iterate(
    `SELECT chunk.oid, chunk.seq, chunk.data
       FROM json_each(?) requested
       JOIN git_object_chunks chunk
         ON chunk.repo_id = ? AND chunk.oid = requested.value
      ORDER BY chunk.oid, chunk.seq`,
    json,
    repoId,
  )) {
    if (typeof row.oid !== "string" || !Number.isSafeInteger(row.seq)) {
      throw new CorruptError("schema v12 migration found invalid loose-object chunk metadata");
    }
    const assembly = assemblies.get(row.oid);
    if (assembly === undefined || row.seq !== assembly.chunks.length) {
      throw new CorruptError("schema v12 migration found non-contiguous loose-object chunks");
    }
    let data: Uint8Array;
    try {
      data = readBlob(row.data);
    } catch (error) {
      throw new CorruptError("schema v12 migration found a non-BLOB loose-object chunk", {
        cause: error,
      });
    }
    if (data.length > 1024 * 1024) {
      throw new CorruptError("schema v12 migration found an oversized loose-object chunk");
    }
    assembly.storedBytes += data.length;
    if (
      !Number.isSafeInteger(assembly.storedBytes) ||
      assembly.storedBytes > MAX_MIGRATION_LOOSE_OBJECT_BYTES
    ) {
      throw new CorruptError("schema v12 migration found oversized loose-object storage");
    }
    assembly.chunks.push(data);
  }

  const objects = new Map<string, RawObject>();
  for (const assembly of assemblies.values()) {
    const { metadata: row } = assembly;
    if (
      assembly.chunks.length === 0 ||
      (row.stored === "raw" && assembly.storedBytes !== row.size) ||
      (row.stored === "zlib" && assembly.storedBytes === 0)
    ) {
      throw new CorruptError("schema v12 migration found invalid loose-object chunks");
    }
    let stored: Uint8Array;
    let data: Uint8Array;
    try {
      stored = new Uint8Array(assembly.storedBytes);
      let offset = 0;
      for (const chunk of assembly.chunks) {
        stored.set(chunk, offset);
        offset += chunk.length;
      }
      data = row.stored === "raw" ? stored : inflate(stored);
    } catch (error) {
      throw new CorruptError("schema v12 migration could not decode a loose object", {
        cause: error,
      });
    }
    if (data.length !== row.size || hashObject(row.type, data) !== row.oid) {
      throw new CorruptError("schema v12 migration found corrupt loose-object bytes");
    }
    objects.set(row.oid, { type: row.type, data });
  }
  return objects;
}

export function readMigrationLooseObjects(
  db: SqlDatabase,
  repoId: number,
  oids: readonly string[],
): Map<string, RawObject> {
  try {
    return readLooseObjects(db, repoId, oids);
  } catch (error) {
    if (hasErrorCode(error, "ECORRUPT") || hasErrorCode(error, "E2BIG")) throw error;
    throw new CorruptError("schema v12 migration could not read loose objects", { cause: error });
  }
}

export function readMigrationLooseInfo(
  db: SqlDatabase,
  repoId: number,
  oids: readonly string[],
): Map<string, { type: ObjectType; size: number }> {
  try {
    const found = new Map<string, { type: ObjectType; size: number }>();
    for (const row of readMetadata(db, repoId, oids).values()) {
      if (!isObjectType(row.type)) {
        throw new CorruptError("schema v12 migration found an invalid loose object type");
      }
      found.set(row.oid, { type: row.type, size: row.size });
    }
    return found;
  } catch (error) {
    if (hasErrorCode(error, "ECORRUPT") || hasErrorCode(error, "E2BIG")) throw error;
    throw new CorruptError("schema v12 migration could not read loose metadata", { cause: error });
  }
}
