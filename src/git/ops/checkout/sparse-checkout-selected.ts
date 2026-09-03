import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type { IndexEntry } from "../../store/index.js";
import type {
  SelectedPathResult,
  SelectedWorktreeFact,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorktreeLeaf,
} from "../worktree/sparse-workspace.js";
import type { SparseCheckoutCandidate } from "./sparse-checkout-operation.js";

type AvailableSparseWorkspaceResult = Extract<SparseWorkspaceResult, { available: true }>;

function validNullableIndexNumber(value: number | null, minimum: number): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= minimum);
}

function selectedUtf8Bytes(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return null;
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return null;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else bytes += 3;
  }
  return bytes;
}

function validSelectedPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.endsWith("/")) return false;
  let segmentStart = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index !== path.length && path.charCodeAt(index) !== 0x2f) continue;
    const segmentLength = index - segmentStart;
    if (
      segmentLength === 0 ||
      (segmentLength === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
      (segmentLength === 2 &&
        path.charCodeAt(segmentStart) === 0x2e &&
        path.charCodeAt(segmentStart + 1) === 0x2e)
    ) {
      return false;
    }
    segmentStart = index + 1;
  }
  return selectedUtf8Bytes(path) !== null;
}

function validSelectedIndexEntry(entry: IndexEntry): boolean {
  return (
    typeof entry.path === "string" &&
    validSelectedPath(entry.path) &&
    Number.isSafeInteger(entry.stage) &&
    entry.stage >= 0 &&
    entry.stage <= 3 &&
    Number.isSafeInteger(entry.mode) &&
    [0o100644, 0o100755, 0o120000, 0o160000].includes(entry.mode) &&
    typeof entry.oid === "string" &&
    isOid(entry.oid) &&
    entry.size !== undefined &&
    validNullableIndexNumber(entry.size, 0) &&
    entry.mtime !== undefined &&
    validNullableIndexNumber(entry.mtime, Number.MIN_SAFE_INTEGER) &&
    entry.ino !== undefined &&
    validNullableIndexNumber(entry.ino, 1) &&
    (entry.rev === undefined || validNullableIndexNumber(entry.rev, 0))
  );
}

function validSelectedWorktreeLeaf(stat: SparseWorktreeLeaf): boolean {
  if (
    (stat.type !== "file" && stat.type !== "dir" && stat.type !== "symlink") ||
    !Number.isSafeInteger(stat.mode) ||
    stat.mode < 0 ||
    stat.mode > 0o7777 ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    !Number.isSafeInteger(stat.mtime) ||
    !Number.isSafeInteger(stat.ino) ||
    stat.ino <= 0 ||
    !Number.isSafeInteger(stat.nlink) ||
    stat.nlink <= 0 ||
    !Number.isSafeInteger(stat.rev) ||
    stat.rev < 0 ||
    (stat.contentId !== null && !(stat.contentId instanceof Uint8Array))
  ) {
    return false;
  }
  if (stat.type === "dir")
    return stat.size === 0 && stat.target === null && stat.contentId === null;
  if (stat.type === "file") return stat.target === null;
  return (
    typeof stat.target === "string" &&
    selectedUtf8Bytes(stat.target) === stat.size &&
    stat.contentId === null
  );
}

function validateSelectedFacts(
  index: readonly IndexEntry[],
  worktree: readonly SelectedWorktreeFact[],
  candidateCount: number,
): void {
  if (index.length > candidateCount * 4 || worktree.length > candidateCount) {
    throw new CorruptError("selected sparse checkout returned excessive facts");
  }
  let previousIndex: IndexEntry | undefined;
  for (let ordinal = 0; ordinal < index.length; ordinal++) {
    const entry = index[ordinal];
    if (entry === undefined || !validSelectedIndexEntry(entry)) {
      throw new CorruptError("selected sparse checkout returned a malformed index entry");
    }
    if (
      previousIndex !== undefined &&
      (comparePaths(previousIndex.path, entry.path) > 0 ||
        (previousIndex.path === entry.path && previousIndex.stage >= entry.stage))
    ) {
      throw new CorruptError("selected sparse checkout returned unordered index entries");
    }
    previousIndex = entry;
  }

  let previousPath: string | undefined;
  for (let ordinal = 0; ordinal < worktree.length; ordinal++) {
    const entry = worktree[ordinal];
    if (
      entry === undefined ||
      typeof entry.path !== "string" ||
      !validSelectedPath(entry.path) ||
      !validSelectedWorktreeLeaf(entry.stat)
    ) {
      throw new CorruptError("selected sparse checkout returned a malformed worktree entry");
    }
    if (previousPath !== undefined && comparePaths(previousPath, entry.path) >= 0) {
      throw new CorruptError("selected sparse checkout returned unordered worktree entries");
    }
    previousPath = entry.path;
  }
}

export function selectedSparseWorkspaceRows(
  candidates: readonly SparseCheckoutCandidate[],
  selected: Extract<SelectedPathResult, { available: true }>,
  trusted: boolean,
): AvailableSparseWorkspaceResult {
  if (!trusted) {
    if (!Array.isArray(selected.index) || !Array.isArray(selected.worktree)) {
      throw new CorruptError("selected sparse checkout returned malformed facts");
    }
    validateSelectedFacts(selected.index, selected.worktree, candidates.length);
  }

  const rows: SparseWorkspaceRow[] = [];
  let indexAt = 0;
  let worktreeAt = 0;
  for (const candidate of candidates) {
    const indexRows: IndexEntry[] = [];
    let indexEntry = selected.index[indexAt];
    if (indexEntry !== undefined && comparePaths(indexEntry.path, candidate.path) < 0) {
      throw new CorruptError("selected sparse checkout returned an unrelated index path");
    }
    while (indexEntry !== undefined && indexEntry.path === candidate.path) {
      indexRows.push(indexEntry);
      indexAt++;
      indexEntry = selected.index[indexAt];
    }

    let worktree: SparseWorktreeLeaf | null = null;
    const worktreeEntry = selected.worktree[worktreeAt];
    if (worktreeEntry !== undefined && comparePaths(worktreeEntry.path, candidate.path) < 0) {
      throw new CorruptError("selected sparse checkout returned an unrelated worktree path");
    }
    if (worktreeEntry?.path === candidate.path) {
      worktree = worktreeEntry.stat;
      worktreeAt++;
    }
    rows.push({
      path: candidate.path,
      baseline: candidate.before === undefined ? null : candidate.before,
      current: candidate.after === undefined ? null : candidate.after,
      index: indexRows,
      worktree,
    });
  }
  if (indexAt !== selected.index.length) {
    throw new CorruptError("selected sparse checkout returned an unrelated index path");
  }
  if (worktreeAt !== selected.worktree.length) {
    throw new CorruptError("selected sparse checkout returned an unrelated worktree path");
  }
  return { available: true, rows };
}
