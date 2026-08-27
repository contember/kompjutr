// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.
//
// Pack-native object storage. A received packfile is written to SQLite
// verbatim, still compressed, in fixed-size chunk rows, and indexed
// (oid -> pack, offset, delta base). Reads pull only the chunks an object
// actually spans, so nothing ever inflates a whole repository.

import { concat, isOid, toHex } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import type { ByteLru } from "../core/lru.js";
import {
  hashObject,
  NUMBER_TYPE,
  type ObjectType,
  objectHeader,
  type RawObject,
} from "../core/objects.js";
import { type ByteSource, type ChunkedBytes, ChunkPool } from "../core/pack/chunks.js";
import { applyDelta, DeltaApplier } from "../core/pack/delta.js";
import { Sha1 } from "../core/sha1.js";
import { InflateInto, InflateSizeError, InflateStream, inflatePrefix } from "../core/zlib.js";
import { MAX_COMMIT_CACHE_BYTES, MAX_INDEXED_COMMIT_BYTES } from "./commits.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
import type { MemoryCoordinator, MemoryReservation } from "./memory.js";
import {
  PACK_COMMIT_PAYLOAD_BYTES,
  PACK_INDEX_MEMORY_BYTES,
  PACK_INGEST_METADATA_BYTES,
  PACK_OFFSET_WINDOW_BYTES,
  PACK_PENDING_PAGE_MEMORY_BYTES,
  PACK_PENDING_PAGE_ROWS,
  PACK_TREE_BATCH_BYTES,
  PACK_TREE_CHUNK_BYTES,
  PackCommitIndex,
  PackObjectBatch,
  type PackObjectInput,
  PackPendingBatch,
  PackTreeIndex,
  type PendingRow,
  validatePendingRow,
} from "./pack-ingest-index.js";

/** Bytes per `git_pack_data` row. Comfortably under the DO row limit. */
export const PACK_CHUNK = 1024 * 1024;
export const MAX_PACK_MEMBERSHIP_OBJECTS = 2_048;
export const MAX_PACK_DELETE_BATCH = 128;

/**
 * Git's default pack depth is 50, but a pack from another implementation can
 * legitimately chain deeper. The base walk is iterative and separately
 * cycle-checked by a seen-set, so this bounds chain *length* rather than
 * guarding stack depth — which means it can be generous without risk.
 */
export const MAX_DELTA_DEPTH = 50_000;

/** Output and compressed graph bytes admitted by one bulk blob read. */
export const MAX_PACK_BLOB_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_PACK_BLOB_GRAPH_ENTRIES = 4096;
const MAX_PACK_BLOB_INPUTS = 4096;

/** Recent (offset -> oid) pairs kept in memory for immediate ofs-delta bases. */
const OFFSET_WINDOW = 4_096;

export interface PackCacheOptions {
  /** Database-wide bytes of still-compressed pack rows held hot. */
  chunkBytes?: number;
  /** Largest entry inflated into one buffer. Anything above streams. */
  maxBufferedEntry?: number;
  /** Largest object admitted to the shared object cache. */
  cacheEntryLimit?: number;
  /** Test seam; production uses `MAX_DELTA_DEPTH`. */
  maxDeltaDepth?: number;
}

const DEFAULT_CHUNK_BYTES = 4 * PACK_CHUNK;
export const MAX_PACK_ROW_CACHE_BYTES = DEFAULT_CHUNK_BYTES;
const DEFAULT_MAX_BUFFERED_ENTRY = 8 * 1024 * 1024;
const DEFAULT_CACHE_ENTRY_LIMIT = 2 * 1024 * 1024;
export const MAX_PACK_DELTA_WORKING_BYTES = 48 * 1024 * 1024;
const PACK_READ_BYTES = 1024 * 1024;
const PACK_RANGE_SLICE_BYTES = 256 * 1024;
const PACK_RANGE_BATCH_BYTES = 1024 * 1024;
// Four conservative JSON copies plus request, map, result and view wrappers.
const PACK_RANGE_REQUEST_MEMORY_BYTES = 832;
const PACK_INFLATE_HEADROOM_BYTES = 16 * 1024 * 1024;
const PACK_SHARED_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
const PACK_INFLATE_OUTPUT_CHUNK_BYTES = 16 * 1024;
const PACK_BLOB_GRAPH_METADATA_BYTES = 2 * 1024 * 1024;
const PACK_EXTERNAL_BASE_BYTES = MAX_PACK_BLOB_BATCH_BYTES + 64 * 1024;

// Charged JS-owned state includes both database-wide shared caches once.
const PACK_MEMORY_MODEL_BYTES =
  MAX_PACK_DELTA_WORKING_BYTES +
  PACK_READ_BYTES +
  DEFAULT_CHUNK_BYTES +
  PACK_SHARED_OBJECT_CACHE_BYTES +
  PACK_TREE_BATCH_BYTES +
  MAX_COMMIT_CACHE_BYTES +
  PACK_INDEX_MEMORY_BYTES +
  PACK_PENDING_PAGE_MEMORY_BYTES +
  PACK_OFFSET_WINDOW_BYTES +
  2 * MAX_INDEXED_COMMIT_BYTES +
  PACK_INFLATE_HEADROOM_BYTES;
if (PACK_MEMORY_MODEL_BYTES > 100 * 1024 * 1024) {
  throw new Error("pack memory model exceeds 100 MiB");
}

// The bulk-read model likewise charges both database-wide caches once.
/** Caller-owned state allowed to coexist with one bulk packed-blob read. */
export const PACK_BLOB_CALLER_HEADROOM_BYTES = 8 * 1024 * 1024;

export const PACK_BLOB_MEMORY_MODEL_BYTES =
  MAX_PACK_DELTA_WORKING_BYTES +
  PACK_READ_BYTES +
  DEFAULT_CHUNK_BYTES +
  PACK_SHARED_OBJECT_CACHE_BYTES +
  MAX_PACK_BLOB_BATCH_BYTES * 2 +
  PACK_EXTERNAL_BASE_BYTES +
  PACK_BLOB_GRAPH_METADATA_BYTES +
  PACK_INFLATE_HEADROOM_BYTES +
  PACK_BLOB_CALLER_HEADROOM_BYTES;
if (PACK_BLOB_MEMORY_MODEL_BYTES >= 100 * 1024 * 1024) {
  throw new Error("packed blob batch memory model exceeds 100 MiB");
}

function pushExactInflate(stream: InflateInto, input: Uint8Array, label: string): number {
  try {
    return stream.push(input);
  } catch (error) {
    if (error instanceof InflateSizeError) {
      throw new CorruptError(`${label} exceeds its indexed size`, { cause: error });
    }
    throw error;
  }
}

function isObjectType(value: string): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

function packRangeBatchMemory(bytes: number, requests: number): number {
  const retained = bytes + PACK_RANGE_SLICE_BYTES + requests * PACK_RANGE_REQUEST_MEMORY_BYTES;
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "pack range batch retained state is too large");
  }
  return retained;
}

function packRangeFragment(request: PackRangeRequest, position: number, length: number): number {
  let current = request.position;
  let fragment = 0;
  const end = request.position + request.length;
  while (current < end) {
    const expected = Math.min(
      end - current,
      PACK_RANGE_SLICE_BYTES,
      PACK_CHUNK - (current % PACK_CHUNK),
    );
    if (current === position) return expected === length ? fragment : -1;
    current += expected;
    fragment++;
  }
  return -1;
}

function packRangeFragmentMask(request: PackRangeRequest): number {
  let current = request.position;
  let fragments = 0;
  const end = request.position + request.length;
  while (current < end) {
    current += Math.min(end - current, PACK_RANGE_SLICE_BYTES, PACK_CHUNK - (current % PACK_CHUNK));
    fragments++;
  }
  return 2 ** fragments - 1;
}

class FlatByteSource implements ByteSource {
  constructor(readonly bytes: Uint8Array) {}

  get length(): number {
    return this.bytes.length;
  }

  byteAt(index: number): number {
    const value = this.bytes[index];
    if (value === undefined) throw new RangeError("byte source index is out of range");
    return value;
  }

  copyTo(target: ChunkedBytes, targetOffset: number, sourceOffset: number, length: number): void {
    if (
      !Number.isSafeInteger(sourceOffset) ||
      !Number.isSafeInteger(length) ||
      sourceOffset < 0 ||
      length < 0 ||
      sourceOffset > this.bytes.length - length
    ) {
      throw new RangeError("byte source range is out of bounds");
    }
    target.write(targetOffset, this.bytes.subarray(sourceOffset, sourceOffset + length));
  }

  *chunks(): Iterable<Uint8Array> {
    yield this.bytes;
  }
}

function hashByteSource(type: ObjectType, source: ByteSource): string {
  const sha = new Sha1().update(objectHeader(type, source.length));
  for (const chunk of source.chunks()) sha.update(chunk);
  return toHex(sha.digest());
}

export interface PackedEntry {
  oid: string;
  packId: number;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjectType;
  size: number;
  entrySize: number;
  baseOid: string | null;
}

interface PackObjectRow {
  pack_id: number;
  offset: number;
  data_off: number;
  data_len: number;
  type: ObjectType;
  size: number;
  entry_size: number;
  base_oid: string | null;
}

export interface PackIngestOptions {
  /** Refuse a pack larger than this. */
  maxBytes?: number;
  onProgress?: (message: string) => void;
  /** Awaited periodically so the runtime can flush its write buffer. */
  yieldNow?: () => Promise<void>;
  now?: () => number;
  /** Synchronous hooks run inside the reservation and publication transactions. */
  lifecycle?: PackIngestLifecycle;
}

export interface PackIngestResult {
  packId: number;
  count: number;
  bytes: number;
}

export interface PackIngestLifecycle {
  reserved(packId: number): unknown;
  published(result: PackIngestResult): unknown;
}

export interface CompletePackObject {
  oid: string;
  type: ObjectType;
  size: number;
}

export interface CompletePackedEntry {
  packId: number;
  type: ObjectType;
  size: number;
  baseOid: string | null;
}

function requirePackId(packId: number): void {
  if (!Number.isSafeInteger(packId) || packId < 0) {
    throw new RangeError("pack id must be a non-negative safe integer");
  }
}

function uniquePackIds(packIds: readonly number[], limit: number): number[] {
  if (packIds.length > limit) {
    throw new GitError("E2BIG", `pack batch exceeds ${limit} inputs`);
  }
  const unique = new Set<number>();
  for (const packId of packIds) {
    requirePackId(packId);
    if (unique.has(packId)) throw new RangeError(`duplicate pack id ${packId}`);
    unique.add(packId);
  }
  return [...unique];
}

function requireLifecycleResult(result: unknown, hook: string): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw new Error(`pack lifecycle ${hook} hook must return undefined`);
}

