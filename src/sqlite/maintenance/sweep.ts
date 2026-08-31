import { CorruptError, GitError } from "../../core/errors.js";
import { decodeRow, int, nullable, oneOf, text } from "../../core/rows.js";
import type { SqlDatabase } from "../db.js";
import type { SharedRepoStore } from "../store.js";
import {
  expectPhase,
  expectRootsSettled,
  type MaintenanceRunView,
  readMaintenanceRunView,
} from "./state.js";

export const GC_GRACE_MS = 1_209_600_000;

const DEFAULT_PAGE_ROWS = 64;
const MAX_PAGE_ROWS = 128;

type SweepPhase =
  | "classify-loose"
  | "repack"
  | "classify-packs"
  | "sweep-loose"
  | "sweep-packs"
  | "finish";

export type MaintenanceSweepStatus = "progress" | "phase-complete" | "complete" | "root-changed";

export interface AdvanceMaintenanceSweepOptions {
  nowMs: number;
  pageRows?: number;
}

export interface MaintenanceSweepProgress {
  runId: number;
  phase: SweepPhase;
  status: MaintenanceSweepStatus;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleMs: number | null;
}

type RunState = MaintenanceRunView & { phase: SweepPhase };

interface LooseRow {
  oid: string;
  storedBytes: number;
  marked: boolean;
  candidateSince: number | null;
}

interface PackAudit {
  packId: number;
  size: number;
  count: number;
  state: "pending" | "complete";
  owned: boolean;
  marked: boolean;
  candidateSince: number | null;
}

interface SliceResult {
  progress: MaintenanceSweepProgress;
  storageChanged: boolean;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

function readRun(db: SqlDatabase, repoId: number): RunState {
  const run = readMaintenanceRunView(db, repoId);
  if (run === null) throw new GitError("ENOTFOUND", "maintenance run does not exist");
  expectPhase(
    run,
    ["classify-loose", "repack", "classify-packs", "sweep-loose", "sweep-packs", "finish"],
    `maintenance sweep cannot advance phase ${run.phase}`,
  );
  expectRootsSettled(run);
  return run;
}

function progress(
  run: RunState,
  phase: SweepPhase,
  status: MaintenanceSweepStatus,
): MaintenanceSweepProgress {
  return {
    runId: run.runId,
    phase,
    status,
    reclaimedObjects: run.reclaimedObjects,
    reclaimedPacks: run.reclaimedPacks,
    reclaimedBytes: run.reclaimedBytes,
    nextEligibleMs: run.nextEligibleMs,
  };
}

function requireStableEpoch(db: SqlDatabase, repoId: number, run: RunState): void {
  const epoch = db.scalar<unknown>(
    "SELECT root_epoch FROM git_maintenance_control WHERE repo_id = ?",
    repoId,
  );
  if (safeInteger(epoch, "destructive maintenance root epoch", 0) !== run.observedRootEpoch) {
    throw new GitError("ESTALE", "maintenance roots changed before storage reclamation");
  }
}

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
        AND ((mark.oid IS NULL AND candidate.oid IS NULL)
          OR (mark.oid IS NOT NULL AND candidate.oid IS NOT NULL))
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

function transitionPhase(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  nextPhase: SweepPhase,
  nextEligibleMs: number | null,
): RunState {
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET phase = ?, next_eligible_ms = ?
      WHERE repo_id = ? AND run_id = ? AND phase = ? AND observed_root_epoch = ?
        AND cursor_checkout_id IS NULL AND cursor_text IS NULL AND cursor_ordinal IS NULL
      RETURNING repo_id, run_id, phase, next_eligible_ms`,
    nextPhase,
    nextEligibleMs,
    repoId,
    run.runId,
    run.phase,
    run.observedRootEpoch,
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.phase !== nextPhase ||
    row.next_eligible_ms !== nextEligibleMs
  ) {
    throw new CorruptError("maintenance phase transition was not published atomically");
  }
  return { ...run, phase: nextPhase, nextEligibleMs };
}

function classifyLoose(
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
    page.filter((row) => row.marked).map((row) => row.oid),
  );
  insertLooseCandidates(
    db,
    repoId,
    page.filter((row) => !row.marked).map((row) => row.oid),
    nowMs,
  );
  return { progress: progress(run, run.phase, "progress"), storageChanged: false };
}

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

function classifyPacks(db: SqlDatabase, repoId: number, run: RunState, nowMs: number): SliceResult {
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

function eligibilityTime(since: number): number {
  if (since > Number.MAX_SAFE_INTEGER - GC_GRACE_MS) {
    throw new GitError("E2BIG", "garbage-collection eligibility time exceeds the safe range");
  }
  return since + GC_GRACE_MS;
}

function sweepCutoff(nowMs: number): number {
  return nowMs < GC_GRACE_MS ? -1 : nowMs - GC_GRACE_MS;
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
        AND (mark.oid IS NOT NULL OR candidate.unreachable_since_ms <= ?)
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

function updateReclamationCounters(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  objects: number,
  packs: number,
  bytes: number,
): RunState {
  if (
    run.reclaimedObjects > Number.MAX_SAFE_INTEGER - objects ||
    run.reclaimedPacks > Number.MAX_SAFE_INTEGER - packs ||
    run.reclaimedBytes > Number.MAX_SAFE_INTEGER - bytes
  ) {
    throw new GitError("E2BIG", "maintenance reclamation counters are exhausted");
  }
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET reclaimed_objects = reclaimed_objects + ?,
            reclaimed_packs = reclaimed_packs + ?, reclaimed_bytes = reclaimed_bytes + ?
      WHERE repo_id = ? AND run_id = ? AND phase = ? AND observed_root_epoch = ?
        AND reclaimed_objects = ? AND reclaimed_packs = ? AND reclaimed_bytes = ?
      RETURNING repo_id, run_id, reclaimed_objects, reclaimed_packs, reclaimed_bytes`,
    objects,
    packs,
    bytes,
    repoId,
    run.runId,
    run.phase,
    run.observedRootEpoch,
    run.reclaimedObjects,
    run.reclaimedPacks,
    run.reclaimedBytes,
  );
  const reclaimedObjects = run.reclaimedObjects + objects;
  const reclaimedPacks = run.reclaimedPacks + packs;
  const reclaimedBytes = run.reclaimedBytes + bytes;
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.reclaimed_objects !== reclaimedObjects ||
    row.reclaimed_packs !== reclaimedPacks ||
    row.reclaimed_bytes !== reclaimedBytes
  ) {
    throw new CorruptError("maintenance reclamation counters were not published atomically");
  }
  return { ...run, reclaimedObjects, reclaimedPacks, reclaimedBytes };
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

