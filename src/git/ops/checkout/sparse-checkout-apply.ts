import { hasErrorCode } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import type { Worktree, WorktreeEntryType } from "../worktree/worktree.js";
import { flushCheckoutWrites } from "./checkout-writes.js";

export interface SparseCheckoutChange {
  path: string;
  before: TargetEntry | undefined;
  after: TargetEntry | undefined;
  worktreeType: WorktreeEntryType | null;
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

  applyIndexOwned(repo.checkout, (sink) => {
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
  applyIndexOwned(repo.checkout, (sink) => {
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
