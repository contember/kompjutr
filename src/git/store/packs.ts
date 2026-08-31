// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.
//
// Pack-native object storage. A received packfile is written to SQLite
// verbatim, still compressed, in fixed-size chunk rows, and indexed
// (oid -> pack, offset, delta base). Reads pull only the chunks an object
// actually spans, so nothing ever inflates a whole repository.

import type { SqlDatabase } from "../../db/db.js";
import type { ByteLru } from "../common/lru.js";
import type { ObjectType, RawObject } from "../common/objects.js";
import { PackIngestEngine } from "./pack/ingest.js";
import { PackLifecycle } from "./pack/lifecycle.js";
import { PackReadEngine } from "./pack/read.js";
import {
  type CompletePackedEntry,
  type CompletePackObject,
  DEFAULT_CACHE_ENTRY_LIMIT,
  DEFAULT_MAX_BUFFERED_ENTRY,
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  MAX_DELTA_DEPTH,
  MAX_PACK_BLOB_GRAPH_ENTRIES,
  type PackCacheOptions,
  type PackedEntry,
  type PackIngestOptions,
  type PackIngestResult,
  type PackSharedState,
} from "./pack/shared.js";

export type {
  CompletePackedEntry,
  CompletePackObject,
  ExternalBatchResolver,
  ExternalMetadataResolver,
  ExternalObjectMetadata,
  PackCacheOptions,
  PackedEntry,
  PackIngestLifecycle,
  PackIngestOptions,
  PackIngestResult,
} from "./pack/shared.js";
export {
  MAX_DELTA_DEPTH,
  MAX_PACK_DELETE_BATCH,
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_MEMBERSHIP_OBJECTS,
  MAX_PACK_ROW_CACHE_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_CHUNK,
  PACK_DELTA_OBJECT_WRAPPER_BYTES,
  PACK_INGEST_LEASE_MS,
} from "./pack/shared.js";

