// Bounded clean-workspace checkout without traversing the full tree.

import {
  contentIdKey,
  type IndexEntry,
  PACK_BLOB_CALLER_HEADROOM_BYTES,
} from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import type { GitContext } from "../context.js";
import { CorruptError, hasErrorCode } from "../errors.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import type {
  SelectedPathResult,
  SelectedWorktreeFact,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorktreeLeaf,
} from "../sparse-workspace.js";
import { comparePaths } from "../streams.js";
import { gitModeFor, type Worktree, type WorktreeEntryType } from "../worktree.js";
import { flushCheckoutWrites } from "./checkout-writes.js";
import type { TargetEntry } from "./tree-stream.js";
import { hashExactWorktreePaths, indexMatchesStat, type WorktreePath } from "./worktree-io.js";

const SPARSE_CHECKOUT_PATHS = 1_000;
const SPARSE_CHECKOUT_ROW_BYTES = 384;
const SPARSE_CHECKOUT_PATH_VECTOR_BYTES = 64;
const SPARSE_CHECKOUT_SELECTED_SPEC_BYTES = 72;
const SPARSE_CHECKOUT_SELECTED_INDEX_BYTES = 320;
const SPARSE_CHECKOUT_SELECTED_WORKTREE_BYTES = 512;
const SPARSE_CHECKOUT_SELECTED_RESULT_BYTES = 64;
const SPARSE_CHECKOUT_SELECTED_ROWS_BYTES = 64;
const SPARSE_CHECKOUT_SELECTED_ROW_BYTES = 256;
const SPARSE_CHECKOUT_SELECTED_INDEX_ARRAY_BYTES = 64;
const SPARSE_CHECKOUT_SELECTED_ARRAY_SLOT_BYTES = 8;
const SPARSE_CHECKOUT_GUARD_ROW_BYTES = 512;
const SPARSE_CHECKOUT_CHANGE_ROW_BYTES = 128;
const CHECKOUT_PATH_FIXED_BYTES = 96;
const SPARSE_CHECKOUT_FIXED_BYTES = 384;
const SPARSE_CHECKOUT_SQL_LIMIT = 1_000;
// Conservatively reserves all non-prune tree, guard, write, HEAD and reseal SQL.
const SPARSE_CHECKOUT_FIXED_SQL = 400;
// Guarded ancestors are real: stat costs two SQL, and resolve + LIMIT 1 scan costs two.
const SPARSE_CHECKOUT_STAT_SQL = 2;
// Keep one extra statement over the measured two-SQL directory probe.
const SPARSE_CHECKOUT_DIRECTORY_PROBE_SQL = 3;
const SPARSE_CHECKOUT_GROUP_REMOVE_SQL = 7;

class SparseCheckoutRetainedBudget {
  #retainedBytes = 0;

  get remaining(): number {
    return PACK_BLOB_CALLER_HEADROOM_BYTES - this.#retainedBytes;
  }

  retain(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining) return false;
    this.#retainedBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#retainedBytes) {
      throw new CorruptError("sparse checkout retained accounting is invalid");
    }
    this.#retainedBytes -= bytes;
  }
}

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

  const baselineTreeOid = repo.headTree();
  const state = source.readState(repo.checkout.checkoutId);
  if (!state.available || state.baselineTreeOid !== baselineTreeOid) return false;
  try {
    for (const _entry of source.dirtyPaths(repo.checkout.checkoutId)) return false;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return false;
    throw error;
  }
  if (repo.checkout.hasCheckoutBlockingIndexEntries()) return false;

  const budget = new SparseCheckoutRetainedBudget();
  if (!budget.retain(256)) return false;
  const candidates = sparseCheckoutCandidates(repo, baselineTreeOid, targetTreeOid, budget);
  if (candidates === null) return false;
  if (candidates.length === 0) return true;

  const selected = selectSparseCheckoutRows(context, repo, candidates, budget);
  const hydrated =
    selected ??
    hydrateSparseCheckoutRows(source, repo, candidates, baselineTreeOid, targetTreeOid, budget);
  if (hydrated === null) return false;
  if (hydrated.rows.length !== candidates.length) {
    throw new CorruptError("sparse checkout hydration returned the wrong row count");
  }
  const maxHydratedBytes = budget.remaining;
  if (
    !Number.isSafeInteger(hydrated.retainedBytes) ||
    hydrated.retainedBytes < 0 ||
    hydrated.retainedBytes > maxHydratedBytes
  ) {
    throw new CorruptError("sparse checkout hydration returned an invalid retained size");
  }
  if (!budget.retain(hydrated.retainedBytes)) return false;
  if (!validateSparseCheckoutRows(candidates, hydrated.rows)) return false;
  if (!sparseCheckoutWorktreeMatches(repo, worktree, hydrated.rows, budget)) return false;

  if (!budget.retain(candidates.length * SPARSE_CHECKOUT_CHANGE_ROW_BYTES)) return false;
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
  return checkoutSparseChanges(repo, worktree, changes, budget.remaining);
}

