// Materialising a tree into the working tree, and keeping the SQL index in step with it.

import type { IndexStore } from "../store/index.js";
import { checkoutTreeInternal } from "./checkout-operation.js";
import { checkoutInternalOptions, readOnlyIndex, targetFromIndex } from "./checkout-support.js";
import type { CheckoutOptions } from "./checkout-types.js";
import type { Repository } from "./repository.js";
import { treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";

export {
  indexFromTree,
  isTree,
  matchesPaths,
  stageZero,
  treeEntries,
  writeEntry,
} from "./checkout-support.js";
export type { CheckoutOptions } from "./checkout-types.js";
export { checkoutSparseChanges, type SparseCheckoutChange } from "./sparse-checkout.js";
export type { TargetEntry } from "./tree-stream.js";
export { type CompiledPathspecMatcher, compilePathspecs } from "./worktree-io.js";

/**
 * Bring the working tree and the index to `treeOid`. Entries already
 * matching are left alone, so a checkout that changes one file touches one
 * file.
 */
export function checkoutTree(
  repo: Repository,
  worktree: Worktree,
  treeOid: string | null,
  options: CheckoutOptions = {},
  index: IndexStore = repo.checkout,
): void {
  checkoutTreeInternal(
    repo,
    worktree,
    () => treeStream(repo, treeOid),
    checkoutInternalOptions(repo, options, []),
    index,
  );
}

/** Materialize while preserving registered checkout roots owned by another repository view. */
export function checkoutTreeExcluding(
  repo: Repository,
  worktree: Worktree,
  treeOid: string | null,
  excludeRoots: readonly string[],
  options: CheckoutOptions = {},
  index: IndexStore = repo.checkout,
): void {
  checkoutTreeInternal(
    repo,
    worktree,
    () => treeStream(repo, treeOid),
    checkoutInternalOptions(repo, options, excludeRoots),
    index,
  );
}

/** Restore selected worktree paths from a tree without changing index rows. */
export function checkoutWorktreePathsExcluding(
  repo: Repository,
  worktree: Worktree,
  treeOid: string | null,
  paths: string[],
  excludeRoots: readonly string[],
): void {
  checkoutTreeExcluding(
    repo,
    worktree,
    treeOid,
    excludeRoots,
    { paths, prune: true, restoreStructure: true },
    readOnlyIndex(repo),
  );
}

/** Restore selected worktree paths from stage 0 without changing any index row. */
export function checkoutIndexPathsExcluding(
  repo: Repository,
  worktree: Worktree,
  paths: string[],
  excludeRoots: readonly string[],
): void {
  checkoutTreeInternal(
    repo,
    worktree,
    () => targetFromIndex(repo.checkout.indexScan()),
    checkoutInternalOptions(repo, { paths, prune: true, restoreStructure: true }, excludeRoots),
    readOnlyIndex(repo),
  );
}
