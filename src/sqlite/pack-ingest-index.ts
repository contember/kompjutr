import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import type { ObjectType } from "../core/objects.js";
import { type ChunkedBytes, PACK_CHUNK_BYTES } from "../core/pack/chunks.js";
import type { MemoryReservation } from "../memory.js";
import {
  type CommitCacheEntry,
  type CommitCacheSource,
  insertCommitCaches,
  MAX_COMMIT_CACHE_BYTES,
  MAX_INDEXED_COMMIT_BYTES,
  prepareCommitCache,
} from "./commits.js";
import type { SqlDatabase } from "./db.js";
import {
  createTreeIndexSink,
  indexTreeSource,
  indexTreeSources,
  type TreeSourceInput,
} from "./tree-index.js";

export const PACK_TREE_BATCH_BYTES = 1024 * 1024;
const PACK_TREE_BATCH_SOURCES = 2048;
const PACK_TREE_SOURCE_BYTES = 256;
export const PACK_TREE_CHUNK_BYTES = 64;
const PACK_TREE_CHUNK_ARRAY_BYTES = 64;
const PACK_COMMIT_BATCH_SOURCES = 2048;
const PACK_COMMIT_PARSE_BYTES = 1024;
export const PACK_COMMIT_PAYLOAD_BYTES = 256;
const PACK_COMMIT_PHYSICAL_LINE_BYTES = 32;
const PACK_COMMIT_LOGICAL_HEADER_BYTES = 64;
const PACK_COMMIT_CONTINUATION_BYTES = 32;
const PACK_COMMIT_PAGE_ROWS = 2048;
const PACK_COMMIT_PAGE_JSON_BYTES = 1024 * 1024;
// Three UTF-16 page copies, one encoded binding, and bounded row-array wrappers.
const PACK_COMMIT_PAGE_TRANSIENT_BYTES =
  7 * PACK_COMMIT_PAGE_JSON_BYTES + PACK_COMMIT_PAGE_ROWS * PACK_COMMIT_LOGICAL_HEADER_BYTES;
const PACK_COMMIT_ACTIVE_HEADROOM_BYTES = 8 * 1024 * 1024;
const PACK_INDEX_BATCH_BYTES = 1024 * 1024;
const PACK_INDEX_BATCH_ROWS = 2048;
export const PACK_PENDING_PAGE_ROWS = 4096;
export const PACK_PENDING_PAGE_MEMORY_BYTES = PACK_PENDING_PAGE_ROWS * 512;
export const PACK_INDEX_MEMORY_BYTES = 3 * 1024 * 1024;
export const PACK_OFFSET_WINDOW_BYTES = 2 * 1024 * 1024;
export const PACK_INGEST_METADATA_BYTES =
  PACK_INDEX_MEMORY_BYTES + PACK_OFFSET_WINDOW_BYTES + PACK_PENDING_PAGE_MEMORY_BYTES;

function commitHeaderKind(data: Uint8Array, start: number, end: number): number {
  const length = end - start;
  if (
    length === 4 &&
    data[start] === 0x74 &&
    data[start + 1] === 0x72 &&
    data[start + 2] === 0x65 &&
    data[start + 3] === 0x65
  ) {
    return 1;
  }
  if (
    length === 6 &&
    data[start] === 0x70 &&
    data[start + 1] === 0x61 &&
    data[start + 2] === 0x72 &&
    data[start + 3] === 0x65 &&
    data[start + 4] === 0x6e &&
    data[start + 5] === 0x74
  ) {
    return 2;
  }
  if (
    length === 6 &&
    data[start] === 0x61 &&
    data[start + 1] === 0x75 &&
    data[start + 2] === 0x74 &&
    data[start + 3] === 0x68 &&
    data[start + 4] === 0x6f &&
    data[start + 5] === 0x72
  ) {
    return 3;
  }
  if (
    length === 9 &&
    data[start] === 0x63 &&
    data[start + 1] === 0x6f &&
    data[start + 2] === 0x6d &&
    data[start + 3] === 0x6d &&
    data[start + 4] === 0x69 &&
    data[start + 5] === 0x74 &&
    data[start + 6] === 0x74 &&
    data[start + 7] === 0x65 &&
    data[start + 8] === 0x72
  ) {
    return 4;
  }
  if (
    length === 6 &&
    data[start] === 0x67 &&
    data[start + 1] === 0x70 &&
    data[start + 2] === 0x67 &&
    data[start + 3] === 0x73 &&
    data[start + 4] === 0x69 &&
    data[start + 5] === 0x67
  ) {
    return 5;
  }
  return 0;
}

