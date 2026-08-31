// Durable, bounded state shared by merge and sequenced replay operations.

import { isOid, utf8 } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { hashObject } from "../objects.js";
import type { ReplayEmptyReason } from "./kinds.js";
import {
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  mergeAlreadyActive,
  mergeJournalIntegrityOid,
  mergeNotActive,
  validateMergeTouchedPath,
} from "./merge-state.js";

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

interface OperationJournalFields<S extends OperationStateMetadata> {
  state: S;
  steps: readonly OperationStepMetadata[];
  touched: readonly MergeTouchedPath[];
  integrityOid: string;
}

export type MergeOperationJournal = OperationJournalFields<MergeOperationStateMetadata> & {
  kind: "merge";
};
export type CherryPickJournal = OperationJournalFields<
  ReplayStateMetadata & { kind: "cherry-pick" }
> & { kind: "cherry-pick" };
export type RevertJournal = OperationJournalFields<ReplayStateMetadata & { kind: "revert" }> & {
  kind: "revert";
};
export type RebaseJournal = OperationJournalFields<RebaseStateMetadata> & { kind: "rebase" };
export type OperationJournal =
  | MergeOperationJournal
  | CherryPickJournal
  | RevertJournal
  | RebaseJournal;

function boundedTextBytes(
  value: string,
  label: string,
  limit: number,
  forbidden: (unit: number) => boolean,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (forbidden(unit)) throw new CorruptError(`replay ${label} contains an invalid character`);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new CorruptError(`replay ${label} is not canonical UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`replay ${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) {
      throw new GitError("E2BIG", `replay ${label} exceeds ${limit} UTF-8 bytes`);
    }
  }
  return bytes;
}

function control(unit: number): boolean {
  return unit === 0 || unit === 0x0a || unit === 0x0d;
}

function validateOriginalHeadRef(ref: string): void {
  if (
    !ref.startsWith("refs/heads/") ||
    ref.length === "refs/heads/".length ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("\\")
  ) {
    throw new CorruptError("replay original HEAD is not a local branch ref");
  }
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[".includes(character)) {
      throw new CorruptError("replay original HEAD is not a valid branch ref");
    }
  }
  for (const component of ref.split("/")) {
    if (
      component === "" ||
      component === "." ||
      component === ".." ||
      component.startsWith(".") ||
      component.endsWith(".lock")
    ) {
      throw new CorruptError("replay original HEAD is not a valid branch ref");
    }
  }
  boundedTextBytes(ref, "original HEAD ref", MAX_MERGE_REF_BYTES, control);
}

function validateIdentity(identity: MergeSavedIdentity | null, label: string): void {
  if (identity === null) return;
  const forbidden = (unit: number): boolean => control(unit) || unit === 0x3c || unit === 0x3e;
  const name = boundedTextBytes(
    identity.name,
    `${label} name`,
    MAX_MERGE_IDENTITY_BYTES,
    forbidden,
  );
  const email = boundedTextBytes(
    identity.email,
    `${label} email`,
    MAX_MERGE_IDENTITY_BYTES,
    forbidden,
  );
  if (name === 0 || email === 0) throw new CorruptError(`replay ${label} identity is incomplete`);
}

function validateOperationCommonState(state: OperationCommonStateFields): void {
  validateOriginalHeadRef(state.originalHeadRef);
  if (!isOid(state.originalHeadOid)) {
    throw new CorruptError("replay original HEAD has an invalid object id");
  }
  const currentLabel = boundedTextBytes(
    state.currentLabel,
    "current label",
    MAX_MERGE_LABEL_BYTES,
    control,
  );
  const incomingLabel = boundedTextBytes(
    state.incomingLabel,
    "incoming label",
    MAX_MERGE_LABEL_BYTES,
    control,
  );
  if (currentLabel === 0 || incomingLabel === 0) {
    throw new CorruptError("replay labels must not be empty");
  }
  boundedTextBytes(state.message, "message", MAX_MERGE_MESSAGE_BYTES, (unit) => unit === 0);
  validateIdentity(state.author, "author");
  validateIdentity(state.committer, "committer");
}

