export { applyProjectedIndex } from "./merge-apply-index.js";
export {
  applyProjectedMerge,
  applyProjectedOperation,
  applyProjectedRebaseTransition,
} from "./merge-apply-operation.js";
export { abortProjectedMerge, restoreProjectedOperation } from "./merge-apply-restore.js";
export type {
  MergeApplyMetadata,
  MergeApplyOutcome,
  MergeApplyResult,
  OperationApplyOptions,
  OperationApplyResult,
  ProjectedRebaseTransitionOptions,
  ProjectedRebaseTransitionResult,
} from "./merge-apply-types.js";
export { validateProjectedIndexEntries } from "./merge-apply-validation.js";
