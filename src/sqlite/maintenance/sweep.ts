import { isOid } from "../../core/bytes.js";
import { CorruptError, GitError } from "../../core/errors.js";
import type { ObjectType } from "../../core/objects.js";
import type { SqlDatabase } from "../db.js";
import { PACK_CHUNK } from "../packs.js";
import type { SharedRepoStore } from "../store.js";

export const GC_GRACE_MS = 1_209_600_000;

const DEFAULT_PAGE_ROWS = 64;
const MAX_PAGE_ROWS = 128;
const OBJECT_CHUNK_BYTES = 1024 * 1024;

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

interface RunState {
  runId: number;
  observedRootEpoch: number;
  rootEpoch: number;
  phase: SweepPhase;
  reachableObjects: number;
  queuedObjects: number;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleMs: number | null;
}

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
  members: number;
  invalidMembers: number;
  invalidMarks: number;
  dataRows: number;
  storedBytes: number;
  pendingRows: number;
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

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label, 0);
}

function booleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} is not boolean`);
  return value === 1;
}

function oidField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) throw new CorruptError(`${label} is invalid`);
  return value;
}

function objectType(value: unknown, label: string): ObjectType {
  if (value !== "blob" && value !== "tree" && value !== "commit" && value !== "tag") {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

function phaseField(value: unknown): SweepPhase {
  if (
    value !== "classify-loose" &&
    value !== "repack" &&
    value !== "classify-packs" &&
    value !== "sweep-loose" &&
    value !== "sweep-packs" &&
    value !== "finish"
  ) {
    throw new GitError("EINVAL", `maintenance sweep cannot advance phase ${String(value)}`);
  }
  return value;
}

function readRun(db: SqlDatabase, repoId: number): RunState {
  const row = db.one<Record<string, unknown>>(
    `SELECT run.repo_id, run.run_id, run.observed_root_epoch, run.phase, run.started_ms,
            run.root_source,
            run.cursor_checkout_id, run.cursor_text, run.cursor_ordinal,
            run.reachable_objects, run.queued_objects, run.repacked_objects, run.reclaimed_objects,
            run.reclaimed_packs, run.reclaimed_bytes, run.next_eligible_ms,
            run.restarted, control.root_epoch,
            (SELECT count(*) FROM git_maintenance_objects mark
              WHERE mark.repo_id = run.repo_id AND mark.run_id = run.run_id
                AND mark.physical_only = 0) AS logical_marks,
            EXISTS (SELECT 1 FROM git_maintenance_objects mark
              WHERE mark.repo_id = run.repo_id AND mark.run_id = run.run_id AND (
                typeof(mark.oid) != 'text' OR length(CAST(mark.oid AS BLOB)) != 40 OR
                mark.oid GLOB '*[^0-9a-f]*' OR
                typeof(mark.source_mask) != 'integer' OR mark.source_mask < 0 OR
                mark.source_mask > ? OR mark.expanded != 1 OR
                mark.shallow_boundary NOT IN (0, 1) OR mark.physical_only NOT IN (0, 1) OR
                typeof(mark.edge_cursor) != 'integer' OR mark.edge_cursor < 0 OR
                mark.edge_cursor > ? OR NOT EXISTS (
                  SELECT 1 FROM git_objects loose
                   WHERE loose.repo_id = mark.repo_id AND loose.oid = mark.oid
                  UNION ALL
                  SELECT 1 FROM git_pack_objects packed
                  JOIN git_pack_meta pack
                    ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
                   AND pack.state = 'complete'
                   WHERE packed.repo_id = mark.repo_id AND packed.oid = mark.oid
                )
              )) AS invalid_marks
       FROM git_maintenance_runs run
       JOIN git_maintenance_control control ON control.repo_id = run.repo_id
      WHERE run.repo_id = ?`,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    repoId,
  );
  if (row === undefined) throw new GitError("ENOTFOUND", "maintenance run does not exist");
  if (row.repo_id !== repoId) throw new CorruptError("maintenance sweep crossed repositories");
  if (
    row.root_source !== "done" ||
    row.cursor_checkout_id !== null ||
    row.cursor_text !== null ||
    row.cursor_ordinal !== null
  ) {
    throw new CorruptError("maintenance sweep retained root discovery state");
  }
  const run: RunState = {
    runId: safeInteger(row.run_id, "maintenance run id", 1),
    observedRootEpoch: safeInteger(row.observed_root_epoch, "observed root epoch", 0),
    rootEpoch: safeInteger(row.root_epoch, "current root epoch", 0),
    phase: phaseField(row.phase),
    reachableObjects: safeInteger(row.reachable_objects, "reachable object count", 0),
    queuedObjects: safeInteger(row.queued_objects, "queued object count", 0),
    reclaimedObjects: safeInteger(row.reclaimed_objects, "reclaimed object count", 0),
    reclaimedPacks: safeInteger(row.reclaimed_packs, "reclaimed pack count", 0),
    reclaimedBytes: safeInteger(row.reclaimed_bytes, "reclaimed byte count", 0),
    nextEligibleMs: nullableInteger(row.next_eligible_ms, "next eligible time"),
  };
  safeInteger(row.started_ms, "maintenance start time", 0);
  safeInteger(row.repacked_objects, "repacked object count", 0);
  booleanInteger(row.restarted, "maintenance restart marker");
  const logicalMarks = safeInteger(row.logical_marks, "logical maintenance mark count", 0);
  if (row.invalid_marks !== 0 || logicalMarks !== run.reachableObjects) {
    throw new CorruptError("maintenance marks do not match the completed reachability run");
  }
  if (run.queuedObjects !== 0) {
    throw new CorruptError("maintenance sweep started with queued reachability objects");
  }
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

function validateMark(row: Record<string, unknown>): boolean {
  if (row.mark_oid === null) {
    if (row.mark_expanded !== null || row.mark_physical_only !== null) {
      throw new CorruptError("absent maintenance mark returned traversal state");
    }
    return false;
  }
  oidField(row.mark_oid, "maintenance mark OID");
  if (!booleanInteger(row.mark_expanded, "maintenance expanded marker")) {
    throw new CorruptError("maintenance classification observed an unexpanded mark");
  }
  booleanInteger(row.mark_physical_only, "maintenance physical-only marker");
  return true;
}

const LOOSE_COLUMNS = `object.repo_id, object.oid, object.type, object.size, object.stored,
  lifecycle.oid AS lifecycle_oid, lifecycle.created_ms,
  candidate.oid AS candidate_oid, candidate.unreachable_since_ms,
  mark.oid AS mark_oid, mark.expanded AS mark_expanded,
  mark.physical_only AS mark_physical_only,
  (SELECT count(*) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) AS chunk_rows,
  (SELECT min(CASE WHEN typeof(seq) = 'integer' AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    THEN seq ELSE NULL END) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) AS first_chunk,
  (SELECT max(CASE WHEN typeof(seq) = 'integer' AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    THEN seq ELSE NULL END) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) AS last_chunk,
  (SELECT count(*) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid
      AND CASE
        WHEN typeof(chunk.seq) != 'integer' OR chunk.seq < 0
          OR chunk.seq > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN typeof(chunk.data) != 'blob' THEN 1
        WHEN length(chunk.data) > ${OBJECT_CHUNK_BYTES} THEN 1
        ELSE 0
      END != 0) AS invalid_chunks,
  coalesce((SELECT max(CASE
      WHEN typeof(data) = 'blob' AND length(data) <= ${OBJECT_CHUNK_BYTES}
        THEN length(data) ELSE 0 END) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid), 0) AS largest_chunk,
  coalesce((SELECT sum(CASE
      WHEN typeof(data) = 'blob' AND length(data) <= ${OBJECT_CHUNK_BYTES}
        THEN length(data) ELSE 0 END) FROM git_object_chunks chunk
    WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid), 0) AS stored_bytes`;

function validateLooseRow(
  row: Record<string, unknown>,
  repoId: number,
  previousOid: string | null,
): LooseRow {
  if (row.repo_id !== repoId) throw new CorruptError("loose maintenance row crossed repositories");
  const oid = oidField(row.oid, "loose maintenance OID");
  if (previousOid !== null && oid <= previousOid) {
    throw new CorruptError("loose maintenance page is not in deterministic order");
  }
  objectType(row.type, "loose maintenance object type");
  const size = safeInteger(row.size, "loose maintenance object size", 0);
  if (row.stored !== "raw" && row.stored !== "zlib") {
    throw new CorruptError("loose maintenance object encoding is invalid");
  }
  if (row.lifecycle_oid !== oid) throw new CorruptError("loose object has no lifecycle row");
  safeInteger(row.created_ms, "loose object creation time", 0);
  const invalidChunks = safeInteger(row.invalid_chunks, "invalid loose object chunk count", 0);
  if (invalidChunks !== 0) throw new CorruptError("loose object has invalid chunk rows");
  const chunkRows = safeInteger(row.chunk_rows, "loose object chunk count", 1);
  const storedBytes = safeInteger(row.stored_bytes, "loose object stored bytes", 0);
  const largestChunk = safeInteger(row.largest_chunk, "loose object largest chunk", 0);
  if (
    row.first_chunk !== 0 ||
    row.last_chunk !== chunkRows - 1 ||
    largestChunk > OBJECT_CHUNK_BYTES ||
    (row.stored === "raw" && storedBytes !== size) ||
    (row.stored === "zlib" && storedBytes === 0)
  ) {
    throw new CorruptError("loose maintenance object has invalid chunk metadata");
  }
  let candidateSince: number | null = null;
  if (row.candidate_oid === null) {
    if (row.unreachable_since_ms !== null) {
      throw new CorruptError("absent loose candidate returned a timestamp");
    }
  } else {
    if (row.candidate_oid !== oid) throw new CorruptError("loose candidate crossed objects");
    candidateSince = safeInteger(row.unreachable_since_ms, "loose unreachable time", 0);
  }
  return { oid, storedBytes, marked: validateMark(row), candidateSince };
}

function readLooseMismatch(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  pageRows: number,
): LooseRow[] {
  const rows: LooseRow[] = [];
  let previous: string | null = null;
  for (const row of db.iterate(
    `SELECT /* maintenance-classify-loose */ ${LOOSE_COLUMNS}
       FROM git_objects object
       LEFT JOIN git_loose_object_lifecycle lifecycle
         ON lifecycle.repo_id = object.repo_id AND lifecycle.oid = object.oid
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
    const checked = validateLooseRow(row, repoId, previous);
    rows.push(checked);
    previous = checked.oid;
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

