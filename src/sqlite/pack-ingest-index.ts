import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { hashObject, type ObjectType, parseCommit } from "../core/objects.js";
import { type ChunkedBytes, type ChunkPool, PACK_CHUNK_BYTES } from "../core/pack/chunks.js";
import type { MemoryReservation } from "../memory.js";
import {
  COMMIT_CACHE_FLUSH_BYTES,
  type CommitCacheEntry,
  type CommitCacheSource,
  commitCacheFlushTransientBytes,
  commitPreparationTransientBytes,
  insertCommitCaches,
  prepareCommitCacheOwned,
} from "./commits.js";
import type { SqlDatabase } from "./db.js";
import {
  createTreeIndexSink,
  indexTreeSource,
  indexTreeSources,
  type TreeSource,
  type TreeSourceInput,
} from "./tree-index.js";

export const PACK_TREE_BATCH_BYTES = 1024 * 1024;
const PACK_TREE_BATCH_SOURCES = 2048;
const PACK_TREE_SOURCE_BYTES = 256;
export const PACK_TREE_CHUNK_BYTES = 64;
const PACK_TREE_CHUNK_ARRAY_BYTES = 64;
const PACK_TREE_DIRECT_FIXED_BYTES =
  PACK_TREE_SOURCE_BYTES + PACK_TREE_CHUNK_ARRAY_BYTES + PACK_TREE_CHUNK_BYTES;
const PACK_COMMIT_BATCH_SOURCES = 2048;
export const PACK_COMMIT_PAYLOAD_BYTES = 256;
const PACK_INDEX_BATCH_BYTES = 1024 * 1024;
const PACK_INDEX_BATCH_ROWS = 2048;
export const PACK_PENDING_PAGE_ROWS = 4096;
export const PACK_PENDING_PAGE_MEMORY_BYTES = PACK_PENDING_PAGE_ROWS * 512;
export const PACK_INDEX_MEMORY_BYTES = 3 * 1024 * 1024;
export const PACK_OFFSET_WINDOW_BYTES = 2 * 1024 * 1024;
export const PACK_INGEST_METADATA_BYTES =
  PACK_INDEX_MEMORY_BYTES + PACK_OFFSET_WINDOW_BYTES + PACK_PENDING_PAGE_MEMORY_BYTES;

function largeCommitParserBytes(data: Uint8Array): number {
  let physicalLines = 1;
  for (const byte of data) if (byte === 0x0a) physicalLines++;
  const retained = 1_024 + 6 * data.length + 128 * physicalLines;
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "packed commit parser memory accounting overflow");
  }
  return retained;
}

function validateLargeCommit(source: CommitCacheSource, reservation: MemoryReservation): void {
  if (!Number.isSafeInteger(source.repoId) || source.repoId < 1 || !isOid(source.oid)) {
    throw new CorruptError("commit cache source identity is invalid");
  }
  reservation.set("commit", largeCommitParserBytes(source.data));
  if (hashObject("commit", source.data) !== source.oid) {
    throw new CorruptError(`commit cache source ${source.oid} does not match its bytes`);
  }
  const commit = parseCommit(source.data);
  for (const value of [
    commit.author.timestamp,
    commit.author.timezoneOffset,
    commit.committer.timestamp,
    commit.committer.timezoneOffset,
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new GitError("E2BIG", "commit has an unrepresentable identity number");
    }
  }
}

export type PackObjectInput = [
  oid: string,
  packId: number,
  offset: number,
  dataOff: number,
  dataLen: number,
  type: ObjectType,
  size: number,
  entrySize: number,
  baseOid: string | null,
];

export type PendingInput = [
  offset: number,
  dataOff: number,
  dataLen: number,
  entrySize: number,
  baseOid: string | null,
  baseOffset: number | null,
];

export interface PendingRow {
  offset: number;
  data_off: number;
  data_len: number;
  entry_size: number;
  base_oid: string | null;
  base_offset: number | null;
  resolved_oid: string | null;
}

