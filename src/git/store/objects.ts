import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError } from "../common/errors.js";
import type { ByteLru } from "../common/lru.js";
import {
  hashObject,
  MAX_OBJECT_BYTES,
  type ObjectType,
  type RawObject,
} from "../common/objects.js";
import { blob as blobRow, int, nullable, oneOf, RowShape, text } from "../common/rows.js";
import { InflateInto, InflateSizeError } from "../common/zlib.js";
import type {
  BlobReadBatch,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
  OwnedObjectBatch,
} from "./contracts.js";
import { createObjectWriteBatch, writeObjects } from "./objects-batch.js";
import {
  hasAllObjects,
  hasObject,
  looseObjectMetadata,
  missingObjects,
  objectCount,
  objectInfo,
  objectTypeAndSize,
  resolveObjectPrefix,
} from "./objects-query.js";
import { readObjectChunks, readObjects } from "./objects-read.js";
import {
  INFLATE_FEED,
  OBJECT_CHUNK,
  type ObjectCacheKeys,
  type ObjectTableOwner,
  type ObjectWriteContext,
} from "./objects-shared.js";
import { writeObject, writeObjectStream } from "./objects-write.js";
import type { PackStore } from "./packs.js";
import type { Clock } from "./reflog.js";

export type {
  ChunkPayload,
  LooseEncoding,
  ObjectCacheKeys,
  ObjectTableOwner,
  StagedObject,
} from "./objects-shared.js";
export {
  COMMIT_STAGE_CACHE_BYTES,
  DEFAULT_OBJECT_FLUSH,
  encodeLoose,
  INFLATE_FEED,
  isObjectType,
  looseEncoding,
  MAX_BLOB_BATCH_OIDS,
  maximumDeflatedBytes,
  OBJECT_CHUNK,
  OBJECT_PAYLOAD,
  OID_PROBE_PAGE,
  parseLooseEncoding,
  RAW_OBJECT_MAX,
  requireCommitCacheWrites,
  STREAM_CHUNK,
} from "./objects-shared.js";

const LOOSE_PAYLOAD_ROW = new RowShape({
  ordinal: int(0),
  oid: text(),
  type: oneOf(["blob", "tree", "commit", "tag"]),
  size: int(0, MAX_OBJECT_BYTES),
  stored: oneOf(["raw", "zlib"]),
  seq: nullable(int(0)),
  data: nullable(blobRow()),
});

export function readAuthenticatedObjectOwned(
  store: ObjectTableOwner,
  oid: string,
  expectedType: ObjectType,
): RawObject | null {
  return store.readAuthenticatedObjectOwned(oid, expectedType);
}

