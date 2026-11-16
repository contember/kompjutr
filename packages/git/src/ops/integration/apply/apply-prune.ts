// Git schedules the parents of every path an integration removes and drops
// those left empty, even when the removed file was already missing. Untracked
// and ignored files keep a directory. Candidates are collected before the
// worktree changes, so the cap fails before anything is written.

import { GitError } from "../../../common/errors.js";
import { gitParentPath } from "../../../common/paths.js";
import { comparePaths } from "../../../common/streams.js";
import type { ProjectedMergeEntry } from "../../../store/operations/integration-workspace/descriptors.js";
import { planWorktreeRemovalBatches } from "../../checkout/checkout-structure.js";
import { CHECKOUT_PRUNE_PATHS } from "../../checkout/checkout-support.js";
import type { Repository } from "../../repository/repository.js";
import type { Worktree } from "../../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../../worktree/worktree-io.js";

type DirectoryState = "unseen" | "empty" | "occupied";

export class EmptiedDirectories {
  readonly #directories = new Map<string, DirectoryState>();

  /** Record the parents of every path the result drops from the worktree. */
  static fromPlan(entries: Iterable<ProjectedMergeEntry>): EmptiedDirectories {
    const emptied = new EmptiedDirectories();
    for (const entry of entries) if (entry.worktree === null) emptied.#recordParents(entry.path);
    return emptied;
  }

  /** Remove the recorded directories that hold nothing once the result is written. */
  prune(repo: Repository, worktree: Worktree): void {
    if (this.#directories.size === 0) return;
    for (const entry of walkWorktreeEntriesStream(worktree, repo.root, {
      includeDirectories: true,
      includeIgnored: true,
      // Only candidates are read; any other directory occupies its parent.
      pruneDirectory: (path) => {
        if (this.#directories.has(path)) return false;
        this.#occupy(gitParentPath(path));
        return true;
      },
    })) {
      if (entry.stat.type === "dir") this.#directories.set(entry.path, "empty");
      else this.#occupy(gitParentPath(entry.path));
    }
    const roots: string[] = [];
    for (const [directory, state] of this.#directories) {
      if (state !== "empty") continue;
      if (this.#directories.get(gitParentPath(directory)) === "empty") continue;
      roots.push(directory);
    }
    roots.sort(comparePaths);
    for (const batch of planWorktreeRemovalBatches(repo, roots))
      worktree.removeFiles(batch, { recursive: true });
  }

  #recordParents(path: string): void {
    let directory = gitParentPath(path);
    while (directory !== "" && !this.#directories.has(directory)) {
      if (this.#directories.size >= CHECKOUT_PRUNE_PATHS) {
        throw new GitError(
          "E2BIG",
          `integration directory-prune state exceeds ${CHECKOUT_PRUNE_PATHS} paths`,
        );
      }
      this.#directories.set(directory, "unseen");
      directory = gitParentPath(directory);
    }
  }

  #occupy(directory: string): void {
    let current = directory;
    while (current !== "" && this.#directories.has(current)) {
      if (this.#directories.get(current) === "occupied") return;
      this.#directories.set(current, "occupied");
      current = gitParentPath(current);
    }
  }
}
