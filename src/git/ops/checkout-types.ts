export interface CheckoutOptions {
  /** Restrict the update to these repo-relative pathspecs. */
  paths?: string[];
  /** Remove tracked files that the target tree does not have. */
  prune?: boolean;
  /** Keep local changes to entries that are identical in the index and target. */
  preserveMatchingIndex?: boolean;
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

export interface CheckoutInternalOptions extends CheckoutOptions {
  excludeRoots: string[];
  relativeExcludeRoots: string[];
}
