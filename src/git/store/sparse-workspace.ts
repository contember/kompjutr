export { hasSparseSourceReceipt } from "./sparse/receipt.js";
export {
  createSqliteSelectedPathSource,
  selectSparsePathsOwned,
} from "./sparse/selection.js";
export {
  createSqliteCommitTreeSnapshotSource,
  snapshotCommitTreeOwned,
} from "./sparse/snapshot.js";
export { SPARSE_TREE_DEPTH_SQL } from "./sparse/tree-resolution.js";
export {
  createSqliteSparseWorkspaceSource,
  hydrateSparseWorkspaceOwned,
  sparseDirtyPathsOwned,
  sparseIndexAncestorFactsOwned,
} from "./sparse/workspace.js";
