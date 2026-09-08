import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { expectSafeInteger } from "../../../common/rows.js";
import { expectPhase, expectRootsSettled, readMaintenanceRunView } from "../state/state-view.js";
import {
  GC_GRACE_MS,
  type MaintenanceSweepProgress,
  type MaintenanceSweepStatus,
  type RunState,
  type SweepPhase,
} from "./sweep-contracts.js";

export function readRun(db: SqlDatabase, repoId: number): RunState {
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

export function progress(
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

export function requireStableEpoch(db: SqlDatabase, repoId: number, run: RunState): void {
  const epoch = db.scalar<unknown>(
    "SELECT root_epoch FROM git_maintenance_control WHERE repo_id = ?",
    repoId,
  );
  if (
    expectSafeInteger(epoch, 0, Number.MAX_SAFE_INTEGER, "destructive maintenance root epoch") !==
    run.observedRootEpoch
  ) {
    throw new GitError("ESTALE", "maintenance roots changed before storage reclamation");
  }
}

export function transitionPhase(
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

export function eligibilityTime(since: number): number {
  if (since > Number.MAX_SAFE_INTEGER - GC_GRACE_MS) {
    throw new GitError("E2BIG", "garbage-collection eligibility time exceeds the safe range");
  }
  return since + GC_GRACE_MS;
}

export function sweepCutoff(nowMs: number): number {
  return nowMs < GC_GRACE_MS ? -1 : nowMs - GC_GRACE_MS;
}

export function updateReclamationCounters(
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
