import pako from "pako";
import { blob, readBlob, type SqlDatabase } from "../../db/db.js";
import { concat, isOid, toHex } from "../common/bytes.js";
import { CorruptError, GitError, ObjectNotFoundError } from "../common/errors.js";
import type { ByteLru } from "../common/lru.js";
import {
  hashObject,
  MAX_OBJECT_BYTES,
  type ObjectType,
  objectHeader,
  type RawObject,
} from "../common/objects.js";
import { blob as blobRow, int, nullable, oneOf, RowShape, text } from "../common/rows.js";
import { Sha1 } from "../common/sha1.js";
import { deflate, InflateInto, InflateSizeError, InflateStream } from "../common/zlib.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  insertCommitCaches,
  prepareCommitCache,
} from "./commits.js";
import { nextPrefix } from "./config.js";
import type {
  BlobReadBatch,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
  OwnedObjectBatch,
} from "./contracts.js";
import { isThenableResult } from "./json-pages.js";
import { PACK_BLOB_BATCH_TARGET_BYTES, type PackStore } from "./packs.js";
import type { Clock } from "./reflog.js";
import { indexSeededTreeSource, indexSeededTreeSources } from "./tree-index.js";

/** Bytes per `git_object_chunks` row. */
export const OBJECT_CHUNK = 1024 * 1024;

/** Small loose objects cost more to deflate than storing their bytes directly. */
export const RAW_OBJECT_MAX = 4 * 1024;

/** Deflate output chunk, and one row, for a streamed write. Smaller than
 *  OBJECT_CHUNK so a streamed object's peak is a chunk, not a megabyte. */
export const STREAM_CHUNK = 64 * 1024;

/** Compressed bytes fed to the inflater at a time when streaming a read. */
export const INFLATE_FEED = 16 * 1024;

/** Compressed bytes gathered into one `substr()` payload, and the trigger
 *  that flushes a batch. Well under the 2 MB ceiling on a bound value. */
export const OBJECT_PAYLOAD = 1024 * 1024;

/** Objects buffered before a batch flushes. The JSON arrays are bound
 *  values too, so the row count is capped as well as the byte count. */
export const DEFAULT_OBJECT_FLUSH = 4096;

/** Oids per existence-probe statement, bounding the same JSON parameter. */
export const OID_PROBE_PAGE = 4096;

export const MAX_BLOB_BATCH_OIDS = 4096;

/** Parsed commits staged beside encoded object bytes before a batch flush. */
export const COMMIT_STAGE_CACHE_BYTES = 16 * 1024 * 1024;

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
const OBJECT_INFO_ROW = new RowShape({
  source: nullable(oneOf(["loose", "pack"])),
  type: nullable(oneOf(["blob", "tree", "commit", "tag"])),
  size: nullable(int(0)),
  stored: nullable(oneOf(["raw", "zlib"])),
  chunk_rows: int(0),
  first_chunk: nullable(int(0)),
  last_chunk: nullable(int(0)),
  largest_chunk: int(0),
  stored_bytes: int(0),
});

const LOOSE_PAYLOAD_ROW = new RowShape({
  ordinal: int(0),
  oid: text(),
  type: oneOf(["blob", "tree", "commit", "tag"]),
  size: int(0, MAX_OBJECT_BYTES),
  stored: oneOf(["raw", "zlib"]),
  seq: nullable(int(0)),
  data: nullable(blobRow()),
});

export type LooseEncoding = "raw" | "zlib";

/** One object staged in a batch, already hashed and encoded for storage. */
export interface StagedObject {
  oid: string;
  type: ObjectType;
  size: number;
  stored: LooseEncoding;
  storedData: Uint8Array;
  treeData?: Uint8Array;
  commitEntry?: CommitCacheEntry;
}

/** One `substr()` payload: the bytes, and the rows cut out of them. */
export interface ChunkPayload {
  parts: Uint8Array[];
  length: number;
  rows: { o: string; q: number; a: number; n: number }[];
}

export interface ObjectCacheKeys {
  readonly hasLoose: boolean;
  markLoose(): void;
  objectCacheKey(oid: string): string;
}

export interface ObjectTableOwner {
  readAuthenticatedObjectOwned(oid: string, expectedType: ObjectType): RawObject | null;
}