function hydrateSparseCheckoutRows(
  source: NonNullable<GitContext["sparseWorkspace"]>,
  repo: Repository,
  candidates: readonly SparseCheckoutCandidate[],
  baselineTreeOid: string | null,
  targetTreeOid: string,
  budget: SparseCheckoutRetainedBudget,
): AvailableSparseWorkspaceResult | null {
  const pathVectorBytes = SPARSE_CHECKOUT_PATH_VECTOR_BYTES + candidates.length * 8;
  if (!budget.retain(pathVectorBytes)) return null;
  try {
    const hydrated = source.hydrate({
      repoId: repo.store.repoId,
      checkoutId: repo.checkout.checkoutId,
      root: repo.root,
      baselineTreeOid,
      currentTreeOid: targetTreeOid,
      paths: candidates.map((candidate) => candidate.path),
      maxRetainedBytes: budget.remaining,
    });
    return hydrated.available ? hydrated : null;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

function selectSparseCheckoutRows(
  context: GitContext,
  repo: Repository,
  candidates: readonly SparseCheckoutCandidate[],
  budget: SparseCheckoutRetainedBudget,
): AvailableSparseWorkspaceResult | null {
  const source = context.selectedPaths;
  if (source === undefined || hasStructuralCandidates(candidates)) return null;
  const requestBytes =
    SPARSE_CHECKOUT_PATH_VECTOR_BYTES + candidates.length * SPARSE_CHECKOUT_SELECTED_SPEC_BYTES;
  if (!budget.retain(requestBytes)) return null;
  const maxRetainedBytes = budget.remaining;
  let selected: SelectedPathResult;
  try {
    selected = source.select({
      repoId: repo.store.repoId,
      checkoutId: repo.checkout.checkoutId,
      root: repo.root,
      specs: candidates.map((candidate) => ({ path: candidate.path, recursive: false })),
      maxRetainedBytes,
    });
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  } finally {
    budget.release(requestBytes);
  }
  if (!selected.available) return null;
  if (
    !Number.isSafeInteger(selected.retainedBytes) ||
    selected.retainedBytes < 0 ||
    selected.retainedBytes > maxRetainedBytes
  ) {
    throw new CorruptError("selected sparse checkout returned an invalid retained size");
  }
  return selectedSparseWorkspaceRows(candidates, selected, maxRetainedBytes);
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

function selectedUtf8Bytes(value: string, maximum: number): number | null {
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
    if (bytes > maximum) return null;
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
  return selectedUtf8Bytes(path, 2_200) !== null;
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
    selectedUtf8Bytes(stat.target, stat.size) === stat.size &&
    stat.contentId === null
  );
}

function validateSelectedFacts(
  index: readonly IndexEntry[],
  worktree: readonly SelectedWorktreeFact[],
  retainedBytes: number,
  candidateCount: number,
): void {
  if (index.length > candidateCount * 4 || worktree.length > candidateCount) {
    throw new CorruptError("selected sparse checkout returned excessive facts");
  }
  let accountedBytes = 0;
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
    const factBytes = SPARSE_CHECKOUT_SELECTED_INDEX_BYTES + entry.path.length * 2;
    if (accountedBytes > retainedBytes - factBytes) {
      throw new CorruptError("selected sparse checkout underreported retained state");
    }
    accountedBytes += factBytes;
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
    const targetBytes = entry.stat.target === null ? 0 : entry.stat.size * 2;
    const contentBytes = entry.stat.contentId?.byteLength ?? 0;
    const factBytes =
      SPARSE_CHECKOUT_SELECTED_WORKTREE_BYTES + entry.path.length * 2 + targetBytes + contentBytes;
    if (
      !Number.isSafeInteger(factBytes) ||
      factBytes < 0 ||
      accountedBytes > retainedBytes - factBytes
    ) {
      throw new CorruptError("selected sparse checkout underreported retained state");
    }
    accountedBytes += factBytes;
    previousPath = entry.path;
  }
}

function selectedMappingRetainedBytes(candidateCount: number, indexCount: number): number | null {
  const fixed = SPARSE_CHECKOUT_SELECTED_RESULT_BYTES + SPARSE_CHECKOUT_SELECTED_ROWS_BYTES;
  const perCandidate =
    SPARSE_CHECKOUT_SELECTED_ROW_BYTES +
    SPARSE_CHECKOUT_SELECTED_INDEX_ARRAY_BYTES +
    SPARSE_CHECKOUT_SELECTED_ARRAY_SLOT_BYTES;
  const indexSlots = indexCount * SPARSE_CHECKOUT_SELECTED_ARRAY_SLOT_BYTES;
  if (
    !Number.isSafeInteger(indexSlots) ||
    candidateCount > Math.floor((Number.MAX_SAFE_INTEGER - fixed - indexSlots) / perCandidate)
  ) {
    return null;
  }
  return fixed + candidateCount * perCandidate + indexSlots;
}

function selectedSparseWorkspaceRows(
  candidates: readonly SparseCheckoutCandidate[],
  selected: Extract<SelectedPathResult, { available: true }>,
  maxRetainedBytes: number,
): AvailableSparseWorkspaceResult | null {
  if (!Array.isArray(selected.index) || !Array.isArray(selected.worktree)) {
    throw new CorruptError("selected sparse checkout returned malformed facts");
  }
  validateSelectedFacts(
    selected.index,
    selected.worktree,
    selected.retainedBytes,
    candidates.length,
  );
  const mappingBytes = selectedMappingRetainedBytes(candidates.length, selected.index.length);
  if (mappingBytes === null || selected.retainedBytes > maxRetainedBytes - mappingBytes) {
    return null;
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
  return { available: true, rows, retainedBytes: selected.retainedBytes + mappingBytes };
}

function sparseCheckoutCandidates(
  repo: Repository,
  baselineTreeOid: string | null,
  targetTreeOid: string,
  budget: SparseCheckoutRetainedBudget,
): SparseCheckoutCandidate[] | null {
  const candidates: SparseCheckoutCandidate[] = [];
  try {
    for (const entry of repo.walkTreeDiff(baselineTreeOid, targetTreeOid)) {
      if (entry.beforeMode === "160000" || entry.afterMode === "160000") return null;
      if (candidates.length === SPARSE_CHECKOUT_PATHS) return null;
      const bytes = SPARSE_CHECKOUT_ROW_BYTES + entry.path.length * 2;
      if (!budget.retain(bytes)) return null;
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
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
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
  budget: SparseCheckoutRetainedBudget,
): boolean {
  const pending: Array<{ expected: TargetEntry; worktree: WorktreePath }> = [];
  for (const row of rows) {
    if (row.baseline === null) continue;
    const entry = row.index[0];
    if (entry === undefined || row.worktree === null || row.worktree.type === "dir") return false;
    const candidate: WorktreePath = { path: row.path, stat: row.worktree };
    if (!indexMatchesStat(entry, candidate.stat)) {
      if (!budget.retain(SPARSE_CHECKOUT_GUARD_ROW_BYTES)) return false;
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
  const hashed = hashExactWorktreePaths(repo, worktree, unresolved, { write: false });
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
  maxRetainedBytes: number,
): boolean {
  const plan = prepareSparseCheckout(changes, maxRetainedBytes);
  if (plan === null) return false;

  repo.checkout.indexApply((sink) => {
    if (plan.structuralRoots.length > 0) {
      worktree.removeFiles(
        plan.structuralRoots.map((path) => joinPath(repo.root, path)),
        { recursive: true },
      );
    }
    if (plan.physicalRemovals.length > 0) {
      worktree.removeFiles(plan.physicalRemovals.map((path) => joinPath(repo.root, path)));
    }
    for (const path of plan.indexRemovals) sink.remove(path);
    sink.flush();
  });
  pruneSparseDirectories(repo, worktree, plan.pruneGroups);
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
  changes: readonly SparseCheckoutChange[],
  maxRetainedBytes: number,
): SparseCheckoutPlan | null {
  if (maxRetainedBytes < SPARSE_CHECKOUT_FIXED_BYTES) return null;
  let retainedBytes = SPARSE_CHECKOUT_FIXED_BYTES;
  const retain = (path: string): boolean => {
    const bytes = CHECKOUT_PATH_FIXED_BYTES + path.length * 2;
    if (bytes > maxRetainedBytes - retainedBytes) return false;
    retainedBytes += bytes;
    return true;
  };

  const structuralRoots: string[] = [];
  for (const change of changes) {
    if (change.after === undefined || change.worktreeType !== "dir") continue;
    if (!retain(change.path)) return null;
    structuralRoots.push(change.path);
  }
  structuralRoots.sort(comparePaths);

  const minimalStructuralRoots: string[] = [];
  for (const path of structuralRoots) {
    const previous = minimalStructuralRoots[minimalStructuralRoots.length - 1];
    if (previous !== undefined && path.startsWith(`${previous}/`)) continue;
    minimalStructuralRoots.push(path);
  }

  const physicalRemovals: string[] = [];
  const indexRemovals: string[] = [];
  const writes: TargetEntry[] = [];
  const pruneDirectories = new Set<string>();
  for (const change of changes) {
    if (!retain(change.path)) return null;
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
        if (!retain(directory)) return null;
        pruneDirectories.add(directory);
      }
      slash = directory.lastIndexOf("/");
    }
  }

  const byDepth = new Map<number, string[]>();
  for (const directory of pruneDirectories) {
    const depth = directory.split("/").length;
    const group = byDepth.get(depth);
    if (group === undefined) byDepth.set(depth, [directory]);
    else group.push(directory);
  }
  const depths = [...byDepth.keys()].sort((left, right) => right - left);
  const pruneStatements =
    pruneDirectories.size * (SPARSE_CHECKOUT_STAT_SQL + SPARSE_CHECKOUT_DIRECTORY_PROBE_SQL) +
    depths.length * SPARSE_CHECKOUT_GROUP_REMOVE_SQL;
  if (pruneStatements > SPARSE_CHECKOUT_SQL_LIMIT - SPARSE_CHECKOUT_FIXED_SQL) return null;
  const pruneGroups: string[][] = [];
  for (const depth of depths) {
    const group = byDepth.get(depth);
    if (group === undefined) continue;
    group.sort(comparePaths);
    pruneGroups.push(group);
  }

  return {
    structuralRoots: minimalStructuralRoots,
    physicalRemovals,
    indexRemovals,
    pruneGroups,
    writes,
  };
}

function withinSparseRoot(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}/`)) return true;
    if (comparePaths(root, path) > 0) return false;
  }
  return false;
}

function pruneSparseDirectories(
  repo: Repository,
  worktree: Worktree,
  groups: readonly string[][],
): void {
  for (const group of groups) {
    const empty: string[] = [];
    for (const directory of group) {
      const absolute = joinPath(repo.root, directory);
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
