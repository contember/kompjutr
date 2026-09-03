// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "../../../../db/db.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import {
  type ExpectedPackMembership,
  MAX_PACK_DELETE_BATCH,
  PACK_INGEST_LEASE_MS,
  type PackIngestControl,
  type PackIngestLease,
  type PackIngestLifecycle,
  type PackSharedState,
  requireIngestControl,
  requireIngestTime,
  requireLifecycleResult,
} from "../shared.js";
import type { PackDeletion } from "./lifecycle-delete.js";

export class PackIngestLifecycleControl {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly sharedState: PackSharedState,
    private readonly now: () => number,
    private readonly deletion: PackDeletion,
  ) {}

  #clearCaches(): void {
    this.sharedState.cacheGeneration++;
  }

  #ensureIngestControl(): PackIngestControl {
    const row = this.db.one<Record<string, unknown>>(
      `SELECT repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms
         FROM git_pack_ingest_control WHERE repo_id = ?`,
      this.repoId,
    );
    if (row === undefined) throw new CorruptError("pack ingest control is missing");
    return requireIngestControl(row, this.repoId);
  }

  #nextPackId(control: PackIngestControl): number {
    const latest = this.db.scalar<number | null>(
      "SELECT MAX(pack_id) FROM git_pack_meta WHERE repo_id = ?",
      this.repoId,
    );
    if (latest !== undefined && latest !== null && (!Number.isSafeInteger(latest) || latest < 0)) {
      throw new CorruptError("pack id allocation state is invalid");
    }
    const last = Math.max(control.lastPackId, latest ?? 0);
    if (last === Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "pack id allocation is exhausted");
    }
    return last + 1;
  }

  #reclaimPendingRows(
    control: PackIngestControl,
    nowMs: number,
  ): {
    control: PackIngestControl;
    removed: number;
  } {
    const ids = new Set<number>();
    let current = control;
    let livePackId: number | null = null;
    if (control.activePackId !== null) {
      if (control.expiresMs === null) throw new CorruptError("pack ingest lease expiry is missing");
      const owner = this.db.one<Record<string, unknown>>(
        `SELECT pack.state AS state,
                EXISTS(
                  SELECT 1 FROM git_maintenance_repack_batches batch
                   WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
                ) AS maintenance_owned
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.pack_id = ?`,
        this.repoId,
        control.activePackId,
      );
      if (owner === undefined) throw new CorruptError("active pack ingest identity is missing");
      if (owner.state !== "pending" || owner.maintenance_owned !== 0) {
        throw new CorruptError("active ordinary pack ingest ownership is invalid");
      }
      if (nowMs < control.expiresMs) {
        livePackId = control.activePackId;
      } else {
        const cleared = this.db.one<Record<string, unknown>>(
          `UPDATE git_pack_ingest_control
              SET active_pack_id = NULL, expires_ms = NULL
            WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ?
          RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
          this.repoId,
          control.ownerGeneration,
          control.activePackId,
        );
        if (cleared === undefined) throw new CorruptError("expired pack ingest lease changed");
        current = requireIngestControl(cleared, this.repoId);
        ids.add(control.activePackId);
      }
    }
    const collect = (rows: Iterable<Record<string, unknown>>, requirePending: boolean): void => {
      for (const row of rows) {
        const packId = row.pack_id;
        if (typeof packId !== "number" || !Number.isSafeInteger(packId) || packId < 0) {
          throw new CorruptError("pending pack query returned an invalid pack id");
        }
        if (requirePending && row.state !== "pending") {
          throw new CorruptError(`pack ${packId}: invalid pending cleanup state`);
        }
        ids.add(packId);
      }
    };
    collect(
      this.db.iterate(
        `SELECT pack.pack_id AS pack_id, pack.state AS state
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.state IS NOT 'complete'
            AND (? IS NULL OR pack.pack_id != ?)
            AND pack.pack_id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM git_maintenance_repack_batches batch
               WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
            )
          ORDER BY pack.pack_id LIMIT ?`,
        this.repoId,
        livePackId,
        livePackId,
        JSON.stringify([...this.sharedState.activePending]),
        MAX_PACK_DELETE_BATCH + 1,
      ),
      true,
    );
    collect(
      this.db.iterate(
        `SELECT DISTINCT data.pack_id AS pack_id
           FROM git_pack_data data
           LEFT JOIN git_pack_meta pack
             ON pack.repo_id = data.repo_id AND pack.pack_id = data.pack_id
          WHERE data.repo_id = ? AND pack.pack_id IS NULL
          ORDER BY data.pack_id LIMIT ?`,
        this.repoId,
        MAX_PACK_DELETE_BATCH + 1,
      ),
      false,
    );
    if (ids.size > MAX_PACK_DELETE_BATCH) {
      throw new GitError("E2BIG", `pending pack cleanup exceeds ${MAX_PACK_DELETE_BATCH} packs`);
    }
    for (const packId of ids) this.deletion.deletePack(packId, [packId]);
    return { control: current, removed: ids.size };
  }

  /** Drop only unowned or expired ordinary packs. */
  reclaimPending(now: () => number = this.now): number {
    const nowMs = requireIngestTime(now);
    const removed = this.db.transactionSync(() => {
      const control = this.#ensureIngestControl();
      return this.#reclaimPendingRows(control, nowMs).removed;
    });
    if (removed > 0) this.#clearCaches();
    return removed;
  }

  reservePending(
    nowMs: number,
    lifecycle: PackIngestLifecycle | undefined,
    ownership: { ordinary: boolean },
  ): { packId: number; lease: PackIngestLease | null; reclaimed: number } {
    let activePackId: number | undefined;
    try {
      return this.db.transactionSync(() => {
        let control = this.#ensureIngestControl();
        let reclaimed = 0;
        if (ownership.ordinary) {
          const cleanup = this.#reclaimPendingRows(control, nowMs);
          control = cleanup.control;
          reclaimed = cleanup.removed;
          if (control.activePackId !== null) {
            throw new GitError("EBUSY", "pack ingest is active");
          }
          if (control.ownerGeneration === Number.MAX_SAFE_INTEGER) {
            throw new GitError("E2BIG", "pack ingest generation is exhausted");
          }
        }
        const packId = this.#nextPackId(control);
        this.db.run(
          "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, 0, 0, 'pending', ?)",
          this.repoId,
          packId,
          nowMs,
        );
        let lease: PackIngestLease | null = null;
        let updated: Record<string, unknown> | undefined;
        if (ownership.ordinary) {
          const generation = control.ownerGeneration + 1;
          updated = this.db.one<Record<string, unknown>>(
            `UPDATE git_pack_ingest_control
                SET owner_generation = ?, last_pack_id = ?, active_pack_id = ?, expires_ms = ?
              WHERE repo_id = ?
            RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
            generation,
            packId,
            packId,
            nowMs + PACK_INGEST_LEASE_MS,
            this.repoId,
          );
          lease = { generation, packId, expiresMs: nowMs + PACK_INGEST_LEASE_MS };
        } else {
          updated = this.db.one<Record<string, unknown>>(
            `UPDATE git_pack_ingest_control SET last_pack_id = ? WHERE repo_id = ?
            RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
            packId,
            this.repoId,
          );
        }
        if (
          updated === undefined ||
          requireIngestControl(updated, this.repoId).lastPackId !== packId
        ) {
          throw new CorruptError("pack ingest allocation was not recorded");
        }
        this.sharedState.activePending.add(packId);
        activePackId = packId;
        if (lifecycle !== undefined) {
          requireLifecycleResult(lifecycle.reserved(packId), "reserved");
        }
        return { packId, lease, reclaimed };
      });
    } catch (error) {
      if (activePackId !== undefined) this.sharedState.activePending.delete(activePackId);
      throw error;
    }
  }

  renewIngestLease(lease: PackIngestLease, now: () => number): void {
    const nowMs = requireIngestTime(now);
    if (nowMs < lease.expiresMs - Math.floor(PACK_INGEST_LEASE_MS / 2)) return;
    const row = this.db.one<Record<string, unknown>>(
      `UPDATE git_pack_ingest_control
          SET expires_ms = max(expires_ms, ?)
        WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ? AND expires_ms > ?
      RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
      nowMs + PACK_INGEST_LEASE_MS,
      this.repoId,
      lease.generation,
      lease.packId,
      nowMs,
    );
    if (row === undefined) throw new GitError("ESTALE", "pack ingest ownership expired");
    const control = requireIngestControl(row, this.repoId);
    if (
      control.ownerGeneration !== lease.generation ||
      control.activePackId !== lease.packId ||
      control.expiresMs === null ||
      control.expiresMs <= nowMs
    ) {
      throw new CorruptError("pack ingest lease renewal returned an invalid owner");
    }
    lease.expiresMs = control.expiresMs;
  }

  releaseIngestLease(lease: PackIngestLease, required: boolean, db: SqlDatabase = this.db): void {
    const row = db.one<Record<string, unknown>>(
      `UPDATE git_pack_ingest_control
          SET active_pack_id = NULL, expires_ms = NULL
        WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ?
      RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
      this.repoId,
      lease.generation,
      lease.packId,
    );
    if (row === undefined) {
      if (required) throw new GitError("ESTALE", "pack ingest ownership changed");
      return;
    }
    requireIngestControl(row, this.repoId);
  }

  auditPublishedMembership(packId: number, expected: ExpectedPackMembership): void {
    const unavailable = this.db.scalar<number>(
      `SELECT CASE WHEN count(*) != ? THEN -1
              ELSE coalesce(sum(CASE
                WHEN canonical.oid IS NULL OR owner.state IS NOT 'complete' THEN 1
                ELSE 0
              END), 0)
            END
         FROM git_pack_entries entry
         LEFT JOIN git_pack_objects canonical
           ON canonical.repo_id = entry.repo_id AND canonical.oid = entry.oid
         LEFT JOIN git_pack_meta owner
           ON owner.repo_id = canonical.repo_id AND owner.pack_id = canonical.pack_id
        WHERE entry.repo_id = ? AND entry.pack_id = ?`,
      expected.count,
      this.repoId,
      packId,
    );
    if (unavailable !== 0) {
      throw new GitError("ESTALE", "pack membership was claimed by another ingest");
    }
  }
}
