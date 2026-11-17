import type { CompiledPathspecMatcher } from "../worktree/worktree-io.js";

export interface CheckoutOptions {
  /** Restrict the update to these repo-relative pathspecs. */
  paths?: string[];
  /** Remove tracked files that the target tree does not have. */
  prune?: boolean;
  /** Keep local changes to entries that are identical in the index and target. */
  preserveMatchingIndex?: boolean;
  /** Keep staged state where the baseline and target agree, as git's two-way merge does. */
  carry?: StagedCarry;
  /** Remove worktree entries whose type prevents materialising the target. */
  restoreStructure?: boolean;
  /** Discard conflict stages before hard materialisation. */
  discardUnmerged?: boolean;
  /** Bound each paged worktree traversal used by checkout. */
  maxWorktreeRowsPerPass?: number;
  /** Bound each tree and index traversal used by checkout. */
  maxSourceRowsPerPass?: number;
  /** Bound aggregate blob bytes materialised into the worktree. */
  maxWriteBytes?: number;
}

/** A branch switch's two-way merge, as the checkout guard planned it. */
export interface StagedCarry {
  /** The tree the switch leaves, `null` when unborn. */
  baselineTree: string | null;
  /** Kept staged files that a path taken from the target replaces as file versus directory. */
  replaced: ReadonlySet<string>;
}

export interface CheckoutInternalOptions extends CheckoutOptions {
  excludeRoots: string[];
  relativeExcludeRoots: string[];
  pathspec?: CompiledPathspecMatcher;
}
