// Stable facade for worktree walking, hashing, and dirty-path detection.

export {
  type DirtyPathLimits,
  dirtyPathStream,
  dirtyPaths,
} from "./worktree-io-dirty.js";
export {
  createWorktreeHashCursor,
  type HashedPath,
  hashExactWorktreePaths,
  hashWorktreePath,
  hashWorktreePaths,
  indexEntryFor,
  indexMatchesStat,
  type WorktreeHashCursor,
} from "./worktree-io-hash.js";
export {
  type CompiledPathspecMatcher,
  compilePathspecs,
  MAX_COMPILED_PATHS,
} from "./worktree-io-pathspec.js";
export {
  WORKTREE_SCAN_PAGE,
  type WorktreePath,
  walkWorktree,
  walkWorktreeEntriesStream,
  walkWorktreeStream,
} from "./worktree-io-walk.js";
