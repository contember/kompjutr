// Durable, bounded state for one incomplete two-head merge.

import { isOid, utf8 } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { hashObject } from "../common/objects.js";

export const MAX_MERGE_TOUCHED_PATHS = 1_000;
export const MAX_MERGE_PATH_BYTES = 2_200;
export const MAX_MERGE_REF_BYTES = 1_024;
export const MAX_MERGE_LABEL_BYTES = 256;
export const MAX_MERGE_IDENTITY_BYTES = 1_024;
export const MAX_MERGE_MESSAGE_BYTES = 1024 * 1024;

export type MergeStatePhase = "conflicted" | "ready";
export type MergeStateMode = "commit" | "no-commit";
export type MergeOrigin = "merge" | "pull";
export type MergeTouchedPurpose = "primary" | "current-relocation" | "incoming-relocation";

export interface MergeSavedIdentity {
  name: string;
  email: string;
}

export interface MergeStateMetadata {
  originalHeadRef: string;
  originalHeadOid: string;
  currentParentOid: string;
  incomingParentOid: string;
  phase: MergeStatePhase;
  mode: MergeStateMode;
  mergeOrigin: MergeOrigin;
  currentLabel: string;
  incomingLabel: string;
  message: string;
  author: MergeSavedIdentity | null;
  committer: MergeSavedIdentity | null;
}

export interface MergeIndexSnapshot {
  stage: 0;
  mode: number;
  oid: string;
  size: number | null;
  mtime: number | null;
  ino: number | null;
  rev: number | null;
}

export type MergeWorktreeSnapshot =
  | { kind: "absent" }
  | { kind: "file" | "symlink"; mode: number; oid: string; revision: number }
  | { kind: "directory"; mode: number; revision: number };

export interface MergeTouchedPath {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPurpose;
  index: MergeIndexSnapshot | null;
  worktree: MergeWorktreeSnapshot;
}

export interface MergeJournal {
  state: MergeStateMetadata;
  touched: readonly MergeTouchedPath[];
}

function boundedTextBytes(
  value: string,
  label: string,
  limit: number,
  forbidden: (unit: number) => boolean,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (forbidden(unit)) throw new CorruptError(`merge ${label} contains an invalid character`);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new CorruptError(`merge ${label} is not canonical UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`merge ${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) throw new GitError("E2BIG", `merge ${label} exceeds ${limit} UTF-8 bytes`);
  }
  return bytes;
}

function control(unit: number): boolean {
  return unit === 0 || unit === 0x0a || unit === 0x0d;
}

function nul(unit: number): boolean {
  return unit === 0;
}

export function validateMergePath(path: string, label: string): number {
  if (path.length === 0 || path.charCodeAt(0) === 0x2f) {
    throw new CorruptError(`merge ${label} is invalid`);
  }
  let bytes = 0;
  let segmentStart = 0;
  for (let index = 0; index < path.length; index++) {
    const unit = path.charCodeAt(index);
    if (unit === 0) throw new CorruptError(`merge ${label} is invalid`);
    if (unit === 0x2f) {
      const length = index - segmentStart;
      if (
        length === 0 ||
        (length === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
        (length === 2 &&
          path.charCodeAt(segmentStart) === 0x2e &&
          path.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        throw new CorruptError(`merge ${label} is invalid`);
      }
      segmentStart = index + 1;
      bytes++;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new CorruptError(`merge ${label} is not canonical UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`merge ${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > MAX_MERGE_PATH_BYTES) {
      throw new GitError("E2BIG", `merge ${label} exceeds ${MAX_MERGE_PATH_BYTES} UTF-8 bytes`);
    }
  }
  const length = path.length - segmentStart;
  if (
    length === 0 ||
    (length === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
    (length === 2 &&
      path.charCodeAt(segmentStart) === 0x2e &&
      path.charCodeAt(segmentStart + 1) === 0x2e)
  ) {
    throw new CorruptError(`merge ${label} is invalid`);
  }
  return bytes;
}

export function requireMergeText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new CorruptError(`merge ${label} is not text`);
  return value;
}

export function requireMergeOid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`merge ${label} is not a valid object id`);
  }
  return value;
}

export function requireMergeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError(`merge ${label} is not a safe nonnegative integer`);
  }
  return value;
}

