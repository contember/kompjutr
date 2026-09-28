// Checkout removes obsolete paths while the tree/index join streams. Only the
// count-capped directory map outlives a window; which directories became
// empty is read from the worktree once the removed leaves are gone. A cap that
// fires mid-stream relies on the caller's transaction to undo earlier windows.

import { GitError } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import type { IndexSink } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import { planWorktreeRemovalBatches, WorktreeRemovalBatcher } from "./checkout-structure.js";
import { CHECKOUT_PRUNE_PATHS, CHECKOUT_WINDOW_ROWS } from "./checkout-support.js";

export interface CheckoutPrunePlan {
  batches: string[][];
}

export interface CheckoutRemovalScope {
  /** Paths `restoreStructure` already replaced; their index rows still go. */
  preserved: ReadonlySet<string>;
  maxWorktreeRows: number | undefined;
  excludeRoots: string[];
  relativeExcludeRoots: string[];
}

export class CheckoutRemovalStream {
  readonly #repo: Repository;
  readonly #worktree: Worktree;
  readonly #sink: IndexSink;
  readonly #scope: CheckoutRemovalScope;
  readonly #batcher: WorktreeRemovalBatcher;
  readonly #directories = new Map<string, boolean>();
  #pendingIndexRows = 0;

  constructor(repo: Repository, worktree: Worktree, sink: IndexSink, scope: CheckoutRemovalScope) {
    this.#repo = repo;
    this.#worktree = worktree;
    this.#sink = sink;
    this.#scope = scope;
    this.#batcher = new WorktreeRemovalBatcher(repo.root);
  }

  remove(path: string): void {
    this.#recordParents(path);
    if (!this.#scope.preserved.has(path)) this.#removeFiles(this.#batcher.push(path));
    this.#sink.remove(path);
    this.#pendingIndexRows++;
    if (this.#pendingIndexRows === CHECKOUT_WINDOW_ROWS) this.#flushIndex();
  }

  /** Flush the last windows and plan the prune of directories the removals emptied. */
  finish(): CheckoutPrunePlan | undefined {
    this.#removeFiles(this.#batcher.take());
    this.#flushIndex();
    if (this.#directories.size === 0) return undefined;
    for (const root of this.#scope.relativeExcludeRoots) this.#markContents(root);
    for (const entry of walkWorktreeEntriesStream(this.#worktree, this.#repo.root, {
      excludeRoots: this.#scope.excludeRoots,
      includeIgnored: true,
      includeDirectories: true,
      maxScanRows: this.#scope.maxWorktreeRows,
    })) {
      if (entry.stat.type === "dir" && this.#directories.has(entry.path)) continue;
      this.#markContents(entry.path);
    }

    const roots: string[] = [];
    for (const [directory, hasContents] of this.#directories) {
      if (hasContents) continue;
      const slash = directory.lastIndexOf("/");
      const parent = slash < 0 ? undefined : directory.slice(0, slash);
      if (parent !== undefined && this.#directories.get(parent) === false) continue;
      roots.push(directory);
    }
    roots.sort(comparePaths);
    return { batches: planWorktreeRemovalBatches(this.#repo, roots) };
  }

  #recordParents(path: string): void {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const directory = path.slice(0, slash);
      if (this.#directories.has(directory)) return;
      if (this.#directories.size >= CHECKOUT_PRUNE_PATHS) {
        throw new GitError(
          "E2BIG",
          `checkout directory-prune state exceeds ${CHECKOUT_PRUNE_PATHS} paths`,
        );
      }
      this.#directories.set(directory, false);
      slash = directory.lastIndexOf("/");
    }
  }

  #markContents(path: string): void {
    let candidate = path;
    while (candidate !== "") {
      if (this.#directories.has(candidate)) this.#directories.set(candidate, true);
      const slash = candidate.lastIndexOf("/");
      candidate = slash < 0 ? "" : candidate.slice(0, slash);
    }
  }

  #removeFiles(batch: string[] | undefined): void {
    if (batch === undefined) return;
    this.#worktree.removeFiles(batch.map((path) => joinPath(this.#repo.root, path)));
  }

  #flushIndex(): void {
    if (this.#pendingIndexRows === 0) return;
    this.#sink.flush();
    this.#pendingIndexRows = 0;
  }
}

/** Drop the planned empty subtrees after tracked leaves are gone. */
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
