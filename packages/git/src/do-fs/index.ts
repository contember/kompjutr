export {
  hasSparseSourceReceipt,
  hydrateSparseWorkspaceOwned,
  selectSparsePathsOwned,
  snapshotCommitTreeOwned,
  sparseDirtyPathsOwned,
  sparseIndexAncestorFactsOwned,
} from "../store/sparse/sparse-workspace.js";
export {
  advanceIndexTrackerBaseline,
  INDEX_DIRTY,
  type IndexTrackerDirty,
  type IndexTrackerState,
  initializeIndexTracker,
  invalidateIndexTracker,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
  WORKTREE_DIRTY,
} from "./indexes/index-tracker.js";
export { createSqliteSelectedPathSource } from "./sparse/selection.js";
export { createSqliteCommitTreeSnapshotSource } from "./sparse/snapshot.js";
export { SPARSE_TREE_DEPTH_SQL } from "./sparse/tree-resolution.js";
export { createSqliteSparseWorkspaceSource } from "./sparse/workspace.js";
