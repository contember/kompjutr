import type {
  MergeIndexSnapshot,
  MergeJournal,
  MergeStateMetadata,
  MergeTouchedPath,
} from "./merge-state.js";
import type { OperationStateMetadata, RebaseStateMetadata } from "./operation-state.js";
import type { WorktreeStat } from "./worktree.js";
import type { HashedPath } from "./worktree-io.js";

export type MergeApplyMetadata = Omit<MergeStateMetadata, "phase">;
export type MergeApplyOutcome = "clean" | "conflicted" | "ready";

export interface MergeApplyResult {
  outcome: MergeApplyOutcome;
  journal: MergeJournal | null;
}

export interface OperationApplyOptions {
  suspendedState: OperationStateMetadata | null;
}

export interface ActiveRebaseApply {
  currentStep: number;
  conflictState: RebaseStateMetadata | null;
}

export interface OperationApplyResult {
  touched: readonly MergeTouchedPath[] | null;
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

export interface TouchedSpecs {
  entries: TouchedSpec[];
}

export interface WorktreeSnapshotScan {
  entries: Map<string, WorktreeStat>;
}

export interface IndexSnapshots {
  entries: Map<string, MergeIndexSnapshot>;
}

export interface SnapshotObjects {
  entries: Map<string, HashedPath>;
}

export interface ContentObjects {
  entries: Map<string, string>;
}

export interface BlobMetadata {
  sizes: ReadonlyMap<string, number>;
}

export interface AdmittedBlobBatch {
  end: number;
  blobs: ReadonlyMap<string, Uint8Array>;
}

export interface OwnedPaths {
  entries: string[];
}

export interface ProjectedRebaseTransitionOptions<T> extends ActiveRebaseApply {
  onClean: (applied: OperationApplyResult) => T;
}

export type ProjectedRebaseTransitionResult<T> =
  | { outcome: "clean"; value: T }
  | { outcome: "conflicted" };
