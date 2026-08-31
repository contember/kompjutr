// Bounded clean-workspace checkout without traversing the full tree.

import { isOid } from "../common/bytes.js";
import { CorruptError, hasErrorCode } from "../common/errors.js";
import { joinPath } from "../common/paths.js";
import { comparePaths } from "../common/streams.js";
import { contentIdKey, type IndexEntry } from "../store/index.js";
import {
  hydrateSparseWorkspaceOwned,
  selectSparsePathsOwned,
  sparseDirtyPathsOwned,
} from "../store/sparse-workspace.js";
import { flushCheckoutWrites } from "./checkout-writes.js";
import type { GitContext } from "./context.js";
import type { Repository } from "./repository.js";
import type {
  SelectedPathResult,
  SelectedWorktreeFact,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorktreeLeaf,
} from "./sparse-workspace.js";
import type { TargetEntry } from "./tree-stream.js";
import { gitModeFor, type Worktree, type WorktreeEntryType } from "./worktree.js";
import { hashExactWorktreePathsOwned, indexMatchesStat, type WorktreePath } from "./worktree-io.js";

const SPARSE_CHECKOUT_PATHS = 1_000;

interface SparseCheckoutCandidate {
  path: string;
  before: TargetEntry | undefined;
  after: TargetEntry | undefined;
}

type AvailableSparseWorkspaceResult = Extract<SparseWorkspaceResult, { available: true }>;

export interface SparseCheckoutChange {
  path: string;
  before: TargetEntry | undefined;
  after: TargetEntry | undefined;
  worktreeType: WorktreeEntryType | null;
}

export function trySparseCleanCheckout(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  targetTreeOid: string,
): boolean {
  const source = context.sparseWorkspace;
  const tracker = context.indexTracker;
  if (source === undefined || tracker === undefined) return false;

  let applying = false;
  try {
    const baselineTreeOid = repo.headTree();
    const state = source.readState(repo.checkout.checkoutId);
    if (!state.available || state.baselineTreeOid !== baselineTreeOid) return false;
    for (const _entry of sparseDirtyPathsOwned(source, repo.checkout.checkoutId)) {
      return false;
    }
    if (repo.checkout.hasCheckoutBlockingIndexEntries()) return false;

    const candidates = sparseCheckoutCandidates(repo, baselineTreeOid, targetTreeOid);
    if (candidates === null) return false;
    if (candidates.length === 0) return true;

    const selected = selectSparseCheckoutRows(context, repo, candidates);
    const hydrated =
      selected ??
      hydrateSparseCheckoutRows(source, repo, candidates, baselineTreeOid, targetTreeOid);
    if (hydrated === null) return false;
    if (hydrated.rows.length !== candidates.length) {
      throw new CorruptError("sparse checkout hydration returned the wrong row count");
    }
    if (!validateSparseCheckoutRows(candidates, hydrated.rows)) return false;
    if (!sparseCheckoutWorktreeMatches(repo, worktree, hydrated.rows)) return false;

    const changes: SparseCheckoutChange[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const row = hydrated.rows[index];
      if (candidate === undefined || row === undefined) {
        throw new CorruptError("sparse checkout hydration lost a candidate");
      }
      changes.push({
        path: candidate.path,
        before: candidate.before,
        after: candidate.after,
        worktreeType: row.worktree?.type ?? null,
      });
    }
    applying = true;
    return checkoutSparseChanges(repo, worktree, changes);
  } catch (error) {
    if (!applying && hasErrorCode(error, "E2BIG")) return false;
    throw error;
  }
}

function hydrateSparseCheckoutRows(
  source: NonNullable<GitContext["sparseWorkspace"]>,
  repo: Repository,
  candidates: readonly SparseCheckoutCandidate[],
  baselineTreeOid: string | null,
  targetTreeOid: string,
): AvailableSparseWorkspaceResult | null {
  const hydrated = hydrateSparseWorkspaceOwned(source, {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    baselineTreeOid,
    currentTreeOid: targetTreeOid,
    paths: candidates.map((candidate) => candidate.path),
  });
  return hydrated.available ? hydrated : null;
}

function selectSparseCheckoutRows(
  context: GitContext,
  repo: Repository,
  candidates: readonly SparseCheckoutCandidate[],
): AvailableSparseWorkspaceResult | null {
  const source = context.selectedPaths;
  if (source === undefined || hasStructuralCandidates(candidates)) return null;
  const selected: SelectedPathResult = selectSparsePathsOwned(source, {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    specs: candidates.map((candidate) => ({ path: candidate.path, recursive: false })),
  });
  if (!selected.available) return null;
  return selectedSparseWorkspaceRows(candidates, selected);
}

