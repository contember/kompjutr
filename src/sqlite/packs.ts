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
import type { MemoryCoordinator, MemoryReservation } from "../memory.js";
import { MAX_COMMIT_CACHE_BYTES, MAX_INDEXED_COMMIT_BYTES } from "./commits.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
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
export const MAX_PACK_DELETE_BATCH = 48;
export const PACK_INGEST_LEASE_MS = 5 * 60 * 1_000;
const MAX_PACK_FALLBACK_AUDIT_BYTES = 48 * 1024 * 1024;
const MAX_PACK_FALLBACK_AUDIT_PACKS = 128;
const MAX_PACK_INGEST_OBJECTS = 128 * 1024;
const PACK_MEMBERSHIP_DIGEST_BYTES = 20;
const PACK_FALLBACK_AUDIT_METADATA_BYTES = 2 * 1024 * 1024;

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
  /** Test seam for durable ingest lease expiry. */
  now?: () => number;
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
const MAX_PACK_AUTH_COMPRESSED_BYTES = MAX_PACK_DELTA_WORKING_BYTES + PACK_INFLATE_HEADROOM_BYTES;
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

interface PackIngestControl {
  ownerGeneration: number;
  lastPackId: number;
  activePackId: number | null;
  expiresMs: number | null;
}

interface PackIngestLease {
  generation: number;
  packId: number;
  expiresMs: number;
}

interface FallbackPackAudit {
  packId: number;
  size: number;
  count: number;
}

interface FallbackAuditBudget {
  readonly packIds: Set<number>;
  bytes: number;
  entries: number;
}

function fallbackAuditBudget(): FallbackAuditBudget {
  return {
    packIds: new Set(),
    bytes: 0,
    entries: 0,
  };
}

const PACK_MEMBERSHIP_ENCODER = new TextEncoder();

function packMembershipDigest(row: PackObjectInput): Uint8Array {
  return new Sha1().update(PACK_MEMBERSHIP_ENCODER.encode(JSON.stringify(row))).digest();
}

function expectedPackMembershipBytes(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PACK_INGEST_OBJECTS) {
    throw new GitError("E2BIG", `pack exceeds ${MAX_PACK_INGEST_OBJECTS} objects`);
  }
  return count * (Float64Array.BYTES_PER_ELEMENT + 2 * PACK_MEMBERSHIP_DIGEST_BYTES + 1);
}

interface PackByteMembership {
  offset: number;
  dataOff: number;
  dataLen: number;
  entrySize: number;
  kind: "ofs" | "ref" | null;
  baseDelta: number | null;
  baseOid: string | null;
  type: ObjectType | null;
  size: number;
  oid: string | null;
  compressedDigest: string;
}

function packByteMembershipDigest(row: PackByteMembership): Uint8Array {
  return new Sha1().update(PACK_MEMBERSHIP_ENCODER.encode(JSON.stringify(row))).digest();
}

class ExpectedPackMembership {
  readonly #offsets: Float64Array;
  readonly #digests: Uint8Array;
  readonly #byteDigests: Uint8Array;
  readonly #completed: Uint8Array;
  #offsetCount = 0;

  constructor(readonly count: number) {
    expectedPackMembershipBytes(count);
    this.#offsets = new Float64Array(count);
    this.#digests = new Uint8Array(count * PACK_MEMBERSHIP_DIGEST_BYTES);
    this.#byteDigests = new Uint8Array(count * PACK_MEMBERSHIP_DIGEST_BYTES);
    this.#completed = new Uint8Array(count);
  }

  addOffset(ordinal: number, offset: number): void {
    if (
      ordinal !== this.#offsetCount ||
      ordinal < 0 ||
      ordinal >= this.count ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (ordinal > 0 && offset <= this.#offsets[ordinal - 1]!)
    ) {
      throw new CorruptError("pack physical offsets are not strictly ordered");
    }
    this.#offsets[ordinal] = offset;
    this.#offsetCount++;
  }

  record(row: PackObjectInput): void {
    const offset = row[2];
    let low = 0;
    let high = this.#offsetCount - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.#offsets[middle]!;
      if (candidate < offset) low = middle + 1;
      else if (candidate > offset) high = middle - 1;
      else {
        if (this.#completed[middle] !== 0) {
          throw new CorruptError(`pack entry at ${offset} was indexed more than once`);
        }
        this.#digests.set(packMembershipDigest(row), middle * PACK_MEMBERSHIP_DIGEST_BYTES);
        this.#completed[middle] = 1;
        return;
      }
    }
    throw new CorruptError(`pack entry at ${offset} has no physical ordinal`);
  }

  recordBytes(ordinal: number, row: PackByteMembership): void {
    if (ordinal < 0 || ordinal >= this.count || row.offset !== this.#offsets[ordinal]) {
      throw new CorruptError("pack byte membership order disagrees");
    }
    this.#byteDigests.set(packByteMembershipDigest(row), ordinal * PACK_MEMBERSHIP_DIGEST_BYTES);
  }

  verifyBytes(ordinal: number, row: PackByteMembership): void {
    if (ordinal < 0 || ordinal >= this.count || row.offset !== this.#offsets[ordinal]) {
      throw new CorruptError("pack publication bytes disagree with indexed entries");
    }
    const actual = packByteMembershipDigest(row);
    const start = ordinal * PACK_MEMBERSHIP_DIGEST_BYTES;
    for (let index = 0; index < PACK_MEMBERSHIP_DIGEST_BYTES; index++) {
      if (actual[index] !== this.#byteDigests[start + index]) {
        throw new CorruptError("pack publication bytes disagree with indexed entries");
      }
    }
  }

  verify(ordinal: number, row: PackObjectInput): void {
    if (
      ordinal < 0 ||
      ordinal >= this.count ||
      this.#completed[ordinal] !== 1 ||
      row[2] !== this.#offsets[ordinal]
    ) {
      throw new CorruptError("pack publication membership order disagrees");
    }
    const actual = packMembershipDigest(row);
    const start = ordinal * PACK_MEMBERSHIP_DIGEST_BYTES;
    for (let index = 0; index < PACK_MEMBERSHIP_DIGEST_BYTES; index++) {
      if (actual[index] !== this.#digests[start + index]) {
        throw new CorruptError("pack publication membership disagrees with indexed entries");
      }
    }
  }

  assertComplete(): void {
    if (this.#offsetCount !== this.count) {
      throw new CorruptError("pack physical membership is incomplete");
    }
    for (const completed of this.#completed) {
      if (completed !== 1) throw new CorruptError("pack indexed membership is incomplete");
    }
  }
}

export interface PackIngestOptions {
  /** Refuse a pack larger than this. */
  maxBytes?: number;
  /** Caller-owned operation budget; ingest uses and disposes one additive child scope. */
  reservation?: MemoryReservation;
  onProgress?: (message: string) => void;
  /** Awaited periodically so the runtime can flush its write buffer. */
  yieldNow?: () => Promise<void>;
  now?: () => number;
  /** Synchronous hooks run inside the reservation and publication transactions. */
  lifecycle?: PackIngestLifecycle;
  /** Ordinary ingest reclaims abandoned packs; owned maintenance retries skip that broad scan. */
  reclaimPending?: boolean;
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

interface AuthenticatedPackSource {
  oid: string;
  type: ObjectType;
  size: number;
  packId: number;
  dataOff: number;
  dataLen: number;
  entrySize: number;
  baseOid: string | null;
}

function requirePackId(packId: number): void {
  if (!Number.isSafeInteger(packId) || packId < 0) {
    throw new RangeError("pack id must be a non-negative safe integer");
  }
}

function requireIngestTime(now: () => number): number {
  const value = now();
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER - PACK_INGEST_LEASE_MS
  ) {
    throw new RangeError("pack ingest time must be a bounded non-negative integer");
  }
  return value;
}