export function readAuthenticatedObjectOwned(
  store: ObjectTableOwner,
  oid: string,
  expectedType: ObjectType,
): RawObject | null {
  return store.readAuthenticatedObjectOwned(oid, expectedType);
}

/** The store never accepts an object it could not later return in one buffer. */
function requireStorableObjectSize(type: ObjectType, size: number): void {
  if (size > MAX_OBJECT_BYTES) {
    throw new GitError(
      "E2BIG",
      `${type} object of ${size} bytes exceeds the ${MAX_OBJECT_BYTES}-byte object limit`,
    );
  }
}

export function requireCommitCacheWrites(result: CommitCacheWriteResult, expected: number): void {
  if (result.written !== result.eligible || result.eligible + result.skipped !== expected) {
    throw new CorruptError(`commit cache wrote ${result.written} of ${expected} required rows`);
  }
}

export function looseEncoding(size: number): LooseEncoding {
  return size <= RAW_OBJECT_MAX ? "raw" : "zlib";
}

export function encodeLoose(data: Uint8Array, stored: LooseEncoding): Uint8Array {
  return stored === "raw" ? data : deflate(data);
}

export function maximumDeflatedBytes(bytes: number): number {
  const maximum =
    bytes +
    Math.floor(bytes / 4_096) +
    Math.floor(bytes / 16_384) +
    Math.floor(bytes / 33_554_432) +
    13;
  if (!Number.isSafeInteger(maximum)) {
    throw new GitError("E2BIG", "object compression memory accounting overflow");
  }
  return maximum;
}

export function parseLooseEncoding(stored: string): LooseEncoding {
  if (stored === "raw" || stored === "zlib") return stored;
  throw new CorruptError(`loose object has unknown storage encoding '${stored}'`);
}

export function isObjectType(value: string | null): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

