import type { SqlDatabase } from "../../../../db/db.js";
import { isOid } from "../../../common/bytes.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../pack/packs.js";
import { expectPhase, expectRootsSettled, readMaintenanceRunView } from "../state/state-view.js";
import {
  MAX_REPACK_INFLATED_BYTES,
  MAX_REPACK_OBJECTS,
  MAX_REPACK_STORED_BYTES,
  type MaintenanceRepackOptions,
  type MaintenanceRepackProgress,
  type RepackLimits,
  type RepackRun,
} from "./repack-contracts.js";

export function safeInteger(
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

export function objectType(value: unknown, label: string): ObjectType {
  if (value !== "blob" && value !== "tree" && value !== "commit" && value !== "tag") {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function oidField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) throw new CorruptError(`${label} is invalid`);
  return value;
}

export function packIdField(value: unknown, label: string): number {
  return safeInteger(value, label, 0);
}

function optionLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
    throw new RangeError(`${label} must be an integer from 1 to ${fallback}`);
  }
  return selected;
}

export function limits(options: MaintenanceRepackOptions): RepackLimits {
  return {
    maxObjects: optionLimit(options.maxObjects, MAX_REPACK_OBJECTS, "repack object limit"),
    maxInflatedBytes: optionLimit(
      options.maxInflatedBytes,
      MAX_REPACK_INFLATED_BYTES,
      "repack inflated-byte limit",
    ),
    maxStoredBytes: optionLimit(
      options.maxStoredBytes,
      MAX_REPACK_STORED_BYTES,
      "repack stored-byte limit",
    ),
    readBatchBytes: optionLimit(
      options.readBatchBytes,
      PACK_BLOB_BATCH_TARGET_BYTES,
      "repack read-batch limit",
    ),
  };
}

export function readRun(db: SqlDatabase, repoId: number): RepackRun {
  const run = readMaintenanceRunView(db, repoId);
  if (run === null) {
    throw new GitError("ENOTFOUND", "maintenance repack run does not exist");
  }
  expectPhase(run, ["repack"], `maintenance repack cannot advance phase ${run.phase}`);
  expectRootsSettled(run);
  return run;
}

export function currentRootEpoch(db: SqlDatabase, repoId: number): number {
  const row = db.one<Record<string, unknown>>(
    "SELECT repo_id, root_epoch FROM git_maintenance_control WHERE repo_id = ?",
    repoId,
  );
  if (row === undefined || row.repo_id !== repoId) {
    throw new CorruptError("maintenance root epoch is missing");
  }
  return safeInteger(row.root_epoch, "maintenance root epoch", 0);
}

export function rootChanged(runId: number): MaintenanceRepackProgress {
  return {
    runId,
    status: "root-changed",
    boundary: null,
    batchId: null,
    packId: null,
    objectCount: 0,
  };
}

export function requireRepackedCapacity(run: RepackRun, objectCount: number): void {
  if (
    !Number.isSafeInteger(objectCount) ||
    objectCount < 0 ||
    objectCount > Number.MAX_SAFE_INTEGER - run.repackedObjects
  ) {
    throw new GitError("E2BIG", "maintenance repacked counter is exhausted");
  }
}