/** Resolves an oid the pack index does not hold (loose storage, thin-pack bases). */
export type ExternalResolver = (oid: string) => RawObject | null;
export type ExternalBatchResolver = (oids: readonly string[]) => Map<string, RawObject>;
export interface ExternalObjectMetadata {
  type: ObjectType;
  size: number;
}
export type ExternalMetadataResolver = (
  oids: readonly string[],
) => Map<string, ExternalObjectMetadata>;

interface BulkPackRow extends PackObjectRow {
  oid: string;
}

interface CompressedEntry {
  bytes: Uint8Array;
  filled: number;
}

interface PackRangeRequest {
  ordinal: number;
  offset: number;
  position: number;
  length: number;
}

interface PackIngestMemory {
  reservation: MemoryReservation;
  pool: ChunkPool;
}

interface IngestBase {
  type: ObjectType;
  source: ByteSource;
  owned: ChunkedBytes | null;
}

/**
 * The largest a valid deflate stream can be for `size` bytes of input:
 * stored blocks cost five bytes per 65535, plus the zlib header and
 * checksum. A sender that pads beyond this still works — the read window
 * grows and retries — but this bound gets the common case in one pass.
 */
function checkDeltaWorkingSet(base: Uint8Array, delta: Uint8Array): void {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (at >= delta.length) throw new CorruptError("delta truncated");
      byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 56) throw new CorruptError("delta size is invalid");
    } while ((byte & 0x80) !== 0);
    return value;
  };
  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
  if (base.length + delta.length + targetSize > MAX_PACK_DELTA_WORKING_BYTES) {
    throw new CorruptError("delta working set exceeds 48 MiB");
  }
}

function checkDeltaInflateBudget(base: Uint8Array, deltaSize: number): void {
  if (
    !Number.isSafeInteger(deltaSize) ||
    deltaSize < 0 ||
    base.length + deltaSize > MAX_PACK_DELTA_WORKING_BYTES
  ) {
    throw new CorruptError("delta input exceeds the bounded working set");
  }
}