function jsonEscapedChars(data: Uint8Array, start: number, end: number): number {
  let chars = 0;
  for (let index = start; index < end; index++) {
    const byte = data[index]!;
    if (byte === 0x22 || byte === 0x5c) {
      chars += 2;
    } else if (byte < 0x20) {
      chars +=
        byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d ? 2 : 6;
    } else {
      chars++;
    }
  }
  return chars;
}

function jsonEncodedBytes(data: Uint8Array, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const byte = data[index]!;
    if (byte === 0x22 || byte === 0x5c) {
      bytes += 2;
    } else if (byte < 0x20) {
      bytes +=
        byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d ? 2 : 6;
    } else {
      bytes += byte < 0x80 ? 1 : 3;
    }
  }
  return bytes;
}

/** Preflight the parser's decoded text, header tables and retained commit without decoding. */
function commitMemoryEstimate(
  data: Uint8Array,
  oid: string,
): { prepareBytes: number; serializationBytes: number } {
  if (data.length > MAX_INDEXED_COMMIT_BYTES) {
    throw new GitError(
      "E2BIG",
      `packed commit ${oid} exceeds the ${MAX_INDEXED_COMMIT_BYTES}-byte index limit`,
    );
  }

  let headEnd = data.length;
  for (let index = 0; index + 1 < data.length; index++) {
    if (data[index] === 0x0a && data[index + 1] === 0x0a) {
      headEnd = index;
      break;
    }
  }

  let physicalLines = 0;
  let logicalHeaders = 0;
  let continuations = 0;
  let parentCount = 0;
  let outputBytes = headEnd === data.length ? 0 : data.length - headEnd - 2;
  let serializedChars =
    headEnd === data.length ? 0 : jsonEscapedChars(data, headEnd + 2, data.length);
  let serializedBytes =
    headEnd === data.length ? 0 : jsonEncodedBytes(data, headEnd + 2, data.length);
  let currentKind = 0;
  let hasHeader = false;
  let lineStart = 0;
  for (;;) {
    let lineEnd = lineStart;
    while (lineEnd < headEnd && data[lineEnd] !== 0x0a) lineEnd++;
    physicalLines++;

    if (data[lineStart] === 0x20 && hasHeader) {
      continuations++;
      if (currentKind !== 0) outputBytes += lineEnd - lineStart;
      if (currentKind >= 3) {
        serializedChars += 2 + jsonEscapedChars(data, lineStart + 1, lineEnd);
        serializedBytes += 2 + jsonEncodedBytes(data, lineStart + 1, lineEnd);
      }
    } else {
      let space = lineStart;
      while (space < lineEnd && data[space] !== 0x20) space++;
      if (space > lineStart && space < lineEnd) {
        logicalHeaders++;
        hasHeader = true;
        currentKind = commitHeaderKind(data, lineStart, space);
        if (currentKind !== 0) outputBytes += lineEnd - space - 1;
        if (currentKind === 2) parentCount++;
        if (currentKind >= 3) {
          serializedChars += jsonEscapedChars(data, space + 1, lineEnd);
          serializedBytes += jsonEncodedBytes(data, space + 1, lineEnd);
        }
      }
    }

    if (lineEnd === headEnd) break;
    lineStart = lineEnd + 1;
  }

  const parsePeakBytes =
    PACK_COMMIT_PARSE_BYTES +
    2 * data.length +
    physicalLines * PACK_COMMIT_PHYSICAL_LINE_BYTES +
    logicalHeaders * PACK_COMMIT_LOGICAL_HEADER_BYTES +
    continuations * PACK_COMMIT_CONTINUATION_BYTES +
    2 * outputBytes +
    parentCount * PACK_COMMIT_LOGICAL_HEADER_BYTES;
  const cacheBytes =
    PACK_COMMIT_PARSE_BYTES + 2 * outputBytes + parentCount * PACK_COMMIT_LOGICAL_HEADER_BYTES;
  const parentJsonChars = parentCount === 0 ? 2 : 43 * parentCount + 1;
  const escapedParentJsonChars = parentJsonChars + 2 * parentCount + 2;
  const outerJsonChars = PACK_COMMIT_PARSE_BYTES + escapedParentJsonChars + serializedChars;
  const outerJsonBytes = PACK_COMMIT_PARSE_BYTES + escapedParentJsonChars + serializedBytes;
  const serializationPeakBytes = Math.max(
    cacheBytes + 2 * parentJsonChars + 2 * outerJsonChars,
    cacheBytes + 2 * outerJsonChars + outerJsonBytes,
  );
  const prepareBytes = Math.max(parsePeakBytes, serializationPeakBytes);
  if (!Number.isSafeInteger(prepareBytes)) {
    throw new GitError("E2BIG", `packed commit ${oid} parser state is too large`);
  }
  return { prepareBytes, serializationBytes: serializationPeakBytes };
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
      this.#direct(() =>
        indexTreeSource(this.db, this.#source(repoId, treeOid, sourceId, objectSize, [data]), [
          data,
        ]),
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
    this.#direct(() => {
      const source = this.#source(repoId, treeOid, sourceId, objectSize, []);
      indexTreeSource(this.db, source, chunks());
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
      this.#direct(() => {
        const source = this.#source(repoId, treeOid, sourceId, objectSize, []);
        const sink = createTreeIndexSink(this.db, source);
        for (const chunk of target.chunks()) sink.push(chunk);
        sink.finish();
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
      this.db.transactionSync(() => indexTreeSources(this.db, this.#sources));
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

  #direct(write: () => void): void {
    this.reservation.set("tree", PACK_TREE_BATCH_BYTES);
    try {
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
  #serializationTransientBytes = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly packId: number,
    private readonly objects: PackObjectBatch,
    private readonly reservation: MemoryReservation,
  ) {}

  get retainedBytes(): number {
    return this.#bytes;
  }

  add(source: CommitCacheSource): void {
    const estimate = commitMemoryEstimate(source.data, source.oid);
    if (
      this.#entries.length > 0 &&
      (this.#entries.length >= PACK_COMMIT_BATCH_SOURCES ||
        this.#bytes + estimate.prepareBytes > MAX_COMMIT_CACHE_BYTES ||
        this.#bytes + estimate.serializationBytes + PACK_COMMIT_PAGE_TRANSIENT_BYTES >
          PACK_COMMIT_ACTIVE_HEADROOM_BYTES)
    ) {
      this.#stage();
    }
    this.reservation.set("commit", this.#bytes + estimate.prepareBytes);
    let entry: CommitCacheEntry;
    try {
      entry = prepareCommitCache(source);
    } catch (error) {
      this.reservation.set("commit", this.#bytes);
      throw error;
    }
    if (entry.cacheBytes > MAX_COMMIT_CACHE_BYTES) {
      this.reservation.set("commit", this.#bytes);
      throw new GitError("E2BIG", `packed commit ${source.oid} exceeds the cache batch limit`);
    }
    if (
      this.#entries.length > 0 &&
      (this.#entries.length >= PACK_COMMIT_BATCH_SOURCES ||
        this.#bytes + entry.cacheBytes > MAX_COMMIT_CACHE_BYTES)
    ) {
      this.#stage();
    }
    this.reservation.set("commit", this.#bytes + entry.cacheBytes);
    this.#entries.push(entry);
    this.#bytes += entry.cacheBytes;
    this.#serializationTransientBytes = Math.max(
      this.#serializationTransientBytes,
      estimate.serializationBytes - entry.cacheBytes,
    );
  }

  /** Flush the final batch after the caller marks the pack complete. */
  finish(): void {
    this.objects.flush();
    this.#insert();
    this.#clear();
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
    this.reservation.set(
      "commit",
      this.#bytes + this.#serializationTransientBytes + PACK_COMMIT_PAGE_TRANSIENT_BYTES,
    );
    try {
      const result = insertCommitCaches(this.db, this.#entries);
      if (result.eligible !== this.#entries.length || result.written !== this.#entries.length) {
        throw new CorruptError(
          `packed commit cache wrote ${result.written} of ${this.#entries.length} required rows`,
        );
      }
    } finally {
      this.reservation.set("commit", this.#bytes);
    }
  }

  #clear(): void {
    this.#entries.length = 0;
    this.#bytes = 0;
    this.#serializationTransientBytes = 0;
    this.reservation.clear("commit");
  }
}
