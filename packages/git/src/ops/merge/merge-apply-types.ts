import type { OperationStateMetadata, RebaseStateMetadata } from "../core/operation-state.js";
import type { WorktreeStat } from "../worktree/worktree.js";
import type { HashedPath } from "../worktree/worktree-io.js";
import type { MergeIndexSnapshot, MergeTouchedPath } from "./merge-state.js";

export interface OperationApplyOptions {
  suspendedState: OperationStateMetadata | null;
}

export interface ActiveRebaseApply {
  currentStep: number;
  conflictState: RebaseStateMetadata | null;
}

export interface TouchedSpec {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPath["purpose"];
}

export interface SnapshotDraft {
  spec: TouchedSpec;
  index: MergeIndexSnapshot | null;
  stat: WorktreeStat | null;
}

export interface SnapshotObjects {
  entries: Map<string, HashedPath>;
}

export interface BlobMetadata {
  sizes: ReadonlyMap<string, number>;
}

export interface AdmittedBlobBatch {
  end: number;
  blobs: ReadonlyMap<string, Uint8Array>;
}
