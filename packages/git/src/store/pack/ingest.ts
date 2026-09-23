// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import type { RawObject } from "../../common/objects.js";
import { bumpRepositorySourceGeneration } from "../core/source-generation.js";
import { ChunkPool } from "./chunks.js";
import { PackIndexer } from "./ingest/ingest-index.js";
import { type AbortablePackIngestOptions, throwIfIngestAborted } from "./ingest/ingest-options.js";
import { PackChunkWriter } from "./ingest/ingest-write.js";
import type { PackLifecycle } from "./lifecycle.js";
import type { PackReadEngine } from "./read.js";
import {
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
    read: PackReadEngine,
    lifecycle: PackLifecycle,
    sharedState: PackSharedState,
    now: () => number,
    maxBufferedEntry: number,
    cacheEntryLimit: number,
    maxDeltaDepth: number,
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
      read,
      maxBufferedEntry,
      cacheEntryLimit,
      maxDeltaDepth,
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
      const reservation = this.#lifecycle.reservePending(requireIngestTime(now), options.lifecycle);
      activePackId = reservation.packId;
      const activeLease = reservation.lease;
      lease = activeLease;
      if (reservation.reclaimed > 0) this.#read.clearCaches();
      const heartbeat = () => this.#lifecycle.renewIngestLease(activeLease, now);

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

      throwIfIngestAborted(signal);
      commits.checkpoint();
      this.#db.transactionSync(() => {
        this.#lifecycle.renewIngestLease(activeLease, now);
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
        this.#lifecycle.auditPublishedMembership(reservation.packId, membership);
        commits.finish();
        bumpRepositorySourceGeneration(this.#db, this.#repoId);
        if (options.lifecycle !== undefined) {
          requireLifecycleResult(options.lifecycle.published(result), "published");
        }
        this.#lifecycle.releaseIngestLease(activeLease, true);
      });
      lease = null;
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
