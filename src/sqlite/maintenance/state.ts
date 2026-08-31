import { CorruptError, GitError } from "../../core/errors.js";
import { decodeRow, int, nullable, oneOf, text } from "../../core/rows.js";
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

function requiredField<Value>(value: Value | null, message: string): Value {
  if (value === null) throw new CorruptError(message);
  return value;
}

function validateRepositoryId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
}

function requireRunView(row: Record<string, unknown>, repoId: number): MaintenanceRunView | null {
  const decoded = decodeRow(
    row,
    {
      repository_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance repository id is invalid"),
      control_repo_id: nullable(
        int(1, Number.MAX_SAFE_INTEGER, "maintenance control repository id is invalid"),
      ),
      root_epoch: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "maintenance root epoch is not a bounded safe integer"),
      ),
      next_run_id: nullable(
        int(1, Number.MAX_SAFE_INTEGER, "maintenance next run id is not a bounded safe integer"),
      ),
      run_repo_id: nullable(
        int(1, Number.MAX_SAFE_INTEGER, "maintenance run repository id is invalid"),
      ),
      run_id: nullable(
        int(1, Number.MAX_SAFE_INTEGER, "maintenance run id is not a bounded safe integer"),
      ),
      observed_root_epoch: nullable(
        int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance observed root epoch is not a bounded safe integer",
        ),
      ),
      phase: nullable(
        oneOf(
          [
            "roots",
            "mark",
            "classify-loose",
            "repack",
            "classify-packs",
            "sweep-loose",
            "sweep-packs",
            "finish",
          ],
          "maintenance phase is invalid",
        ),
      ),
      started_ms: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "maintenance start time is not a bounded safe integer"),
      ),
      root_source: nullable(
        oneOf(
          ["refs", "heads", "reflogs", "index", "index-baseline", "shallow", "operations", "done"],
          "maintenance root source is invalid",
        ),
      ),
      cursor_checkout_id: nullable(
        int(
          1,
          Number.MAX_SAFE_INTEGER,
          "maintenance checkout cursor is not a bounded safe integer",
        ),
      ),
      cursor_text: nullable(text("maintenance text cursor is invalid")),
      cursor_ordinal: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "maintenance ordinal cursor is not a bounded safe integer"),
      ),
      reachable_objects: nullable(
        int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance reachable count is not a bounded safe integer",
        ),
      ),
      queued_objects: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "maintenance queued count is not a bounded safe integer"),
      ),
      repacked_objects: nullable(
        int(0, Number.MAX_SAFE_INTEGER, "maintenance repacked count is not a bounded safe integer"),
      ),
      reclaimed_objects: nullable(
        int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance reclaimed object count is not a bounded safe integer",
        ),
      ),
      reclaimed_packs: nullable(
        int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance reclaimed pack count is not a bounded safe integer",
        ),
      ),
      reclaimed_bytes: nullable(
        int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance reclaimed byte count is not a bounded safe integer",
        ),
      ),
      next_eligible_ms: nullable(
        int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance next eligible time is not a bounded safe integer",
        ),
      ),
      restarted: nullable(int(0, 1, "maintenance restart marker is invalid")),
    },
    "maintenance state row is malformed",
  );
  if (decoded.repository_id !== repoId) {
    throw new CorruptError("maintenance state crossed repositories");
  }
  if (decoded.control_repo_id === null) {
    if (decoded.root_epoch !== null || decoded.next_run_id !== null) {
      throw new CorruptError("absent maintenance control returned state");
    }
    for (const field of ABSENT_RUN_FIELDS) {
      if (row[field] !== null) throw new CorruptError("run exists without maintenance control");
    }
    return null;
  }
  if (decoded.control_repo_id !== repoId) {
    throw new CorruptError("maintenance control crossed repositories");
  }
  const rootEpoch = requiredField(
    decoded.root_epoch,
    "maintenance root epoch is not a bounded safe integer",
  );
  const nextRunId = requiredField(
    decoded.next_run_id,
    "maintenance next run id is not a bounded safe integer",
  );
  if (decoded.run_repo_id === null) {
    for (const field of ABSENT_RUN_FIELDS) {
      if (row[field] !== null) throw new CorruptError("absent maintenance run returned state");
    }
    if (nextRunId !== 1) {
      throw new CorruptError("maintenance allocator advanced without a run");
    }
    return null;
  }
  if (decoded.run_repo_id !== repoId) {
    throw new CorruptError("maintenance run crossed repositories");
  }
  const runId = requiredField(decoded.run_id, "maintenance run id is not a bounded safe integer");
  if (nextRunId !== runId + 1) {
    throw new CorruptError("maintenance run allocator is inconsistent");
  }
  const phase = requiredField(decoded.phase, "maintenance phase is invalid");
  const rootSource = requiredField(decoded.root_source, "maintenance root source is invalid");
  const cursorCheckoutId = decoded.cursor_checkout_id;
  const cursorText = decoded.cursor_text;
  const cursorOrdinal = decoded.cursor_ordinal;
  const nextEligibleMs = decoded.next_eligible_ms;
  if (phase !== "sweep-packs" && phase !== "finish" && nextEligibleMs !== null) {
    throw new CorruptError("maintenance phase retained an eligibility time");
  }
  const restarted = requiredField(decoded.restarted, "maintenance restart marker is invalid");
  const view: MaintenanceRunView = {
    repoId,
    runId,
    observedRootEpoch: requiredField(
      decoded.observed_root_epoch,
      "maintenance observed root epoch is not a bounded safe integer",
    ),
    rootEpoch,
    nextRunId,
    phase,
    startedMs: requiredField(
      decoded.started_ms,
      "maintenance start time is not a bounded safe integer",
    ),
    rootSource,
    cursorCheckoutId,
    cursorText,
    cursorOrdinal,
    reachableObjects: requiredField(
      decoded.reachable_objects,
      "maintenance reachable count is not a bounded safe integer",
    ),
    queuedObjects: requiredField(
      decoded.queued_objects,
      "maintenance queued count is not a bounded safe integer",
    ),
    repackedObjects: requiredField(
      decoded.repacked_objects,
      "maintenance repacked count is not a bounded safe integer",
    ),
    reclaimedObjects: requiredField(
      decoded.reclaimed_objects,
      "maintenance reclaimed object count is not a bounded safe integer",
    ),
    reclaimedPacks: requiredField(
      decoded.reclaimed_packs,
      "maintenance reclaimed pack count is not a bounded safe integer",
    ),
    reclaimedBytes: requiredField(
      decoded.reclaimed_bytes,
      "maintenance reclaimed byte count is not a bounded safe integer",
    ),
    nextEligibleMs,
    restarted: restarted === 1,
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
export function readMaintenanceRunView(db: SqlDatabase, repoId: number): MaintenanceRunView | null {
  validateRepositoryId(repoId);
  const row = db.one<Record<string, unknown>>(
    `SELECT repository.id AS repository_id,
            control.repo_id AS control_repo_id, control.root_epoch, control.next_run_id,
            run.repo_id AS run_repo_id, run.run_id, run.observed_root_epoch, run.phase,
            run.started_ms, run.root_source, run.cursor_checkout_id,
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
  if (row === undefined) throw new GitError("ENOTFOUND", "repository does not exist");
  return requireRunView(row, repoId);
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
): MaintenanceRunView {
  validateRepositoryId(repoId);
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId < 1) {
    throw new GitError("EINVAL", "maintenance run id must be a safe positive integer");
  }
  return db.transactionSync(() => {
    const before = readMaintenanceRunView(db, repoId);
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
    const updatedRow = db.one<Record<string, unknown>>(
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
    if (updatedRow === undefined) {
      throw new CorruptError("maintenance restart was not published atomically");
    }
    const updated = decodeRow(
      updatedRow,
      {
        repo_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance restart repository is invalid"),
        run_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance restart run id is invalid"),
        observed_root_epoch: int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance restart root epoch is invalid",
        ),
        phase: oneOf(["roots"], "maintenance restart phase is invalid"),
        root_source: oneOf(["refs"], "maintenance restart root source is invalid"),
        reachable_objects: int(0, 0, "maintenance restart reachable count is invalid"),
        queued_objects: int(0, 0, "maintenance restart queued count is invalid"),
        next_eligible_ms: nullable(
          int(0, Number.MAX_SAFE_INTEGER, "maintenance restart eligibility is invalid"),
        ),
        restarted: int(0, 1, "maintenance restart marker is invalid"),
      },
      "maintenance restart result is malformed",
    );
    if (
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
    const after = readMaintenanceRunView(db, repoId);
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
): MaintenanceRunView {
  validateRepositoryId(repoId);
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId < 1) {
    throw new GitError("EINVAL", "maintenance run id must be a safe positive integer");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new GitError("EINVAL", "maintenance clock must return non-negative integer milliseconds");
  }
  return db.transactionSync(() => {
    const before = readMaintenanceRunView(db, repoId);
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
    const allocatedRow = db.one<Record<string, unknown>>(
      `UPDATE git_maintenance_control SET next_run_id = next_run_id + 1
        WHERE repo_id = ? AND next_run_id < ?
        RETURNING repo_id, root_epoch, next_run_id`,
      repoId,
      Number.MAX_SAFE_INTEGER,
    );
    if (allocatedRow === undefined) {
      throw new GitError("E2BIG", "maintenance run id space is exhausted");
    }
    const allocated = decodeRow(
      allocatedRow,
      {
        repo_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance allocation repository is invalid"),
        root_epoch: int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance rollover root epoch is not a bounded safe integer",
        ),
        next_run_id: int(
          2,
          Number.MAX_SAFE_INTEGER,
          "maintenance rollover next run id is not a bounded safe integer",
        ),
      },
      "maintenance allocation result is malformed",
    );
    if (allocated.repo_id !== repoId) {
      throw new CorruptError("maintenance rollover allocation crossed repositories");
    }
    const rootEpoch = allocated.root_epoch;
    if (rootEpoch !== before.rootEpoch) {
      throw new CorruptError("maintenance rollover allocation changed the root epoch");
    }
    const nextRunId = allocated.next_run_id;
    const runId = nextRunId - 1;
    if (runId !== before.nextRunId) {
      throw new CorruptError("maintenance rollover allocation skipped a run id");
    }
    const removedRow = db.one<Record<string, unknown>>(
      `DELETE FROM git_maintenance_runs
        WHERE repo_id = ? AND run_id = ? AND phase = 'finish'
        RETURNING repo_id, run_id`,
      repoId,
      expectedRunId,
    );
    if (removedRow === undefined) {
      throw new CorruptError("maintenance rollover did not delete its exact finished run");
    }
    const removed = decodeRow(
      removedRow,
      {
        repo_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance removal repository is invalid"),
        run_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance removal run id is invalid"),
      },
      "maintenance removal result is malformed",
    );
    if (removed.repo_id !== repoId || removed.run_id !== expectedRunId) {
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
    const insertedRow = db.one<Record<string, unknown>>(
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
    if (insertedRow === undefined) {
      throw new CorruptError("maintenance rollover did not publish a zeroed run");
    }
    const inserted = decodeRow(
      insertedRow,
      {
        repo_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance rollover repository is invalid"),
        run_id: int(1, Number.MAX_SAFE_INTEGER, "maintenance rollover run id is invalid"),
        observed_root_epoch: int(
          0,
          Number.MAX_SAFE_INTEGER,
          "maintenance rollover root epoch is invalid",
        ),
        phase: oneOf(["roots"], "maintenance rollover phase is invalid"),
        started_ms: int(0, Number.MAX_SAFE_INTEGER, "maintenance rollover start time is invalid"),
        root_source: oneOf(["refs"], "maintenance rollover root source is invalid"),
        reachable_objects: int(0, 0, "maintenance rollover reachable count is invalid"),
        queued_objects: int(0, 0, "maintenance rollover queued count is invalid"),
        repacked_objects: int(0, 0, "maintenance rollover repacked count is invalid"),
        reclaimed_objects: int(0, 0, "maintenance rollover reclaimed object count is invalid"),
        reclaimed_packs: int(0, 0, "maintenance rollover reclaimed pack count is invalid"),
        reclaimed_bytes: int(0, 0, "maintenance rollover reclaimed byte count is invalid"),
        next_eligible_ms: nullable(
          int(0, Number.MAX_SAFE_INTEGER, "maintenance rollover eligibility is invalid"),
        ),
        restarted: int(0, 1, "maintenance rollover restart marker is invalid"),
      },
      "maintenance rollover result is malformed",
    );
    if (
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
    const after = readMaintenanceRunView(db, repoId);
    if (after === null || after.runId !== runId) {
      throw new CorruptError("maintenance rollover did not publish its new run");
    }
    return after;
  });
}
