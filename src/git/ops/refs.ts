import { mutateRefsOwned } from "../store/refs.js";
import { sharedRepoStoreMutations } from "../store/shared.js";
// Branches, tags and HEAD movement, plus the working-tree reconciliation
// that goes with moving HEAD. Refs are rows; HEAD is a column on the
// repository row, so nothing here writes a file.

import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import { comparePaths, joinSorted } from "../common/streams.js";
import {
  contentIdKey,
  type IndexEntry,
  indexScanOwned,
  listCheckoutsOwned,
} from "../store/index.js";
import { resolveBranchUpstream } from "./branch-upstream.js";
import { checkoutTreeExcluding, matchesPaths, stageZero, type TargetEntry } from "./checkout.js";
import type { GitContext } from "./context.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "./initial-checkout.js";
import { selectMergeBases } from "./merge-base.js";
import { treeOf } from "./reads.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { expandRefOwned, type Repository, resolveHeadOwned } from "./repository.js";
import { trySparseCleanCheckout } from "./sparse-checkout.js";
import { treeStream } from "./tree-stream.js";
import { gitModeFor, type Worktree } from "./worktree.js";
import {
  createWorktreeHashCursor,
  hashWorktreePathsOwned,
  indexMatchesStat,
  type WorktreeHashCursor,
  type WorktreePath,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io.js";

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";
const CHECKOUT_GUARD_BATCH = 1_000;

export interface BranchOptions {
  name: string;
  /** Commit-ish the branch points at. Defaults to HEAD. */
  startPoint?: string;
  /**
   * Point HEAD at the new branch. The working tree is left where it is —
   * `switchBranch` is the spelling that moves both.
   */
  checkout?: boolean;
  force?: boolean;
}

export function branch(context: GitContext, repo: Repository, options: BranchOptions): void {
  branchOwned(context, repo, options);
}

function branchOwned(context: GitContext, repo: Repository, options: BranchOptions): void {
  const full = branchRef(options.name);
  const exists = refExists(repo, full);
  if (options.force !== true && exists) {
    throw new GitError("EBRANCHFAIL", `a branch named '${options.name}' already exists`);
  }
  // A branch names a commit, so an annotated tag start point is peeled.
  const oid = repo.peel(repo.revParse(options.startPoint ?? "HEAD"));
  repo.store.db.transactionSync(() => {
    const mutation =
      options.checkout === true
        ? { puts: [{ name: full, target: oid }], head: symbolicRef(full) }
        : { puts: [{ name: full, target: oid }] };
    mutateRefsOwned(
      repo.checkout,
      mutation,
      operationRefLogMetadata(context, repo, exists ? "branch: reset" : "branch: create"),
    );
  });
}

export interface BranchDeleteOptions {
  name: string;
  /** Delete even when the branch is not fully merged. */
  force?: boolean;
}

export interface BranchRenameOptions {
  /** Branch to rename. Defaults to the selected checkout's current branch. */
  oldName?: string;
  newName: string;
}

export function branchRename(
  context: GitContext,
  repo: Repository,
  options: BranchRenameOptions,
): void {
  branchRenameOwned(context, repo, options);
}

function branchRenameOwned(
  context: GitContext,
  repo: Repository,
  options: BranchRenameOptions,
): void {
  const runtimeOptions: unknown = options;
  const optionObject =
    typeof runtimeOptions === "object" && runtimeOptions !== null ? runtimeOptions : null;
  const newName = optionObject === null ? undefined : Reflect.get(optionObject, "newName");
  const oldName = optionObject === null ? undefined : Reflect.get(optionObject, "oldName");
  const destination = branchRenameRef(newName, "new branch name");
  const requestedSource =
    oldName === undefined ? null : branchRenameRef(oldName, "old branch name");
  const metadata = operationRefLogMetadata(context, repo, "branch: rename");

  repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const oldHead = repo.checkout.head();
    let source: string;
    if (requestedSource === null) {
      const selected = oldHead.startsWith("ref: ") ? oldHead.slice(5) : null;
      if (selected?.startsWith(HEADS) !== true) {
        throw new GitError("EBRANCHFAIL", "cannot rename branch from detached HEAD");
      }
      source = selected;
    } else {
      source = requestedSource;
    }

    const tip = repo.store.getRef(source);
    if (tip === null) {
      throw new GitError("EBRANCHFAIL", `branch '${source.slice(HEADS.length)}' not found`);
    }
    if (!isOid(tip)) {
      throw new CorruptError(`branch '${source.slice(HEADS.length)}' is not a direct ref`);
    }
    repo.readAuthenticatedCommit(tip);
    if (source === destination || repo.store.getRef(destination) !== null) {
      throw new GitError(
        "EBRANCHFAIL",
        `a branch named '${destination.slice(HEADS.length)}' already exists`,
      );
    }

    const sourceHead = symbolicRef(source);
    const checkoutOwner = listCheckoutsOwned(context.database, repo.store.repoId).find(
      (checkout) => checkout.head === sourceHead,
    );
    if (checkoutOwner !== undefined && checkoutOwner.id !== repo.checkout.checkoutId) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot rename branch '${source.slice(HEADS.length)}': it is checked out at ${checkoutOwner.root}`,
      );
    }

    const sourceConfig = branchConfigPrefix(source);
    const destinationConfig = branchConfigPrefix(destination);
    sharedRepoStoreMutations(repo.store).configMoveSectionOwned(sourceConfig, destinationConfig);
    mutateRefsOwned(
      repo.checkout,
      {
        puts: [{ name: destination, target: tip }],
        deletes: [source],
        head: oldHead === sourceHead ? symbolicRef(destination) : undefined,
        expected: { name: source, target: tip },
      },
      metadata,
    );
  });
}

function branchRenameRef(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError("EINVAL", `${label} is required`);
  }
  const checked = checkRefText(value);
  if (checked.problem !== null) throw new GitError("EINVAL", `${label} is invalid`);
  const ref = `${HEADS}${value}`;
  if (!hasCanonicalRefSyntax(ref)) throw new GitError("EINVAL", `${label} is invalid`);
  return ref;
}

export function branchDelete(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
): void {
  branchDeleteOwned(context, repo, options);
}

function branchDeleteOwned(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
): void {
  const full = branchRef(options.name);
  repo.store.db.transactionSync(() => {
    const storedTip = repo.store.getRef(full);
    if (storedTip === null) {
      throw new GitError("EBRANCHFAIL", `branch '${options.name}' not found`);
    }
    if (!isOid(storedTip)) {
      throw new CorruptError(`branch '${options.name}' does not point to a commit`);
    }
    const tip = storedTip;
    repo.readCommit(tip);
    const attachedHead = symbolicRef(full);
    const attachedCheckout = listCheckoutsOwned(context.database, repo.store.repoId).find(
      (checkout) => checkout.head === attachedHead,
    );
    if (attachedCheckout !== undefined) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot delete branch '${options.name}': it is checked out at ${attachedCheckout.root}`,
      );
    }

    if (options.force !== true) {
      const upstream = resolveBranchUpstream(repo, full);
      const upstreamOid = upstream?.oid;
      const fallback =
        upstreamOid === null || upstreamOid === undefined ? resolveHeadOwned(repo).oid : null;
      const comparison = upstreamOid ?? fallback;
      if (comparison === null) {
        throw new GitError(
          "EBRANCHFAIL",
          `cannot delete branch '${options.name}': no comparison commit is available`,
        );
      }
      const selection = selectMergeBases(repo, { currentOid: comparison, incomingOid: tip });
      if (selection.kind === "shallow") {
        throw new GitError(
          "ESHALLOW",
          `cannot prove branch '${options.name}' is fully merged across a shallow boundary`,
        );
      }
      if (selection.kind !== "already-merged") {
        throw new GitError("EBRANCHFAIL", `branch '${options.name}' is not fully merged`);
      }
    }

    mutateRefsOwned(
      repo.checkout,
      { deletes: [full], expected: { name: full, target: tip } },
      operationRefLogMetadata(context, repo, "branch: delete"),
    );
  });
}

