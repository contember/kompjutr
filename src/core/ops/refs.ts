// Branches, tags and HEAD movement, plus the working-tree reconciliation
// that goes with moving HEAD. Refs are rows; HEAD is a column on the
// repository row, so nothing here writes a file.

import { contentIdKey, type IndexEntry } from "../../sqlite/store.js";
import type { GitContext } from "../context.js";
import { GitError } from "../errors.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths, joinSorted } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { checkoutTree, matchesPaths, stageZero, type TargetEntry } from "./checkout.js";
import { treeOf } from "./reads.js";
import { trySparseCleanCheckout } from "./sparse-checkout.js";
import { treeStream } from "./tree-stream.js";
import {
  hashWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
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

export function branch(repo: Repository, options: BranchOptions): void {
  const full = branchRef(options.name);
  if (options.force !== true && repo.store.getRef(full) !== null) {
    throw new GitError("EBRANCHFAIL", `a branch named '${options.name}' already exists`);
  }
  // A branch names a commit, so an annotated tag start point is peeled.
  const oid = repo.peel(repo.revParse(options.startPoint ?? "HEAD"));
  repo.store.db.transactionSync(() => {
    repo.store.setRef(full, oid);
    if (options.checkout === true) repo.store.setHead(`ref: ${full}`);
  });
}

export interface BranchDeleteOptions {
  name: string;
}

export function branchDelete(repo: Repository, options: BranchDeleteOptions): void {
  const full = branchRef(options.name);
  if (repo.store.getRef(full) === null) {
    throw new GitError("EBRANCHFAIL", `branch '${options.name}' not found`);
  }
  if (repo.head().ref === full) {
    throw new GitError("EBRANCHFAIL", `cannot delete branch '${options.name}': it is checked out`);
  }
  repo.store.deleteRef(full);
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
export function tag(repo: Repository, options: TagOptions): void {
  const full = tagRef(options.name);
  if (options.force !== true && repo.store.getRef(full) !== null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' already exists`);
  }
  repo.store.setRef(full, repo.revParse(options.object ?? "HEAD"));
}

export interface TagDeleteOptions {
  name: string;
}

export function tagDelete(repo: Repository, options: TagDeleteOptions): void {
  const full = tagRef(options.name);
  if (repo.store.getRef(full) === null) {
    throw new GitError("ETAGFAIL", `tag '${options.name}' not found`);
  }
  repo.store.deleteRef(full);
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

  const tracker = context.indexTracker;
  if (
    paths === undefined &&
    tracker !== undefined &&
    trySparseCleanCheckout(context, repo, worktree, tree)
  ) {
    moveHead(repo, options.ref, commit);
    tracker.reseal(repo.store.repoId, tree, []);
    return;
  }

  if (options.force !== true) {
    const blocked = localChangesInTheWay(repo, worktree, tree, paths, paths === undefined);
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

  if (paths !== undefined) {
    // Path checkout restores named targets without pruning absent ones.
    checkoutTree(repo, worktree, tree, { paths, prune: false, restoreStructure: true });
    return;
  }
  checkoutTree(repo, worktree, tree, {
    preserveMatchingIndex: options.force !== true,
    restoreStructure: options.force === true,
  });
  moveHead(repo, options.ref, commit);
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
  // The branch is created first, so a name collision leaves the tree alone.
  if (options.create === true) {
    branch(repo, { name: options.name, startPoint: options.startPoint });
  }
  checkout(context, repo, worktree, { ref: options.name });
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
function moveHead(repo: Repository, ref: string, commit: string): void {
  const expanded = repo.expandRef(ref);
  const full = expanded === "HEAD" ? repo.head().ref : expanded;
  repo.store.setHead(full?.startsWith(HEADS) ? `ref: ${full}` : commit);
}

/**
 * Tracked paths this checkout would rewrite or remove whose working-tree
 * content no longer matches the index — the set real git refuses to
 * clobber. A path missing from disk is not one of them: git restores a
 * locally deleted file without complaint.
 */
interface CheckoutBlockers {
  /** Tracked paths carrying uncommitted work the checkout would discard. */
  tracked: string[];
  /** Untracked files the target tree would write over. */
  untracked: string[];
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
function localChangesInTheWay(
  repo: Repository,
  worktree: Worktree,
  tree: string | null,
  paths: string[] | undefined,
  prune: boolean,
): CheckoutBlockers {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const dirtyCandidates: GuardCandidate[] = [];
  const pendingTargets: PendingTarget[] = [];
  const pendingTrackedPaths: PendingTarget[] = [];
  const untrackedAncestors: PendingTarget[] = [];
  const budget = new CheckoutGuardBudget();

  for (const row of checkoutGuardRows(repo, worktree, tree)) {
    expireRanges(pendingTargets, row.path, budget);
    expireRanges(pendingTrackedPaths, row.path, budget);
    expireRanges(untrackedAncestors, row.path, budget);
    if (row.worktree !== undefined && row.index === undefined) {
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
      retainBlocker(tracked, row.path, budget);
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
      flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, budget);
    }
  }
  flushGuardCandidates(repo, worktree, dirtyCandidates, tracked, budget);
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
  tree: string | null,
): Generator<CheckoutGuardRow> {
  const trees = joinSorted(treeStream(repo, tree), treeStream(repo, repo.headTree()), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  });
  const current = joinSorted(
    stageZero(repo.store.indexScan()),
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
