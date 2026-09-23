import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { decodeRow, expectSafeInteger, int, nullable, text } from "../../../common/rows.js";
import { bumpRepositorySourceGeneration } from "../../core/source-generation.js";
import type { LooseRow, RunState, SliceResult } from "./sweep-contracts.js";
import {
  eligibilityTime,
  progress,
  requireStableEpoch,
  sweepCutoff,
  transitionPhase,
  updateReclamationCounters,
} from "./sweep-shared.js";

const LOOSE_COLUMNS = `object.repo_id, object.oid, candidate.unreachable_since_ms,
  mark.oid IS NOT NULL AS marked,
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
    candidateSince: decoded.unreachable_since_ms,
  };
}

// One page holds the next loose objects after the cursor whose candidate row is
// wrong or whose grace has elapsed. Each action removes its row from the
// predicate, so nothing behind the cursor needs a second look, and a fresh
// nomination is never eligible at once.
function readLooseActions(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
  pageRows: number,
): LooseRow[] {
  const rows: LooseRow[] = [];
  for (const row of db.iterate(
    `SELECT /* maintenance-loose */ ${LOOSE_COLUMNS}
       FROM git_objects object
       LEFT JOIN git_loose_gc_candidates candidate
         ON candidate.repo_id = object.repo_id AND candidate.oid = object.oid
       LEFT JOIN git_maintenance_objects mark
         ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
      WHERE object.repo_id = ? AND object.oid > ?
        AND CASE WHEN mark.oid IS NOT NULL
                 THEN candidate.oid IS NOT NULL
                 ELSE candidate.oid IS NULL OR candidate.unreachable_since_ms <= ? END
      ORDER BY object.oid COLLATE BINARY LIMIT ?`,
    run.runId,
    repoId,
    run.cursorText ?? "",
    sweepCutoff(nowMs),
    pageRows,
  )) {
    rows.push(readLooseRow(row, repoId));
  }
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
  bumpRepositorySourceGeneration(db, repoId);
}

function nextLooseEligibility(db: SqlDatabase, repoId: number): number | null {
  const since = db.scalar<unknown>(
    "SELECT min(unreachable_since_ms) FROM git_loose_gc_candidates WHERE repo_id = ?",
    repoId,
  );
  return since === null
    ? null
    : eligibilityTime(expectSafeInteger(since, 0, Number.MAX_SAFE_INTEGER, "loose candidate age"));
}

export function advanceLoose(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nowMs: number,
  pageRows: number,
): SliceResult {
  const page = readLooseActions(db, repoId, run, nowMs, pageRows);
  if (page.length === 0) {
    const updated = transitionPhase(db, repoId, run, "packs", nextLooseEligibility(db, repoId));
    return {
      progress: progress(updated, updated.phase, "phase-complete"),
      storageChanged: false,
    };
  }
  deleteLooseCandidates(
    db,
    repoId,
    page.filter((row) => row.marked).map((row) => row.oid),
  );
  insertLooseCandidates(
    db,
    repoId,
    page.filter((row) => !row.marked && row.candidateSince === null).map((row) => row.oid),
    nowMs,
  );
  const doomed = page.filter((row) => !row.marked && row.candidateSince !== null);
  let bytes = 0;
  for (const row of doomed) {
    bytes += row.storedBytes;
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "loose byte count overflow");
  }
  const last = page.at(-1)?.oid ?? null;
  db.run(
    "UPDATE git_maintenance_runs SET cursor_text = ? WHERE repo_id = ? AND run_id = ?",
    last,
    repoId,
    run.runId,
  );
  let updated: RunState = { ...run, cursorText: last };
  if (doomed.length > 0) {
    requireStableEpoch(db, repoId, run);
    deleteLooseObjects(
      db,
      repoId,
      doomed.map((row) => row.oid),
    );
    updated = updateReclamationCounters(db, repoId, updated, doomed.length, 0, bytes);
  }
  return {
    progress: progress(updated, updated.phase, "progress"),
    storageChanged: doomed.length > 0,
  };
}
