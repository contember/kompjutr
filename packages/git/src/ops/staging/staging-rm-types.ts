import type { IndexEntry } from "../../store/index.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import type { WorktreePath } from "../worktree/worktree-io.js";

export interface RmOptions {
  /** Repo-relative pathspecs. Empty is a no-op. */
  paths: string[];
  /** Remove only index rows and leave working-tree bytes in place. */
  cached?: boolean;
  /** Bypass content safety, but never bounds or pathspec matching. */
  force?: boolean;
  /** Permit a pathspec to select descendants of a directory. */
  recursive?: boolean;
  /** Roots of nested repositories that this operation must not cross. */
  excludeRoots?: string[];
}

export interface RmIndexPath {
  path: string;
  entry: IndexEntry | undefined;
  conflicted: boolean;
}

export interface RmSpec {
  path: string;
  directoryOnly: boolean;
  matched: boolean;
  directoryMatch: boolean;
  worktreeDirectory: boolean;
}

export interface RmSpecIndex {
  files: Map<string, RmSpec>;
  directories: Map<string, RmSpec>;
}

export interface RmCandidate {
  path: string;
  head: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
  conflicted: boolean;
  worktreeMatchesIndex: boolean;
}

export const RM_WINDOW_ROWS = 1_000;
export const RM_MAX_ROWS_PER_STREAM = 50_000;
export const RM_MAX_PATHSPECS = 10_000;
export const RM_CANDIDATE_FIXED_BYTES = 320;
export const RM_DIRECTORY_FIXED_BYTES = 96;
export const RM_SPEC_FIXED_BYTES = 192;
export const RM_ARRAY_ENTRY_BYTES = 8;
export const RM_REMOVE_BINDING_BYTES = 1_000_000;
export const RM_EXECUTION_HEADROOM_BYTES = 4 * 1024 * 1024;
