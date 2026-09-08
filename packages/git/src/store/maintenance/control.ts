import {
  MAINTENANCE_ROOT_EPOCH_EXHAUSTED,
  rethrowMaintenanceRootEpochError,
  type SqlDatabase,
} from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";

export { MAINTENANCE_ROOT_EPOCH_EXHAUSTED, rethrowMaintenanceRootEpochError };

export interface MaintenanceControl {
  rootEpoch: number;
  nextRunId: number;
}

function requireRepositoryId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
}

function requireControlRow(row: Record<string, unknown>, repoId: number): MaintenanceControl {
  if (row.repo_id !== repoId) {
    throw new CorruptError("maintenance control belongs to another repository");
  }
  if (
    typeof row.root_epoch !== "number" ||
    !Number.isSafeInteger(row.root_epoch) ||
    row.root_epoch < 0
  ) {
    throw new CorruptError("maintenance root epoch is invalid");
  }
  if (
    typeof row.next_run_id !== "number" ||
    !Number.isSafeInteger(row.next_run_id) ||
    row.next_run_id < 1
  ) {
    throw new CorruptError("maintenance next run id is invalid");
  }
  return { rootEpoch: row.root_epoch, nextRunId: row.next_run_id };
}

/** Lazily install and validate one repository's maintenance control row. */
export function ensureMaintenanceControl(db: SqlDatabase, repoId: number): MaintenanceControl {
  requireRepositoryId(repoId);
  db.run(
    `INSERT OR IGNORE INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 1)`,
    repoId,
  );
  const row = db.one<Record<string, unknown>>(
    `SELECT repo_id, root_epoch, next_run_id
       FROM git_maintenance_control WHERE repo_id = ?`,
    repoId,
  );
  if (row === undefined) throw new CorruptError("maintenance control row is missing");
  return requireControlRow(row, repoId);
}

/** Increment the root generation inside the caller's root-changing transaction. */
export function bumpMaintenanceRootEpoch(db: SqlDatabase, repoId: number): number {
  requireRepositoryId(repoId);
  const row = db.one<Record<string, unknown>>(
    `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 1, 1)
     ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1
       WHERE root_epoch < ?
     RETURNING repo_id, root_epoch, next_run_id`,
    repoId,
    Number.MAX_SAFE_INTEGER,
  );
  if (row === undefined) {
    throw new GitError("E2BIG", MAINTENANCE_ROOT_EPOCH_EXHAUSTED);
  }
  return requireControlRow(row, repoId).rootEpoch;
}

/** Read the current root generation without creating maintenance state. */
export function readMaintenanceRootEpoch(db: SqlDatabase, repoId: number): number {
  requireRepositoryId(repoId);
  const row = db.one<Record<string, unknown>>(
    `SELECT repo_id, root_epoch, next_run_id
       FROM git_maintenance_control WHERE repo_id = ?`,
    repoId,
  );
  return row === undefined ? 0 : requireControlRow(row, repoId).rootEpoch;
}
