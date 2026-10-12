// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { bumpRepositorySourceGeneration } from "../../core/source-generation.js";
import { completePackEntriesSql } from "../canonical.js";
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
    const encodedDeletingPackIds = JSON.stringify(deletingPackIds);
    const complete = this.db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_pack_meta
          WHERE repo_id = ? AND state = 'complete'
            AND pack_id IN (SELECT value FROM json_each(?))
       )`,
      this.repoId,
      encodedDeletingPackIds,
    );
    if (complete !== 0 && complete !== 1) {
      throw new CorruptError("complete pack deletion probe returned an invalid value");
    }
    for (const packId of deletingPackIds) {
      this.#deletePackStorage(packId, encodedDeletingPackIds);
    }
    if (complete === 1) bumpRepositorySourceGeneration(this.db, this.repoId);
  }

  #deletePackStorage(packId: number, encodedDeletingPackIds: string): void {
    this.db.run(
      `DELETE FROM git_commits
        WHERE repo_id = ?
          AND oid IN (
            SELECT oid FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND type = 'commit'
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = git_commits.repo_id
               AND loose.oid = git_commits.oid
               AND loose.type = 'commit'
               AND loose.size = git_commits.object_size
          )
          AND NOT EXISTS (
            SELECT 1 ${completePackEntriesSql("git_commits.repo_id", "git_commits.oid")}
              AND candidate.pack_id NOT IN (SELECT value FROM json_each(?))
          )`,
      this.repoId,
      this.repoId,
      packId,
      encodedDeletingPackIds,
    );
    this.db.run(
      `DELETE FROM git_tree_sources
        WHERE repo_id = ?
          AND tree_oid IN (
            SELECT oid FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND type = 'tree'
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = git_tree_sources.repo_id AND loose.oid = git_tree_sources.tree_oid
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries other
             WHERE other.repo_id = git_tree_sources.repo_id
               AND other.oid = git_tree_sources.tree_oid
               AND other.pack_id != ?
          )`,
      this.repoId,
      this.repoId,
      packId,
      packId,
    );
    for (const table of [
      "git_pack_data",
      "git_pack_entries",
      "git_pack_pending",
      "git_pack_meta",
    ]) {
      this.db.run(`DELETE FROM ${table} WHERE repo_id = ? AND pack_id = ?`, this.repoId, packId);
    }
  }
}