export function branchList(repo: Repository): string[] {
  return repo.branches().sort();
}

export interface CurrentBranchOptions {
  /** Return `refs/heads/<name>` instead of `<name>`. */
  fullname?: boolean;
}

/**
 * The short name by default. Computer's prose doc claims `fullname`
 * defaults to true, but its code hands the flag straight to
 * isomorphic-git, which defaults to false.
 */
export function currentBranch(
  repo: Repository,
  options: CurrentBranchOptions = {},
): string | undefined {
  const { ref } = resolveHeadOwned(repo);
  if (ref === null) return undefined;
  if (options.fullname === true || !ref.startsWith(HEADS)) return ref;
  return ref.slice(HEADS.length);
}

export interface TagOptions {
  name: string;
  /** Object to tag. Defaults to HEAD. */
  object?: string;
  force?: boolean;
}

/** Lightweight tags only: a ref row, no tag object. */
export function tag(context: GitContext, repo: Repository, options: TagOptions): void {
  tagOwned(context, repo, options);
}

function tagOwned(context: GitContext, repo: Repository, options: TagOptions): void {
  const full = tagRef(options.name);
  const exists = refExists(repo, full);
  if (options.force !== true && exists) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' already exists`);
  }
  const target = repo.revParse(options.object ?? "HEAD");
  repo.typeOf(target);
  mutateRefsOwned(
    repo.checkout,
    { puts: [{ name: full, target }] },
    operationRefLogMetadata(context, repo, exists ? "tag: update" : "tag: create"),
  );
}

