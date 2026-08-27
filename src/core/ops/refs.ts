// Branches, tags and HEAD movement, plus the working-tree reconciliation
// that goes with moving HEAD. Refs are rows; HEAD is a column on the
// repository row, so nothing here writes a file.

import { contentIdKey, type IndexEntry } from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import type { GitContext } from "../context.js";
import { CorruptError, GitError } from "../errors.js";
import type { Repository } from "../repository.js";
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
  hashWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
  worktreeHashRangeReads,
} from "./worktree-io.js";

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";
const CHECKOUT_GUARD_BYTES = 16 * 1024 * 1024;
const CHECKOUT_GUARD_BATCH = 1_000;
const INDEX_ENTRY_BYTES = 256;
const WORKTREE_ENTRY_BYTES = 256;
const DIRECTORY_ENTRY_BYTES = 96;

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
  const full = branchRef(options.name);
  const current = repo.store.getRef(full);
  if (options.force !== true && current !== null) {
    throw new GitError("EBRANCHFAIL", `a branch named '${options.name}' already exists`);
  }
  // A branch names a commit, so an annotated tag start point is peeled.
  const oid = repo.peel(repo.revParse(options.startPoint ?? "HEAD"));
  repo.store.db.transactionSync(() => {
    const mutation =
      options.checkout === true
        ? { puts: [{ name: full, target: oid }], head: `ref: ${full}` }
        : { puts: [{ name: full, target: oid }] };
    repo.mutateRefs(
      mutation,
      operationRefLogMetadata(context, repo, current === null ? "branch: create" : "branch: reset"),
    );
  });
}

export interface BranchDeleteOptions {
  name: string;
  /** Delete even when the branch is not fully merged. */
  force?: boolean;
}

export function branchDelete(
  context: GitContext,
  repo: Repository,
  options: BranchDeleteOptions,
): void {
  const full = branchRef(options.name);
  repo.store.db.transactionSync(() => {
    const tip = repo.store.getRef(full);
    if (tip === null) {
      throw new GitError("EBRANCHFAIL", `branch '${options.name}' not found`);
    }
    if (!isOid(tip)) {
      throw new CorruptError(`branch '${options.name}' does not point to a commit`);
    }
    repo.readCommit(tip);
    const owner = context.database
      .listCheckouts(repo.store.repoId)
      .find((checkout) => checkout.head === `ref: ${full}`);
    if (owner !== undefined) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot delete branch '${options.name}': it is checked out at ${owner.root}`,
      );
    }

    if (options.force !== true) {
      const upstream = resolveBranchUpstream(repo, full);
      const comparison = upstream?.oid ?? repo.head().oid;
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

    repo.mutateRefs(
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
  const { ref } = repo.head();
  if (ref === null) return undefined;
  if (options.fullname === true) return ref;
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

export interface TagOptions {
  name: string;
  /** Object to tag. Defaults to HEAD. */
  object?: string;
  force?: boolean;
}

/** Lightweight tags only: a ref row, no tag object. */
export function tag(context: GitContext, repo: Repository, options: TagOptions): void {
  const full = tagRef(options.name);
  const current = repo.store.getRef(full);
  if (options.force !== true && current !== null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' already exists`);
  }
  repo.mutateRefs(
    { puts: [{ name: full, target: repo.revParse(options.object ?? "HEAD") }] },
    operationRefLogMetadata(context, repo, current === null ? "tag: create" : "tag: update"),
  );
}

export interface TagDeleteOptions {
  name: string;
}

