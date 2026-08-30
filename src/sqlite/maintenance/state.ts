import { CorruptError, GitError } from "../../core/errors.js";
import type { MemoryReservation } from "../../memory.js";
import type { SqlDatabase } from "../db.js";
import { type MaintenanceRootSource, validateMaintenanceRootCursor } from "./roots.js";

export type MaintenancePhase =
  | "roots"
  | "mark"
  | "classify-loose"
  | "repack"
  | "classify-packs"
  | "sweep-loose"
  | "sweep-packs"
  | "finish";

export interface MaintenanceRunView {
  repoId: number;
  runId: number;
  observedRootEpoch: number;
  rootEpoch: number;
  nextRunId: number;
  phase: MaintenancePhase;
  startedMs: number;
  rootSource: MaintenanceRootSource;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  reachableObjects: number;
  queuedObjects: number;
  repackedObjects: number;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleMs: number | null;
  restarted: boolean;
}

const ABSENT_RUN_FIELDS = [
  "run_repo_id",
  "run_id",
  "observed_root_epoch",
  "phase",
  "started_ms",
  "root_source",
  "cursor_checkout_id",
  "cursor_text",
  "cursor_text_type",
  "cursor_text_bytes",
  "cursor_ordinal",
  "reachable_objects",
  "queued_objects",
  "repacked_objects",
  "reclaimed_objects",
  "reclaimed_packs",
  "reclaimed_bytes",
  "next_eligible_ms",
  "restarted",
];

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

function nullableInteger(value: unknown, label: string, minimum = 0): number | null {
  return value === null ? null : safeInteger(value, label, minimum);
}

function phaseField(value: unknown): MaintenancePhase {
  if (
    value !== "roots" &&
    value !== "mark" &&
    value !== "classify-loose" &&
    value !== "repack" &&
    value !== "classify-packs" &&
    value !== "sweep-loose" &&
    value !== "sweep-packs" &&
    value !== "finish"
  ) {
    throw new CorruptError("maintenance phase is invalid");
  }
  return value;
}

function rootSourceField(value: unknown): MaintenanceRootSource {
  if (
    value !== "refs" &&
    value !== "heads" &&
    value !== "reflogs" &&
    value !== "index" &&
    value !== "index-baseline" &&
    value !== "shallow" &&
    value !== "operations" &&
    value !== "done"
  ) {
    throw new CorruptError("maintenance root source is invalid");
  }
  return value;
}

function cursorMemoryBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > (Number.MAX_SAFE_INTEGER - 256) / 3) {
    throw new CorruptError("maintenance text cursor byte metadata is invalid");
  }
  return 256 + 3 * bytes;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) index++;
      bytes += low >= 0xdc00 && low <= 0xdfff ? 4 : 3;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 3;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

function cursorMetadata(row: Record<string, unknown>): number | null {
  if (row.cursor_text_type === null || row.cursor_text_type === "null") {
    if (row.cursor_text_bytes !== null) {
      throw new CorruptError("absent maintenance text cursor returned byte metadata");
    }
    return null;
  }
  if (row.cursor_text_type !== "text") {
    throw new CorruptError("maintenance text cursor storage type is invalid");
  }
  return safeInteger(row.cursor_text_bytes, "maintenance text cursor bytes", 0);
}

function cursorTextField(
  row: Record<string, unknown>,
  admittedCursorBytes: number | null,
): string | null {
  if (admittedCursorBytes === null) {
    if (row.cursor_text !== null || row.cursor_text_bytes !== null) {
      throw new CorruptError("absent maintenance text cursor returned metadata");
    }
    return null;
  }
  if (
    row.cursor_text_type !== "text" ||
    typeof row.cursor_text !== "string" ||
    utf8ByteLength(row.cursor_text) !== admittedCursorBytes
  ) {
    throw new CorruptError("maintenance text cursor is invalid");
  }
  return row.cursor_text;
}

function validateRepositoryId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
}