export class PackStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #external: ExternalResolver;
  readonly #externalBatch: ExternalBatchResolver;
  readonly #externalMetadata: ExternalMetadataResolver;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #chunks: ByteLru<string, Uint8Array>;
  readonly #memory: MemoryCoordinator;
  readonly #cacheNamespace: string;
  #cacheGeneration = 0;
  readonly #maxBufferedEntry: number;
  readonly #cacheEntryLimit: number;
  readonly #maxDeltaDepth: number;
  readonly #activePending = new Set<number>();
  #lastIngestMemoryHighWater = 0;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    chunks: ByteLru<string, Uint8Array>,
    memory: MemoryCoordinator,
    cacheNamespace: string,
    external: ExternalResolver,
    externalBatch: ExternalBatchResolver,
    externalMetadata: ExternalMetadataResolver,
    options: PackCacheOptions = {},
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#external = external;
    this.#externalBatch = externalBatch;
    this.#externalMetadata = externalMetadata;
    this.#objects = objects;
    this.#chunks = chunks;
    this.#memory = memory;
    this.#cacheNamespace = cacheNamespace;
    this.#maxBufferedEntry = Math.min(
      options.maxBufferedEntry ?? DEFAULT_MAX_BUFFERED_ENTRY,
      DEFAULT_MAX_BUFFERED_ENTRY,
    );
    this.#cacheEntryLimit = Math.min(
      options.cacheEntryLimit ?? DEFAULT_CACHE_ENTRY_LIMIT,
      DEFAULT_CACHE_ENTRY_LIMIT,
    );
    const maxDeltaDepth = options.maxDeltaDepth ?? MAX_DELTA_DEPTH;
    if (!Number.isFinite(maxDeltaDepth) || !Number.isInteger(maxDeltaDepth) || maxDeltaDepth < 0) {
      throw new RangeError("maxDeltaDepth must be a finite non-negative integer");
    }
    this.#maxDeltaDepth = Math.min(maxDeltaDepth, MAX_DELTA_DEPTH);
  }

  /** Bytes the chunk cache currently holds. */
  get cachedChunkBytes(): number {
    return this.#chunks.bytes;
  }

  get lastIngestMemoryHighWater(): number {
    return this.#lastIngestMemoryHighWater;
  }

  lookup(oid: string): PackedEntry | null {
    const row = this.#db.one<PackObjectRow>(
      `SELECT object.pack_id, object.offset, object.data_off, object.data_len,
              object.type, object.size, object.entry_size, object.base_oid
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?`,
      this.#repoId,
      oid,
    );
    if (row === undefined) return null;
    return {
      oid,
      packId: row.pack_id,
      offset: row.offset,
      dataOff: row.data_off,
      dataLen: row.data_len,
      type: row.type,
      size: row.size,
      entrySize: row.entry_size,
      baseOid: row.base_oid,
    };
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    const row = this.#db.one<{ type: ObjectType; size: number }>(
      `SELECT object.type, object.size
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?`,
      this.#repoId,
      oid,
    );
    return row ?? null;
  }

  count(): number {
    return (
      this.#db.scalar<number>(
        `SELECT COUNT(*)
           FROM git_pack_objects object
           JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND pack.state = 'complete'
          WHERE object.repo_id = ?`,
        this.#repoId,
      ) ?? 0
    );
  }

  findPrefix(prefix: string, limit: number): string[] {
    return this.#db
      .all<{ oid: string }>(
        `SELECT object.oid
           FROM git_pack_objects object
           JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND pack.state = 'complete'
          WHERE object.repo_id = ? AND object.oid >= ? AND object.oid < ?
          ORDER BY object.oid LIMIT ?`,
        this.#repoId,
        prefix,
        `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
        limit,
      )
      .map((row) => row.oid);
  }

  /** Every oid the pack index holds, in index order. */
  oids(): string[] {
    return this.#db
      .all<{ oid: string }>(
        `SELECT object.oid
           FROM git_pack_objects object
           JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND pack.state = 'complete'
          WHERE object.repo_id = ?
          ORDER BY object.oid`,
        this.#repoId,
      )
      .map((row) => row.oid);
  }

  /**
   * Inflate and delta-resolve an object. The base chain is walked through
   * index lookups first — bounding its length and catching cycles before
   * anything is inflated — then applied upward from the base, holding at
   * most two inflated buffers at a time.
   */
  read(oid: string): RawObject | null {
    const first = this.lookup(oid);
    if (first === null) return null;
    const cached = this.#objects.get(this.#objectCacheKey(first.packId, oid));
    if (cached !== undefined) return cached;

    const chain: PackedEntry[] = [];
    const seen = new Set<string>();
    let base: RawObject | null = null;
    let current: PackedEntry = first;
    for (;;) {
      if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
      seen.add(current.oid);
      if (current.baseOid === null) {
        base = { type: current.type, data: this.#inflateEntry(current) };
        this.#cacheObject(current.packId, current.oid, base);
        break;
      }
      if (chain.length >= this.#maxDeltaDepth) {
        throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
      }
      chain.push(current);
      const next = this.lookup(current.baseOid);
      if (next === null) {
        const external = this.#external(current.baseOid);
        if (external === null) {
          throw new CorruptError(`missing delta base ${current.baseOid} for ${current.oid}`);
        }
        base = external;
        break;
      }
      const cachedBase = this.#objects.get(this.#objectCacheKey(next.packId, next.oid));
      if (cachedBase !== undefined) {
        base = cachedBase;
        break;
      }
      current = next;
    }

    let object = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i]!;
      checkDeltaInflateBudget(object.data, entry.entrySize);
      const delta = this.#inflateEntry(entry);
      checkDeltaWorkingSet(object.data, delta);
      object = { type: base.type, data: applyDelta(object.data, delta) };
      this.#cacheObject(entry.packId, entry.oid, object);
    }
    if (chain.length === 0) this.#cacheObject(first.packId, oid, object);
    return object;
  }

  /** Resolve packed blobs with one graph query and one physical chunk cursor. */
  readBlobs(oids: readonly string[]): Map<string, Uint8Array> {
    const objects = this.#readObjects(oids, null, "blob", false);
    const blobs = new Map<string, Uint8Array>();
    for (const [oid, object] of objects) {
      if (object.type !== "blob") throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
      blobs.set(oid, object.data);
    }
    return blobs;
  }

  /** Resolve a bounded mixed-object batch in physical pack order. */
  readObjects(
    oids: readonly string[],
    expectedType: ObjectType | null = null,
  ): Map<string, RawObject> {
    return this.#readObjects(oids, null, expectedType, false);
  }

  /** Resolve ingest bases in bounded graph and physical pack order. */
  #readObjects(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject> = new Map(),
  ): Map<string, RawObject> {
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    if (wanted.length > MAX_PACK_BLOB_INPUTS) {
      throw new GitError("E2BIG", `blob batch exceeds ${MAX_PACK_BLOB_INPUTS} packed inputs`);
    }

    const rows = this.#db.all<BulkPackRow>(
      `WITH RECURSIVE
         roots(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         reachable(oid) AS (
           SELECT o.oid
             FROM roots r
             CROSS JOIN git_pack_objects o
             CROSS JOIN git_pack_meta m
            WHERE o.repo_id = ? AND o.oid = r.oid
              AND m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND (m.state = 'complete' OR o.pack_id = ?)
           UNION
           SELECT base.oid
             FROM reachable r
             CROSS JOIN git_pack_objects child
             CROSS JOIN git_pack_meta child_meta
             CROSS JOIN git_pack_objects base
             CROSS JOIN git_pack_meta base_meta
            WHERE child.repo_id = ? AND child.oid = r.oid
              AND child_meta.repo_id = child.repo_id
              AND child_meta.pack_id = child.pack_id
              AND (child_meta.state = 'complete' OR child.pack_id = ?)
              AND base.repo_id = child.repo_id AND base.oid = child.base_oid
              AND base_meta.repo_id = base.repo_id
              AND base_meta.pack_id = base.pack_id
              AND (base_meta.state = 'complete' OR base.pack_id = ?)
              AND NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)
         )
       SELECT o.oid, o.pack_id, o.offset, o.data_off, o.data_len, o.type,
              o.size, o.entry_size, o.base_oid
         FROM reachable r
         CROSS JOIN git_pack_objects o
        WHERE o.repo_id = ? AND o.oid = r.oid
        LIMIT ${MAX_PACK_BLOB_GRAPH_ENTRIES + 1}`,
      JSON.stringify(wanted),
      JSON.stringify([...seeds.keys()]),
      this.#repoId,
      pendingPackId ?? -1,
      this.#repoId,
      pendingPackId ?? -1,
      pendingPackId ?? -1,
      this.#repoId,
    );
    if (rows.length > MAX_PACK_BLOB_GRAPH_ENTRIES) {
      throw new GitError("E2BIG", "packed blob dependency graph exceeds the bounded entry limit");
    }

    const entries = new Map<string, PackedEntry>();
    for (const row of rows) {
      if (
        typeof row.oid !== "string" ||
        row.oid.length !== 40 ||
        !isObjectType(row.type) ||
        !Number.isSafeInteger(row.pack_id) ||
        !Number.isSafeInteger(row.offset) ||
        !Number.isSafeInteger(row.data_off) ||
        !Number.isSafeInteger(row.data_len) ||
        !Number.isSafeInteger(row.size) ||
        !Number.isSafeInteger(row.entry_size) ||
        row.pack_id < 0 ||
        row.offset < 0 ||
        row.data_off < 0 ||
        row.data_len < 0 ||
        !Number.isSafeInteger(row.data_off + row.data_len) ||
        row.size < 0 ||
        row.entry_size < 0 ||
        (row.base_oid !== null && (typeof row.base_oid !== "string" || row.base_oid.length !== 40))
      ) {
        throw new CorruptError("packed blob index contains invalid metadata");
      }
      entries.set(row.oid, {
        oid: row.oid,
        packId: row.pack_id,
        offset: row.offset,
        dataOff: row.data_off,
        dataLen: row.data_len,
        type: row.type,
        size: row.size,
        entrySize: row.entry_size,
        baseOid: row.base_oid,
      });
    }
    const available: string[] = [];
    let outputBytes = 0;
    const outputLimit =
      pendingPackId !== null && wanted.length === 1
        ? MAX_PACK_DELTA_WORKING_BYTES
        : MAX_PACK_BLOB_BATCH_BYTES;
    for (const oid of wanted) {
      const entry = entries.get(oid);
      if (entry === undefined) {
        if (allowMissing) continue;
        throw new CorruptError(`packed object ${oid} has no visible source`);
      }
      if (expectedType !== null && entry.type !== expectedType) {
        throw new CorruptError(`${oid} is a ${entry.type}, not a ${expectedType}`);
      }
      outputBytes += entry.size;
      if (!Number.isSafeInteger(outputBytes) || outputBytes > outputLimit) {
        throw new GitError("E2BIG", "packed object output exceeds the bounded batch limit");
      }
      available.push(oid);
    }

    const needed = new Map<string, PackedEntry>();
    const externalOids = new Set<string>();
    for (const oid of available) {
      let current = entries.get(oid)!;
      if (this.#objects.get(this.#objectCacheKey(current.packId, oid)) !== undefined) continue;
      const seen = new Set<string>();
      let depth = 0;
      for (;;) {
        if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(current.oid);
        needed.set(current.oid, current);
        if (current.baseOid === null) break;
        if (depth >= this.#maxDeltaDepth) {
          throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
        }
        depth++;
        const next = entries.get(current.baseOid);
        if (next === undefined) {
          if (seeds.has(current.baseOid)) break;
          externalOids.add(current.baseOid);
          break;
        }
        if (this.#objects.get(this.#objectCacheKey(next.packId, next.oid)) !== undefined) break;
        current = next;
      }
    }

    let compressedBytes = 0;
    const compressed = new Map<string, CompressedEntry>();
    const consumers = new Map<string, { entry: PackedEntry; output: CompressedEntry }[]>();
    for (const entry of needed.values()) {
      compressedBytes += entry.dataLen;
      if (!Number.isSafeInteger(compressedBytes) || compressedBytes > MAX_PACK_BLOB_BATCH_BYTES) {
        throw new GitError("E2BIG", "packed blob compressed graph exceeds the 4 MiB batch limit");
      }
      const output = { bytes: new Uint8Array(entry.dataLen), filled: 0 };
      compressed.set(entry.oid, output);
      if (entry.dataLen === 0) continue;
      const first = Math.floor(entry.dataOff / PACK_CHUNK);
      const last = Math.floor((entry.dataOff + entry.dataLen - 1) / PACK_CHUNK);
      for (let seq = first; seq <= last; seq++) {
        const key = `${entry.packId}:${seq}`;
        const list = consumers.get(key);
        const consumer = { entry, output };
        if (list === undefined) consumers.set(key, [consumer]);
        else list.push(consumer);
      }
    }

    const copyChunk = (packId: number, seq: number, chunk: Uint8Array): void => {
      for (const { entry, output } of consumers.get(`${packId}:${seq}`) ?? []) {
        const chunkStart = seq * PACK_CHUNK;
        const from = Math.max(entry.dataOff, chunkStart);
        const to = Math.min(entry.dataOff + entry.dataLen, chunkStart + chunk.length);
        if (to <= from) continue;
        const target = from - entry.dataOff;
        output.bytes.set(chunk.subarray(from - chunkStart, to - chunkStart), target);
        output.filled += to - from;
      }
    };

    const missingChunks: { p: number; q: number }[] = [];
    for (const key of consumers.keys()) {
      const separator = key.indexOf(":");
      const packId = Number(key.slice(0, separator));
      const seq = Number(key.slice(separator + 1));
      const hit = this.#chunks.get(this.#chunkCacheKey(packId, seq));
      if (hit === undefined) missingChunks.push({ p: packId, q: seq });
      else copyChunk(packId, seq, hit);
    }
    missingChunks.sort((left, right) => left.p - right.p || left.q - right.q);
    const returned = new Set<string>();
    if (missingChunks.length > 0) {
      for (const row of this.#db.iterate(
        `WITH requested(pack_id, seq) AS (
           SELECT json_extract(value, '$.p'), json_extract(value, '$.q') FROM json_each(?)
         )
         SELECT d.pack_id, d.seq, d.data
           FROM requested r
           JOIN git_pack_data d
             ON d.repo_id = ? AND d.pack_id = r.pack_id AND d.seq = r.seq
          WHERE length(d.data) <= ${PACK_CHUNK}
          ORDER BY d.pack_id, d.seq`,
        JSON.stringify(missingChunks),
        this.#repoId,
      )) {
        if (!Number.isSafeInteger(row.pack_id) || !Number.isSafeInteger(row.seq)) {
          throw new CorruptError("pack chunk query returned invalid coordinates");
        }
        const packId = Number(row.pack_id);
        const seq = Number(row.seq);
        const data = readBlob(row.data);
        const key = `${packId}:${seq}`;
        returned.add(key);
        this.#chunks.set(this.#chunkCacheKey(packId, seq), data);
        copyChunk(packId, seq, data);
      }
    }
    for (const chunk of missingChunks) {
      if (!returned.has(`${chunk.p}:${chunk.q}`)) {
        throw new CorruptError(`pack ${chunk.p}: missing chunk ${chunk.q}`);
      }
    }
    for (const [oid, value] of compressed) {
      if (value.filled !== value.bytes.length) {
        throw new CorruptError(`packed blob entry ${oid} exceeds its stored chunks`);
      }
    }

    const external = this.#externalBatch([...externalOids]);
    const result = new Map<string, RawObject>();
    for (const oid of available) {
      const first = entries.get(oid)!;
      const cached = this.#objects.get(this.#objectCacheKey(first.packId, oid));
      if (cached !== undefined) {
        result.set(oid, cached);
        continue;
      }
      const chain: PackedEntry[] = [];
      const seen = new Set<string>();
      let current = first;
      let object: RawObject | undefined;
      for (;;) {
        if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(current.oid);
        if (current.baseOid === null) {
          if (current.entrySize !== current.size) {
            throw new CorruptError(
              `pack entry at ${current.offset} has inconsistent size metadata`,
            );
          }
          object = {
            type: current.type,
            data: this.#inflateCompressed(current, compressed.get(current.oid)?.bytes),
          };
          this.#cacheObject(current.packId, current.oid, object);
          break;
        }
        if (chain.length >= this.#maxDeltaDepth) {
          throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
        }
        chain.push(current);
        const next = entries.get(current.baseOid);
        if (next === undefined) {
          object = seeds.get(current.baseOid) ?? external.get(current.baseOid);
          if (object === undefined) {
            throw new CorruptError(`missing delta base ${current.baseOid} for ${current.oid}`);
          }
          break;
        }
        const cachedBase = this.#objects.get(this.#objectCacheKey(next.packId, next.oid));
        if (cachedBase !== undefined) {
          object = cachedBase;
          break;
        }
        current = next;
      }
      for (let index = chain.length - 1; index >= 0; index--) {
        const entry = chain[index]!;
        checkDeltaInflateBudget(object.data, entry.entrySize);
        const delta = this.#inflateCompressed(entry, compressed.get(entry.oid)?.bytes);
        checkDeltaWorkingSet(object.data, delta);
        object = { type: object.type, data: applyDelta(object.data, delta) };
        if (object.data.length !== entry.size || object.type !== entry.type) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent type or size`);
        }
        this.#cacheObject(entry.packId, entry.oid, object);
      }
      if (object.type !== first.type || object.data.length !== first.size) {
        throw new CorruptError(`packed object ${oid} has inconsistent type or size`);
      }
      result.set(oid, object);
    }
    return result;
  }

  #inflateCompressed(entry: PackedEntry, compressed: Uint8Array | undefined): Uint8Array {
    if (compressed === undefined) {
      throw new CorruptError(`packed blob entry ${entry.oid} was not loaded`);
    }
    return this.#inflateBytes(compressed, entry.entrySize, `pack entry at ${entry.offset}`);
  }

  #inflateBytes(input: Uint8Array, expectedSize: number, label: string): Uint8Array {
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded inflate limit`);
    }
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    try {
      while (!stream.ended && consumed < input.length) {
        const used = pushExactInflate(stream, input.subarray(consumed), label);
        consumed += used;
        if (!stream.ended && used === 0) {
          throw new CorruptError(`${label} inflater made no progress`);
        }
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
    }
    if (!stream.ended || consumed !== input.length) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    try {
      return stream.finish();
    } catch (error) {
      throw new CorruptError(`${label} size does not match its index metadata`, { cause: error });
    }
  }

  #cacheObject(packId: number, oid: string, object: RawObject): void {
    if (object.data.length <= this.#cacheEntryLimit) {
      this.#objects.set(this.#objectCacheKey(packId, oid), object);
    }
  }

  #objectCacheKey(packId: number, oid: string): string {
    return `${this.#cacheNamespace}:${this.#cacheGeneration}:pack:${packId}:${oid}`;
  }

  #chunkCacheKey(packId: number, seq: number): string {
    return `${this.#cacheNamespace}:${this.#cacheGeneration}:row:${packId}:${seq}`;
  }

  /** Inflate one indexed entry, whose compressed length is already known. */
  #inflateEntry(entry: PackedEntry): Uint8Array {
    return this.#inflateStoredEntry(
      entry.packId,
      entry.dataOff,
      entry.dataLen,
      entry.entrySize,
      `pack entry at ${entry.offset}`,
    );
  }

  #inflateStoredEntry(
    packId: number,
    dataOff: number,
    dataLen: number,
    expectedSize: number,
    label: string,
  ): Uint8Array {
    if (
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(expectedSize) ||
      dataLen < 0 ||
      expectedSize < 0 ||
      expectedSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded inflate limit`);
    }
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
      const input = this.readRaw(packId, dataOff + consumed, length);
      const used = pushExactInflate(stream, input, label);
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    }
    if (!stream.ended || consumed !== dataLen) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    try {
      return stream.finish();
    } catch (error) {
      throw new CorruptError(`${label} size does not match its index metadata`, { cause: error });
    }
  }

  #readRangeBatch(packId: number, requests: readonly PackRangeRequest[]): Map<number, Uint8Array> {
    if (requests.length === 0 || requests.length > PACK_PENDING_PAGE_ROWS) {
      throw new CorruptError("pack range batch has an invalid request count");
    }
    let totalBytes = 0;
    for (const request of requests) {
      totalBytes += request.length;
      if (
        !Number.isSafeInteger(request.ordinal) ||
        !Number.isSafeInteger(request.offset) ||
        !Number.isSafeInteger(request.position) ||
        !Number.isSafeInteger(request.length) ||
        request.ordinal < 0 ||
        request.offset < 0 ||
        request.position < 0 ||
        request.length < 1 ||
        !Number.isSafeInteger(request.position + request.length) ||
        totalBytes > PACK_RANGE_BATCH_BYTES
      ) {
        throw new CorruptError("pack range batch has invalid coordinates");
      }
    }

    const outputs = new Map<number, Uint8Array>();
    const seen = new Map<number, number>();
    for (const request of requests) {
      if (outputs.has(request.offset)) {
        throw new CorruptError("pack range batch has a duplicate object offset");
      }
      outputs.set(request.offset, new Uint8Array(request.length));
      seen.set(request.offset, 0);
    }
    for (const range of this.#db.iterate(
      `WITH RECURSIVE /* pack-range substr <= ${PACK_RANGE_SLICE_BYTES} */
         requested(ordinal, object_offset, position, remaining) AS (
           SELECT json_extract(value, '$.ordinal'), json_extract(value, '$.offset'),
                  json_extract(value, '$.position'), json_extract(value, '$.length')
             FROM json_each(?)
         ),
         slices(ordinal, object_offset, position, remaining) AS (
           SELECT ordinal, object_offset, position, remaining FROM requested
           UNION ALL
           SELECT ordinal, object_offset,
                  position + min(remaining, ${PACK_RANGE_SLICE_BYTES},
                                 ${PACK_CHUNK} - position % ${PACK_CHUNK}),
                  remaining - min(remaining, ${PACK_RANGE_SLICE_BYTES},
                                  ${PACK_CHUNK} - position % ${PACK_CHUNK})
             FROM slices WHERE remaining > 0
         )
       SELECT slices.ordinal, slices.object_offset AS offset, slices.position,
              min(slices.remaining, ${PACK_RANGE_SLICE_BYTES},
                  ${PACK_CHUNK} - slices.position % ${PACK_CHUNK}) AS expected,
              substr(data.data, slices.position % ${PACK_CHUNK} + 1,
                     min(slices.remaining, ${PACK_RANGE_SLICE_BYTES},
                         ${PACK_CHUNK} - slices.position % ${PACK_CHUNK})) AS data
         FROM slices
        JOIN git_pack_data data
           ON data.repo_id = ? AND data.pack_id = ?
          AND data.seq = CAST(slices.position / ${PACK_CHUNK} AS INTEGER)
        WHERE slices.remaining > 0`,
      JSON.stringify(requests),
      this.#repoId,
      packId,
    )) {
      if (
        typeof range.ordinal !== "number" ||
        typeof range.offset !== "number" ||
        typeof range.position !== "number" ||
        typeof range.expected !== "number" ||
        !Number.isSafeInteger(range.ordinal) ||
        !Number.isSafeInteger(range.offset) ||
        !Number.isSafeInteger(range.position) ||
        !Number.isSafeInteger(range.expected) ||
        range.ordinal < 0 ||
        range.ordinal >= requests.length ||
        range.expected < 1 ||
        range.expected > PACK_RANGE_SLICE_BYTES
      ) {
        throw new CorruptError("pack range batch returned invalid coordinates");
      }
      const request = requests[range.ordinal];
      const output = outputs.get(range.offset);
      const seenMask = seen.get(range.offset);
      const fragment =
        request === undefined || typeof range.position !== "number"
          ? -1
          : packRangeFragment(request, range.position, range.expected);
      if (
        request === undefined ||
        output === undefined ||
        seenMask === undefined ||
        request.offset !== range.offset ||
        fragment < 0 ||
        (seenMask & (2 ** fragment)) !== 0
      ) {
        throw new CorruptError("pack range batch returned an unexpected slice");
      }
      const data = readBlob(range.data);
      if (data.length !== range.expected) {
        throw new CorruptError("pack range batch returned a truncated slice");
      }
      output.set(data, range.position - request.position);
      seen.set(range.offset, seenMask | (2 ** fragment));
    }
    for (const request of requests) {
      if (seen.get(request.offset) !== packRangeFragmentMask(request)) {
        throw new CorruptError(`pack ${packId}: missing range bytes`);
      }
    }
    return outputs;
  }

  /** Still-compressed bytes of a pack region, assembled from chunk rows. */
  readRaw(packId: number, offset: number, length: number): Uint8Array {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new CorruptError("pack read exceeds the bounded region limit");
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    if (first === last) {
      const chunk = this.#chunk(packId, first);
      const start = offset - first * PACK_CHUNK;
      return chunk.subarray(start, start + length);
    }
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const chunk = this.#chunk(packId, seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
    }
    return out;
  }

  /**
   * One decoded `git_pack_data` row through the database-wide LRU. The key
   * includes both store and invalidation generations, so deleted rows can
   * stay stale only until this bounded cache evicts them.
   */
  #chunk(packId: number, seq: number): Uint8Array {
    const key = this.#chunkCacheKey(packId, seq);
    const hit = this.#chunks.get(key);
    if (hit !== undefined) return hit;
    const row = this.#db.one<{ data: unknown }>(
      "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
      this.#repoId,
      packId,
      seq,
    );
    if (row === undefined) throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
    const chunk = readBlob(row.data);
    this.#chunks.set(key, chunk);
    return chunk;
  }

  clearCaches(): void {
    this.#cacheGeneration++;
  }

  /** Drop unowned packs left half-written by interrupted ordinary ingest. */
  reclaimPending(): number {
    const ids = new Set<number>();
    const collect = (rows: Iterable<Record<string, unknown>>): void => {
      for (const row of rows) {
        const packId = row.pack_id;
        if (typeof packId !== "number" || !Number.isSafeInteger(packId) || packId < 0) {
          throw new CorruptError("pending pack query returned an invalid pack id");
        }
        ids.add(packId);
      }
    };
    collect(
      this.#db.iterate(
        `SELECT pack.pack_id AS pack_id
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.state != 'complete'
            AND pack.pack_id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM git_maintenance_repack_batches batch
               WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
            )
          ORDER BY pack.pack_id LIMIT ?`,
        this.#repoId,
        JSON.stringify([...this.#activePending]),
        MAX_PACK_DELETE_BATCH + 1,
      ),
    );
    collect(
      this.#db.iterate(
        `SELECT DISTINCT data.pack_id AS pack_id
           FROM git_pack_data data
           LEFT JOIN git_pack_meta pack
             ON pack.repo_id = data.repo_id AND pack.pack_id = data.pack_id
          WHERE data.repo_id = ? AND pack.pack_id IS NULL
          ORDER BY data.pack_id LIMIT ?`,
        this.#repoId,
        MAX_PACK_DELETE_BATCH + 1,
      ),
    );
    if (ids.size > MAX_PACK_DELETE_BATCH) {
      throw new GitError("E2BIG", `pending pack cleanup exceeds ${MAX_PACK_DELETE_BATCH} packs`);
    }
    if (ids.size === 0) return 0;
    this.#db.transactionSync(() => {
      for (const packId of ids) this.#deletePack(packId);
    });
    this.clearCaches();
    return ids.size;
  }

  /** Delete exactly one pending pack after its owner releases the durable reference. */
  discardPending(packId: number, releaseOwnership?: (packId: number) => void): boolean {
    requirePackId(packId);
    const removed = this.#db.transactionSync(() => {
      const row = this.#db.one<{ state: unknown }>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      );
      if (row === undefined) return false;
      if (row.state !== "pending" && row.state !== "complete") {
        throw new CorruptError(`pack ${packId}: invalid state`);
      }
      if (row.state !== "pending") {
        throw new GitError("EBUSY", `pack ${packId} is already complete`);
      }
      releaseOwnership?.(packId);
      this.#deletePack(packId);
      return true;
    });
    if (removed) this.clearCaches();
    return removed;
  }

  /** Verify that one complete pack contains exactly the requested object metadata. */
  completePackMatches(packId: number, objects: readonly CompletePackObject[]): boolean {
    requirePackId(packId);
    if (objects.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
      throw new GitError("E2BIG", `pack membership exceeds ${MAX_PACK_MEMBERSHIP_OBJECTS} objects`);
    }
    const expected = new Map<string, { type: ObjectType; size: number }>();
    for (const object of objects) {
      if (
        !isOid(object.oid) ||
        !isObjectType(object.type) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0
      ) {
        throw new RangeError("pack membership contains invalid object metadata");
      }
      if (expected.has(object.oid)) throw new RangeError(`duplicate pack object ${object.oid}`);
      expected.set(object.oid, { type: object.type, size: object.size });
    }
    const meta = this.#db.one<{ state: unknown; count: unknown }>(
      "SELECT state, count FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
      this.#repoId,
      packId,
    );
    if (meta === undefined) return false;
    if (
      (meta.state !== "pending" && meta.state !== "complete") ||
      typeof meta.count !== "number" ||
      !Number.isSafeInteger(meta.count) ||
      meta.count < 0
    ) {
      throw new CorruptError(`pack ${packId}: invalid metadata`);
    }
    if (meta.state !== "complete" || meta.count !== expected.size) return false;

    let found = 0;
    let previousOid: string | null = null;
    for (const row of this.#db.iterate(
      `SELECT /* complete-pack-membership */ oid, pack_id, offset, type, size FROM git_pack_objects
        WHERE repo_id = ? AND pack_id = ?
        ORDER BY oid COLLATE BINARY LIMIT ?`,
      this.#repoId,
      packId,
      expected.size + 1,
    )) {
      const oid = row.oid;
      const rowPackId = row.pack_id;
      const offset = row.offset;
      const type = row.type;
      const size = row.size;
      if (
        typeof oid !== "string" ||
        !isOid(oid) ||
        typeof rowPackId !== "number" ||
        !Number.isSafeInteger(rowPackId) ||
        rowPackId !== packId ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (previousOid !== null && oid <= previousOid)
      ) {
        throw new CorruptError(`pack ${packId}: invalid object membership`);
      }
      const wanted = expected.get(oid);
      if (wanted === undefined || wanted.type !== type || wanted.size !== size) return false;
      expected.delete(oid);
      previousOid = oid;
      found++;
    }
    return found === objects.length && expected.size === 0;
  }

  /** Read packed metadata directly, ignoring any loose object that shadows it. */
  completePackedEntry(oid: string): CompletePackedEntry | null {
    if (!isOid(oid)) throw new RangeError("packed entry requires a valid object id");
    let result: CompletePackedEntry | null = null;
    let rows = 0;
    for (const row of this.#db.iterate(
      `SELECT /* complete-packed-entry */ object.oid, object.pack_id,
              object.type, object.size, object.base_oid
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?
        LIMIT 2`,
      this.#repoId,
      oid,
    )) {
      const rowOid = row.oid;
      const packId = row.pack_id;
      const type = row.type;
      const size = row.size;
      const baseOid = row.base_oid;
      if (
        typeof rowOid !== "string" ||
        rowOid !== oid ||
        !isOid(rowOid) ||
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        packId < 0 ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid)))
      ) {
        throw new CorruptError(`packed entry ${oid} has invalid metadata`);
      }
      rows++;
      if (rows > 1) throw new CorruptError(`packed entry ${oid} is not unique`);
      result = { packId, type, size, baseOid };
    }
    return result;
  }

  /** Delete a bounded set of complete packs; absent ids make retries idempotent. */
  deleteCompletePacks(packIds: readonly number[]): number {
    const ids = uniquePackIds(packIds, MAX_PACK_DELETE_BATCH);
    if (ids.length === 0) return 0;
    const requested = new Set(ids);
    const states = new Map<number, "pending" | "complete">();
    for (const row of this.#db.iterate(
      `SELECT pack_id, state FROM git_pack_meta
        WHERE repo_id = ? AND pack_id IN (SELECT value FROM json_each(?))`,
      this.#repoId,
      JSON.stringify(ids),
    )) {
      const packId = row.pack_id;
      const state = row.state;
      if (
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        packId < 0 ||
        (state !== "pending" && state !== "complete") ||
        !requested.has(packId) ||
        states.has(packId)
      ) {
        throw new CorruptError("complete pack deletion query returned an invalid row");
      }
      states.set(packId, state);
    }
    for (const [packId, state] of states) {
      if (state !== "complete") throw new GitError("EBUSY", `pack ${packId} is still pending`);
    }
    if (states.size === 0) return 0;
    this.#db.transactionSync(() => {
      for (const packId of states.keys()) this.#deletePack(packId);
    });
    this.clearCaches();
    return states.size;
  }

  #deletePack(packId: number): void {
    this.#db.run(
      `DELETE FROM git_commits
        WHERE repo_id = ?
          AND oid IN (
            SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ? AND type = 'commit'
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = git_commits.repo_id
               AND loose.oid = git_commits.oid
               AND loose.type = 'commit'
               AND loose.size = git_commits.object_size
          )`,
      this.#repoId,
      this.#repoId,
      packId,
    );
    this.#db.run(
      `DELETE FROM git_tree_effective WHERE source_key IN (
         SELECT source_key FROM git_tree_sources
          WHERE repo_id = ? AND storage = 'pack' AND source_id = ?
       )`,
      this.#repoId,
      packId,
    );
    this.#db.run(
      "DELETE FROM git_tree_sources WHERE repo_id = ? AND storage = 'pack' AND source_id = ?",
      this.#repoId,
      packId,
    );
    for (const table of [
      "git_pack_data",
      "git_pack_objects",
      "git_pack_pending",
      "git_pack_meta",
    ]) {
      this.#db.run(`DELETE FROM ${table} WHERE repo_id = ? AND pack_id = ?`, this.#repoId, packId);
    }
  }

  /**
   * Stream a packfile into storage: chunk rows first (verifying the SHA-1
   * trailer as the bytes go past), then a sequential index pass with eager
   * delta resolution, then a straggler pass for deltas whose base appeared
   * later. The pack is marked complete only once all three succeed, so an
   * interrupted fetch leaves nothing that later reads can see.
   */
  async ingest(
    source: AsyncIterable<Uint8Array>,
    options: PackIngestOptions = {},
  ): Promise<PackIngestResult> {
    const reservation = this.#memory.reserve();
    const pool = new ChunkPool(MAX_PACK_DELTA_WORKING_BYTES);
    const memory = { reservation, pool };
    const now = options.now ?? Date.now;
    const say = options.onProgress ?? (() => {});
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const yieldNow = options.yieldNow ?? (() => Promise.resolve());

    let activePackId: number | undefined;
    try {
      this.reclaimPending();
      const packId = this.#reservePending(now, options.lifecycle);
      activePackId = packId;

      const total = await this.#writeChunks(source, packId, maxBytes, say, yieldNow, memory);
      reservation.set("pool", MAX_PACK_DELTA_WORKING_BYTES);
      const { count, commits } = await this.#indexPack(packId, total, say, yieldNow, memory);
      const result = { packId, count, bytes: total };

      this.#db.transactionSync(() => {
        this.#db.run(
          "UPDATE git_pack_meta SET size = ?, count = ?, state = 'complete' WHERE repo_id = ? AND pack_id = ?",
          total,
          count,
          this.#repoId,
          packId,
        );
        commits.finish();
        if (options.lifecycle !== undefined) {
          requireLifecycleResult(options.lifecycle.published(result), "published");
        }
      });
      reservation.clear("commit");
      return result;
    } finally {
      if (activePackId !== undefined) this.#activePending.delete(activePackId);
      this.#lastIngestMemoryHighWater = reservation.highWaterBytes;
      if (!reservation.disposed) {
        try {
          pool.assertIdle();
          pool.dispose();
          reservation.clear("flat");
          reservation.clear("compressed");
          reservation.clear("metadata");
          reservation.clear("tree");
          reservation.clear("commit");
          reservation.clear("base");
          reservation.clear("pool");
          reservation.assertEmpty();
        } finally {
          reservation.dispose();
        }
      }
    }
  }

  #reservePending(now: () => number, lifecycle: PackIngestLifecycle | undefined): number {
    let activePackId: number | undefined;
    try {
      return this.#db.transactionSync(() => {
        const latest = this.#db.scalar<number | null>(
          "SELECT MAX(pack_id) FROM git_pack_meta WHERE repo_id = ?",
          this.#repoId,
        );
        if (
          latest !== undefined &&
          latest !== null &&
          (!Number.isSafeInteger(latest) || latest < 0 || latest === Number.MAX_SAFE_INTEGER)
        ) {
          throw new CorruptError("pack id allocation state is invalid");
        }
        const packId = (latest ?? 0) + 1;
        this.#db.run(
          "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, 0, 0, 'pending', ?)",
          this.#repoId,
          packId,
          now(),
        );
        this.#activePending.add(packId);
        activePackId = packId;
        if (lifecycle !== undefined) {
          requireLifecycleResult(lifecycle.reserved(packId), "reserved");
        }
        return packId;
      });
    } catch (error) {
      if (activePackId !== undefined) this.#activePending.delete(activePackId);
      throw error;
    }
  }

  /**
   * Phase A: bytes to chunk rows. Strictly linear over a fixed buffer —
   * the source may hand over one huge chunk, so nothing re-concatenates
   * the remainder.
   */
  async #writeChunks(
    source: AsyncIterable<Uint8Array>,
    packId: number,
    maxBytes: number,
    say: (message: string) => void,
    yieldNow: () => Promise<void>,
    memory: PackIngestMemory,
  ): Promise<number> {
    const sha = new Sha1();
    let tail = new Uint8Array(0); // rolling 20-byte lookbehind: the trailer
    let total = 0;
    let seq = 0;
    let announced = 0;
    const buffer = new Uint8Array(PACK_CHUNK);
    memory.reservation.set("compressed", PACK_CHUNK + 40);
    let filled = 0;

    const feed = (data: Uint8Array): void => {
      total += data.length;
      if (total > maxBytes) throw new CorruptError("pack exceeds the maximum accepted size");
      // Everything except the final 20 bytes is covered by the checksum,
      // and which bytes those are is only known at the end.
      const joined = tail.length > 0 ? concat([tail, data]) : data;
      if (joined.length > 20) {
        sha.update(joined.subarray(0, joined.length - 20));
        tail = joined.slice(joined.length - 20);
      } else {
        tail = joined.slice();
      }
      let offset = 0;
      while (offset < data.length) {
        const take = Math.min(PACK_CHUNK - filled, data.length - offset);
        buffer.set(data.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === PACK_CHUNK) {
          this.#writeChunk(packId, seq++, buffer.slice());
          filled = 0;
        }
      }
      if (total - announced >= 16 * 1024 * 1024) {
        announced = total;
        say(`Receiving objects: ${Math.round(total / 1048576)} MiB\n`);
      }
    };

    const SLICE = 4 * 1024 * 1024;
    for await (const data of source) {
      if (data.length === 0) continue;
      for (let offset = 0; offset < data.length; offset += SLICE) {
        feed(data.subarray(offset, offset + SLICE));
        memory.pool.assertIdle();
        await yieldNow();
      }
    }
    if (filled > 0) this.#writeChunk(packId, seq++, buffer.slice(0, filled));

    if (total < 32) throw new CorruptError("pack is too small to be valid");
    if (toHex(tail) !== toHex(sha.digest())) throw new CorruptError("pack checksum mismatch");
    memory.reservation.clear("compressed");
    return total;
  }

  #writeChunk(packId: number, seq: number, data: Uint8Array): void {
    this.#db.run(
      "INSERT INTO git_pack_data (repo_id, pack_id, seq, data) VALUES (?, ?, ?, ?)",
      this.#repoId,
      packId,
      seq,
      blob(data),
    );
  }

  /** Phase B + C: index every entry, then drain the deferred deltas. */
  async #indexPack(
    packId: number,
    total: number,
    say: (message: string) => void,
    yieldNow: () => Promise<void>,
    memory: PackIngestMemory,
  ): Promise<{ count: number; commits: PackCommitIndex }> {
    memory.reservation.set("metadata", PACK_INGEST_METADATA_BYTES);
    const reader = new PackReader(this, packId, total);
    const magic = reader.take(4);
    if (magic[0] !== 0x50 || magic[1] !== 0x41 || magic[2] !== 0x43 || magic[3] !== 0x4b) {
      throw new CorruptError("bad pack signature");
    }
    const version = reader.uint32();
    const count = reader.uint32();
    if (version !== 2 && version !== 3)
      throw new CorruptError(`unsupported pack version ${version}`);

    const offsets = new OffsetWindow();
    const objectIndex = new PackObjectBatch(this.#db, this.#repoId);
    const pendingIndex = new PackPendingBatch(this.#db, this.#repoId, packId);
    const treeIndex = new PackTreeIndex(this.#db, memory.reservation);
    const commitIndex = new PackCommitIndex(
      this.#db,
      this.#repoId,
      packId,
      objectIndex,
      memory.reservation,
    );
    const missingBases = new Set<string>();
    const offsetToOid = (offset: number): string | null => {
      return offsets.get(offset);
    };

    let deferred = 0;
    for (let i = 0; i < count; i++) {
      const header = reader.entryHeader();
      const entryType = header.kind === null ? NUMBER_TYPE[header.type]! : null;
      this.#reserveFlat(header.entrySize, treeIndex, commitIndex, memory.reservation);
      const entry = this.#inflateAt(reader, header.dataOff, header.entrySize, entryType);

      if (header.kind === null) {
        const type = entryType!;
        const oid = entry.data === null ? entry.streamedOid! : hashObject(type, entry.data);
        const row: PackObjectInput = [
          oid,
          packId,
          header.offset,
          header.dataOff,
          entry.consumed,
          type,
          header.entrySize,
          header.entrySize,
          null,
        ];
        this.#insertResolved(
          row,
          packId,
          oid,
          type,
          entry.data,
          treeIndex,
          commitIndex,
          header.dataOff,
          entry.consumed,
          header.entrySize,
          objectIndex,
          null,
          memory.reservation,
          0,
        );
        if (type === "tree") memory.reservation.clear("flat");
        this.#syncIndexMemory(treeIndex, commitIndex, memory.reservation);
        offsets.set(header.offset, oid);
        missingBases.delete(oid);
        if (entry.data !== null) this.#cacheObject(packId, oid, { type, data: entry.data });
        memory.reservation.clear("flat");
      } else {
        const baseOid =
          header.kind === "ref" ? header.baseOid! : offsetToOid(header.offset - header.baseDelta!);
        let resolved = false;
        if (entry.data !== null && baseOid !== null) {
          const base = missingBases.has(baseOid)
            ? undefined
            : this.#objects.get(this.#objectCacheKey(packId, baseOid));
          if (base === undefined) missingBases.add(baseOid);
          if (base !== undefined) {
            const target = this.#applyDeltaBytes(base.data, entry.data, memory.pool);
            try {
              const oid = hashByteSource(base.type, target);
              const row: PackObjectInput = [
                oid,
                packId,
                header.offset,
                header.dataOff,
                entry.consumed,
                base.type,
                target.length,
                header.entrySize,
                baseOid,
              ];
              if (base.type === "commit") {
                memory.reservation.set("flat", entry.data.length + target.length);
              }
              this.#insertResolved(
                row,
                packId,
                oid,
                base.type,
                null,
                treeIndex,
                commitIndex,
                header.dataOff,
                entry.consumed,
                target.length,
                objectIndex,
                target,
                memory.reservation,
                entry.data.length,
              );
              if (base.type === "commit") {
                memory.reservation.set("flat", entry.data.length);
              }
              this.#syncIndexMemory(treeIndex, commitIndex, memory.reservation);
              offsets.set(header.offset, oid);
              missingBases.delete(oid);
              if (target.length <= this.#cacheEntryLimit) {
                this.#cacheChunked(
                  packId,
                  oid,
                  base.type,
                  target,
                  entry.data.length,
                  memory.reservation,
                );
              }
              resolved = true;
            } finally {
              target.release();
              memory.pool.dispose();
            }
          }
        }
        if (!resolved) {
          pendingIndex.add([
            header.offset,
            header.dataOff,
            entry.consumed,
            header.entrySize,
            header.kind === "ref" ? header.baseOid : null,
            header.kind === "ofs" ? header.offset - header.baseDelta! : null,
          ]);
          deferred++;
        }
        memory.reservation.clear("flat");
      }

      if ((i & 1023) === 1023) {
        objectIndex.flush();
        pendingIndex.flush();
        memory.pool.assertIdle();
        await yieldNow();
        if ((i & 65535) === 65535) say(`Resolving deltas: ${i + 1}/${count}\n`);
      }
    }

    if (reader.position !== total - 20) {
      throw new CorruptError("pack has trailing data or a bad object count");
    }
    objectIndex.flush();
    pendingIndex.flush();
    if (deferred > 0) this.clearCaches();
    await this.#drainPending(
      packId,
      offsets,
      objectIndex,
      treeIndex,
      commitIndex,
      yieldNow,
      memory,
    );
    objectIndex.flush();
    treeIndex.flush();
    memory.reservation.clear("tree");
    memory.reservation.clear("metadata");
    if (deferred > 0) say(`Resolved ${deferred} deferred delta(s)\n`);
    return { count, commits: commitIndex };
  }

  async #drainPending(
    packId: number,
    offsets: OffsetWindow,
    objectIndex: PackObjectBatch,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    yieldNow: () => Promise<void>,
    memory: PackIngestMemory,
  ): Promise<void> {
    let remaining =
      this.#db.scalar<number>(
        "SELECT COUNT(*) FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      ) ?? 0;
    while (remaining > 0) {
      let progressed = 0;
      let after = -1;
      for (;;) {
        const page = this.#db.all<PendingRow>(
          `SELECT pending.offset, pending.data_off, pending.data_len, pending.entry_size,
                  pending.base_oid, pending.base_offset,
                  COALESCE(pending.base_oid, base.oid) AS resolved_oid
             FROM git_pack_pending pending
             LEFT JOIN git_pack_objects base
               ON base.repo_id = pending.repo_id AND base.pack_id = pending.pack_id
              AND base.offset = pending.base_offset
            WHERE pending.repo_id = ? AND pending.pack_id = ? AND pending.offset > ?
            ORDER BY pending.offset LIMIT ${PACK_PENDING_PAGE_ROWS}`,
          this.#repoId,
          packId,
          after,
        );
        if (page.length === 0) break;
        for (const row of page) validatePendingRow(row);
        const last = page[page.length - 1]!;
        after = last.offset;

        const byBaseOid = new Map<string, PendingRow[]>();
        const byBaseOffset = new Map<number, PendingRow[]>();
        const resolvedOffsets = new Map<number, string>();
        const baseOidSet = new Set<string>();
        for (const row of page) {
          if (row.base_oid !== null) {
            baseOidSet.add(row.base_oid);
            const children = byBaseOid.get(row.base_oid);
            if (children === undefined) byBaseOid.set(row.base_oid, [row]);
            else children.push(row);
            continue;
          }
          if (row.base_offset === null) continue;
          const children = byBaseOffset.get(row.base_offset);
          if (children === undefined) byBaseOffset.set(row.base_offset, [row]);
          else children.push(row);
          const oid = row.resolved_oid ?? offsets.get(row.base_offset);
          if (oid !== null) {
            baseOidSet.add(oid);
            resolvedOffsets.set(row.base_offset, oid);
          }
        }
        const baseOids = [...baseOidSet];
        const packedMetadata = this.#packedBaseMetadata(baseOids, packId);
        const externalOids = baseOids.filter((oid) => !packedMetadata.has(oid));
        const externalMetadata = this.#externalMetadata(externalOids);
        this.#checkBaseAdmission(packedMetadata, externalMetadata);
        let admittedBaseBytes = 0;
        for (const metadata of [...packedMetadata.values(), ...externalMetadata.values()]) {
          admittedBaseBytes += metadata.size;
        }
        memory.reservation.set(
          "base",
          packedMetadata.size + externalMetadata.size > 1 ? admittedBaseBytes : 0,
        );
        const materialized = this.#readBaseBatch([...packedMetadata.keys()], packId);
        for (const [oid, object] of materialized) {
          const metadata = packedMetadata.get(oid);
          if (
            metadata === undefined ||
            metadata.type !== object.type ||
            metadata.size !== object.data.length
          ) {
            throw new CorruptError("materialized pack base disagrees with its admitted metadata");
          }
        }
        for (const [oid, object] of this.#externalBatch([...externalMetadata.keys()])) {
          const metadata = externalMetadata.get(oid);
          if (
            metadata === undefined ||
            metadata.type !== object.type ||
            metadata.size !== object.data.length
          ) {
            throw new CorruptError("materialized loose base disagrees with its admitted metadata");
          }
          materialized.set(oid, object);
        }
        const bases = new Map<string, IngestBase>();
        for (const [oid, object] of materialized) {
          bases.set(oid, {
            type: object.type,
            source: new FlatByteSource(object.data),
            owned: null,
          });
        }
        let retainedBaseBytes = 0;
        for (const object of bases.values()) retainedBaseBytes += object.source.length;
        if (
          !Number.isSafeInteger(retainedBaseBytes) ||
          (bases.size > 1 && retainedBaseBytes > MAX_PACK_BLOB_BATCH_BYTES) ||
          retainedBaseBytes > MAX_PACK_DELTA_WORKING_BYTES
        ) {
          throw new GitError("E2BIG", "pack ingest bases exceed the bounded live-set limit");
        }
        const remainingUses = new Map<string, number>();
        for (const [oid, children] of byBaseOid) {
          remainingUses.set(oid, (remainingUses.get(oid) ?? 0) + children.length);
        }
        for (const [offset, oid] of resolvedOffsets) {
          remainingUses.set(
            oid,
            (remainingUses.get(oid) ?? 0) + (byBaseOffset.get(offset)?.length ?? 0),
          );
        }

        const ready: { row: PendingRow; baseOid: string }[] = [];
        const queued = new Set<number>();
        const enqueue = (row: PendingRow, baseOid: string): void => {
          if (queued.has(row.offset)) return;
          queued.add(row.offset);
          ready.push({ row, baseOid });
        };
        for (const [oid, children] of byBaseOid) {
          if (bases.has(oid)) for (const row of children) enqueue(row, oid);
        }
        for (const [offset, oid] of resolvedOffsets) {
          if (bases.has(oid)) {
            for (const row of byBaseOffset.get(offset) ?? []) enqueue(row, oid);
          }
        }

        const completed: number[] = [];
        let compressedBatch = new Map<number, Uint8Array>();
        let compressedBatchBytes = 0;
        for (const row of page) {
          compressedBatchBytes += row.data_len;
          if (!Number.isSafeInteger(compressedBatchBytes)) {
            throw new CorruptError("pending pack page has invalid compressed size");
          }
        }
        if (compressedBatchBytes > 0 && compressedBatchBytes <= PACK_RANGE_BATCH_BYTES) {
          memory.reservation.set(
            "compressed",
            packRangeBatchMemory(compressedBatchBytes, page.length),
          );
          const requests: PackRangeRequest[] = [];
          for (const row of page) {
            requests.push({
              ordinal: requests.length,
              offset: row.offset,
              position: row.data_off,
              length: row.data_len,
            });
          }
          compressedBatch = this.#readRangeBatch(packId, requests);
        } else {
          compressedBatchBytes = 0;
        }
        try {
          for (let cursor = 0; cursor < ready.length; cursor++) {
            const { row, baseOid } = ready[cursor]!;
            const base = bases.get(baseOid);
            if (base === undefined) continue;
            const compressed = compressedBatch.get(row.offset) ?? null;
            const uses = (remainingUses.get(baseOid) ?? 1) - 1;
            remainingUses.set(baseOid, uses);
            const target = this.#applyStoredDelta(
              packId,
              row.data_off,
              row.data_len,
              row.entry_size,
              `delta at ${row.offset}`,
              base.source,
              memory.pool,
              compressed,
            );
            if (uses === 0 && bases.delete(baseOid)) {
              retainedBaseBytes -= base.source.length;
              base.owned?.release();
              memory.reservation.set("base", bases.size > 1 ? retainedBaseBytes : 0);
            }
            let retainedTarget = false;
            try {
              const oid = hashByteSource(base.type, target);
              const offsetChildren = byBaseOffset.get(row.offset) ?? [];
              const oidChildren = byBaseOid.get(oid) ?? [];
              const hasChildren = oidChildren.length > 0 || offsetChildren.length > 0;
              const objectRow: PackObjectInput = [
                oid,
                packId,
                row.offset,
                row.data_off,
                row.data_len,
                base.type,
                target.length,
                row.entry_size,
                baseOid,
              ];
              if (base.type === "commit") {
                memory.reservation.set("flat", target.length);
              }
              this.#insertResolved(
                objectRow,
                packId,
                oid,
                base.type,
                null,
                treeIndex,
                commitIndex,
                row.data_off,
                row.data_len,
                target.length,
                objectIndex,
                target,
                memory.reservation,
                0,
              );
              if (base.type === "commit") memory.reservation.clear("flat");
              this.#syncIndexMemory(treeIndex, commitIndex, memory.reservation);
              completed.push(row.offset);
              offsets.set(row.offset, oid);
              if (offsetChildren.length > 0) {
                remainingUses.set(oid, (remainingUses.get(oid) ?? 0) + offsetChildren.length);
              }
              if (hasChildren && !bases.has(oid)) {
                if (
                  target.length > MAX_PACK_DELTA_WORKING_BYTES ||
                  (retainedBaseBytes > 0 &&
                    retainedBaseBytes + target.length > MAX_PACK_BLOB_BATCH_BYTES)
                ) {
                  throw new GitError(
                    "E2BIG",
                    "pack ingest bases exceed the bounded live-set limit",
                  );
                }
                memory.reservation.set(
                  "base",
                  bases.size > 0 ? retainedBaseBytes + target.length : 0,
                );
                bases.set(oid, { type: base.type, source: target, owned: target });
                retainedBaseBytes += target.length;
                retainedTarget = true;
              }
              if (hasChildren) {
                for (const child of oidChildren) enqueue(child, oid);
                for (const child of offsetChildren) enqueue(child, oid);
              }
              if (target.length <= this.#cacheEntryLimit) {
                this.#cacheChunked(packId, oid, base.type, target, 0, memory.reservation);
              }
              progressed++;
            } finally {
              if (!retainedTarget) target.release();
            }
          }
        } finally {
          memory.reservation.clear("compressed");
          for (const base of bases.values()) base.owned?.release();
          bases.clear();
          memory.reservation.clear("base");
        }
        if (completed.length > 0) {
          objectIndex.flush();
          this.#db.run(
            "DELETE FROM git_pack_pending WHERE repo_id = ? AND pack_id = ? AND offset IN (SELECT value FROM json_each(?))",
            this.#repoId,
            packId,
            JSON.stringify(completed),
          );
        }
        memory.pool.assertIdle();
        memory.pool.dispose();
        await yieldNow();
      }
      objectIndex.flush();
      remaining -= progressed;
      if (progressed === 0 && remaining > 0) {
        throw new CorruptError(`cannot resolve ${remaining} delta object(s): missing base`);
      }
    }
  }

  #packedBaseMetadata(
    oids: readonly string[],
    packId: number,
  ): Map<string, ExternalObjectMetadata> {
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    const result = new Map<string, ExternalObjectMetadata>();
    for (const row of this.#db.all<{ oid: string; type: string; size: number }>(
      // CROSS JOIN pins the order: without it SQLite drives from
      // git_pack_objects and re-scans the bound set once per packed object.
      `SELECT object.oid, object.type, object.size
         FROM json_each(?) wanted
         CROSS JOIN git_pack_objects object
           ON object.repo_id = ? AND object.oid = wanted.value
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND (pack.state = 'complete' OR object.pack_id = ?)`,
      JSON.stringify(wanted),
      this.#repoId,
      packId,
    )) {
      if (
        !isOid(row.oid) ||
        !isObjectType(row.type) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > MAX_PACK_DELTA_WORKING_BYTES ||
        result.has(row.oid)
      ) {
        throw new CorruptError("pack ingest base has invalid size metadata");
      }
      result.set(row.oid, { type: row.type, size: row.size });
    }
    return result;
  }

  #checkBaseAdmission(
    packed: ReadonlyMap<string, ExternalObjectMetadata>,
    external: ReadonlyMap<string, ExternalObjectMetadata>,
  ): void {
    let bytes = 0;
    const sources = packed.size + external.size;
    for (const metadata of [...packed.values(), ...external.values()]) {
      bytes += metadata.size;
      if (!Number.isSafeInteger(bytes) || (sources > 1 && bytes > MAX_PACK_BLOB_BATCH_BYTES)) {
        throw new GitError("E2BIG", "pack ingest bases exceed the 4 MiB batch limit");
      }
    }
  }

  #readBaseBatch(oids: readonly string[], packId: number): Map<string, RawObject> {
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    const result = new Map<string, RawObject>();
    const uncached: string[] = [];
    for (const oid of wanted) {
      const cached = this.#objects.get(this.#objectCacheKey(packId, oid));
      if (cached === undefined) uncached.push(oid);
      else result.set(oid, cached);
    }
    for (const [oid, object] of this.#readBaseBatchParts(uncached, packId)) {
      result.set(oid, object);
    }
    return result;
  }

  #readBaseBatchParts(oids: readonly string[], packId: number): Map<string, RawObject> {
    if (oids.length === 0) return new Map();
    try {
      return this.#readObjects(oids, packId, null, true);
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== "E2BIG") throw error;
      if (oids.length === 1) {
        const oid = oids[0]!;
        const object = this.#readBasePaged(oid, packId);
        return object === null ? new Map() : new Map([[oid, object]]);
      }
      const middle = Math.ceil(oids.length / 2);
      const result = this.#readBaseBatchParts(oids.slice(0, middle), packId);
      for (const [oid, object] of this.#readBaseBatchParts(oids.slice(middle), packId)) {
        result.set(oid, object);
      }
      return result;
    }
  }

  /** Resolve a deep ingest base as bounded graph segments joined by one live checkpoint. */
  #readBasePaged(oid: string, packId: number): RawObject | null {
    const roots: string[] = [];
    let current = oid;
    let depth = 0;
    for (;;) {
      const tail = this.#db.one<{ oid: string; base_oid: string | null; depth: number }>(
        `WITH RECURSIVE chain(oid, base_oid, depth) AS (
           SELECT object.oid, object.base_oid, 0
             FROM git_pack_objects object
             JOIN git_pack_meta pack
               ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
              AND (pack.state = 'complete' OR object.pack_id = ?)
            WHERE object.repo_id = ? AND object.oid = ?
           UNION ALL
           SELECT base.oid, base.base_oid, chain.depth + 1
             FROM chain
             JOIN git_pack_objects base ON base.repo_id = ? AND base.oid = chain.base_oid
             JOIN git_pack_meta pack
               ON pack.repo_id = base.repo_id AND pack.pack_id = base.pack_id
              AND (pack.state = 'complete' OR base.pack_id = ?)
            WHERE chain.depth < ${MAX_PACK_BLOB_GRAPH_ENTRIES - 1}
         )
         SELECT oid, base_oid, depth FROM chain ORDER BY depth DESC LIMIT 1`,
        packId,
        this.#repoId,
        current,
        this.#repoId,
        packId,
      );
      if (tail === undefined) return null;
      if (
        !isOid(tail.oid) ||
        (tail.base_oid !== null && !isOid(tail.base_oid)) ||
        !Number.isSafeInteger(tail.depth) ||
        tail.depth < 0 ||
        tail.depth >= MAX_PACK_BLOB_GRAPH_ENTRIES
      ) {
        throw new CorruptError("paged pack base traversal returned invalid metadata");
      }
      roots.push(current);
      if (tail.base_oid === null || tail.depth < MAX_PACK_BLOB_GRAPH_ENTRIES - 1) {
        depth += tail.depth + (tail.base_oid === null ? 0 : 1);
        break;
      }
      depth += tail.depth + 1;
      if (depth > this.#maxDeltaDepth) {
        throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
      }
      current = tail.base_oid;
    }
    if (depth > this.#maxDeltaDepth) {
      throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
    }

    let checkpoint: { oid: string; object: RawObject } | null = null;
    for (let index = roots.length - 1; index >= 0; index--) {
      const root = roots[index]!;
      const seeds: ReadonlyMap<string, RawObject> =
        checkpoint === null
          ? new Map<string, RawObject>()
          : new Map<string, RawObject>([[checkpoint.oid, checkpoint.object]]);
      const object: RawObject | undefined = this.#readObjects(
        [root],
        packId,
        null,
        true,
        seeds,
      ).get(root);
      if (object === undefined) return null;
      checkpoint = { oid: root, object };
    }
    return checkpoint?.object ?? null;
  }

  #reserveFlat(
    bytes: number,
    trees: PackTreeIndex,
    commits: PackCommitIndex,
    reservation: MemoryReservation,
  ): void {
    const retained = bytes <= this.#maxBufferedEntry ? bytes : 0;
    try {
      reservation.set("flat", retained);
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== "E2BIG") throw error;
      trees.flush();
      commits.checkpoint();
      reservation.clear("tree");
      reservation.clear("commit");
      reservation.set("flat", retained);
    }
  }

  #syncIndexMemory(
    trees: PackTreeIndex,
    commits: PackCommitIndex,
    reservation: MemoryReservation,
  ): void {
    reservation.set("tree", trees.retainedBytes);
    reservation.set("commit", commits.retainedBytes);
  }

  #cacheChunked(
    packId: number,
    oid: string,
    type: ObjectType,
    target: ChunkedBytes,
    retainedFlatBytes: number,
    reservation: MemoryReservation,
  ): void {
    try {
      reservation.set("flat", retainedFlatBytes + target.length);
    } catch (error) {
      if (error instanceof GitError && error.code === "E2BIG") return;
      throw error;
    }
    try {
      this.#cacheObject(packId, oid, { type, data: target.toUint8Array() });
    } finally {
      reservation.set("flat", retainedFlatBytes);
    }
  }

  #applyDeltaBytes(base: Uint8Array, delta: Uint8Array, pool: ChunkPool): ChunkedBytes {
    const applier = new DeltaApplier(new FlatByteSource(base), pool, {
      maxWorkingBytes: MAX_PACK_DELTA_WORKING_BYTES,
      maxInstructionBytes: MAX_PACK_DELTA_WORKING_BYTES,
    });
    try {
      applier.push(delta);
      const target = applier.finish();
      if (base.length + applier.instructionBytes + target.length > MAX_PACK_DELTA_WORKING_BYTES) {
        target.release();
        throw new CorruptError("delta working set exceeds 48 MiB");
      }
      return target;
    } catch (error) {
      applier.abort();
      throw error;
    }
  }

  #applyStoredDelta(
    packId: number,
    dataOff: number,
    dataLen: number,
    instructionSize: number,
    label: string,
    base: ByteSource,
    pool: ChunkPool,
    compressed: Uint8Array | null = null,
  ): ChunkedBytes {
    if (
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(instructionSize) ||
      dataLen < 0 ||
      instructionSize < 0 ||
      base.length + instructionSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded working set`);
    }
    const applier = new DeltaApplier(base, pool, {
      maxWorkingBytes: MAX_PACK_DELTA_WORKING_BYTES,
      maxInstructionBytes: MAX_PACK_DELTA_WORKING_BYTES,
    });
    const stream = new InflateStream((chunk) => applier.push(chunk));
    let consumed = 0;
    const push = (input: Uint8Array): void => {
      let used: number;
      try {
        used = stream.push(input);
      } catch (error) {
        if (error instanceof CorruptError) throw error;
        throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
      }
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    };
    try {
      if (compressed === null) {
        while (!stream.ended && consumed < dataLen) {
          const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
          push(this.readRaw(packId, dataOff + consumed, length));
        }
      } else {
        if (compressed.length !== dataLen) {
          throw new CorruptError(`${label} compressed range has the wrong size`);
        }
        for (let offset = 0; offset < compressed.length; offset += PACK_RANGE_SLICE_BYTES) {
          push(compressed.subarray(offset, offset + PACK_RANGE_SLICE_BYTES));
        }
      }
      if (!stream.ended || consumed !== dataLen || stream.inflated !== instructionSize) {
        throw new CorruptError(`${label} size does not match its index metadata`);
      }
      const target = applier.finish();
      if (base.length + applier.instructionBytes + target.length > MAX_PACK_DELTA_WORKING_BYTES) {
        target.release();
        throw new CorruptError("delta working set exceeds 48 MiB");
      }
      return target;
    } catch (error) {
      applier.abort();
      throw error;
    }
  }

  #insertResolved(
    row: PackObjectInput,
    packId: number,
    oid: string,
    type: ObjectType,
    data: Uint8Array | null,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    dataOff: number,
    dataLen: number,
    objectSize: number,
    objectIndex: PackObjectBatch,
    chunked: ChunkedBytes | null,
    reservation: MemoryReservation,
    retainedFlatBytes: number,
  ): void {
    objectIndex.add(row);
    if (type === "commit") {
      if (objectSize > MAX_INDEXED_COMMIT_BYTES) {
        throw new GitError(
          "E2BIG",
          `packed commit ${oid} exceeds the ${MAX_INDEXED_COMMIT_BYTES}-byte index limit`,
        );
      }
      let commitData: Uint8Array;
      if (data !== null) {
        commitData = data;
      } else if (chunked !== null) {
        reservation.set("flat", retainedFlatBytes + objectSize + PACK_COMMIT_PAYLOAD_BYTES);
        commitData = chunked.toUint8Array();
        reservation.set("flat", retainedFlatBytes + objectSize);
      } else {
        const chunkCount = Math.max(1, Math.ceil(objectSize / PACK_INFLATE_OUTPUT_CHUNK_BYTES));
        const transientBytes =
          2 * objectSize + PACK_COMMIT_PAYLOAD_BYTES + chunkCount * PACK_TREE_CHUNK_BYTES;
        if (!Number.isSafeInteger(transientBytes)) {
          throw new GitError("E2BIG", `packed commit ${oid} payload state is too large`);
        }
        reservation.set("flat", retainedFlatBytes + transientBytes);
        const inflated = [...this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize)];
        commitData = concat(inflated);
        reservation.set("flat", retainedFlatBytes + objectSize);
      }
      commitIndex.add({ repoId: this.#repoId, oid, data: commitData });
    }
    if (type !== "tree") return;
    if (chunked !== null) {
      treeIndex.addChunked(this.#repoId, oid, packId, objectSize, chunked);
      return;
    }
    if (data !== null) {
      treeIndex.addBuffered(this.#repoId, oid, packId, objectSize, data);
      return;
    }
    treeIndex.addStream(this.#repoId, oid, packId, objectSize, () =>
      this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize),
    );
  }

  /** Re-inflate a large full tree directly into the streaming parser. */
  *#inflateEntryChunks(
    packId: number,
    dataOff: number,
    dataLen: number,
    expectedSize: number,
  ): Generator<Uint8Array> {
    if (
      !Number.isSafeInteger(dataOff) ||
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(expectedSize) ||
      dataOff < 0 ||
      dataLen < 0 ||
      expectedSize < 0 ||
      !Number.isSafeInteger(dataOff + dataLen)
    ) {
      throw new CorruptError("packed tree has invalid size metadata");
    }
    const ready: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => ready.push(chunk));
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_CHUNK, dataLen - consumed);
      const input = this.readRaw(packId, dataOff + consumed, length);
      const used = stream.push(input);
      consumed += used;
      for (const chunk of ready) yield chunk;
      ready.length = 0;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError("packed tree inflater stopped before the stream ended");
      }
    }
    for (const chunk of ready) yield chunk;
    if (!stream.ended || consumed !== dataLen || stream.inflated !== expectedSize) {
      throw new CorruptError("packed tree size does not match its index metadata");
    }
  }

  /**
   * Inflate the entry whose compressed bytes start at `dataOff`. Small
   * entries come back whole; anything past the buffer limit is streamed,
   * hashed on the way past, and reported by oid only.
   */
  #inflateAt(
    reader: PackReader,
    dataOff: number,
    entrySize: number,
    type: ObjectType | null,
  ): { data: Uint8Array | null; consumed: number; streamedOid: string | null } {
    const buffered = entrySize <= this.#maxBufferedEntry;
    reader.seek(dataOff);
    if (buffered) {
      const window = reader.window();
      if (window.length === 0) throw new CorruptError(`truncated pack entry at ${dataOff}`);
      let exact: { data: Uint8Array; consumed: number } | null;
      try {
        exact = inflatePrefix(window, entrySize);
      } catch (error) {
        throw new CorruptError(`invalid pack entry at ${dataOff}`, { cause: error });
      }
      if (exact !== null) {
        if (
          exact.data.length !== entrySize ||
          !Number.isSafeInteger(exact.consumed) ||
          exact.consumed <= 0 ||
          exact.consumed > window.length
        ) {
          throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
        }
        reader.seek(dataOff + exact.consumed);
        return { data: exact.data, consumed: exact.consumed, streamedOid: null };
      }
    }
    const exactInflater = buffered ? new InflateInto(entrySize) : null;
    let produced = 0;
    const sha = type === null ? null : new Sha1().update(objectHeader(type, entrySize));
    const stream =
      exactInflater ??
      new InflateStream((chunk) => {
        produced += chunk.length;
        if (produced > entrySize) {
          throw new CorruptError(`pack entry exceeds its declared size at ${dataOff}`);
        }
        sha?.update(chunk);
      });
    reader.seek(dataOff);
    let consumed = 0;
    while (!stream.ended) {
      const window = reader.window();
      if (window.length === 0) throw new CorruptError(`truncated pack entry at ${dataOff}`);
      const used =
        exactInflater === null
          ? stream.push(window)
          : pushExactInflate(exactInflater, window, `pack entry at ${dataOff}`);
      consumed += used;
      reader.seek(reader.position + (stream.ended ? used : window.length));
    }
    if (stream.inflated !== entrySize) {
      throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
    }
    return {
      data: exactInflater?.finish() ?? null,
      consumed,
      streamedOid: buffered || sha === null ? null : toHex(sha.digest()),
    };
  }
}

