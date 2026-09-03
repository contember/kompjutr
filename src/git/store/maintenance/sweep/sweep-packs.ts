import type { SqlDatabase } from "../../../../db/db.js";
import { CorruptError } from "../../../common/errors.js";
import { decodeRow, int, nullable, oneOf } from "../../../common/rows.js";
import type { SharedRepoStore } from "../../index.js";
import type { PackAudit, RunState, SliceResult } from "./sweep-contracts.js";
import {
  eligibilityTime,
  progress,
  requireStableEpoch,
  safeInteger,
  sweepCutoff,
  transitionPhase,
  updateReclamationCounters,
} from "./sweep-shared.js";

const PACK_COLUMNS = `pack.repo_id, pack.pack_id, pack.size, pack.count, pack.state,
  candidate.unreachable_since_ms,
  EXISTS (SELECT 1 FROM git_maintenance_repack_batches batch
    WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id) AS owned,
  EXISTS (
    SELECT 1 FROM git_pack_objects object
    JOIN git_maintenance_objects mark
      ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
    WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
  ) AS marked`;

function readPackRow(row: Record<string, unknown>, repoId: number): PackAudit {
  const decoded = decodeRow(
    row,
    {
      repo_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance pack repository is invalid"),
      pack_id: int(0, Number.MAX_SAFE_INTEGER, "maintenance pack id is invalid"),
      size: int(0, Number.MAX_SAFE_INTEGER, "maintenance pack size is invalid"),
      count: int(0, Number.MAX_SAFE_INTEGER, "maintenance pack object count is invalid"),
      state: oneOf(["pending", "complete"], "maintenance pack state is invalid"),
      unreachable_since_ms: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "pack unreachable time is invalid"),
      ),
      owned: int(0, 1, "maintenance pack ownership marker is invalid"),
      marked: int(0, 1, "maintenance pack mark marker is invalid"),
    },
    "maintenance pack row is malformed",
  );
  if (decoded.repo_id !== repoId) {
    throw new CorruptError("maintenance pack row crossed repositories");
  }
  return {
    packId: decoded.pack_id,
    size: decoded.size,
    count: decoded.count,
    state: decoded.state,
    owned: decoded.owned === 1,
    marked: decoded.marked === 1,
    candidateSince: decoded.unreachable_since_ms,
  };
}
function readPackClassificationMismatch(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
): PackAudit | null {
  let result: PackAudit | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `WITH audits AS (
       SELECT ${PACK_COLUMNS}
         FROM git_pack_meta pack
         LEFT JOIN git_pack_gc_candidates candidate
           ON candidate.repo_id = pack.repo_id AND candidate.pack_id = pack.pack_id
        WHERE pack.repo_id = ?
     )
     SELECT * FROM audits
      WHERE (state != 'complete' AND unreachable_since_ms IS NOT NULL)
         OR (owned != 0 AND unreachable_since_ms IS NOT NULL)
         OR (state = 'complete' AND owned = 0 AND marked = 0
           AND unreachable_since_ms IS NULL)
         OR (state = 'complete' AND marked != 0 AND unreachable_since_ms IS NOT NULL)
      ORDER BY pack_id LIMIT 2`,
    run.runId,
    repoId,
  )) {
    const checked = readPackRow(row, repoId);
    result ??= checked;
    rows++;
  }
  if (rows > 2) throw new CorruptError("pack classification exceeded sentinel");
  return result;
}

function deletePackCandidate(db: SqlDatabase, repoId: number, packId: number): void {
  db.run("DELETE FROM git_pack_gc_candidates WHERE repo_id = ? AND pack_id = ?", repoId, packId);
}

export function classifyPacks(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
): SliceResult {
  const pack = readPackClassificationMismatch(db, repoId, run);
  if (pack === null) {
    const updated = transitionPhase(db, repoId, run, "sweep-loose", null);
    return {
      progress: progress(updated, updated.phase, "phase-complete"),
      storageChanged: false,
    };
  }
  if (pack.state !== "complete" || pack.owned || pack.marked) {
    deletePackCandidate(db, repoId, pack.packId);
  } else {
    db.run(
      `INSERT OR IGNORE INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, ?)`,
      repoId,
      pack.packId,
      nowMs,
    );
  }
  return { progress: progress(run, run.phase, "progress"), storageChanged: false };
}