function hasStructuralCandidates(candidates: readonly SparseCheckoutCandidate[]): boolean {
  for (let left = 0; left < candidates.length; left++) {
    const parent = candidates[left];
    if (parent === undefined) continue;
    for (let right = left + 1; right < candidates.length; right++) {
      const child = candidates[right];
      if (
        child !== undefined &&
        child.path.length > parent.path.length &&
        child.path.startsWith(parent.path) &&
        child.path.charCodeAt(parent.path.length) === 0x2f
      ) {
        return true;
      }
    }
  }
  return false;
}

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

function selectedSparseWorkspaceRows(
  candidates: readonly SparseCheckoutCandidate[],
  selected: Extract<SelectedPathResult, { available: true }>,
): AvailableSparseWorkspaceResult | null {
  if (!Array.isArray(selected.index) || !Array.isArray(selected.worktree)) {
    throw new CorruptError("selected sparse checkout returned malformed facts");
  }
  validateSelectedFacts(selected.index, selected.worktree, candidates.length);

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

function sparseCheckoutCandidates(
  repo: Repository,
  baselineTreeOid: string | null,
  targetTreeOid: string,
): SparseCheckoutCandidate[] | null {
  const candidates: SparseCheckoutCandidate[] = [];
  for (const entry of repo.store.walkTreeDiff(baselineTreeOid, targetTreeOid)) {
    if (entry.beforeMode === "160000" || entry.afterMode === "160000") {
      return null;
    }
    if (candidates.length === SPARSE_CHECKOUT_PATHS) {
      return null;
    }
    candidates.push({
      path: entry.path,
      before:
        entry.beforeMode === null || entry.beforeOid === null
          ? undefined
          : { path: entry.path, mode: entry.beforeMode, oid: entry.beforeOid },
      after:
        entry.afterMode === null || entry.afterOid === null
          ? undefined
          : { path: entry.path, mode: entry.afterMode, oid: entry.afterOid },
    });
  }
  return candidates;
}

function validateSparseCheckoutRows(
  candidates: readonly SparseCheckoutCandidate[],
  rows: readonly SparseWorkspaceRow[],
): boolean {
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const row = rows[index];
    if (candidate === undefined || row === undefined || row.path !== candidate.path) {
      throw new CorruptError("sparse checkout hydration returned unordered rows");
    }
    if (
      !sameSparseLeaf(row.baseline, candidate.before) ||
      !sameSparseLeaf(row.current, candidate.after)
    ) {
      throw new CorruptError("sparse checkout hydration disagrees with the tree difference");
    }
    if (candidate.before === undefined) {
      if (row.index.length !== 0) return false;
      if (row.worktree !== null && row.worktree.type !== "dir") return false;
      continue;
    }
    const entry = row.index[0];
    if (
      row.index.length !== 1 ||
      entry === undefined ||
      entry.stage !== 0 ||
      entry.oid !== candidate.before.oid ||
      entry.mode !== Number.parseInt(candidate.before.mode, 8) ||
      row.worktree === null ||
      row.worktree.type === "dir" ||
      gitModeFor(row.worktree) !== candidate.before.mode
    ) {
      return false;
    }
  }
  return true;
}

function sameSparseLeaf(
  leaf: { mode: string; oid: string } | null,
  entry: TargetEntry | undefined,
): boolean {
  if (leaf === null || entry === undefined) return leaf === null && entry === undefined;
  return leaf.mode === entry.mode && leaf.oid === entry.oid;
}

function sparseCheckoutWorktreeMatches(
  repo: Repository,
  worktree: Worktree,
  rows: readonly SparseWorkspaceRow[],
): boolean {
  const pending: Array<{ expected: TargetEntry; worktree: WorktreePath }> = [];
  for (const row of rows) {
    if (row.baseline === null) continue;
    const entry = row.index[0];
    if (entry === undefined || row.worktree === null || row.worktree.type === "dir") return false;
    const candidate: WorktreePath = { path: row.path, stat: row.worktree };
    if (!indexMatchesStat(entry, candidate.stat)) {
      pending.push({
        expected: { path: row.path, mode: row.baseline.mode, oid: row.baseline.oid },
        worktree: candidate,
      });
    }
  }
  const mapped = repo.store.lookupBlobIds(
    pending.flatMap(({ worktree: candidate }) => {
      const contentId = candidate.stat.contentId;
      return contentId === null ? [] : [contentId];
    }),
  );
  const unresolved: WorktreePath[] = [];
  const unresolvedExpected = new Map<string, TargetEntry>();
  for (const candidate of pending) {
    const contentId = candidate.worktree.stat.contentId;
    const oid = contentId === null ? undefined : mapped.get(contentIdKey(contentId));
    if (oid === candidate.expected.oid) continue;
    unresolved.push(candidate.worktree);
    unresolvedExpected.set(candidate.expected.path, candidate.expected);
  }
  const hashed = hashExactWorktreePathsOwned(repo, worktree, unresolved, {
    write: false,
  });
  for (const candidate of unresolved) {
    const expected = unresolvedExpected.get(candidate.path);
    const actual = hashed.get(candidate.path);
    if (
      expected === undefined ||
      actual === undefined ||
      actual.oid !== expected.oid ||
      actual.mode !== expected.mode
    ) {
      return false;
    }
  }
  return true;
}

