import type { Commit } from "../common/objects.js";
import type { TextMergeOptions } from "../diff/xmerge.js";
import type { IntegrationConflictKind, IntegrationLimits, IntegrationPlan } from "./integration.js";

export type ReplayKind = "cherry-pick" | "revert";
export type ReplayIncomingLabelStyle = "tree" | "source-subject" | "parent-of-source-subject";

export interface ReplayInput {
  kind: ReplayKind;
  source: string;
  currentOid: string;
  mainline?: number;
  text?: TextMergeOptions;
  limits?: IntegrationLimits;
  /** Select Git's command-specific sequencer label or the planner's tree label. */
  incomingLabelStyle?: ReplayIncomingLabelStyle;
}

export interface ReplayLabels {
  current: string;
  base: string;
  incoming: string;
}

export interface ReplayPlan {
  kind: ReplayKind;
  sourceOid: string;
  sourceCommit: Commit;
  sourceTreeOid: string;
  selectedParentOid: string | null;
  selectedParentTreeOid: string | null;
  mainline: number | null;
  currentOid: string;
  currentCommit: Commit;
  currentTreeOid: string;
  baseTreeOid: string | null;
  incomingTreeOid: string | null;
  labels: ReplayLabels;
  integration: IntegrationPlan;
}

export interface ReplaySnapshotOptions {
  snapshot: string;
  onto: string;
}

export interface ReplaySnapshotConflictStage {
  stage: 1 | 2 | 3;
  mode: string;
  oid: string;
}

export interface ReplaySnapshotConflict {
  path: string;
  kind: IntegrationConflictKind;
  stages: readonly ReplaySnapshotConflictStage[];
}

export type ReplaySnapshotResult =
  | { outcome: "clean"; tree: string }
  | { outcome: "conflicted"; conflicts: readonly ReplaySnapshotConflict[] };

export interface FixedReplayStepInput {
  sourceOid: string;
  selectedParentOid: string | null;
  currentOid: string;
  limits?: IntegrationLimits;
}

export interface BoundedRevisionLabels {
  input: string;
  operation: string;
}
