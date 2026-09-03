// Stable facade for full and sparse tree construction.

export {
  buildTree,
  buildTreeInBatch,
  MAX_TREE_BUILD_LEAF_ENTRIES,
  preflightTreeBuild,
  type TreeBuildPreflightLimits,
  type TreeBuildPreflightStats,
} from "./tree-build-full.js";
export {
  planSparseTreeBuild,
  planSparseTreeBuildFromSource,
  type SparseTreeBuildPlan,
  writeSparseTreePlanInBatch,
} from "./tree-build-sparse.js";