export function requireMergeNullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : requireMergeInteger(value, label);
}

export function requireMergePhase(value: unknown): MergeStatePhase {
  if (value !== "conflicted" && value !== "ready") {
    throw new CorruptError("merge journal has an invalid phase");
  }
  return value;
}

export function requireMergeMode(value: unknown): MergeStateMode {
  if (value !== "commit" && value !== "no-commit") {
    throw new CorruptError("merge journal has an invalid mode");
  }
  return value;
}

export function requireMergeOrigin(value: unknown): MergeOrigin {
  if (value !== "merge" && value !== "pull") {
    throw new CorruptError("merge journal has an invalid origin");
  }
  return value;
}

export function requireMergePurpose(value: unknown): MergeTouchedPurpose {
  if (value !== "primary" && value !== "current-relocation" && value !== "incoming-relocation") {
    throw new CorruptError("merge journal has an invalid touched-path purpose");
  }
  return value;
}

function validateIdentity(identity: MergeSavedIdentity | null, label: string): void {
  if (identity === null) return;
  const forbiddenName = (unit: number): boolean => control(unit) || unit === 0x3c || unit === 0x3e;
  const forbiddenEmail = (unit: number): boolean => control(unit) || unit === 0x3c || unit === 0x3e;
  const name = boundedTextBytes(
    identity.name,
    `${label} name`,
    MAX_MERGE_IDENTITY_BYTES,
    forbiddenName,
  );
  const email = boundedTextBytes(
    identity.email,
    `${label} email`,
    MAX_MERGE_IDENTITY_BYTES,
    forbiddenEmail,
  );
  if (name === 0 || email === 0) throw new CorruptError(`merge ${label} identity is incomplete`);
}

export function validateMergeStateMetadata(state: MergeStateMetadata): void {
  if (
    !state.originalHeadRef.startsWith("refs/heads/") ||
    state.originalHeadRef.length === "refs/heads/".length ||
    state.originalHeadRef.endsWith("/") ||
    state.originalHeadRef.endsWith(".") ||
    state.originalHeadRef.includes("//") ||
    state.originalHeadRef.includes("..") ||
    state.originalHeadRef.includes("@{") ||
    state.originalHeadRef.includes("\\")
  ) {
    throw new CorruptError("merge original HEAD is not a local branch ref");
  }
  for (const character of state.originalHeadRef) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[".includes(character)) {
      throw new CorruptError("merge original HEAD is not a valid branch ref");
    }
  }
  for (const component of state.originalHeadRef.split("/")) {
    if (
      component === "" ||
      component === "." ||
      component === ".." ||
      component.startsWith(".") ||
      component.endsWith(".lock")
    ) {
      throw new CorruptError("merge original HEAD is not a valid branch ref");
    }
  }
  boundedTextBytes(state.originalHeadRef, "original HEAD ref", MAX_MERGE_REF_BYTES, control);
  const oids: readonly (readonly [string, string])[] = [
    ["original HEAD", state.originalHeadOid],
    ["current parent", state.currentParentOid],
    ["incoming parent", state.incomingParentOid],
  ];
  for (const [label, oid] of oids) {
    if (!isOid(oid)) throw new CorruptError(`merge ${label} has an invalid object id`);
  }
  if (state.currentParentOid !== state.originalHeadOid) {
    throw new CorruptError("merge current parent differs from the original HEAD");
  }
  if (state.phase !== "conflicted" && state.phase !== "ready") {
    throw new CorruptError("merge journal has an invalid phase");
  }
  if (state.mode !== "commit" && state.mode !== "no-commit") {
    throw new CorruptError("merge journal has an invalid mode");
  }
  if (state.phase === "ready" && state.mode !== "no-commit") {
    throw new CorruptError("a ready merge journal must be a no-commit merge");
  }
  requireMergeOrigin(state.mergeOrigin);
  const currentLabelBytes = boundedTextBytes(
    state.currentLabel,
    "current label",
    MAX_MERGE_LABEL_BYTES,
    control,
  );
  const incomingLabelBytes = boundedTextBytes(
    state.incomingLabel,
    "incoming label",
    MAX_MERGE_LABEL_BYTES,
    control,
  );
  if (currentLabelBytes === 0 || incomingLabelBytes === 0) {
    throw new CorruptError("merge labels must not be empty");
  }
  boundedTextBytes(state.message, "message", MAX_MERGE_MESSAGE_BYTES, nul);
  validateIdentity(state.author, "author");
  validateIdentity(state.committer, "committer");
}