function requireRunView(
  row: Record<string, unknown>,
  repoId: number,
  admittedCursorBytes: number | null,
): MaintenanceRunView | null {
  if (row.repository_id !== repoId) {
    throw new CorruptError("maintenance state crossed repositories");
  }
  if (row.control_repo_id === null) {
    if (row.root_epoch !== null || row.next_run_id !== null) {
      throw new CorruptError("absent maintenance control returned state");
    }
    for (const field of ABSENT_RUN_FIELDS) {
      if (row[field] !== null) throw new CorruptError("run exists without maintenance control");
    }
    return null;
  }
  if (row.control_repo_id !== repoId) {
    throw new CorruptError("maintenance control crossed repositories");
  }
  const rootEpoch = safeInteger(row.root_epoch, "maintenance root epoch", 0);
  const nextRunId = safeInteger(row.next_run_id, "maintenance next run id", 1);
  if (row.run_repo_id === null) {
    for (const field of ABSENT_RUN_FIELDS) {
      if (row[field] !== null) throw new CorruptError("absent maintenance run returned state");
    }
    if (nextRunId !== 1) {
      throw new CorruptError("maintenance allocator advanced without a run");
    }
    return null;
  }
  if (row.run_repo_id !== repoId) throw new CorruptError("maintenance run crossed repositories");
  const runId = safeInteger(row.run_id, "maintenance run id", 1);
  if (nextRunId !== runId + 1) {
    throw new CorruptError("maintenance run allocator is inconsistent");
  }
  const phase = phaseField(row.phase);
  const rootSource = rootSourceField(row.root_source);
  const cursorCheckoutId = nullableInteger(
    row.cursor_checkout_id,
    "maintenance checkout cursor",
    1,
  );
  if (cursorMetadata(row) !== admittedCursorBytes) {
    throw new CorruptError("maintenance text cursor changed after metadata preflight");
  }
  const cursorText = cursorTextField(row, admittedCursorBytes);
  const cursorOrdinal = nullableInteger(row.cursor_ordinal, "maintenance ordinal cursor");
  const nextEligibleMs = nullableInteger(row.next_eligible_ms, "maintenance next eligible time");
  if (phase !== "sweep-packs" && phase !== "finish" && nextEligibleMs !== null) {
    throw new CorruptError("maintenance phase retained an eligibility time");
  }
  if (row.restarted !== 0 && row.restarted !== 1) {
    throw new CorruptError("maintenance restart marker is invalid");
  }
  const view: MaintenanceRunView = {
    repoId,
    runId,
    observedRootEpoch: safeInteger(row.observed_root_epoch, "maintenance observed root epoch", 0),
    rootEpoch,
    nextRunId,
    phase,
    startedMs: safeInteger(row.started_ms, "maintenance start time", 0),
    rootSource,
    cursorCheckoutId,
    cursorText,
    cursorOrdinal,
    reachableObjects: safeInteger(row.reachable_objects, "maintenance reachable count", 0),
    queuedObjects: safeInteger(row.queued_objects, "maintenance queued count", 0),
    repackedObjects: safeInteger(row.repacked_objects, "maintenance repacked count", 0),
    reclaimedObjects: safeInteger(row.reclaimed_objects, "maintenance reclaimed object count", 0),
    reclaimedPacks: safeInteger(row.reclaimed_packs, "maintenance reclaimed pack count", 0),
    reclaimedBytes: safeInteger(row.reclaimed_bytes, "maintenance reclaimed byte count", 0),
    nextEligibleMs,
    restarted: row.restarted === 1,
  };
  validateMaintenanceRootCursor(view);
  if (phase === "roots" && (view.reachableObjects !== 0 || view.queuedObjects !== 0)) {
    throw new CorruptError("maintenance roots retained reachability counters");
  }
  if (phase !== "roots" && phase !== "mark" && view.queuedObjects !== 0) {
    throw new CorruptError("completed maintenance mark retained queued objects");
  }
  return view;
}

/** Read and fully validate the active run together with its allocation control. */
export function readMaintenanceRunView(
  db: SqlDatabase,
  repoId: number,
  reservation: MemoryReservation,
): MaintenanceRunView | null {
  validateRepositoryId(repoId);
  const metadata = db.one<Record<string, unknown>>(
    `SELECT repository.id AS repository_id,
            CASE WHEN run.repo_id IS NOT NULL THEN typeof(run.cursor_text) END
              AS cursor_text_type,
            CASE WHEN run.repo_id IS NOT NULL
              THEN length(CAST(run.cursor_text AS BLOB)) END AS cursor_text_bytes
       FROM git_repositories repository
       LEFT JOIN git_maintenance_runs run ON run.repo_id = repository.id
      WHERE repository.id = ?`,
    repoId,
  );
  if (metadata === undefined) throw new GitError("ENOTFOUND", "repository does not exist");
  if (metadata.repository_id !== repoId) {
    throw new CorruptError("maintenance state metadata crossed repositories");
  }
  const admittedCursorBytes = cursorMetadata(metadata);
  reservation.set(
    "other",
    admittedCursorBytes === null ? 0 : cursorMemoryBytes(admittedCursorBytes),
  );
  const row = db.one<Record<string, unknown>>(
    `SELECT repository.id AS repository_id,
            control.repo_id AS control_repo_id, control.root_epoch, control.next_run_id,
            run.repo_id AS run_repo_id, run.run_id, run.observed_root_epoch, run.phase,
            run.started_ms, run.root_source, run.cursor_checkout_id,
            CASE WHEN run.repo_id IS NOT NULL THEN typeof(run.cursor_text) END
              AS cursor_text_type,
            CASE WHEN run.repo_id IS NOT NULL
              THEN length(CAST(run.cursor_text AS BLOB)) END AS cursor_text_bytes,
            run.cursor_text,
            run.cursor_ordinal, run.reachable_objects, run.queued_objects,
            run.repacked_objects, run.reclaimed_objects, run.reclaimed_packs,
            run.reclaimed_bytes, run.next_eligible_ms, run.restarted
       FROM git_repositories repository
       LEFT JOIN git_maintenance_control control ON control.repo_id = repository.id
       LEFT JOIN git_maintenance_runs run ON run.repo_id = control.repo_id
      WHERE repository.id = ?`,
    repoId,
  );
  if (row === undefined) {
    throw new CorruptError("maintenance state changed after metadata preflight");
  }
  return requireRunView(row, repoId, admittedCursorBytes);
}