export interface TagDeleteOptions {
  name: string;
}

export function tagDelete(context: GitContext, repo: Repository, options: TagDeleteOptions): void {
  tagDeleteOwned(context, repo, options);
}

function tagDeleteOwned(context: GitContext, repo: Repository, options: TagDeleteOptions): void {
  const full = tagRef(options.name);
  if (repo.store.getRef(full) === null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' not found`);
  }
  mutateRefsOwned(
    repo.checkout,
    { deletes: [full] },
    operationRefLogMetadata(context, repo, "tag: delete"),
  );
}

export function tagList(repo: Repository): string[] {
  return repo.tags().sort();
}

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

function branchRef(name: string): string {
  if (name === "") throw new GitError("EBRANCHFAIL", "a branch name is required");
  return `${HEADS}${name}`;
}

function tagRef(name: string): string {
  if (name === "") throw new GitError("ETAGFAIL", "a tag name is required");
  return `${TAGS}${name}`;
}

function refExists(repo: Repository, name: string): boolean {
  const present = repo.store.db.scalar<unknown>(
    "SELECT 1 FROM git_refs WHERE repo_id = ? AND name = ? LIMIT 1",
    repo.store.repoId,
    name,
  );
  if (present === undefined) return false;
  if (present !== 1) throw new CorruptError("ref existence query returned invalid state");
  return true;
}

function symbolicRef(ref: string): string {
  return `ref: ${ref}`;
}

function branchConfigPrefix(ref: string): string {
  return `branch.${ref.slice(HEADS.length)}.`;
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
    { head: full?.startsWith(HEADS) ? symbolicRef(full) : commit },
    operationRefLogMetadata(context, repo, "checkout"),
  );
}

/**
 * Tracked paths this checkout would rewrite or remove whose working-tree
 * content no longer matches the index — the set real git refuses to
 * clobber. A path missing from disk is not one of them: git restores a
 * locally deleted file without complaint.
 */
export interface CheckoutBlockers {
  /** Tracked paths carrying uncommitted work the checkout would discard. */
  tracked: string[];
  /** Untracked files the target tree would write over. */
  untracked: string[];
}

export interface CheckoutBlockerLimits {
  maxRows: number;
  rows: number;
  maxHashCandidates: number;
  hashCandidates: number;
}

/**
 * What stands between the working tree and `tree`. git refuses a checkout
 * for two separate reasons and says so in two separate messages, so they
 * are kept apart here.
 *
 * "Uncommitted" covers both halves: a file differing from the index, and an
 * index entry differing from HEAD. Either would be lost, and only the first
 * is what `dirtyPaths` can see on its own.
 */
export function checkoutBlockers(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  limits?: CheckoutBlockerLimits,
): CheckoutBlockers {
  return checkoutBlockersOwned(repo, worktree, tree, paths, prune, limits);
}

/** Internal checkout guard shared by integration operations. */
export function checkoutBlockersOwned(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  limits?: CheckoutBlockerLimits,
): CheckoutBlockers {
  return checkoutBlockersAgainstOwned(repo, worktree, repo.headTree(), tree, paths, prune, limits);
}

/** Checkout safety when an operation's checked-out baseline is not the published HEAD tree. */
export function checkoutBlockersAgainst(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  limits?: CheckoutBlockerLimits,
  excludeRoots: string[] = [],
): CheckoutBlockers {
  return checkoutBlockersAgainstOwned(
    repo,
    worktree,
    baselineTree,
    tree,
    paths,
    prune,
    limits,
    excludeRoots,
  );
}

