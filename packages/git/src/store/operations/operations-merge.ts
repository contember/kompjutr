// Durable, bounded state for one incomplete two-head merge.

import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";

export const MAX_MERGE_PATH_BYTES = 2_200;

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

export interface MergeJournal<Touched = readonly MergeTouchedPath[]> {
  state: MergeStateMetadata;
  touched: Touched;
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

export function mergeAlreadyActive(): GitError {
  return new GitError("EMERGEACTIVE", "a merge operation is already active");
}

export function mergeNotActive(): GitError {
  return new GitError("ENOMERGE", "no merge operation is active");
}