/** Rotating (offset -> oid) map: ofs-delta bases are almost always recent. */
class OffsetWindow {
  #current = new Map<number, string>();
  #previous = new Map<number, string>();

  set(offset: number, oid: string): void {
    this.#current.set(offset, oid);
    if (this.#current.size >= OFFSET_WINDOW) {
      this.#previous = this.#current;
      this.#current = new Map();
    }
  }

  get(offset: number): string | null {
    return this.#current.get(offset) ?? this.#previous.get(offset) ?? null;
  }
}

interface EntryHeader {
  offset: number;
  dataOff: number;
  type: number;
  entrySize: number;
  kind: "ofs" | "ref" | null;
  baseDelta: number | null;
  baseOid: string | null;
}

/** Sequential cursor over a pack stored as chunk rows. */
class PackReader {
  #position = 0;

  constructor(
    private readonly store: PackStore,
    readonly packId: number,
    readonly limit: number,
  ) {}

  get position(): number {
    return this.#position;
  }

  seek(position: number): void {
    this.#position = position;
  }

  byte(): number {
    if (this.#position >= this.limit) throw new CorruptError("pack truncated");
    const value = this.store.readRaw(this.packId, this.#position, 1)[0]!;
    this.#position += 1;
    return value;
  }

  take(length: number): Uint8Array {
    const bytes = this.store.readRaw(this.packId, this.#position, length);
    this.#position += length;
    return bytes;
  }

  uint32(): number {
    const bytes = this.take(4);
    return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  }

  /** Remaining bytes of the chunk row containing the cursor. */
  window(): Uint8Array {
    if (this.#position >= this.limit) return new Uint8Array(0);
    const chunkStart = Math.floor(this.#position / PACK_CHUNK) * PACK_CHUNK;
    const end = Math.min(chunkStart + PACK_CHUNK, this.limit);
    return this.store.readRaw(this.packId, this.#position, end - this.#position);
  }

  entryHeader(): EntryHeader {
    const offset = this.#position;
    let byte = this.byte();
    const type = (byte >> 4) & 7;
    let entrySize = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = this.byte();
      entrySize += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let kind: "ofs" | "ref" | null = null;
    let baseDelta: number | null = null;
    let baseOid: string | null = null;
    if (type === 6) {
      kind = "ofs";
      byte = this.byte();
      let delta = byte & 0x7f;
      while (byte & 0x80) {
        byte = this.byte();
        delta = (delta + 1) * 128 + (byte & 0x7f);
      }
      baseDelta = delta;
    } else if (type === 7) {
      kind = "ref";
      baseOid = toHex(this.take(20));
    } else if (NUMBER_TYPE[type] === undefined) {
      throw new CorruptError(`bad object type ${type} at ${offset}`);
    }
    return { offset, dataOff: this.#position, type, entrySize, kind, baseDelta, baseOid };
  }
}
