// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.
//
// Pack-native object storage. A received packfile is written to SQLite
// verbatim, still compressed, in fixed-size chunk rows, and indexed
// (oid -> pack, offset, delta base). Reads pull only the chunks an object
// actually spans, so nothing ever inflates a whole repository.

import { concat, toHex } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { ByteLru } from "../core/lru.js";
import {
  hashObject,
  NUMBER_TYPE,
  type ObjectType,
  objectHeader,
  type RawObject,
} from "../core/objects.js";
import { applyDelta } from "../core/pack/delta.js";
import { Sha1 } from "../core/sha1.js";
import { InflateStream } from "../core/zlib.js";
import {
  type CommitCacheEntry,
  type CommitCacheSource,
  insertCommitCaches,
  MAX_COMMIT_CACHE_BYTES,
  MAX_INDEXED_COMMIT_BYTES,
  prepareCommitCache,
} from "./commits.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
import { indexTreeSource, indexTreeSources, type TreeSourceInput } from "./schema.js";

/** Bytes per `git_pack_data` row. Comfortably under the DO row limit. */
export const PACK_CHUNK = 1024 * 1024;

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

/** Recent (offset -> oid) pairs kept in memory for ofs-delta bases. */
const OFFSET_WINDOW = 100_000;

export interface PackCacheOptions {
  /** Bytes of still-compressed pack rows held hot. */
  chunkBytes?: number;
  /** Largest entry inflated into one buffer. Anything above streams. */
  maxBufferedEntry?: number;
  /** Largest object admitted to the shared object cache. */
  cacheEntryLimit?: number;
  /** Test seam; production uses `MAX_DELTA_DEPTH`. */
  maxDeltaDepth?: number;
}

const DEFAULT_CHUNK_BYTES = 4 * PACK_CHUNK;
const DEFAULT_MAX_BUFFERED_ENTRY = 8 * 1024 * 1024;
const DEFAULT_CACHE_ENTRY_LIMIT = 2 * 1024 * 1024;
export const MAX_PACK_DELTA_WORKING_BYTES = 48 * 1024 * 1024;
const PACK_READ_BYTES = 1024 * 1024;
const PACK_INFLATE_HEADROOM_BYTES = 16 * 1024 * 1024;
const PACK_OBJECT_CACHE_RESERVE_BYTES = 16 * 1024 * 1024;
const PACK_TREE_BATCH_BYTES = 1024 * 1024;
const PACK_TREE_BATCH_SOURCES = 2048;
const PACK_COMMIT_BATCH_SOURCES = 2048;
const PACK_BLOB_GRAPH_METADATA_BYTES = 2 * 1024 * 1024;
const PACK_EXTERNAL_BASE_BYTES = MAX_PACK_BLOB_BATCH_BYTES + 64 * 1024;

// Delta buffers, one compressed row, both caches, both parsed-object sinks,
// bounded commit re-inflation and inflater headroom peak below 100 MiB.
const PACK_MEMORY_MODEL_BYTES =
  MAX_PACK_DELTA_WORKING_BYTES +
  PACK_READ_BYTES +
  DEFAULT_CHUNK_BYTES +
  PACK_OBJECT_CACHE_RESERVE_BYTES +
  PACK_TREE_BATCH_BYTES +
  MAX_COMMIT_CACHE_BYTES +
  2 * MAX_INDEXED_COMMIT_BYTES +
  PACK_INFLATE_HEADROOM_BYTES;
if (PACK_MEMORY_MODEL_BYTES > 100 * 1024 * 1024) {
  throw new Error("pack memory model exceeds 100 MiB");
}

// Delta buffers, the lazy chunk row, both shared caches, compressed graph,
// an external base stream, returned blobs, metadata and inflater headroom stay below 100 MiB.
const PACK_BLOB_MEMORY_MODEL_BYTES =
  MAX_PACK_DELTA_WORKING_BYTES +
  PACK_READ_BYTES +
  DEFAULT_CHUNK_BYTES +
  PACK_OBJECT_CACHE_RESERVE_BYTES +
  MAX_PACK_BLOB_BATCH_BYTES * 2 +
  PACK_EXTERNAL_BASE_BYTES +
  PACK_BLOB_GRAPH_METADATA_BYTES +
  PACK_INFLATE_HEADROOM_BYTES;
