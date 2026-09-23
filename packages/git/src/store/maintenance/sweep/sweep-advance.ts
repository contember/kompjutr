import { GitError } from "../../../common/errors.js";
import type { SharedRepoStore } from "../../index.js";
import { adoptMaintenanceSourceGeneration } from "../state/state-transitions.js";
import {
  type AdvanceMaintenanceSweepOptions,
  DEFAULT_PAGE_ROWS,
  MAX_PAGE_ROWS,
  type MaintenanceSweepProgress,
  type SliceResult,
} from "./sweep-contracts.js";
import { advanceLoose } from "./sweep-loose.js";
import { advancePacks } from "./sweep-packs.js";
import { progress, readRun } from "./sweep-shared.js";

/** Advance one durable loose or pack page, or one phase transition. */
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
    const slice =
      run.phase === "loose"
        ? advanceLoose(store.db, store.repoId, run, nowMs, pageRows)
        : advancePacks(store, run, nowMs, pageRows);
    // A slice that reclaimed storage bumped the generation itself; adopting it
    // as the transaction's last statement keeps the run from restarting itself.
    if (slice.storageChanged) {
      adoptMaintenanceSourceGeneration(store.db, store.repoId, run.runId);
    }
    return slice;
  });
  if (result.storageChanged) store.revalidateStorageCaches();
  return result.progress;
}
