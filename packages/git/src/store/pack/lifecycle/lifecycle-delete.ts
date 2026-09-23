// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { bumpRepositorySourceGeneration } from "../../core/source-generation.js";
import { MAX_PACK_DELETE_BATCH, type PackSharedState, uniquePackIds } from "../shared.js";

export class PackDeletion {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly sharedState: PackSharedState,
  ) {}

  #clearCaches(): void {
    this.sharedState.cacheGeneration++;
  }

  /** Delete a bounded set of complete packs; absent ids make retries idempotent. */
  deleteCompletePacks(packIds: readonly number[]): number {
    const ids = uniquePackIds(packIds, MAX_PACK_DELETE_BATCH);
    if (ids.length === 0) return 0;
    const requested = new Set(ids);
    const states = new Map<number, "pending" | "complete">();
    for (const row of this.db.iterate(
      `SELECT pack_id, state FROM git_pack_meta
        WHERE repo_id = ? AND pack_id IN (SELECT value FROM json_each(?))`,
      this.repoId,
      JSON.stringify(ids),
    )) {
      const packId = row.pack_id;
      const state = row.state;
      if (
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        packId < 0 ||
        (state !== "pending" && state !== "complete") ||
        !requested.has(packId) ||
        states.has(packId)
      ) {
        throw new CorruptError("complete pack deletion query returned an invalid row");
      }
      states.set(packId, state);
    }
    for (const [packId, state] of states) {
      if (state !== "complete") throw new GitError("EBUSY", `pack ${packId} is still pending`);
    }
    if (states.size === 0) return 0;
    this.db.transactionSync(() => {
      this.deletePacks([...states.keys()]);
    });
    this.#clearCaches();
    return states.size;
  }

  deletePacks(deletingPackIds: readonly number[]): void {
    if (deletingPackIds.length === 0) return;
    // Read before the first promotion: afterwards the canonical rows already
    // point at the surviving packs and a complete owner looks like none.
    const ownedCanonicalRows = this.#ownsVisibleCanonicalRows(deletingPackIds);
    let promoted = 0;
    for (const packId of deletingPackIds) {
      promoted += this.#promoteFallbacks(packId, deletingPackIds);
    }
    for (const packId of deletingPackIds) this.#deletePackStorage(packId);
    // Pending rows are invisible to complete reads, so a pending-only deletion
    // that promotes nothing changes no source an ordinary reader can observe.
    if (ownedCanonicalRows || promoted > 0) {
      bumpRepositorySourceGeneration(this.db, this.repoId);
    }
  }

  #ownsVisibleCanonicalRows(deletingPackIds: readonly number[]): boolean {
    const owned = this.db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_pack_objects o
         JOIN git_pack_meta m
           ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id AND m.state = 'complete'
         WHERE o.repo_id = ? AND o.pack_id IN (SELECT value FROM json_each(?))
       )`,
      this.repoId,
      JSON.stringify(deletingPackIds),
    );
    if (owned !== 0 && owned !== 1) {
      throw new CorruptError("canonical pack ownership probe returned an invalid value");
    }
    return owned === 1;
  }

  #promoteFallbacks(packId: number, deletingPackIds: readonly number[]): number {
    const encodedDeletingPackIds = JSON.stringify(deletingPackIds);
    this.db.run(
      `INSERT OR REPLACE INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size)
       SELECT candidate.repo_id, candidate.oid, candidate.pack_id, candidate.offset,
              candidate.data_off, candidate.data_len, candidate.type, candidate.size,
              candidate.entry_size
         FROM git_pack_entries candidate
         JOIN git_pack_meta candidate_meta
           ON candidate_meta.repo_id = candidate.repo_id
          AND candidate_meta.pack_id = candidate.pack_id
          AND candidate_meta.state = 'complete'
        WHERE candidate.repo_id = ?
          AND candidate.pack_id NOT IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM git_pack_objects current
             WHERE current.repo_id = candidate.repo_id AND current.oid = candidate.oid
               AND current.pack_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries earlier
            JOIN git_pack_meta earlier_meta
              ON earlier_meta.repo_id = earlier.repo_id
             AND earlier_meta.pack_id = earlier.pack_id
             AND earlier_meta.state = 'complete'
             WHERE earlier.repo_id = candidate.repo_id AND earlier.oid = candidate.oid
               AND earlier.pack_id NOT IN (SELECT value FROM json_each(?))
               AND earlier.pack_id < candidate.pack_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries same_pack
             WHERE same_pack.repo_id = candidate.repo_id
               AND same_pack.pack_id = candidate.pack_id
               AND same_pack.oid = candidate.oid
               AND same_pack.offset < candidate.offset
           )`,
      this.repoId,
      encodedDeletingPackIds,
      packId,
      encodedDeletingPackIds,
    );
    // `#promoteFallbacks` runs once per deleted pack, so the promotions have to
    // accumulate: a later iteration must not hide an earlier one.
    const promoted = this.db.scalar<unknown>("SELECT changes()");
    if (typeof promoted !== "number" || !Number.isSafeInteger(promoted) || promoted < 0) {
      throw new CorruptError("pack fallback promotion returned an invalid row count");
    }
    return promoted;
  }

  #deletePackStorage(packId: number): void {
    this.db.run(
      `DELETE FROM git_commits
        WHERE repo_id = ?
          AND oid IN (
            SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ? AND type = 'commit'
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = git_commits.repo_id
               AND loose.oid = git_commits.oid
               AND loose.type = 'commit'
               AND loose.size = git_commits.object_size
          )`,
      this.repoId,
      this.repoId,
      packId,
    );
    this.db.run(
      `DELETE FROM git_tree_effective WHERE source_key IN (
         SELECT source_key FROM git_tree_sources
          WHERE repo_id = ? AND storage = 'pack' AND source_id = ?
       )`,
      this.repoId,
      packId,
    );
    this.db.run(
      `INSERT OR REPLACE INTO git_tree_effective (repo_id, tree_oid, source_key)
       SELECT object.repo_id, object.oid, source.source_key
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
         JOIN git_tree_sources source
           ON source.repo_id = object.repo_id AND source.tree_oid = object.oid
          AND source.storage = 'pack' AND source.source_id = object.pack_id
        WHERE object.repo_id = ? AND object.type = 'tree'
          AND EXISTS (
            SELECT 1 FROM git_tree_sources doomed
             WHERE doomed.repo_id = object.repo_id AND doomed.tree_oid = object.oid
               AND doomed.storage = 'pack' AND doomed.source_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = object.repo_id AND loose.oid = object.oid
               AND loose.type = 'tree'
          )`,
      this.repoId,
      packId,
    );
    this.db.run(
      "DELETE FROM git_tree_sources WHERE repo_id = ? AND storage = 'pack' AND source_id = ?",
      this.repoId,
      packId,
    );
    for (const table of [
      "git_pack_data",
      "git_pack_entries",
      "git_pack_objects",
      "git_pack_pending",
      "git_pack_meta",
    ]) {
      this.db.run(`DELETE FROM ${table} WHERE repo_id = ? AND pack_id = ?`, this.repoId, packId);
    }
  }
}
