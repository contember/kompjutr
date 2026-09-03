// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import { hashObject, MAX_OBJECT_BYTES, NUMBER_TYPE, type RawObject } from "../../common/objects.js";
import {
  PackCommitIndex,
  PackObjectBatch,
  type PackObjectInput,
  PackPendingBatch,
  PackTreeIndex,
} from "../pack-ingest-index.js";
import type { ChunkedBytes } from "./chunks.js";
import { PackIngestInflater } from "./ingest-inflate.js";
import { throwIfIngestAborted } from "./ingest-options.js";
import { PackPendingResolver } from "./ingest-pending.js";
import { PackResolvedProjection } from "./ingest-projection.js";
import { OffsetWindow, PackReader } from "./ingest-reader.js";
import type { PackReadEngine } from "./read.js";
import {
  ExpectedPackMembership,
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  hashByteSource,
  type PackIngestMemory,
} from "./shared.js";

export class PackIndexer {
  readonly #inflater: PackIngestInflater;
  readonly #projection: PackResolvedProjection;
  readonly #pending: PackPendingResolver;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly objects: ByteLru<string, RawObject>,
    externalBatch: ExternalBatchResolver,
    externalMetadata: ExternalMetadataResolver,
    private readonly read: PackReadEngine,
    maxBufferedEntry: number,
    private readonly cacheEntryLimit: number,
  ) {
    this.#inflater = new PackIngestInflater(read, maxBufferedEntry);
    this.#projection = new PackResolvedProjection(repoId, read);
    this.#pending = new PackPendingResolver(
      db,
      repoId,
      externalBatch,
      externalMetadata,
      objects,
      read,
      cacheEntryLimit,
      this.#inflater,
      this.#projection,
    );
  }
  /** Phase B + C: index every entry, then drain the deferred deltas. */
  async indexPack(
    packId: number,
    total: number,
    say: (message: string) => void,
    yieldNow: () => Promise<void>,
    heartbeat: () => void,
    memory: PackIngestMemory,
    signal: AbortSignal | undefined,
  ): Promise<{
    count: number;
    commits: PackCommitIndex;
    membership: ExpectedPackMembership;
  }> {
    const reader = new PackReader(
      (offset, length) => this.read.readRaw(packId, offset, length),
      packId,
      total,
    );
    throwIfIngestAborted(signal);
    const magic = reader.take(4);
    if (magic[0] !== 0x50 || magic[1] !== 0x41 || magic[2] !== 0x43 || magic[3] !== 0x4b) {
      throw new CorruptError("bad pack signature");
    }
    const version = reader.uint32();
    const count = reader.uint32();
    if (version !== 2 && version !== 3)
      throw new CorruptError(`unsupported pack version ${version}`);
    const membership = new ExpectedPackMembership(count);

    const offsets = new OffsetWindow();
    const objectIndex = new PackObjectBatch(this.db, this.repoId, (row) => membership.record(row));
    const pendingIndex = new PackPendingBatch(this.db, this.repoId, packId);
    const treeIndex = new PackTreeIndex(this.db);
    const commitIndex = new PackCommitIndex(this.db, this.repoId, packId, objectIndex);
    const missingBases = new Set<string>();
    const offsetToOid = (offset: number): string | null => {
      return offsets.get(offset);
    };

    let deferred = 0;
    for (let i = 0; i < count; i++) {
      throwIfIngestAborted(signal);
      const header = reader.entryHeader();
      if (header.kind === null && header.entrySize > MAX_OBJECT_BYTES) {
        throw new GitError(
          "E2BIG",
          `pack entry at ${header.offset} is ${header.entrySize} bytes, above the ${MAX_OBJECT_BYTES}-byte object limit`,
        );
      }
      membership.addOffset(i, header.offset);
      const entryType = header.kind === null ? NUMBER_TYPE[header.type]! : null;
      const entry = this.#inflater.inflateAt(reader, header.dataOff, header.entrySize, entryType);
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
        this.#projection.insertResolved(
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
        );
        offsets.set(header.offset, oid);
        missingBases.delete(oid);
        if (entry.data !== null) this.read.cacheObject(packId, oid, { type, data: entry.data });
      } else {
        const baseOid =
          header.kind === "ref" ? header.baseOid! : offsetToOid(header.offset - header.baseDelta!);
        let resolved = false;
        if (entry.data !== null && baseOid !== null) {
          const base = missingBases.has(baseOid)
            ? undefined
            : this.objects.get(this.read.objectCacheKey(packId, baseOid));
          if (base === undefined) missingBases.add(baseOid);
          if (base !== undefined) {
            const target = this.#inflater.applyDeltaBytes(base.data, entry.data, memory.pool);
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
              this.#projection.insertResolved(
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
              );
              offsets.set(header.offset, oid);
              missingBases.delete(oid);
              if (target.length <= this.cacheEntryLimit) {
                this.#cacheChunked(packId, oid, base.type, target);
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
      }

      if ((i & 1023) === 1023) {
        objectIndex.flush();
        pendingIndex.flush();
        memory.pool.assertIdle();
        await yieldNow();
        throwIfIngestAborted(signal);
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
    if (deferred > 0) this.read.clearCaches();
    await this.#pending.drainPending(
      packId,
      offsets,
      objectIndex,
      treeIndex,
      commitIndex,
      yieldNow,
      heartbeat,
      memory,
      signal,
    );
    heartbeat();
    objectIndex.flush();
    treeIndex.flush();
    if (deferred > 0) say(`Resolved ${deferred} deferred delta(s)\n`);
    membership.assertComplete();
    return { count, commits: commitIndex, membership };
  }
  #cacheChunked(packId: number, oid: string, type: RawObject["type"], target: ChunkedBytes): void {
    this.read.cacheObject(packId, oid, { type, data: target.toUint8Array() });
  }
}