/** Internal checkout guard with an explicit baseline. */
export function checkoutBlockersAgainstOwned(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  limits?: CheckoutBlockerLimits,
  excludeRoots: string[] = [],
): CheckoutBlockers {
  return checkoutBlockersAgainstMode(
    repo,
    worktree,
    baselineTree,
    tree,
    paths,
    prune,
    limits,
    false,
    excludeRoots,
  );
}

/** Checkout safety for a sequencer hard reset that intentionally discards tracked edits. */
export function hardResetBlockersAgainst(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  limits: CheckoutBlockerLimits,
  excludeRoots: string[] = [],
): CheckoutBlockers {
  return hardResetBlockersAgainstOwned(repo, worktree, baselineTree, tree, limits, excludeRoots);
}

/** Internal hard-reset guard shared by sequencer operations. */
export function hardResetBlockersAgainstOwned(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  limits: CheckoutBlockerLimits,
  excludeRoots: string[] = [],
): CheckoutBlockers {
  return checkoutBlockersAgainstMode(
    repo,
    worktree,
    baselineTree,
    tree,
    undefined,
    true,
    limits,
    true,
    excludeRoots,
  );
}

function checkoutBlockersAgainstMode(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  limits: CheckoutBlockerLimits | undefined,
  discardTrackedChanges: boolean,
  excludeRoots: string[],
): CheckoutBlockers {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const dirtyCandidates: GuardCandidate[] = [];
  const pendingTargets: PendingTarget[] = [];
  const pendingTrackedPaths: PendingTarget[] = [];
  const untrackedAncestors: PendingTarget[] = [];
  const hashCursor = createWorktreeHashCursor();

  for (const row of checkoutGuardRows(repo, worktree, baselineTree, tree, excludeRoots)) {
    if (limits !== undefined) {
      if (limits.rows >= limits.maxRows) {
        throw new GitError("E2BIG", `checkout guard exceeds ${limits.maxRows} source rows`);
      }
      limits.rows++;
    }
    expireRanges(pendingTargets, row.path);
    expireRanges(pendingTrackedPaths, row.path);
    expireRanges(untrackedAncestors, row.path);
    if (
      row.worktree !== undefined &&
      row.index === undefined &&
      (!discardTrackedChanges || row.head === undefined)
    ) {
      for (let index = pendingTargets.length - 1; index >= 0; index--) {
        const pending = pendingTargets[index]!;
        if (!row.path.startsWith(`${pending.path}/`)) continue;
        pendingTargets.splice(index, 1);
        retainBlocker(untracked, pending.path);
        break;
      }
      for (let index = pendingTrackedPaths.length - 1; index >= 0; index--) {
        const pending = pendingTrackedPaths[index]!;
        if (!row.path.startsWith(`${pending.path}/`)) continue;
        pendingTrackedPaths.splice(index, 1);
        retainBlocker(untracked, pending.path);
        break;
      }
      if (row.target === undefined) retainRange(untrackedAncestors, row.path);
    }

    const target = row.target;
    const existing = row.index;
    if (!matchesPaths(row.path, paths)) continue;

    if (target === undefined) {
      // Only the checkout that prunes would remove this path.
      if (!prune || existing === undefined) continue;
    } else if (existing === undefined) {
      if (discardTrackedChanges && row.head !== undefined) {
        if (row.worktree === undefined) retainRange(pendingTrackedPaths, row.path);
        continue;
      }
      const ancestor = findAncestor(untrackedAncestors, row.path);
      if (ancestor !== undefined) {
        convertRangeToBlocker(untrackedAncestors, ancestor, untracked);
      } else if (row.worktree !== undefined) {
        retainBlocker(untracked, row.path);
      } else {
        retainRange(pendingTargets, row.path);
      }
      continue;
    }

    if (existing === undefined) continue;
    const changesIndex =
      target === undefined ||
      existing.oid !== target.oid ||
      existing.mode !== Number.parseInt(target.mode, 8);
    const ancestor = changesIndex ? findAncestor(untrackedAncestors, row.path) : undefined;
    if (ancestor !== undefined) {
      untrackedAncestors.splice(untrackedAncestors.indexOf(ancestor), 1);
      retainBlocker(discardTrackedChanges ? untracked : tracked, row.path);
      continue;
    }
    if (discardTrackedChanges) {
      if (target !== undefined && row.worktree === undefined) {
        retainRange(pendingTrackedPaths, row.path);
      }
      continue;
    }
    if (changesIndex && differsFromHead(existing, row.head)) {
      retainBlocker(tracked, row.path);
      continue;
    }
    if (!changesIndex) continue;
    if (row.worktree === undefined) {
      retainRange(pendingTrackedPaths, row.path);
      continue;
    }
    if (indexMatchesStat(existing, row.worktree.stat)) continue;
    dirtyCandidates.push({ entry: existing, worktree: row.worktree });
    if (dirtyCandidates.length >= CHECKOUT_GUARD_BATCH) {
      flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, limits, hashCursor);
    }
  }
  flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, limits, hashCursor);
  tracked.sort(comparePaths);
  untracked.sort(comparePaths);
  return { tracked, untracked };
}

