import type { RebaseStateMetadata } from "../../core/operation-state.js";
import type { MergeIndexSnapshot, MergeTouchedPath } from "../../merge/merge-state.js";
import type { WorktreeStat } from "../../worktree/worktree.js";

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

/** A file or symlink an abort writes back from a blob. */
export interface RestoredFile {
  path: string;
  kind: "file" | "symlink";
  mode: number;
  oid: string;
}

export interface AdmittedBlobBatch {
  end: number;
  blobs: ReadonlyMap<string, Uint8Array>;
}
