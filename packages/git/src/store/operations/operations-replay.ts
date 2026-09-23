// Durable, bounded state shared by merge and sequenced replay operations.

import { GitError } from "../../common/errors.js";
import {
  type MergeJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  mergeAlreadyActive,
  mergeNotActive,
} from "./operations-merge.js";

export type ReplayEmptyReason = "source" | "result";

export const MAX_OPERATION_STEPS = 4_096;

export type OperationKind = "merge" | "cherry-pick" | "revert" | "rebase";
export type ReplayKind = "cherry-pick" | "revert";
export type ReplayStatePhase = "conflicted" | "empty";
export type RebaseStatePhase = "running" | "conflicted";
export type OperationStepOutcome = "pending" | "applied" | "skipped";

export type MergeOperationStateMetadata = MergeStateMetadata & { kind: "merge" };

interface OperationCommonStateFields {
  originalHeadRef: string;
  originalHeadOid: string;
  currentLabel: string;
  incomingLabel: string;
  message: string;
  author: MergeSavedIdentity | null;
  committer: MergeSavedIdentity | null;
}

interface ReplayStateFields extends OperationCommonStateFields {
  phase: ReplayStatePhase;
  emptyReason: ReplayEmptyReason | null;
  sourceOid: string;
  selectedParentOid: string | null;
  mainline: number | null;
}

export type ReplayStateMetadata = ReplayStateFields &
  ({ kind: "cherry-pick" } | { kind: "revert" });

export interface RebaseStateMetadata extends OperationCommonStateFields {
  kind: "rebase";
  phase: RebaseStatePhase;
  upstreamOid: string;
  baseOid: string;
  currentParentOid: string;
  currentStep: number;
}

export interface OperationStepMetadata {
  sourceOid: string;
  selectedParentOid: string | null;
  mainline: number | null;
  outcome: OperationStepOutcome;
  resultOid: string | null;
}

export type OperationStateMetadata =
  | MergeOperationStateMetadata
  | ReplayStateMetadata
  | RebaseStateMetadata;

interface OperationJournalFields<
  S extends OperationStateMetadata,
  Touched = readonly MergeTouchedPath[],
> {
  state: S;
  steps: readonly OperationStepMetadata[];
  touched: Touched;
  replayed: number;
  skipped: number;
}

export type MergeOperationJournal<Touched = readonly MergeTouchedPath[]> = OperationJournalFields<
  MergeOperationStateMetadata,
  Touched
> & {
  kind: "merge";
};
export type CherryPickJournal<Touched = readonly MergeTouchedPath[]> = OperationJournalFields<
  ReplayStateMetadata & { kind: "cherry-pick" },
  Touched
> & { kind: "cherry-pick" };
export type RevertJournal<Touched = readonly MergeTouchedPath[]> = OperationJournalFields<
  ReplayStateMetadata & { kind: "revert" },
  Touched
> & {
  kind: "revert";
};
export type RebaseJournal<Touched = readonly MergeTouchedPath[]> = OperationJournalFields<
  RebaseStateMetadata,
  Touched
> & { kind: "rebase" };
export type OperationJournal<Touched = readonly MergeTouchedPath[]> =
  | MergeOperationJournal<Touched>
  | CherryPickJournal<Touched>
  | RevertJournal<Touched>
  | RebaseJournal<Touched>;

function replayStep(state: ReplayStateMetadata): OperationStepMetadata {
  return {
    sourceOid: state.sourceOid,
    selectedParentOid: state.selectedParentOid,
    mainline: state.mainline,
    outcome: "pending",
    resultOid: null,
  };
}

export function operationStepsForState(
  state: Exclude<OperationStateMetadata, RebaseStateMetadata>,
): readonly OperationStepMetadata[] {
  return state.kind === "merge" ? [] : [replayStep(state)];
}

export function mergeOperationState(state: MergeStateMetadata): MergeOperationStateMetadata {
  return { kind: "merge", ...state };
}

export function mergeJournalFromOperation(journal: MergeOperationJournal): MergeJournal {
  const { kind: _kind, ...state } = journal.state;
  return { state, touched: journal.touched };
}

export function operationAlreadyActive(kind: OperationKind): GitError {
  return kind === "merge"
    ? mergeAlreadyActive()
    : new GitError("EOPACTIVE", `a ${kind} operation is already active`);
}

export function operationNotActive(kind: OperationKind): GitError {
  if (kind === "merge") return mergeNotActive();
  if (kind === "cherry-pick") {
    return new GitError("ENOCHERRYPICK", "no cherry-pick operation is active");
  }
  return kind === "revert"
    ? new GitError("ENOREVERT", "no revert operation is active")
    : new GitError("ENOREBASE", "no rebase operation is active");
}

export function operationKindMismatch(expected: OperationKind, actual: OperationKind): GitError {
  return new GitError("EOPMISMATCH", `expected ${expected} operation, found ${actual}`);
}