if (PACK_BLOB_MEMORY_MODEL_BYTES > 100 * 1024 * 1024) {
  throw new Error("packed blob batch memory model exceeds 100 MiB");
}

function packObjectKey(packId: number, oid: string): string {
  return `pack:${packId}:${oid}`;
}

function isObjectType(value: string): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
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
}

export interface PackIngestResult {
  packId: number;
  count: number;
  bytes: number;
}

/** Resolves an oid the pack index does not hold (loose storage, thin-pack bases). */
export type ExternalResolver = (oid: string) => RawObject | null;
export type ExternalBatchResolver = (oids: readonly string[]) => Map<string, RawObject>;

interface BulkPackRow extends PackObjectRow {
  oid: string;
}

interface CompressedEntry {
  bytes: Uint8Array;
  filled: number;
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

/** Parsed pack trees pending a bounded, transactional index flush. */
class PackTreeIndex {
  readonly #sources: TreeSourceInput[] = [];
  #bytes = 0;

  constructor(private readonly db: SqlDatabase) {}

  add(source: TreeSourceInput, bufferedBytes: number): void {
    if (
      this.#sources.length > 0 &&
      (this.#sources.length >= PACK_TREE_BATCH_SOURCES ||
        this.#bytes + bufferedBytes > PACK_TREE_BATCH_BYTES)
    ) {
      this.flush();
    }
    if (bufferedBytes > PACK_TREE_BATCH_BYTES) {
      this.db.transactionSync(() => indexTreeSource(this.db, source, source.chunks));
      return;
    }
    this.#sources.push(source);
    this.#bytes += bufferedBytes;
  }

  flush(): void {
    if (this.#sources.length === 0) return;
    this.db.transactionSync(() => indexTreeSources(this.db, this.#sources));
    this.#sources.length = 0;
    this.#bytes = 0;
  }
}

/** Parsed pack commits pending a bounded, transactionally hidden flush. */
class PackCommitIndex {
  readonly #entries: CommitCacheEntry[] = [];
  #bytes = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly packId: number,
  ) {}

  add(source: CommitCacheSource): void {
    const entry = prepareCommitCache(source);
    if (entry.cacheBytes > MAX_COMMIT_CACHE_BYTES) {
      throw new GitError("E2BIG", `packed commit ${source.oid} exceeds the cache batch limit`);
    }
    if (
      this.#entries.length > 0 &&
      (this.#entries.length >= PACK_COMMIT_BATCH_SOURCES ||
        this.#bytes + entry.cacheBytes > MAX_COMMIT_CACHE_BYTES)
    ) {
      this.#stage();
    }
    this.#entries.push(entry);
    this.#bytes += entry.cacheBytes;
  }

  /** Flush the final batch after the caller marks the pack complete. */
  finish(): void {
    this.#insert();
    this.#clear();
  }

  /** Persist a full batch while leaving the pack externally pending. */
  #stage(): void {
    this.db.transactionSync(() => {
      this.#setState("complete");
      this.#insert();
      this.#setState("pending");
    });
    this.#clear();
  }

  #setState(state: "complete" | "pending"): void {
    this.db.run(
      "UPDATE git_pack_meta SET state = ? WHERE repo_id = ? AND pack_id = ?",
      state,
      this.repoId,
      this.packId,
    );
  }

  #insert(): void {
    if (this.#entries.length === 0) return;
    const result = insertCommitCaches(this.db, this.#entries);
    if (result.eligible !== this.#entries.length || result.written !== this.#entries.length) {
      throw new CorruptError(
        `packed commit cache wrote ${result.written} of ${this.#entries.length} required rows`,
      );
    }
  }

  #clear(): void {
    this.#entries.length = 0;
    this.#bytes = 0;
  }
}

export class PackStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #external: ExternalResolver;
  readonly #externalBatch: ExternalBatchResolver;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #chunks: ByteLru<string, Uint8Array>;
  readonly #maxBufferedEntry: number;
  readonly #cacheEntryLimit: number;
  readonly #maxDeltaDepth: number;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    external: ExternalResolver,
    externalBatch: ExternalBatchResolver,
    options: PackCacheOptions = {},
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#external = external;
    this.#externalBatch = externalBatch;
    this.#objects = objects;
    this.#chunks = new ByteLru(
      Math.min(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, DEFAULT_CHUNK_BYTES),
      (c) => c.length,
    );
    this.#maxBufferedEntry = Math.min(
      options.maxBufferedEntry ?? DEFAULT_MAX_BUFFERED_ENTRY,
      DEFAULT_MAX_BUFFERED_ENTRY,
    );
    this.#cacheEntryLimit = options.cacheEntryLimit ?? DEFAULT_CACHE_ENTRY_LIMIT;
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