export class ObjectTable {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packs: PackStore;
  readonly #cacheKeys: ObjectCacheKeys;
  readonly #clock: Clock;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    packs: PackStore,
    cacheKeys: ObjectCacheKeys,
    clock: Clock,
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#objects = objects;
    this.#packs = packs;
    this.#cacheKeys = cacheKeys;
    this.#clock = clock;
  }

  has(oid: string): boolean {
    if (this.#cacheKeys.hasLoose && this.#looseRow(oid) !== null) return true;
    return this.#packs.typeAndSize(oid) !== null;
  }

  /**
   * Which of `oids` this repository already holds, in one statement per
   * page. Both tables, deliberately: an `ON CONFLICT` on `git_objects`
   * alone cannot see a packed object, so after a clone an unchanged tree
   * would be re-written loose and shadow the packed copy.
   */
  hasAll(oids: Iterable<string>): Set<string> {
    const found = new Set<string>();
    let page: string[] = [];
    const probe = (): void => {
      if (page.length === 0) return;
      for (const row of this.#db.all<{ oid: string }>(
        `SELECT j.value AS oid FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM git_objects o WHERE o.repo_id = ? AND o.oid = j.value)
             OR EXISTS (
               SELECT 1 FROM git_pack_objects p
               JOIN git_pack_meta m
                 ON m.repo_id = p.repo_id AND m.pack_id = p.pack_id AND m.state = 'complete'
                WHERE p.repo_id = ? AND p.oid = j.value
             )`,
        JSON.stringify(page),
        this.#repoId,
        this.#repoId,
      )) {
        found.add(row.oid);
      }
      page = [];
    };
    for (const oid of oids) {
      page.push(oid);
      if (page.length >= OID_PROBE_PAGE) probe();
    }
    probe();
    return found;
  }

  /** The oids this repository does not hold, in input order, deduplicated. */
  missing(oids: Iterable<string>): string[] {
    const wanted = [...new Set(oids)];
    const present = this.hasAll(wanted);
    return wanted.filter((oid) => !present.has(oid));
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    if (this.#cacheKeys.hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return { type: row.type, size: row.size };
    }
    return this.#packs.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    const cached = this.#objects.get(this.#objectCacheKey(oid));
    if (cached !== undefined) return cached;
    return this.#readLoose(oid) ?? this.#packs.read(oid);
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
      return this.#packs.readAuthenticatedObject(oid, expectedType);
    }
    const cacheKey = this.#objectCacheKey(oid);
    try {
      if (loose.type !== expectedType) {
        throw new CorruptError(`${oid} is a ${loose.type}, not a ${expectedType}`);
      }
      if (hashObject(loose.type, loose.data) !== oid) {
        throw new CorruptError(`loose ${expectedType} ${oid} does not match its bytes`);
      }
      return loose;
    } finally {
      this.#objects.delete(cacheKey);
    }
  }

  /** Validate bounded object metadata without reading payload bytes. */
  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    const wanted = [...new Set(oids)];
    if (wanted.length > MAX_BLOB_BATCH_OIDS) {
      throw new GitError("E2BIG", `object metadata batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
    }
    for (const oid of wanted) {
      if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    }
    const rows = this.#db.all<Record<string, unknown>>(
      `WITH wanted(ordinal, oid) AS MATERIALIZED (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       ), chunks AS MATERIALIZED (
         SELECT chunk.oid, COUNT(*) AS chunk_rows, MIN(chunk.seq) AS first_chunk,
                MAX(chunk.seq) AS last_chunk, MAX(length(chunk.data)) AS largest_chunk,
                SUM(length(chunk.data)) AS stored_bytes
           FROM git_object_chunks chunk
           JOIN wanted ON wanted.oid = chunk.oid
          WHERE chunk.repo_id = ?
          GROUP BY chunk.oid
       )
       SELECT CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                   WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
              CASE WHEN loose.oid IS NOT NULL THEN loose.type
                   WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
              CASE WHEN loose.oid IS NOT NULL THEN loose.size
                   WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size,
              CASE WHEN loose.oid IS NOT NULL THEN loose.stored END AS stored,
              CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.chunk_rows, 0) END AS chunk_rows,
              CASE WHEN loose.oid IS NULL THEN NULL ELSE chunks.first_chunk END AS first_chunk,
              CASE WHEN loose.oid IS NULL THEN NULL ELSE chunks.last_chunk END AS last_chunk,
              CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.largest_chunk, 0) END AS largest_chunk,
              CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.stored_bytes, 0) END AS stored_bytes
         FROM wanted w
         LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
         LEFT JOIN chunks ON chunks.oid = w.oid
         LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
          AND pack.state = 'complete'
        ORDER BY w.ordinal`,
      JSON.stringify(wanted),
      this.#repoId,
      this.#repoId,
      this.#repoId,
    );
    if (rows.length !== wanted.length) {
      throw new CorruptError("object metadata lookup returned the wrong row count");
    }
    return rows.map((raw, ordinal) => {
      const row = OBJECT_INFO_ROW.decode(raw);
      const oid = wanted[ordinal];
      if (oid === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
      if (
        row.source === null ||
        row.type === null ||
        row.size === null ||
        (row.source === "loose" && row.stored !== "raw" && row.stored !== "zlib") ||
        (row.source === "loose" && row.chunk_rows <= 0) ||
        (row.source === "loose" && row.first_chunk !== 0) ||
        (row.source === "loose" && row.last_chunk !== row.chunk_rows - 1) ||
        (row.source === "loose" && row.largest_chunk > OBJECT_CHUNK) ||
        (row.source === "loose" && row.stored === "raw" && row.stored_bytes !== row.size) ||
        (row.source === "loose" && row.stored === "zlib" && row.stored_bytes === 0) ||
        (row.source === "pack" &&
          (row.stored !== null ||
            row.chunk_rows !== 0 ||
            row.first_chunk !== null ||
            row.last_chunk !== null ||
            row.largest_chunk !== 0 ||
            row.stored_bytes !== 0))
      ) {
        if (row.source === null) throw new ObjectNotFoundError(oid);
        throw new CorruptError("object metadata lookup returned an invalid row");
      }
      return {
        oid,
        type: row.type,
        size: row.size,
        source: row.source,
        chunkRows: row.chunk_rows,
      };
    });
  }

  /** Read a deduplicated prefix of mixed objects under an explicit byte budget. */
  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.readObjectsOwned(oids, options);
  }

  readObjectsOwned(oids: readonly string[], options: { budgetBytes?: number }): ObjectReadBatch {
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

    const rawMetadata = this.#db.all<Record<string, unknown>>(
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
      this.#repoId,
      this.#repoId,
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
    const looseObjects = this.#readLooseObjects(looseRows.map((row) => row.oid));
    const packed =
      packedOids.length === 0 ? new Map<string, RawObject>() : this.#packs.readObjects(packedOids);
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

  /** Stream every non-tree entry in raw Git DFS order with one SQL statement. */

  write(type: ObjectType, data: Uint8Array): string {
    requireStorableObjectSize(type, data.length);
    const oid = hashObject(type, data);
    const commitEntry =
      type === "commit" ? prepareCommitCache({ repoId: this.#repoId, oid, data }) : undefined;
    if (this.has(oid)) {
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
      return oid;
    }
    const stored = looseEncoding(data.length);
    const storedData = encodeLoose(data, stored);
    const createdMs = this.#nowMilliseconds();
    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, ?)",
        this.#repoId,
        oid,
        type,
        data.length,
        stored,
      );
      this.#db.run(
        `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         VALUES (?, ?, ?)`,
        this.#repoId,
        oid,
        createdMs,
      );
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      );
      for (
        let seq = 0, offset = 0;
        offset < storedData.length || seq === 0;
        seq++, offset += OBJECT_CHUNK
      ) {
        const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
        if (part.length === 0) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, zeroblob(0))",
            this.#repoId,
            oid,
            seq,
          );
        } else {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
            this.#repoId,
            oid,
            seq,
            blob(part),
          );
        }
      }
      if (type === "tree") {
        indexSeededTreeSource(
          this.#db,
          {
            repoId: this.#repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: data.length,
          },
          [data],
        );
      }
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
    });
    this.#cacheKeys.markLoose();
    this.#objects.set(this.#objectCacheKey(oid), { type, data });
    return oid;
  }

  /**
   * Write a loose object from a stream of chunks. `chunks` is a factory
   * because the content is read twice: once to hash it, which is how the oid
   * is known and how `has` can short-circuit before a single row is written,
   * and once to deflate and store it. Nothing larger than one chunk is ever
   * live, so the peak does not follow the object's size.
   */
  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitError("EINVAL", "streamed object size must be a safe nonnegative integer");
    }
    requireStorableObjectSize(type, size);
    const hash = new Sha1().update(objectHeader(type, size));
    const commitData = type === "commit" ? new Uint8Array(size) : undefined;
    let hashed = 0;
    for (const chunk of chunks()) {
      if (hashed + chunk.length <= size) commitData?.set(chunk, hashed);
      hashed += chunk.length;
      hash.update(chunk);
    }
    if (hashed !== size) {
      throw new CorruptError(`streamed ${hashed} bytes for a ${type} declared as ${size}`);
    }
    const oid = toHex(hash.digest());
    const commitEntry =
      commitData === undefined
        ? undefined
        : prepareCommitCache({ repoId: this.#repoId, oid, data: commitData });
    if (this.has(oid)) {
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
      return oid;
    }

    const stored = looseEncoding(size);
    if (stored === "raw") {
      const data = commitData ?? new Uint8Array(size);
      const storageHash = new Sha1().update(objectHeader(type, size));
      let offset = 0;
      for (const chunk of chunks()) {
        if (offset + chunk.length > size) {
          throw new CorruptError(`stream changed after hashing ${oid}`);
        }
        data.set(chunk, offset);
        storageHash.update(chunk);
        offset += chunk.length;
      }
      if (offset !== size) throw new CorruptError(`stream changed after hashing ${oid}`);
      if (toHex(storageHash.digest()) !== oid) {
        throw new CorruptError(`stream changed after hashing ${oid}`);
      }
      const createdMs = this.#nowMilliseconds();
      this.#db.transactionSync(() => {
        this.#db.run(
          "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'raw')",
          this.#repoId,
          oid,
          type,
          size,
        );
        this.#db.run(
          `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
           VALUES (?, ?, ?)`,
          this.#repoId,
          oid,
          createdMs,
        );
        this.#db.run(
          "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
          this.#repoId,
          oid,
        );
        if (data.length === 0) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, zeroblob(0))",
            this.#repoId,
            oid,
          );
        } else {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
            this.#repoId,
            oid,
            blob(data),
          );
        }
        if (type === "tree") {
          indexSeededTreeSource(
            this.#db,
            {
              repoId: this.#repoId,
              treeOid: oid,
              storage: "loose",
              sourceId: 0,
              objectSize: size,
            },
            [data],
          );
        }
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
      });
      this.#cacheKeys.markLoose();
      return oid;
    }

    const rows: Uint8Array[] = [];
    const deflate = new pako.Deflate({ chunkSize: STREAM_CHUNK });
    deflate.onData = (chunk) => {
      if (!(chunk instanceof Uint8Array))
        throw new CorruptError("deflate produced a non-binary chunk");
      rows.push(chunk);
    };

    const createdMs = this.#nowMilliseconds();
    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'zlib')",
        this.#repoId,
        oid,
        type,
        size,
      );
      this.#db.run(
        `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         VALUES (?, ?, ?)`,
        this.#repoId,
        oid,
        createdMs,
      );
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      );
      let seq = 0;
      const drain = (): void => {
        for (const row of rows) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
            this.#repoId,
            oid,
            seq++,
            blob(row),
          );
        }
        rows.length = 0;
      };
      const storageChunks = function* (): Generator<Uint8Array> {
        const storageHash = new Sha1().update(objectHeader(type, size));
        let streamed = 0;
        for (const chunk of chunks()) {
          const offset = streamed;
          streamed += chunk.length;
          if (streamed > size) throw new CorruptError(`stream changed after hashing ${oid}`);
          commitData?.set(chunk, offset);
          storageHash.update(chunk);
          deflate.push(chunk, false);
          if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
          drain();
          yield chunk;
        }
        deflate.push(new Uint8Array(0), true);
        if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
        drain();
        if (streamed !== size || toHex(storageHash.digest()) !== oid) {
          throw new CorruptError(`stream changed after hashing ${oid}`);
        }
      };
      const storage = storageChunks();
      if (type === "tree") {
        indexSeededTreeSource(
          this.#db,
          {
            repoId: this.#repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: size,
          },
          storage,
        );
      } else {
        for (const _chunk of storage) {
          // Storage and hashing advance together without retaining the object.
        }
      }
      // An empty object still deserves one row, matching `write`.
      if (seq === 0) {
        this.#db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          this.#repoId,
          oid,
          0,
          blob(new Uint8Array(0)),
        );
      }
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
    });
    this.#cacheKeys.markLoose();
    return oid;
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
    return this.#createWriteBatch(options);
  }
  writeBatchGuarded(options: ObjectBatchOptions, mutate: (body: () => void) => void): ObjectBatch {
    return this.#createWriteBatch(options, mutate);
  }

  writeBatchOwned(options: ObjectBatchOptions): OwnedObjectBatch {
    return this.#createWriteBatch(options);
  }

  #createWriteBatch(
    options: ObjectBatchOptions,
    mutate: (body: () => void) => void = (body) => body(),
  ): OwnedObjectBatch {
    const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
    const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
    // Keyed by oid: a tree build re-emits identical subtrees, and one
    // (oid, seq) may appear at most once in a payload.
    const staged = new Map<string, StagedObject>();
    let bytes = 0;
    let commitBytes = 0;
    let active = true;
    const requireActive = (): void => {
      if (!active) throw new GitError("EINVAL", "object batch is disposed");
    };
    const clear = (): void => {
      staged.clear();
      bytes = 0;
      commitBytes = 0;
    };
    const flush = (): void => {
      requireActive();
      if (staged.size === 0) return;
      try {
        mutate(() => this.#flushObjects([...staged.values()], payloadBytes));
      } finally {
        clear();
      }
    };
    return {
      write: (type: ObjectType, data: Uint8Array): string => {
        requireActive();
        try {
          requireStorableObjectSize(type, data.length);
          const oid = hashObject(type, data);
          if (staged.has(oid)) return oid;
          const stored = looseEncoding(data.length);
          const storedData = stored === "raw" ? data.slice() : encodeLoose(data, stored);
          const object: StagedObject = { oid, type, size: data.length, stored, storedData };
          if (type === "tree") object.treeData = stored === "raw" ? storedData : data.slice();
          if (type === "commit") {
            const commitEntry = prepareCommitCache({ repoId: this.#repoId, oid, data });
            object.commitEntry = commitEntry;
          }
          const nextBytes =
            bytes +
            storedData.length +
            (object.treeData !== undefined && object.treeData !== storedData
              ? object.treeData.length
              : 0);
          const nextCommitBytes = commitBytes + (object.commitEntry?.cacheBytes ?? 0);
          staged.set(oid, object);
          bytes = nextBytes;
          commitBytes = nextCommitBytes;
          // After staging, never before: an object's chunks and its metadata
          // row have to land in the same flush, whatever its size.
          if (
            bytes >= payloadBytes ||
            commitBytes >= COMMIT_STAGE_CACHE_BYTES ||
            staged.size >= flushEvery
          ) {
            flush();
          }
          return oid;
        } catch (error) {
          clear();
          throw error;
        }
      },
      flush,
      dispose: (): void => {
        if (!active) return;
        clear();
        active = false;
      },
    };
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    const batch = this.#createWriteBatch(options);
    try {
      const result = body(batch);
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "object batch callback must be synchronous");
      }
      batch.flush();
      return result;
    } finally {
      batch.dispose();
    }
  }

  #flushObjects(staged: StagedObject[], payloadBytes: number): void {
    const byOid = new Map(staged.map((object) => [object.oid, object]));
    const commitEntries = staged.flatMap((object) =>
      object.commitEntry === undefined ? [] : [object.commitEntry],
    );
    const meta = JSON.stringify(
      staged.map((object) => ({ o: object.oid, t: object.type, s: object.size, e: object.stored })),
    );
    let wroteLoose = false;
    this.#db.transactionSync(() => {
      const fresh: StagedObject[] = [];
      for (const row of this.#db.iterate(
        `INSERT INTO git_objects (repo_id, oid, type, size, stored)
         SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.t'),
                json_extract(j.value, '$.s'), json_extract(j.value, '$.e')
           FROM json_each(?) j
          WHERE NOT EXISTS (
            SELECT 1
              FROM git_pack_objects packed
              JOIN git_pack_meta pack
                ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
               AND pack.state = 'complete'
             WHERE packed.repo_id = ?
               AND packed.oid = json_extract(j.value, '$.o')
          )
         ON CONFLICT(repo_id, oid) DO NOTHING
         RETURNING oid`,
        this.#repoId,
        meta,
        this.#repoId,
      )) {
        if (typeof row.oid !== "string") {
          throw new CorruptError("object metadata insert returned an invalid oid");
        }
        const object = byOid.get(row.oid);
        if (object === undefined) {
          throw new CorruptError("object metadata insert returned an unknown oid");
        }
        fresh.push(object);
      }
      if (fresh.length === 0) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, commitEntries), commitEntries.length);
        return;
      }
      wroteLoose = true;

      const payloads: ChunkPayload[] = [{ parts: [], length: 0, rows: [] }];
      for (const object of fresh) {
        const storedData = object.storedData;
        for (
          let seq = 0, offset = 0;
          offset < storedData.length || seq === 0;
          seq++, offset += OBJECT_CHUNK
        ) {
          const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
          let current = payloads[payloads.length - 1]!;
          if (current.length > 0 && current.length + part.length > payloadBytes) {
            current = { parts: [], length: 0, rows: [] };
            payloads.push(current);
          }
          // `a` is a 1-based byte offset: substr() counts bytes over a BLOB.
          current.rows.push({ o: object.oid, q: seq, a: current.length + 1, n: part.length });
          current.parts.push(part);
          current.length += part.length;
        }
      }

      const oids = JSON.stringify(fresh.map((object) => object.oid));
      this.#db.run(
        `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         SELECT ?, value, ? FROM json_each(?)`,
        this.#repoId,
        this.#nowMilliseconds(),
        oids,
      );
      // The transaction keeps metadata invisible until all chunks and parsed
      // tree rows are ready, while RETURNING replaces a separate probe.
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
        this.#repoId,
        oids,
      );
      for (const payload of payloads) {
        this.#db.run(
          `INSERT INTO git_object_chunks (repo_id, oid, seq, data)
           SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.q'),
                  CASE WHEN json_extract(j.value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.n'))
                   END
             FROM json_each(?) j
            WHERE true
           ON CONFLICT(repo_id, oid, seq) DO UPDATE SET data = excluded.data`,
          this.#repoId,
          blob(concat(payload.parts)),
          JSON.stringify(payload.rows),
        );
      }
      indexSeededTreeSources(
        this.#db,
        fresh.flatMap((object) => {
          if (object.type !== "tree" || object.treeData === undefined) return [];
          return [
            {
              repoId: this.#repoId,
              treeOid: object.oid,
              storage: "loose",
              sourceId: 0,
              objectSize: object.size,
              chunks: [object.treeData],
            },
          ];
        }),
      );
      requireCommitCacheWrites(insertCommitCaches(this.#db, commitEntries), commitEntries.length);
    });
    if (wroteLoose) this.#cacheKeys.markLoose();
  }

  /**
   * Inflated object bytes, chunk by chunk. A loose object really streams: its
   * rows are read one at a time and inflated incrementally. A packed object
   * yields exactly one chunk holding the whole thing, because a delta cannot
   * be reconstructed without its full base in memory. Null when unknown.
   */
  readChunks(oid: string): Iterable<Uint8Array> | null {
    const cached = this.#objects.get(this.#objectCacheKey(oid));
    if (cached !== undefined) return [cached.data];
    if (this.#cacheKeys.hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return this.#looseChunks(oid, parseLooseEncoding(row.stored));
    }
    const packed = this.#packs.read(oid);
    return packed === null ? null : [packed.data];
  }

  *#looseChunks(oid: string, stored: LooseEncoding): Generator<Uint8Array> {
    if (stored === "raw") {
      for (let seq = 0; ; seq++) {
        const row = this.#db.one<{ data: unknown }>(
          "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
          this.#repoId,
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
      const row = this.#db.one<{ data: unknown }>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
        this.#repoId,
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

  /** Resolve an abbreviated oid. Null when unknown or ambiguous. */
  resolvePrefix(prefix: string): string | null {
    if (prefix.length === 40) return this.has(prefix) ? prefix : null;
    const found = new Set<string>();
    if (this.#cacheKeys.hasLoose) {
      const upper = nextPrefix(prefix);
      for (const row of this.#db.all<{ oid: string }>(
        "SELECT oid FROM git_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2",
        this.#repoId,
        prefix,
        upper,
      )) {
        found.add(row.oid);
      }
    }
    for (const oid of this.#packs.findPrefix(prefix, 2)) found.add(oid);
    return found.size === 1 ? [...found][0]! : null;
  }

  objectCount(): number {
    const loose =
      this.#db.scalar<number>("SELECT COUNT(*) FROM git_objects WHERE repo_id = ?", this.#repoId) ??
      0;
    return loose + this.#packs.count();
  }

  #looseRow(oid: string): { type: ObjectType; size: number; stored: string } | null {
    return (
      this.#db.one<{ type: ObjectType; size: number; stored: string }>(
        "SELECT type, size, stored FROM git_objects WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      ) ?? null
    );
  }

  #readLoose(oid: string): RawObject | null {
    if (!this.#cacheKeys.hasLoose) return null;
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
      stored: LooseEncoding;
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
      this.#objects.set(this.#objectCacheKey(state.oid), object);
      result.set(state.oid, object);
    };

    for (const raw of this.#db.iterate(
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
      this.#repoId,
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
    if (oids.length === 0) return new Map();
    const result = new Map<string, { type: ObjectType; size: number }>();
    for (const row of this.#db.all<{ oid: string; type: string; size: number }>(
      `SELECT wanted.value AS oid, object.type, object.size
         FROM json_each(?) wanted
         JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.value`,
      JSON.stringify(oids),
      this.#repoId,
    )) {
      if (
        !isOid(row.oid) ||
        !isObjectType(row.type) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        result.has(row.oid)
      ) {
        throw new CorruptError("loose object metadata query returned an invalid row");
      }
      result.set(row.oid, { type: row.type, size: row.size });
    }
    return result;
  }

  readLooseObjects(oids: readonly string[]): Map<string, RawObject> {
    return this.#readLooseObjects(oids);
  }

  looseObjectMetadata(oids: readonly string[]): Map<string, { type: ObjectType; size: number }> {
    return this.#looseObjectMetadata(oids);
  }

  #objectCacheKey(oid: string): string {
    return this.#cacheKeys.objectCacheKey(oid);
  }

  #nowMilliseconds(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new GitError("EINVAL", "Git store clock must return non-negative integer milliseconds");
    }
    return now;
  }
}
