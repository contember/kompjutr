import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { decodeRow, int, nullable, text } from "../../common/rows.js";
import type { LooseRow, RunState, SliceResult } from "./sweep-contracts.js";
import {
  eligibilityTime,
  progress,
  requireStableEpoch,
  safeInteger,
  sweepCutoff,
  transitionPhase,
  updateReclamationCounters,
} from "./sweep-shared.js";

// A pack delta resolves its base by OID, so a loose base outlives its own
// reachability for as long as any pack that deltas against it survives. Both
// tables cascade with the pack, so a surviving row means a surviving pack.
const LOOSE_DELTA_BASE = `EXISTS (
      SELECT 1 FROM git_pack_entries child
       WHERE child.repo_id = object.repo_id AND child.base_oid = object.oid)
    OR EXISTS (
      SELECT 1 FROM git_pack_pending pending
       WHERE pending.repo_id = object.repo_id AND pending.base_oid = object.oid)`;

const LOOSE_COLUMNS = `object.repo_id, object.oid, candidate.unreachable_since_ms,
  mark.oid IS NOT NULL AS marked, (${LOOSE_DELTA_BASE}) AS pinned,
  coalesce((SELECT sum(length(chunk.data)) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid), 0) AS stored_bytes`;

function readLooseRow(row: Record<string, unknown>, repoId: number): LooseRow {
  const decoded = decodeRow(
    row,
    {
      repo_id: int(1, Number.MAX_SAFE_INTEGER, "loose maintenance repository is invalid"),
      oid: text("loose maintenance OID is invalid"),
      unreachable_since_ms: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "loose unreachable time is invalid"),
      ),
      marked: int(0, 1, "loose maintenance mark is invalid"),
      pinned: int(0, 1, "loose delta-base pin is invalid"),
      stored_bytes: int(0, Number.MAX_SAFE_INTEGER, "loose stored byte count is invalid"),
    },
    "loose maintenance row is malformed",
  );
  if (decoded.repo_id !== repoId) {
    throw new CorruptError("loose maintenance row crossed repositories");
  }
  return {
    oid: decoded.oid,
    storedBytes: decoded.stored_bytes,
    marked: decoded.marked === 1,
    pinned: decoded.pinned === 1,
    candidateSince: decoded.unreachable_since_ms,
  };
}

function retained(row: LooseRow): boolean {
  return row.marked || row.pinned;
}

function readLooseMismatch(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  pageRows: number,
): LooseRow[] {
  const rows: LooseRow[] = [];
  for (const row of db.iterate(
    `SELECT /* maintenance-classify-loose */ ${LOOSE_COLUMNS}
       FROM git_objects object
       LEFT JOIN git_loose_gc_candidates candidate
         ON candidate.repo_id = object.repo_id AND candidate.oid = object.oid
       LEFT JOIN git_maintenance_objects mark
         ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
      WHERE object.repo_id = ?
        AND (mark.oid IS NOT NULL OR ${LOOSE_DELTA_BASE}) = (candidate.oid IS NOT NULL)
      ORDER BY object.oid COLLATE BINARY LIMIT ?`,
    run.runId,
    repoId,
    pageRows + 1,
  )) {
    rows.push(readLooseRow(row, repoId));
  }
  if (rows.length > pageRows + 1) throw new CorruptError("loose mismatch page exceeded sentinel");
  return rows;
}

function deleteLooseCandidates(db: SqlDatabase, repoId: number, oids: readonly string[]): void {
  if (oids.length === 0) return;
  db.run(
    `DELETE FROM git_loose_gc_candidates
      WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))`,
    repoId,
    JSON.stringify(oids),
  );
}

function insertLooseCandidates(
  db: SqlDatabase,
  repoId: number,
  oids: readonly string[],
  nowMs: number,
): void {
  if (oids.length === 0) return;
  db.run(
    `INSERT OR IGNORE INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
     SELECT ?, value, ? FROM json_each(?)`,
    repoId,
    nowMs,
    JSON.stringify(oids),
  );
}

export function classifyLoose(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
  pageRows: number,
): SliceResult {
  const rows = readLooseMismatch(db, repoId, run, pageRows);
  if (rows.length === 0) {
    const updated = transitionPhase(db, repoId, run, "repack", null);
    return {
      progress: progress(updated, updated.phase, "phase-complete"),
      storageChanged: false,
    };
  }
  const page = rows.slice(0, pageRows);
  deleteLooseCandidates(
    db,
    repoId,
    page.filter(retained).map((row) => row.oid),
  );
  insertLooseCandidates(
    db,
    repoId,
    page.filter((row) => !retained(row)).map((row) => row.oid),
    nowMs,
  );
  return { progress: progress(run, run.phase, "progress"), storageChanged: false };
}

