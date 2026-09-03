import { GitError } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";
import type { IndexEntry } from "../store/index.js";
import type { SelectedWorktreeFact } from "./sparse-workspace.js";
import { ADD_RETAINED_BYTES } from "./staging-rm.js";
import type { AvailableSelectedPaths } from "./staging-selected-validation.js";

const SELECTED_MERGE_FIXED_BYTES = 128;
const SELECTED_MERGE_SLOT_BYTES = 8;
const ADD_SELECTED_PATHS = 1_000;

export function mergeSelectedAddResults(
  exact: AvailableSelectedPaths,
  recursive: AvailableSelectedPaths,
): AvailableSelectedPaths | null {
  if (exact.trusted && recursive.trusted) {
    const retainedPaths = new Set<string>();
    const retain = (path: string): boolean => {
      if (retainedPaths.has(path)) return true;
      if (retainedPaths.size === ADD_SELECTED_PATHS) return false;
      retainedPaths.add(path);
      return true;
    };
    const index = mergeSelectedIndexRows(exact.index, recursive.index, retain);
    if (index === null) return null;
    const worktree = mergeSelectedWorktreeRows(exact.worktree, recursive.worktree, retain);
    if (worktree === null) return null;
    return {
      available: true,
      index,
      worktree,
      structuralBytes: 0,
      trusted: true,
    };
  }
  const slots =
    exact.index.length + recursive.index.length + exact.worktree.length + recursive.worktree.length;
  const mergeCharge = SELECTED_MERGE_FIXED_BYTES + slots * SELECTED_MERGE_SLOT_BYTES;
  if (
    !Number.isSafeInteger(mergeCharge) ||
    exact.structuralBytes > ADD_RETAINED_BYTES - recursive.structuralBytes ||
    exact.structuralBytes + recursive.structuralBytes > ADD_RETAINED_BYTES - mergeCharge
  ) {
    return null;
  }
  const index = mergeSelectedIndexRows(exact.index, recursive.index);
  const worktree = mergeSelectedWorktreeRows(exact.worktree, recursive.worktree);
  if (index === null || worktree === null) return null;
  return {
    available: true,
    index,
    worktree,
    structuralBytes: exact.structuralBytes + recursive.structuralBytes + mergeCharge,
    trusted: false,
  };
}

function mergeSelectedIndexRows(
  left: readonly IndexEntry[],
  right: readonly IndexEntry[],
  retain?: (path: string) => boolean,
): IndexEntry[] | null {
  const rows: IndexEntry[] = [];
  const append = (row: IndexEntry): boolean => {
    if (retain !== undefined && !retain(row.path)) return false;
    rows.push(row);
    return true;
  };
  let leftAt = 0;
  let rightAt = 0;
  while (leftAt < left.length || rightAt < right.length) {
    const a = left[leftAt];
    const b = right[rightAt];
    if (a === undefined) {
      if (b !== undefined && !append(b)) return null;
      rightAt++;
      continue;
    }
    if (b === undefined) {
      if (!append(a)) return null;
      leftAt++;
      continue;
    }
    const order = comparePaths(a.path, b.path) || a.stage - b.stage;
    if (order < 0) {
      if (!append(a)) return null;
      leftAt++;
    } else if (order > 0) {
      if (!append(b)) return null;
      rightAt++;
    } else {
      if (!sameIndexEntry(a, b)) {
        throw new GitError("ECORRUPT", "selected add index sources disagreed on a row");
      }
      if (!append(a)) return null;
      leftAt++;
      rightAt++;
    }
  }
  return rows;
}

function sameIndexEntry(left: IndexEntry, right: IndexEntry): boolean {
  return (
    left.path === right.path &&
    left.stage === right.stage &&
    left.mode === right.mode &&
    left.oid === right.oid &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.ino === right.ino &&
    left.rev === right.rev
  );
}

function mergeSelectedWorktreeRows(
  left: readonly SelectedWorktreeFact[],
  right: readonly SelectedWorktreeFact[],
  retain?: (path: string) => boolean,
): SelectedWorktreeFact[] | null {
  const rows: SelectedWorktreeFact[] = [];
  const append = (row: SelectedWorktreeFact): boolean => {
    if (retain !== undefined && !retain(row.path)) return false;
    rows.push(row);
    return true;
  };
  let leftAt = 0;
  let rightAt = 0;
  while (leftAt < left.length || rightAt < right.length) {
    const a = left[leftAt];
    const b = right[rightAt];
    if (a === undefined) {
      if (b !== undefined && !append(b)) return null;
      rightAt++;
      continue;
    }
    if (b === undefined) {
      if (!append(a)) return null;
      leftAt++;
      continue;
    }
    const order = comparePaths(a.path, b.path);
    if (order < 0) {
      if (!append(a)) return null;
      leftAt++;
    } else if (order > 0) {
      if (!append(b)) return null;
      rightAt++;
    } else {
      if (!sameWorktreeFact(a, b)) {
        throw new GitError("ECORRUPT", "selected add worktree sources disagreed on a row");
      }
      if (!append(a)) return null;
      leftAt++;
      rightAt++;
    }
  }
  return rows;
}

function sameWorktreeFact(left: SelectedWorktreeFact, right: SelectedWorktreeFact): boolean {
  const a = left.stat;
  const b = right.stat;
  return (
    left.path === right.path &&
    a.type === b.type &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.rev === b.rev &&
    a.target === b.target &&
    sameBytes(a.contentId, b.contentId)
  );
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
