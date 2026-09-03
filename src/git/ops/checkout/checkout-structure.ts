import { utf8 } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import { comparePaths, joinSorted, joinSorted3 } from "../../common/streams.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import type { IndexStore } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import {
  boundedCheckoutSourceRows,
  boundedCheckoutWorktreeEntries,
  CHECKOUT_PATH_FIXED_BYTES,
  CHECKOUT_PRUNE_BYTES,
  CHECKOUT_PRUNE_PATHS,
  CHECKOUT_REMOVAL_BYTES,
  CHECKOUT_UNMERGED_BYTES,
  CHECKOUT_UNMERGED_PATHS,
  CHECKOUT_WINDOW_ROWS,
  matchesPaths,
  stageZero,
} from "./checkout-support.js";
import type { CheckoutInternalOptions } from "./checkout-types.js";

const CHECKOUT_REMOVE_FLUSH_BYTES = 1_000_000;

export function discardUnmergedPaths(
  repo: Repository,
  worktree: Worktree,
  maxWorktreeRows: number | undefined,
  maxSourceRows: number | undefined,
  index: IndexStore,
  excludeRoots: string[],
): void {
  const paths: string[] = [];
  let previousUnmerged: string | null = null;
  let retainedBytes = 0;
  for (const entry of boundedCheckoutSourceRows(index.indexScan(), maxSourceRows, "index")) {
    if (entry.stage === 0 || entry.path === previousUnmerged) continue;
    previousUnmerged = entry.path;
    if (paths.length >= CHECKOUT_UNMERGED_PATHS) {
      throw new GitError("E2BIG", `checkout conflicts exceed ${CHECKOUT_UNMERGED_PATHS} paths`);
    }
    retainedBytes += CHECKOUT_PATH_FIXED_BYTES + entry.path.length * 2;
    if (retainedBytes > CHECKOUT_UNMERGED_BYTES) {
      throw new GitError(
        "E2BIG",
        `checkout conflict paths exceed ${CHECKOUT_UNMERGED_BYTES} bytes`,
      );
    }
    paths.push(entry.path);
  }
  if (paths.length === 0) return;

  const physical: string[] = [];
  for (const row of joinSorted(
    paths,
    boundedCheckoutWorktreeEntries(
      walkWorktreeEntriesStream(worktree, repo.root, {
        excludeRoots,
        includeIgnored: true,
        maxScanRows: maxWorktreeRows,
      }),
      maxWorktreeRows,
    ),
    { left: (path) => path, right: (entry) => entry.path },
  )) {
    if (row.left !== undefined && row.right !== undefined && row.right.stat.type !== "dir") {
      physical.push(row.left);
    }
  }
  for (const batch of planWorktreeRemovalBatches(repo, physical)) {
    worktree.removeFiles(batch.map((path) => joinPath(repo.root, path)));
  }
  applyIndexOwned(index, (sink) => {
    for (let offset = 0; offset < paths.length; offset += CHECKOUT_WINDOW_ROWS) {
      for (const path of paths.slice(offset, offset + CHECKOUT_WINDOW_ROWS)) sink.remove(path);
      sink.flush();
    }
  });
}

interface StructuralPath {
  path: string;
  type: "file" | "dir" | "symlink";
}

