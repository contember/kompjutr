import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../../common/errors.js";
import { decodeRow, expectSafeInteger, int, nullable, oneOf } from "../../../common/rows.js";
import type { SharedRepoStore } from "../../index.js";
import { PACK_SWEEP_RETRY } from "../roots/root-contracts.js";
import type { PackAudit, RunState, SliceResult } from "./sweep-contracts.js";
import { hasRequiredPackDependency } from "./sweep-pack-dependencies.js";
import {
  eligibilityTime,
  progress,
  requireStableEpoch,
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

function* readPackSweepPage(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
  pageRows: number,
): Generator<PackAudit> {
  for (const row of db.iterate(
    `WITH audits AS (
        SELECT ${PACK_COLUMNS}
          FROM git_pack_gc_candidates candidate
         JOIN git_pack_meta pack
           ON pack.repo_id = candidate.repo_id AND pack.pack_id = candidate.pack_id
        WHERE candidate.repo_id = ? AND candidate.pack_id > ?
     )
      SELECT /* pack-sweep-page */ * FROM audits
        WHERE state != 'complete' OR owned != 0 OR marked != 0
          OR unreachable_since_ms <= ?
        ORDER BY pack_id LIMIT ?`,
    run.runId,
    repoId,
    run.cursorOrdinal ?? -1,
    sweepCutoff(nowMs),
    pageRows,
  )) {
    const checked = readPackRow(row, repoId);
    if (checked.candidateSince === null) throw new CorruptError("pack sweep lost candidate age");
    yield checked;
  }
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
    : eligibilityTime(
        expectSafeInteger(row.since, 0, Number.MAX_SAFE_INTEGER, "pack candidate age"),
      );
}

function saveSweepCursor(
  store: SharedRepoStore,
  run: RunState,
  ordinal: number | null,
  marker: string | null,
): RunState {
  const row = store.db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET cursor_ordinal = ?, cursor_text = ?
      WHERE repo_id = ? AND run_id = ? AND phase = 'sweep-packs'
        AND observed_root_epoch = ? AND cursor_checkout_id IS NULL
        AND cursor_ordinal IS ? AND cursor_text IS ?
      RETURNING cursor_ordinal, cursor_text`,
    ordinal,
    marker,
    store.repoId,
    run.runId,
    run.observedRootEpoch,
    run.cursorOrdinal,
    run.cursorText,
  );
  if (row === undefined || row.cursor_ordinal !== ordinal || row.cursor_text !== marker) {
    throw new CorruptError("maintenance pack sweep cursor was not published atomically");
  }
  return { ...run, cursorOrdinal: ordinal, cursorText: marker };
}

export function sweepPacks(
  store: SharedRepoStore,
  run: RunState,
  nowMs: number,
  pageRows: number,
): SliceResult {
  let examined = 0;
  let last = run.cursorOrdinal;
  for (const pack of readPackSweepPage(store.db, store.repoId, run, nowMs, pageRows)) {
    examined++;
    last = pack.packId;
    if (pack.state !== "complete" || pack.owned || pack.marked) {
      deletePackCandidate(store.db, store.repoId, pack.packId);
      const updated = saveSweepCursor(store, run, last, run.cursorText);
      return { progress: progress(updated, updated.phase, "progress"), storageChanged: false };
    }
    const since = pack.candidateSince;
    if (since === null || nowMs < eligibilityTime(since)) {
      throw new CorruptError("pack sweep selected an ineligible candidate");
    }
    if (hasRequiredPackDependency(store.db, store.repoId, pack.packId)) continue;
    deletePackStorage(store, run, pack);
    const counted = updateReclamationCounters(
      store.db,
      store.repoId,
      run,
      pack.count,
      1,
      pack.size,
    );
    const updated = saveSweepCursor(store, counted, last, PACK_SWEEP_RETRY);
    return { progress: progress(updated, updated.phase, "progress"), storageChanged: true };
  }
  if (examined === pageRows) {
    const updated = saveSweepCursor(store, run, last, run.cursorText);
    return { progress: progress(updated, updated.phase, "progress"), storageChanged: false };
  }
  const cleared = saveSweepCursor(store, run, null, null);
  if (run.cursorText === PACK_SWEEP_RETRY) {
    return { progress: progress(cleared, cleared.phase, "progress"), storageChanged: false };
  }
  const packEligible = nextPackEligibility(store.db, store.repoId, run);
  const nextEligibleMs =
    run.nextEligibleMs === null
      ? packEligible
      : packEligible === null
        ? run.nextEligibleMs
        : Math.min(run.nextEligibleMs, packEligible);
  const updated = transitionPhase(store.db, store.repoId, cleared, "finish", nextEligibleMs);
  return { progress: progress(updated, updated.phase, "complete"), storageChanged: false };
}
