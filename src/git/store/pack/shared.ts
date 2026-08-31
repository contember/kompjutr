// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.
//
// Pack-native object storage. A received packfile is written to SQLite
// verbatim, still compressed, in fixed-size chunk rows, and indexed
// (oid -> pack, offset, delta base). Reads pull only the chunks an object
// actually spans, so nothing ever inflates a whole repository.

import { isOid, toHex } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { type ObjectType, objectHeader, type RawObject } from "../../common/objects.js";
import { Sha1 } from "../../common/sha1.js";
import { type InflateInto, InflateSizeError } from "../../common/zlib.js";
import type { PackObjectInput } from "../pack-ingest-index.js";
import type { ByteSource, ChunkedBytes, ChunkPool } from "./chunks.js";

/** Bytes per `git_pack_data` row. Comfortably under the DO row limit. */
export const PACK_CHUNK = 1024 * 1024;
export const MAX_PACK_MEMBERSHIP_OBJECTS = 2_048;
export const MAX_PACK_DELETE_BATCH = 48;
export const PACK_INGEST_LEASE_MS = 5 * 60 * 1_000;
export const MAX_PACK_INGEST_OBJECTS = 128 * 1024;
export const PACK_MEMBERSHIP_DIGEST_BYTES = 20;

/**
 * Git's default pack depth is 50, but a pack from another implementation can
 * legitimately chain deeper. The base walk is iterative and separately
 * cycle-checked by a seen-set, so this bounds chain *length* rather than
 * guarding stack depth — which means it can be generous without risk.
 */
export const MAX_DELTA_DEPTH = 50_000;

/** Non-refusing target for buffered object, compressed, and base batches. */
export const PACK_BLOB_BATCH_TARGET_BYTES = 4 * 1024 * 1024;
export const MAX_PACK_BLOB_GRAPH_ENTRIES = 4096;
export const MAX_PACK_BLOB_INPUTS = 4096;

/** Recent (offset -> oid) pairs kept in memory for immediate ofs-delta bases. */
export const OFFSET_WINDOW = 4_096;

export interface PackCacheOptions {
  /** Database-wide bytes of still-compressed pack rows held hot. */
  chunkBytes?: number;
  /** Largest entry inflated into one buffer. Anything above streams. */
  maxBufferedEntry?: number;
  /** Largest object admitted to the shared object cache. */
  cacheEntryLimit?: number;
  /** Test seam; production uses `MAX_DELTA_DEPTH`. */
  maxDeltaDepth?: number;
  /** Test seam; production discovers 4,096 union-graph rows per page. */
  graphPageEntries?: number;
  /** Test seam for durable ingest lease expiry. */
  now?: () => number;
}

export interface PackSharedState {
  cacheGeneration: number;
  activePending: Set<number>;
}

export const DEFAULT_CHUNK_BYTES = 4 * PACK_CHUNK;
export const MAX_PACK_ROW_CACHE_BYTES = DEFAULT_CHUNK_BYTES;
export const DEFAULT_MAX_BUFFERED_ENTRY = 8 * 1024 * 1024;
export const DEFAULT_CACHE_ENTRY_LIMIT = 2 * 1024 * 1024;
export const MAX_PACK_DELTA_WORKING_BYTES = 48 * 1024 * 1024;
export const PACK_READ_BYTES = 1024 * 1024;
export const PACK_RANGE_SLICE_BYTES = 256 * 1024;
export const PACK_RANGE_BATCH_BYTES = 1024 * 1024;
export const PACK_DELTA_OBJECT_WRAPPER_BYTES = 256;

export function checkedPackBytes(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw new GitError("E2BIG", `packed object ${label} byte count overflow`);
  }
  return left + right;
}

export function isPackGraphLimit(error: unknown): error is GitError {
  return (
    error instanceof GitError &&
    error.code === "E2BIG" &&
    error.message === "packed blob dependency graph exceeds the bounded entry limit"
  );
}

export function pushExactInflate(stream: InflateInto, input: Uint8Array, label: string): number {
  try {
    return stream.push(input);
  } catch (error) {
    if (error instanceof InflateSizeError) {
      throw new CorruptError(`${label} exceeds its indexed size`, { cause: error });
    }
    throw error;
  }
}

export function isObjectType(value: string): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

export function validatePackReadInputs(
  oids: readonly string[],
  expectedType: ObjectType | null,
): void {
  if (oids.length > MAX_PACK_BLOB_INPUTS) {
    throw new GitError("E2BIG", `blob batch exceeds ${MAX_PACK_BLOB_INPUTS} packed inputs`);
  }
  if (expectedType !== null && !isObjectType(expectedType)) {
    throw new GitError("EINVAL", "packed object read type is invalid");
  }
  for (const oid of oids) {
    if (typeof oid !== "string" || !isOid(oid)) {
      throw new GitError("EINVAL", "packed object read contains an invalid object id");
    }
  }
}

