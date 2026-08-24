// Durable, bounded state for one incomplete two-head merge.

import { isOid } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";

export const MAX_MERGE_TOUCHED_PATHS = 1_000;
export const MAX_MERGE_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_MERGE_PATH_BYTES = 2_200;
export const MAX_MERGE_REF_BYTES = 1_024;
export const MAX_MERGE_LABEL_BYTES = 256;
export const MAX_MERGE_IDENTITY_BYTES = 1_024;
export const MAX_MERGE_MESSAGE_BYTES = 1024 * 1024;

const MERGE_STATE_FIXED_BYTES = 2 * 1024;
const MERGE_TOUCHED_FIXED_BYTES = 768;

export type MergeStatePhase = "conflicted" | "ready";
export type MergeStateMode = "commit" | "no-commit";
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
  retainedBytes: number;
}

function checkedAdd(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw new GitError("E2BIG", "merge journal byte accounting overflow");
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

export function requireMergePurpose(value: unknown): MergeTouchedPurpose {
  if (value !== "primary" && value !== "current-relocation" && value !== "incoming-relocation") {
    throw new CorruptError("merge journal has an invalid touched-path purpose");
  }
  return value;
}

function validateIdentity(identity: MergeSavedIdentity | null, label: string): number {
  if (identity === null) return 0;
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
  return checkedAdd(name, email);
}

export function validateMergeStateMetadata(state: MergeStateMetadata): number {
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
  let bytes = MERGE_STATE_FIXED_BYTES;
  bytes = checkedAdd(
    bytes,
    boundedTextBytes(state.originalHeadRef, "original HEAD ref", MAX_MERGE_REF_BYTES, control),
  );
  const oids: readonly (readonly [string, string])[] = [
    ["original HEAD", state.originalHeadOid],
    ["current parent", state.currentParentOid],
    ["incoming parent", state.incomingParentOid],
  ];
  for (const [label, oid] of oids) {
    if (!isOid(oid)) throw new CorruptError(`merge ${label} has an invalid object id`);
    bytes = checkedAdd(bytes, 40);
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
  bytes = checkedAdd(
    bytes,
    boundedTextBytes(state.currentLabel, "current label", MAX_MERGE_LABEL_BYTES, control),
  );
  bytes = checkedAdd(
    bytes,
    boundedTextBytes(state.incomingLabel, "incoming label", MAX_MERGE_LABEL_BYTES, control),
  );
  bytes = checkedAdd(
    bytes,
    boundedTextBytes(state.message, "message", MAX_MERGE_MESSAGE_BYTES, nul),
  );
  bytes = checkedAdd(bytes, validateIdentity(state.author, "author"));
  bytes = checkedAdd(bytes, validateIdentity(state.committer, "committer"));
  return bytes;
}

function validIndexMode(mode: number): boolean {
  return mode === 0o100644 || mode === 0o100755 || mode === 0o120000 || mode === 0o160000;
}

function validateIndex(snapshot: MergeIndexSnapshot | null): number {
  if (snapshot === null) return 0;
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
  return 256;
}

function validateWorktree(snapshot: MergeWorktreeSnapshot): number {
  if (snapshot.kind === "absent") return 0;
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
    return 128;
  }
  const expected = snapshot.kind === "file" ? 0o100000 : 0o120000;
  if (type !== expected || !isOid(snapshot.oid)) {
    throw new CorruptError(`merge ${snapshot.kind} snapshot has an invalid identity`);
  }
  return 256;
}

export function validateMergeTouchedPath(entry: MergeTouchedPath): number {
  let bytes = MERGE_TOUCHED_FIXED_BYTES;
  bytes = checkedAdd(bytes, validateMergePath(entry.path, "touched path") * 2);
  bytes = checkedAdd(bytes, validateMergePath(entry.logicalPath, "logical path") * 2);
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
  bytes = checkedAdd(bytes, validateIndex(entry.index));
  bytes = checkedAdd(bytes, validateWorktree(entry.worktree));
  return bytes;
}

export function mergeJournalRetainedBytes(
  state: MergeStateMetadata,
  touched: readonly MergeTouchedPath[],
): number {
  if (touched.length > MAX_MERGE_TOUCHED_PATHS) {
    throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
  }
  let bytes = validateMergeStateMetadata(state);
  for (const entry of touched) {
    bytes = checkedAdd(bytes, validateMergeTouchedPath(entry));
    if (bytes > MAX_MERGE_STATE_BYTES) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_STATE_BYTES} retained bytes`);
    }
  }
  return bytes;
}

export function mergeAlreadyActive(): GitError {
  return new GitError("EMERGEACTIVE", "a merge operation is already active");
}

export function mergeNotActive(): GitError {
  return new GitError("ENOMERGE", "no merge operation is active");
}