export function tagDelete(context: GitContext, repo: Repository, options: TagDeleteOptions): void {
  const full = tagRef(options.name);
  if (repo.store.getRef(full) === null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' not found`);
  }
  repo.mutateRefs({ deletes: [full] }, operationRefLogMetadata(context, repo, "tag: delete"));
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
      if (tracker !== undefined && trySparseCleanCheckout(context, repo, worktree, tree)) {
        moveHead(context, repo, options.ref, commit);
        tracker.reseal(repo.checkout.checkoutId, tree, []);
        return;
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

function branchRef(name: string): string {
  if (name === "") throw new GitError("EBRANCHFAIL", "a branch name is required");
  return `${HEADS}${name}`;
}

function tagRef(name: string): string {
  if (name === "") throw new GitError("ETAGFAIL", "a tag name is required");
  return `${TAGS}${name}`;
}

/**
 * HEAD stays symbolic when the requested ref is a local branch, and
 * detaches at the commit for anything else — a tag, a remote-tracking
 * branch, or a raw oid.
 */
function moveHead(context: GitContext, repo: Repository, ref: string, commit: string): void {
  const expanded = repo.expandRef(ref);
  const full = expanded === "HEAD" ? repo.head().ref : expanded;
  repo.mutateRefs(
    { head: full?.startsWith(HEADS) ? `ref: ${full}` : commit },
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
  maxHashBytes: number;
  rows: number;
  hashBytes: number;
  maxHashRangeReads: number;
  hashRangeReads: number;
  maxHashCandidates: number;
  hashCandidates: number;
  maxHashBatches: number;
  hashBatches: number;
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
  return checkoutBlockersAgainst(repo, worktree, repo.headTree(), tree, paths, prune, limits);
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
  );
}

/** Checkout safety for a sequencer hard reset that intentionally discards tracked edits. */
export function hardResetBlockersAgainst(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string | null,
  tree: string | null,
  limits: CheckoutBlockerLimits,
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
): CheckoutBlockers {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const dirtyCandidates: GuardCandidate[] = [];
  const pendingTargets: PendingTarget[] = [];
  const pendingTrackedPaths: PendingTarget[] = [];
  const untrackedAncestors: PendingTarget[] = [];
  const budget = new CheckoutGuardBudget();

  for (const row of checkoutGuardRows(repo, worktree, baselineTree, tree)) {
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
      flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, budget, limits);
    }
  }
  flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, budget, limits);
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
): Generator<CheckoutGuardRow> {
  const trees = joinSorted(treeStream(repo, tree), treeStream(repo, baselineTree), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  });
  const current = joinSorted(
    stageZero(repo.checkout.indexScan()),
    walkWorktreeEntriesStream(worktree, repo.root),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  );
  for (const row of joinSorted(trees, current, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    yield {
      path: row.path,
      target: row.left?.left,
      head: row.left?.right,
      index: row.right?.left,
      worktree: row.right?.right,
    };
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
  #bytes = 0;

  add(bytes: number): void {
    if (bytes > CHECKOUT_GUARD_BYTES - this.#bytes) {
      throw new GitError("E2BIG", `checkout guard state exceeds ${CHECKOUT_GUARD_BYTES} bytes`);
    }
    this.#bytes += bytes;
  }

  release(bytes: number): void {
    this.#bytes -= bytes;
  }
}

function retainBlocker(paths: string[], path: string, budget: CheckoutGuardBudget): void {
  budget.add(DIRECTORY_ENTRY_BYTES + retainedStringBytes(path));
  paths.push(path);
}

function retainRange(ranges: PendingTarget[], path: string, budget: CheckoutGuardBudget): void {
  const upper = `${path}0`;
  const bytes = DIRECTORY_ENTRY_BYTES + retainedStringBytes(path) + retainedStringBytes(upper);
  budget.add(bytes);
  ranges.push({ path, upper, bytes });
}

function expireRanges(ranges: PendingTarget[], path: string, budget: CheckoutGuardBudget): void {
  while (ranges.length > 0 && comparePaths(path, ranges[ranges.length - 1]!.upper) >= 0) {
    budget.release(ranges.pop()!.bytes);
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
      if (limits.hashBatches >= limits.maxHashBatches) {
        throw new GitError(
          "E2BIG",
          `checkout guard hashing exceeds ${limits.maxHashBatches} batches`,
        );
      }
      if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
        throw new GitError(
          "E2BIG",
          `checkout guard hashing exceeds ${limits.maxHashCandidates} paths`,
        );
      }
      limits.hashBatches++;
      limits.hashCandidates += needsHash.length;
    }
    const rangeReads = worktreeHashRangeReads(needsHash.map((candidate) => candidate.worktree));
    if (rangeReads > limits.maxHashRangeReads - limits.hashRangeReads) {
      throw new GitError(
        "E2BIG",
        `checkout guard hashing exceeds ${limits.maxHashRangeReads} range reads`,
      );
    }
    limits.hashRangeReads += rangeReads;
    for (const candidate of needsHash) {
      const size = candidate.worktree.stat.size;
      if (size > limits.maxHashBytes - limits.hashBytes) {
        throw new GitError("E2BIG", `checkout guard hashing exceeds ${limits.maxHashBytes} bytes`);
      }
      limits.hashBytes += size;
    }
  }
  const hashed = hashWorktreePaths(
    repo,
    worktree,
    needsHash.map((candidate) => candidate.worktree),
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
}

function differsFromHead(entry: IndexEntry, head: TargetEntry | undefined): boolean {
  if (head === undefined) return true;
  return entry.oid !== head.oid || entry.mode !== Number.parseInt(head.mode, 8);
}
