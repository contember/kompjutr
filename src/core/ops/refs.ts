// Branches, tags and HEAD movement, plus the working-tree reconciliation
// that goes with moving HEAD. Refs are rows; HEAD is a column on the
// repository row, so nothing here writes a file.

import type { MemoryReservation } from "../../memory.js";
import {
  contentIdKey,
  createRefMutationMemoryOwner,
  type IndexEntry,
  indexScanOwned,
  mutateRefsOwned,
  type RefMutationMemoryOwner,
} from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import type { GitContext } from "../context.js";
import { CorruptError, GitError } from "../errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../ref-name.js";
import { expandRefOwned, type Repository, resolveHeadOwned } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths, joinSorted } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { resolveBranchUpstream } from "./branch-upstream.js";
import { checkoutTree, matchesPaths, stageZero, type TargetEntry } from "./checkout.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "./initial-checkout.js";
import { selectMergeBases } from "./merge-base.js";
import { treeOf } from "./reads.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { trySparseCleanCheckout } from "./sparse-checkout.js";
import { treeStream } from "./tree-stream.js";
import {
  hashWorktreePathsOwned,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io.js";

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";
const CHECKOUT_GUARD_BATCH = 1_000;
const INDEX_ENTRY_BYTES = 256;
const WORKTREE_ENTRY_BYTES = 256;
const DIRECTORY_ENTRY_BYTES = 96;
const HASH_LOOKUP_ENTRY_BYTES = 128;
const HASH_OID_BYTES = retainedStringBytes("0".repeat(40));

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
  const owner = new RefOperationOwner(repo);
  try {
    branchOwned(context, repo, options, owner);
  } finally {
    owner.dispose();
  }
}

