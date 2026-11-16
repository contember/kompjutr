import { GitError } from "../../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../../common/ref-name.js";
import { mutateRefsOwned } from "../../store/refs/refs.js";
import { checkoutTreeExcluding } from "../checkout/checkout.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "../checkout/initial-checkout.js";
import { trySparseCleanCheckout } from "../checkout/sparse-checkout-operation.js";
import type { GitContext } from "../core/context.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import { treeOf } from "../repository/reads.js";
import { type Repository, resolveHeadOwned } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { compilePathspecs, requirePathspecsMatched } from "../worktree/worktree-io.js";
import { branch } from "./refs-branches.js";
import {
  type CheckoutBlockers,
  checkoutBlockers,
  describeBlockers,
} from "./refs-checkout-guard.js";

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
export type {
  CheckoutBlockerLimits,
  CheckoutBlockers,
  CheckoutGuard,
  CheckoutPathSelection,
} from "./refs-checkout-guard.js";
export { checkoutBlockers } from "./refs-checkout-guard.js";

const HEADS = "refs/heads/";

export interface CheckoutOptions {
  /** Branch, tag or commit to check out. */
  ref: string;
  /** Update only these paths, and leave HEAD where it is. */
  paths?: string[];
  /**
   * Overwrite local changes instead of refusing. Path checkout overwrites
   * tracked changes regardless and refuses only over untracked content.
   */
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
  requireSharedMutationScope(repo.store.db, worktree);
  const paths = options.paths !== undefined && options.paths.length > 0 ? options.paths : undefined;

  if (paths !== undefined) {
    const tree = treeOf(repo, checkoutCommit(repo, options.ref));
    // Git matches a path checkout's pathspecs against the source tree alone.
    requirePathspecsMatched(paths, [treeStream(repo, tree)]);
    requirePathCheckoutAllowed(repo, worktree, tree, paths, options.force === true, excludeRoots);
    // Path checkout restores named targets without pruning absent ones.
    checkoutTreeExcluding(repo, worktree, tree, excludeRoots, {
      paths,
      prune: false,
      restoreStructure: true,
    });
    return;
  }

  const { head, commit } = checkoutTarget(repo, options.ref);
  const tree = treeOf(repo, commit);
  try {
    repo.store.db.transactionSync(() => {
      if (
        excludeRoots.length === 0 &&
        tryInitialCheckout(context, repo, tree, {
          requireSharedDatabase: true,
          fallbackOnCapacity: true,
          afterMaterialize: () => moveHead(context, repo, head),
        })
      ) {
        return;
      }
      const tracker = context.indexTracker;
      if (tracker !== undefined && excludeRoots.length === 0) {
        if (trySparseCleanCheckout(context, repo, worktree, tree)) {
          moveHead(context, repo, head);
          tracker.reseal(repo.checkout.checkoutId, tree, []);
          return;
        }
      }
      checkoutLegacy(context, repo, worktree, options, tree, head, excludeRoots);
    });
  } catch (error) {
    if (!isInitialCheckoutFallback(error)) throw error;
    repo.store.db.transactionSync(() => {
      checkoutLegacy(context, repo, worktree, options, tree, head, excludeRoots);
    });
  }
}

function checkoutLegacy(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CheckoutOptions,
  tree: string,
  head: string,
  excludeRoots: readonly string[],
): void {
  const force = options.force === true;
  // git's initial checkout, with no index yet, skips the carry; an empty
  // index is the nearest state kompjutr can tell apart.
  const baselineTree = force || !hasIndexEntries(repo) ? undefined : repo.headTree();
  requireCheckoutAllowed(repo, worktree, tree, force, excludeRoots, baselineTree !== undefined);
  checkoutTreeExcluding(repo, worktree, tree, excludeRoots, {
    preserveMatchingIndex: !force,
    restoreStructure: true,
    baselineTree,
  });
  moveHead(context, repo, head);
}

