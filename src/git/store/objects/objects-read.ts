import { readBlob } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError, ObjectNotFoundError } from "../../common/errors.js";
import type { ObjectType, RawObject } from "../../common/objects.js";
import { int, nullable, oneOf, RowShape } from "../../common/rows.js";
import { InflateStream } from "../../common/zlib.js";
import type { ObjectReadBatch } from "../core/contracts.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../pack/packs.js";
import { looseRow } from "./objects-query.js";
import {
  INFLATE_FEED,
  type LooseEncoding,
  MAX_BLOB_BATCH_OIDS,
  type ObjectReadContext,
  parseLooseEncoding,
} from "./objects-shared.js";

interface ObjectReadMetadata {
  oid: string;
  source: "loose" | "pack";
  type: ObjectType;
  size: number;
}

const OBJECT_READ_ROW = new RowShape({
  source: nullable(oneOf(["loose", "pack"])),
  type: nullable(oneOf(["blob", "tree", "commit", "tag"])),
  size: nullable(int(0)),
});

export function readObjects(
  context: ObjectReadContext,
  oids: readonly string[],
  options: { budgetBytes?: number },
  readLooseObjects: (oids: readonly string[]) => Map<string, RawObject>,
): ObjectReadBatch {
  const budget = options.budgetBytes ?? PACK_BLOB_BATCH_TARGET_BYTES;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new RangeError("object read budget must be a positive safe integer");
  }
  const inputLength = oids.length;
  if (!Number.isSafeInteger(inputLength) || inputLength > MAX_BLOB_BATCH_OIDS) {
    throw new GitError("E2BIG", `object batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
  }
  const captured: string[] = [];
  for (let index = 0; index < inputLength; index++) {
    const oid = oids[index];
    if (typeof oid !== "string") throw new CorruptError("invalid object id input");
    captured.push(oid);
    if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
  }
  const seen = new Set<string>();
  const wanted: string[] = [];
  for (const oid of captured) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    wanted.push(oid);
  }
  if (wanted.length === 0) return { objects: new Map(), remaining: [], bytes: 0 };

  const encodedWanted = JSON.stringify(wanted);

  const rawMetadata = context.db.all<Record<string, unknown>>(
    `WITH wanted(ordinal, oid) AS (
       SELECT CAST(key AS INTEGER), value FROM json_each(?)
     )
     SELECT CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                  WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
            CASE WHEN loose.oid IS NOT NULL THEN loose.type
                 WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
            CASE WHEN loose.oid IS NOT NULL THEN loose.size
                 WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size
       FROM wanted w
       LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
       LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
      LEFT JOIN git_pack_meta pack
        ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
        AND pack.state = 'complete'
      ORDER BY w.ordinal`,
    encodedWanted,
    context.repoId,
    context.repoId,
  );
  if (rawMetadata.length !== wanted.length) {
    throw new CorruptError("object metadata lookup returned the wrong row count");
  }

  const metadata: ObjectReadMetadata[] = [];
  for (let index = 0; index < rawMetadata.length; index++) {
    const raw = rawMetadata[index];
    if (raw === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
    const row = OBJECT_READ_ROW.decode(raw);
    const oid = wanted[index];
    if (oid === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
    if (row.source === null) throw new ObjectNotFoundError(oid);
    if (row.type === null || row.size === null) {
      throw new CorruptError(`object ${oid} has invalid indexed metadata`);
    }
    metadata.push({
      oid,
      source: row.source,
      type: row.type,
      size: row.size,
    });
  }

  const selected: ObjectReadMetadata[] = [];
  let bytes = 0;
  for (const row of metadata) {
    if (row.size > Number.MAX_SAFE_INTEGER - bytes) {
      throw new GitError("E2BIG", "object read size accounting overflow");
    }
    if (selected.length > 0 && bytes + row.size > budget) break;
    selected.push(row);
    bytes += row.size;
    if (bytes >= budget) break;
  }

  const looseRows: ObjectReadMetadata[] = [];
  const packedOids: string[] = [];
  for (const row of selected) {
    if (row.source === "loose") {
      looseRows.push(row);
    } else {
      packedOids.push(row.oid);
    }
  }

  const remaining = wanted.slice(selected.length);
  const looseObjects = readLooseObjects(looseRows.map((row) => row.oid));
  const packed =
    packedOids.length === 0 ? new Map<string, RawObject>() : context.packs.readObjects(packedOids);
  const objects = new Map<string, RawObject>();
  for (const row of selected) {
    const object = (row.source === "loose" ? looseObjects : packed).get(row.oid);
    if (object === undefined || object.type !== row.type || object.data.length !== row.size) {
      throw new CorruptError(`object ${row.oid} did not produce its indexed bytes`);
    }
    objects.set(row.oid, object);
  }
  return { objects, remaining, bytes };
}

export function readObjectChunks(
  context: ObjectReadContext,
  oid: string,
): Iterable<Uint8Array> | null {
  const cached = context.objects.get(context.cacheKeys.objectCacheKey(oid));
  if (cached !== undefined) return [cached.data];
  if (context.cacheKeys.hasLoose) {
    const row = looseRow(context, oid);
    if (row !== null) return looseChunks(context, oid, parseLooseEncoding(row.stored));
  }
  const packed = context.packs.read(oid);
  return packed === null ? null : [packed.data];
}

function* looseChunks(
  context: ObjectReadContext,
  oid: string,
  stored: LooseEncoding,
): Generator<Uint8Array> {
  if (stored === "raw") {
    for (let seq = 0; ; seq++) {
      const row = context.db.one<{ data: unknown }>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
        context.repoId,
        oid,
        seq,
      );
      if (row === undefined) return;
      yield readBlob(row.data);
    }
  }
  const ready: Uint8Array[] = [];
  const stream = new InflateStream((chunk) => ready.push(chunk));
  for (let seq = 0; ; seq++) {
    const row = context.db.one<{ data: unknown }>(
      "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
      context.repoId,
      oid,
      seq,
    );
    if (row === undefined) break;
    const compressed = readBlob(row.data);
    for (let offset = 0; offset < compressed.length; offset += INFLATE_FEED) {
      stream.push(compressed.subarray(offset, offset + INFLATE_FEED));
      for (const chunk of ready) yield chunk;
      ready.length = 0;
    }
    if (compressed.length === 0) {
      for (const chunk of ready) yield chunk;
      ready.length = 0;
    }
  }
  for (const chunk of ready) yield chunk;
}