export function packRangeFragment(
  request: PackRangeRequest,
  position: number,
  length: number,
): number {
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

export function packRangeFragmentMask(request: PackRangeRequest): number {
  let current = request.position;
  let fragments = 0;
  const end = request.position + request.length;
  while (current < end) {
    current += Math.min(end - current, PACK_RANGE_SLICE_BYTES, PACK_CHUNK - (current % PACK_CHUNK));
    fragments++;
  }
  return 2 ** fragments - 1;
}

export class FlatByteSource implements ByteSource {
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

export function hashByteSource(type: ObjectType, source: ByteSource): string {
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

export interface PackObjectRow {
  pack_id: number;
  offset: number;
  data_off: number;
  data_len: number;
  type: ObjectType;
  size: number;
  entry_size: number;
  base_oid: string | null;
}

export interface PackIngestControl {
  ownerGeneration: number;
  lastPackId: number;
  activePackId: number | null;
  expiresMs: number | null;
}

export interface PackIngestLease {
  generation: number;
  packId: number;
  expiresMs: number;
}

const PACK_MEMBERSHIP_ENCODER = new TextEncoder();

export function packMembershipDigest(row: PackObjectInput): Uint8Array {
  return new Sha1().update(PACK_MEMBERSHIP_ENCODER.encode(JSON.stringify(row))).digest();
}

export function validatePackMembershipCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PACK_INGEST_OBJECTS) {
    throw new GitError("E2BIG", `pack exceeds ${MAX_PACK_INGEST_OBJECTS} objects`);
  }
}

export interface PackByteMembership {
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

export function packByteMembershipDigest(row: PackByteMembership): Uint8Array {
  return new Sha1().update(PACK_MEMBERSHIP_ENCODER.encode(JSON.stringify(row))).digest();
}

export class ExpectedPackMembership {
  readonly #offsets: Float64Array;
  readonly #digests: Uint8Array;
  readonly #byteDigests: Uint8Array;
  readonly #completed: Uint8Array;
  #offsetCount = 0;

  constructor(readonly count: number) {
    validatePackMembershipCount(count);
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

export interface AuthenticatedPackSource {
  oid: string;
  type: ObjectType;
  size: number;
  packId: number;
  dataOff: number;
  dataLen: number;
  entrySize: number;
  baseOid: string | null;
}

export function requirePackId(packId: number): void {
  if (!Number.isSafeInteger(packId) || packId < 0) {
    throw new RangeError("pack id must be a non-negative safe integer");
  }
}

export function requireIngestTime(now: () => number): number {
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

export function requireIngestControl(
  row: Record<string, unknown>,
  repoId: number,
): PackIngestControl {
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

export function uniquePackIds(packIds: readonly number[], limit: number): number[] {
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

export function requireLifecycleResult(result: unknown, hook: string): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw new Error(`pack lifecycle ${hook} hook must return undefined`);
}

export type ExternalBatchResolver = (oids: readonly string[]) => Map<string, RawObject>;
export interface ExternalObjectMetadata {
  type: ObjectType;
  size: number;
}
export type ExternalMetadataResolver = (
  oids: readonly string[],
) => Map<string, ExternalObjectMetadata>;

export interface CompressedEntry {
  bytes: Uint8Array;
  filled: number;
}

export interface PackGraphOrigin {
  readonly rootOid: string;
  depth: number;
  readonly checkpoints: Set<string>;
}

export interface PackGraphPage {
  readonly roots: readonly string[];
  readonly entryLimit: number;
}

export interface PackGraphExit {
  readonly oid: string | null;
  readonly distance: number;
}

export interface PackRangeRequest {
  ordinal: number;
  offset: number;
  position: number;
  length: number;
}

export interface PackIngestMemory {
  pool: ChunkPool;
}

export interface IngestBase {
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
export function validateDeltaWorkingSet(
  base: Uint8Array,
  delta: Uint8Array,
  expectedTargetSize: number,
): number {
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
  if (targetSize !== expectedTargetSize) throw new CorruptError("delta target size mismatch");
  const workingBytes = base.length + delta.length + targetSize + PACK_DELTA_OBJECT_WRAPPER_BYTES;
  if (!Number.isSafeInteger(workingBytes) || workingBytes > MAX_PACK_DELTA_WORKING_BYTES) {
    throw new CorruptError("delta working set exceeds 48 MiB");
  }
  return targetSize;
}

export function checkDeltaInflateBudget(base: Uint8Array, deltaSize: number): void {
  if (
    !Number.isSafeInteger(deltaSize) ||
    deltaSize < 0 ||
    base.length + deltaSize > MAX_PACK_DELTA_WORKING_BYTES
  ) {
    throw new CorruptError("delta input exceeds the bounded working set");
  }
}

export class DeltaHeaderProbe {
  #value = 0;
  #shift = 0;
  #field = 0;
  #sourceSize: number | null = null;
  #targetSize: number | null = null;

  get complete(): boolean {
    return this.#targetSize !== null;
  }

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