function readLooseSweepActions(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
  pageRows: number,
): LooseRow[] {
  const rows: LooseRow[] = [];
  for (const row of db.iterate(
    `SELECT /* maintenance-sweep-loose */ ${LOOSE_COLUMNS}
       FROM git_loose_gc_candidates candidate
       JOIN git_objects object
         ON object.repo_id = candidate.repo_id AND object.oid = candidate.oid
       LEFT JOIN git_maintenance_objects mark
         ON mark.repo_id = candidate.repo_id AND mark.run_id = ? AND mark.oid = candidate.oid
      WHERE candidate.repo_id = ?
        AND (mark.oid IS NOT NULL OR ${LOOSE_DELTA_BASE}
          OR candidate.unreachable_since_ms <= ?)
      ORDER BY candidate.oid COLLATE BINARY LIMIT ?`,
    run.runId,
    repoId,
    sweepCutoff(nowMs),
    pageRows + 1,
  )) {
    const checked = readLooseRow(row, repoId);
    if (checked.candidateSince === null) throw new CorruptError("loose sweep lost candidate age");
    rows.push(checked);
  }
  if (rows.length > pageRows + 1) throw new CorruptError("loose sweep page exceeded sentinel");
  return rows;
}

function deleteLooseObjects(db: SqlDatabase, repoId: number, oids: readonly string[]): void {
  if (oids.length === 0) return;
  const payload = JSON.stringify(oids);
  db.run(
    `DELETE FROM git_blob_ids
      WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_objects packed
          JOIN git_pack_meta pack
            ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
           AND pack.state = 'complete'
          WHERE packed.repo_id = git_blob_ids.repo_id AND packed.oid = git_blob_ids.oid
        )`,
    repoId,
    payload,
  );
  db.run(
    `DELETE FROM git_commits
      WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_objects packed
          JOIN git_pack_meta pack
            ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
           AND pack.state = 'complete'
          WHERE packed.repo_id = git_commits.repo_id AND packed.oid = git_commits.oid
            AND packed.type = 'commit' AND packed.size = git_commits.object_size
        )`,
    repoId,
    payload,
  );
  db.run(
    "DELETE FROM git_objects WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
    repoId,
    payload,
  );
}

function nextLooseEligibility(db: SqlDatabase, repoId: number, run: RunState): number | null {
  const row = db.one<Record<string, unknown>>(
    `SELECT min(candidate.unreachable_since_ms) AS since,
            EXISTS(
              SELECT 1 FROM git_loose_gc_candidates candidate
              JOIN git_maintenance_objects mark
                ON mark.repo_id = candidate.repo_id AND mark.run_id = ? AND mark.oid = candidate.oid
              WHERE candidate.repo_id = ?
            ) AS marked
       FROM git_loose_gc_candidates candidate WHERE candidate.repo_id = ?`,
    run.runId,
    repoId,
    repoId,
  );
  if (row === undefined || row.marked !== 0) {
    throw new CorruptError("loose sweep completion retained an actionable candidate");
  }
  return row.since === null
    ? null
    : eligibilityTime(safeInteger(row.since, "loose candidate age", 0));
}

export function sweepLoose(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
  pageRows: number,
): SliceResult {
  const rows = readLooseSweepActions(db, repoId, run, nowMs, pageRows);
  if (rows.length === 0) {
    const eligible = nextLooseEligibility(db, repoId, run);
    const updated = transitionPhase(db, repoId, run, "sweep-packs", eligible);
    return {
      progress: progress(updated, updated.phase, "phase-complete"),
      storageChanged: false,
    };
  }
  const page = rows.slice(0, pageRows);
  deleteLooseCandidates(
    db,
    repoId,
    page.filter(retained).map((row) => row.oid),
  );
  const doomed = page.filter((row) => !retained(row));
  let bytes = 0;
  for (const row of doomed) {
    bytes += row.storedBytes;
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "loose byte count overflow");
  }
  let updated = run;
  if (doomed.length > 0) {
    requireStableEpoch(db, repoId, run);
    deleteLooseObjects(
      db,
      repoId,
      doomed.map((row) => row.oid),
    );
    updated = updateReclamationCounters(db, repoId, run, doomed.length, 0, bytes);
  }
  return {
    progress: progress(updated, updated.phase, "progress"),
    storageChanged: doomed.length > 0,
  };
}
