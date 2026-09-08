import { GitError } from "../../../common/errors.js";
import { withGitMutationGuard } from "../../core/mutation-guard.js";
import type { SharedRepoStore } from "../../index.js";
import { createBatch, readBatch, selectCandidates } from "./repack-batch.js";
import {
  completed,
  type MaintenanceRepackOptions,
  type MaintenanceRepackProgress,
  type RepackLimits,
  type RepackLocalStep,
  type RunMutationPhase,
} from "./repack-contracts.js";
import {
  finalizePublished,
  finalizeSelectedShadows,
  finalizeShadows,
  transitionToClassifyPacks,
} from "./repack-finalize.js";
import { limits, readRun, requireRepackedCapacity, rootChanged } from "./repack-helpers.js";
import { publishBatch, recoverPending, selectedBatchShadows } from "./repack-publish.js";

function advanceMaintenanceRepackLocal(
  store: SharedRepoStore,
  selectedLimits: RepackLimits,
): RepackLocalStep {
  const run = readRun(store.db, store.repoId);
  if (run.observedRootEpoch !== run.rootEpoch) {
    return completed(rootChanged(run.runId));
  }
  const batch = readBatch(store.db, store.repoId, run.runId);
  if (batch !== null) requireRepackedCapacity(run, batch.objectCount);
  if (batch?.state === "pending") return completed(recoverPending(store, run, batch));
  if (batch?.state === "published") {
    return completed(finalizePublished(store, run, batch), true);
  }
  if (batch?.state === "selected") {
    const shadows = selectedBatchShadows(store.db, store.repoId, run.runId, batch);
    if (shadows.length > 0) {
      return completed(finalizeSelectedShadows(store, run, batch, shadows), true);
    }
    return { kind: "publish", run, batch };
  }

  const selected = selectCandidates(store.db, store.repoId, run, selectedLimits);
  if (selected.objects.length === 0) {
    transitionToClassifyPacks(store.db, store.repoId, run);
    return completed({
      runId: run.runId,
      status: "complete",
      boundary: null,
      batchId: null,
      packId: null,
      objectCount: 0,
    });
  }
  requireRepackedCapacity(run, selected.objects.length);
  if (selected.shadows) {
    return completed(finalizeShadows(store, run, selected.objects), true);
  }
  const created = createBatch(store.db, store.repoId, run, selected.objects);
  return completed({
    runId: run.runId,
    status: "progress",
    boundary: "selected",
    batchId: created.batchId,
    packId: null,
    objectCount: created.objectCount,
  });
}

/** Advance one bounded durable repack boundary for the active repository run. */
export async function advanceMaintenanceRepack(
  store: SharedRepoStore,
  options: MaintenanceRepackOptions,
): Promise<MaintenanceRepackProgress> {
  if (!Number.isSafeInteger(store.repoId) || store.repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
  const nowMs = options.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("maintenance repack clock must be a non-negative safe integer");
  }
  const selectedLimits = limits(options);
  const runMutation: RunMutationPhase = (body) => withGitMutationGuard(store.db, body);
  const step = runMutation(() => advanceMaintenanceRepackLocal(store, selectedLimits));
  if (step.kind === "complete") {
    if (step.revalidateStorage) store.revalidateStorageCaches();
    return step.progress;
  }
  return publishBatch(store, step.run, step.batch, selectedLimits, options, nowMs, runMutation);
}
