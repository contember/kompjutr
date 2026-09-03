import type { MaintenanceRunView } from "../state/state-contracts.js";

export const GC_GRACE_MS = 1_209_600_000;

export const DEFAULT_PAGE_ROWS = 64;
export const MAX_PAGE_ROWS = 128;

export type SweepPhase =
  | "classify-loose"
  | "repack"
  | "classify-packs"
  | "sweep-loose"
  | "sweep-packs"
  | "finish";

export type MaintenanceSweepStatus = "progress" | "phase-complete" | "complete" | "root-changed";

export interface AdvanceMaintenanceSweepOptions {
  nowMs: number;
  pageRows?: number;
}

export interface MaintenanceSweepProgress {
  runId: number;
  phase: SweepPhase;
  status: MaintenanceSweepStatus;
  reclaimedObjects: number;
  reclaimedPacks: number;
  reclaimedBytes: number;
  nextEligibleMs: number | null;
}

export type RunState = MaintenanceRunView & { phase: SweepPhase };

export interface LooseRow {
  oid: string;
  storedBytes: number;
  marked: boolean;
  pinned: boolean;
  candidateSince: number | null;
}

export interface PackAudit {
  packId: number;
  size: number;
  count: number;
  state: "pending" | "complete";
  owned: boolean;
  marked: boolean;
  candidateSince: number | null;
}

export interface SliceResult {
  progress: MaintenanceSweepProgress;
  storageChanged: boolean;
}
