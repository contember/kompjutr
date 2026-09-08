import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import { MAX_OBJECT_BYTES, type ObjectType, type RawObject } from "../../common/objects.js";
import { deflate } from "../../common/zlib.js";
import type { PackStore } from "../pack/packs.js";
import type { Clock } from "../refs/reflog.js";
import type { CommitCacheEntry, CommitCacheWriteResult } from "../trees/commits.js";

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

export interface ObjectDatabaseContext {
  readonly db: SqlDatabase;
  readonly repoId: number;
}

export interface ObjectQueryContext extends ObjectDatabaseContext {
  readonly packs: PackStore;
  readonly cacheKeys: ObjectCacheKeys;
}

export interface ObjectReadContext extends ObjectQueryContext {
  readonly objects: ByteLru<string, RawObject>;
}

export interface ObjectClockContext {
  readonly clock: Clock;
}

export interface ObjectBatchContext extends ObjectDatabaseContext, ObjectClockContext {
  readonly cacheKeys: ObjectCacheKeys;
}

export interface ObjectWriteContext extends ObjectReadContext, ObjectClockContext {}

export function requireStorableObjectSize(type: ObjectType, size: number): void {
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

export function nowMilliseconds(context: ObjectClockContext): number {
  const now = context.clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new GitError("EINVAL", "Git store clock must return non-negative integer milliseconds");
  }
  return now;
}