function requireLooseStorageValid(db: SqlDatabase, repoId: number): void {
  const invalid = db.scalar<unknown>(
    `SELECT EXISTS(
       SELECT 1 FROM git_objects object
       LEFT JOIN git_loose_object_lifecycle lifecycle
         ON lifecycle.repo_id = object.repo_id AND lifecycle.oid = object.oid
       WHERE object.repo_id = ? AND (
         typeof(object.oid) != 'text' OR length(CAST(object.oid AS BLOB)) != 40 OR
         object.oid GLOB '*[^0-9a-f]*' OR
         object.type NOT IN ('blob','tree','commit','tag') OR
         typeof(object.size) != 'integer' OR object.size < 0 OR object.size > ? OR
         object.stored NOT IN ('raw','zlib') OR
         lifecycle.oid IS NULL OR
         typeof(lifecycle.created_ms) != 'integer' OR lifecycle.created_ms < 0 OR
         lifecycle.created_ms > ? OR
         EXISTS (SELECT 1 FROM git_loose_gc_candidates candidate
           WHERE candidate.repo_id = object.repo_id AND candidate.oid = object.oid
             AND (typeof(candidate.unreachable_since_ms) != 'integer'
               OR candidate.unreachable_since_ms < 0 OR candidate.unreachable_since_ms > ?)) OR
         EXISTS (SELECT 1 FROM git_maintenance_objects mark
           WHERE mark.repo_id = object.repo_id AND mark.oid = object.oid
             AND (mark.expanded != 1 OR mark.physical_only NOT IN (0, 1))) OR
         EXISTS (SELECT 1 FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid
             AND CASE
               WHEN typeof(chunk.seq) != 'integer' OR chunk.seq < 0
                 OR chunk.seq > ? THEN 1
               WHEN typeof(chunk.data) != 'blob' THEN 1
               WHEN length(chunk.data) > ? THEN 1
               ELSE 0
             END != 0) OR
         (SELECT count(*) FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) < 1 OR
         (SELECT min(seq) FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) != 0 OR
         (SELECT max(seq) + 1 FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) !=
         (SELECT count(*) FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid) OR
         (object.stored = 'raw' AND coalesce((SELECT sum(CASE
           WHEN typeof(data) = 'blob' AND length(data) <= ? THEN length(data) ELSE 0 END)
           FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid), 0) != object.size) OR
         (object.stored = 'zlib' AND coalesce((SELECT sum(CASE
           WHEN typeof(data) = 'blob' AND length(data) <= ? THEN length(data) ELSE 0 END)
           FROM git_object_chunks chunk
           WHERE chunk.repo_id = object.repo_id AND chunk.oid = object.oid), 0) = 0)
       )
       UNION ALL
       SELECT 1 FROM git_loose_gc_candidates candidate
       LEFT JOIN git_objects object
         ON object.repo_id = candidate.repo_id AND object.oid = candidate.oid
       WHERE candidate.repo_id = ? AND object.oid IS NULL
    )`,
    repoId,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    OBJECT_CHUNK_BYTES,
    OBJECT_CHUNK_BYTES,
    OBJECT_CHUNK_BYTES,
    repoId,
  );
  if (invalid !== 0) throw new CorruptError("loose maintenance storage audit failed");
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
    requireLooseStorageValid(db, repoId);
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

const PACK_AUDIT_COLUMNS = `pack.repo_id, pack.pack_id, pack.size, pack.count, pack.state, pack.created,
  candidate.pack_id AS candidate_pack_id, candidate.unreachable_since_ms,
  CASE WHEN pack.pack_id IS NULL
    OR typeof(pack.pack_id) != 'integer' OR pack.pack_id < 0 OR pack.pack_id > ${Number.MAX_SAFE_INTEGER}
    OR typeof(pack.size) != 'integer' OR pack.size < 0 OR pack.size > ${Number.MAX_SAFE_INTEGER}
    OR typeof(pack.count) != 'integer' OR pack.count < 0 OR pack.count > ${Number.MAX_SAFE_INTEGER}
    OR pack.state NOT IN ('pending','complete')
    OR typeof(pack.created) != 'integer' OR pack.created < 0 OR pack.created > ${Number.MAX_SAFE_INTEGER}
    THEN 1 ELSE 0 END AS invalid_pack,
  CASE WHEN candidate.pack_id IS NOT NULL AND (
    typeof(candidate.pack_id) != 'integer' OR candidate.pack_id != pack.pack_id
    OR typeof(candidate.unreachable_since_ms) != 'integer'
    OR candidate.unreachable_since_ms < 0
    OR candidate.unreachable_since_ms > ${Number.MAX_SAFE_INTEGER})
    THEN 1 ELSE 0 END AS invalid_candidate,
  EXISTS (SELECT 1 FROM git_maintenance_repack_batches batch
    WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id) AS owned,
  (SELECT count(*) FROM git_pack_entries entry
    WHERE entry.repo_id = pack.repo_id AND entry.pack_id = pack.pack_id) AS members,
  EXISTS (
    SELECT 1 FROM git_pack_objects object
    JOIN git_maintenance_objects mark
      ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
    WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
  ) AS marked,
  (SELECT count(*) FROM git_pack_objects object
    JOIN git_maintenance_objects mark
      ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
    WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
      AND (mark.expanded != 1 OR mark.physical_only NOT IN (0, 1))) AS invalid_marks,
  ((SELECT count(*) FROM git_pack_entries object
    WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
      AND CASE
        WHEN typeof(object.oid) != 'text' THEN 1
        WHEN length(CAST(object.oid AS BLOB)) != 40 OR object.oid GLOB '*[^0-9a-f]*' THEN 1
        WHEN typeof(object.offset) != 'integer' OR object.offset < 0
          OR object.offset > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN typeof(object.data_off) != 'integer' OR object.data_off < object.offset
          OR object.data_off > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN typeof(object.data_len) != 'integer' OR object.data_len < 0
          OR object.data_len > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN typeof(object.size) != 'integer' OR object.size < 0
          OR object.size > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN typeof(object.entry_size) != 'integer' OR object.entry_size < 0
          OR object.entry_size > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN object.data_off > ${Number.MAX_SAFE_INTEGER} - object.data_len
          OR object.data_off + object.data_len > pack.size THEN 1
        WHEN typeof(object.type) != 'text'
          OR object.type NOT IN ('blob','tree','commit','tag') THEN 1
        WHEN object.base_oid IS NOT NULL AND typeof(object.base_oid) != 'text' THEN 1
        WHEN object.base_oid IS NOT NULL AND (length(CAST(object.base_oid AS BLOB)) != 40
          OR object.base_oid GLOB '*[^0-9a-f]*') THEN 1
        ELSE 0
      END != 0
  ) + (SELECT count(*) FROM git_pack_objects object
    WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
      AND (
        CASE
          WHEN typeof(object.oid) != 'text' THEN 1
          WHEN length(CAST(object.oid AS BLOB)) != 40 OR object.oid GLOB '*[^0-9a-f]*' THEN 1
          WHEN typeof(object.offset) != 'integer' OR object.offset < 0
            OR object.offset > ${Number.MAX_SAFE_INTEGER} THEN 1
          WHEN typeof(object.data_off) != 'integer' OR object.data_off < object.offset
            OR object.data_off > ${Number.MAX_SAFE_INTEGER} THEN 1
          WHEN typeof(object.data_len) != 'integer' OR object.data_len < 0
            OR object.data_len > ${Number.MAX_SAFE_INTEGER} THEN 1
          WHEN typeof(object.size) != 'integer' OR object.size < 0
            OR object.size > ${Number.MAX_SAFE_INTEGER} THEN 1
          WHEN typeof(object.entry_size) != 'integer' OR object.entry_size < 0
            OR object.entry_size > ${Number.MAX_SAFE_INTEGER} THEN 1
          WHEN object.data_off > ${Number.MAX_SAFE_INTEGER} - object.data_len
            OR object.data_off + object.data_len > pack.size THEN 1
          WHEN typeof(object.type) != 'text'
            OR object.type NOT IN ('blob','tree','commit','tag') THEN 1
          WHEN object.base_oid IS NOT NULL AND typeof(object.base_oid) != 'text' THEN 1
          WHEN object.base_oid IS NOT NULL AND (length(CAST(object.base_oid AS BLOB)) != 40
            OR object.base_oid GLOB '*[^0-9a-f]*') THEN 1
          ELSE 0
        END != 0
        OR NOT EXISTS (
          SELECT 1 FROM git_pack_entries entry
           WHERE entry.repo_id = object.repo_id AND entry.pack_id = object.pack_id
             AND entry.oid = object.oid AND entry.offset = object.offset
             AND entry.data_off = object.data_off AND entry.data_len = object.data_len
             AND entry.type = object.type AND entry.size = object.size
             AND entry.entry_size = object.entry_size
             AND entry.base_oid IS object.base_oid
        )
      )
  )) AS invalid_members,
  (SELECT count(*) FROM git_pack_data data
    WHERE data.repo_id = pack.repo_id AND data.pack_id = pack.pack_id) AS data_rows,
  (SELECT min(CASE WHEN typeof(seq) = 'integer' AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    THEN seq ELSE NULL END) FROM git_pack_data data
    WHERE data.repo_id = pack.repo_id AND data.pack_id = pack.pack_id) AS first_data,
  (SELECT max(CASE WHEN typeof(seq) = 'integer' AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    THEN seq ELSE NULL END) FROM git_pack_data data
    WHERE data.repo_id = pack.repo_id AND data.pack_id = pack.pack_id) AS last_data,
  coalesce((SELECT sum(CASE
      WHEN typeof(chunk.data) = 'blob' AND length(chunk.data) <= ${PACK_CHUNK}
        THEN length(chunk.data) ELSE 0 END) FROM git_pack_data chunk
    WHERE chunk.repo_id = pack.repo_id AND chunk.pack_id = pack.pack_id), 0) AS stored_bytes,
  (SELECT count(*) FROM git_pack_data chunk
    WHERE chunk.repo_id = pack.repo_id AND chunk.pack_id = pack.pack_id
      AND CASE
        WHEN typeof(chunk.seq) != 'integer' OR chunk.seq < 0
          OR chunk.seq > ${Number.MAX_SAFE_INTEGER} THEN 1
        WHEN typeof(chunk.data) != 'blob' THEN 1
        WHEN length(chunk.data) > ${PACK_CHUNK} THEN 1
        ELSE 0
      END != 0) AS invalid_data,
  (SELECT count(*) FROM git_pack_pending pending
    WHERE pending.repo_id = pack.repo_id AND pending.pack_id = pack.pack_id) AS pending_rows`;

function validatePackAudit(
  row: Record<string, unknown>,
  repoId: number,
  previousPackId: number | null,
): PackAudit {
  if (row.repo_id !== repoId) throw new CorruptError("pack audit crossed repositories");
  const packId = safeInteger(row.pack_id, "maintenance pack id", 0);
  if (previousPackId !== null && packId <= previousPackId) {
    throw new CorruptError("pack audit is not in deterministic order");
  }
  const state = row.state;
  if (state !== "pending" && state !== "complete") throw new CorruptError("invalid pack state");
  safeInteger(row.created, "maintenance pack creation time", 0);
  if (row.invalid_pack !== 0 || row.invalid_candidate !== 0) {
    throw new CorruptError(`pack ${packId} has invalid maintenance metadata`);
  }
  const count = safeInteger(row.count, "maintenance pack object count", 0);
  const members = safeInteger(row.members, "maintenance pack membership count", 0);
  const invalidMembers = safeInteger(row.invalid_members, "invalid pack membership count", 0);
  const invalidMarks = safeInteger(row.invalid_marks, "invalid pack mark count", 0);
  const dataRows = safeInteger(row.data_rows, "maintenance pack data count", 0);
  const storedBytes = safeInteger(row.stored_bytes, "maintenance pack stored bytes", 0);
  const invalidData = safeInteger(row.invalid_data, "invalid pack data count", 0);
  const pendingRows = safeInteger(row.pending_rows, "maintenance pending pack row count", 0);
  if (
    state === "complete" &&
    (members !== count ||
      invalidMembers !== 0 ||
      invalidMarks !== 0 ||
      dataRows < 1 ||
      row.first_data !== 0 ||
      row.last_data !== dataRows - 1 ||
      storedBytes !== row.size ||
      invalidData !== 0 ||
      pendingRows !== 0)
  ) {
    throw new CorruptError(`complete pack ${packId} has invalid membership metadata`);
  }
  let candidateSince: number | null = null;
  if (row.candidate_pack_id === null) {
    if (row.unreachable_since_ms !== null) {
      throw new CorruptError("absent pack candidate returned a timestamp");
    }
  } else {
    if (row.candidate_pack_id !== packId) throw new CorruptError("pack candidate crossed packs");
    candidateSince = safeInteger(row.unreachable_since_ms, "pack unreachable time", 0);
  }
  return {
    packId,
    size: safeInteger(row.size, "maintenance pack size", 0),
    count,
    state,
    owned: booleanInteger(row.owned, "maintenance pack ownership marker"),
    marked: booleanInteger(row.marked, "maintenance pack mark marker"),
    members,
    invalidMembers,
    invalidMarks,
    dataRows,
    storedBytes,
    pendingRows,
    candidateSince,
  };
}

function readPackClassificationMismatch(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
): PackAudit | null {
  let result: PackAudit | null = null;
  let previous: number | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `WITH audits AS (
       SELECT ${PACK_AUDIT_COLUMNS}
         FROM git_pack_meta pack
         LEFT JOIN git_pack_gc_candidates candidate
           ON candidate.repo_id = pack.repo_id AND candidate.pack_id = pack.pack_id
        WHERE pack.repo_id = ?
     )
     SELECT * FROM audits
      WHERE invalid_pack != 0 OR invalid_candidate != 0
         OR (state != 'complete' AND candidate_pack_id IS NOT NULL)
         OR (owned != 0 AND candidate_pack_id IS NOT NULL)
         OR (state = 'complete' AND (members != count OR invalid_members != 0
           OR data_rows < 1 OR first_data != 0 OR last_data != data_rows - 1
           OR stored_bytes != size OR invalid_data != 0 OR pending_rows != 0))
         OR (state = 'complete' AND invalid_marks != 0)
         OR (state = 'complete' AND owned = 0 AND marked = 0 AND candidate_pack_id IS NULL)
         OR (state = 'complete' AND marked != 0 AND candidate_pack_id IS NOT NULL)
      ORDER BY pack_id LIMIT 2`,
    run.runId,
    run.runId,
    repoId,
  )) {
    const checked = validatePackAudit(row, repoId, previous);
    result ??= checked;
    previous = checked.packId;
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
    const orphanCandidate = db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_pack_gc_candidates candidate
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = candidate.repo_id AND pack.pack_id = candidate.pack_id
        WHERE candidate.repo_id = ? AND pack.pack_id IS NULL
       )`,
      repoId,
    );
    if (orphanCandidate !== 0) throw new CorruptError("pack candidate has no storage pack");
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
  let previous: string | null = null;
  for (const row of db.iterate(
    `SELECT /* maintenance-sweep-loose */ ${LOOSE_COLUMNS}
       FROM git_loose_gc_candidates candidate
       LEFT JOIN git_objects object
         ON object.repo_id = candidate.repo_id AND object.oid = candidate.oid
       LEFT JOIN git_loose_object_lifecycle lifecycle
         ON lifecycle.repo_id = object.repo_id AND lifecycle.oid = object.oid
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
    const checked = validateLooseRow(row, repoId, previous);
    if (checked.candidateSince === null) throw new CorruptError("loose sweep lost candidate age");
    rows.push(checked);
    previous = checked.oid;
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
  const remains = db.scalar<unknown>(
    `SELECT EXISTS(
       SELECT 1 FROM git_objects WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
       UNION ALL SELECT 1 FROM git_loose_object_lifecycle
        WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
       UNION ALL SELECT 1 FROM git_loose_gc_candidates
        WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
       UNION ALL SELECT 1 FROM git_tree_sources
        WHERE repo_id = ? AND storage = 'loose'
          AND tree_oid IN (SELECT value FROM json_each(?))
       UNION ALL SELECT 1 FROM git_blob_ids mapping
        WHERE mapping.repo_id = ? AND mapping.oid IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_objects packed
            JOIN git_pack_meta pack
              ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
             AND pack.state = 'complete'
            WHERE packed.repo_id = mapping.repo_id AND packed.oid = mapping.oid
          )
       UNION ALL SELECT 1 FROM git_commits cached
        WHERE cached.repo_id = ? AND cached.oid IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_objects packed
            JOIN git_pack_meta pack
              ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
             AND pack.state = 'complete'
            WHERE packed.repo_id = cached.repo_id AND packed.oid = cached.oid
              AND packed.type = 'commit' AND packed.size = cached.object_size
          )
     )`,
    repoId,
    payload,
    repoId,
    payload,
    repoId,
    payload,
    repoId,
    payload,
    repoId,
    payload,
    repoId,
    payload,
  );
  if (remains !== 0) {
    throw new CorruptError("loose object reclamation left authoritative storage rows");
  }
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
  requireLooseStorageValid(db, repoId);
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
  let previous: number | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `WITH audits AS (
       SELECT ${PACK_AUDIT_COLUMNS}
         FROM git_pack_gc_candidates candidate
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = candidate.repo_id AND pack.pack_id = candidate.pack_id
        WHERE candidate.repo_id = ?
     )
     SELECT * FROM audits
      WHERE invalid_pack != 0 OR invalid_candidate != 0
         OR state != 'complete' OR owned != 0 OR marked != 0
         OR members != count OR invalid_members != 0
         OR data_rows < 1 OR first_data != 0 OR last_data != data_rows - 1
         OR stored_bytes != size OR invalid_data != 0 OR pending_rows != 0
         OR invalid_marks != 0
         OR unreachable_since_ms <= ?
      ORDER BY pack_id LIMIT 2`,
    run.runId,
    run.runId,
    repoId,
    sweepCutoff(nowMs),
  )) {
    const checked = validatePackAudit(row, repoId, previous);
    if (checked.candidateSince === null) throw new CorruptError("pack sweep lost candidate age");
    result ??= checked;
    previous = checked.packId;
    rows++;
  }
  if (rows > 2) throw new CorruptError("pack sweep action exceeded sentinel");
  return result;
}