export class ObjectTable {
  readonly #context: ObjectWriteContext;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    packs: PackStore,
    cacheKeys: ObjectCacheKeys,
    clock: Clock,
  ) {
    this.#context = { db, repoId, objects, packs, cacheKeys, clock };
  }

  has(oid: string): boolean {
    return hasObject(this.#context, oid);
  }

  /**
   * Which of `oids` this repository already holds, in one statement per
   * page. Both tables, deliberately: an `ON CONFLICT` on `git_objects`
   * alone cannot see a packed object, so after a clone an unchanged tree
   * would be re-written loose and shadow the packed copy.
   */
  hasAll(oids: Iterable<string>): Set<string> {
    return hasAllObjects(this.#context, oids);
  }

  /** The oids this repository does not hold, in input order, deduplicated. */
  missing(oids: Iterable<string>): string[] {
    return missingObjects(this.#context, oids);
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return objectTypeAndSize(this.#context, oid);
  }

  read(oid: string): RawObject | null {
    const cached = this.#context.objects.get(this.#context.cacheKeys.objectCacheKey(oid));
    if (cached !== undefined) return cached;
    return this.#readLoose(oid) ?? this.#context.packs.read(oid);
  }

  /** Cold-read and hash one authoritative loose or complete-pack object. */
  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#readAuthenticatedObject(oid, expectedType);
  }

  readAuthenticatedObjectOwned(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#readAuthenticatedObject(oid, expectedType);
  }

  #readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    const loose = this.#readLooseObjects([oid]).get(oid);
    if (loose === undefined) {
      return this.#context.packs.readAuthenticatedObject(oid, expectedType);
    }
    const cacheKey = this.#context.cacheKeys.objectCacheKey(oid);
    try {
      if (loose.type !== expectedType) {
        throw new CorruptError(`${oid} is a ${loose.type}, not a ${expectedType}`);
      }
      if (hashObject(loose.type, loose.data) !== oid) {
        throw new CorruptError(`loose ${expectedType} ${oid} does not match its bytes`);
      }
      return loose;
    } finally {
      this.#context.objects.delete(cacheKey);
    }
  }

  /** Validate bounded object metadata without reading payload bytes. */
  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return objectInfo(this.#context, oids);
  }

  /** Read a deduplicated prefix of mixed objects under an explicit byte budget. */
  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.readObjectsOwned(oids, options);
  }

  readObjectsOwned(oids: readonly string[], options: { budgetBytes?: number }): ObjectReadBatch {
    return readObjects(this.#context, oids, options, (wanted) => this.#readLooseObjects(wanted));
  }

  /** Read a deduplicated prefix of blobs under an explicit byte budget. */
  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    const batch = this.readObjectsOwned(oids, options);
    const blobs = new Map<string, Uint8Array>();
    for (const [oid, object] of batch.objects) {
      if (object.type !== "blob") throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
      blobs.set(oid, object.data);
    }
    return { blobs, remaining: batch.remaining, bytes: batch.bytes };
  }

  write(type: ObjectType, data: Uint8Array): string {
    return writeObject(this.#context, type, data);
  }

  /**
   * Write a loose object from a stream of chunks. `chunks` is a factory
   * because the content is read twice: once to hash it, which is how the oid
   * is known and how `has` can short-circuit before a single row is written,
   * and once to deflate and store it. Nothing larger than one chunk is ever
   * live, so the peak does not follow the object's size.
   */
  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return writeObjectStream(this.#context, type, size, chunks);
  }

  /**
   * Open a batch of loose object writes. However many objects go in, a
   * flush costs one existence probe, one delete, one insert per payload
   * budget and one metadata insert — not five statements per object.
   *
   * The caller owns the lifecycle; `writeObjects` is the scoped form that
   * cannot forget the final flush.
   */
  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return createObjectWriteBatch(this.#context, options);
  }

  writeBatchGuarded(options: ObjectBatchOptions, mutate: (body: () => void) => void): ObjectBatch {
    return createObjectWriteBatch(this.#context, options, mutate);
  }

  writeBatchOwned(options: ObjectBatchOptions): OwnedObjectBatch {
    return createObjectWriteBatch(this.#context, options);
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return writeObjects(this.#context, body, options);
  }

  /**
   * Inflated object bytes, chunk by chunk. A loose object really streams: its
   * rows are read one at a time and inflated incrementally. A packed object
   * yields exactly one chunk holding the whole thing, because a delta cannot
   * be reconstructed without its full base in memory. Null when unknown.
   */
  readChunks(oid: string): Iterable<Uint8Array> | null {
    return readObjectChunks(this.#context, oid);
  }

  /** Resolve an abbreviated oid. Null when unknown or ambiguous. */
  resolvePrefix(prefix: string): string | null {
    return resolveObjectPrefix(this.#context, prefix);
  }

  objectCount(): number {
    return objectCount(this.#context);
  }

  #readLoose(oid: string): RawObject | null {
    if (!this.#context.cacheKeys.hasLoose) return null;
    return this.#readLooseObjects([oid]).get(oid) ?? null;
  }

  /** Decode the joined payload cursor without retaining compressed rows between iterations. */
  #readLooseObjects(oids: readonly string[]): Map<string, RawObject> {
    if (oids.length === 0) return new Map();
    const wanted = [...new Set(oids)];
    const result = new Map<string, RawObject>();
    let current: {
      ordinal: number;
      oid: string;
      type: ObjectType;
      size: number;
      stored: "raw" | "zlib";
      nextSeq: number;
      encodedBytes: number;
      data: Uint8Array | null;
      inflater: InflateInto | null;
    } | null = null;

    const finishCurrent = (): void => {
      const state = current;
      if (state === null) return;
      let data: Uint8Array;
      if (state.nextSeq === 0) {
        throw new CorruptError(`loose blob ${state.oid} has no payload rows`);
      }
      if (state.stored === "raw") {
        if (state.encodedBytes !== state.size || state.data === null) {
          throw new CorruptError(`loose blob ${state.oid} size does not match its metadata`);
        }
        data = state.data;
      } else {
        if (state.encodedBytes === 0 || state.inflater?.ended !== true) {
          throw new CorruptError(`loose object ${state.oid} size does not match its metadata`);
        }
        try {
          data = state.inflater.finish();
        } catch (error) {
          throw new CorruptError(`loose object ${state.oid} size does not match its metadata`, {
            cause: error,
          });
        }
      }
      if (data.length !== state.size) {
        throw new CorruptError(`loose blob ${state.oid} size does not match its metadata`);
      }
      const object: RawObject = { type: state.type, data };
      this.#context.objects.set(this.#context.cacheKeys.objectCacheKey(state.oid), object);
      result.set(state.oid, object);
    };

    for (const raw of this.#context.db.iterate(
      `WITH /* loose-object-payload */ wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT wanted.ordinal, object.oid, object.type, object.size, object.stored,
              chunk.seq, chunk.data
         FROM wanted
         JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.oid
         LEFT JOIN git_object_chunks chunk
           ON chunk.repo_id = object.repo_id AND chunk.oid = object.oid
        ORDER BY wanted.ordinal, chunk.seq`,
      JSON.stringify(wanted),
      this.#context.repoId,
    )) {
      const row = LOOSE_PAYLOAD_ROW.decode(raw);
      const expectedOid = wanted[row.ordinal];
      if (expectedOid === undefined || row.oid !== expectedOid) {
        throw new CorruptError("loose object payload crossed object boundaries");
      }
      if (current === null || row.ordinal !== current.ordinal) {
        if (current !== null && row.ordinal <= current.ordinal) {
          throw new CorruptError("loose object payload returned out-of-order objects");
        }
        finishCurrent();
        current = {
          ordinal: row.ordinal,
          oid: row.oid,
          type: row.type,
          size: row.size,
          stored: row.stored,
          nextSeq: 0,
          encodedBytes: 0,
          data: row.stored === "raw" ? new Uint8Array(row.size) : null,
          inflater: row.stored === "zlib" ? new InflateInto(row.size) : null,
        };
      } else if (
        row.oid !== current.oid ||
        row.type !== current.type ||
        row.size !== current.size ||
        row.stored !== current.stored
      ) {
        throw new CorruptError(`loose object ${current.oid} metadata changed between payload rows`);
      }
      if (row.seq === null || row.data === null) {
        throw new CorruptError(`loose blob ${row.oid} has no payload rows`);
      }
      if (row.seq !== current.nextSeq) {
        throw new CorruptError(`loose blob ${row.oid} has an invalid chunk sequence`);
      }
      if (
        row.data.length === 0 &&
        !(current.stored === "raw" && current.size === 0 && row.seq === 0)
      ) {
        throw new CorruptError(`loose blob ${row.oid} has an empty payload row`);
      }
      if (row.data.length > OBJECT_CHUNK) {
        throw new CorruptError(`loose blob ${row.oid} has an oversized payload row`);
      }
      if (row.data.length > Number.MAX_SAFE_INTEGER - current.encodedBytes) {
        throw new CorruptError(`loose blob ${row.oid} encoded size overflowed`);
      }
      const offset = current.encodedBytes;
      current.encodedBytes += row.data.length;
      current.nextSeq++;
      if (current.stored === "raw") {
        if (current.data === null || current.encodedBytes > current.size) {
          throw new CorruptError(`loose blob ${row.oid} size does not match its metadata`);
        }
        current.data.set(row.data, offset);
        continue;
      }
      const inflater = current.inflater;
      if (inflater === null) throw new CorruptError(`loose object ${row.oid} lost its inflater`);
      for (let feedOffset = 0; feedOffset < row.data.length; feedOffset += INFLATE_FEED) {
        const input = row.data.subarray(feedOffset, feedOffset + INFLATE_FEED);
        let used: number;
        try {
          used = inflater.push(input);
        } catch (error) {
          if (error instanceof InflateSizeError) {
            throw new CorruptError(`loose object ${row.oid} exceeds its indexed size`, {
              cause: error,
            });
          }
          throw new CorruptError(`loose object ${row.oid} has invalid compressed bytes`, {
            cause: error,
          });
        }
        if (used <= 0 || (!inflater.ended && used !== input.length)) {
          throw new CorruptError(`loose object ${row.oid} inflater made no progress`);
        }
        if (used !== input.length) {
          throw new CorruptError(`loose object ${row.oid} has trailing compressed bytes`);
        }
      }
    }
    finishCurrent();
    return result;
  }

  #looseObjectMetadata(oids: readonly string[]): Map<string, { type: ObjectType; size: number }> {
    return looseObjectMetadata(this.#context, oids);
  }

  readLooseObjects(oids: readonly string[]): Map<string, RawObject> {
    return this.#readLooseObjects(oids);
  }

  looseObjectMetadata(oids: readonly string[]): Map<string, { type: ObjectType; size: number }> {
    return this.#looseObjectMetadata(oids);
  }
}
