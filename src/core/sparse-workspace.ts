import type { IndexEntry } from "../sqlite/store.js";
import type { WorktreeEntryType } from "./worktree.js";

export type SparseWorkspaceState =
  | { available: false }
  | { available: true; baselineTreeOid: string | null };

export interface SparseWorkspaceDirty {
  path: string;
  flags: number;
}

export interface SparseTreeLeaf {
  mode: string;
  oid: string;
}

export interface SparseWorktreeLeaf {
  type: WorktreeEntryType;
  mode: number;
  size: number;
  mtime: number;
  ino: number;
  nlink: number;
  rev: number;
  target: string | null;
  contentId: Uint8Array | null;
}

export interface SparseWorkspaceRow {
  path: string;
  baseline: SparseTreeLeaf | null;
  current: SparseTreeLeaf | null;
  index: IndexEntry[];
  worktree: SparseWorktreeLeaf | null;
}

export interface SparseWorkspaceRequest {
  repoId: number;
  root: string;
  baselineTreeOid: string | null;
  currentTreeOid: string | null;
  paths: string[];
  /** Caller-owned headroom available for retained hydration state. */
  maxRetainedBytes?: number;
}

export type SparseWorkspaceResult =
  | { available: false }
  | { available: true; rows: SparseWorkspaceRow[]; retainedBytes: number };

/** Optional same-database fast path. Generic clients omit this capability. */
export interface SparseWorkspaceSource {
  readState(repoId: number): SparseWorkspaceState;
  dirtyPaths(repoId: number): Iterable<SparseWorkspaceDirty>;
  hydrate(request: SparseWorkspaceRequest): SparseWorkspaceResult;
}