function deletePackStorage(store: SharedRepoStore, run: RunState, pack: PackAudit): void {
  requireStableEpoch(store.db, store.repoId, run);
  const audit = store.db.one<Record<string, unknown>>(
    `SELECT pack.state, pack.size, pack.count, candidate.unreachable_since_ms,
            EXISTS (SELECT 1 FROM git_maintenance_repack_batches batch
              WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id) AS owned,
            (SELECT count(*) FROM git_pack_entries entry
              WHERE entry.repo_id = pack.repo_id AND entry.pack_id = pack.pack_id) AS members,
            (SELECT count(*) FROM git_pack_pending pending
              WHERE pending.repo_id = pack.repo_id AND pending.pack_id = pack.pack_id) AS pending_rows,
            EXISTS (
              SELECT 1 FROM git_pack_objects object
              JOIN git_maintenance_objects mark
                ON mark.repo_id = object.repo_id AND mark.run_id = ? AND mark.oid = object.oid
              WHERE object.repo_id = pack.repo_id AND object.pack_id = pack.pack_id
            ) AS marked
       FROM git_pack_meta pack
       JOIN git_pack_gc_candidates candidate
         ON candidate.repo_id = pack.repo_id AND candidate.pack_id = pack.pack_id
      WHERE pack.repo_id = ? AND pack.pack_id = ?`,
    run.runId,
    store.repoId,
    pack.packId,
  );
  if (
    audit === undefined ||
    audit.state !== "complete" ||
    audit.size !== pack.size ||
    audit.count !== pack.count ||
    audit.unreachable_since_ms !== pack.candidateSince ||
    audit.owned !== 0 ||
    audit.marked !== 0 ||
    safeInteger(audit.members, "pack deletion member count", 0) !== pack.count ||
    safeInteger(audit.pending_rows, "pack deletion pending row count", 0) !== pack.pendingRows
  ) {
    throw new CorruptError("pack deletion preflight changed after classification");
  }
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
  const staleBlobIds = store.db.scalar<unknown>(
    `SELECT EXISTS(
       SELECT 1 FROM git_blob_ids mapping
       JOIN git_pack_objects packed
         ON packed.repo_id = mapping.repo_id AND packed.oid = mapping.oid
      WHERE packed.repo_id = ? AND packed.pack_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM git_objects loose
           WHERE loose.repo_id = mapping.repo_id AND loose.oid = mapping.oid
        )
     )`,
    store.repoId,
    pack.packId,
  );
  if (staleBlobIds !== 0) {
    throw new CorruptError("pack reclamation retained a stale blob-id mapping");
  }
  if (store.packs.deleteCompletePacks([pack.packId]) !== 1) {
    throw new CorruptError("complete pack deletion did not remove exactly one pack");
  }
  const remains = store.db.scalar<unknown>(
    `SELECT EXISTS(
       SELECT 1 FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?
       UNION ALL SELECT 1 FROM git_pack_data WHERE repo_id = ? AND pack_id = ?
       UNION ALL SELECT 1 FROM git_pack_entries WHERE repo_id = ? AND pack_id = ?
       UNION ALL SELECT 1 FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?
       UNION ALL SELECT 1 FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?
       UNION ALL SELECT 1 FROM git_pack_gc_candidates WHERE repo_id = ? AND pack_id = ?
       UNION ALL SELECT 1 FROM git_tree_sources
        WHERE repo_id = ? AND storage = 'pack' AND source_id = ?
       UNION ALL SELECT 1 FROM git_blob_ids mapping
        WHERE mapping.repo_id = ?
          AND NOT EXISTS (SELECT 1 FROM git_objects loose
            WHERE loose.repo_id = mapping.repo_id AND loose.oid = mapping.oid)
          AND NOT EXISTS (SELECT 1 FROM git_pack_objects packed
            JOIN git_pack_meta pack
              ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
             AND pack.state = 'complete'
            WHERE packed.repo_id = mapping.repo_id AND packed.oid = mapping.oid)
       UNION ALL SELECT 1 FROM git_commits cached
        WHERE cached.repo_id = ?
          AND NOT EXISTS (SELECT 1 FROM git_objects loose
            WHERE loose.repo_id = cached.repo_id AND loose.oid = cached.oid
              AND loose.type = 'commit' AND loose.size = cached.object_size)
          AND NOT EXISTS (SELECT 1 FROM git_pack_objects packed
            JOIN git_pack_meta pack
              ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
             AND pack.state = 'complete'
            WHERE packed.repo_id = cached.repo_id AND packed.oid = cached.oid
              AND packed.type = 'commit' AND packed.size = cached.object_size)
     )`,
    store.repoId,
    pack.packId,
    store.repoId,
    pack.packId,
    store.repoId,
    pack.packId,
    store.repoId,
    pack.packId,
    store.repoId,
    pack.packId,
    store.repoId,
    pack.packId,
    store.repoId,
    pack.packId,
    store.repoId,
    store.repoId,
  );
  if (remains !== 0) throw new CorruptError("pack reclamation left storage rows");
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
                ) OR pack.count != (SELECT count(*) FROM git_pack_entries entry
                  WHERE entry.repo_id = pack.repo_id AND entry.pack_id = pack.pack_id)
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