/** Apply a complete, pre-guarded leaf diff without traversing the full tree. */
export function checkoutSparseChanges(
  repo: Repository,
  worktree: Worktree,
  changes: readonly SparseCheckoutChange[],
): boolean {
  let plan: SparseCheckoutPlan;
  try {
    plan = prepareSparseCheckout(repo.root, changes);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return false;
    throw error;
  }

  repo.checkout.indexApply((sink) => {
    if (plan.structuralRoots.length > 0) {
      worktree.removeFiles(plan.structuralRoots, { recursive: true });
    }
    if (plan.physicalRemovals.length > 0) {
      worktree.removeFiles(plan.physicalRemovals);
    }
    for (const path of plan.indexRemovals) sink.remove(path);
    sink.flush();
  });
  pruneSparseDirectories(worktree, plan.pruneGroups);
  repo.checkout.indexApply((sink) => {
    const written = [...plan.writes];
    flushCheckoutWrites(repo, worktree, written, sink);
  });
  return true;
}

interface SparseCheckoutPlan {
  structuralRoots: string[];
  physicalRemovals: string[];
  indexRemovals: string[];
  pruneGroups: string[][];
  writes: TargetEntry[];
}

function prepareSparseCheckout(
  root: string,
  changes: readonly SparseCheckoutChange[],
): SparseCheckoutPlan {
  const structuralRoots: string[] = [];
  for (const change of changes) {
    if (change.after === undefined || change.worktreeType !== "dir") continue;
    structuralRoots.push(change.path);
  }
  structuralRoots.sort(comparePaths);

  const minimalStructuralRoots: string[] = [];
  for (const path of structuralRoots) {
    const previous = minimalStructuralRoots[minimalStructuralRoots.length - 1];
    if (
      previous !== undefined &&
      path.length > previous.length &&
      path.startsWith(previous) &&
      path.charCodeAt(previous.length) === 0x2f
    ) {
      continue;
    }
    minimalStructuralRoots.push(path);
  }

  const physicalRemovals: string[] = [];
  const indexRemovals: string[] = [];
  const writes: TargetEntry[] = [];
  const pruneDirectories = new Set<string>();
  for (const change of changes) {
    if (change.before !== undefined && change.after === undefined) {
      indexRemovals.push(change.path);
      if (!withinSparseRoot(change.path, minimalStructuralRoots)) {
        physicalRemovals.push(change.path);
      }
    }
    if (change.after !== undefined) writes.push(change.after);
  }

  const removalRoots = [...physicalRemovals, ...minimalStructuralRoots];
  for (const path of removalRoots) {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const directory = path.slice(0, slash);
      if (!pruneDirectories.has(directory)) {
        pruneDirectories.add(directory);
      }
      slash = directory.lastIndexOf("/");
    }
  }

  const byDepth = new Map<number, string[]>();
  for (const directory of pruneDirectories) {
    let depth = 1;
    for (let at = directory.indexOf("/"); at !== -1; at = directory.indexOf("/", at + 1)) {
      depth++;
    }
    const group = byDepth.get(depth);
    if (group === undefined) byDepth.set(depth, [directory]);
    else group.push(directory);
  }
  const depths = [...byDepth.keys()].sort((left, right) => right - left);
  const pruneGroups: string[][] = [];
  for (const depth of depths) {
    const group = byDepth.get(depth);
    if (group === undefined) continue;
    group.sort(comparePaths);
    pruneGroups.push(group);
  }

  return {
    structuralRoots: absoluteSparsePaths(root, minimalStructuralRoots),
    physicalRemovals: absoluteSparsePaths(root, physicalRemovals),
    indexRemovals,
    pruneGroups: pruneGroups.map((group) => absoluteSparsePaths(root, group)),
    writes,
  };
}

function absoluteSparsePaths(root: string, paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of paths) {
    result.push(joinPath(root, path));
  }
  return result;
}

function withinSparseRoot(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (
      path === root ||
      (path.length > root.length && path.startsWith(root) && path.charCodeAt(root.length) === 0x2f)
    ) {
      return true;
    }
    if (comparePaths(root, path) > 0) return false;
  }
  return false;
}

function pruneSparseDirectories(worktree: Worktree, groups: readonly string[][]): void {
  for (const group of groups) {
    const empty: string[] = [];
    for (const absolute of group) {
      if (
        worktree.stat(absolute)?.type === "dir" &&
        worktree.scan(absolute, { limit: 1 }).length === 0
      ) {
        empty.push(absolute);
      }
    }
    if (empty.length > 0) worktree.removeFiles(empty);
  }
}
