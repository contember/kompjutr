import { GitError } from "../common/errors.js";
import { comparePaths, joinSorted } from "../common/streams.js";
import { contentIdKey, type IndexEntry, indexScanOwned } from "../store/index.js";
import { matchesPaths, stageZero, type TargetEntry } from "./checkout.js";
import type { Repository } from "./repository.js";
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

const CHECKOUT_GUARD_BATCH = 1_000;

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
  if (limits !== undefined && needsHash.length > 0) {
    if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
      throw new GitError(
        "E2BIG",
        `checkout guard hashing exceeds ${limits.maxHashCandidates} paths`,
      );
    }
    limits.hashCandidates += needsHash.length;
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
