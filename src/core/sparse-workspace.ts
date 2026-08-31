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
  checkoutId: number;
  root: string;
  baselineTreeOid: string | null;
  currentTreeOid: string | null;
  paths: string[];
}

export type SparseWorkspaceResult =
  | { available: false }
  | { available: true; rows: SparseWorkspaceRow[] };

export interface SparseIndexAncestorRequest {
  checkoutId: number;
  ancestors: string[];
}

export interface SparseIndexAncestorFact {
  path: string;
  exact: boolean;
  descendant: boolean;
}

export interface SparseIndexAncestorResult {
  facts: SparseIndexAncestorFact[];
}

export interface SelectedPathSpec {
  path: string;
  /** Include descendants as well as the exact path. */
  recursive: boolean;
}

export interface SelectedPathRequest {
  repoId: number;
  checkoutId: number;
  root: string;
  specs: SelectedPathSpec[];
}

export interface SelectedWorktreeFact {
  path: string;
  stat: SparseWorktreeLeaf;
}

export type SelectedPathResult =
  | { available: false }
  | {
      available: true;
      index: IndexEntry[];
      worktree: SelectedWorktreeFact[];
    };

/** Optional same-database selected-subtree projection. */
export interface SelectedPathSource {
  select(request: SelectedPathRequest): SelectedPathResult;
}

export interface CommitTreeSnapshotRequest {
  repoId: number;
  checkoutId: number;
  root: string;
  baselineTreeOid: string | null;
}

export interface CommitTreeSnapshotEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitTreeSnapshotDirectory {
  /** Empty for the repository root. */
  path: string;
  oid: string | null;
  entries: CommitTreeSnapshotEntry[];
}

export type CommitTreeSnapshotResult =
  | { available: false }
  | {
      available: true;
      baselineTreeOid: string | null;
      dirty: SparseWorkspaceDirty[];
      index: IndexEntry[];
      directories: CommitTreeSnapshotDirectory[];
    };

/** Optional authenticated baseline projection for narrow tree rebuilds. */
export interface CommitTreeSnapshotSource {
  snapshot(request: CommitTreeSnapshotRequest): CommitTreeSnapshotResult;
}

/** Optional same-database fast path. Generic clients omit this capability. */
export interface SparseWorkspaceSource {
  readState(checkoutId: number): SparseWorkspaceState;
  dirtyPaths(checkoutId: number): Iterable<SparseWorkspaceDirty>;
  hydrate(request: SparseWorkspaceRequest): SparseWorkspaceResult;
  indexAncestorFacts?(request: SparseIndexAncestorRequest): SparseIndexAncestorResult;
}
