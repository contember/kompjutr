export type MaintenancePhase = "roots" | "mark" | "loose" | "packs" | "finish";

export interface MaintenanceRunView {
  repoId: number;
  runId: number;
  observedRootEpoch: number;
  rootEpoch: number;
  observedSourceGeneration: number;
  sourceGeneration: number;
  nextRunId: number;
  phase: MaintenancePhase;
  startedMs: number;
  rootSource: import("../roots/root-contracts.js").MaintenanceRootSource;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  reachableObjects: number;
  queuedObjects: number;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleMs: number | null;
  restarted: boolean;
}