function clearRunOwnedReachability(db: SqlDatabase, repoId: number, runId: number): void {
  db.run("DELETE FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?", repoId, runId);
  db.run("DELETE FROM git_maintenance_shallow WHERE repo_id = ? AND run_id = ?", repoId, runId);
  const remains = db.scalar<unknown>(
    `SELECT EXISTS(
       SELECT 1 FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?
       UNION ALL
       SELECT 1 FROM git_maintenance_shallow WHERE repo_id = ? AND run_id = ?
     )`,
    repoId,
    runId,
    repoId,
    runId,
  );
  if (remains !== 0) throw new CorruptError("maintenance restart retained reachability state");
}

/** Reset one drifted run after its owned repack batch has been settled. */
export function resetMaintenanceRunForRootChange(
  db: SqlDatabase,
  repoId: number,
  expectedRunId: number,
  reservation: MemoryReservation,
): MaintenanceRunView {
  validateRepositoryId(repoId);
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId < 1) {
    throw new GitError("EINVAL", "maintenance run id must be a safe positive integer");
  }
  return db.transactionSync(() => {
    const before = readMaintenanceRunView(db, repoId, reservation.scope());
    if (before === null || before.runId !== expectedRunId) {
      throw new CorruptError("maintenance restart lost its active run");
    }
    if (before.phase === "finish" || before.observedRootEpoch === before.rootEpoch) {
      throw new CorruptError("maintenance restart requires a drifted unfinished run");
    }
    const owned = db.scalar<unknown>(
      "SELECT EXISTS(SELECT 1 FROM git_maintenance_repack_batches WHERE repo_id = ? AND run_id = ?)",
      repoId,
      expectedRunId,
    );
    if (owned !== 0) throw new CorruptError("maintenance restart retained an owned repack batch");
    clearRunOwnedReachability(db, repoId, expectedRunId);
    const updated = db.one<Record<string, unknown>>(
      `UPDATE git_maintenance_runs
          SET observed_root_epoch = ?, phase = 'roots', root_source = 'refs',
              cursor_checkout_id = NULL, cursor_text = NULL, cursor_ordinal = NULL,
              reachable_objects = 0, queued_objects = 0, next_eligible_ms = NULL,
              restarted = 1
        WHERE repo_id = ? AND run_id = ? AND observed_root_epoch = ? AND phase != 'finish'
        RETURNING repo_id, run_id, observed_root_epoch, phase, root_source,
                  reachable_objects, queued_objects, next_eligible_ms, restarted`,
      before.rootEpoch,
      repoId,
      expectedRunId,
      before.observedRootEpoch,
    );
    if (
      updated === undefined ||
      updated.repo_id !== repoId ||
      updated.run_id !== expectedRunId ||
      updated.observed_root_epoch !== before.rootEpoch ||
      updated.phase !== "roots" ||
      updated.root_source !== "refs" ||
      updated.reachable_objects !== 0 ||
      updated.queued_objects !== 0 ||
      updated.next_eligible_ms !== null ||
      updated.restarted !== 1
    ) {
      throw new CorruptError("maintenance restart was not published atomically");
    }
    const after = readMaintenanceRunView(db, repoId, reservation.scope());
    if (after === null || after.runId !== expectedRunId) {
      throw new CorruptError("maintenance restart did not retain its run id");
    }
    return after;
  });
}

