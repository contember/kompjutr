// Durable, bounded state shared by merge and one-commit replay operations.

import { isOid, utf8 } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { hashObject } from "../objects.js";
import type { ReplayEmptyReason } from "./kinds.js";
import {
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_STATE_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  mergeAlreadyActive,
  mergeJournalIntegrityOid,
  mergeJournalRetainedBytes,
  mergeNotActive,
  validateMergeTouchedPath,
} from "./merge-state.js";

export type OperationKind = "merge" | "cherry-pick" | "revert";
export type ReplayKind = Exclude<OperationKind, "merge">;
export type ReplayStatePhase = "conflicted" | "empty";

export type MergeOperationStateMetadata = MergeStateMetadata & { kind: "merge" };

interface ReplayStateFields {
  originalHeadRef: string;
  originalHeadOid: string;
  phase: ReplayStatePhase;
  emptyReason: ReplayEmptyReason | null;
  sourceOid: string;
  selectedParentOid: string | null;
  mainline: number | null;
  currentLabel: string;
  incomingLabel: string;
  message: string;
  author: MergeSavedIdentity | null;
  committer: MergeSavedIdentity | null;
}

export type ReplayStateMetadata = ReplayStateFields &
  ({ kind: "cherry-pick" } | { kind: "revert" });

export type OperationStateMetadata = MergeOperationStateMetadata | ReplayStateMetadata;

interface OperationJournalFields<S extends OperationStateMetadata> {
  state: S;
  touched: readonly MergeTouchedPath[];
  retainedBytes: number;
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
export type OperationJournal = MergeOperationJournal | CherryPickJournal | RevertJournal;

const REPLAY_STATE_FIXED_BYTES = 2 * 1024;

function checkedAdd(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw new GitError("E2BIG", "operation journal byte accounting overflow");
  }
  return left + right;
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

function validateOriginalHeadRef(ref: string): number {
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
  return boundedTextBytes(ref, "original HEAD ref", MAX_MERGE_REF_BYTES, control);
}

function validateIdentity(identity: MergeSavedIdentity | null, label: string): number {
  if (identity === null) return 0;
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
  return checkedAdd(name, email);
}

export function validateReplayStateMetadata(state: ReplayStateMetadata): number {
  let bytes = checkedAdd(REPLAY_STATE_FIXED_BYTES, validateOriginalHeadRef(state.originalHeadRef));
  const requiredOids: readonly (readonly [string, string])[] = [
    ["original HEAD", state.originalHeadOid],
    ["source", state.sourceOid],
  ];
  for (const [label, oid] of requiredOids) {
    if (!isOid(oid)) throw new CorruptError(`replay ${label} has an invalid object id`);
    bytes = checkedAdd(bytes, 40);
  }
  if (state.selectedParentOid !== null) {
    if (!isOid(state.selectedParentOid)) {
      throw new CorruptError("replay selected parent has an invalid object id");
    }
    bytes = checkedAdd(bytes, 40);
  }
  if (state.mainline !== null && (!Number.isSafeInteger(state.mainline) || state.mainline < 1)) {
    throw new CorruptError("replay mainline is not a safe positive integer");
  }
  if (state.mainline !== null && state.selectedParentOid === null) {
    throw new CorruptError("replay mainline has no selected parent");
  }
  if (state.phase !== "conflicted" && state.phase !== "empty") {
    throw new CorruptError("replay journal has an invalid phase");
  }
  if (
    (state.phase === "conflicted" && state.emptyReason !== null) ||
    (state.phase === "empty" && state.emptyReason !== "source" && state.emptyReason !== "result")
  ) {
    throw new CorruptError("replay journal has an invalid empty reason");
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
  bytes = checkedAdd(bytes, currentLabel);
  bytes = checkedAdd(bytes, incomingLabel);
  bytes = checkedAdd(
    bytes,
    boundedTextBytes(state.message, "message", MAX_MERGE_MESSAGE_BYTES, (unit) => unit === 0),
  );
  bytes = checkedAdd(bytes, validateIdentity(state.author, "author"));
  bytes = checkedAdd(bytes, validateIdentity(state.committer, "committer"));
  return bytes;
}

export function operationJournalRetainedBytes(
  state: OperationStateMetadata,
  touched: readonly MergeTouchedPath[],
): number {
  if (state.kind === "merge") {
    const { kind: _kind, ...mergeState } = state;
    return mergeJournalRetainedBytes(mergeState, touched);
  }
  if (touched.length > MAX_MERGE_TOUCHED_PATHS) {
    throw new GitError(
      "E2BIG",
      `operation journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`,
    );
  }
  if (state.phase === "conflicted" && touched.length === 0) {
    throw new CorruptError("a conflicted replay journal must retain a touched path");
  }
  let bytes = validateReplayStateMetadata(state);
  for (const entry of touched) {
    bytes = checkedAdd(bytes, validateMergeTouchedPath(entry));
    if (bytes > MAX_MERGE_STATE_BYTES) {
      throw new GitError(
        "E2BIG",
        `operation journal exceeds ${MAX_MERGE_STATE_BYTES} retained bytes`,
      );
    }
  }
  return bytes;
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

export function operationJournalIntegrityOid(
  state: OperationStateMetadata,
  touched: readonly MergeTouchedPath[],
): string {
  operationJournalRetainedBytes(state, touched);
  if (state.kind === "merge") {
    const { kind: _kind, ...mergeState } = state;
    return mergeJournalIntegrityOid(mergeState, touched);
  }
  const payload: readonly unknown[] = [
    2,
    state.kind,
    [
      state.originalHeadRef,
      state.originalHeadOid,
      state.phase,
      state.emptyReason,
      state.sourceOid,
      state.selectedParentOid,
      state.mainline,
      state.currentLabel,
      state.incomingLabel,
      state.message,
      savedIdentityVector(state.author),
      savedIdentityVector(state.committer),
    ],
    touched.map(touchedVector),
  ];
  return hashObject("blob", utf8.encode(JSON.stringify(payload)));
}

export function mergeOperationState(state: MergeStateMetadata): MergeOperationStateMetadata {
  return { kind: "merge", ...state };
}

export function mergeJournalFromOperation(journal: MergeOperationJournal): MergeJournal {
  const { kind: _kind, ...state } = journal.state;
  return { state, touched: journal.touched, retainedBytes: journal.retainedBytes };
}

export function operationAlreadyActive(kind: OperationKind): GitError {
  return kind === "merge"
    ? mergeAlreadyActive()
    : new GitError("EOPACTIVE", `a ${kind} operation is already active`);
}

export function operationNotActive(kind: OperationKind): GitError {
  if (kind === "merge") return mergeNotActive();
  return kind === "cherry-pick"
    ? new GitError("ENOCHERRYPICK", "no cherry-pick operation is active")
    : new GitError("ENOREVERT", "no revert operation is active");
}

export function operationKindMismatch(expected: OperationKind, actual: OperationKind): GitError {
  return new GitError("EOPMISMATCH", `expected ${expected} operation, found ${actual}`);
}
