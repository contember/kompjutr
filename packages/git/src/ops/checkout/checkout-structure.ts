import { GitError } from "../../common/errors.js";
import { gitParentPath, joinPath } from "../../common/paths.js";
import { comparePaths, joinSorted, joinSorted3 } from "../../common/streams.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import { utf8ByteLength } from "../../store/core/json-pages.js";
import type { IndexStore } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import {
  boundedCheckoutSourceRows,
  boundedCheckoutWorktreeEntries,
  CHECKOUT_STRUCTURAL_ROOTS,
  CHECKOUT_UNMERGED_PATHS,
  CHECKOUT_WINDOW_ROWS,
  matchesPaths,
  stageZero,
} from "./checkout-support.js";
import type { CheckoutInternalOptions } from "./checkout-types.js";

const CHECKOUT_REMOVE_FLUSH_BYTES = 1_000_000;
const EMPTY_REMOVAL_BINDING_BYTES = 2;

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
  for (const entry of boundedCheckoutSourceRows(index.indexScan(), maxSourceRows, "index")) {
    if (entry.stage === 0 || entry.path === previousUnmerged) continue;
    previousUnmerged = entry.path;
    if (paths.length >= CHECKOUT_UNMERGED_PATHS) {
      throw new GitError("E2BIG", `checkout conflicts exceed ${CHECKOUT_UNMERGED_PATHS} paths`);
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

interface ActiveLeaf {
  path: string;
  upper: string;
  replaced: boolean;
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
): ReplacedIndexPaths {
  const removals = new Set<string>();
  const replaced = new ReplacedIndexPaths();
  const activeLeaves: ActiveLeaf[] = [];
  // A leaf that becomes a replaced root stays active but is counted once.
  let unreplacedLeaves = 0;
  const releaseLeaf = (leaf: ActiveLeaf): void => {
    if (!leaf.replaced) unreplacedLeaves--;
  };
  const requireStructuralCapacity = (): void => {
    if (removals.size + replaced.roots + unreplacedLeaves >= CHECKOUT_STRUCTURAL_ROOTS) {
      throw new GitError(
        "E2BIG",
        `checkout structural state exceeds ${CHECKOUT_STRUCTURAL_ROOTS} roots`,
      );
    }
  };
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
      releaseLeaf(activeLeaves.pop()!);
    }
    const current = row.c;
    if (current !== undefined && current.type !== "dir" && row.a === undefined) {
      requireStructuralCapacity();
      activeLeaves.push({ path: current.path, upper: `${current.path}0`, replaced: false });
      unreplacedLeaves++;
    }

    const target = row.a;
    if (
      target === undefined &&
      row.b !== undefined &&
      options.prune !== false &&
      (options.pathspec?.matches(row.b.path) ?? matchesPaths(row.b.path, options.paths))
    ) {
      let replacingLeaf: ActiveLeaf | undefined;
      for (let index = activeLeaves.length - 1; index >= 0; index--) {
        const leaf = activeLeaves[index]!;
        if (row.b.path.startsWith(`${leaf.path}/`)) {
          replacingLeaf = leaf;
          break;
        }
      }
      if (current?.type === "dir" && !replaced.has(row.b.path)) {
        requireStructuralCapacity();
        replaced.addDirectory(row.b.path);
      } else if (replacingLeaf !== undefined && !replacingLeaf.replaced) {
        replacingLeaf.replaced = true;
        unreplacedLeaves--;
        replaced.addLeaf(replacingLeaf.path);
      }
    }
    if (
      target === undefined ||
      target.mode === "160000" ||
      !(options.pathspec?.matches(target.path) ?? matchesPaths(target.path, options.paths))
    ) {
      continue;
    }
    const sameIndex =
      row.b !== undefined &&
      row.b.oid === target.oid &&
      row.b.mode === Number.parseInt(target.mode, 8);
    if (options.preserveMatchingIndex === true && sameIndex) continue;

    let activeLeaf: ActiveLeaf | undefined;
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
      activeLeaves.splice(activeLeaves.indexOf(activeLeaf), 1);
      releaseLeaf(activeLeaf);
    }
    requireStructuralCapacity();
    removals.add(structural);
  }

  const paths = [...removals].sort(comparePaths);
  for (const batch of planWorktreeRemovalBatches(repo, paths)) {
    worktree.removeFiles(
      batch.map((path) => joinPath(repo.root, path)),
      { recursive: true },
    );
  }
  return replaced;
}

/**
 * Tracked paths whose worktree entry `restoreStructure` found replaced. Only
 * the replacing roots are kept: a directory standing at a tracked path, and a
 * leaf standing where tracked paths lived below it.
 */
export class ReplacedIndexPaths {
  readonly #directories = new Set<string>();
  readonly #leaves = new Set<string>();

  get roots(): number {
    return this.#directories.size + this.#leaves.size;
  }

  addDirectory(path: string): void {
    this.#directories.add(path);
  }

  addLeaf(path: string): void {
    this.#leaves.add(path);
  }

  has(path: string): boolean {
    if (this.#directories.has(path)) return true;
    for (let parent = gitParentPath(path); parent !== ""; parent = gitParentPath(parent)) {
      if (this.#leaves.has(parent)) return true;
    }
    return false;
  }
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

/** Split ordinary removals at the flush target; larger singletons still reach the worktree. */
export class WorktreeRemovalBatcher {
  readonly #root: string;
  #paths: string[] = [];
  #bytes = EMPTY_REMOVAL_BINDING_BYTES;

  constructor(root: string) {
    this.#root = root;
  }

  /** Queue `path`, returning the batch it closed when it would cross the flush target. */
  push(path: string): string[] | undefined {
    const itemBytes = utf8ByteLength(JSON.stringify(joinPath(this.#root, path)));
    const closed =
      this.#paths.length > 0 && this.#bytes + 1 + itemBytes > CHECKOUT_REMOVE_FLUSH_BYTES
        ? this.take()
        : undefined;
    this.#bytes += (this.#paths.length === 0 ? 0 : 1) + itemBytes;
    this.#paths.push(path);
    return closed;
  }

  take(): string[] | undefined {
    if (this.#paths.length === 0) return undefined;
    const batch = this.#paths;
    this.#paths = [];
    this.#bytes = EMPTY_REMOVAL_BINDING_BYTES;
    return batch;
  }
}

export function planWorktreeRemovalBatches(repo: Repository, paths: readonly string[]): string[][] {
  const batcher = new WorktreeRemovalBatcher(repo.root);
  const batches: string[][] = [];
  for (const path of paths) {
    const closed = batcher.push(path);
    if (closed !== undefined) batches.push(closed);
  }
  const last = batcher.take();
  if (last !== undefined) batches.push(last);
  return batches;
}