  lookup(oid: string): PackedEntry | null {
    const row = this.#db.one<PackObjectRow>(
      "SELECT pack_id, offset, data_off, data_len, type, size, entry_size, base_oid FROM git_pack_objects WHERE repo_id = ? AND oid = ?",
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
      "SELECT type, size FROM git_pack_objects WHERE repo_id = ? AND oid = ?",
      this.#repoId,
      oid,
    );
    return row ?? null;
  }

  count(): number {
    return (
      this.#db.scalar<number>(
        "SELECT COUNT(*) FROM git_pack_objects WHERE repo_id = ?",
        this.#repoId,
      ) ?? 0
    );
  }

  findPrefix(prefix: string, limit: number): string[] {
    return this.#db
      .all<{ oid: string }>(
        "SELECT oid FROM git_pack_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT ?",
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
      .all<{ oid: string }>("SELECT oid FROM git_pack_objects WHERE repo_id = ?", this.#repoId)
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
    const cached = this.#objects.get(packObjectKey(first.packId, oid));
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
      const cachedBase = this.#objects.get(packObjectKey(next.packId, next.oid));
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
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    if (wanted.length > MAX_PACK_BLOB_INPUTS) {
      throw new GitError("E2BIG", `blob batch exceeds ${MAX_PACK_BLOB_INPUTS} packed inputs`);
    }

    const rows = this.#db.all<BulkPackRow>(
      `WITH RECURSIVE
         roots(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         reachable(oid) AS (
           SELECT o.oid
             FROM roots r
             CROSS JOIN git_pack_objects o
             CROSS JOIN git_pack_meta m
            WHERE o.repo_id = ? AND o.oid = r.oid
              AND m.repo_id = o.repo_id AND m.pack_id = o.pack_id AND m.state = 'complete'
           UNION
           SELECT base.oid
             FROM reachable r
             CROSS JOIN git_pack_objects child
             CROSS JOIN git_pack_meta child_meta
             CROSS JOIN git_pack_objects base
             CROSS JOIN git_pack_meta base_meta
            WHERE child.repo_id = ? AND child.oid = r.oid
              AND child_meta.repo_id = child.repo_id
              AND child_meta.pack_id = child.pack_id AND child_meta.state = 'complete'
              AND base.repo_id = child.repo_id AND base.oid = child.base_oid
              AND base_meta.repo_id = base.repo_id
              AND base_meta.pack_id = base.pack_id AND base_meta.state = 'complete'
         )
       SELECT o.oid, o.pack_id, o.offset, o.data_off, o.data_len, o.type,
              o.size, o.entry_size, o.base_oid
         FROM reachable r
         CROSS JOIN git_pack_objects o
        WHERE o.repo_id = ? AND o.oid = r.oid
        LIMIT ${MAX_PACK_BLOB_GRAPH_ENTRIES + 1}`,
      JSON.stringify(wanted),
      this.#repoId,
      this.#repoId,
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
    for (const oid of wanted) {
      const entry = entries.get(oid);
      if (entry === undefined) throw new CorruptError(`packed blob ${oid} has no complete source`);
      if (entry.type !== "blob") throw new CorruptError(`${oid} is a ${entry.type}, not a blob`);
    }

    const needed = new Map<string, PackedEntry>();
    const externalOids = new Set<string>();
    for (const oid of wanted) {
      let current = entries.get(oid)!;
      if (this.#objects.get(packObjectKey(current.packId, oid)) !== undefined) continue;
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
          externalOids.add(current.baseOid);
          break;
        }
        if (this.#objects.get(packObjectKey(next.packId, next.oid)) !== undefined) break;
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
      const hit = this.#chunks.get(key);
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
        this.#chunks.set(key, data);
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
    const result = new Map<string, Uint8Array>();
    for (const oid of wanted) {
      const first = entries.get(oid)!;
      const cached = this.#objects.get(packObjectKey(first.packId, oid));
      if (cached !== undefined) {
        if (cached.type !== "blob") throw new CorruptError(`${oid} is not a blob`);
        result.set(oid, cached.data);
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
          object = external.get(current.baseOid);
          if (object === undefined) {
            throw new CorruptError(`missing delta base ${current.baseOid} for ${current.oid}`);
          }
          break;
        }
        const cachedBase = this.#objects.get(packObjectKey(next.packId, next.oid));
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
      if (object.type !== "blob" || object.data.length !== first.size) {
        throw new CorruptError(`packed blob ${oid} has inconsistent type or size`);
      }
      result.set(oid, object.data);
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
    const result = new Uint8Array(expectedSize);
    let produced = 0;
    const stream = new InflateStream((chunk) => {
      if (chunk.length > expectedSize - produced) {
        throw new CorruptError(`${label} exceeds its indexed size`);
      }
      result.set(chunk, produced);
      produced += chunk.length;
    });
    let consumed = 0;
    try {
      while (!stream.ended && consumed < input.length) {
        const used = stream.push(input.subarray(consumed));
        consumed += used;
        if (!stream.ended && used === 0) {
          throw new CorruptError(`${label} inflater made no progress`);
        }
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
    }
    if (!stream.ended || consumed !== input.length || produced !== expectedSize) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    return result;
  }

  #cacheObject(packId: number, oid: string, object: RawObject): void {
    if (object.data.length <= this.#cacheEntryLimit) {
      this.#objects.set(packObjectKey(packId, oid), object);
    }
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
    const result = new Uint8Array(expectedSize);
    let produced = 0;
    const stream = new InflateStream((chunk) => {
      if (chunk.length > expectedSize - produced) {
        throw new CorruptError(`${label} exceeds its indexed size`);
      }
      result.set(chunk, produced);
      produced += chunk.length;
    });
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
      const input = this.readRaw(packId, dataOff + consumed, length);
      const used = stream.push(input);
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    }
    if (!stream.ended || consumed !== dataLen || produced !== expectedSize) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    return result;
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
   * One decoded `git_pack_data` row through the LRU. Rows are immutable
   * once written — a chunk is inserted exactly once and only ever removed
   * wholesale, at which point the cache is cleared — so a hit is never
   * stale.
   */
  #chunk(packId: number, seq: number): Uint8Array {
    const key = `${packId}:${seq}`;
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
    this.#chunks.clear();
  }

  /** Drop every pack left half-written by an interrupted ingest. */
  reclaimPending(): number {
    const pending = this.#db.all<{ pack_id: number }>(
      "SELECT pack_id FROM git_pack_meta WHERE repo_id = ? AND state != 'complete'",
      this.#repoId,
    );
    const orphaned = this.#db.all<{ pack_id: number }>(
      `SELECT DISTINCT d.pack_id AS pack_id FROM git_pack_data d
         LEFT JOIN git_pack_meta m ON m.repo_id = d.repo_id AND m.pack_id = d.pack_id
        WHERE d.repo_id = ? AND m.pack_id IS NULL`,
      this.#repoId,
    );
    const ids = new Set([...pending, ...orphaned].map((row) => row.pack_id));
    if (ids.size === 0) return 0;
    this.#db.transactionSync(() => {
      for (const packId of ids) this.#deletePack(packId);
    });
    this.#chunks.clear();
    return ids.size;
  }

  #deletePack(packId: number): void {
    this.#db.run(
      "DELETE FROM git_tree_entries WHERE repo_id = ? AND storage = 'pack' AND source_id = ?",
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
    this.reclaimPending();
    const packId =
      (this.#db.scalar<number | null>(
        "SELECT MAX(pack_id) FROM git_pack_meta WHERE repo_id = ?",
        this.#repoId,
      ) ?? 0) + 1;
    const now = options.now ?? Date.now;
    const say = options.onProgress ?? (() => {});
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const yieldNow = options.yieldNow ?? (() => Promise.resolve());

    this.#db.run(
      "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, 0, 0, 'pending', ?)",
      this.#repoId,
      packId,
      now(),
    );

    const total = await this.#writeChunks(source, packId, maxBytes, say, yieldNow);
    const { count, commits } = await this.#indexPack(packId, total, say, yieldNow);

    this.#db.transactionSync(() => {
      this.#db.run(
        "UPDATE git_pack_meta SET size = ?, count = ?, state = 'complete' WHERE repo_id = ? AND pack_id = ?",
        total,
        count,
        this.#repoId,
        packId,
      );
      commits.finish();
    });
    return { packId, count, bytes: total };
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
  ): Promise<number> {
    const sha = new Sha1();
    let tail = new Uint8Array(0); // rolling 20-byte lookbehind: the trailer
    let total = 0;
    let seq = 0;
    let announced = 0;
    const buffer = new Uint8Array(PACK_CHUNK);
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
        await yieldNow();
      }
    }
    if (filled > 0) this.#writeChunk(packId, seq++, buffer.slice(0, filled));

    if (total < 32) throw new CorruptError("pack is too small to be valid");
    if (toHex(tail) !== toHex(sha.digest())) throw new CorruptError("pack checksum mismatch");
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
  ): Promise<{ count: number; commits: PackCommitIndex }> {
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
    const treeIndex = new PackTreeIndex(this.#db);
    const commitIndex = new PackCommitIndex(this.#db, this.#repoId, packId);
    const offsetToOid = (offset: number): string | null => {
      const hit = offsets.get(offset);
      if (hit !== null) return hit;
      const row = this.#db.one<{ oid: string }>(
        "SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ? AND offset = ?",
        this.#repoId,
        packId,
        offset,
      );
      return row?.oid ?? null;
    };

    let deferred = 0;
    for (let i = 0; i < count; i++) {
      const header = reader.entryHeader();
      const entryType = header.kind === null ? NUMBER_TYPE[header.type]! : null;
      const entry = this.#inflateAt(reader, header.dataOff, header.entrySize, entryType);

      if (header.kind === null) {
        const type = entryType!;
        const oid = entry.data === null ? entry.streamedOid! : hashObject(type, entry.data);
        const row: (string | number | null)[] = [
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
        );
        offsets.set(header.offset, oid);
        if (entry.data !== null) this.#cacheObject(packId, oid, { type, data: entry.data });
      } else {
        const baseOid =
          header.kind === "ref" ? header.baseOid! : offsetToOid(header.offset - header.baseDelta!);
        let resolved = false;
        if (entry.data !== null && baseOid !== null) {
          const base = this.#readForBase(baseOid);
          if (base !== null) {
            checkDeltaWorkingSet(base.data, entry.data);
            const data = applyDelta(base.data, entry.data);
            const oid = hashObject(base.type, data);
            const row: (string | number | null)[] = [
              oid,
              packId,
              header.offset,
              header.dataOff,
              entry.consumed,
              base.type,
              data.length,
              header.entrySize,
              baseOid,
            ];
            this.#insertResolved(
              row,
              packId,
              oid,
              base.type,
              data,
              treeIndex,
              commitIndex,
              header.dataOff,
              entry.consumed,
              data.length,
            );
            offsets.set(header.offset, oid);
            this.#cacheObject(packId, oid, { type: base.type, data });
            resolved = true;
          }
        }
        if (!resolved) {
          this.#db.run(
            "INSERT OR REPLACE INTO git_pack_pending (repo_id, pack_id, offset, data_off, data_len, entry_size, base_oid, base_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            this.#repoId,
            packId,
            header.offset,
            header.dataOff,
            entry.consumed,
            header.entrySize,
            header.kind === "ref" ? header.baseOid : null,
            header.kind === "ofs" ? header.offset - header.baseDelta! : null,
          );
          deferred++;
        }
      }

      if ((i & 1023) === 1023) {
        await yieldNow();
        if ((i & 65535) === 65535) say(`Resolving deltas: ${i + 1}/${count}\n`);
      }
    }

    if (reader.position !== total - 20) {
      throw new CorruptError("pack has trailing data or a bad object count");
    }
    await this.#drainPending(packId, offsets, offsetToOid, treeIndex, commitIndex, yieldNow);
    treeIndex.flush();
    if (deferred > 0) say(`Resolved ${deferred} deferred delta(s)\n`);
    return { count, commits: commitIndex };
  }

  /** A base that lives in an already-indexed pack, loose storage, or another pack. */
  #readForBase(oid: string): RawObject | null {
    const packed = this.read(oid);
    if (packed !== null) return packed;
    return this.#external(oid);
  }

  async #drainPending(
    packId: number,
    offsets: OffsetWindow,
    offsetToOid: (offset: number) => string | null,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    yieldNow: () => Promise<void>,
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
        const page = this.#db.all<{
          offset: number;
          data_off: number;
          data_len: number;
          entry_size: number;
          base_oid: string | null;
          base_offset: number | null;
        }>(
          "SELECT offset, data_off, data_len, entry_size, base_oid, base_offset FROM git_pack_pending WHERE repo_id = ? AND pack_id = ? AND offset > ? ORDER BY offset LIMIT 256",
          this.#repoId,
          packId,
          after,
        );
        if (page.length === 0) break;
        for (const row of page) {
          after = row.offset;
          const baseOid =
            row.base_oid ?? (row.base_offset === null ? null : offsetToOid(row.base_offset));
          if (baseOid === null) continue;
          const base = this.#readForBase(baseOid);
          if (base === null) continue;
          checkDeltaInflateBudget(base.data, row.entry_size);
          const delta = this.#inflateStoredEntry(
            packId,
            row.data_off,
            row.data_len,
            row.entry_size,
            `delta at ${row.offset}`,
          );
          checkDeltaWorkingSet(base.data, delta);
          const data = applyDelta(base.data, delta);
          const oid = hashObject(base.type, data);
          const objectRow: (string | number | null)[] = [
            oid,
            packId,
            row.offset,
            row.data_off,
            row.data_len,
            base.type,
            data.length,
            row.entry_size,
            baseOid,
          ];
          this.#insertResolved(
            objectRow,
            packId,
            oid,
            base.type,
            data,
            treeIndex,
            commitIndex,
            row.data_off,
            row.data_len,
            data.length,
          );
          this.#db.run(
            "DELETE FROM git_pack_pending WHERE repo_id = ? AND pack_id = ? AND offset = ?",
            this.#repoId,
            packId,
            row.offset,
          );
          offsets.set(row.offset, oid);
          this.#cacheObject(packId, oid, { type: base.type, data });
          progressed++;
        }
        await yieldNow();
      }
      remaining -= progressed;
      if (progressed === 0 && remaining > 0) {
        throw new CorruptError(`cannot resolve ${remaining} delta object(s): missing base`);
      }
    }
  }

  #insertObject(row: (string | number | null)[]): void {
    // OR IGNORE, never OR REPLACE: a duplicate object keeps its first
    // location. Re-pointing it at the incoming pack would make it
    // unresolvable if this ingest is later reclaimed.
    this.#db.run(
      "INSERT OR IGNORE INTO git_pack_objects (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      this.#repoId,
      ...row,
    );
  }

  #insertResolved(
    row: (string | number | null)[],
    packId: number,
    oid: string,
    type: ObjectType,
    data: Uint8Array | null,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    dataOff: number,
    dataLen: number,
    objectSize: number,
  ): void {
    this.#db.transactionSync(() => this.#insertObject(row));
    if (type === "commit") {
      if (objectSize > MAX_INDEXED_COMMIT_BYTES) {
        throw new GitError(
          "E2BIG",
          `packed commit ${oid} exceeds the ${MAX_INDEXED_COMMIT_BYTES}-byte index limit`,
        );
      }
      const commitData =
        data ?? concat([...this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize)]);
      commitIndex.add({ repoId: this.#repoId, oid, data: commitData });
    }
    if (type !== "tree") return;
    const chunks =
      data === null ? this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize) : [data];
    treeIndex.add(
      {
        repoId: this.#repoId,
        treeOid: oid,
        storage: "pack",
        sourceId: packId,
        objectSize,
        chunks,
      },
      data?.length ?? objectSize,
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
    const chunks: Uint8Array[] = [];
    let produced = 0;
    const sha = type === null ? null : new Sha1().update(objectHeader(type, entrySize));
    const stream = new InflateStream((chunk) => {
      produced += chunk.length;
      if (produced > entrySize) {
        throw new CorruptError(`pack entry exceeds its declared size at ${dataOff}`);
      }
      sha?.update(chunk);
      if (buffered) chunks.push(chunk);
    });
    reader.seek(dataOff);
    let consumed = 0;
    while (!stream.ended) {
      const window = reader.window();
      if (window.length === 0) throw new CorruptError(`truncated pack entry at ${dataOff}`);
      const used = stream.push(window);
      consumed += used;
      reader.seek(reader.position + (stream.ended ? used : window.length));
    }
    if (stream.inflated !== entrySize) {
      throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
    }
    return {
      data: buffered ? concat(chunks) : null,
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