export function validatePendingRow(row: PendingRow): void {
  if (
    !Number.isSafeInteger(row.offset) ||
    !Number.isSafeInteger(row.data_off) ||
    !Number.isSafeInteger(row.data_len) ||
    !Number.isSafeInteger(row.entry_size) ||
    row.offset < 0 ||
    row.data_off < 0 ||
    row.data_len < 0 ||
    row.entry_size < 0 ||
    !Number.isSafeInteger(row.data_off + row.data_len) ||
    (row.base_oid === null) === (row.base_offset === null) ||
    (row.base_oid !== null && !isOid(row.base_oid)) ||
    (row.base_offset !== null && (!Number.isSafeInteger(row.base_offset) || row.base_offset < 0)) ||
    (row.resolved_oid !== null && !isOid(row.resolved_oid))
  ) {
    throw new CorruptError("pending pack delta has invalid metadata");
  }
}

const PACK_JSON_ENCODER = new TextEncoder();

export class PackObjectBatch {
  readonly #rows: string[] = [];
  #bytes = 2;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly onAdd: ((row: PackObjectInput) => void) | undefined = undefined,
  ) {}

  add(row: PackObjectInput): void {
    this.onAdd?.(row);
    const json = JSON.stringify(row);
    const bytes = PACK_JSON_ENCODER.encode(json).length;
    if (
      this.#rows.length > 0 &&
      (this.#rows.length >= PACK_INDEX_BATCH_ROWS ||
        this.#bytes + 1 + bytes > PACK_INDEX_BATCH_BYTES)
    ) {
      this.flush();
    }
    if (bytes + 2 > PACK_INDEX_BATCH_BYTES) {
      throw new GitError("E2BIG", "one pack object index row exceeds the batch limit");
    }
    this.#bytes += (this.#rows.length === 0 ? 0 : 1) + bytes;
    this.#rows.push(json);
  }

  flush(): void {
    if (this.#rows.length === 0) return;
    const rows = `[${this.#rows.join(",")}]`;
    this.db.transactionSync(() => {
      this.db.run(
        `INSERT OR IGNORE INTO git_pack_entries
           (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]'), json_extract(value, '$[5]'),
                json_extract(value, '$[6]'), json_extract(value, '$[7]'),
                json_extract(value, '$[8]')
           FROM json_each(?)`,
        this.repoId,
        rows,
      );
      this.db.run(
        `INSERT OR IGNORE INTO git_pack_objects
           (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]'), json_extract(value, '$[5]'),
                json_extract(value, '$[6]'), json_extract(value, '$[7]'),
                json_extract(value, '$[8]')
           FROM json_each(?)`,
        this.repoId,
        rows,
      );
    });
    this.#rows.length = 0;
    this.#bytes = 2;
  }
}

export class PackPendingBatch {
  readonly #rows: string[] = [];
  #bytes = 2;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly packId: number,
  ) {}

  add(row: PendingInput): void {
    const json = JSON.stringify(row);
    const bytes = PACK_JSON_ENCODER.encode(json).length;
    if (
      this.#rows.length > 0 &&
      (this.#rows.length >= PACK_INDEX_BATCH_ROWS ||
        this.#bytes + 1 + bytes > PACK_INDEX_BATCH_BYTES)
    ) {
      this.flush();
    }
    if (bytes + 2 > PACK_INDEX_BATCH_BYTES) {
      throw new GitError("E2BIG", "one pending delta row exceeds the batch limit");
    }
    this.#bytes += (this.#rows.length === 0 ? 0 : 1) + bytes;
    this.#rows.push(json);
  }

  flush(): void {
    if (this.#rows.length === 0) return;
    this.db.run(
      `INSERT OR REPLACE INTO git_pack_pending
         (repo_id, pack_id, offset, data_off, data_len, entry_size, base_oid, base_offset)
       SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
              json_extract(value, '$[2]'), json_extract(value, '$[3]'),
              json_extract(value, '$[4]'), json_extract(value, '$[5]')
         FROM json_each(?)`,
      this.repoId,
      this.packId,
      `[${this.#rows.join(",")}]`,
    );
    this.#rows.length = 0;
    this.#bytes = 2;
  }
}

/** Parsed pack trees pending a bounded, transactional index flush. */
export class PackTreeIndex {
  readonly #sources: TreeSourceInput[] = [];
  #payloadBytes = 0;
  #retainedBytes = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly reservation: MemoryReservation,
  ) {}

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  addBuffered(
    repoId: number,
    treeOid: string,
    sourceId: number,
    objectSize: number,
    data: Uint8Array,
  ): void {
    const retained = this.#sourceBytes(data.length, 1);
    if (
      this.#sources.length > 0 &&
      (this.#sources.length >= PACK_TREE_BATCH_SOURCES ||
        this.#payloadBytes + data.length > PACK_TREE_BATCH_BYTES ||
        this.#retainedBytes + retained > PACK_TREE_BATCH_BYTES)
    ) {
      this.flush();
    }
    if (retained > PACK_TREE_BATCH_BYTES) {
      this.#direct(PACK_TREE_DIRECT_FIXED_BYTES, () =>
        indexTreeSource(
          this.db,
          this.#directSource(repoId, treeOid, sourceId, objectSize),
          [data],
          this.reservation,
        ),
      );
      return;
    }
    this.reservation.set("tree", this.#retainedBytes + retained);
    this.#sources.push(this.#source(repoId, treeOid, sourceId, objectSize, [data]));
    this.#payloadBytes += data.length;
    this.#retainedBytes += retained;
  }

  addStream(
    repoId: number,
    treeOid: string,
    sourceId: number,
    objectSize: number,
    chunks: () => Iterable<Uint8Array>,
  ): void {
    this.flush();
    this.#direct(PACK_TREE_DIRECT_FIXED_BYTES, () => {
      const source = this.#directSource(repoId, treeOid, sourceId, objectSize);
      indexTreeSource(
        this.db,
        source,
        this.#ownDirectChunks(chunks(), PACK_TREE_DIRECT_FIXED_BYTES),
        this.reservation,
      );
    });
  }

  addChunked(
    repoId: number,
    treeOid: string,
    sourceId: number,
    objectSize: number,
    target: ChunkedBytes,
  ): void {
    const chunkCount = Math.max(1, Math.ceil(target.length / PACK_CHUNK_BYTES));
    const retained = this.#sourceBytes(target.length, chunkCount);
    if (retained > PACK_TREE_BATCH_BYTES) {
      this.flush();
      this.#direct(PACK_TREE_DIRECT_FIXED_BYTES, () => {
        const source = this.#directSource(repoId, treeOid, sourceId, objectSize);
        const sink = createTreeIndexSink(this.db, source, this.reservation);
        try {
          for (const chunk of target.chunks()) sink.push(chunk);
          sink.finish();
        } finally {
          sink.dispose();
        }
      });
      return;
    }
    if (
      this.#sources.length > 0 &&
      (this.#sources.length >= PACK_TREE_BATCH_SOURCES ||
        this.#payloadBytes + target.length > PACK_TREE_BATCH_BYTES ||
        this.#retainedBytes + retained > PACK_TREE_BATCH_BYTES)
    ) {
      this.flush();
    }
    this.reservation.set("tree", this.#retainedBytes + retained);
    const chunks: Uint8Array[] = [];
    try {
      for (const chunk of target.chunks()) chunks.push(chunk.slice());
      this.#sources.push(this.#source(repoId, treeOid, sourceId, objectSize, chunks));
      this.#payloadBytes += target.length;
      this.#retainedBytes += retained;
    } catch (error) {
      this.reservation.set("tree", this.#retainedBytes);
      throw error;
    }
  }

  flush(): void {
    if (this.#sources.length === 0) return;
    try {
      this.db.transactionSync(() => indexTreeSources(this.db, this.#sources, this.reservation));
    } finally {
      this.#sources.length = 0;
      this.#payloadBytes = 0;
      this.#retainedBytes = 0;
      this.reservation.clear("tree");
    }
  }

  #sourceBytes(payloadBytes: number, chunkCount: number): number {
    const retained =
      payloadBytes +
      PACK_TREE_SOURCE_BYTES +
      PACK_TREE_CHUNK_ARRAY_BYTES +
      chunkCount * PACK_TREE_CHUNK_BYTES;
    if (!Number.isSafeInteger(retained)) {
      throw new GitError("E2BIG", "packed tree batch retained state is too large");
    }
    return retained;
  }

  #source(
    repoId: number,
    treeOid: string,
    sourceId: number,
    objectSize: number,
    chunks: Iterable<Uint8Array>,
  ): TreeSourceInput {
    return { repoId, treeOid, storage: "pack", sourceId, objectSize, chunks };
  }

  #directSource(repoId: number, treeOid: string, sourceId: number, objectSize: number): TreeSource {
    return { repoId, treeOid, storage: "pack", sourceId, objectSize };
  }

  *#ownDirectChunks(chunks: Iterable<Uint8Array>, retainedBytes: number): Generator<Uint8Array> {
    for (const chunk of chunks) {
      const currentBytes = retainedBytes + chunk.length;
      if (!Number.isSafeInteger(currentBytes)) {
        throw new GitError("E2BIG", "packed tree stream ownership is too large");
      }
      this.reservation.set("tree", currentBytes);
      try {
        yield chunk;
      } finally {
        this.reservation.set("tree", retainedBytes);
      }
    }
  }

  #direct(retainedBytes: number, write: () => void): void {
    try {
      this.reservation.set("tree", retainedBytes);
      this.db.transactionSync(write);
    } finally {
      this.reservation.clear("tree");
    }
  }
}