export class PackStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #read: PackReadEngine;
  readonly #lifecycle: PackLifecycle;
  readonly #ingest: PackIngestEngine;
  readonly #now: () => number;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    chunks: ByteLru<string, Uint8Array>,
    cacheNamespace: string,
    externalBatch: ExternalBatchResolver,
    externalMetadata: ExternalMetadataResolver,
    options: PackCacheOptions = {},
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#now = options.now ?? Date.now;
    const maxBufferedEntry = Math.min(
      options.maxBufferedEntry ?? DEFAULT_MAX_BUFFERED_ENTRY,
      DEFAULT_MAX_BUFFERED_ENTRY,
    );
    const cacheEntryLimit = Math.min(
      options.cacheEntryLimit ?? DEFAULT_CACHE_ENTRY_LIMIT,
      DEFAULT_CACHE_ENTRY_LIMIT,
    );
    const maxDeltaDepth = options.maxDeltaDepth ?? MAX_DELTA_DEPTH;
    if (!Number.isFinite(maxDeltaDepth) || !Number.isInteger(maxDeltaDepth) || maxDeltaDepth < 0) {
      throw new RangeError("maxDeltaDepth must be a finite non-negative integer");
    }
    const boundedMaxDeltaDepth = Math.min(maxDeltaDepth, MAX_DELTA_DEPTH);
    const graphPageEntries = options.graphPageEntries ?? MAX_PACK_BLOB_GRAPH_ENTRIES;
    if (
      !Number.isFinite(graphPageEntries) ||
      !Number.isInteger(graphPageEntries) ||
      graphPageEntries < 1
    ) {
      throw new RangeError("graphPageEntries must be a finite positive integer");
    }
    const boundedGraphPageEntries = Math.min(graphPageEntries, MAX_PACK_BLOB_GRAPH_ENTRIES);
    const sharedState: PackSharedState = {
      cacheGeneration: 0,
      activePending: new Set<number>(),
    };
    this.#read = new PackReadEngine(
      db,
      repoId,
      objects,
      chunks,
      cacheNamespace,
      externalBatch,
      externalMetadata,
      sharedState,
      cacheEntryLimit,
      boundedMaxDeltaDepth,
      boundedGraphPageEntries,
    );
    this.#lifecycle = new PackLifecycle(db, repoId, sharedState, this.#now);
    this.#ingest = new PackIngestEngine(
      db,
      repoId,
      objects,
      externalBatch,
      externalMetadata,
      this.#read,
      this.#lifecycle,
      sharedState,
      this.#now,
      maxBufferedEntry,
      cacheEntryLimit,
    );
  }

  /** Bytes the chunk cache currently holds. */
  get cachedChunkBytes(): number {
    return this.#read.cachedChunkBytes;
  }

  lookup(oid: string): PackedEntry | null {
    return this.#read.lookup(oid);
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.#read.typeAndSize(oid);
  }

  count(): number {
    return this.#read.count();
  }

  findPrefix(prefix: string, limit: number): string[] {
    return this.#read.findPrefix(prefix, limit);
  }

  /** Every oid the pack index holds, in index order. */
  oids(): string[] {
    return this.#read.oids();
  }

  read(oid: string): RawObject | null {
    return this.#read.read(oid);
  }

  readBlobs(oids: readonly string[]): Map<string, Uint8Array> {
    return this.#read.readBlobs(oids);
  }

  readObjects(
    oids: readonly string[],
    expectedType: ObjectType | null = null,
  ): Map<string, RawObject> {
    return this.#read.readObjects(oids, expectedType);
  }

  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#read.readAuthenticatedObject(oid, expectedType);
  }

  authenticateCompleteSources(
    objects: readonly { oid: string; type: ObjectType; size: number; packId: number }[],
  ): void {
    this.#read.authenticateCompleteSources(objects);
  }

  readRaw(packId: number, offset: number, length: number): Uint8Array {
    return this.#read.readRaw(packId, offset, length);
  }

  clearCaches(): void {
    this.#read.clearCaches();
  }

  /** Drop only unowned or expired ordinary packs. */
  reclaimPending(now: () => number = this.#now): number {
    return this.#lifecycle.reclaimPending(now);
  }

  /** Delete exactly one pending pack after its owner releases the durable reference. */
  discardPending(packId: number, releaseOwnership?: (packId: number) => unknown): boolean {
    return this.#lifecycle.discardPending(packId, releaseOwnership);
  }

  /** Release and delete exactly one complete pack owned by a durable maintenance batch. */
  discardOwnedComplete(packId: number, releaseOwnership: (packId: number) => unknown): boolean {
    return this.#lifecycle.discardOwnedComplete(packId, releaseOwnership);
  }

  /** Verify that one complete pack contains exactly the requested object metadata. */
  completePackMatches(packId: number, objects: readonly CompletePackObject[]): boolean {
    return this.#lifecycle.completePackMatches(packId, objects);
  }

  /** Read packed metadata directly, ignoring any loose object that shadows it. */
  completePackedEntry(oid: string): CompletePackedEntry | null {
    return this.#lifecycle.completePackedEntry(oid);
  }

  /** Delete a bounded set of complete packs; absent ids make retries idempotent. */
  deleteCompletePacks(packIds: readonly number[]): number {
    return this.#lifecycle.deleteCompletePacks(packIds);
  }

  async ingest(
    source: AsyncIterable<Uint8Array>,
    options: PackIngestOptions = {},
  ): Promise<PackIngestResult> {
    const lifecycle = options.lifecycle;
    return this.#ingest.ingest(source, {
      ...options,
      lifecycle: {
        reserved(packId) {
          return lifecycle?.reserved(packId);
        },
        published: (result) => {
          this.#db.run(
            `DELETE FROM git_promised_blobs
              WHERE repo_id = ? AND oid IN (
                SELECT oid FROM git_pack_entries WHERE repo_id = ? AND pack_id = ?
              )`,
            this.#repoId,
            this.#repoId,
            result.packId,
          );
          return lifecycle?.published(result);
        },
      },
    });
  }
}