export function validateOperationStepMetadata(step: OperationStepMetadata): void {
  if (!isOid(step.sourceOid)) {
    throw new CorruptError("operation step source has an invalid object id");
  }
  if (step.selectedParentOid !== null) {
    if (!isOid(step.selectedParentOid)) {
      throw new CorruptError("operation step selected parent has an invalid object id");
    }
  }
  if (step.mainline !== null && (!Number.isSafeInteger(step.mainline) || step.mainline < 1)) {
    throw new CorruptError("operation step mainline is not a safe positive integer");
  }
  if (step.mainline !== null && step.selectedParentOid === null) {
    throw new CorruptError("operation step mainline has no selected parent");
  }
  if (step.outcome !== "pending" && step.outcome !== "applied" && step.outcome !== "skipped") {
    throw new CorruptError("operation step has an invalid outcome");
  }
  if (step.outcome === "applied") {
    if (step.resultOid === null || !isOid(step.resultOid)) {
      throw new CorruptError("applied operation step has an invalid result object id");
    }
  } else if (step.resultOid !== null) {
    throw new CorruptError("unapplied operation step retained a result object id");
  }
}

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

function validateReplayHeader(state: ReplayStateMetadata): void {
  validateOperationCommonState(state);
  if (state.phase !== "conflicted" && state.phase !== "empty") {
    throw new CorruptError("replay journal has an invalid phase");
  }
  if (
    (state.phase === "conflicted" && state.emptyReason !== null) ||
    (state.phase === "empty" && state.emptyReason !== "source" && state.emptyReason !== "result")
  ) {
    throw new CorruptError("replay journal has an invalid empty reason");
  }
}

export function validateReplayStateMetadata(state: ReplayStateMetadata): void {
  validateReplayHeader(state);
  validateOperationStepMetadata(replayStep(state));
}

function sameStep(left: OperationStepMetadata, right: OperationStepMetadata): boolean {
  return (
    left.sourceOid === right.sourceOid &&
    left.selectedParentOid === right.selectedParentOid &&
    left.mainline === right.mainline &&
    left.outcome === right.outcome &&
    left.resultOid === right.resultOid
  );
}

function validateSequencedState(
  state: ReplayStateMetadata | RebaseStateMetadata,
  steps: readonly OperationStepMetadata[],
): void {
  if (steps.length > MAX_OPERATION_STEPS) {
    throw new GitError("E2BIG", `operation journal exceeds ${MAX_OPERATION_STEPS} steps`);
  }
  if (state.kind !== "rebase") {
    const expected = replayStep(state);
    if (steps.length !== 1 || steps[0] === undefined || !sameStep(steps[0], expected)) {
      throw new CorruptError("one-commit replay journal does not contain its pending source step");
    }
    validateReplayHeader(state);
    return;
  }
  if (steps.length === 0) throw new CorruptError("rebase journal has no replay steps");
  validateOperationCommonState(state);
  const anchors: readonly (readonly [string, string])[] = [
    ["upstream", state.upstreamOid],
    ["base", state.baseOid],
    ["current parent", state.currentParentOid],
  ];
  for (const [label, oid] of anchors) {
    if (!isOid(oid)) throw new CorruptError(`rebase ${label} has an invalid object id`);
  }
  if (state.phase !== "running" && state.phase !== "conflicted") {
    throw new CorruptError("rebase journal has an invalid phase");
  }
  if (
    !Number.isSafeInteger(state.currentStep) ||
    state.currentStep < 0 ||
    state.currentStep > steps.length
  ) {
    throw new CorruptError("rebase current step is outside the replay sequence");
  }
  let currentParentOid = state.upstreamOid;
  for (let ordinal = 0; ordinal < steps.length; ordinal++) {
    const step = steps[ordinal];
    if (step === undefined) throw new CorruptError("rebase step sequence is sparse");
    if (ordinal < state.currentStep) {
      if (step.outcome === "pending") {
        throw new CorruptError("rebase completed prefix retained a pending step");
      }
      if (step.outcome === "applied") {
        if (step.resultOid === null) throw new CorruptError("applied rebase step lost its result");
        currentParentOid = step.resultOid;
      }
    } else if (step.outcome !== "pending") {
      throw new CorruptError("rebase pending suffix retained a completed step");
    }
  }
  if (state.currentParentOid !== currentParentOid) {
    throw new CorruptError("rebase current parent differs from the replay cursor");
  }
  if (state.phase === "conflicted" && state.currentStep === steps.length) {
    throw new CorruptError("completed rebase cursor cannot be conflicted");
  }
}

