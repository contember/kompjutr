// Shared bounded index, worktree, projection, and commit preflight for integration operations.

import type { IndexEntry } from "../../sqlite/store.js";
import { GitError } from "../errors.js";
import type { Repository } from "../repository.js";
import { comparePaths, joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { commitMaterializationSqlStatements, commitPublicationSqlStatements } from "./commit.js";
import { type IntegrationPlan, MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ } from "./integration.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import { projectMergePlan } from "./merge-projection.js";
import type { MergeTouchedPath } from "./merge-state.js";
import { checkoutBlockers, checkoutBlockersAgainst } from "./refs.js";
import {
  MAX_TREE_BUILD_LEAF_ENTRIES,
  MAX_TREE_BUILD_OBJECTS,
  MAX_TREE_BUILD_SERIALIZED_BYTES,
  MAX_TREE_BUILD_TOTAL_PATH_BYTES,
  preflightTreeBuild,
  TREE_BUILD_EXECUTION_MEMORY_BYTES,
  type TreeBuildPreflightStats,
} from "./tree-build.js";
import { treeStream } from "./tree-stream.js";
import { type DirtyPathLimits, dirtyPathStream, walkWorktreeEntriesStream } from "./worktree-io.js";

export const MAX_INTEGRATION_INDEX_ENTRIES = MAX_TREE_BUILD_LEAF_ENTRIES;
export const MAX_INTEGRATION_INDEX_PATH_BYTES = MAX_TREE_BUILD_TOTAL_PATH_BYTES;
export const MAX_INTEGRATION_TREE_OBJECTS = MAX_TREE_BUILD_OBJECTS;
export const MAX_INTEGRATION_SERIALIZED_TREE_BYTES = MAX_TREE_BUILD_SERIALIZED_BYTES;
export const INTEGRATION_INDEX_SQL_STATEMENTS = 48;
export const INTEGRATION_GUARD_SQL_STATEMENTS = 300;
export const INTEGRATION_COLLISION_SQL_STATEMENTS = 160;
const MAX_REPOSITORY_ROWS = 50_000;
const MAX_GUARD_HASH_BYTES = 32 * 1024 * 1024;
export const INTEGRATION_EXECUTION_HEADROOM_BYTES = TREE_BUILD_EXECUTION_MEMORY_BYTES;
const MAX_RELOCATION_COLLISIONS = 1_000;

function dirtyPathLimits(): DirtyPathLimits {
  return {
    maxIndexRows: MAX_INTEGRATION_INDEX_ENTRIES,
    indexRows: 0,
    maxWorktreeRows: MAX_REPOSITORY_ROWS,
    worktreeRows: 0,
    maxHashCandidates: MAX_INTEGRATION_INDEX_ENTRIES,
    hashCandidates: 0,
    maxHashBytes: MAX_GUARD_HASH_BYTES,
    hashBytes: 0,
    maxHashRangeReads: 64,
    hashRangeReads: 0,
    maxHashBatches: 10,
    hashBatches: 0,
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

export function integrationSqlStatements(plan: IntegrationPlan, treeStatements: number): number {
  return treeStatements + plan.blobReadCalls * MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ;
}

export const integrationCommitMaterializationSqlStatements = commitMaterializationSqlStatements;
export const integrationCommitSqlStatements = commitPublicationSqlStatements;

export const MAX_INTEGRATION_COMMIT_SQL_STATEMENTS = integrationCommitSqlStatements({
  leafEntries: MAX_INTEGRATION_INDEX_ENTRIES,
  totalPathBytes: MAX_INTEGRATION_INDEX_PATH_BYTES,
  treeObjects: MAX_INTEGRATION_TREE_OBJECTS,
  serializedTreeBytes: MAX_INTEGRATION_SERIALIZED_TREE_BYTES,
  maxSingleTreeBytes: MAX_INTEGRATION_SERIALIZED_TREE_BYTES,
});

export function requireBoundedIntegrationTree(
  entries: Iterable<IndexEntry>,
): TreeBuildPreflightStats {
  return preflightTreeBuild(entries, {
    maxLeafEntries: MAX_INTEGRATION_INDEX_ENTRIES,
    maxTotalPathBytes: MAX_INTEGRATION_INDEX_PATH_BYTES,
    maxTreeObjects: MAX_INTEGRATION_TREE_OBJECTS,
    maxSerializedTreeBytes: MAX_INTEGRATION_SERIALIZED_TREE_BYTES,
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
  const owned = new Set(projectedTouchedShape(projected).map((entry) => entry.path));
  for (const row of joinSorted(repo.checkout.indexScan(), projected, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (row.right !== undefined) {
      const identity = projectedIdentity(row.right);
      if (identity !== null) yield indexEntry(row.right.path, identity.mode, identity.oid);
      continue;
    }
    if (row.left !== undefined && !owned.has(row.left.path)) yield row.left;
  }
}

function* continuationIndexEntries(repo: Repository): Generator<IndexEntry> {
  let previous: string | null = null;
  for (const entry of repo.checkout.indexScan()) {
    if (entry.path === previous) continue;
    previous = entry.path;
    yield entry.stage === 0 ? entry : { ...entry, stage: 0 };
  }
}

export function requireBoundedIntegrationIndex(repo: Repository): TreeBuildPreflightStats {
  return requireBoundedIntegrationTree(continuationIndexEntries(repo));
}

export function reserveIntegrationPlan(
  repo: Repository,
  plan: IntegrationPlan,
  callerRetainedBytes = 0,
): ReturnType<Repository["store"]["reserveMemory"]> {
  const reservation = repo.store.reserveMemory();
  reservation.set(
    "other",
    callerRetainedBytes + plan.retainedBytes + INTEGRATION_EXECUTION_HEADROOM_BYTES,
  );
  return reservation;
}

export function reserveIntegrationExecution(
  repo: Repository,
): ReturnType<Repository["store"]["reserveMemory"]> {
  const reservation = repo.store.reserveMemory();
  reservation.set("other", INTEGRATION_EXECUTION_HEADROOM_BYTES);
  return reservation;
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
  const dirty = dirtyPathStream(repo, worktree, undefined, dirtyPathLimits(), excludeRoots).next();
  if (dirty.done !== true) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `cannot ${operation}: tracked working tree changes are present at ${dirty.value}`,
    );
  }
}

export function requireSafeIntegrationWorktree(
  repo: Repository,
  worktree: Worktree,
  incomingTree: string | null,
  paths: readonly string[],
  operation: IntegrationOperation,
  baselineTree?: string | null,
): void {
  if (paths.length === 0) return;
  const limits = {
    maxRows: MAX_REPOSITORY_ROWS,
    maxHashBytes: MAX_GUARD_HASH_BYTES,
    rows: 0,
    hashBytes: 0,
    maxHashRangeReads: 30,
    hashRangeReads: 0,
    maxHashCandidates: 1_000,
    hashCandidates: 0,
    maxHashBatches: 1,
    hashBatches: 0,
  };
  const blockers =
    baselineTree === undefined
      ? checkoutBlockers(repo, worktree, incomingTree, [...paths], true, limits)
      : checkoutBlockersAgainst(
          repo,
          worktree,
          baselineTree,
          incomingTree,
          [...paths],
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

function relocationBases(entries: readonly ProjectedMergeEntry[]): string[] {
  return entries.flatMap((entry) => (entry.purpose === "primary" ? [] : [entry.path]));
}

function collisionCandidate(base: string, path: string): string | null {
  if (path === base || path.startsWith(`${base}/`)) return base;
  if (!path.startsWith(`${base}_`)) return null;
  let end = base.length + 1;
  while (end < path.length && path.charCodeAt(end) >= 0x30 && path.charCodeAt(end) <= 0x39) end++;
  if (end === base.length + 1 || (end < path.length && path.charCodeAt(end) !== 0x2f)) return null;
  return path.slice(0, end);
}

function retainCollision(
  path: string,
  bases: readonly string[],
  collisions: Set<string>,
  operation: IntegrationOperation,
): void {
  for (const base of bases) {
    const candidate = collisionCandidate(base, path);
    if (candidate === null || collisions.has(candidate)) continue;
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
  const bases = relocationBases(initial);
  if (bases.length === 0) return { tracked: new Set(), untracked: new Set() };
  const tracked = new Set<string>();
  let indexRows = 0;
  for (const entry of repo.checkout.indexScan()) {
    if (indexRows >= MAX_REPOSITORY_ROWS) {
      throw new GitError(
        "E2BIG",
        `${operation} collision scan exceeds ${MAX_REPOSITORY_ROWS} rows`,
      );
    }
    indexRows++;
    if (!omitted.has(entry.path)) retainCollision(entry.path, bases, tracked, operation);
  }
  for (const entry of treeStream(repo, baseTree))
    retainCollision(entry.path, bases, tracked, operation);
  for (const entry of treeStream(repo, incomingTree)) {
    retainCollision(entry.path, bases, tracked, operation);
  }

  const untracked = new Set<string>();
  let worktreeRows = 0;
  for (const row of joinSorted(
    repo.checkout.indexScan(),
    walkWorktreeEntriesStream(worktree, repo.root, { includeIgnored: true }),
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
  omitted: ReadonlySet<string> = new Set(),
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

export function projectedTouchedShape(entries: readonly ProjectedMergeEntry[]): TouchedShape[] {
  const byPath = new Map<string, TouchedShape>();
  const retain = (shape: TouchedShape): void => {
    if (byPath.has(shape.path)) return;
    if (byPath.size >= 1_000) {
      throw new GitError("E2BIG", "integration ownership exceeds 1000 touched paths");
    }
    byPath.set(shape.path, shape);
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      retain({ path: ancestor, logicalPath: ancestor, purpose: "primary" });
      slash = ancestor.lastIndexOf("/");
    }
  };
  for (const entry of entries) {
    retain({ path: entry.path, logicalPath: entry.logicalPath, purpose: entry.purpose });
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain({ path: entry.logicalPath, logicalPath: entry.logicalPath, purpose: "primary" });
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  return [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
}
