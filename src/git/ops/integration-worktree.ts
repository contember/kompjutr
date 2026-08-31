// Shared bounded index, worktree, projection, and commit preflight for integration operations.

import { GitError } from "../common/errors.js";
import { comparePaths, joinSorted } from "../common/streams.js";
import { type IndexEntry, indexScanOwned } from "../store/index.js";
import type { IntegrationPlan } from "./integration.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import { projectMergePlan } from "./merge-projection.js";
import type { MergeTouchedPath } from "./merge-state.js";
import { checkoutBlockersAgainstOwned, checkoutBlockersOwned } from "./refs.js";
import type { Repository } from "./repository.js";
import {
  MAX_TREE_BUILD_LEAF_ENTRIES,
  MAX_TREE_BUILD_OBJECTS,
  preflightTreeBuild,
  type TreeBuildPreflightStats,
} from "./tree-build.js";
import { treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";
import {
  type DirtyPathLimits,
  dirtyPathStreamOwned,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io.js";

export const MAX_INTEGRATION_INDEX_ENTRIES = MAX_TREE_BUILD_LEAF_ENTRIES;
export const MAX_INTEGRATION_TREE_OBJECTS = MAX_TREE_BUILD_OBJECTS;
const MAX_REPOSITORY_ROWS = 50_000;
const MAX_RELOCATION_COLLISIONS = 1_000;
const NO_OMITTED_PATHS: ReadonlySet<string> = new Set();

function dirtyPathLimits(): DirtyPathLimits {
  return {
    maxIndexRows: MAX_INTEGRATION_INDEX_ENTRIES,
    indexRows: 0,
    maxWorktreeRows: MAX_REPOSITORY_ROWS,
    worktreeRows: 0,
    maxHashCandidates: MAX_INTEGRATION_INDEX_ENTRIES,
    hashCandidates: 0,
  };
}

export type IntegrationOperation = "merge" | "cherry-pick" | "revert" | "rebase";

function indexEntry(path: string, mode: string, oid: string): IndexEntry {
  return {
    path,
    stage: 0,
    mode: Number.parseInt(mode, 8),
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}

export function requireBoundedIntegrationTree(
  _repo: Repository,
  source: Iterable<IndexEntry> | (() => Iterable<IndexEntry>),
): TreeBuildPreflightStats {
  const entries = typeof source === "function" ? source() : source;
  return preflightTreeBuild(entries, {
    maxEntriesPerTree: MAX_INTEGRATION_INDEX_ENTRIES,
    maxTreeObjects: MAX_INTEGRATION_TREE_OBJECTS,
  });
}

function projectedIdentity(entry: ProjectedMergeEntry): { mode: string; oid: string } | null {
  if (entry.stageZero !== null) return entry.stageZero;
  if (entry.stages === null) return null;
  return entry.stages.current ?? entry.stages.incoming ?? entry.stages.base;
}

export function* prospectiveIntegrationIndexEntries(
  repo: Repository,
  projected: readonly ProjectedMergeEntry[],
): Generator<IndexEntry> {
  const owned = projectedTouchedShape(projected);
  let ownedIndex = 0;
  for (const row of joinSorted(indexScanOwned(repo.checkout), projected, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (row.right !== undefined) {
      const identity = projectedIdentity(row.right);
      if (identity !== null) yield indexEntry(row.right.path, identity.mode, identity.oid);
      continue;
    }
    if (row.left === undefined) continue;
    while (
      owned[ownedIndex] !== undefined &&
      comparePaths(owned[ownedIndex]?.path ?? "", row.left.path) < 0
    ) {
      ownedIndex++;
    }
    if (owned[ownedIndex]?.path !== row.left.path) yield row.left;
  }
}

function* continuationIndexEntries(repo: Repository): Generator<IndexEntry> {
  let previous: string | null = null;
  for (const entry of indexScanOwned(repo.checkout)) {
    if (entry.path === previous) continue;
    previous = entry.path;
    yield entry.stage === 0 ? entry : { ...entry, stage: 0 };
  }
}

export function requireBoundedIntegrationIndex(repo: Repository): TreeBuildPreflightStats {
  return requireBoundedIntegrationTree(repo, () => continuationIndexEntries(repo));
}

export function requireCleanIntegrationIndex(
  repo: Repository,
  headTree: string,
  operation: IntegrationOperation,
): void {
  if (repo.checkout.hasConflicts()) {
    throw new GitError("EUNMERGED", `cannot ${operation} with unmerged index entries`);
  }
  for (const row of joinSorted(treeStream(repo, headTree), repo.checkout.indexScan(), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const tree = row.left;
    const index = row.right;
    if (
      tree === undefined ||
      index === undefined ||
      index.stage !== 0 ||
      index.oid !== tree.oid ||
      index.mode !== Number.parseInt(tree.mode, 8)
    ) {
      throw new GitError("ECHECKOUTFAIL", `cannot ${operation}: the index contains staged changes`);
    }
  }
}

export function integrationIndexMatchesTree(repo: Repository, treeOid: string): boolean {
  if (repo.checkout.hasConflicts()) return false;
  for (const row of joinSorted(treeStream(repo, treeOid), repo.checkout.indexScan(), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (
      row.left === undefined ||
      row.right === undefined ||
      row.right.stage !== 0 ||
      row.right.oid !== row.left.oid ||
      row.right.mode !== Number.parseInt(row.left.mode, 8)
    ) {
      return false;
    }
  }
  return true;
}

export function requireCleanIntegrationWorktree(
  repo: Repository,
  worktree: Worktree,
  operation: IntegrationOperation,
  excludeRoots: string[] = [],
): void {
  const iterator = dirtyPathStreamOwned(repo, worktree, undefined, dirtyPathLimits(), excludeRoots);
  try {
    const dirty = iterator.next();
    if (dirty.done !== true) {
      throw new GitError(
        "ECHECKOUTFAIL",
        `cannot ${operation}: tracked working tree changes are present at ${dirty.value}`,
      );
    }
  } finally {
    iterator.return(undefined);
  }
}

export function requireSafeIntegrationWorktree(
  repo: Repository,
  worktree: Worktree,
  incomingTree: string | null,
  entries: readonly { path: string }[],
  operation: IntegrationOperation,
  baselineTree?: string | null,
): void {
  if (entries.length === 0) return;
  const paths = entries.map((entry) => entry.path);
  const limits = {
    maxRows: MAX_REPOSITORY_ROWS,
    rows: 0,
    maxHashCandidates: 1_000,
    hashCandidates: 0,
  };
  const blockers =
    baselineTree === undefined
      ? checkoutBlockersOwned(repo, worktree, incomingTree, paths, true, limits)
      : checkoutBlockersAgainstOwned(
          repo,
          worktree,
          baselineTree,
          incomingTree,
          paths,
          true,
          limits,
        );
  if (blockers.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${blockers.tracked.join(", ")} would be overwritten by ${operation}`,
    );
  }
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by ${operation}: ${blockers.untracked.join(", ")}`,
    );
  }
}

function collisionCandidateEnd(base: string, path: string): number | null {
  if (path === base || (path.startsWith(base) && path[base.length] === "/")) return base.length;
  if (!path.startsWith(base) || path[base.length] !== "_") return null;
  let end = base.length + 1;
  while (end < path.length && path.charCodeAt(end) >= 0x30 && path.charCodeAt(end) <= 0x39) end++;
  if (end === base.length + 1 || (end < path.length && path.charCodeAt(end) !== 0x2f)) return null;
  return end;
}

function retainCollision(
  path: string,
  bases: readonly string[],
  collisions: Set<string>,
  operation: IntegrationOperation,
): void {
  for (const base of bases) {
    const end = collisionCandidateEnd(base, path);
    if (end === null) continue;
    const candidate = end === base.length ? base : path.slice(0, end);
    if (collisions.has(candidate)) continue;
    if (collisions.size >= MAX_RELOCATION_COLLISIONS) {
      throw new GitError(
        "E2BIG",
        `${operation} relocation collisions exceed ${MAX_RELOCATION_COLLISIONS} paths`,
      );
    }
    collisions.add(candidate);
  }
}

function relocationCollisions(
  repo: Repository,
  worktree: Worktree,
  baseTree: string | null,
  incomingTree: string | null,
  initial: readonly ProjectedMergeEntry[],
  omitted: ReadonlySet<string>,
  operation: IntegrationOperation,
): { tracked: ReadonlySet<string>; untracked: ReadonlySet<string> } {
  let baseCount = 0;
  for (const entry of initial) {
    if (entry.purpose === "primary") continue;
    baseCount++;
  }
  const bases: string[] = [];
  for (const entry of initial) {
    if (entry.purpose !== "primary") bases.push(entry.path);
  }
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  if (baseCount === 0) return { tracked, untracked };
  let indexRows = 0;
  for (const entry of indexScanOwned(repo.checkout)) {
    if (indexRows >= MAX_REPOSITORY_ROWS) {
      throw new GitError(
        "E2BIG",
        `${operation} collision scan exceeds ${MAX_REPOSITORY_ROWS} rows`,
      );
    }
    indexRows++;
    if (!omitted.has(entry.path)) {
      retainCollision(entry.path, bases, tracked, operation);
    }
  }
  for (const entry of treeStream(repo, baseTree)) {
    retainCollision(entry.path, bases, tracked, operation);
  }
  for (const entry of treeStream(repo, incomingTree)) {
    retainCollision(entry.path, bases, tracked, operation);
  }

  let worktreeRows = 0;
  for (const row of joinSorted(
    indexScanOwned(repo.checkout),
    walkWorktreeEntriesStreamOwned(worktree, repo.root, {
      includeIgnored: true,
    }),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  )) {
    if (worktreeRows >= MAX_REPOSITORY_ROWS) {
      throw new GitError(
        "E2BIG",
        `${operation} collision scan exceeds ${MAX_REPOSITORY_ROWS} rows`,
      );
    }
    worktreeRows++;
    if (omitted.has(row.path)) continue;
    if (row.right !== undefined && row.left === undefined) {
      retainCollision(row.path, bases, untracked, operation);
    }
  }
  return { tracked, untracked };
}

export function projectIntegrationWithCollisions(
  repo: Repository,
  worktree: Worktree,
  baseTree: string | null,
  incomingTree: string | null,
  plan: IntegrationPlan,
  currentLabel: string,
  incomingLabel: string,
  omitted: ReadonlySet<string> = NO_OMITTED_PATHS,
  operation: IntegrationOperation = "merge",
): readonly ProjectedMergeEntry[] {
  const initial = projectMergePlan(plan, { currentLabel, incomingLabel });
  const collisions = relocationCollisions(
    repo,
    worktree,
    baseTree,
    incomingTree,
    initial,
    omitted,
    operation,
  );
  return projectMergePlan(plan, {
    currentLabel,
    incomingLabel,
    trackedCollisions: collisions.tracked,
    untrackedCollisions: collisions.untracked,
  });
}

export interface TouchedShape {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPath["purpose"];
}

export function touchedPathSet(entries: readonly { path: string }[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) continue;
    paths.add(entry.path);
  }
  return paths;
}

function buildProjectedTouchedShape(entries: readonly ProjectedMergeEntry[]): TouchedShape[] {
  const byPath = new Map<string, TouchedShape>();
  const retain = (
    path: string,
    logicalPath: string,
    purpose: MergeTouchedPath["purpose"],
  ): void => {
    if (byPath.has(path)) return;
    if (byPath.size >= 1_000) {
      throw new GitError("E2BIG", "integration ownership exceeds 1000 touched paths");
    }
    byPath.set(path, { path, logicalPath, purpose });
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      if (!byPath.has(ancestor)) {
        if (byPath.size >= 1_000) {
          throw new GitError("E2BIG", "integration ownership exceeds 1000 touched paths");
        }
        byPath.set(ancestor, {
          path: ancestor,
          logicalPath: ancestor,
          purpose: "primary",
        });
      }
      slash = ancestor.lastIndexOf("/");
    }
  };
  for (const entry of entries) {
    retain(entry.path, entry.logicalPath, entry.purpose);
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain(entry.logicalPath, entry.logicalPath, "primary");
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  return [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
}

export function projectedTouchedShape(entries: readonly ProjectedMergeEntry[]): TouchedShape[] {
  return buildProjectedTouchedShape(entries);
}