/** Replace one eligible finished run with a fresh zeroed root-discovery run. */
export function rolloverFinishedMaintenanceRun(
  db: SqlDatabase,
  repoId: number,
  expectedRunId: number,
  nowMs: number,
  reservation: MemoryReservation,
): MaintenanceRunView {
  validateRepositoryId(repoId);
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId < 1) {
    throw new GitError("EINVAL", "maintenance run id must be a safe positive integer");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new GitError("EINVAL", "maintenance clock must return non-negative integer milliseconds");
  }
  return db.transactionSync(() => {
    const before = readMaintenanceRunView(db, repoId, reservation.scope());
    if (before === null || before.runId !== expectedRunId || before.phase !== "finish") {
      throw new CorruptError("maintenance rollover lost its finished run");
    }
    if (
      before.observedRootEpoch === before.rootEpoch &&
      before.nextEligibleMs !== null &&
      nowMs < before.nextEligibleMs
    ) {
      throw new GitError("EINVAL", "maintenance run is not eligible to roll over");
    }
    const owned = db.scalar<unknown>(
      "SELECT EXISTS(SELECT 1 FROM git_maintenance_repack_batches WHERE repo_id = ? AND run_id = ?)",
      repoId,
      expectedRunId,
    );
    if (owned !== 0) throw new CorruptError("finished maintenance run retained a repack batch");
    const allocated = db.one<Record<string, unknown>>(
      `UPDATE git_maintenance_control SET next_run_id = next_run_id + 1
        WHERE repo_id = ? AND next_run_id < ?
        RETURNING repo_id, root_epoch, next_run_id`,
      repoId,
      Number.MAX_SAFE_INTEGER,
    );
    if (allocated === undefined) {
      throw new GitError("E2BIG", "maintenance run id space is exhausted");
    }
    if (allocated.repo_id !== repoId) {
      throw new CorruptError("maintenance rollover allocation crossed repositories");
    }
    const rootEpoch = safeInteger(allocated.root_epoch, "maintenance rollover root epoch", 0);
    if (rootEpoch !== before.rootEpoch) {
      throw new CorruptError("maintenance rollover allocation changed the root epoch");
    }
    const nextRunId = safeInteger(allocated.next_run_id, "maintenance rollover next run id", 2);
    const runId = nextRunId - 1;
    if (runId !== before.nextRunId) {
      throw new CorruptError("maintenance rollover allocation skipped a run id");
    }
    const removed = db.one<Record<string, unknown>>(
      `DELETE FROM git_maintenance_runs
        WHERE repo_id = ? AND run_id = ? AND phase = 'finish'
        RETURNING repo_id, run_id`,
      repoId,
      expectedRunId,
    );
    if (removed?.repo_id !== repoId || removed.run_id !== expectedRunId) {
      throw new CorruptError("maintenance rollover did not delete its exact finished run");
    }
    const retained = db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?
         UNION ALL
         SELECT 1 FROM git_maintenance_shallow WHERE repo_id = ? AND run_id = ?
         UNION ALL
         SELECT 1 FROM git_maintenance_repack_batches WHERE repo_id = ? AND run_id = ?
       )`,
      repoId,
      expectedRunId,
      repoId,
      expectedRunId,
      repoId,
      expectedRunId,
    );
    if (retained !== 0) throw new CorruptError("maintenance rollover retained old run rows");
    const inserted = db.one<Record<string, unknown>>(
      `INSERT INTO git_maintenance_runs
         (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
       VALUES (?, ?, ?, 'roots', ?, 'refs')
       RETURNING repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
                 reachable_objects, queued_objects, repacked_objects, reclaimed_objects,
                 reclaimed_packs, reclaimed_bytes, next_eligible_ms, restarted`,
      repoId,
      runId,
      rootEpoch,
      nowMs,
    );
    if (
      inserted === undefined ||
      inserted.repo_id !== repoId ||
      inserted.run_id !== runId ||
      inserted.observed_root_epoch !== rootEpoch ||
      inserted.phase !== "roots" ||
      inserted.started_ms !== nowMs ||
      inserted.root_source !== "refs" ||
      inserted.reachable_objects !== 0 ||
      inserted.queued_objects !== 0 ||
      inserted.repacked_objects !== 0 ||
      inserted.reclaimed_objects !== 0 ||
      inserted.reclaimed_packs !== 0 ||
      inserted.reclaimed_bytes !== 0 ||
      inserted.next_eligible_ms !== null ||
      inserted.restarted !== 0
    ) {
      throw new CorruptError("maintenance rollover did not publish a zeroed run");
    }
    const after = readMaintenanceRunView(db, repoId, reservation.scope());
    if (after === null || after.runId !== runId) {
      throw new CorruptError("maintenance rollover did not publish its new run");
    }
    return after;
  });
}
