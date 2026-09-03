import type { FullObjectPackInput } from "../pack/full-object-stream.js";
import type { MaintenanceRunView } from "./state-contracts.js";

export const MAX_REPACK_OBJECTS = 2_048;
export const MAX_REPACK_INFLATED_BYTES = 32 * 1024 * 1024;
export const MAX_REPACK_STORED_BYTES = 64 * 1024 * 1024;

export type MaintenanceRepackStatus = "progress" | "complete" | "root-changed";
export type MaintenanceRepackBoundary = "selected" | "published" | "finalized" | null;

export interface MaintenanceRepackProgress {
  runId: number;
  status: MaintenanceRepackStatus;
  boundary: MaintenanceRepackBoundary;
  batchId: number | null;
  packId: number | null;
  objectCount: number;
}

export interface MaintenanceRepackOptions {
  maxObjects?: number;
  maxInflatedBytes?: number;
  maxStoredBytes?: number;
  readBatchBytes?: number;
  nowMs: number;
  yieldNow?: () => Promise<void>;
}

export interface RepackLimits {
  maxObjects: number;
  maxInflatedBytes: number;
  maxStoredBytes: number;
  readBatchBytes: number;
}

export type RepackRun = MaintenanceRunView & { phase: "repack" };

export interface RepackBatch {
  batchId: number;
  state: "selected" | "pending" | "published";
  packId: number | null;
  objectCount: number;
  inflatedBytes: number;
  storedBytes: number;
  objects: FullObjectPackInput[];
}

export type RunMutationPhase = <T>(body: () => T) => T;

export type RepackLocalStep =
  | {
      kind: "complete";
      progress: MaintenanceRepackProgress;
      revalidateStorage: boolean;
    }
  | { kind: "publish"; run: RepackRun; batch: RepackBatch };

export interface LooseCandidate extends FullObjectPackInput {
  packId: number | null;
  baseOid: string | null;
}

export interface FinalizedObject extends FullObjectPackInput {
  packId: number;
}

export function completed(
  progress: MaintenanceRepackProgress,
  revalidateStorage = false,
): RepackLocalStep {
  return { kind: "complete", progress, revalidateStorage };
}
