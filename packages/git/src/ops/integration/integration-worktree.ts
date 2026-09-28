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
import type { GitContext } from "../core/context.js";
import type { ProjectedMergeEntry } from "../merge/merge-projection.js";
import { type CheckoutPathSelection, checkoutBlockers } from "../refs/refs.js";
import { describeBlockers } from "../refs/refs-checkout-guard.js";
import type { Repository } from "../repository/repository.js";
import {
  MAX_TREE_BUILD_LEAF_ENTRIES,
  preflightTreeBuild,
  type TreeBuildPreflightStats,
} from "../tree/tree-build-full.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { dirtyPathStream } from "../worktree/worktree-io.js";

export const MAX_INTEGRATION_INDEX_ENTRIES = MAX_TREE_BUILD_LEAF_ENTRIES;

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

function unmergedIndexError(operation: IntegrationOperation): GitError {
  return new GitError("EUNMERGED", `cannot ${operation} with unmerged index entries`);
}

function stagedChangesError(operation: IntegrationOperation): GitError {
  return new GitError("ECHECKOUTFAIL", `cannot ${operation}: the index contains staged changes`);
}

export function requireCleanIntegrationIndex(
  repo: Repository,
  headTree: string,
  operation: IntegrationOperation,
): void {
  if (repo.checkout.hasConflicts()) throw unmergedIndexError(operation);
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
      throw stagedChangesError(operation);
    }
  }
}

/**
 * The bounded-index, clean-index and clean-worktree start checks, with the
 * first two answered by one tree/index join. Errors keep their former order:
 * the index bound, unmerged entries, staged changes, then worktree changes.
 */
export function requireCleanIntegrationStart(
  repo: Repository,
  worktree: Worktree,
  headTree: string,
  operation: IntegrationOperation,
  excludeRoots: string[],
): void {
  let staged = false;
  const entries = function* (): Generator<IndexEntry> {
    for (const row of joinSorted(treeStream(repo, headTree), continuationIndexEntries(repo), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      const tree = row.left;
      const index = row.right;
      if (
        tree === undefined ||
        index === undefined ||
        index.oid !== tree.oid ||
        index.mode !== Number.parseInt(tree.mode, 8)
      ) {
        staged = true;
      }
      if (index !== undefined) yield index;
    }
  };
  requireBoundedIntegrationTree(repo, entries());
  if (repo.checkout.hasConflicts()) throw unmergedIndexError(operation);
  if (staged) throw stagedChangesError(operation);
  requireCleanIntegrationWorktree(repo, worktree, operation, excludeRoots);
}

/**
 * The sparse index tracker proves a clean start without a pass: its baseline
 * is `headTree`, no path is dirty, and no conflict or gitlink row exists.
 * Only a host that supplies the tracker writer keeps that baseline current.
 */
export function trackerProvesCleanIntegrationStart(
  context: Pick<GitContext, "sparseWorkspace" | "indexTracker">,
  repo: Repository,
  headTree: string,
): boolean {
  const source = context.sparseWorkspace;
  if (source === undefined || context.indexTracker === undefined) return false;
  const checkoutId = repo.checkout.checkoutId;
  const state = source.readState(checkoutId);
  if (!state.available || state.baselineTreeOid !== headTree) return false;
  for (const _dirty of source.dirtyPaths(checkoutId)) return false;
  return !repo.checkout.hasCheckoutBlockingIndexEntries();
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

/** Streams in fixed hash batches, so the tree size does not bound the check. */
export function requireCleanIntegrationWorktree(
  repo: Repository,
  worktree: Worktree,
  operation: IntegrationOperation,
  excludeRoots: string[] = [],
): void {
  const iterator = dirtyPathStream(repo, worktree, undefined, undefined, excludeRoots);
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
): void {
  const blockers = checkoutBlockers(repo, worktree, {
    baselineTree,
    tree: incomingTree,
    paths,
    prune: true,
    mode: "checkout",
  });
  if (blockers.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${describeBlockers(blockers.tracked, blockers.trackedOmitted)} would be overwritten by ${operation}`,
    );
  }
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by ${operation}: ${describeBlockers(blockers.untracked, blockers.untrackedOmitted)}`,
    );
  }
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
    requireSafeIntegrationSelection(repo, worktree, incomingTree, paths, operation, baselineTree);
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