export function restoreStructuralConflicts(
  repo: Repository,
  worktree: Worktree,
  targetEntries: () => Iterable<TargetEntry>,
  options: CheckoutInternalOptions,
  index: IndexStore,
): Set<string> {
  const removals = new Set<string>();
  const preservedRemovals = new Set<string>();
  let retainedBytes = 0;
  let activeBytes = 0;
  const activeLeaves: Array<{ path: string; upper: string; bytes: number }> = [];
  for (const row of joinSorted3(
    boundedCheckoutSourceRows(targetEntries(), options.maxSourceRowsPerPass, "tree"),
    stageZero(boundedCheckoutSourceRows(index.indexScan(), options.maxSourceRowsPerPass, "index")),
    walkStructuralPaths(worktree, repo.root, options.maxWorktreeRowsPerPass, options.excludeRoots),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    while (
      activeLeaves.length > 0 &&
      comparePaths(row.path, activeLeaves[activeLeaves.length - 1]!.upper) >= 0
    ) {
      activeBytes -= activeLeaves.pop()!.bytes;
    }
    const current = row.c;
    if (current !== undefined && current.type !== "dir" && row.a === undefined) {
      const upper = `${current.path}0`;
      const bytes = CHECKOUT_PATH_FIXED_BYTES + current.path.length * 2 + upper.length * 2;
      if (retainedBytes + activeBytes + bytes > CHECKOUT_REMOVAL_BYTES) {
        throw new GitError(
          "E2BIG",
          `checkout structural state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
        );
      }
      activeLeaves.push({ path: current.path, upper, bytes });
      activeBytes += bytes;
    }

    const target = row.a;
    if (
      target === undefined &&
      row.b !== undefined &&
      options.prune !== false &&
      matchesPaths(row.b.path, options.paths)
    ) {
      const replacedByDirectory = current?.type === "dir";
      let replacedUnderLeaf = false;
      for (let index = activeLeaves.length - 1; index >= 0; index--) {
        if (row.b.path.startsWith(`${activeLeaves[index]!.path}/`)) {
          replacedUnderLeaf = true;
          break;
        }
      }
      if ((replacedByDirectory || replacedUnderLeaf) && !preservedRemovals.has(row.b.path)) {
        retainedBytes += CHECKOUT_PATH_FIXED_BYTES + row.b.path.length * 2;
        if (retainedBytes + activeBytes > CHECKOUT_REMOVAL_BYTES) {
          throw new GitError(
            "E2BIG",
            `checkout structural state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
          );
        }
        preservedRemovals.add(row.b.path);
      }
    }
    if (
      target === undefined ||
      target.mode === "160000" ||
      !matchesPaths(target.path, options.paths)
    ) {
      continue;
    }
    const sameIndex =
      row.b !== undefined &&
      row.b.oid === target.oid &&
      row.b.mode === Number.parseInt(target.mode, 8);
    if (options.preserveMatchingIndex === true && sameIndex) continue;

    let activeLeaf: { path: string; upper: string; bytes: number } | undefined;
    for (let index = activeLeaves.length - 1; index >= 0; index--) {
      const leaf = activeLeaves[index]!;
      if (target.path.startsWith(`${leaf.path}/`)) {
        activeLeaf = leaf;
        break;
      }
    }
    const targetType = target.mode === "120000" ? "symlink" : "file";
    const structural =
      current !== undefined && current.type !== targetType ? target.path : activeLeaf?.path;
    if (structural === undefined || removals.has(structural)) continue;
    if (activeLeaf?.path === structural) {
      activeBytes -= activeLeaf.bytes;
      activeLeaves.splice(activeLeaves.indexOf(activeLeaf), 1);
    }
    retainedBytes += CHECKOUT_PATH_FIXED_BYTES + structural.length * 2;
    if (retainedBytes + activeBytes > CHECKOUT_REMOVAL_BYTES) {
      throw new GitError(
        "E2BIG",
        `checkout structural state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
      );
    }
    removals.add(structural);
  }

  const paths = [...removals].sort(comparePaths);
  for (const batch of planWorktreeRemovalBatches(repo, paths)) {
    worktree.removeFiles(
      batch.map((path) => joinPath(repo.root, path)),
      { recursive: true },
    );
  }
  return preservedRemovals;
}

function* walkStructuralPaths(
  worktree: Worktree,
  root: string,
  maxRows?: number,
  excludeRoots: string[] = [],
): Generator<StructuralPath> {
  for (const entry of walkWorktreeEntriesStream(worktree, root, {
    excludeRoots,
    includeDirectories: true,
    includeIgnored: true,
    maxScanRows: maxRows,
  })) {
    yield { path: entry.path, type: entry.stat.type };
  }
}

export interface CheckoutPrunePlan {
  batches: string[][];
}

/** Preflight the retained directory state before checkout starts removing paths. */
export function planEmptyDirectories(
  repo: Repository,
  worktree: Worktree,
  removed: readonly string[],
  preserved: ReadonlySet<string>,
  maxRows: number | undefined,
  excludeRoots: string[],
  relativeExcludeRoots: string[],
): CheckoutPrunePlan {
  const directories = new Map<string, boolean>();
  const physicalRemovals = new Set<string>();
  let retainedBytes = 0;
  for (const path of removed) {
    if (!preserved.has(path)) physicalRemovals.add(path);
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const directory = path.slice(0, slash);
      if (!directories.has(directory)) {
        if (directories.size >= CHECKOUT_PRUNE_PATHS) {
          throw new GitError(
            "E2BIG",
            `checkout directory-prune state exceeds ${CHECKOUT_PRUNE_PATHS} paths`,
          );
        }
        retainedBytes += CHECKOUT_PATH_FIXED_BYTES + directory.length * 2;
        if (retainedBytes > CHECKOUT_PRUNE_BYTES) {
          throw new GitError(
            "E2BIG",
            `checkout directory-prune state exceeds ${CHECKOUT_PRUNE_BYTES} bytes`,
          );
        }
        directories.set(directory, false);
      }
      slash = directory.lastIndexOf("/");
    }
  }
  if (directories.size === 0) return { batches: [] };
  for (const root of relativeExcludeRoots) {
    let candidate = root;
    while (candidate !== "") {
      if (directories.has(candidate)) directories.set(candidate, true);
      const slash = candidate.lastIndexOf("/");
      candidate = slash < 0 ? "" : candidate.slice(0, slash);
    }
  }
  for (const entry of walkWorktreeEntriesStream(worktree, repo.root, {
    excludeRoots,
    includeIgnored: true,
    includeDirectories: true,
    maxScanRows: maxRows,
  })) {
    if (physicalRemovals.has(entry.path)) continue;
    if (entry.stat.type === "dir" && directories.has(entry.path)) continue;
    let candidate = entry.path;
    while (candidate !== "") {
      if (directories.has(candidate)) directories.set(candidate, true);
      const slash = candidate.lastIndexOf("/");
      candidate = slash < 0 ? "" : candidate.slice(0, slash);
    }
  }

  const roots: string[] = [];
  for (const [directory, hasContents] of directories) {
    if (hasContents) continue;
    const slash = directory.lastIndexOf("/");
    const parent = slash < 0 ? undefined : directory.slice(0, slash);
    if (parent !== undefined && directories.get(parent) === false) continue;
    roots.push(directory);
  }
  roots.sort(comparePaths);
  return {
    batches: planWorktreeRemovalBatches(repo, roots),
  };
}

/** Drop preflighted empty candidate subtrees after tracked leaves are gone. */
export function pruneEmptyDirectories(
  repo: Repository,
  worktree: Worktree,
  plan: CheckoutPrunePlan,
): void {
  for (const batch of plan.batches) {
    worktree.removeFiles(
      batch.map((path) => joinPath(repo.root, path)),
      { recursive: true },
    );
  }
}

/** Split ordinary removals at the flush target; larger singletons still reach the worktree. */
export function planWorktreeRemovalBatches(repo: Repository, paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (batch.length === 0) return;
    batches.push(batch);
    batch = [];
    bytes = 2;
  };

  for (const path of paths) {
    const absolute = joinPath(repo.root, path);
    const itemBytes = utf8.encode(JSON.stringify(absolute)).byteLength;
    const separator = batch.length === 0 ? 0 : 1;
    if (batch.length > 0 && bytes + separator + itemBytes > CHECKOUT_REMOVE_FLUSH_BYTES) flush();
    batch.push(path);
    bytes += (batch.length === 1 ? 0 : 1) + itemBytes;
  }
  flush();
  return batches;
}