function sweepLoose(
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
    page.filter((row) => row.marked).map((row) => row.oid),
  );
  const doomed = page.filter((row) => !row.marked);
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

function sweepPacks(store: SharedRepoStore, run: RunState, nowMs: number): SliceResult {
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

/** Advance one durable WU6 classification, sweep, or phase-transition boundary. */
export function advanceMaintenanceSweep(
  store: SharedRepoStore,
  options: AdvanceMaintenanceSweepOptions,
): MaintenanceSweepProgress {
  const nowMs = options.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new GitError("EINVAL", "maintenance clock must return a non-negative safe integer");
  }
  const pageRows = options.pageRows ?? DEFAULT_PAGE_ROWS;
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > MAX_PAGE_ROWS) {
    throw new GitError("EINVAL", `maintenance sweep page size must be from 1 to ${MAX_PAGE_ROWS}`);
  }
  const result = store.db.transactionSync((): SliceResult => {
    const run = readRun(store.db, store.repoId);
    if (run.observedRootEpoch !== run.rootEpoch) {
      return { progress: progress(run, run.phase, "root-changed"), storageChanged: false };
    }
    if (run.phase === "finish") {
      return { progress: progress(run, run.phase, "complete"), storageChanged: false };
    }
    if (run.phase === "repack") {
      throw new GitError("EINVAL", "maintenance repack phase belongs to the repack coordinator");
    }
    if (run.phase === "classify-loose") {
      return classifyLoose(store.db, store.repoId, run, nowMs, pageRows);
    }
    if (run.phase === "classify-packs") {
      return classifyPacks(store.db, store.repoId, run, nowMs);
    }
    if (run.phase === "sweep-loose") {
      return sweepLoose(store.db, store.repoId, run, nowMs, pageRows);
    }
    return sweepPacks(store, run, nowMs);
  });
  if (result.storageChanged) store.revalidateStorageCaches();
  return result.progress;
}
