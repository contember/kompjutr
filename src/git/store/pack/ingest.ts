// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { blob, type SqlDatabase } from "../../../db/db.js";
import { concat, isOid, toHex } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import {
  hashObject,
  NUMBER_TYPE,
  type ObjectType,
  objectHeader,
  type RawObject,
} from "../../common/objects.js";
import { Sha1 } from "../../common/sha1.js";
import { InflateInto, InflateStream, inflatePrefix } from "../../common/zlib.js";
import {
  PACK_PENDING_PAGE_ROWS,
  PackCommitIndex,
  PackObjectBatch,
  type PackObjectInput,
  PackPendingBatch,
  PackTreeIndex,
  type PendingRow,
  validatePendingRow,
} from "../pack-ingest-index.js";
import { type ByteSource, type ChunkedBytes, ChunkPool, chunkFootprint } from "./chunks.js";
import { DeltaApplier } from "./delta.js";
import type { PackLifecycle } from "./lifecycle.js";
import type { PackReadEngine } from "./read.js";
import {
  DeltaHeaderProbe,
  ExpectedPackMembership,
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type ExternalObjectMetadata,
  FlatByteSource,
  hashByteSource,
  type IngestBase,
  isObjectType,
  MAX_PACK_DELTA_WORKING_BYTES,
  OFFSET_WINDOW,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_CHUNK,
  PACK_RANGE_BATCH_BYTES,
  PACK_RANGE_SLICE_BYTES,
  PACK_READ_BYTES,
  type PackIngestLease,
  type PackIngestMemory,
  type PackIngestOptions,
  type PackIngestResult,
  type PackRangeRequest,
  type PackSharedState,
  pushExactInflate,
  requireIngestTime,
  requireLifecycleResult,
} from "./shared.js";

interface AbortablePackIngestOptions extends PackIngestOptions {
  signal?: AbortSignal;
}

function throwIfIngestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new GitError("EABORTED", "network operation aborted", { cause: signal.reason });
  }
}

