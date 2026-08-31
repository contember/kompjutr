import { CorruptError, GitError } from "../common/errors.js";
import { advanceMaintenanceRootSnapshotOwned } from "../store/index.js";
import { advanceMaintenanceReachability } from "../store/maintenance/reachability.js";
import {
  advanceMaintenanceRepack,
  settleMaintenanceRepackForRestart,
} from "../store/maintenance/repack.js";
import {
  type MaintenancePhase,
  type MaintenanceRunView,
  readMaintenanceRunView,
  resetMaintenanceRunForRootChange,
  rolloverFinishedMaintenanceRun,
} from "../store/maintenance/state.js";
import { advanceMaintenanceSweep } from "../store/maintenance/sweep.js";
import type { GitContext } from "./context.js";
import type { Repository } from "./repository.js";

export interface MaintenanceProgressResult {
  status: "progress";
  phase: Exclude<MaintenancePhase, "finish">;
  runId: number;
  restarted: boolean;
  reachableObjects: number;
  queuedObjects: number;
  repackedObjects: number;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleAt: null;
}

export interface MaintenanceCompleteResult {
  status: "complete";
  phase: "finish";
  runId: number;
  restarted: boolean;
  reachableObjects: number;
  queuedObjects: number;
  repackedObjects: number;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleAt: number | null;
}

export type MaintenanceResult = MaintenanceProgressResult | MaintenanceCompleteResult;

function result(view: MaintenanceRunView): MaintenanceResult {
  const counters = {
    runId: view.runId,
    restarted: view.restarted,
    reachableObjects: view.reachableObjects,
    queuedObjects: view.queuedObjects,
    repackedObjects: view.repackedObjects,
    reclaimedObjects: view.reclaimedObjects,
    reclaimedPacks: view.reclaimedPacks,
    reclaimedBytes: view.reclaimedBytes,
  };
  if (view.phase === "finish") {
    return {
      status: "complete",
      phase: "finish",
      ...counters,
      nextEligibleAt: view.nextEligibleMs,
    };
  }
  return {
    status: "progress",
    phase: view.phase,
    ...counters,
    nextEligibleAt: null,
  };
}

function durableResult(repo: Repository): MaintenanceResult {
  const view = readMaintenanceRunView(repo.store.db, repo.store.repoId);
  if (view === null) throw new CorruptError("maintenance action did not publish a run");
  return result(view);
}

/** Advance one bounded durable maintenance action. */
export async function maintenance(
  context: GitContext,
  repo: Repository,
): Promise<MaintenanceResult> {
  const nowMs = context.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new GitError("EINVAL", "maintenance clock must return non-negative integer milliseconds");
  }
  const repoId = repo.store.repoId;
  const before = readMaintenanceRunView(repo.store.db, repoId);
  if (before === null) {
    advanceMaintenanceRootSnapshotOwned(context.database, repoId, { nowMs });
    return durableResult(repo);
  }

  if (before.phase === "finish") {
    if (
      before.observedRootEpoch === before.rootEpoch &&
      before.nextEligibleMs !== null &&
      nowMs < before.nextEligibleMs
    ) {
      return result(before);
    }
    rolloverFinishedMaintenanceRun(repo.store.db, repoId, before.runId, nowMs);
    return durableResult(repo);
  }

  if (before.observedRootEpoch !== before.rootEpoch) {
    if (before.phase === "roots" || before.phase === "mark") {
      advanceMaintenanceRootSnapshotOwned(context.database, repoId, { nowMs });
      return durableResult(repo);
    }
    repo.store.db.transactionSync(() => {
      settleMaintenanceRepackForRestart(repo.store, before.runId);
      resetMaintenanceRunForRootChange(repo.store.db, repoId, before.runId);
    });
    return durableResult(repo);
  }

  if (before.phase === "roots") {
    advanceMaintenanceRootSnapshotOwned(context.database, repoId, { nowMs });
  } else if (before.phase === "mark") {
    advanceMaintenanceReachability(repo.store);
  } else if (before.phase === "repack") {
    if (context.yieldNow === undefined) {
      await advanceMaintenanceRepack(repo.store, { nowMs });
    } else {
      await advanceMaintenanceRepack(repo.store, { nowMs, yieldNow: context.yieldNow });
    }
  } else {
    advanceMaintenanceSweep(repo.store, { nowMs });
  }
  return durableResult(repo);
}