function branchOwned(
  context: GitContext,
  repo: Repository,
  options: BranchOptions,
  owner: RefOperationOwner,
): void {
  const full = branchRef(owner, options.name);
  const exists = refExists(repo, full);
  if (options.force !== true && exists) {
    throw new GitError("EBRANCHFAIL", `a branch named '${options.name}' already exists`);
  }
  // A branch names a commit, so an annotated tag start point is peeled.
  const oid = repo.peel(repo.revParse(options.startPoint ?? "HEAD"));
  repo.store.db.transactionSync(() => {
    const mutation =
      options.checkout === true
        ? { puts: [{ name: full, target: oid }], head: symbolicRef(owner, full) }
        : { puts: [{ name: full, target: oid }] };
    mutateRefsOwned(
      repo.checkout,
      mutation,
      operationRefLogMetadata(
        context,
        repo,
        exists ? "branch: reset" : "branch: create",
        {},
        owner.mutationOwner,
      ),
      owner.mutationOwner,
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
  const owner = new RefOperationOwner(repo);
  try {
    branchRenameOwned(context, repo, options, owner);
  } finally {
    owner.dispose();
  }
}

function branchRenameOwned(
  context: GitContext,
  repo: Repository,
  options: BranchRenameOptions,
  owner: RefOperationOwner,
): void {
  const runtimeOptions: unknown = options;
  const optionObject =
    typeof runtimeOptions === "object" && runtimeOptions !== null ? runtimeOptions : null;
  const newName = optionObject === null ? undefined : Reflect.get(optionObject, "newName");
  const oldName = optionObject === null ? undefined : Reflect.get(optionObject, "oldName");
  const destination = branchRenameRef(owner, newName, "new branch name");
  const requestedSource =
    oldName === undefined ? null : branchRenameRef(owner, oldName, "old branch name");
  const metadata = operationRefLogMetadata(
    context,
    repo,
    "branch: rename",
    {},
    owner.mutationOwner,
  );

  repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const oldHead = owner.retain(repo.checkout.head());
    let source: string;
    if (requestedSource === null) {
      const selected = oldHead.startsWith("ref: ")
        ? owner.construct(oldHead.length - 5, () => oldHead.slice(5))
        : null;
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

    const sourceHead = symbolicRef(owner, source);
    const checkoutOwner = context.database
      .listCheckouts(repo.store.repoId)
      .find((checkout) => checkout.head === sourceHead);
    if (checkoutOwner !== undefined && checkoutOwner.id !== repo.checkout.checkoutId) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot rename branch '${source.slice(HEADS.length)}': it is checked out at ${checkoutOwner.root}`,
      );
    }

    const sourceConfig = branchConfigPrefix(owner, source);
    const destinationConfig = branchConfigPrefix(owner, destination);
    repo.store.configMoveSection(sourceConfig, destinationConfig);
    mutateRefsOwned(
      repo.checkout,
      {
        puts: [{ name: destination, target: tip }],
        deletes: [source],
        head: oldHead === sourceHead ? symbolicRef(owner, destination) : undefined,
        expected: { name: source, target: tip },
      },
      metadata,
      owner.mutationOwner,
    );
  });
}

function branchRenameRef(owner: RefOperationOwner, value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError("EINVAL", `${label} is required`);
  }
  const checked = checkRefText(value);
  if (checked.problem !== null) throw new GitError("EINVAL", `${label} is invalid`);
  const ref = owner.construct(HEADS.length + value.length, () => `${HEADS}${value}`);
  if (!hasCanonicalRefSyntax(ref)) throw new GitError("EINVAL", `${label} is invalid`);
  return ref;
}

export function branchDelete(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
): void {
  const owner = new RefOperationOwner(repo);
  try {
    branchDeleteOwned(context, repo, options, owner);
  } finally {
    owner.dispose();
  }
}

function branchDeleteOwned(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
  owner: RefOperationOwner,
): void {
  const full = branchRef(owner, options.name);
  repo.store.db.transactionSync(() => {
    const storedTip = repo.store.getRef(full);
    if (storedTip === null) {
      throw new GitError("EBRANCHFAIL", `branch '${options.name}' not found`);
    }
    if (!isOid(storedTip)) {
      throw new CorruptError(`branch '${options.name}' does not point to a commit`);
    }
    const tip = owner.retain(storedTip);
    repo.readCommit(tip);
    const attachedHead = symbolicRef(owner, full);
    const attachedCheckout = context.database
      .listCheckouts(repo.store.repoId)
      .find((checkout) => checkout.head === attachedHead);
    if (attachedCheckout !== undefined) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot delete branch '${options.name}': it is checked out at ${attachedCheckout.root}`,
      );
    }

    if (options.force !== true) {
      const upstream = resolveBranchUpstream(repo, full, owner.mutationOwner);
      const upstreamOid = upstream?.oid;
      const fallback =
        upstreamOid === null || upstreamOid === undefined
          ? resolveHeadOwned(repo, owner).oid
          : null;
      const comparison = upstreamOid ?? (fallback === null ? null : owner.retain(fallback));
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
      operationRefLogMetadata(context, repo, "branch: delete", {}, owner.mutationOwner),
      owner.mutationOwner,
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
  const owner = new RefOperationOwner(repo);
  try {
    const { ref } = resolveHeadOwned(repo, owner);
    if (ref === null) return undefined;
    if (options.fullname === true || !ref.startsWith(HEADS)) return ref;
    return owner.construct(ref.length - HEADS.length, () => ref.slice(HEADS.length));
  } finally {
    owner.dispose();
  }
}

export interface TagOptions {
  name: string;
  /** Object to tag. Defaults to HEAD. */
  object?: string;
  force?: boolean;
}

/** Lightweight tags only: a ref row, no tag object. */
export function tag(context: GitContext, repo: Repository, options: TagOptions): void {
  const owner = new RefOperationOwner(repo);
  try {
    tagOwned(context, repo, options, owner);
  } finally {
    owner.dispose();
  }
}

function tagOwned(
  context: GitContext,
  repo: Repository,
  options: TagOptions,
  owner: RefOperationOwner,
): void {
  const full = tagRef(owner, options.name);
  const exists = refExists(repo, full);
  if (options.force !== true && exists) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' already exists`);
  }
  mutateRefsOwned(
    repo.checkout,
    { puts: [{ name: full, target: repo.revParse(options.object ?? "HEAD") }] },
    operationRefLogMetadata(
      context,
      repo,
      exists ? "tag: update" : "tag: create",
      {},
      owner.mutationOwner,
    ),
    owner.mutationOwner,
  );
}

export interface TagDeleteOptions {
  name: string;
}

export function tagDelete(context: GitContext, repo: Repository, options: TagDeleteOptions): void {
  const owner = new RefOperationOwner(repo);
  try {
    tagDeleteOwned(context, repo, options, owner);
  } finally {
    owner.dispose();
  }
}

function tagDeleteOwned(
  context: GitContext,
  repo: Repository,
  options: TagDeleteOptions,
  owner: RefOperationOwner,
): void {
  const full = tagRef(owner, options.name);
  if (repo.store.getRef(full) === null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' not found`);
  }
  mutateRefsOwned(
    repo.checkout,
    { deletes: [full] },
    operationRefLogMetadata(context, repo, "tag: delete", {}, owner.mutationOwner),
    owner.mutationOwner,
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
  const paths = options.paths !== undefined && options.paths.length > 0 ? options.paths : undefined;
  const commit = repo.peel(repo.revParse(options.ref));
  const tree = treeOf(repo, commit);

  if (paths !== undefined) {
    requireCheckoutAllowed(repo, worktree, tree, paths, false, options.force === true);
    // Path checkout restores named targets without pruning absent ones.
    checkoutTree(repo, worktree, tree, { paths, prune: false, restoreStructure: true });
    return;
  }

  try {
    repo.store.db.transactionSync(() => {
      if (
        tryInitialCheckout(context, repo, tree, {
          requireSharedDatabase: true,
          fallbackOnCapacity: true,
          afterMaterialize: () => moveHead(context, repo, options.ref, commit),
        })
      ) {
        return;
      }
      const tracker = context.indexTracker;
      if (tracker !== undefined) {
        const sparseReservation = repo.store.reserveMemory();
        try {
          if (trySparseCleanCheckout(context, repo, worktree, tree, sparseReservation)) {
            moveHead(context, repo, options.ref, commit);
            tracker.reseal(repo.checkout.checkoutId, tree, [], sparseReservation);
            return;
          }
        } finally {
          sparseReservation.dispose();
        }
      }
      checkoutLegacy(context, repo, worktree, options, tree, commit);
    });
  } catch (error) {
    if (!isInitialCheckoutFallback(error)) throw error;
    repo.store.db.transactionSync(() => {
      checkoutLegacy(context, repo, worktree, options, tree, commit);
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
): void {
  requireCheckoutAllowed(repo, worktree, tree, undefined, true, options.force === true);
  checkoutTree(repo, worktree, tree, {
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
): void {
  if (force) return;
  const blocked = checkoutBlockers(repo, worktree, tree, paths, prune);
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
  repo.store.db.transactionSync(() => {
    // The branch is created first, so a name collision leaves the tree alone.
    if (options.create === true) {
      branch(context, repo, { name: options.name, startPoint: options.startPoint });
    }
    checkout(context, repo, worktree, { ref: options.name });
  });
}

function branchRef(owner: RefOperationOwner, name: string): string {
  if (name === "") throw new GitError("EBRANCHFAIL", "a branch name is required");
  return owner.construct(HEADS.length + name.length, () => `${HEADS}${name}`);
}

function tagRef(owner: RefOperationOwner, name: string): string {
  if (name === "") throw new GitError("ETAGFAIL", "a tag name is required");
  return owner.construct(TAGS.length + name.length, () => `${TAGS}${name}`);
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

function symbolicRef(owner: RefOperationOwner, ref: string): string {
  return owner.construct(5 + ref.length, () => `ref: ${ref}`);
}

function branchConfigPrefix(owner: RefOperationOwner, ref: string): string {
  const shortUnits = ref.length - HEADS.length;
  const short = owner.construct(shortUnits, () => ref.slice(HEADS.length));
  return owner.construct("branch..".length + shortUnits, () => `branch.${short}.`);
}

class RefOperationOwner {
  readonly mutationOwner: RefMutationMemoryOwner;

  constructor(repo: Repository) {
    this.mutationOwner = createRefMutationMemoryOwner(repo.store);
  }

  construct<T extends string>(units: number, construct: () => T): T {
    return this.mutationOwner.construct(units, construct);
  }

  retain<T extends string>(value: T): T {
    return this.mutationOwner.owns(value) ? value : this.mutationOwner.retain(value);
  }

  dispose(): void {
    this.mutationOwner.dispose();
  }
}

/**
 * HEAD stays symbolic when the requested ref is a local branch, and
 * detaches at the commit for anything else — a tag, a remote-tracking
 * branch, or a raw oid.
 */
function moveHead(context: GitContext, repo: Repository, ref: string, commit: string): void {
  const owner = new RefOperationOwner(repo);
  try {
    const expanded = expandRefOwned(repo, ref, owner);
    const full = expanded === "HEAD" ? resolveHeadOwned(repo, owner).ref : expanded;
    if (full !== null) owner.retain(full);
    mutateRefsOwned(
      repo.checkout,
      { head: full?.startsWith(HEADS) ? symbolicRef(owner, full) : commit },
      operationRefLogMetadata(context, repo, "checkout", {}, owner.mutationOwner),
      owner.mutationOwner,
    );
  } finally {
    owner.dispose();
  }
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
  const reservation = repo.store.reserveMemory();
  try {
    return checkoutBlockersOwned(repo, worktree, tree, paths, prune, reservation, limits);
  } finally {
    reservation.dispose();
  }
}

/** Internal checkout guard under a caller-owned dedicated reservation. */
export function checkoutBlockersOwned(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  reservation: MemoryReservation,
  limits?: CheckoutBlockerLimits,
): CheckoutBlockers {
  return checkoutBlockersAgainstOwned(
    repo,
    worktree,
    repo.headTree(),
    tree,
    paths,
    prune,
    reservation,
    limits,
  );
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
  const reservation = repo.store.reserveMemory();
  try {
    return checkoutBlockersAgainstOwned(
      repo,
      worktree,
      baselineTree,
      tree,
      paths,
      prune,
      reservation,
      limits,
      excludeRoots,
    );
  } finally {
    reservation.dispose();
  }
}

/** Internal checkout guard with an explicit baseline and caller-owned reservation. */
export function checkoutBlockersAgainstOwned(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
  reservation: MemoryReservation,
  limits?: CheckoutBlockerLimits,
  excludeRoots: string[] = [],
): CheckoutBlockers {
  if (!repo.store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "checkout guard reservation belongs to another repository");
  }
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
    reservation,
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
  const reservation = repo.store.reserveMemory();
  try {
    return hardResetBlockersAgainstOwned(
      repo,
      worktree,
      baselineTree,
      tree,
      reservation,
      limits,
      excludeRoots,
    );
  } finally {
    reservation.dispose();
  }
}

/** Internal hard-reset guard under a caller-owned dedicated reservation. */
export function hardResetBlockersAgainstOwned(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  reservation: MemoryReservation,
  limits: CheckoutBlockerLimits,
  excludeRoots: string[] = [],
): CheckoutBlockers {
  if (!repo.store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "checkout guard reservation belongs to another repository");
  }
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
    reservation,
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
  reservation: MemoryReservation,
): CheckoutBlockers {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const dirtyCandidates: GuardCandidate[] = [];
  const pendingTargets: PendingTarget[] = [];
  const pendingTrackedPaths: PendingTarget[] = [];
  const untrackedAncestors: PendingTarget[] = [];
  const budget = new CheckoutGuardBudget(reservation);

  for (const row of checkoutGuardRows(
    repo,
    worktree,
    baselineTree,
    tree,
    excludeRoots,
    reservation,
  )) {
    if (limits !== undefined) {
      if (limits.rows >= limits.maxRows) {
        throw new GitError("E2BIG", `checkout guard exceeds ${limits.maxRows} source rows`);
      }
      limits.rows++;
    }
    expireRanges(pendingTargets, row.path, budget);
    expireRanges(pendingTrackedPaths, row.path, budget);
    expireRanges(untrackedAncestors, row.path, budget);
    if (
      row.worktree !== undefined &&
      row.index === undefined &&
      (!discardTrackedChanges || row.head === undefined)
    ) {
      for (let index = pendingTargets.length - 1; index >= 0; index--) {
        const pending = pendingTargets[index]!;
        if (!row.path.startsWith(`${pending.path}/`)) continue;
        budget.release(pending.bytes);
        pendingTargets.splice(index, 1);
        retainBlocker(untracked, pending.path, budget);
        break;
      }
      for (let index = pendingTrackedPaths.length - 1; index >= 0; index--) {
        const pending = pendingTrackedPaths[index]!;
        if (!row.path.startsWith(`${pending.path}/`)) continue;
        budget.release(pending.bytes);
        pendingTrackedPaths.splice(index, 1);
        retainBlocker(untracked, pending.path, budget);
        break;
      }
      if (row.target === undefined) retainRange(untrackedAncestors, row.path, budget);
    }

    const target = row.target;
    const existing = row.index;
    if (!matchesPaths(row.path, paths)) continue;

    if (target === undefined) {
      // Only the checkout that prunes would remove this path.
      if (!prune || existing === undefined) continue;
    } else if (existing === undefined) {
      if (discardTrackedChanges && row.head !== undefined) {
        if (row.worktree === undefined) retainRange(pendingTrackedPaths, row.path, budget);
        continue;
      }
      const ancestor = findAncestor(untrackedAncestors, row.path);
      if (ancestor !== undefined) {
        convertRangeToBlocker(untrackedAncestors, ancestor, untracked, budget);
      } else if (row.worktree !== undefined) {
        retainBlocker(untracked, row.path, budget);
      } else {
        retainRange(pendingTargets, row.path, budget);
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
      budget.release(ancestor.bytes);
      untrackedAncestors.splice(untrackedAncestors.indexOf(ancestor), 1);
      retainBlocker(discardTrackedChanges ? untracked : tracked, row.path, budget);
      continue;
    }
    if (discardTrackedChanges) {
      if (target !== undefined && row.worktree === undefined) {
        retainRange(pendingTrackedPaths, row.path, budget);
      }
      continue;
    }
    if (changesIndex && differsFromHead(existing, row.head)) {
      retainBlocker(tracked, row.path, budget);
      continue;
    }
    if (!changesIndex) continue;
    if (row.worktree === undefined) {
      retainRange(pendingTrackedPaths, row.path, budget);
      continue;
    }
    if (indexMatchesStat(existing, row.worktree.stat)) continue;
    const bytes =
      INDEX_ENTRY_BYTES +
      WORKTREE_ENTRY_BYTES +
      retainedStringBytes(existing.path) +
      retainedStringBytes(existing.oid) +
      retainedStringBytes(row.worktree.path) +
      retainedStringBytes(row.worktree.stat.target ?? "");
    budget.add(bytes);
    dirtyCandidates.push({ entry: existing, worktree: row.worktree, bytes });
    if (dirtyCandidates.length >= CHECKOUT_GUARD_BATCH) {
      flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, budget, limits, reservation);
    }
  }
  flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, budget, limits, reservation);
  releaseRanges(pendingTargets, budget);
  releaseRanges(pendingTrackedPaths, budget);
  releaseRanges(untrackedAncestors, budget);
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

function checkoutGuardRowRetainedBytes(
  path: string,
  target: TargetEntry | undefined,
  head: TargetEntry | undefined,
  index: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
): number {
  let bytes = 256 + retainedStringBytes(path);
  for (const entry of [target, head]) {
    if (entry !== undefined) {
      bytes +=
        128 +
        retainedStringBytes(entry.path) +
        retainedStringBytes(entry.mode) +
        retainedStringBytes(entry.oid);
    }
  }
  if (index !== undefined) {
    bytes += INDEX_ENTRY_BYTES + retainedStringBytes(index.path) + retainedStringBytes(index.oid);
  }
  if (worktree !== undefined) {
    bytes +=
      WORKTREE_ENTRY_BYTES +
      retainedStringBytes(worktree.path) +
      retainedStringBytes(worktree.stat.target ?? "") +
      (worktree.stat.contentId?.byteLength ?? 0);
  }
  return bytes;
}

function* checkoutGuardRows(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  excludeRoots: string[],
  reservation: MemoryReservation,
): Generator<CheckoutGuardRow> {
  const indexMemory = reservation.scope();
  const worktreeMemory = reservation.scope();
  const trees = joinSorted(treeStream(repo, tree), treeStream(repo, baselineTree), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  });
  const current = joinSorted(
    stageZero(indexScanOwned(repo.checkout, indexMemory)),
    walkWorktreeEntriesStreamOwned(worktree, repo.root, worktreeMemory, { excludeRoots }),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  );
  try {
    for (const row of joinSorted(trees, current, {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      const target = row.left?.left;
      const head = row.left?.right;
      const index = row.right?.left;
      const worktreeEntry = row.right?.right;
      const rowMemory = reservation.scope();
      rowMemory.set(
        "other",
        checkoutGuardRowRetainedBytes(row.path, target, head, index, worktreeEntry),
      );
      const result = {
        path: row.path,
        target,
        head,
        index,
        worktree: worktreeEntry,
      };
      try {
        yield result;
      } finally {
        rowMemory.dispose();
      }
    }
  } finally {
    worktreeMemory.dispose();
    indexMemory.dispose();
  }
}

interface GuardCandidate {
  entry: IndexEntry;
  worktree: WorktreePath;
  bytes: number;
}

interface PendingTarget {
  path: string;
  upper: string;
  bytes: number;
}

class CheckoutGuardBudget {
  readonly #reservation: MemoryReservation;
  #bytes = 256;

  constructor(reservation: MemoryReservation) {
    this.#reservation = reservation;
    this.#reservation.set("other", this.#bytes);
  }

  add(bytes: number): void {
    const next = this.#bytes + bytes;
    this.#reservation.set("other", next);
    this.#bytes = next;
  }

  construct(units: number, construct: () => string): string {
    const predicted = 48 + units * 2;
    this.add(predicted);
    try {
      const value = construct();
      const actual = retainedStringBytes(value);
      if (actual > predicted) this.add(actual - predicted);
      else if (actual < predicted) this.release(predicted - actual);
      return value;
    } catch (error) {
      this.release(predicted);
      throw error;
    }
  }

  release(bytes: number): void {
    this.#bytes -= bytes;
    if (this.#bytes < 256) throw new Error("checkout guard memory accounting is corrupt");
    this.#reservation.set("other", this.#bytes);
  }
}

function retainBlocker(paths: string[], path: string, budget: CheckoutGuardBudget): void {
  budget.add(DIRECTORY_ENTRY_BYTES + retainedStringBytes(path));
  paths.push(path);
}

function retainRange(ranges: PendingTarget[], path: string, budget: CheckoutGuardBudget): void {
  const retainedPathBytes = DIRECTORY_ENTRY_BYTES + retainedStringBytes(path);
  budget.add(retainedPathBytes);
  try {
    const upper = budget.construct(path.length + 1, () => `${path}0`);
    const bytes = retainedPathBytes + retainedStringBytes(upper);
    ranges.push({ path, upper, bytes });
  } catch (error) {
    budget.release(retainedPathBytes);
    throw error;
  }
}

function expireRanges(ranges: PendingTarget[], path: string, budget: CheckoutGuardBudget): void {
  while (ranges.length > 0 && comparePaths(path, ranges[ranges.length - 1]!.upper) >= 0) {
    budget.release(ranges.pop()!.bytes);
  }
}

function releaseRanges(ranges: PendingTarget[], budget: CheckoutGuardBudget): void {
  for (const range of ranges) budget.release(range.bytes);
  ranges.length = 0;
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
  budget: CheckoutGuardBudget,
): void {
  budget.release(range.bytes);
  ranges.splice(ranges.indexOf(range), 1);
  retainBlocker(blockers, range.path, budget);
}

function flushGuardCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: GuardCandidate[],
  tracked: string[],
  budget: CheckoutGuardBudget,
  limits: CheckoutBlockerLimits | undefined,
  reservation: MemoryReservation,
): void {
  if (candidates.length === 0) return;
  const current = reservation.scope();
  current.set("other", candidates.length * (HASH_LOOKUP_ENTRY_BYTES + 32 + HASH_OID_BYTES));
  try {
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
    const hashReservation = reservation.scope();
    try {
      const hashed = hashWorktreePathsOwned(
        repo,
        worktree,
        needsHash.map((candidate) => candidate.worktree),
        hashReservation,
        { write: false },
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
        budget.release(candidate.bytes);
        if (dirty.has(candidate.entry.path)) retainBlocker(tracked, candidate.entry.path, budget);
      }
      candidates.length = 0;
    } finally {
      hashReservation.dispose();
    }
  } finally {
    current.dispose();
  }
}

function differsFromHead(entry: IndexEntry, head: TargetEntry | undefined): boolean {
  if (head === undefined) return true;
  return entry.oid !== head.oid || entry.mode !== Number.parseInt(head.mode, 8);
}
