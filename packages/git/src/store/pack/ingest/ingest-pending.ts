// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { ByteLru } from "../../../common/lru.js";
import type { ObjectType, RawObject } from "../../../common/objects.js";
import type { ChunkedBytes } from "../chunks.js";
import {
  PACK_PENDING_PAGE_ROWS,
  type PackCommitIndex,
  type PackObjectBatch,
  type PackObjectInput,
  type PackTreeIndex,
  type PendingRow,
  validatePendingRow,
} from "../pack-ingest-index.js";
import type { PackReadEngine } from "../read.js";
import {
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type ExternalObjectMetadata,
  FlatByteSource,
  hashByteSource,
  type IngestBase,
  isObjectType,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_RANGE_BATCH_BYTES,
  type PackIngestMemory,
  type PackRangeRequest,
} from "../shared.js";
import type { PackIngestInflater } from "./ingest-inflate.js";
import { throwIfIngestAborted } from "./ingest-options.js";
import type { PackResolvedProjection } from "./ingest-projection.js";
import type { OffsetWindow } from "./ingest-reader.js";

export class PackPendingResolver {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly externalBatch: ExternalBatchResolver,
    private readonly externalMetadata: ExternalMetadataResolver,
    private readonly objects: ByteLru<string, RawObject>,
    private readonly read: PackReadEngine,
    private readonly cacheEntryLimit: number,
    private readonly inflater: PackIngestInflater,
    private readonly projection: PackResolvedProjection,
  ) {}
  async drainPending(
    packId: number,
    offsets: OffsetWindow,
    objectIndex: PackObjectBatch,
    treeIndex: PackTreeIndex,
    commitIndex: PackCommitIndex,
    yieldNow: () => Promise<void>,
    heartbeat: () => void,
    memory: PackIngestMemory,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let remaining =
      this.db.scalar<number>(
        "SELECT COUNT(*) FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?",
        this.repoId,
        packId,
      ) ?? 0;
    while (remaining > 0) {
      throwIfIngestAborted(signal);
      let progressed = 0;
      let after = -1;
      for (;;) {
        const page = this.db.all<PendingRow>(
          `SELECT pending.offset, pending.data_off, pending.data_len, pending.entry_size,
                   pending.base_oid, pending.base_offset,
                   COALESCE(pending.base_oid, base.oid) AS resolved_oid
             FROM git_pack_pending pending
             LEFT JOIN git_pack_entries base
                ON base.repo_id = pending.repo_id AND base.pack_id = pending.pack_id
               AND base.offset = pending.base_offset
             WHERE pending.repo_id = ? AND pending.pack_id = ? AND pending.offset > ?
             ORDER BY pending.offset LIMIT ${PACK_PENDING_PAGE_ROWS}`,
          this.repoId,
          packId,
          after,
        );
        if (page.length === 0) break;
        for (const row of page) validatePendingRow(row);
        throwIfIngestAborted(signal);
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
        const allPackedMetadata = this.#packedBaseMetadata(baseOids, packId);
        const externalOids = baseOids.filter((oid) => !allPackedMetadata.has(oid));
        const allExternalMetadata = this.externalMetadata(externalOids);
        const admittedOids = this.#selectBaseGroup(
          baseOids,
          allPackedMetadata,
          allExternalMetadata,
        );
        const packedMetadata = new Map<string, ExternalObjectMetadata>();
        const externalMetadata = new Map<string, ExternalObjectMetadata>();
        for (const oid of admittedOids) {
          const packed = allPackedMetadata.get(oid);
          const external = allExternalMetadata.get(oid);
          if (packed !== undefined) packedMetadata.set(oid, packed);
          else if (external !== undefined) externalMetadata.set(oid, external);
        }
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
        for (const [oid, object] of this.externalBatch([...externalMetadata.keys()])) {
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
        materialized.clear();
        let retainedBaseBytes = 0;
        for (const object of bases.values()) retainedBaseBytes += object.source.length;
        if (
          !Number.isSafeInteger(retainedBaseBytes) ||
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
          const requests: PackRangeRequest[] = [];
          for (const row of page) {
            requests.push({
              ordinal: requests.length,
              offset: row.offset,
              position: row.data_off,
              length: row.data_len,
            });
          }
          compressedBatch = this.read.readRangeBatch(packId, requests);
        } else {
          compressedBatchBytes = 0;
        }
        try {
          for (let cursor = 0; cursor < ready.length; cursor++) {
            throwIfIngestAborted(signal);
            const { row, baseOid } = ready[cursor]!;
            const base = bases.get(baseOid);
            if (base === undefined) continue;
            const compressed = compressedBatch.get(row.offset) ?? null;
            const uses = (remainingUses.get(baseOid) ?? 1) - 1;
            remainingUses.set(baseOid, uses);
            const target = this.inflater.applyStoredDelta(
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
              if (base.owned !== null) {
                base.owned.release();
              }
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
              this.projection.insertResolved(
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
              );
              completed.push(row.offset);
              offsets.set(row.offset, oid);
              if (offsetChildren.length > 0) {
                remainingUses.set(oid, (remainingUses.get(oid) ?? 0) + offsetChildren.length);
              }
              if (hasChildren && !bases.has(oid)) {
                const nextBaseBytes = retainedBaseBytes + target.length;
                if (
                  Number.isSafeInteger(nextBaseBytes) &&
                  (retainedBaseBytes === 0 || nextBaseBytes <= PACK_BLOB_BATCH_TARGET_BYTES)
                ) {
                  bases.set(oid, { type: base.type, source: target, owned: target });
                  retainedBaseBytes = nextBaseBytes;
                  retainedTarget = true;
                }
              }
              if (retainedTarget) {
                for (const child of oidChildren) enqueue(child, oid);
                for (const child of offsetChildren) enqueue(child, oid);
              }
              if (target.length <= this.cacheEntryLimit) {
                this.#cacheChunked(packId, oid, base.type, target);
              }
              progressed++;
            } finally {
              if (!retainedTarget) target.release();
            }
          }
        } finally {
          for (const base of bases.values()) base.owned?.release();
          bases.clear();
        }
        if (completed.length > 0) {
          objectIndex.flush();
          this.db.run(
            "DELETE FROM git_pack_pending WHERE repo_id = ? AND pack_id = ? AND offset IN (SELECT value FROM json_each(?))",
            this.repoId,
            packId,
            JSON.stringify(completed),
          );
        }
        memory.pool.assertIdle();
        memory.pool.dispose();
        await yieldNow();
        throwIfIngestAborted(signal);
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
    for (const row of this.db.all<{ oid: string; type: string; size: number }>(
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
      this.repoId,
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

  #selectBaseGroup(
    oids: readonly string[],
    packed: ReadonlyMap<string, ExternalObjectMetadata>,
    external: ReadonlyMap<string, ExternalObjectMetadata>,
  ): string[] {
    const group: string[] = [];
    let bytes = 0;
    for (const oid of oids) {
      const metadata = packed.get(oid) ?? external.get(oid);
      if (metadata === undefined) continue;
      if (group.length > 0 && metadata.size > PACK_BLOB_BATCH_TARGET_BYTES - bytes) break;
      group.push(oid);
      bytes += metadata.size;
      if (!Number.isSafeInteger(bytes)) {
        throw new CorruptError("pack ingest base group size is not representable");
      }
      if (bytes > PACK_BLOB_BATCH_TARGET_BYTES) break;
    }
    return group;
  }

  #readBaseBatch(oids: readonly string[], packId: number): Map<string, RawObject> {
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    const result = new Map<string, RawObject>();
    const uncached: string[] = [];
    for (const oid of wanted) {
      const cached = this.objects.get(this.read.objectCacheKey(packId, oid));
      if (cached === undefined) uncached.push(oid);
      else {
        result.set(oid, cached);
      }
    }
    if (result.size === 0) {
      return this.read.readObjectsBounded(uncached, packId, null, true, new Map(), false);
    }
    if (uncached.length === 0) return result;
    const parts = this.read.readObjectsBounded(uncached, packId, null, true, new Map(), false);
    for (const [oid, object] of parts) result.set(oid, object);
    return result;
  }

  #cacheChunked(packId: number, oid: string, type: ObjectType, target: ChunkedBytes): void {
    this.read.cacheObject(packId, oid, { type, data: target.toUint8Array() });
  }
}
