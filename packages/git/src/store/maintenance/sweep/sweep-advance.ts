import { GitError } from "../../../common/errors.js";
import type { SharedRepoStore } from "../../index.js";
import {
  type AdvanceMaintenanceSweepOptions,
  DEFAULT_PAGE_ROWS,
  MAX_PAGE_ROWS,
  type MaintenanceSweepProgress,
  type SliceResult,
} from "./sweep-contracts.js";
import { classifyLoose, sweepLoose } from "./sweep-loose.js";
import { classifyPacks, sweepPacks } from "./sweep-packs.js";
import { progress, readRun } from "./sweep-shared.js";

/** Advance one durable WU6 classification, sweep, or phase-transition boundary. */
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
    if (run.phase === "repack") {
      throw new GitError("EINVAL", "maintenance repack phase belongs to the repack coordinator");
    }
    if (run.phase === "classify-loose") {
      return classifyLoose(store.db, store.repoId, run, nowMs, pageRows);
    }
    if (run.phase === "classify-packs") {
      return classifyPacks(store.db, store.repoId, run, nowMs);
    }
    if (run.phase === "sweep-loose") {
      return sweepLoose(store.db, store.repoId, run, nowMs, pageRows);
    }
    return sweepPacks(store, run, nowMs, pageRows);
  });
  if (result.storageChanged) store.revalidateStorageCaches();
  return result.progress;
}