interface CheckoutGuardRow {
  path: string;
  target: TargetEntry | undefined;
  head: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
}

function* checkoutGuardRows(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  excludeRoots: string[],
): Generator<CheckoutGuardRow> {
  const trees = joinSorted(treeStream(repo, tree), treeStream(repo, baselineTree), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  });
  const current = joinSorted(
    stageZero(indexScanOwned(repo.checkout)),
    walkWorktreeEntriesStreamOwned(worktree, repo.root, { excludeRoots }),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  );
  for (const row of joinSorted(trees, current, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const target = row.left?.left;
    const head = row.left?.right;
    const index = row.right?.left;
    const worktreeEntry = row.right?.right;
    yield {
      path: row.path,
      target,
      head,
      index,
      worktree: worktreeEntry,
    };
  }
}

interface GuardCandidate {
  entry: IndexEntry;
  worktree: WorktreePath;
}

interface PendingTarget {
  path: string;
  upper: string;
}

function retainBlocker(paths: string[], path: string): void {
  paths.push(path);
}

function retainRange(ranges: PendingTarget[], path: string): void {
  ranges.push({ path, upper: `${path}0` });
}

function expireRanges(ranges: PendingTarget[], path: string): void {
  while (ranges.length > 0 && comparePaths(path, ranges[ranges.length - 1]!.upper) >= 0) {
    ranges.pop();
  }
}

function findAncestor(ranges: PendingTarget[], path: string): PendingTarget | undefined {
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    if (path.startsWith(`${range.path}/`)) return range;
  }
  return undefined;
}

function convertRangeToBlocker(
  ranges: PendingTarget[],
  range: PendingTarget,
  blockers: string[],
): void {
  ranges.splice(ranges.indexOf(range), 1);
  retainBlocker(blockers, range.path);
}

function flushGuardCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: GuardCandidate[],
  tracked: string[],
  limits: CheckoutBlockerLimits | undefined,
  hashCursor: WorktreeHashCursor,
): void {
  if (candidates.length === 0) return;
  const identities = repo.store.lookupBlobIds(
    candidates.flatMap((candidate) =>
      candidate.worktree.stat.contentId === null ? [] : [candidate.worktree.stat.contentId],
    ),
  );
  const needsHash: GuardCandidate[] = [];
  for (const candidate of candidates) {
    const contentId = candidate.worktree.stat.contentId;
    const mapped = contentId === null ? undefined : identities.get(contentIdKey(contentId));
    if (
      mapped === candidate.entry.oid &&
      candidate.entry.mode === Number.parseInt(gitModeFor(candidate.worktree.stat), 8)
    ) {
      continue;
    }
    needsHash.push(candidate);
  }
  if (limits !== undefined) {
    if (needsHash.length > 0) {
      if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
        throw new GitError(
          "E2BIG",
          `checkout guard hashing exceeds ${limits.maxHashCandidates} paths`,
        );
      }
      limits.hashCandidates += needsHash.length;
    }
  }
  const hashed = hashWorktreePathsOwned(
    repo,
    worktree,
    needsHash.map((candidate) => candidate.worktree),
    { write: false },
    hashCursor,
  );
  const dirty = new Set<string>();
  for (const candidate of needsHash) {
    const actual = hashed.get(candidate.entry.path);
    if (
      actual === undefined ||
      actual.oid !== candidate.entry.oid ||
      Number.parseInt(actual.mode, 8) !== candidate.entry.mode
    ) {
      dirty.add(candidate.entry.path);
    }
  }
  for (const candidate of candidates) {
    if (dirty.has(candidate.entry.path)) retainBlocker(tracked, candidate.entry.path);
  }
  candidates.length = 0;
}

function differsFromHead(entry: IndexEntry, head: TargetEntry | undefined): boolean {
  if (head === undefined) return true;
  return entry.oid !== head.oid || entry.mode !== Number.parseInt(head.mode, 8);
}
