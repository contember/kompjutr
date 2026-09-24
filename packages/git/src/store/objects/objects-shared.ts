import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import { MAX_OBJECT_BYTES, type ObjectType, type RawObject } from "../../common/objects.js";
import type { PackStore } from "../pack/packs.js";
import type { CommitCacheEntry, CommitCacheWriteResult } from "../trees/commits.js";

/** Bytes per `git_object_chunks` row. */
export const OBJECT_CHUNK = 1024 * 1024;

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

/** Commit source bytes staged beside encoded object bytes before a batch flush. */
export const COMMIT_STAGE_SOURCE_BYTES = 8 * 1024 * 1024;

/** One object staged in a batch, already hashed and encoded for storage. */
export interface StagedObject {
  oid: string;
  type: ObjectType;
  size: number;
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

export interface ObjectBatchContext extends ObjectDatabaseContext {
  readonly cacheKeys: ObjectCacheKeys;
}

export type ObjectWriteContext = ObjectReadContext;

export function requireStorableObjectSize(type: ObjectType, size: number): void {
  if (size > MAX_OBJECT_BYTES) {
    throw new GitError(
      "E2BIG",
      `${type} object of ${size} bytes exceeds the ${MAX_OBJECT_BYTES}-byte object limit`,
    );
  }
}

export function requireCommitCacheWrites(result: CommitCacheWriteResult, expected: number): void {
  if (result.written !== expected) {
    throw new CorruptError(`commit cache wrote ${result.written} of ${expected} required rows`);
  }
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

export function isObjectType(value: string | null): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}
