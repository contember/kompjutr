export type MaintenancePhase =
  | "roots"
  | "mark"
  | "classify-loose"
  | "repack"
  | "classify-packs"
  | "sweep-loose"
  | "sweep-packs"
  | "finish";

export interface MaintenanceRunView {
  repoId: number;
  runId: number;
  observedRootEpoch: number;
  rootEpoch: number;
  nextRunId: number;
  phase: MaintenancePhase;
  startedMs: number;
  rootSource: import("../roots/root-contracts.js").MaintenanceRootSource;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  reachableObjects: number;
  queuedObjects: number;
  repackedObjects: number;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleMs: number | null;
  restarted: boolean;
}

export type MaintenanceMarkReconciliation = "initial" | "complete";
