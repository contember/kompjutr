import { CorruptError, GitError } from "../../common/errors.js";
import {
  advanceMaintenanceRootSnapshotOwned,
  type SqliteGitDatabase,
  withGitMutationGuardOwned,
} from "../../store/database/database.js";
import { advanceMaintenanceMark } from "../../store/maintenance/reachability.js";
import {
  type MaintenancePhase,
  type MaintenanceRunView,
  readMaintenanceRunView,
  resetMaintenanceRunForRootChange,
  rolloverFinishedMaintenanceRun,
} from "../../store/maintenance/state.js";
import { advanceMaintenanceSweep } from "../../store/maintenance/sweep.js";
import type { SharedRepoStore } from "../../store/repository/shared.js";
import { cleanupTransfers, nextTransferExpiryMs } from "../../store/transfer/lifetime.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "./repository.js";

export interface MaintenanceProgressResult {
  status: "progress";
  phase: Exclude<MaintenancePhase, "finish"> | "transfers";
  runId: number;
  restarted: boolean;
  reachableObjects: number;
  queuedObjects: number;
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

function durableResult(store: SharedRepoStore): MaintenanceResult {
  const view = readMaintenanceRunView(store.db, store.repoId);
  if (view === null) throw new CorruptError("maintenance action did not publish a run");
  return result(view);
}

function advanceMaintenance(
  database: SqliteGitDatabase,
  store: SharedRepoStore,
  nowMs: number,
): MaintenanceResult {
  const repoId = store.repoId;
  const before = readMaintenanceRunView(store.db, repoId);
  if (before === null) {
    advanceMaintenanceRootSnapshotOwned(database, repoId, { nowMs });
    return durableResult(store);
  }

  if (before.phase === "finish") {
    if (
      before.observedRootEpoch === before.rootEpoch &&
      before.nextEligibleMs !== null &&
      nowMs < before.nextEligibleMs
    ) {
      return result(before);
    }
    rolloverFinishedMaintenanceRun(store.db, repoId, before.runId, nowMs);
    return durableResult(store);
  }

  // A run carries two identities: the root epoch and the source generation.
  // Either drifting restarts discovery before any further destruction.
  if (
    before.observedRootEpoch !== before.rootEpoch ||
    before.observedSourceGeneration !== before.sourceGeneration
  ) {
    if (before.phase === "roots" || before.phase === "mark") {
      advanceMaintenanceRootSnapshotOwned(database, repoId, { nowMs });
      return durableResult(store);
    }
    resetMaintenanceRunForRootChange(store.db, repoId, before.runId);
    return durableResult(store);
  }

  if (before.phase === "roots") {
    advanceMaintenanceRootSnapshotOwned(database, repoId, { nowMs });
  } else if (before.phase === "mark") {
    advanceMaintenanceMark(store);
  } else {
    advanceMaintenanceSweep(store, { nowMs });
  }
  return durableResult(store);
}

/** Advance one bounded durable maintenance action. */
export async function maintenance(
  context: GitContext,
  repo: Repository,
): Promise<MaintenanceResult> {
  return maintainRepository(context.database, repo.checkout.shared.repoId, {
    nowMs: context.now(),
  });
}

/** Advance one bounded maintenance action without requiring a checkout. */
export function maintainRepository(
  database: SqliteGitDatabase,
  repoId: number,
  options: { nowMs: number },
): MaintenanceResult {
  const nowMs = options.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new GitError("EINVAL", "maintenance clock must return non-negative integer milliseconds");
  }
  return withGitMutationGuardOwned(database, () => {
    const store = database.openShared(repoId);
    const transfersComplete = cleanupTransfers(store, nowMs);
    const progress = advanceMaintenance(database, store, nowMs);
    if (transfersComplete) {
      if (progress.status !== "complete") return progress;
      const expiry = nextTransferExpiryMs(store);
      if (expiry === null) return progress;
      return { ...progress, nextEligibleAt: Math.min(progress.nextEligibleAt ?? expiry, expiry) };
    }
    return { ...progress, status: "progress", phase: "transfers", nextEligibleAt: null };
  });
}