function validateOperationJournal(
  state: OperationStateMetadata,
  touched: readonly MergeTouchedPath[],
  steps: readonly OperationStepMetadata[],
): void {
  if (state.kind === "merge") throw new CorruptError("merge journal entered replay validation");
  if (touched.length > MAX_MERGE_TOUCHED_PATHS) {
    throw new GitError(
      "E2BIG",
      `operation journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`,
    );
  }
  if (state.phase === "conflicted" && touched.length === 0) {
    throw new CorruptError("a conflicted replay journal must retain a touched path");
  }
  if (state.kind === "rebase" && state.phase === "running" && touched.length !== 0) {
    throw new CorruptError("a running rebase journal retained touched paths");
  }
  validateSequencedState(state, steps);
  for (const step of steps) {
    validateOperationStepMetadata(step);
  }
  for (const entry of touched) {
    validateMergeTouchedPath(entry);
  }
}

function savedIdentityVector(identity: MergeSavedIdentity | null): readonly unknown[] | null {
  return identity === null ? null : [identity.name, identity.email];
}

function touchedVector(entry: MergeTouchedPath): readonly unknown[] {
  const index =
    entry.index === null
      ? null
      : [
          entry.index.stage,
          entry.index.mode,
          entry.index.oid,
          entry.index.size,
          entry.index.mtime,
          entry.index.ino,
          entry.index.rev,
        ];
  const worktree =
    entry.worktree.kind === "absent"
      ? [entry.worktree.kind]
      : entry.worktree.kind === "directory"
        ? [entry.worktree.kind, entry.worktree.mode, entry.worktree.revision]
        : [entry.worktree.kind, entry.worktree.mode, entry.worktree.oid, entry.worktree.revision];
  return [entry.path, entry.logicalPath, entry.purpose, index, worktree];
}

function stepVector(step: OperationStepMetadata): readonly unknown[] {
  return [step.sourceOid, step.selectedParentOid, step.mainline, step.outcome, step.resultOid];
}

function operationHeaderVector(
  state: ReplayStateMetadata | RebaseStateMetadata,
): readonly unknown[] {
  const common: readonly unknown[] = [
    state.originalHeadRef,
    state.originalHeadOid,
    state.phase,
    state.currentLabel,
    state.incomingLabel,
    state.message,
    savedIdentityVector(state.author),
    savedIdentityVector(state.committer),
  ];
  return state.kind === "rebase"
    ? [...common, state.upstreamOid, state.baseOid, state.currentParentOid, state.currentStep]
    : [...common, state.emptyReason];
}

export function operationJournalIntegrityOid(
  state: OperationStateMetadata,
  touched: readonly MergeTouchedPath[],
  steps?: readonly OperationStepMetadata[],
): string {
  if (state.kind === "merge") {
    if (steps !== undefined && steps.length !== 0) {
      throw new CorruptError("merge journal retained replay steps");
    }
    const { kind: _kind, ...mergeState } = state;
    return mergeJournalIntegrityOid(mergeState, touched);
  }
  const sequence = steps ?? (state.kind === "rebase" ? undefined : operationStepsForState(state));
  if (sequence === undefined) throw new CorruptError("rebase journal is missing its replay steps");
  validateOperationJournal(state, touched, sequence);
  const payload: readonly unknown[] = [
    3,
    state.kind,
    operationHeaderVector(state),
    sequence.map(stepVector),
    touched.map(touchedVector),
  ];
  return hashObject("blob", utf8.encode(JSON.stringify(payload)));
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
