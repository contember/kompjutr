import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { decodeRow, int, nullable, oneOf } from "../../common/rows.js";
import type { MaintenanceMarkReconciliation, MaintenanceRunView } from "./state-contracts.js";
import { readMaintenanceRunView, validateRepositoryId } from "./state-view.js";

export function reconcileMaintenanceMark(
  db: SqlDatabase,
  view: MaintenanceRunView,
  boundary: MaintenanceMarkReconciliation,
): number {
  const row = db.one<Record<string, unknown>>(
    `SELECT coalesce(sum(CASE WHEN expanded = 0 THEN 1 ELSE 0 END), 0) AS queued,
            coalesce(sum(CASE WHEN physical_only = 0 THEN 1 ELSE 0 END), 0) AS logical,
            coalesce(sum(CASE WHEN physical_only != 0 OR expanded != 0 OR edge_cursor != 0
                              THEN 1 ELSE 0 END), 0) AS non_initial
       FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?`,
    view.repoId,
    view.runId,
  );
  if (row === undefined) throw new CorruptError("maintenance mark count returned no row");
  const counts = decodeRow(
    row,
    {
      queued: int(0, Number.MAX_SAFE_INTEGER, "maintenance queued mark count is invalid"),
      logical: int(0, Number.MAX_SAFE_INTEGER, "maintenance logical mark count is invalid"),
      non_initial: int(0, Number.MAX_SAFE_INTEGER, "maintenance initial mark state is invalid"),
    },
    "maintenance mark count is malformed",
  );
  if (boundary === "initial") {
    if (counts.queued !== view.queuedObjects || counts.logical !== counts.queued) {
      throw new CorruptError("initial maintenance counters disagree with their root marks");
    }
    if (counts.non_initial !== 0) {
      throw new CorruptError("uninitialized maintenance roots already contain traversal state");
    }
    return counts.logical;
  }
  if (view.queuedObjects !== 0) {
    throw new CorruptError("maintenance mark queue is empty but its counter is not zero");
  }
  if (counts.queued !== 0 || counts.logical !== view.reachableObjects) {
    throw new CorruptError("completed maintenance counters disagree with their mark rows");
  }
  return counts.logical;
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