function readPackSweepAction(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
): PackAudit | null {
  let result: PackAudit | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `WITH audits AS (
       SELECT ${PACK_COLUMNS}
         FROM git_pack_gc_candidates candidate
         JOIN git_pack_meta pack
           ON pack.repo_id = candidate.repo_id AND pack.pack_id = candidate.pack_id
        WHERE candidate.repo_id = ?
     )
     SELECT * FROM audits
      WHERE state != 'complete' OR owned != 0 OR marked != 0 OR unreachable_since_ms <= ?
      ORDER BY pack_id LIMIT 2`,
    run.runId,
    repoId,
    sweepCutoff(nowMs),
  )) {
    const checked = readPackRow(row, repoId);
    if (checked.candidateSince === null) throw new CorruptError("pack sweep lost candidate age");
    result ??= checked;
    rows++;
  }
  if (rows > 2) throw new CorruptError("pack sweep action exceeded sentinel");
  return result;
}

function deletePackStorage(store: SharedRepoStore, run: RunState, pack: PackAudit): void {
  requireStableEpoch(store.db, store.repoId, run);
  store.db.run(
    `DELETE FROM git_blob_ids
      WHERE repo_id = ?
        AND oid IN (SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM git_objects loose
           WHERE loose.repo_id = git_blob_ids.repo_id AND loose.oid = git_blob_ids.oid
        )`,
    store.repoId,
    store.repoId,
    pack.packId,
  );
  if (store.packs.deleteCompletePacks([pack.packId]) !== 1) {
    throw new CorruptError("complete pack deletion did not remove exactly one pack");
  }
}
function nextPackEligibility(db: SqlDatabase, repoId: number, run: RunState): number | null {
  const row = db.one<Record<string, unknown>>(
    `SELECT min(candidate.unreachable_since_ms) AS since,
            EXISTS (
              SELECT 1 FROM git_pack_gc_candidates candidate
              JOIN git_pack_meta pack
                ON pack.repo_id = candidate.repo_id AND pack.pack_id = candidate.pack_id
              WHERE candidate.repo_id = ? AND (
                pack.state != 'complete' OR
                EXISTS (SELECT 1 FROM git_maintenance_repack_batches batch
                  WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id) OR
                EXISTS (
                  SELECT 1 FROM git_pack_objects object
                  JOIN git_maintenance_objects mark
                    ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
                  WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
                )
              )
            ) AS actionable
       FROM git_pack_gc_candidates candidate WHERE candidate.repo_id = ?`,
    repoId,
    run.runId,
    repoId,
  );
  if (row === undefined || row.actionable !== 0) {
    throw new CorruptError("pack sweep completion retained an actionable candidate");
  }
  return row.since === null
    ? null
    : eligibilityTime(safeInteger(row.since, "pack candidate age", 0));
}

export function sweepPacks(store: SharedRepoStore, run: RunState, nowMs: number): SliceResult {
  const pack = readPackSweepAction(store.db, store.repoId, run, nowMs);
  if (pack === null) {
    const packEligible = nextPackEligibility(store.db, store.repoId, run);
    const nextEligibleMs =
      run.nextEligibleMs === null
        ? packEligible
        : packEligible === null
          ? run.nextEligibleMs
          : Math.min(run.nextEligibleMs, packEligible);
    const updated = transitionPhase(store.db, store.repoId, run, "finish", nextEligibleMs);
    return { progress: progress(updated, updated.phase, "complete"), storageChanged: false };
  }
  if (pack.state !== "complete" || pack.owned || pack.marked) {
    deletePackCandidate(store.db, store.repoId, pack.packId);
    return { progress: progress(run, run.phase, "progress"), storageChanged: false };
  }
  const since = pack.candidateSince;
  if (since === null || nowMs < eligibilityTime(since)) {
    throw new CorruptError("pack sweep selected an ineligible candidate");
  }
  deletePackStorage(store, run, pack);
  const updated = updateReclamationCounters(store.db, store.repoId, run, pack.count, 1, pack.size);
  return { progress: progress(updated, updated.phase, "progress"), storageChanged: true };
}
