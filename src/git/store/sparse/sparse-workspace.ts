export { hasSparseSourceReceipt } from "./receipt.js";
export {
  createSqliteSelectedPathSource,
  selectSparsePathsOwned,
} from "./selection.js";
export {
  createSqliteCommitTreeSnapshotSource,
  snapshotCommitTreeOwned,
} from "./snapshot.js";
export { SPARSE_TREE_DEPTH_SQL } from "./tree-resolution.js";
export {
  createSqliteSparseWorkspaceSource,
  hydrateSparseWorkspaceOwned,
  sparseDirtyPathsOwned,
  sparseIndexAncestorFactsOwned,
} from "./workspace.js";
