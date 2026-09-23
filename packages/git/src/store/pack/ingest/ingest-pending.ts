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
  FlatByteSource,
  hashByteSource,
  type IngestBase,
  isObjectType,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_RANGE_BATCH_BYTES,
  type PackBaseMetadata,
  type PackIngestMemory,
  type PackRangeRequest,
} from "../shared.js";
import type { PackIngestInflater } from "./ingest-inflate.js";
import { throwIfIngestAborted } from "./ingest-options.js";
import type { PackResolvedProjection } from "./ingest-projection.js";

/**
 * Deferred deltas name their base by offset, or by OID for a ref-delta, and the
 * base must be an entry of the same pack. A ref-delta is stored with the
 * offset of the in-pack entry it resolved against; a base outside the pack
 * never resolves, so a thin pack fails here.
 */
const PENDING_PAGE_SQL = `SELECT pending.offset, pending.data_off, pending.data_len,
         pending.entry_size, pending.base_oid, pending.base_offset,
         base.offset AS resolved_offset, base.oid AS resolved_oid
    FROM git_pack_pending pending
    LEFT JOIN git_pack_entries base
      ON base.repo_id = pending.repo_id AND base.pack_id = pending.pack_id
     AND base.offset = coalesce(pending.base_offset, (
       SELECT min(named.offset) FROM git_pack_entries named
        WHERE named.repo_id = pending.repo_id AND named.oid = pending.base_oid
          AND named.pack_id = pending.pack_id
     ))
   WHERE pending.repo_id = ? AND pending.pack_id = ? AND pending.offset > ?
   ORDER BY pending.offset LIMIT ${PACK_PENDING_PAGE_ROWS}`;

interface ReadyDelta {
  row: PendingRow;
  baseOid: string;
  baseOffset: number;
}

function push<K>(map: Map<K, PendingRow[]>, key: K, row: PendingRow): void {
  const children = map.get(key);
  if (children === undefined) map.set(key, [row]);
  else children.push(row);
}

export class PackPendingResolver {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly objects: ByteLru<string, RawObject>,
    private readonly read: PackReadEngine,
    private readonly cacheEntryLimit: number,
    private readonly inflater: PackIngestInflater,
    private readonly projection: PackResolvedProjection,
  ) {}
  async drainPending(
    packId: number,
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
        const page = this.db.all<PendingRow>(PENDING_PAGE_SQL, this.repoId, packId, after);
        if (page.length === 0) break;
        for (const row of page) validatePendingRow(row);
        throwIfIngestAborted(signal);
        const last = page[page.length - 1]!;
        after = last.offset;

        const byBaseOffset = new Map<number, PendingRow[]>();
        const byBaseOid = new Map<string, PendingRow[]>();
        const indexedBases = new Map<number, string>();
        for (const row of page) {
          const baseOffset = row.resolved_offset ?? row.base_offset;
          if (baseOffset === null) {
            push(byBaseOid, row.base_oid!, row);
            continue;
          }
          push(byBaseOffset, baseOffset, row);
          if (row.resolved_oid !== null) indexedBases.set(baseOffset, row.resolved_oid);
        }
        const baseOids = [...new Set(indexedBases.values())];
        const allMetadata = this.#packedBaseMetadata([...indexedBases.keys()], packId);
        const admittedOids = this.#selectBaseGroup(baseOids, allMetadata);
        const metadata = new Map<string, PackBaseMetadata>();
        for (const oid of admittedOids) metadata.set(oid, allMetadata.get(oid)!);
        const materialized = this.#readBaseBatch([...metadata.keys()], packId);
        const bases = new Map<string, IngestBase>();
        for (const [oid, object] of materialized) {
          const admitted = metadata.get(oid);
          if (
            admitted === undefined ||
            admitted.type !== object.type ||
            admitted.size !== object.data.length
          ) {
            throw new CorruptError("materialized pack base disagrees with its admitted metadata");
          }
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
        for (const [offset, oid] of indexedBases) {
          remainingUses.set(
            oid,
            (remainingUses.get(oid) ?? 0) + (byBaseOffset.get(offset)?.length ?? 0),
          );
        }

        const ready: ReadyDelta[] = [];
        const queued = new Set<number>();
        const enqueue = (row: PendingRow, baseOid: string, baseOffset: number): void => {
          if (queued.has(row.offset)) return;
          queued.add(row.offset);
          ready.push({ row, baseOid, baseOffset });
        };
        for (const [offset, oid] of indexedBases) {
          if (!bases.has(oid)) continue;
          for (const row of byBaseOffset.get(offset) ?? []) enqueue(row, oid, offset);
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
        }
        try {
          for (let cursor = 0; cursor < ready.length; cursor++) {
            throwIfIngestAborted(signal);
            const { row, baseOid, baseOffset } = ready[cursor]!;
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
              const children = [
                ...(byBaseOffset.get(row.offset) ?? []),
                ...(byBaseOid.get(oid) ?? []),
              ];
              const objectRow: PackObjectInput = [
                oid,
                packId,
                row.offset,
                row.data_off,
                row.data_len,
                base.type,
                target.length,
                row.entry_size,
                baseOffset,
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
              if (children.length > 0) {
                remainingUses.set(oid, (remainingUses.get(oid) ?? 0) + children.length);
              }
              if (children.length > 0 && !bases.has(oid)) {
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
                for (const child of children) enqueue(child, oid, row.offset);
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
        throw new CorruptError(
          `cannot resolve ${remaining} delta object(s): missing base in the pack`,
        );
      }
    }
  }

  /** Base metadata from this pack's own entries; another pack's copy may vanish meanwhile. */
  #packedBaseMetadata(offsets: readonly number[], packId: number): Map<string, PackBaseMetadata> {
    if (offsets.length === 0) return new Map();
    const result = new Map<string, PackBaseMetadata>();
    for (const row of this.db.all<{ oid: string; type: string; size: number }>(
      `SELECT entry.oid, entry.type, entry.size
         FROM json_each(?) wanted
         CROSS JOIN git_pack_entries entry
           ON entry.repo_id = ? AND entry.pack_id = ? AND entry.offset = wanted.value`,
      JSON.stringify(offsets),
      this.repoId,
      packId,
    )) {
      if (
        !isOid(row.oid) ||
        !isObjectType(row.type) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > MAX_PACK_DELTA_WORKING_BYTES
      ) {
        throw new CorruptError("pack ingest base has invalid size metadata");
      }
      result.set(row.oid, { type: row.type, size: row.size });
    }
    return result;
  }

  #selectBaseGroup(
    oids: readonly string[],
    packed: ReadonlyMap<string, PackBaseMetadata>,
  ): string[] {
    const group: string[] = [];
    let bytes = 0;
    for (const oid of oids) {
      const metadata = packed.get(oid);
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
      return this.read.readObjectsBounded(uncached, packId, null, true, false);
    }
    if (uncached.length === 0) return result;
    const parts = this.read.readObjectsBounded(uncached, packId, null, true, false);
    for (const [oid, object] of parts) result.set(oid, object);
    return result;
  }

  #cacheChunked(packId: number, oid: string, type: ObjectType, target: ChunkedBytes): void {
    this.read.cacheObject(packId, oid, { type, data: target.toUint8Array() });
  }
}
