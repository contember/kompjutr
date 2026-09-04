// Stable facade for worktree walking, hashing, and dirty-path detection.

export {
  type DirtyPathLimits,
  dirtyPathStream,
  dirtyPathStreamOwned,
  dirtyPaths,
} from "./worktree-io-dirty.js";
export {
  createWorktreeHashCursor,
  type HashedPath,
  hashExactWorktreePaths,
  hashExactWorktreePathsOwned,
  hashWorktreePath,
  hashWorktreePaths,
  hashWorktreePathsOwned,
  indexEntryFor,
  indexMatchesStat,
  type WorktreeHashCursor,
} from "./worktree-io-hash.js";
export {
  type CompiledPathspecMatcher,
  compilePathspecs,
  compilePathspecsOwned,
  MAX_COMPILED_PATHS,
} from "./worktree-io-pathspec.js";
export {
  WORKTREE_SCAN_PAGE,
  type WorktreePath,
  walkWorktree,
  walkWorktreeEntriesStream,
  walkWorktreeEntriesStreamOwned,
  walkWorktreeStream,
} from "./worktree-io-walk.js";