function validIndexMode(mode: number): boolean {
  return mode === 0o100644 || mode === 0o100755 || mode === 0o120000 || mode === 0o160000;
}

function validateIndex(snapshot: MergeIndexSnapshot | null): void {
  if (snapshot === null) return;
  if (snapshot.stage !== 0) throw new CorruptError("merge index snapshot is not stage zero");
  if (!Number.isSafeInteger(snapshot.mode) || !validIndexMode(snapshot.mode)) {
    throw new CorruptError("merge index snapshot has an invalid mode");
  }
  if (!isOid(snapshot.oid)) throw new CorruptError("merge index snapshot has an invalid oid");
  const metadata: readonly (readonly [string, number | null])[] = [
    ["size", snapshot.size],
    ["mtime", snapshot.mtime],
    ["inode", snapshot.ino],
    ["revision", snapshot.rev],
  ];
  for (const [label, value] of metadata) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new CorruptError(`merge index snapshot has an invalid ${label}`);
    }
  }
}

function validateWorktree(snapshot: MergeWorktreeSnapshot): void {
  if (snapshot.kind === "absent") return;
  if (
    !Number.isSafeInteger(snapshot.mode) ||
    snapshot.mode < 0 ||
    snapshot.mode > 0o177777 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0
  ) {
    throw new CorruptError("merge worktree snapshot has invalid metadata");
  }
  const type = snapshot.mode & 0o170000;
  if (snapshot.kind === "directory") {
    if (type !== 0o040000) throw new CorruptError("merge directory snapshot has an invalid mode");
    return;
  }
  const expected = snapshot.kind === "file" ? 0o100000 : 0o120000;
  if (type !== expected || !isOid(snapshot.oid)) {
    throw new CorruptError(`merge ${snapshot.kind} snapshot has an invalid identity`);
  }
}

export function validateMergeTouchedPath(entry: MergeTouchedPath): void {
  validateMergePath(entry.path, "touched path");
  validateMergePath(entry.logicalPath, "logical path");
  if (
    entry.purpose !== "primary" &&
    entry.purpose !== "current-relocation" &&
    entry.purpose !== "incoming-relocation"
  ) {
    throw new CorruptError("merge touched path has an invalid purpose");
  }
  if (entry.purpose === "primary" && entry.path !== entry.logicalPath) {
    throw new CorruptError("merge primary path differs from its logical path");
  }
  if (entry.purpose !== "primary" && entry.path === entry.logicalPath) {
    throw new CorruptError("merge relocation path equals its logical path");
  }
  validateIndex(entry.index);
  validateWorktree(entry.worktree);
}

function validateMergeJournal(
  state: MergeStateMetadata,
  touched: readonly MergeTouchedPath[],
): void {
  if (touched.length > MAX_MERGE_TOUCHED_PATHS) {
    throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
  }
  if (state.phase === "conflicted" && touched.length === 0) {
    throw new CorruptError("a conflicted merge journal must retain a touched path");
  }
  validateMergeStateMetadata(state);
  for (const entry of touched) {
    validateMergeTouchedPath(entry);
  }
}