function hasIndexEntries(repo: Repository): boolean {
  for (const _entry of repo.checkout.indexScan({ pageSize: 1 })) return true;
  return false;
}

function requireCheckoutAllowed(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  force: boolean,
  excludeRoots: readonly string[],
  carryStaged: boolean,
): void {
  if (force) return;
  const blocked = checkoutBlockers(repo, worktree, {
    tree,
    prune: true,
    excludeRoots: [...excludeRoots],
    mode: "checkout",
    carryStaged,
  });
  if (blocked.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${describeBlockers(blocked.tracked, blocked.trackedOmitted)} would be overwritten by checkout`,
    );
  }
  requireNoUntrackedBlockers(blocked);
}

/**
 * Path checkout overwrites tracked changes as Git does, but unlike Git it
 * refuses to delete untracked content in the way of a selected path.
 */
function requirePathCheckoutAllowed(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  paths: readonly string[],
  force: boolean,
  excludeRoots: readonly string[],
): void {
  if (force) return;
  requireNoUntrackedBlockers(
    checkoutBlockers(repo, worktree, {
      tree,
      paths: compilePathspecs(paths),
      prune: false,
      excludeRoots: [...excludeRoots],
      mode: "checkout",
    }),
  );
}

function requireNoUntrackedBlockers(blocked: CheckoutBlockers): void {
  if (blocked.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by checkout: ${describeBlockers(blocked.untracked, blocked.untrackedOmitted)}`,
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
  requireSharedMutationScope(repo.store.db, worktree);
  repo.store.db.transactionSync(() => {
    if (options.create === true && options.startPoint === undefined && repo.head().oid === null) {
      switchUnbornBranch(context, repo, options.name);
      return;
    }
    // The branch is created first, so a name collision leaves the tree alone.
    if (options.create === true) {
      branch(context, repo, { name: options.name, startPoint: options.startPoint });
    }
    checkoutExcluding(context, repo, worktree, { ref: options.name }, excludeRoots);
  });
}

/** An unborn HEAD has no commit to branch from, so Git only renames the unborn branch. */
function switchUnbornBranch(context: GitContext, repo: Repository, name: string): void {
  const full = `${HEADS}${name}`;
  if (repo.store.getRef(full) !== null) {
    throw new GitError("EBRANCHFAIL", `a branch named '${name}' already exists`);
  }
  moveHead(context, repo, `ref: ${full}`);
}

interface CheckoutTarget {
  /** The raw HEAD value to write: `ref: <branch>`, or the commit to detach at. */
  head: string;
  commit: string;
}

/** The commit `checkout` and `restore --source` read `ref` from, as git resolves it. */
export function checkoutCommit(repo: Repository, ref: string): string {
  return checkoutTarget(repo, ref).commit;
}

/**
 * Git attaches HEAD only when the argument names a local branch, and then
 * takes that branch's tip even over a same-named tag; a path checkout reads
 * the same commit. Anything else — a tag, a full ref name, a revision
 * expression, a raw oid — detaches.
 */
function checkoutTarget(repo: Repository, ref: string): CheckoutTarget {
  if (ref === "HEAD") {
    const current = resolveHeadOwned(repo).ref;
    const commit = repo.peel(repo.revParse("HEAD"));
    return { head: current === null ? commit : `ref: ${current}`, commit };
  }
  const branchRef = `${HEADS}${ref}`;
  const isBranchName = checkRefText(branchRef).problem === null && hasCanonicalRefSyntax(branchRef);
  if (isBranchName && repo.store.getRef(branchRef) !== null) {
    return { head: `ref: ${branchRef}`, commit: repo.peel(repo.revParse(branchRef)) };
  }
  const commit = repo.peel(repo.revParse(ref));
  return { head: commit, commit };
}

function moveHead(context: GitContext, repo: Repository, head: string): void {
  mutateRefsOwned(repo.checkout, { head }, operationRefLogMetadata(context, repo, "checkout"));
}
