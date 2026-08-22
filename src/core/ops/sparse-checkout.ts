// Bounded clean-workspace checkout without traversing the full tree.

import { contentIdKey, PACK_BLOB_CALLER_HEADROOM_BYTES } from "../../sqlite/store.js";
import type { GitContext } from "../context.js";
import { CorruptError, hasErrorCode } from "../errors.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import type { SparseWorkspaceResult, SparseWorkspaceRow } from "../sparse-workspace.js";
import { comparePaths } from "../streams.js";
import { gitModeFor, type Worktree, type WorktreeEntryType } from "../worktree.js";
import { flushCheckoutWrites } from "./checkout-writes.js";
import type { TargetEntry } from "./tree-stream.js";
import { hashExactWorktreePaths, indexMatchesStat, type WorktreePath } from "./worktree-io.js";

const SPARSE_CHECKOUT_PATHS = 1_000;
const SPARSE_CHECKOUT_ROW_BYTES = 384;
const SPARSE_CHECKOUT_PATH_VECTOR_BYTES = 64;
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
}

interface SparseCheckoutCandidate {
  path: string;
  before: TargetEntry | undefined;
  after: TargetEntry | undefined;
}

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
  const state = source.readState(repo.store.repoId);
  if (!state.available || state.baselineTreeOid !== baselineTreeOid) return false;
  try {
    for (const _entry of source.dirtyPaths(repo.store.repoId)) return false;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return false;
    throw error;
  }
  if (repo.store.hasCheckoutBlockingIndexEntries()) return false;

  const budget = new SparseCheckoutRetainedBudget();
  if (!budget.retain(256)) return false;
  const candidates = sparseCheckoutCandidates(repo, baselineTreeOid, targetTreeOid, budget);
  if (candidates === null) return false;
  if (candidates.length === 0) return true;

  const pathVectorBytes = SPARSE_CHECKOUT_PATH_VECTOR_BYTES + candidates.length * 8;
  if (!budget.retain(pathVectorBytes)) return false;
  const maxHydratedBytes = budget.remaining;
  let hydrated: SparseWorkspaceResult;
  try {
    hydrated = source.hydrate({
      repoId: repo.store.repoId,
      root: repo.root,
      baselineTreeOid,
      currentTreeOid: targetTreeOid,
      paths: candidates.map((candidate) => candidate.path),
      maxRetainedBytes: maxHydratedBytes,
    });
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return false;
    throw error;
  }
  if (!hydrated.available) return false;
  if (hydrated.rows.length !== candidates.length) {
    throw new CorruptError("sparse checkout hydration returned the wrong row count");
  }
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

  repo.store.indexApply((sink) => {
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
  repo.store.indexApply((sink) => {
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