export class PackIngestEngine {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #externalBatch: ExternalBatchResolver;
  readonly #externalMetadata: ExternalMetadataResolver;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #read: PackReadEngine;
  readonly #lifecycle: PackLifecycle;
  readonly #sharedState: PackSharedState;
  readonly #now: () => number;
  readonly #maxBufferedEntry: number;
  readonly #cacheEntryLimit: number;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    externalBatch: ExternalBatchResolver,
    externalMetadata: ExternalMetadataResolver,
    read: PackReadEngine,
    lifecycle: PackLifecycle,
    sharedState: PackSharedState,
    now: () => number,
    maxBufferedEntry: number,
    cacheEntryLimit: number,
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#externalBatch = externalBatch;
    this.#externalMetadata = externalMetadata;
    this.#objects = objects;
    this.#read = read;
    this.#lifecycle = lifecycle;
    this.#sharedState = sharedState;
    this.#now = now;
    this.#maxBufferedEntry = maxBufferedEntry;
    this.#cacheEntryLimit = cacheEntryLimit;
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
    options: AbortablePackIngestOptions = {},
  ): Promise<PackIngestResult> {
    return this.#ingest(source, options);
  }

  async #ingest(
    source: AsyncIterable<Uint8Array>,
    options: AbortablePackIngestOptions,
  ): Promise<PackIngestResult> {
    const reclaimPending = options.reclaimPending ?? true;
    if (typeof reclaimPending !== "boolean") {
      throw new RangeError("reclaimPending must be a boolean");
    }
    const now = options.now ?? this.#now;
    const say = options.onProgress ?? (() => {});
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const yieldNow = options.yieldNow ?? (() => Promise.resolve());
    const signal = options.signal;
    const memory: PackIngestMemory = { pool: new ChunkPool() };
    let activePackId: number | undefined;
    let lease: PackIngestLease | null = null;
    try {
      throwIfIngestAborted(signal);
      const reservation = this.#lifecycle.reservePending(
        requireIngestTime(now),
        options.lifecycle,
        {
          ordinary: reclaimPending,
        },
      );
      activePackId = reservation.packId;
      lease = reservation.lease;
      if (reservation.reclaimed > 0) this.#read.clearCaches();
      const activeLease = lease;
      const heartbeat =
        activeLease === null
          ? () => undefined
          : () => this.#lifecycle.renewIngestLease(activeLease, now);

      const total = await this.#writeChunks(
        source,
        reservation.packId,
        maxBytes,
        say,
        yieldNow,
        heartbeat,
        memory,
        signal,
      );
      throwIfIngestAborted(signal);
      heartbeat();
      const { count, commits, membership } = await this.#indexPack(
        reservation.packId,
        total,
        say,
        yieldNow,
        heartbeat,
        memory,
        signal,
      );
      heartbeat();
      const result = { packId: reservation.packId, count, bytes: total };
      const publishingLease = lease;

      throwIfIngestAborted(signal);
      this.#db.transactionSync(() => {
        if (publishingLease !== null) this.#lifecycle.renewIngestLease(publishingLease, now);
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
        this.#lifecycle.auditPublishedMembership(reservation.packId, membership);
        if (options.lifecycle !== undefined) {
          requireLifecycleResult(options.lifecycle.published(result), "published");
        }
        if (publishingLease !== null) this.#lifecycle.releaseIngestLease(publishingLease, true);
      });
      if (publishingLease !== null) lease = null;
      return result;
    } finally {
      if (activePackId !== undefined) this.#sharedState.activePending.delete(activePackId);
      try {
        if (lease !== null) this.#lifecycle.releaseIngestLease(lease, false);
      } finally {
        memory.pool.assertIdle();
        memory.pool.dispose();
      }
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
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const sha = new Sha1();
    let tail = new Uint8Array(0); // rolling 20-byte lookbehind: the trailer
    let total = 0;
    let seq = 0;
    let announced = 0;
    const buffer = new Uint8Array(PACK_CHUNK);
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
      throwIfIngestAborted(signal);
      heartbeat();
      if (data.length === 0) continue;
      for (let offset = 0; offset < data.length; offset += SLICE) {
        feed(data.subarray(offset, offset + SLICE));
        memory.pool.assertIdle();
        await yieldNow();
        throwIfIngestAborted(signal);
        heartbeat();
      }
    }
    throwIfIngestAborted(signal);
    heartbeat();
    if (filled > 0) this.#writeChunk(packId, seq++, buffer.slice(0, filled));

    if (total < 32) throw new CorruptError("pack is too small to be valid");
    if (toHex(tail) !== toHex(sha.digest())) throw new CorruptError("pack checksum mismatch");
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
    signal: AbortSignal | undefined,
  ): Promise<{
    count: number;
    commits: PackCommitIndex;
    membership: ExpectedPackMembership;
  }> {
    const reader = new PackReader(
      (offset, length) => this.#read.readRaw(packId, offset, length),
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
    const objectIndex = new PackObjectBatch(this.#db, this.#repoId, (row) =>
      membership.record(row),
    );
    const pendingIndex = new PackPendingBatch(this.#db, this.#repoId, packId);
    const treeIndex = new PackTreeIndex(this.#db);
    const commitIndex = new PackCommitIndex(this.#db, this.#repoId, packId, objectIndex);
    const missingBases = new Set<string>();
    const offsetToOid = (offset: number): string | null => {
      return offsets.get(offset);
    };

    let deferred = 0;
    for (let i = 0; i < count; i++) {
      throwIfIngestAborted(signal);
      const header = reader.entryHeader();
      membership.addOffset(i, header.offset);
      const entryType = header.kind === null ? NUMBER_TYPE[header.type]! : null;
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
        );
        offsets.set(header.offset, oid);
        missingBases.delete(oid);
        if (entry.data !== null) this.#read.cacheObject(packId, oid, { type, data: entry.data });
      } else {
        const baseOid =
          header.kind === "ref" ? header.baseOid! : offsetToOid(header.offset - header.baseDelta!);
        let resolved = false;
        if (entry.data !== null && baseOid !== null) {
          const base = missingBases.has(baseOid)
            ? undefined
            : this.#objects.get(this.#read.objectCacheKey(packId, baseOid));
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
              );
              offsets.set(header.offset, oid);
              missingBases.delete(oid);
              if (target.length <= this.#cacheEntryLimit) {
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
    if (deferred > 0) this.#read.clearCaches();
    await this.#drainPending(
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

  async #drainPending(
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
      this.#db.scalar<number>(
        "SELECT COUNT(*) FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      ) ?? 0;
    while (remaining > 0) {
      throwIfIngestAborted(signal);
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
        const allExternalMetadata = this.#externalMetadata(externalOids);
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
          compressedBatch = this.#read.readRangeBatch(packId, requests);
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
              if (target.length <= this.#cacheEntryLimit) {
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
      const cached = this.#objects.get(this.#read.objectCacheKey(packId, oid));
      if (cached === undefined) uncached.push(oid);
      else {
        result.set(oid, cached);
      }
    }
    if (result.size === 0) {
      return this.#read.readObjectsBounded(uncached, packId, null, true, new Map(), false);
    }
    if (uncached.length === 0) return result;
    const parts = this.#read.readObjectsBounded(uncached, packId, null, true, new Map(), false);
    for (const [oid, object] of parts) result.set(oid, object);
    return result;
  }

  #cacheChunked(packId: number, oid: string, type: ObjectType, target: ChunkedBytes): void {
    this.#read.cacheObject(packId, oid, { type, data: target.toUint8Array() });
  }

  #applyDeltaBytes(base: Uint8Array, delta: Uint8Array, pool: ChunkPool): ChunkedBytes {
    const probe = new DeltaHeaderProbe();
    probe.update(delta);
    const header = probe.finish();
    if (header.sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
    this.#validatePoolTarget(base.length, header.targetSize);
    const applier = new DeltaApplier(new FlatByteSource(base), pool, {
      expectedTargetSize: header.targetSize,
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
    const header = this.#probeStoredDeltaHeader(packId, dataOff, dataLen, label, compressed);
    if (header.sourceSize !== base.length) throw new CorruptError("delta base size mismatch");
    const targetSize = header.targetSize;
    this.#validatePoolTarget(base.length, targetSize);
    const applier = new DeltaApplier(base, pool, {
      expectedTargetSize: targetSize,
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
          push(this.#read.readRaw(packId, dataOff + consumed, length));
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

  #probeStoredDeltaHeader(
    packId: number,
    dataOff: number,
    dataLen: number,
    label: string,
    compressed: Uint8Array | null,
  ): { sourceSize: number; targetSize: number } {
    if (compressed !== null && compressed.length !== dataLen) {
      throw new CorruptError(`${label} compressed range has the wrong size`);
    }
    const probe = new DeltaHeaderProbe();
    const stream = new InflateStream((chunk) => probe.update(chunk));
    let consumed = 0;
    while (!probe.complete && !stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_RANGE_SLICE_BYTES, dataLen - consumed);
      const input =
        compressed === null
          ? this.#read.readRaw(packId, dataOff + consumed, length)
          : compressed.subarray(consumed, consumed + length);
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
    }
    return probe.finish();
  }

  #validatePoolTarget(baseSize: number, targetSize: number): void {
    const baseBytes = chunkFootprint(baseSize);
    const targetBytes = chunkFootprint(targetSize);
    if (
      baseBytes > MAX_PACK_DELTA_WORKING_BYTES ||
      targetBytes > MAX_PACK_DELTA_WORKING_BYTES - baseBytes
    ) {
      throw new CorruptError("delta working set exceeds 48 MiB");
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
  ): void {
    objectIndex.add(row);
    if (type === "commit") {
      let commitData: Uint8Array;
      if (data !== null) {
        commitData = data;
      } else if (chunked !== null) {
        commitData = chunked.toUint8Array();
      } else {
        const inflated = [...this.#inflateEntryChunks(packId, dataOff, dataLen, objectSize)];
        commitData = concat(inflated);
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
      const input = this.#read.readRaw(packId, dataOff + consumed, length);
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