function requireIngestControl(row: Record<string, unknown>, repoId: number): PackIngestControl {
  const ownerGeneration = row.owner_generation;
  const lastPackId = row.last_pack_id;
  const activePackId = row.active_pack_id;
  const expiresMs = row.expires_ms;
  if (
    row.repo_id !== repoId ||
    typeof ownerGeneration !== "number" ||
    !Number.isSafeInteger(ownerGeneration) ||
    ownerGeneration < 0 ||
    typeof lastPackId !== "number" ||
    !Number.isSafeInteger(lastPackId) ||
    lastPackId < 0 ||
    (activePackId !== null &&
      (typeof activePackId !== "number" ||
        !Number.isSafeInteger(activePackId) ||
        activePackId < 0 ||
        activePackId > lastPackId)) ||
    (expiresMs !== null &&
      (typeof expiresMs !== "number" || !Number.isSafeInteger(expiresMs) || expiresMs < 0)) ||
    (activePackId === null) !== (expiresMs === null) ||
    (activePackId !== null && ownerGeneration < 1)
  ) {
    throw new CorruptError("pack ingest control is invalid");
  }
  return { ownerGeneration, lastPackId, activePackId, expiresMs };
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

class DeltaHeaderProbe {
  #value = 0;
  #shift = 0;
  #field = 0;
  #sourceSize: number | null = null;
  #targetSize: number | null = null;

  update(bytes: Uint8Array): void {
    if (this.#targetSize !== null) return;
    for (const byte of bytes) {
      this.#value += (byte & 0x7f) * 2 ** this.#shift;
      this.#shift += 7;
      if (this.#shift > 56 || !Number.isSafeInteger(this.#value)) {
        throw new CorruptError("delta size is invalid");
      }
      if ((byte & 0x80) !== 0) continue;
      if (this.#field === 0) this.#sourceSize = this.#value;
      else this.#targetSize = this.#value;
      this.#field++;
      this.#value = 0;
      this.#shift = 0;
      if (this.#targetSize !== null) return;
    }
  }

  finish(): { sourceSize: number; targetSize: number } {
    if (this.#sourceSize === null || this.#targetSize === null) {
      throw new CorruptError("delta header is truncated");
    }
    return { sourceSize: this.#sourceSize, targetSize: this.#targetSize };
  }
}

class SequentialPackBytes {
  readonly #rows: Iterator<Record<string, unknown>>;
  readonly #expectedRows: number;
  readonly #sha = new Sha1();
  #tail: Uint8Array = new Uint8Array(0);
  #chunk: Uint8Array = new Uint8Array(0);
  #chunkSeq = -1;
  #loadedRows = 0;
  #loadedBytes = 0;
  #finished = false;

  constructor(
    db: SqlDatabase,
    repoId: number,
    readonly packId: number,
    readonly limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 32) {
      throw new CorruptError(`pack ${packId}: stored byte length is invalid`);
    }
    this.#expectedRows = Math.ceil(limit / PACK_CHUNK);
    this.#rows = db
      .iterate(
        `SELECT pack_id, seq, data FROM git_pack_data
          WHERE repo_id = ? AND pack_id = ? ORDER BY seq LIMIT ?`,
        repoId,
        packId,
        this.#expectedRows + 1,
      )
      [Symbol.iterator]();
  }

  read(offset: number, length: number): Uint8Array {
    if (
      this.#finished ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      offset > this.limit - length
    ) {
      throw new CorruptError(`pack ${this.packId}: uncached read exceeds stored bytes`);
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    if (first === last) {
      const chunk = this.#load(first);
      const start = offset - first * PACK_CHUNK;
      return chunk.subarray(start, start + length);
    }
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const chunk = this.#load(seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
    }
    return out;
  }

  finish(): void {
    if (this.#finished) throw new CorruptError(`pack ${this.packId}: byte audit was reused`);
    this.#finished = true;
    const extra = this.#rows.next();
    if (
      !extra.done ||
      this.#loadedRows !== this.#expectedRows ||
      this.#loadedBytes !== this.limit ||
      this.#tail.length !== 20 ||
      toHex(this.#tail) !== toHex(this.#sha.digest())
    ) {
      throw new CorruptError(`pack ${this.packId}: stored checksum or chunk layout is invalid`);
    }
  }

  #load(seq: number): Uint8Array {
    if (seq === this.#chunkSeq) return this.#chunk;
    if (seq !== this.#chunkSeq + 1) {
      throw new CorruptError(`pack ${this.packId}: uncached traversal is not sequential`);
    }
    const next = this.#rows.next();
    if (next.done) throw new CorruptError(`pack ${this.packId}: missing chunk ${seq}`);
    const row = next.value;
    const data = readBlob(row.data);
    const expected = Math.min(PACK_CHUNK, this.limit - seq * PACK_CHUNK);
    if (row.pack_id !== this.packId || row.seq !== seq || data.length !== expected) {
      throw new CorruptError(`pack ${this.packId}: stored chunk layout is invalid`);
    }
    this.#updateChecksum(data);
    this.#chunk = data;
    this.#chunkSeq = seq;
    this.#loadedRows++;
    this.#loadedBytes += data.length;
    return data;
  }

  #updateChecksum(data: Uint8Array): void {
    if (data.length >= 20) {
      if (this.#tail.length > 0) this.#sha.update(this.#tail);
      this.#sha.update(data.subarray(0, data.length - 20));
      this.#tail = data.slice(data.length - 20);
      return;
    }
    const joined = concat([this.#tail, data]);
    if (joined.length > 20) this.#sha.update(joined.subarray(0, joined.length - 20));
    this.#tail = joined.slice(Math.max(0, joined.length - 20));
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
  readonly #scopeMemory: (reservation: MemoryReservation) => MemoryReservation;
  readonly #cacheNamespace: string;
  readonly #now: () => number;
  #sharedState = {
    cacheGeneration: 0,
    activePending: new Set<number>(),
    lastIngestMemoryHighWater: 0,
  };
  readonly #maxBufferedEntry: number;
  readonly #cacheEntryLimit: number;
  readonly #maxDeltaDepth: number;
  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    chunks: ByteLru<string, Uint8Array>,
    memory: MemoryCoordinator,
    scopeMemory: (reservation: MemoryReservation) => MemoryReservation,
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
    this.#scopeMemory = scopeMemory;
    this.#cacheNamespace = cacheNamespace;
    this.#now = options.now ?? Date.now;
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
    return this.#sharedState.lastIngestMemoryHighWater;
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

  /** Cold-read and hash one canonical object from a complete pack. */
  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    const object = this.#readObjects([oid], null, expectedType, true, new Map(), true).get(oid);
    if (object === undefined) return null;
    if (hashObject(object.type, object.data) !== oid) {
      throw new CorruptError(`packed ${expectedType} ${oid} does not match its bytes`);
    }
    return object;
  }

  /** Cold-read and hash exact canonical complete-pack sources. */
  authenticateCompleteSources(
    objects: readonly { oid: string; type: ObjectType; size: number; packId: number }[],
  ): void {
    if (objects.length < 1 || objects.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
      throw new GitError(
        "E2BIG",
        `packed source authentication exceeds ${MAX_PACK_MEMBERSHIP_OBJECTS} objects`,
      );
    }
    const requested = new Set<string>();
    let requestedBytes = 0;
    for (const object of objects) {
      if (
        !isOid(object.oid) ||
        !isObjectType(object.type) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        object.size > MAX_PACK_DELTA_WORKING_BYTES ||
        !Number.isSafeInteger(object.packId) ||
        object.packId < 0
      ) {
        throw new CorruptError("canonical packed source request is invalid");
      }
      if (requested.has(object.oid)) {
        throw new CorruptError("canonical packed source request contains a duplicate object id");
      }
      requested.add(object.oid);
      requestedBytes += object.size;
      if (!Number.isSafeInteger(requestedBytes) || requestedBytes > MAX_PACK_DELTA_WORKING_BYTES) {
        throw new GitError("E2BIG", "packed source authentication exceeds its output byte limit");
      }
    }
    const encoded = JSON.stringify(objects);
    let sources = 0;
    const authenticated: AuthenticatedPackSource[] = [];
    for (const row of this.#db.iterate(
      `SELECT CAST(input.key AS INTEGER) AS ordinal,
              json_extract(input.value, '$.oid') AS expected_oid,
              json_extract(input.value, '$.type') AS expected_type,
              json_extract(input.value, '$.size') AS expected_size,
              json_extract(input.value, '$.packId') AS expected_pack_id,
              canonical.oid, canonical.type, canonical.size, canonical.pack_id,
              canonical.data_off, canonical.data_len, canonical.entry_size,
              canonical.base_oid, pack.state, pack.size AS pack_size,
              EXISTS (
                SELECT 1 FROM git_pack_entries physical
                 WHERE physical.repo_id = canonical.repo_id
                   AND physical.oid = canonical.oid
                   AND physical.pack_id = canonical.pack_id
                   AND physical.offset IS canonical.offset
                   AND physical.data_off IS canonical.data_off
                   AND physical.data_len IS canonical.data_len
                   AND physical.type IS canonical.type
                   AND physical.size IS canonical.size
                   AND physical.entry_size IS canonical.entry_size
                   AND physical.base_oid IS canonical.base_oid
              ) AS exact_source
         FROM json_each(?) input
         LEFT JOIN git_pack_objects canonical
           ON canonical.repo_id = ? AND canonical.oid = json_extract(input.value, '$.oid')
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = canonical.repo_id AND pack.pack_id = canonical.pack_id
        ORDER BY CAST(input.key AS INTEGER)`,
      encoded,
      this.#repoId,
    )) {
      const expected = objects[sources];
      if (
        expected === undefined ||
        row.ordinal !== sources ||
        row.expected_oid !== expected.oid ||
        row.expected_type !== expected.type ||
        row.expected_size !== expected.size ||
        row.expected_pack_id !== expected.packId ||
        row.oid !== expected.oid ||
        row.type !== expected.type ||
        row.size !== expected.size ||
        row.pack_id !== expected.packId ||
        row.state !== "complete" ||
        row.exact_source !== 1 ||
        typeof row.data_off !== "number" ||
        !Number.isSafeInteger(row.data_off) ||
        row.data_off < 0 ||
        typeof row.data_len !== "number" ||
        !Number.isSafeInteger(row.data_len) ||
        row.data_len < 1 ||
        typeof row.entry_size !== "number" ||
        !Number.isSafeInteger(row.entry_size) ||
        row.entry_size < 0 ||
        row.entry_size > MAX_PACK_DELTA_WORKING_BYTES ||
        (row.base_oid !== null && (typeof row.base_oid !== "string" || !isOid(row.base_oid))) ||
        typeof row.pack_size !== "number" ||
        !Number.isSafeInteger(row.pack_size) ||
        row.pack_size < 32 ||
        !Number.isSafeInteger(row.data_off + row.data_len) ||
        row.data_off + row.data_len > row.pack_size - 20 ||
        (row.base_oid === null && row.entry_size !== expected.size)
      ) {
        throw new CorruptError("canonical packed source changed before authentication");
      }
      authenticated.push({
        oid: expected.oid,
        type: expected.type,
        size: expected.size,
        packId: expected.packId,
        dataOff: row.data_off,
        dataLen: row.data_len,
        entrySize: row.entry_size,
        baseOid: row.base_oid,
      });
      sources++;
    }
    if (sources !== objects.length) {
      throw new CorruptError("canonical packed source authentication is incomplete");
    }

    let compressedBytes = 0;
    for (const source of authenticated) {
      compressedBytes += source.dataLen;
      if (
        !Number.isSafeInteger(compressedBytes) ||
        compressedBytes > MAX_PACK_AUTH_COMPRESSED_BYTES
      ) {
        throw new GitError(
          "E2BIG",
          "packed source authentication exceeds its compressed byte limit",
        );
      }
    }

    let page: AuthenticatedPackSource[] = [];
    let pageBytes = 0;
    const authenticatePage = (): void => {
      if (page.length === 0) return;
      const only = page.length === 1 ? page[0] : undefined;
      if (only !== undefined && only.dataLen > MAX_PACK_BLOB_BATCH_BYTES && only.baseOid === null) {
        this.#authenticateFullPackSourceStreaming(
          only,
          "canonical packed source bytes disagree with their object id",
        );
        page = [];
        pageBytes = 0;
        return;
      }
      const read = this.#readObjects(
        page.map((object) => object.oid),
        only?.packId ?? null,
        null,
        false,
        new Map(),
        true,
      );
      if (read.size !== page.length) {
        throw new CorruptError("canonical packed source authentication is incomplete");
      }
      for (const expected of page) {
        const object = read.get(expected.oid);
        if (
          object === undefined ||
          object.type !== expected.type ||
          object.data.length !== expected.size ||
          hashObject(object.type, object.data) !== expected.oid
        ) {
          throw new CorruptError("canonical packed source bytes disagree with their object id");
        }
      }
      page = [];
      pageBytes = 0;
    };
    for (const object of authenticated) {
      if (
        page.length > 0 &&
        (object.size > MAX_PACK_BLOB_BATCH_BYTES - pageBytes ||
          object.dataLen > MAX_PACK_BLOB_BATCH_BYTES)
      ) {
        authenticatePage();
      }
      page.push(object);
      pageBytes += object.size;
      if (object.size > MAX_PACK_BLOB_BATCH_BYTES || object.dataLen > MAX_PACK_BLOB_BATCH_BYTES) {
        authenticatePage();
      }
    }
    authenticatePage();
  }

  #authenticateFullPackSourceStreaming(source: AuthenticatedPackSource, message: string): void {
    if (source.baseOid !== null || source.entrySize !== source.size || source.dataLen < 1) {
      throw new CorruptError(message);
    }
    if (source.dataLen > MAX_PACK_AUTH_COMPRESSED_BYTES) {
      throw new GitError("E2BIG", "packed source compressed bytes exceed the streaming limit");
    }
    const sha = new Sha1().update(objectHeader(source.type, source.size));
    let produced = 0;
    const stream = new InflateStream((chunk) => {
      produced += chunk.length;
      if (produced > source.size) throw new CorruptError(message);
      sha.update(chunk);
    });
    let consumed = 0;
    try {
      while (!stream.ended && consumed < source.dataLen) {
        const length = Math.min(PACK_READ_BYTES, source.dataLen - consumed);
        const input = this.#readRawUncached(source.packId, source.dataOff + consumed, length);
        const used = stream.push(input);
        consumed += used;
        if (!stream.ended && used !== input.length) throw new CorruptError(message);
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(message, { cause: error });
    }
    if (
      !stream.ended ||
      consumed !== source.dataLen ||
      produced !== source.size ||
      toHex(sha.digest()) !== source.oid
    ) {
      throw new CorruptError(message);
    }
  }

  /** Resolve ingest bases in bounded graph and physical pack order. */
  #readObjects(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject> = new Map(),
    bypassCache = false,
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
      wanted.length === 1 && (pendingPackId !== null || bypassCache)
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
      if (
        !bypassCache &&
        this.#objects.get(this.#objectCacheKey(current.packId, oid)) !== undefined
      ) {
        continue;
      }
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
        if (
          !bypassCache &&
          this.#objects.get(this.#objectCacheKey(next.packId, next.oid)) !== undefined
        ) {
          break;
        }
        current = next;
      }
    }

    let oversizedEntries = 0;
    for (const entry of needed.values()) {
      if (entry.dataLen <= MAX_PACK_BLOB_BATCH_BYTES) continue;
      if (entry.dataLen > MAX_PACK_AUTH_COMPRESSED_BYTES) {
        throw new GitError("E2BIG", "packed entry compressed bytes exceed the streaming limit");
      }
      oversizedEntries++;
    }
    if (oversizedEntries > 0 && (wanted.length !== 1 || oversizedEntries !== 1)) {
      throw new GitError("E2BIG", "packed blob compressed graph exceeds the 4 MiB batch limit");
    }
    let compressedBytes = 0;
    const streamedCompressed = new Set<string>();
    const compressed = new Map<string, CompressedEntry>();
    const consumers = new Map<string, { entry: PackedEntry; output: CompressedEntry }[]>();
    for (const entry of needed.values()) {
      if (entry.dataLen > MAX_PACK_BLOB_BATCH_BYTES) {
        streamedCompressed.add(entry.oid);
        continue;
      }
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
      const hit = bypassCache ? undefined : this.#chunks.get(this.#chunkCacheKey(packId, seq));
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
        if (!bypassCache) this.#chunks.set(this.#chunkCacheKey(packId, seq), data);
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
      const cached = bypassCache
        ? undefined
        : this.#objects.get(this.#objectCacheKey(first.packId, oid));
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
            data: this.#inflateCompressed(
              current,
              compressed.get(current.oid)?.bytes,
              streamedCompressed.has(current.oid),
              bypassCache,
            ),
          };
          if (!bypassCache) this.#cacheObject(current.packId, current.oid, object);
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
        const cachedBase = bypassCache
          ? undefined
          : this.#objects.get(this.#objectCacheKey(next.packId, next.oid));
        if (cachedBase !== undefined) {
          object = cachedBase;
          break;
        }
        current = next;
      }
      for (let index = chain.length - 1; index >= 0; index--) {
        const entry = chain[index]!;
        checkDeltaInflateBudget(object.data, entry.entrySize);
        const delta = this.#inflateCompressed(
          entry,
          compressed.get(entry.oid)?.bytes,
          streamedCompressed.has(entry.oid),
          bypassCache,
        );
        checkDeltaWorkingSet(object.data, delta);
        object = { type: object.type, data: applyDelta(object.data, delta) };
        if (object.data.length !== entry.size || object.type !== entry.type) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent type or size`);
        }
        if (!bypassCache) this.#cacheObject(entry.packId, entry.oid, object);
      }
      if (object.type !== first.type || object.data.length !== first.size) {
        throw new CorruptError(`packed object ${oid} has inconsistent type or size`);
      }
      result.set(oid, object);
    }
    return result;
  }

  #inflateCompressed(
    entry: PackedEntry,
    compressed: Uint8Array | undefined,
    streamed: boolean,
    bypassCache: boolean,
  ): Uint8Array {
    if (compressed === undefined) {
      if (!streamed) throw new CorruptError(`packed blob entry ${entry.oid} was not loaded`);
      return this.#inflateStoredEntry(
        entry.packId,
        entry.dataOff,
        entry.dataLen,
        entry.entrySize,
        `pack entry at ${entry.offset}`,
        bypassCache,
      );
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
    return `${this.#cacheNamespace}:${this.#sharedState.cacheGeneration}:pack:${packId}:${oid}`;
  }

  #chunkCacheKey(packId: number, seq: number): string {
    return `${this.#cacheNamespace}:${this.#sharedState.cacheGeneration}:row:${packId}:${seq}`;
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
    bypassCache = false,
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
    if (dataLen > MAX_PACK_AUTH_COMPRESSED_BYTES) {
      throw new GitError("E2BIG", `${label} compressed bytes exceed the streaming limit`);
    }
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
      const input = bypassCache
        ? this.#readRawUncached(packId, dataOff + consumed, length)
        : this.readRaw(packId, dataOff + consumed, length);
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

  #readRawUncached(packId: number, offset: number, length: number): Uint8Array {
    requirePackId(packId);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new CorruptError("uncached pack read exceeds the bounded region limit");
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const row = this.#db.one<Record<string, unknown>>(
        "SELECT pack_id, seq, data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
        this.#repoId,
        packId,
        seq,
      );
      if (row === undefined || row.pack_id !== packId || row.seq !== seq) {
        throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
      }
      const chunk = readBlob(row.data);
      if (chunk.length < 1 || chunk.length > PACK_CHUNK) {
        throw new CorruptError(`pack ${packId}: chunk ${seq} has an invalid size`);
      }
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + PACK_CHUNK);
      if (to - chunkStart > chunk.length) {
        throw new CorruptError(`pack ${packId}: chunk ${seq} is truncated`);
      }
      out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
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
    this.#sharedState.cacheGeneration++;
  }

  #withMemoryReservation<T>(closure: (reservation: MemoryReservation) => T): T {
    const reservation = this.#memory.reserve();
    try {
      return closure(reservation);
    } finally {
      reservation.dispose();
    }
  }

  #ensureIngestControl(): PackIngestControl {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms
         FROM git_pack_ingest_control WHERE repo_id = ?`,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("pack ingest control is missing");
    return requireIngestControl(row, this.#repoId);
  }

  #nextPackId(control: PackIngestControl): number {
    const latest = this.#db.scalar<number | null>(
      "SELECT MAX(pack_id) FROM git_pack_meta WHERE repo_id = ?",
      this.#repoId,
    );
    if (latest !== undefined && latest !== null && (!Number.isSafeInteger(latest) || latest < 0)) {
      throw new CorruptError("pack id allocation state is invalid");
    }
    const last = Math.max(control.lastPackId, latest ?? 0);
    if (last === Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "pack id allocation is exhausted");
    }
    return last + 1;
  }

  #reclaimPendingRows(
    control: PackIngestControl,
    nowMs: number,
    memory: MemoryReservation,
  ): {
    control: PackIngestControl;
    removed: number;
  } {
    const ids = new Set<number>();
    let current = control;
    let livePackId: number | null = null;
    if (control.activePackId !== null) {
      if (control.expiresMs === null) throw new CorruptError("pack ingest lease expiry is missing");
      const owner = this.#db.one<Record<string, unknown>>(
        `SELECT pack.state AS state,
                EXISTS(
                  SELECT 1 FROM git_maintenance_repack_batches batch
                   WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
                ) AS maintenance_owned
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.pack_id = ?`,
        this.#repoId,
        control.activePackId,
      );
      if (owner === undefined) throw new CorruptError("active pack ingest identity is missing");
      if (owner.state !== "pending" || owner.maintenance_owned !== 0) {
        throw new CorruptError("active ordinary pack ingest ownership is invalid");
      }
      if (nowMs < control.expiresMs) {
        livePackId = control.activePackId;
      } else {
        const cleared = this.#db.one<Record<string, unknown>>(
          `UPDATE git_pack_ingest_control
              SET active_pack_id = NULL, expires_ms = NULL
            WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ?
          RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
          this.#repoId,
          control.ownerGeneration,
          control.activePackId,
        );
        if (cleared === undefined) throw new CorruptError("expired pack ingest lease changed");
        current = requireIngestControl(cleared, this.#repoId);
        ids.add(control.activePackId);
      }
    }
    const collect = (rows: Iterable<Record<string, unknown>>, requirePending: boolean): void => {
      for (const row of rows) {
        const packId = row.pack_id;
        if (typeof packId !== "number" || !Number.isSafeInteger(packId) || packId < 0) {
          throw new CorruptError("pending pack query returned an invalid pack id");
        }
        if (requirePending && row.state !== "pending") {
          throw new CorruptError(`pack ${packId}: invalid pending cleanup state`);
        }
        ids.add(packId);
      }
    };
    collect(
      this.#db.iterate(
        `SELECT pack.pack_id AS pack_id, pack.state AS state
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.state IS NOT 'complete'
            AND (? IS NULL OR pack.pack_id != ?)
            AND pack.pack_id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM git_maintenance_repack_batches batch
               WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
            )
          ORDER BY pack.pack_id LIMIT ?`,
        this.#repoId,
        livePackId,
        livePackId,
        JSON.stringify([...this.#sharedState.activePending]),
        MAX_PACK_DELETE_BATCH + 1,
      ),
      true,
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
      false,
    );
    if (ids.size > MAX_PACK_DELETE_BATCH) {
      throw new GitError("E2BIG", `pending pack cleanup exceeds ${MAX_PACK_DELETE_BATCH} packs`);
    }
    const audit = fallbackAuditBudget();
    for (const packId of ids) this.#deletePack(packId, [packId], audit, memory);
    return { control: current, removed: ids.size };
  }

  /** Drop only unowned or expired ordinary packs. */
  reclaimPending(now: () => number = this.#now): number {
    const nowMs = requireIngestTime(now);
    const removed = this.#withMemoryReservation((memory) =>
      this.#db.transactionSync(() => {
        const control = this.#ensureIngestControl();
        return this.#reclaimPendingRows(control, nowMs, memory).removed;
      }),
    );
    if (removed > 0) this.clearCaches();
    return removed;
  }

  #assertNotDurablyActive(packId: number): void {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms
         FROM git_pack_ingest_control WHERE repo_id = ?`,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("pack ingest control is missing");
    if (requireIngestControl(row, this.#repoId).activePackId === packId) {
      throw new GitError("EBUSY", `pack ${packId} is active`);
    }
  }

  /** Delete exactly one pending pack after its owner releases the durable reference. */
  discardPending(packId: number, releaseOwnership?: (packId: number) => unknown): boolean {
    requirePackId(packId);
    const removed = this.#withMemoryReservation((memory) =>
      this.#db.transactionSync(() => {
        if (this.#sharedState.activePending.has(packId)) {
          throw new GitError("EBUSY", `pack ${packId} is active`);
        }
        this.#assertNotDurablyActive(packId);
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
        if (releaseOwnership !== undefined) {
          requireLifecycleResult(releaseOwnership(packId), "ownership release");
        }
        const current = this.#db.one<{ state: unknown }>(
          "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          this.#repoId,
          packId,
        );
        if (current?.state !== "pending") {
          throw new CorruptError(`pack ${packId}: ownership release changed pending pack state`);
        }
        this.#deletePack(packId, [packId], fallbackAuditBudget(), memory);
        return true;
      }),
    );
    if (removed) this.clearCaches();
    return removed;
  }

  /** Release and delete exactly one complete pack owned by a durable maintenance batch. */
  discardOwnedComplete(packId: number, releaseOwnership: (packId: number) => unknown): boolean {
    requirePackId(packId);
    if (typeof releaseOwnership !== "function") {
      throw new RangeError("complete pack ownership release must be a function");
    }
    const removed = this.#withMemoryReservation((memory) =>
      this.#db.transactionSync(() => {
        if (this.#sharedState.activePending.has(packId)) {
          throw new GitError("EBUSY", `pack ${packId} is active`);
        }
        this.#assertNotDurablyActive(packId);
        const row = this.#db.one<{ state: unknown }>(
          "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          this.#repoId,
          packId,
        );
        if (row === undefined) return false;
        if (row.state !== "pending" && row.state !== "complete") {
          throw new CorruptError(`pack ${packId}: invalid state`);
        }
        if (row.state !== "complete") {
          throw new GitError("EBUSY", `pack ${packId} is still pending`);
        }
        requireLifecycleResult(releaseOwnership(packId), "ownership release");
        const current = this.#db.one<{ state: unknown }>(
          "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          this.#repoId,
          packId,
        );
        if (current?.state !== "complete") {
          throw new CorruptError(`pack ${packId}: ownership release changed complete pack state`);
        }
        this.#deletePack(packId, [packId], fallbackAuditBudget(), memory);
        let rows = 0;
        for (const validation of this.#db.iterate(
          `SELECT /* owned-complete-discard-validation */ EXISTS(
           SELECT 1 FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_data WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_entries WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_tree_sources
             WHERE repo_id = ? AND storage = 'pack' AND source_id = ?
         ) AS remains`,
          this.#repoId,
          packId,
          this.#repoId,
          packId,
          this.#repoId,
          packId,
          this.#repoId,
          packId,
          this.#repoId,
          packId,
          this.#repoId,
          packId,
        )) {
          if (validation.remains !== 0 || rows !== 0) {
            throw new CorruptError(
              `pack ${packId}: complete discard did not remove exactly one pack`,
            );
          }
          rows++;
        }
        if (rows !== 1) {
          throw new CorruptError(`pack ${packId}: complete discard validation returned no row`);
        }
        return true;
      }),
    );
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
    const meta = this.#db.one<{ state: unknown; count: unknown; size: unknown }>(
      "SELECT state, count, size FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
      this.#repoId,
      packId,
    );
    if (meta === undefined) return false;
    if (
      (meta.state !== "pending" && meta.state !== "complete") ||
      typeof meta.count !== "number" ||
      !Number.isSafeInteger(meta.count) ||
      meta.count < 0 ||
      typeof meta.size !== "number" ||
      !Number.isSafeInteger(meta.size) ||
      meta.size < 0
    ) {
      throw new CorruptError(`pack ${packId}: invalid metadata`);
    }
    if (meta.state !== "complete" || meta.count !== expected.size) return false;

    let found = 0;
    let previousOid: string | null = null;
    for (const row of this.#db.iterate(
      `SELECT /* complete-pack-membership */ entry.oid, entry.pack_id, entry.offset,
              entry.data_off, entry.data_len, entry.type, entry.size, entry.entry_size,
              entry.base_oid, object.pack_id AS owner_pack_id, owner.state AS owner_state,
              object.offset AS owner_offset, object.data_off AS owner_data_off,
              object.data_len AS owner_data_len, object.type AS owner_type,
              object.size AS owner_size, object.entry_size AS owner_entry_size,
              object.base_oid AS owner_base_oid
         FROM git_pack_entries entry
         LEFT JOIN git_pack_objects object
           ON object.repo_id = entry.repo_id AND object.oid = entry.oid
         LEFT JOIN git_pack_meta owner
           ON owner.repo_id = object.repo_id AND owner.pack_id = object.pack_id
        WHERE entry.repo_id = ? AND entry.pack_id = ?
        ORDER BY entry.oid COLLATE BINARY LIMIT ?`,
      this.#repoId,
      packId,
      expected.size + 1,
    )) {
      const oid = row.oid;
      const rowPackId = row.pack_id;
      const offset = row.offset;
      const dataOff = row.data_off;
      const dataLen = row.data_len;
      const type = row.type;
      const size = row.size;
      const entrySize = row.entry_size;
      const baseOid = row.base_oid;
      if (
        typeof oid !== "string" ||
        !isOid(oid) ||
        typeof rowPackId !== "number" ||
        !Number.isSafeInteger(rowPackId) ||
        rowPackId !== packId ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        dataOff < offset ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        dataLen < 0 ||
        !Number.isSafeInteger(dataOff + dataLen) ||
        dataOff + dataLen > meta.size ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        entrySize < 0 ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid))) ||
        typeof row.owner_pack_id !== "number" ||
        !Number.isSafeInteger(row.owner_pack_id) ||
        row.owner_pack_id < 0 ||
        row.owner_state !== "complete" ||
        row.owner_type !== type ||
        row.owner_size !== size ||
        (row.owner_pack_id === packId &&
          (row.owner_offset !== offset ||
            row.owner_data_off !== dataOff ||
            row.owner_data_len !== dataLen ||
            row.owner_entry_size !== entrySize ||
            row.owner_base_oid !== baseOid)) ||
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
    this.#withMemoryReservation((memory) =>
      this.#db.transactionSync(() => {
        const deletingPackIds = [...states.keys()];
        const audit = fallbackAuditBudget();
        for (const packId of deletingPackIds) {
          this.#deletePack(packId, deletingPackIds, audit, memory);
        }
      }),
    );
    this.clearCaches();
    return states.size;
  }

  #auditFallbackPacks(
    deletingPackId: number,
    deletingPackIds: readonly number[],
    budget: FallbackAuditBudget,
  ): void {
    const encodedDeletingPackIds = JSON.stringify(deletingPackIds);
    const packs: FallbackPackAudit[] = [];
    for (const row of this.#db.iterate(
      `SELECT DISTINCT candidate.pack_id, candidate_meta.size, candidate_meta.count
         FROM git_pack_entries candidate
         JOIN git_pack_meta candidate_meta
           ON candidate_meta.repo_id = candidate.repo_id
          AND candidate_meta.pack_id = candidate.pack_id
          AND candidate_meta.state = 'complete'
        WHERE candidate.repo_id = ?
          AND candidate.pack_id NOT IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM git_pack_objects current
             WHERE current.repo_id = candidate.repo_id AND current.oid = candidate.oid
               AND current.pack_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries earlier
            JOIN git_pack_meta earlier_meta
              ON earlier_meta.repo_id = earlier.repo_id
             AND earlier_meta.pack_id = earlier.pack_id
             AND earlier_meta.state = 'complete'
             WHERE earlier.repo_id = candidate.repo_id AND earlier.oid = candidate.oid
               AND earlier.pack_id NOT IN (SELECT value FROM json_each(?))
               AND earlier.pack_id < candidate.pack_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries same_pack
             WHERE same_pack.repo_id = candidate.repo_id
               AND same_pack.pack_id = candidate.pack_id
               AND same_pack.oid = candidate.oid
               AND same_pack.offset < candidate.offset
          )
        ORDER BY candidate.pack_id LIMIT ?`,
      this.#repoId,
      encodedDeletingPackIds,
      deletingPackId,
      encodedDeletingPackIds,
      MAX_PACK_FALLBACK_AUDIT_PACKS + 1,
    )) {
      const candidatePackId = row.pack_id;
      const size = row.size;
      const count = row.count;
      if (
        typeof candidatePackId !== "number" ||
        !Number.isSafeInteger(candidatePackId) ||
        candidatePackId < 0 ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 32 ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 1
      ) {
        throw new CorruptError(`pack ${deletingPackId}: fallback pack metadata is invalid`);
      }
      packs.push({ packId: candidatePackId, size, count });
    }
    if (packs.length > MAX_PACK_FALLBACK_AUDIT_PACKS) {
      throw new GitError("E2BIG", "fallback pack audit exceeds its pack limit");
    }
    const pending = packs.filter((pack) => !budget.packIds.has(pack.packId));
    if (pending.length === 0) return;
    for (const pack of pending) {
      if (
        budget.packIds.size >= MAX_PACK_FALLBACK_AUDIT_PACKS ||
        budget.bytes > MAX_PACK_FALLBACK_AUDIT_BYTES - pack.size ||
        budget.entries > MAX_PACK_MEMBERSHIP_OBJECTS - pack.count
      ) {
        throw new GitError("E2BIG", "fallback pack audit exceeds its bounded budget");
      }
      budget.bytes += pack.size;
      budget.entries += pack.count;
      budget.packIds.add(pack.packId);
    }

    const encodedPackIds = JSON.stringify(pending.map((pack) => pack.packId));
    const byPackId = new Map<number, FallbackPackAudit>(pending.map((pack) => [pack.packId, pack]));
    let storageRows = 0;
    for (const row of this.#db.iterate(
      `SELECT pack.pack_id,
              count(data.seq) AS data_rows,
              min(data.seq) AS first_seq,
              max(data.seq) AS last_seq,
              coalesce(sum(CASE WHEN typeof(data.data) = 'blob'
                                THEN length(data.data) ELSE 0 END), 0) AS stored_bytes,
              coalesce(sum(CASE
                WHEN data.pack_id IS NULL THEN 0
                WHEN typeof(data.seq) != 'integer' OR data.seq < 0
                  OR data.seq > ${Number.MAX_SAFE_INTEGER} THEN 1
                WHEN typeof(data.data) != 'blob' OR length(data.data) < 1
                  OR length(data.data) > ${PACK_CHUNK} THEN 1
                WHEN data.seq > CAST((pack.size - 1) / ${PACK_CHUNK} AS INTEGER) THEN 1
                WHEN data.seq < CAST((pack.size - 1) / ${PACK_CHUNK} AS INTEGER)
                  AND length(data.data) != ${PACK_CHUNK} THEN 1
                WHEN data.seq = CAST((pack.size - 1) / ${PACK_CHUNK} AS INTEGER)
                  AND length(data.data) != pack.size - data.seq * ${PACK_CHUNK} THEN 1
                ELSE 0 END), 0) AS invalid_chunks
         FROM git_pack_meta pack
         LEFT JOIN git_pack_data data
           ON data.repo_id = pack.repo_id AND data.pack_id = pack.pack_id
        WHERE pack.repo_id = ? AND pack.pack_id IN (SELECT value FROM json_each(?))
        GROUP BY pack.pack_id ORDER BY pack.pack_id`,
      this.#repoId,
      encodedPackIds,
    )) {
      const packId = row.pack_id;
      const pack = typeof packId === "number" ? byPackId.get(packId) : undefined;
      const dataRows = row.data_rows;
      if (
        pack === undefined ||
        typeof dataRows !== "number" ||
        !Number.isSafeInteger(dataRows) ||
        dataRows < 1 ||
        row.first_seq !== 0 ||
        row.last_seq !== dataRows - 1 ||
        row.stored_bytes !== pack.size ||
        row.invalid_chunks !== 0
      ) {
        throw new CorruptError(`pack ${deletingPackId}: fallback pack storage is invalid`);
      }
      storageRows++;
    }
    if (storageRows !== pending.length) {
      throw new CorruptError(`pack ${deletingPackId}: fallback pack storage is incomplete`);
    }

    const entriesByPack = new Map<number, Map<number, PackedEntry>>();
    for (const pack of pending) entriesByPack.set(pack.packId, new Map());
    let entryRows = 0;
    for (const row of this.#db.iterate(
      `SELECT oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid
         FROM git_pack_entries
        WHERE repo_id = ? AND pack_id IN (SELECT value FROM json_each(?))
        ORDER BY pack_id, offset LIMIT ?`,
      this.#repoId,
      encodedPackIds,
      pending.reduce((total, pack) => total + pack.count, 0) + 1,
    )) {
      const oid = row.oid;
      const packId = row.pack_id;
      const offset = row.offset;
      const dataOff = row.data_off;
      const dataLen = row.data_len;
      const type = row.type;
      const size = row.size;
      const entrySize = row.entry_size;
      const baseOid = row.base_oid;
      const pack = typeof packId === "number" ? byPackId.get(packId) : undefined;
      const entries = typeof packId === "number" ? entriesByPack.get(packId) : undefined;
      if (
        pack === undefined ||
        entries === undefined ||
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        packId < 0 ||
        typeof oid !== "string" ||
        !isOid(oid) ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 12 ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        dataOff <= offset ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        dataLen < 1 ||
        dataOff > pack.size - 20 - dataLen ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        entrySize < 0 ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid))) ||
        entries.has(offset)
      ) {
        throw new CorruptError(`pack ${deletingPackId}: fallback physical index is invalid`);
      }
      entries.set(offset, {
        oid,
        packId,
        offset,
        dataOff,
        dataLen,
        type,
        size,
        entrySize,
        baseOid,
      });
      entryRows++;
    }
    const expectedEntries = pending.reduce((total, pack) => total + pack.count, 0);
    if (entryRows !== expectedEntries) {
      throw new CorruptError(`pack ${deletingPackId}: fallback physical index is incomplete`);
    }

    for (const pack of pending) {
      const entries = entriesByPack.get(pack.packId);
      if (entries === undefined || entries.size !== pack.count) {
        throw new CorruptError(`pack ${pack.packId}: fallback physical index count disagrees`);
      }
      const stored = new SequentialPackBytes(this.#db, this.#repoId, pack.packId, pack.size);
      const reader = new PackReader(
        (offset, length) => stored.read(offset, length),
        pack.packId,
        pack.size,
      );
      const magic = reader.take(4);
      const version = reader.uint32();
      const count = reader.uint32();
      if (
        magic[0] !== 0x50 ||
        magic[1] !== 0x41 ||
        magic[2] !== 0x43 ||
        magic[3] !== 0x4b ||
        (version !== 2 && version !== 3) ||
        count !== pack.count
      ) {
        throw new CorruptError(`pack ${pack.packId}: fallback header is invalid`);
      }
      const offsets = new Map<number, string>();
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const header = reader.entryHeader();
        const indexed = entries.get(header.offset);
        const fullType = header.kind === null ? NUMBER_TYPE[header.type] : undefined;
        let decoded: {
          data: Uint8Array | null;
          consumed: number;
          streamedOid: string | null;
          deltaTargetSize: number | null;
        };
        try {
          decoded = this.#inflateAt(reader, header.dataOff, header.entrySize, fullType ?? null);
        } catch (error) {
          throw new CorruptError(`pack ${pack.packId}: fallback pack bytes are invalid`, {
            cause: error,
          });
        }
        const baseOid =
          header.kind === null
            ? null
            : header.kind === "ref"
              ? header.baseOid
              : (offsets.get(header.offset - (header.baseDelta ?? 0)) ?? null);
        if (header.kind !== null && baseOid === null) {
          throw new CorruptError(`pack ${pack.packId}: fallback delta base is missing`);
        }
        if (
          indexed === undefined ||
          indexed.packId !== pack.packId ||
          indexed.offset !== header.offset ||
          indexed.dataOff !== header.dataOff ||
          indexed.dataLen !== decoded.consumed ||
          indexed.entrySize !== header.entrySize ||
          indexed.baseOid !== baseOid
        ) {
          throw new CorruptError(`pack ${pack.packId}: fallback index disagrees with pack bytes`);
        }
        if (header.kind === null) {
          if (fullType === undefined) {
            throw new CorruptError(`pack ${pack.packId}: fallback object type is invalid`);
          }
          const oid =
            decoded.data === null
              ? (decoded.streamedOid ?? "")
              : hashObject(fullType, decoded.data);
          if (
            indexed.oid !== oid ||
            indexed.type !== fullType ||
            indexed.size !== header.entrySize
          ) {
            throw new CorruptError(`pack ${pack.packId}: fallback index disagrees with pack bytes`);
          }
        }
        offsets.set(header.offset, indexed.oid);
      }
      if (reader.position !== pack.size - 20 || offsets.size !== pack.count) {
        throw new CorruptError(`pack ${pack.packId}: fallback pack traversal is incomplete`);
      }
      reader.take(20);
      try {
        stored.finish();
      } catch (error) {
        throw new CorruptError(`pack ${pack.packId}: fallback checksum mismatch`, { cause: error });
      }
    }
  }

  #auditPromotedFallbacks(deletingPackId: number, rows: readonly AuthenticatedPackSource[]): void {
    if (rows.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
      throw new GitError("E2BIG", "promoted fallback audit exceeds its object limit");
    }

    let page: AuthenticatedPackSource[] = [];
    let pageBytes = 0;
    const auditPage = (): void => {
      if (page.length === 0) return;
      const only = page.length === 1 ? page[0] : undefined;
      if (only !== undefined && only.dataLen > MAX_PACK_BLOB_BATCH_BYTES && only.baseOid === null) {
        this.#authenticateFullPackSourceStreaming(
          only,
          `pack ${deletingPackId}: promoted fallback disagrees with its object id`,
        );
        page = [];
        pageBytes = 0;
        return;
      }
      const objects = this.#readObjects(
        page.map((entry) => entry.oid),
        only?.packId ?? null,
        null,
        false,
        new Map(),
        true,
      );
      if (objects.size !== page.length) {
        throw new CorruptError(`pack ${deletingPackId}: promoted fallback audit is incomplete`);
      }
      for (const expected of page) {
        const object = objects.get(expected.oid);
        if (
          object === undefined ||
          object.type !== expected.type ||
          object.data.length !== expected.size ||
          hashObject(object.type, object.data) !== expected.oid
        ) {
          throw new CorruptError(
            `pack ${deletingPackId}: promoted fallback disagrees with its object id`,
          );
        }
      }
      page = [];
      pageBytes = 0;
    };
    for (const row of rows) {
      if (
        page.length > 0 &&
        (row.size > MAX_PACK_BLOB_BATCH_BYTES - pageBytes ||
          row.dataLen > MAX_PACK_BLOB_BATCH_BYTES ||
          page.length >= MAX_PACK_MEMBERSHIP_OBJECTS)
      ) {
        auditPage();
      }
      page.push(row);
      pageBytes += row.size;
      if (row.size > MAX_PACK_BLOB_BATCH_BYTES || row.dataLen > MAX_PACK_BLOB_BATCH_BYTES) {
        auditPage();
      }
    }
    auditPage();
  }

  #authenticateLooseDeltaBases(
    deletingPackId: number,
    deletingPackIds: readonly number[],
    budget: FallbackAuditBudget,
  ): void {
    const bases: CompletePackObject[] = [];
    for (const row of this.#db.iterate(
      `SELECT DISTINCT base.oid, base.type, base.size,
              loose.oid AS loose_oid, loose.type AS loose_type, loose.size AS loose_size
         FROM git_pack_entries child
         JOIN git_pack_meta child_pack
           ON child_pack.repo_id = child.repo_id AND child_pack.pack_id = child.pack_id
          AND child_pack.state = 'complete'
         JOIN git_pack_objects base
           ON base.repo_id = child.repo_id AND base.oid = child.base_oid
          AND base.pack_id = ?
         LEFT JOIN git_objects loose
           ON loose.repo_id = base.repo_id AND loose.oid = base.oid
        WHERE child.repo_id = ?
          AND child.pack_id NOT IN (SELECT value FROM json_each(?))
        ORDER BY base.oid COLLATE BINARY LIMIT ?`,
      deletingPackId,
      this.#repoId,
      JSON.stringify(deletingPackIds),
      MAX_PACK_MEMBERSHIP_OBJECTS + 1,
    )) {
      if (bases.length >= MAX_PACK_MEMBERSHIP_OBJECTS) {
        throw new GitError("E2BIG", "surviving loose delta closure exceeds its object limit");
      }
      if (
        typeof row.oid !== "string" ||
        !isOid(row.oid) ||
        typeof row.type !== "string" ||
        !isObjectType(row.type) ||
        typeof row.size !== "number" ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > MAX_PACK_DELTA_WORKING_BYTES
      ) {
        throw new CorruptError(`pack ${deletingPackId}: delta base metadata is invalid`);
      }
      if (row.loose_oid === null) {
        throw new GitError(
          "EBUSY",
          `pack ${deletingPackId} is required by a surviving delta chain`,
        );
      }
      if (row.loose_oid !== row.oid || row.loose_type !== row.type || row.loose_size !== row.size) {
        throw new CorruptError(`pack ${deletingPackId}: surviving loose delta base is invalid`);
      }
      bases.push({ oid: row.oid, type: row.type, size: row.size });
    }
    if (bases.length === 0) return;
    const bytes = bases.reduce((total, base) => total + base.size, 0);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_PACK_FALLBACK_AUDIT_BYTES - budget.bytes) {
      throw new GitError("E2BIG", "surviving loose delta closure exceeds its byte limit");
    }
    budget.bytes += bytes;
    this.#authenticateLooseObjects(deletingPackId, bases);
  }

  #authenticateLooseObjects(deletingPackId: number, objects: readonly CompletePackObject[]): void {
    let ordinal = -1;
    let expected: CompletePackObject | undefined;
    let sha: Sha1 | null = null;
    let inflater: InflateStream | null = null;
    let stored: "raw" | "zlib" | null = null;
    let nextSeq = 0;
    let produced = 0;
    let rows = 0;
    const finish = (): void => {
      if (
        expected === undefined ||
        sha === null ||
        stored === null ||
        rows < 1 ||
        produced !== expected.size ||
        (stored === "zlib" && (inflater === null || !inflater.ended)) ||
        toHex(sha.digest()) !== expected.oid
      ) {
        throw new CorruptError(
          `pack ${deletingPackId}: surviving loose delta base bytes are invalid`,
        );
      }
    };
    for (const row of this.#db.iterate(
      `SELECT CAST(input.key AS INTEGER) AS ordinal,
              json_extract(input.value, '$.oid') AS expected_oid,
              json_extract(input.value, '$.type') AS expected_type,
              json_extract(input.value, '$.size') AS expected_size,
              loose.oid, loose.type, loose.size, loose.stored,
              chunk.seq, chunk.data
         FROM json_each(?) input
         LEFT JOIN git_objects loose
           ON loose.repo_id = ? AND loose.oid = json_extract(input.value, '$.oid')
         LEFT JOIN git_object_chunks chunk
           ON chunk.repo_id = loose.repo_id AND chunk.oid = loose.oid
        ORDER BY CAST(input.key AS INTEGER), chunk.seq`,
      JSON.stringify(objects),
      this.#repoId,
    )) {
      if (row.ordinal !== ordinal) {
        if (ordinal >= 0) finish();
        ordinal++;
        expected = objects[ordinal];
        if (
          expected === undefined ||
          row.ordinal !== ordinal ||
          row.expected_oid !== expected.oid ||
          row.expected_type !== expected.type ||
          row.expected_size !== expected.size ||
          row.oid !== expected.oid ||
          row.type !== expected.type ||
          row.size !== expected.size ||
          (row.stored !== "raw" && row.stored !== "zlib")
        ) {
          throw new CorruptError(
            `pack ${deletingPackId}: surviving loose delta base metadata changed`,
          );
        }
        sha = new Sha1().update(objectHeader(expected.type, expected.size));
        stored = row.stored;
        nextSeq = 0;
        produced = 0;
        rows = 0;
        inflater =
          stored === "zlib"
            ? new InflateStream((chunk) => {
                produced += chunk.length;
                if (expected === undefined || produced > expected.size) {
                  throw new CorruptError(
                    `pack ${deletingPackId}: surviving loose delta base exceeds its size`,
                  );
                }
                sha?.update(chunk);
              })
            : null;
      }
      if (row.seq !== nextSeq) {
        throw new CorruptError(
          `pack ${deletingPackId}: surviving loose delta base chunks are incomplete`,
        );
      }
      const data = readBlob(row.data);
      if (data.length > PACK_CHUNK) {
        throw new CorruptError(
          `pack ${deletingPackId}: surviving loose delta base chunk is too large`,
        );
      }
      if (stored === "raw") {
        produced += data.length;
        if (expected === undefined || produced > expected.size) {
          throw new CorruptError(
            `pack ${deletingPackId}: surviving loose delta base exceeds its size`,
          );
        }
        sha?.update(data);
      } else if (inflater !== null) {
        let consumed = 0;
        while (consumed < data.length) {
          const used = inflater.push(data.subarray(consumed));
          consumed += used;
          if (inflater.ended && consumed !== data.length) {
            throw new CorruptError(
              `pack ${deletingPackId}: surviving loose delta base has trailing bytes`,
            );
          }
          if (!inflater.ended && used === 0) {
            throw new CorruptError(
              `pack ${deletingPackId}: surviving loose delta base inflater made no progress`,
            );
          }
        }
      }
      nextSeq++;
      rows++;
    }
    if (ordinal >= 0) finish();
    if (ordinal + 1 !== objects.length) {
      throw new CorruptError(
        `pack ${deletingPackId}: surviving loose delta base authentication is incomplete`,
      );
    }
  }

  #deletePack(
    packId: number,
    deletingPackIds: readonly number[],
    auditBudget: FallbackAuditBudget,
    memory: MemoryReservation,
  ): void {
    memory.set("pool", MAX_PACK_DELTA_WORKING_BYTES);
    memory.set("base", MAX_PACK_BLOB_BATCH_BYTES);
    memory.set("compressed", MAX_PACK_BLOB_BATCH_BYTES);
    memory.set("metadata", PACK_FALLBACK_AUDIT_METADATA_BYTES);
    const encodedDeletingPackIds = JSON.stringify(deletingPackIds);
    const invalidFallback = this.#db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1
           FROM git_pack_entries candidate
           JOIN git_pack_meta candidate_meta
             ON candidate_meta.repo_id = candidate.repo_id
            AND candidate_meta.pack_id = candidate.pack_id
            AND candidate_meta.state = 'complete'
           JOIN git_pack_objects current
             ON current.repo_id = candidate.repo_id AND current.oid = candidate.oid
            AND current.pack_id = ?
          WHERE candidate.repo_id = ?
            AND candidate.pack_id NOT IN (SELECT value FROM json_each(?))
            AND (
              typeof(candidate_meta.size) != 'integer' OR candidate_meta.size < 0
              OR candidate_meta.size > ${Number.MAX_SAFE_INTEGER}
              OR typeof(candidate_meta.count) != 'integer' OR candidate_meta.count < 0
              OR candidate_meta.count > ${Number.MAX_SAFE_INTEGER}
              OR typeof(candidate.pack_id) != 'integer' OR candidate.pack_id < 0
              OR candidate.pack_id > ${Number.MAX_SAFE_INTEGER}
              OR typeof(candidate.oid) != 'text'
              OR length(CAST(candidate.oid AS BLOB)) != 40
              OR candidate.oid GLOB '*[^0-9a-f]*'
              OR typeof(candidate.offset) != 'integer' OR candidate.offset < 0
              OR candidate.offset > ${Number.MAX_SAFE_INTEGER}
              OR typeof(candidate.data_off) != 'integer' OR candidate.data_off < candidate.offset
              OR candidate.data_off > ${Number.MAX_SAFE_INTEGER}
              OR typeof(candidate.data_len) != 'integer' OR candidate.data_len < 0
              OR candidate.data_len > ${Number.MAX_SAFE_INTEGER}
              OR candidate.data_off > candidate_meta.size - candidate.data_len
              OR typeof(candidate.type) != 'text'
              OR candidate.type NOT IN ('blob','tree','commit','tag')
              OR typeof(candidate.size) != 'integer' OR candidate.size < 0
              OR candidate.size > ${Number.MAX_SAFE_INTEGER}
              OR typeof(candidate.entry_size) != 'integer' OR candidate.entry_size < 0
              OR candidate.entry_size > ${Number.MAX_SAFE_INTEGER}
              OR (candidate.base_oid IS NOT NULL AND (
                typeof(candidate.base_oid) != 'text'
                OR length(CAST(candidate.base_oid AS BLOB)) != 40
                OR candidate.base_oid GLOB '*[^0-9a-f]*'
              ))
              OR candidate.type IS NOT current.type
              OR candidate.size IS NOT current.size
            )
       )`,
      packId,
      this.#repoId,
      encodedDeletingPackIds,
    );
    if (invalidFallback !== 0) {
      throw new CorruptError(`pack ${packId}: fallback membership is invalid`);
    }
    this.clearCaches();
    this.#auditFallbackPacks(packId, deletingPackIds, auditBudget);
    const promoted: AuthenticatedPackSource[] = [];
    const promotedOids = new Set<string>();
    for (const row of this.#db.iterate(
      `INSERT OR REPLACE INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       SELECT candidate.repo_id, candidate.oid, candidate.pack_id, candidate.offset,
              candidate.data_off, candidate.data_len, candidate.type, candidate.size,
              candidate.entry_size, candidate.base_oid
         FROM git_pack_entries candidate
         JOIN git_pack_meta candidate_meta
           ON candidate_meta.repo_id = candidate.repo_id
          AND candidate_meta.pack_id = candidate.pack_id
          AND candidate_meta.state = 'complete'
        WHERE candidate.repo_id = ?
          AND candidate.pack_id NOT IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM git_pack_objects current
             WHERE current.repo_id = candidate.repo_id AND current.oid = candidate.oid
               AND current.pack_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries earlier
            JOIN git_pack_meta earlier_meta
              ON earlier_meta.repo_id = earlier.repo_id
             AND earlier_meta.pack_id = earlier.pack_id
             AND earlier_meta.state = 'complete'
             WHERE earlier.repo_id = candidate.repo_id AND earlier.oid = candidate.oid
               AND earlier.pack_id NOT IN (SELECT value FROM json_each(?))
               AND earlier.pack_id < candidate.pack_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries same_pack
             WHERE same_pack.repo_id = candidate.repo_id
               AND same_pack.pack_id = candidate.pack_id
               AND same_pack.oid = candidate.oid
               AND same_pack.offset < candidate.offset
          )
       RETURNING oid, pack_id, type, size, data_off, data_len, entry_size, base_oid`,
      this.#repoId,
      encodedDeletingPackIds,
      packId,
      encodedDeletingPackIds,
    )) {
      const oid = row.oid;
      const promotedPackId = row.pack_id;
      const type = row.type;
      const size = row.size;
      const dataOff = row.data_off;
      const dataLen = row.data_len;
      const entrySize = row.entry_size;
      const baseOid = row.base_oid;
      if (
        typeof oid !== "string" ||
        !isOid(oid) ||
        promotedOids.has(oid) ||
        typeof promotedPackId !== "number" ||
        !Number.isSafeInteger(promotedPackId) ||
        promotedPackId < 0 ||
        deletingPackIds.includes(promotedPackId) ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_PACK_DELTA_WORKING_BYTES ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        dataOff < 0 ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        dataLen < 1 ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        entrySize < 0 ||
        entrySize > MAX_PACK_DELTA_WORKING_BYTES ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid))) ||
        (baseOid === null && entrySize !== size)
      ) {
        throw new CorruptError(`pack ${packId}: promoted fallback row is invalid`);
      }
      promotedOids.add(oid);
      promoted.push({
        oid,
        packId: promotedPackId,
        type,
        size,
        dataOff,
        dataLen,
        entrySize,
        baseOid,
      });
      if (promoted.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
        throw new GitError("E2BIG", "promoted fallback audit exceeds its object limit");
      }
    }
    this.#auditPromotedFallbacks(packId, promoted);
    this.#authenticateLooseDeltaBases(packId, deletingPackIds, auditBudget);
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
      `INSERT OR REPLACE INTO git_tree_effective (repo_id, tree_oid, source_key)
       SELECT object.repo_id, object.oid, source.source_key
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
         JOIN git_tree_sources source
           ON source.repo_id = object.repo_id AND source.tree_oid = object.oid
          AND source.storage = 'pack' AND source.source_id = object.pack_id
        WHERE object.repo_id = ? AND object.type = 'tree'
          AND EXISTS (
            SELECT 1 FROM git_tree_sources doomed
             WHERE doomed.repo_id = object.repo_id AND doomed.tree_oid = object.oid
               AND doomed.storage = 'pack' AND doomed.source_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = object.repo_id AND loose.oid = object.oid
               AND loose.type = 'tree'
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
      "git_pack_entries",
      "git_pack_objects",
      "git_pack_pending",
      "git_pack_meta",
    ]) {
      this.#db.run(`DELETE FROM ${table} WHERE repo_id = ? AND pack_id = ?`, this.#repoId, packId);
    }
    memory.clear("pool");
    memory.clear("base");
    memory.clear("compressed");
    memory.clear("metadata");
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
    return this.#ingest(source, options);
  }

  async #ingest(
    source: AsyncIterable<Uint8Array>,
    options: PackIngestOptions,
  ): Promise<PackIngestResult> {
    const reclaimPending = options.reclaimPending ?? true;
    if (typeof reclaimPending !== "boolean") {
      throw new RangeError("reclaimPending must be a boolean");
    }
    const now = options.now ?? this.#now;
    const say = options.onProgress ?? (() => {});
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const yieldNow = options.yieldNow ?? (() => Promise.resolve());
    let memory: PackIngestMemory | undefined;
    let activePackId: number | undefined;
    let lease: PackIngestLease | null = null;
    try {
      const memoryReservation =
        options.reservation === undefined
          ? this.#memory.reserve()
          : this.#scopeMemory(options.reservation);
      const pool = new ChunkPool(MAX_PACK_DELTA_WORKING_BYTES);
      memory = { reservation: memoryReservation, pool };
      const reservation = this.#reservePending(
        requireIngestTime(now),
        options.lifecycle,
        { ordinary: reclaimPending },
        memoryReservation,
      );
      activePackId = reservation.packId;
      lease = reservation.lease;
      if (reservation.reclaimed > 0) this.clearCaches();
      const activeLease = lease;
      const heartbeat =
        activeLease === null ? () => undefined : () => this.#renewIngestLease(activeLease, now);

      const total = await this.#writeChunks(
        source,
        reservation.packId,
        maxBytes,
        say,
        yieldNow,
        heartbeat,
        memory,
      );
      heartbeat();
      memoryReservation.set("pool", MAX_PACK_DELTA_WORKING_BYTES);
      const { count, commits, membership } = await this.#indexPack(
        reservation.packId,
        total,
        say,
        yieldNow,
        heartbeat,
        memory,
      );
      heartbeat();
      const result = { packId: reservation.packId, count, bytes: total };
      const publishingLease = lease;

      this.#db.transactionSync(() => {
        if (publishingLease !== null) this.#renewIngestLease(publishingLease, now);
        const published = this.#db.one<Record<string, unknown>>(
          `UPDATE git_pack_meta SET size = ?, count = ?, state = 'complete'
            WHERE repo_id = ? AND pack_id = ? AND state = 'pending'
          RETURNING pack_id, size, count, state`,
          total,
          count,
          this.#repoId,
          reservation.packId,
        );
        if (
          published === undefined ||
          published.pack_id !== reservation.packId ||
          published.size !== total ||
          published.count !== count ||
          published.state !== "complete"
        ) {
          throw new GitError("ESTALE", "pack ingest ownership changed before publication");
        }
        commits.finish();
        this.#auditPublishedMembership(reservation.packId, count, total, membership);
        if (options.lifecycle !== undefined) {
          requireLifecycleResult(options.lifecycle.published(result), "published");
        }
        if (publishingLease !== null) this.#releaseIngestLease(publishingLease, true);
      });
      if (publishingLease !== null) lease = null;
      memoryReservation.clear("other");
      memoryReservation.clear("commit");
      return result;
    } finally {
      if (activePackId !== undefined) this.#sharedState.activePending.delete(activePackId);
      try {
        if (lease !== null) this.#releaseIngestLease(lease, false);
      } finally {
        if (memory !== undefined) {
          const { reservation, pool } = memory;
          this.#sharedState.lastIngestMemoryHighWater = reservation.highWaterBytes;
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
              reservation.clear("other");
              reservation.assertEmpty();
            } finally {
              reservation.dispose();
            }
          }
        }
      }
    }
  }

  #reservePending(
    nowMs: number,
    lifecycle: PackIngestLifecycle | undefined,
    ownership: { ordinary: boolean },
    memory: MemoryReservation,
  ): { packId: number; lease: PackIngestLease | null; reclaimed: number } {
    let activePackId: number | undefined;
    try {
      return this.#db.transactionSync(() => {
        let control = this.#ensureIngestControl();
        let reclaimed = 0;
        if (ownership.ordinary) {
          const cleanup = this.#reclaimPendingRows(control, nowMs, memory);
          control = cleanup.control;
          reclaimed = cleanup.removed;
          if (control.activePackId !== null) {
            throw new GitError("EBUSY", "pack ingest is active");
          }
          if (control.ownerGeneration === Number.MAX_SAFE_INTEGER) {
            throw new GitError("E2BIG", "pack ingest generation is exhausted");
          }
        }
        const packId = this.#nextPackId(control);
        this.#db.run(
          "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, 0, 0, 'pending', ?)",
          this.#repoId,
          packId,
          nowMs,
        );
        let lease: PackIngestLease | null = null;
        let updated: Record<string, unknown> | undefined;
        if (ownership.ordinary) {
          const generation = control.ownerGeneration + 1;
          updated = this.#db.one<Record<string, unknown>>(
            `UPDATE git_pack_ingest_control
                SET owner_generation = ?, last_pack_id = ?, active_pack_id = ?, expires_ms = ?
              WHERE repo_id = ?
            RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
            generation,
            packId,
            packId,
            nowMs + PACK_INGEST_LEASE_MS,
            this.#repoId,
          );
          lease = { generation, packId, expiresMs: nowMs + PACK_INGEST_LEASE_MS };
        } else {
          updated = this.#db.one<Record<string, unknown>>(
            `UPDATE git_pack_ingest_control SET last_pack_id = ? WHERE repo_id = ?
            RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
            packId,
            this.#repoId,
          );
        }
        if (
          updated === undefined ||
          requireIngestControl(updated, this.#repoId).lastPackId !== packId
        ) {
          throw new CorruptError("pack ingest allocation was not recorded");
        }
        this.#sharedState.activePending.add(packId);
        activePackId = packId;
        if (lifecycle !== undefined) {
          requireLifecycleResult(lifecycle.reserved(packId), "reserved");
        }
        return { packId, lease, reclaimed };
      });
    } catch (error) {
      if (activePackId !== undefined) this.#sharedState.activePending.delete(activePackId);
      throw error;
    }
  }

  #renewIngestLease(lease: PackIngestLease, now: () => number): void {
    const nowMs = requireIngestTime(now);
    if (nowMs < lease.expiresMs - Math.floor(PACK_INGEST_LEASE_MS / 2)) return;
    const row = this.#db.one<Record<string, unknown>>(
      `UPDATE git_pack_ingest_control
          SET expires_ms = max(expires_ms, ?)
        WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ? AND expires_ms > ?
      RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
      nowMs + PACK_INGEST_LEASE_MS,
      this.#repoId,
      lease.generation,
      lease.packId,
      nowMs,
    );
    if (row === undefined) throw new GitError("ESTALE", "pack ingest ownership expired");
    const control = requireIngestControl(row, this.#repoId);
    if (
      control.ownerGeneration !== lease.generation ||
      control.activePackId !== lease.packId ||
      control.expiresMs === null ||
      control.expiresMs <= nowMs
    ) {
      throw new CorruptError("pack ingest lease renewal returned an invalid owner");
    }
    lease.expiresMs = control.expiresMs;
  }

  #releaseIngestLease(lease: PackIngestLease, required: boolean, db: SqlDatabase = this.#db): void {
    const row = db.one<Record<string, unknown>>(
      `UPDATE git_pack_ingest_control
          SET active_pack_id = NULL, expires_ms = NULL
        WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ?
      RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
      this.#repoId,
      lease.generation,
      lease.packId,
    );
    if (row === undefined) {
      if (required) throw new GitError("ESTALE", "pack ingest ownership changed");
      return;
    }
    requireIngestControl(row, this.#repoId);
  }

  #auditPublishedMembership(
    packId: number,
    expectedCount: number,
    expectedBytes: number,
    expected: ExpectedPackMembership,
  ): void {
    const stored = new SequentialPackBytes(this.#db, this.#repoId, packId, expectedBytes);
    const reader = new PackReader(
      (offset, length) => stored.read(offset, length),
      packId,
      expectedBytes,
    );
    const magic = reader.take(4);
    const version = reader.uint32();
    const storedCount = reader.uint32();
    if (
      magic[0] !== 0x50 ||
      magic[1] !== 0x41 ||
      magic[2] !== 0x43 ||
      magic[3] !== 0x4b ||
      (version !== 2 && version !== 3) ||
      storedCount !== expectedCount
    ) {
      throw new CorruptError(`pack ${packId}: publication bytes have an invalid header`);
    }
    for (let byteOrdinal = 0; byteOrdinal < storedCount; byteOrdinal++) {
      const header = reader.entryHeader();
      const type = header.kind === null ? NUMBER_TYPE[header.type] : undefined;
      if (header.kind === null && type === undefined) {
        throw new CorruptError(`pack ${packId}: publication bytes have an invalid object type`);
      }
      const inflated = this.#inflateAt(reader, header.dataOff, header.entrySize, type ?? null);
      const oid =
        type === undefined
          ? null
          : inflated.data === null
            ? inflated.streamedOid
            : hashObject(type, inflated.data);
      expected.verifyBytes(byteOrdinal, {
        offset: header.offset,
        dataOff: header.dataOff,
        dataLen: inflated.consumed,
        entrySize: header.entrySize,
        kind: header.kind,
        baseDelta: header.baseDelta,
        baseOid: header.baseOid,
        type: type ?? null,
        size: type === undefined ? (inflated.deltaTargetSize ?? -1) : header.entrySize,
        oid,
        compressedDigest: inflated.compressedDigest,
      });
    }
    if (reader.position !== expectedBytes - 20) {
      throw new CorruptError(`pack ${packId}: publication byte traversal is incomplete`);
    }
    reader.take(20);
    stored.finish();

    let ordinal = 0;
    for (const row of this.#db.iterate(
      `SELECT /* exact-pack-publication-membership */ oid,
              CASE WHEN typeof(pack_id) = 'integer'
                     AND pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN pack_id END AS pack_id,
              CASE WHEN typeof(offset) = 'integer'
                     AND offset BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN offset END AS offset,
              CASE WHEN typeof(data_off) = 'integer'
                     AND data_off BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN data_off END AS data_off,
              CASE WHEN typeof(data_len) = 'integer'
                     AND data_len BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN data_len END AS data_len,
              type,
              CASE WHEN typeof(size) = 'integer'
                     AND size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN size END AS size,
              CASE WHEN typeof(entry_size) = 'integer'
                     AND entry_size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN entry_size END AS entry_size,
              base_oid
         FROM git_pack_entries
        WHERE repo_id = ? AND pack_id = ?
        ORDER BY offset LIMIT ?`,
      this.#repoId,
      packId,
      expectedCount + 1,
    )) {
      const oid = row.oid;
      const rowPackId = row.pack_id;
      const offset = row.offset;
      const dataOff = row.data_off;
      const dataLen = row.data_len;
      const type = row.type;
      const size = row.size;
      const entrySize = row.entry_size;
      const baseOid = row.base_oid;
      if (
        typeof oid !== "string" ||
        !isOid(oid) ||
        rowPackId !== packId ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        dataOff <= offset ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        dataLen < 1 ||
        dataOff > expectedBytes - dataLen ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        entrySize < 0 ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid)))
      ) {
        throw new CorruptError(`pack ${packId}: publication membership metadata disagrees`);
      }
      const physical: PackObjectInput = [
        oid,
        packId,
        offset,
        dataOff,
        dataLen,
        type,
        size,
        entrySize,
        baseOid,
      ];
      expected.verify(ordinal, physical);
      ordinal++;
    }
    if (ordinal !== expectedCount) {
      throw new CorruptError(`pack ${packId}: publication membership metadata disagrees`);
    }

    const row = this.#db.one<Record<string, unknown>>(
      `SELECT count(*) AS entry_count,
              (SELECT count(*) FROM git_pack_pending
                WHERE repo_id = ? AND pack_id = ?) AS pending_count,
              (SELECT count(*) FROM git_pack_entries published
                JOIN git_pack_objects canonical
                  ON canonical.repo_id = published.repo_id AND canonical.oid = published.oid
               WHERE published.repo_id = ? AND published.pack_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM git_pack_entries physical
                     WHERE physical.repo_id = canonical.repo_id
                       AND physical.oid = canonical.oid
                       AND physical.pack_id = canonical.pack_id
                       AND physical.offset IS canonical.offset
                       AND physical.data_off IS canonical.data_off
                       AND physical.data_len IS canonical.data_len
                       AND physical.type IS canonical.type
                       AND physical.size IS canonical.size
                       AND physical.entry_size IS canonical.entry_size
                       AND physical.base_oid IS canonical.base_oid
                  )) AS canonical_mismatch_count,
              coalesce(sum(CASE WHEN object.oid IS NULL OR owner.state IS NOT 'complete'
                                THEN 1 ELSE 0 END), 0) AS unavailable_count,
              coalesce(sum(CASE
                WHEN typeof(entry.oid) != 'text'
                  OR length(CAST(entry.oid AS BLOB)) != 40
                  OR entry.oid GLOB '*[^0-9a-f]*'
                  OR typeof(entry.offset) != 'integer' OR entry.offset < 0
                  OR entry.offset > ${Number.MAX_SAFE_INTEGER}
                  OR typeof(entry.data_off) != 'integer' OR entry.data_off < entry.offset
                  OR entry.data_off > ${Number.MAX_SAFE_INTEGER}
                  OR typeof(entry.data_len) != 'integer' OR entry.data_len < 0
                  OR entry.data_len > ${Number.MAX_SAFE_INTEGER}
                  OR entry.data_off > ? - entry.data_len
                  OR entry.data_off + entry.data_len > ?
                  OR typeof(entry.type) != 'text'
                  OR entry.type NOT IN ('blob','tree','commit','tag')
                  OR typeof(entry.size) != 'integer' OR entry.size < 0
                  OR entry.size > ${Number.MAX_SAFE_INTEGER}
                  OR typeof(entry.entry_size) != 'integer' OR entry.entry_size < 0
                  OR entry.entry_size > ${Number.MAX_SAFE_INTEGER}
                  OR (entry.base_oid IS NOT NULL AND (
                    typeof(entry.base_oid) != 'text'
                    OR length(CAST(entry.base_oid AS BLOB)) != 40
                    OR entry.base_oid GLOB '*[^0-9a-f]*'
                  )) THEN 1
                WHEN object.oid IS NOT NULL
                  AND (object.type IS NOT entry.type OR object.size IS NOT entry.size)
                                THEN 1 ELSE 0 END), 0) AS mismatched_count
         FROM git_pack_entries entry
         LEFT JOIN git_pack_objects object
           ON object.repo_id = entry.repo_id AND object.oid = entry.oid
         LEFT JOIN git_pack_meta owner
           ON owner.repo_id = object.repo_id AND owner.pack_id = object.pack_id
        WHERE entry.repo_id = ? AND entry.pack_id = ?`,
      this.#repoId,
      packId,
      this.#repoId,
      packId,
      expectedBytes,
      expectedBytes,
      this.#repoId,
      packId,
    );
    if (
      row === undefined ||
      typeof row.entry_count !== "number" ||
      !Number.isSafeInteger(row.entry_count) ||
      row.entry_count < 0 ||
      typeof row.pending_count !== "number" ||
      !Number.isSafeInteger(row.pending_count) ||
      row.pending_count < 0 ||
      typeof row.canonical_mismatch_count !== "number" ||
      !Number.isSafeInteger(row.canonical_mismatch_count) ||
      row.canonical_mismatch_count < 0 ||
      typeof row.unavailable_count !== "number" ||
      !Number.isSafeInteger(row.unavailable_count) ||
      row.unavailable_count < 0 ||
      typeof row.mismatched_count !== "number" ||
      !Number.isSafeInteger(row.mismatched_count) ||
      row.mismatched_count < 0
    ) {
      throw new CorruptError(`pack ${packId}: publication audit is invalid`);
    }
    if (row.pending_count !== 0) {
      throw new CorruptError(`pack ${packId}: publication retained unresolved deltas`);
    }
    if (row.canonical_mismatch_count !== 0 || row.mismatched_count !== 0) {
      throw new CorruptError(`pack ${packId}: publication membership metadata disagrees`);
    }
    if (row.entry_count !== expectedCount || row.unavailable_count !== 0) {
      throw new GitError("ESTALE", "pack membership was claimed by another ingest");
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
    heartbeat: () => void,
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
      heartbeat();
      if (data.length === 0) continue;
      for (let offset = 0; offset < data.length; offset += SLICE) {
        feed(data.subarray(offset, offset + SLICE));
        memory.pool.assertIdle();
        await yieldNow();
        heartbeat();
      }
    }
    heartbeat();
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
    heartbeat: () => void,
    memory: PackIngestMemory,
  ): Promise<{
    count: number;
    commits: PackCommitIndex;
    membership: ExpectedPackMembership;
  }> {
    memory.reservation.set("metadata", PACK_INGEST_METADATA_BYTES);
    const reader = new PackReader(
      (offset, length) => this.readRaw(packId, offset, length),
      packId,
      total,
    );
    const magic = reader.take(4);
    if (magic[0] !== 0x50 || magic[1] !== 0x41 || magic[2] !== 0x43 || magic[3] !== 0x4b) {
      throw new CorruptError("bad pack signature");
    }
    const version = reader.uint32();
    const count = reader.uint32();
    if (version !== 2 && version !== 3)
      throw new CorruptError(`unsupported pack version ${version}`);
    memory.reservation.set("other", expectedPackMembershipBytes(count));
    const membership = new ExpectedPackMembership(count);

    const offsets = new OffsetWindow();
    const objectIndex = new PackObjectBatch(this.#db, this.#repoId, (row) =>
      membership.record(row),
    );
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
      membership.addOffset(i, header.offset);
      const entryType = header.kind === null ? NUMBER_TYPE[header.type]! : null;
      this.#reserveFlat(header.entrySize, treeIndex, commitIndex, memory.reservation);
      const entry = this.#inflateAt(reader, header.dataOff, header.entrySize, entryType);
      const fullOid =
        entryType === null
          ? null
          : entry.data === null
            ? entry.streamedOid
            : hashObject(entryType, entry.data);
      membership.recordBytes(i, {
        offset: header.offset,
        dataOff: header.dataOff,
        dataLen: entry.consumed,
        entrySize: header.entrySize,
        kind: header.kind,
        baseDelta: header.baseDelta,
        baseOid: header.baseOid,
        type: entryType,
        size: entryType === null ? (entry.deltaTargetSize ?? -1) : header.entrySize,
        oid: fullOid,
        compressedDigest: entry.compressedDigest,
      });

      if (header.kind === null) {
        const type = entryType!;
        const oid = fullOid!;
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
        heartbeat();
        if ((i & 65535) === 65535) {
          say(`Resolving deltas: ${i + 1}/${count}\n`);
          heartbeat();
        }
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
      heartbeat,
      memory,
    );
    heartbeat();
    objectIndex.flush();
    treeIndex.flush();
    memory.reservation.clear("tree");
    memory.reservation.clear("metadata");
    if (deferred > 0) say(`Resolved ${deferred} deferred delta(s)\n`);
    membership.assertComplete();
    return { count, commits: commitIndex, membership };
  }

  async #drainPending(
    packId: number,
    offsets: OffsetWindow,
    objectIndex: PackObjectBatch,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    yieldNow: () => Promise<void>,
    heartbeat: () => void,
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
        heartbeat();
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
  ): {
    data: Uint8Array | null;
    consumed: number;
    streamedOid: string | null;
    deltaTargetSize: number | null;
    compressedDigest: string;
  } {
    const buffered = entrySize <= this.#maxBufferedEntry;
    const deltaHeader = type === null ? new DeltaHeaderProbe() : null;
    const compressedSha = new Sha1();
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
        deltaHeader?.update(exact.data);
        compressedSha.update(window.subarray(0, exact.consumed));
        reader.seek(dataOff + exact.consumed);
        return {
          data: exact.data,
          consumed: exact.consumed,
          streamedOid: null,
          deltaTargetSize: deltaHeader?.finish().targetSize ?? null,
          compressedDigest: toHex(compressedSha.digest()),
        };
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
        deltaHeader?.update(chunk);
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
      if (!stream.ended && used !== window.length) {
        throw new CorruptError(`pack entry inflater stopped before the stream ended at ${dataOff}`);
      }
      compressedSha.update(window.subarray(0, used));
      reader.seek(reader.position + (stream.ended ? used : window.length));
    }
    if (stream.inflated !== entrySize) {
      throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
    }
    const data = exactInflater?.finish() ?? null;
    if (data !== null) deltaHeader?.update(data);
    return {
      data,
      consumed,
      streamedOid: buffered || sha === null ? null : toHex(sha.digest()),
      deltaTargetSize: deltaHeader?.finish().targetSize ?? null,
      compressedDigest: toHex(compressedSha.digest()),
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
    private readonly readRaw: (offset: number, length: number) => Uint8Array,
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
    const value = this.readRaw(this.#position, 1)[0]!;
    this.#position += 1;
    return value;
  }

  take(length: number): Uint8Array {
    const bytes = this.readRaw(this.#position, length);
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
    return this.readRaw(this.#position, end - this.#position);
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
