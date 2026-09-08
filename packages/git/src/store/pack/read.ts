// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import { hashObject, type ObjectType, type RawObject } from "../../common/objects.js";
import { PackSourceAuthenticator } from "./read/read-authenticate.js";
import { PackDataReader } from "./read/read-data.js";
import { PackObjectResolver } from "./read/read-resolver.js";
import {
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type PackedEntry,
  type PackObjectRow,
  type PackRangeRequest,
  type PackSharedState,
  validatePackReadInputs,
} from "./shared.js";

export class PackReadEngine {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #data: PackDataReader;
  readonly #resolver: PackObjectResolver;
  readonly #authenticator: PackSourceAuthenticator;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    chunks: ByteLru<string, Uint8Array>,
    cacheNamespace: string,
    externalBatch: ExternalBatchResolver,
    externalMetadata: ExternalMetadataResolver,
    sharedState: PackSharedState,
    cacheEntryLimit: number,
    maxDeltaDepth: number,
    graphPageEntries: number,
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#data = new PackDataReader(
      db,
      repoId,
      objects,
      chunks,
      cacheNamespace,
      sharedState,
      cacheEntryLimit,
    );
    this.#resolver = new PackObjectResolver(
      db,
      repoId,
      externalBatch,
      externalMetadata,
      objects,
      this.#data,
      maxDeltaDepth,
      graphPageEntries,
    );
    this.#authenticator = new PackSourceAuthenticator(db, repoId, this.#resolver, this.#data);
  }

  /** Bytes the chunk cache currently holds. */
  get cachedChunkBytes(): number {
    return this.#data.cachedChunkBytes;
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

  read(oid: string): RawObject | null {
    validatePackReadInputs([oid], null);
    return this.readObjectsBounded([oid], null, null, true, new Map(), false).get(oid) ?? null;
  }

  /** Resolve packed blobs with one graph query and one physical chunk cursor. */
  readBlobs(oids: readonly string[]): Map<string, Uint8Array> {
    validatePackReadInputs(oids, "blob");
    const objects = this.readObjectsBounded(oids, null, "blob", false, new Map(), false);
    const blobs = new Map<string, Uint8Array>();
    for (const [oid, object] of objects) {
      if (object.type !== "blob") {
        throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
      }
      blobs.set(oid, object.data);
    }
    return blobs;
  }

  readObjects(
    oids: readonly string[],
    expectedType: ObjectType | null = null,
  ): Map<string, RawObject> {
    validatePackReadInputs(oids, expectedType);
    return this.readObjectsBounded(oids, null, expectedType, false, new Map(), false);
  }

  /** Cold-read and hash one canonical object from a complete pack. */
  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    validatePackReadInputs([oid], expectedType);
    const object = this.readObjectsBounded([oid], null, expectedType, true, new Map(), true).get(
      oid,
    );
    if (object === undefined) return null;
    if (hashObject(object.type, object.data) !== oid) {
      throw new CorruptError(`packed ${expectedType} ${oid} does not match its bytes`);
    }
    return object;
  }

  authenticateCompleteSources(
    objects: readonly { oid: string; type: ObjectType; size: number; packId: number }[],
  ): void {
    this.#authenticator.authenticateCompleteSources(objects);
  }

  readObjectsBounded(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject>,
    bypassCache: boolean,
  ): Map<string, RawObject> {
    return this.#resolver.readObjectsBounded(
      oids,
      pendingPackId,
      expectedType,
      allowMissing,
      seeds,
      bypassCache,
    );
  }

  cacheObject(packId: number, oid: string, object: RawObject): void {
    this.#data.cacheObject(packId, oid, object);
  }

  objectCacheKey(packId: number, oid: string): string {
    return this.#data.objectCacheKey(packId, oid);
  }

  readRangeBatch(packId: number, requests: readonly PackRangeRequest[]): Map<number, Uint8Array> {
    return this.#data.readRangeBatch(packId, requests);
  }

  readRaw(packId: number, offset: number, length: number): Uint8Array {
    return this.#data.readRaw(packId, offset, length);
  }

  clearCaches(): void {
    this.#data.clearCaches();
  }
}