function savedIdentityVector(identity: MergeSavedIdentity | null): readonly unknown[] | null {
  return identity === null ? null : [identity.name, identity.email];
}

function indexSnapshotVector(snapshot: MergeIndexSnapshot | null): readonly unknown[] | null {
  return snapshot === null
    ? null
    : [
        snapshot.stage,
        snapshot.mode,
        snapshot.oid,
        snapshot.size,
        snapshot.mtime,
        snapshot.ino,
        snapshot.rev,
      ];
}

function worktreeSnapshotVector(snapshot: MergeWorktreeSnapshot): readonly unknown[] {
  if (snapshot.kind === "absent") return [snapshot.kind];
  if (snapshot.kind === "directory") return [snapshot.kind, snapshot.mode, snapshot.revision];
  return [snapshot.kind, snapshot.mode, snapshot.oid, snapshot.revision];
}

/** Bind every persisted operation field to one deterministic content identity. */
export function mergeJournalIntegrityOid(
  state: MergeStateMetadata,
  touched: readonly MergeTouchedPath[],
): string {
  validateMergeJournal(state, touched);
  const payload: readonly unknown[] = [
    2,
    [
      state.originalHeadRef,
      state.originalHeadOid,
      state.currentParentOid,
      state.incomingParentOid,
      state.phase,
      state.mode,
      state.mergeOrigin,
      state.currentLabel,
      state.incomingLabel,
      state.message,
      savedIdentityVector(state.author),
      savedIdentityVector(state.committer),
    ],
    touched.map((entry) => [
      entry.path,
      entry.logicalPath,
      entry.purpose,
      indexSnapshotVector(entry.index),
      worktreeSnapshotVector(entry.worktree),
    ]),
  ];
  return hashObject("blob", utf8.encode(JSON.stringify(payload)));
}

export function mergeAlreadyActive(): GitError {
  return new GitError("EMERGEACTIVE", "a merge operation is already active");
}

export function mergeNotActive(): GitError {
  return new GitError("ENOMERGE", "no merge operation is active");
}

// Durable, bounded state shared by merge and sequenced replay operations.

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

function replayBoundedTextBytes(
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

function replayControl(unit: number): boolean {
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
  replayBoundedTextBytes(ref, "original HEAD ref", MAX_MERGE_REF_BYTES, replayControl);
}

function validateReplayIdentity(identity: MergeSavedIdentity | null, label: string): void {
  if (identity === null) return;
  const forbidden = (unit: number): boolean =>
    replayControl(unit) || unit === 0x3c || unit === 0x3e;
  const name = replayBoundedTextBytes(
    identity.name,
    `${label} name`,
    MAX_MERGE_IDENTITY_BYTES,
    forbidden,
  );
  const email = replayBoundedTextBytes(
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
  const currentLabel = replayBoundedTextBytes(
    state.currentLabel,
    "current label",
    MAX_MERGE_LABEL_BYTES,
    replayControl,
  );
  const incomingLabel = replayBoundedTextBytes(
    state.incomingLabel,
    "incoming label",
    MAX_MERGE_LABEL_BYTES,
    replayControl,
  );
  if (currentLabel === 0 || incomingLabel === 0) {
    throw new CorruptError("replay labels must not be empty");
  }
  replayBoundedTextBytes(state.message, "message", MAX_MERGE_MESSAGE_BYTES, (unit) => unit === 0);
  validateReplayIdentity(state.author, "author");
  validateReplayIdentity(state.committer, "committer");
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

function replaySavedIdentityVector(identity: MergeSavedIdentity | null): readonly unknown[] | null {
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
    replaySavedIdentityVector(state.author),
    replaySavedIdentityVector(state.committer),
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
