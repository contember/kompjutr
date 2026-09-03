import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { decodeRow, int, nullable, oneOf, text } from "../../common/rows.js";
import { validateMaintenanceRootCursor } from "./root-contracts.js";
import type { MaintenancePhase, MaintenanceRunView } from "./state-contracts.js";

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

export function validateRepositoryId(repoId: number): void {
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

/** Require a run phase while preserving the caller's public error code. */
export function expectPhase<const Phases extends readonly MaintenancePhase[]>(
  view: MaintenanceRunView,
  allowed: Phases,
  message: string,
  code = "EINVAL",
): asserts view is MaintenanceRunView & { phase: Phases[number] } {
  for (const phase of allowed) {
    if (view.phase === phase) return;
  }
  throw new GitError(code, message);
}

/** Require root discovery to be settled before a downstream maintenance phase. */
export function expectRootsSettled(view: MaintenanceRunView): void {
  if (
    view.rootSource !== "done" ||
    view.cursorCheckoutId !== null ||
    view.cursorText !== null ||
    view.cursorOrdinal !== null
  ) {
    throw new CorruptError("completed maintenance roots retained a cursor");
  }
}
