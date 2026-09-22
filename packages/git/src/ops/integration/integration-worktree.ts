// Shared bounded index, worktree, projection, and commit preflight for integration operations.

import { GitError } from "../../common/errors.js";
import { comparePaths, joinSorted, joinSorted3 } from "../../common/streams.js";
import { type IndexEntry, indexScanOwned } from "../../store/index.js";
import type {
  IntegrationEntry as StoredIntegrationEntry,
  ProjectedMergeEntry as StoredProjectedEntry,
} from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationTouched } from "../../store/operations/integration-workspace/touched.js";
import type { ProjectedMergeEntry } from "../merge/merge-projection.js";
import type { MergeTouchedPath } from "../merge/merge-state.js";
import { checkoutBlockersAgainstOwned, checkoutBlockersOwned } from "../refs/refs.js";
import type { CheckoutPathSelection } from "../refs/refs-checkout-guard.js";
import type { Repository } from "../repository/repository.js";
import {
  MAX_TREE_BUILD_LEAF_ENTRIES,
  preflightTreeBuild,
  type TreeBuildPreflightStats,
} from "../tree/tree-build.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { type DirtyPathLimits, dirtyPathStreamOwned } from "../worktree/worktree-io.js";

export const MAX_INTEGRATION_INDEX_ENTRIES = MAX_TREE_BUILD_LEAF_ENTRIES;
const MAX_REPOSITORY_ROWS = 50_000;

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
  });
}

function projectedIdentity<Content>(
  entry: ProjectedMergeEntry<Content>,
): { mode: string; oid: string } | null {
  if (entry.stageZero !== null) return entry.stageZero;
  if (entry.stages === null) return null;
  return entry.stages.current ?? entry.stages.incoming ?? entry.stages.base;
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

function requireSafeIntegrationSelection(
  repo: Repository,
  worktree: Worktree,
  incomingTree: string | null,
  paths: string[] | CheckoutPathSelection,
  operation: IntegrationOperation,
  baselineTree: string | null | undefined,
  maxHashCandidates: number,
): void {
  const limits = {
    maxRows: MAX_REPOSITORY_ROWS,
    rows: 0,
    maxHashCandidates,
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

export interface TouchedShape {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPath["purpose"];
}

function buildProjectedTouchedShape(entries: readonly ProjectedMergeEntry[]): TouchedShape[] {
  const byPath = new Map<string, TouchedShape>();
  const retain = (
    path: string,
    logicalPath: string,
    purpose: MergeTouchedPath["purpose"],
  ): void => {
    if (byPath.has(path)) return;
    byPath.set(path, { path, logicalPath, purpose });
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      if (!byPath.has(ancestor)) {
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

export function requireSafeIntegrationWorktreeOwned(
  repo: Repository,
  worktree: Worktree,
  incomingTree: string | null,
  plan: IntegrationPlanHandle<StoredIntegrationEntry>,
  operation: IntegrationOperation,
  baselineTree?: string | null,
): void {
  if (plan.entryCount === 0) return;
  const iterator = plan.entries[Symbol.iterator]();
  let next = iterator.next();
  let active: string[] = [];
  const paths: CheckoutPathSelection = {
    matches(path) {
      while (!next.done && comparePaths(next.value.path, path) <= 0) {
        const candidate = next.value.path;
        active = active.filter((prefix) => comparePaths(candidate, `${prefix}0`) < 0);
        if (!active.some((prefix) => candidate.startsWith(`${prefix}/`))) active.push(candidate);
        next = iterator.next();
      }
      active = active.filter((prefix) => comparePaths(path, `${prefix}0`) < 0);
      return active.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    },
  };
  try {
    requireSafeIntegrationSelection(
      repo,
      worktree,
      incomingTree,
      paths,
      operation,
      baselineTree,
      MAX_REPOSITORY_ROWS,
    );
  } finally {
    iterator.return(undefined);
  }
}

export function* prospectiveIntegrationIndexEntriesOwned(
  repo: Repository,
  projected: IntegrationPlanHandle<StoredProjectedEntry>,
  touched: IntegrationTouched,
): Generator<IndexEntry> {
  for (const row of joinSorted3(
    indexScanOwned(repo.checkout),
    projected.entries,
    touched.shapes(),
    {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    },
  )) {
    if (row.b !== undefined) {
      const identity = projectedIdentity(row.b);
      if (identity !== null) yield indexEntry(row.b.path, identity.mode, identity.oid);
    } else if (row.a !== undefined && row.c === undefined) yield row.a;
  }
}
