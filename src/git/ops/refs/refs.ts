import { GitError } from "../../common/errors.js";
import { mutateRefsOwned } from "../../store/refs/refs.js";
import { checkoutTreeExcluding } from "../checkout/checkout.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "../checkout/initial-checkout.js";
import { trySparseCleanCheckout } from "../checkout/sparse-checkout.js";
import type { GitContext } from "../core/context.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import { treeOf } from "../repository/reads.js";
import { expandRefOwned, type Repository, resolveHeadOwned } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { branch } from "./refs-branches.js";
import { checkoutBlockersAgainstOwned } from "./refs-checkout-guard.js";

// Branches, tags and HEAD movement, plus the working-tree reconciliation
// that goes with moving HEAD. Refs are rows; HEAD is a column on the
// repository row, so nothing here writes a file.

export type {
  BranchDeleteOptions,
  BranchOptions,
  BranchRenameOptions,
  CurrentBranchOptions,
  TagDeleteOptions,
  TagOptions,
} from "./refs-branches.js";
export {
  branch,
  branchDelete,
  branchList,
  branchRename,
  currentBranch,
  tag,
  tagDelete,
  tagList,
} from "./refs-branches.js";
export type { CheckoutBlockerLimits, CheckoutBlockers } from "./refs-checkout-guard.js";
export {
  checkoutBlockers,
  checkoutBlockersAgainst,
  checkoutBlockersAgainstOwned,
  checkoutBlockersOwned,
  hardResetBlockersAgainst,
  hardResetBlockersAgainstOwned,
} from "./refs-checkout-guard.js";

const HEADS = "refs/heads/";

export interface CheckoutOptions {
  /** Branch, tag or commit to check out. */
  ref: string;
  /** Update only these paths, and leave HEAD where it is. */
  paths?: string[];
  /** Overwrite local changes instead of refusing. */
  force?: boolean;
}

export function checkout(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CheckoutOptions,
): void {
  checkoutInternal(context, repo, worktree, options, []);
}

/** Checkout while preserving registered repository roots below this worktree. */
export function checkoutExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CheckoutOptions,
  excludeRoots: readonly string[],
): void {
  checkoutInternal(context, repo, worktree, options, excludeRoots);
}

function checkoutInternal(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CheckoutOptions,
  excludeRoots: readonly string[],
): void {
  const paths = options.paths !== undefined && options.paths.length > 0 ? options.paths : undefined;
  const commit = repo.peel(repo.revParse(options.ref));
  const tree = treeOf(repo, commit);

  if (paths !== undefined) {
    requireCheckoutAllowed(
      repo,
      worktree,
      tree,
      paths,
      false,
      options.force === true,
      excludeRoots,
    );
    // Path checkout restores named targets without pruning absent ones.
    checkoutTreeExcluding(repo, worktree, tree, excludeRoots, {
      paths,
      prune: false,
      restoreStructure: true,
    });
    return;
  }

  try {
    repo.store.db.transactionSync(() => {
      if (
        excludeRoots.length === 0 &&
        tryInitialCheckout(context, repo, tree, {
          requireSharedDatabase: true,
          fallbackOnCapacity: true,
          afterMaterialize: () => moveHead(context, repo, options.ref, commit),
        })
      ) {
        return;
      }
      const tracker = context.indexTracker;
      if (tracker !== undefined && excludeRoots.length === 0) {
        if (trySparseCleanCheckout(context, repo, worktree, tree)) {
          moveHead(context, repo, options.ref, commit);
          tracker.reseal(repo.checkout.checkoutId, tree, []);
          return;
        }
      }
      checkoutLegacy(context, repo, worktree, options, tree, commit, excludeRoots);
    });
  } catch (error) {
    if (!isInitialCheckoutFallback(error)) throw error;
    repo.store.db.transactionSync(() => {
      checkoutLegacy(context, repo, worktree, options, tree, commit, excludeRoots);
    });
  }
}

function checkoutLegacy(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CheckoutOptions,
  tree: string,
  commit: string,
  excludeRoots: readonly string[],
): void {
  requireCheckoutAllowed(
    repo,
    worktree,
    tree,
    undefined,
    true,
    options.force === true,
    excludeRoots,
  );
  checkoutTreeExcluding(repo, worktree, tree, excludeRoots, {
    preserveMatchingIndex: options.force !== true,
    restoreStructure: options.force === true,
  });
  moveHead(context, repo, options.ref, commit);
}

function requireCheckoutAllowed(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  force: boolean,
  excludeRoots: readonly string[],
): void {
  if (force) return;
  const blocked = checkoutBlockersAgainstOwned(
    repo,
    worktree,
    repo.headTree(),
    tree,
    paths,
    prune,
    undefined,
    [...excludeRoots],
  );
  if (blocked.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${blocked.tracked.join(", ")} would be overwritten by checkout`,
    );
  }
  if (blocked.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by checkout: ${blocked.untracked.join(", ")}`,
    );
  }
}

export interface SwitchOptions {
  name: string;
  /** Create the branch first — `git switch -c`. */
  create?: boolean;
  startPoint?: string;
}

export function switchBranch(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: SwitchOptions,
): void {
  switchBranchExcluding(context, repo, worktree, options, []);
}

/** Switch while preserving registered repository roots below this worktree. */
export function switchBranchExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: SwitchOptions,
  excludeRoots: readonly string[],
): void {
  repo.store.db.transactionSync(() => {
    // The branch is created first, so a name collision leaves the tree alone.
    if (options.create === true) {
      branch(context, repo, { name: options.name, startPoint: options.startPoint });
    }
    checkoutExcluding(context, repo, worktree, { ref: options.name }, excludeRoots);
  });
}

/**
 * HEAD stays symbolic when the requested ref is a local branch, and
 * detaches at the commit for anything else — a tag, a remote-tracking
 * branch, or a raw oid.
 */
function moveHead(context: GitContext, repo: Repository, ref: string, commit: string): void {
  const expanded = expandRefOwned(repo, ref);
  const full = expanded === "HEAD" ? resolveHeadOwned(repo).ref : expanded;
  mutateRefsOwned(
    repo.checkout,
    { head: full?.startsWith(HEADS) ? `ref: ${full}` : commit },
    operationRefLogMetadata(context, repo, "checkout"),
  );
}
