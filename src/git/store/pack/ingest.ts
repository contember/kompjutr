// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "../../../db/db.js";
import { GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import type { RawObject } from "../../common/objects.js";
import { ChunkPool } from "./chunks.js";
import { PackIndexer } from "./ingest/ingest-index.js";
import { type AbortablePackIngestOptions, throwIfIngestAborted } from "./ingest/ingest-options.js";
import { PackChunkWriter } from "./ingest/ingest-write.js";
import type { PackLifecycle } from "./lifecycle.js";
import type { PackReadEngine } from "./read.js";
import {
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type PackIngestLease,
  type PackIngestMemory,
  type PackIngestResult,
  type PackSharedState,
  requireIngestTime,
  requireLifecycleResult,
} from "./shared.js";

export class PackIngestEngine {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #read: PackReadEngine;
  readonly #lifecycle: PackLifecycle;
  readonly #sharedState: PackSharedState;
  readonly #now: () => number;
  readonly #writer: PackChunkWriter;
  readonly #indexer: PackIndexer;

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
    this.#read = read;
    this.#lifecycle = lifecycle;
    this.#sharedState = sharedState;
    this.#now = now;
    this.#writer = new PackChunkWriter(db, repoId);
    this.#indexer = new PackIndexer(
      db,
      repoId,
      objects,
      externalBatch,
      externalMetadata,
      read,
      maxBufferedEntry,
      cacheEntryLimit,
    );
  }

  /** Stream a pack through storage, indexing, delta resolution, and publication. */
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

      const total = await this.#writer.writeChunks(
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
      const { count, commits, membership } = await this.#indexer.indexPack(
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
}