/** Parsed pack commits pending a bounded, transactionally hidden flush. */
export class PackCommitIndex {
  readonly #entries: CommitCacheEntry[] = [];
  #bytes = 0;
  #expected = 0;
  #eligible = 0;
  #skipped = 0;
  #written = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly packId: number,
    private readonly objects: PackObjectBatch,
    private readonly reservation: MemoryReservation,
    private readonly pool: ChunkPool,
  ) {}

  get retainedBytes(): number {
    return this.#bytes;
  }

  add(source: CommitCacheSource): void {
    this.reservation.set("pool", this.pool.allocatedBytes);
    let completed = false;
    try {
      this.#add(source);
      completed = true;
    } finally {
      if (completed) this.reservation.set("pool", this.pool.allocatedBytes);
    }
  }

  #add(source: CommitCacheSource): void {
    if (source.data.length > COMMIT_CACHE_FLUSH_BYTES) {
      const parserBytes = largeCommitParserBytes(source.data);
      if (this.#entries.length > 0 && parserBytes > this.reservation.remainingBytes) {
        this.#stage();
      }
      const parser = this.reservation.scope();
      try {
        validateLargeCommit(source, parser);
      } finally {
        parser.dispose();
      }
      this.#expected++;
      this.#skipped++;
      return;
    }
    const prepareBytes = commitPreparationTransientBytes(source.data.length);
    if (this.#entries.length > 0 && prepareBytes > this.reservation.remainingBytes) {
      this.#stage();
    }
    const preparation = this.reservation.scope();
    let entry: CommitCacheEntry;
    try {
      entry = prepareCommitCacheOwned(source, preparation);
    } finally {
      preparation.dispose();
    }
    this.#expected++;
    if (entry.cacheBytes > COMMIT_CACHE_FLUSH_BYTES) {
      this.#skipped++;
      return;
    }
    if (
      this.#entries.length > 0 &&
      (this.#entries.length >= PACK_COMMIT_BATCH_SOURCES ||
        this.#bytes + entry.cacheBytes > COMMIT_CACHE_FLUSH_BYTES)
    ) {
      this.#stage();
    }
    this.reservation.set("commit", this.#bytes + entry.cacheBytes);
    this.#entries.push(entry);
    this.#bytes += entry.cacheBytes;
  }

  /** Flush the final batch after the caller marks the pack complete. */
  finish(): void {
    this.objects.flush();
    this.#insert();
    this.#clear();
    if (this.#written !== this.#eligible || this.#eligible + this.#skipped !== this.#expected) {
      throw new CorruptError(
        `packed commit cache wrote ${this.#written} of ${this.#eligible} eligible rows and skipped ${this.#skipped} of ${this.#expected}`,
      );
    }
  }

  checkpoint(): void {
    if (this.#entries.length === 0) return;
    this.#stage();
  }

  /** Persist a full batch while leaving the pack externally pending. */
  #stage(): void {
    this.db.transactionSync(() => {
      this.objects.flush();
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
    this.reservation.set("commit", this.#bytes + commitCacheFlushTransientBytes(this.#entries));
    try {
      const result = insertCommitCaches(this.db, this.#entries);
      if (
        result.written !== result.eligible ||
        result.eligible + result.skipped !== this.#entries.length
      ) {
        throw new CorruptError(
          `packed commit cache wrote ${result.written} of ${result.eligible} eligible rows and skipped ${result.skipped} of ${this.#entries.length}`,
        );
      }
      this.#eligible += result.eligible;
      this.#skipped += result.skipped;
      this.#written += result.written;
    } finally {
      this.reservation.set("commit", this.#bytes);
    }
  }

  #clear(): void {
    this.#entries.length = 0;
    this.#bytes = 0;
    this.reservation.clear("commit");
  }
}
