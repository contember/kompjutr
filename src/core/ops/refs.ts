// Branches, tags and HEAD movement, plus the working-tree reconciliation
// that goes with moving HEAD. Refs are rows; HEAD is a column on the
// repository row, so nothing here writes a file.

import type { IndexEntry } from "../../sqlite/store.js";
import type { GitContext } from "../context.js";
import { GitError } from "../errors.js";
import type { Repository } from "../repository.js";
import { comparePaths, joinSorted3 } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { checkoutTree, matchesPaths, stageZero, type TargetEntry } from "./checkout.js";
import { treeOf } from "./reads.js";
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
  _context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CheckoutOptions,
): void {
  const paths = options.paths !== undefined && options.paths.length > 0 ? options.paths : undefined;
  const commit = repo.peel(repo.revParse(options.ref));
  const tree = treeOf(repo, commit);

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
    // `git checkout <ref> -- <paths>` restores paths; it never removes any.
    checkoutTree(repo, worktree, tree, { paths, prune: false });
    return;
  }
  checkoutTree(repo, worktree, tree);
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
  const dirtyCandidates: Array<{ entry: IndexEntry; worktree: WorktreePath }> = [];
  const snapshot = checkoutGuardSnapshot(repo, worktree);

  // Target tree, HEAD tree and the bounded index snapshot are path-ordered.
  for (const row of joinSorted3(
    treeStream(repo, tree),
    treeStream(repo, repo.headTree()),
    snapshot.index,
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    const target = row.a;
    const existing = row.c;
    if (!matchesPaths(row.path, paths)) continue;

    if (target === undefined) {
      // Only the checkout that prunes would remove this path.
      if (!prune || existing === undefined) continue;
    } else if (existing === undefined) {
      // A clean tracked directory may be replaced by a file. Only an exact
      // untracked leaf or an untracked descendant blocks the replacement.
      if (snapshot.worktree.has(row.path) || snapshot.untrackedDirectories.has(row.path)) {
        untracked.push(row.path);
      }
      continue;
    } else if (existing.oid === target.oid && existing.mode === Number.parseInt(target.mode, 8)) {
      continue;
    }

    if (existing === undefined) continue;
    if (differsFromHead(existing, row.b)) {
      tracked.push(row.path);
      continue;
    }
    const worktreeEntry = snapshot.worktree.get(existing.path);
    if (worktreeEntry === undefined || indexMatchesStat(existing, worktreeEntry.stat)) continue;
    dirtyCandidates.push({ entry: existing, worktree: worktreeEntry });
  }

  for (let offset = 0; offset < dirtyCandidates.length; offset += CHECKOUT_GUARD_BATCH) {
    const candidates = dirtyCandidates.slice(offset, offset + CHECKOUT_GUARD_BATCH);
    const hashed = hashWorktreePaths(
      repo,
      worktree,
      candidates.map((candidate) => candidate.worktree),
      { write: false },
    );
    for (const candidate of candidates) {
      const actual = hashed.get(candidate.entry.path);
      if (
        actual === undefined ||
        actual.oid !== candidate.entry.oid ||
        Number.parseInt(actual.mode, 8) !== candidate.entry.mode
      ) {
        tracked.push(candidate.entry.path);
      }
    }
  }
  tracked.sort(comparePaths);
  return { tracked, untracked };
}

interface CheckoutGuardSnapshot {
  index: IndexEntry[];
  worktree: Map<string, WorktreePath>;
  untrackedDirectories: Set<string>;
}

function checkoutGuardSnapshot(repo: Repository, worktree: Worktree): CheckoutGuardSnapshot {
  let retained = 0;
  const reserve = (bytes: number): void => {
    if (bytes > CHECKOUT_GUARD_BYTES - retained) {
      throw new GitError("E2BIG", `checkout guard state exceeds ${CHECKOUT_GUARD_BYTES} bytes`);
    }
    retained += bytes;
  };

  const index: IndexEntry[] = [];
  const trackedPaths = new Set<string>();
  for (const entry of stageZero(repo.store.indexScan())) {
    reserve(INDEX_ENTRY_BYTES + retainedStringBytes(entry.path) + retainedStringBytes(entry.oid));
    index.push(entry);
    trackedPaths.add(entry.path);
  }

  const worktreeEntries = new Map<string, WorktreePath>();
  const untrackedDirectories = new Set<string>();
  for (const entry of walkWorktreeEntriesStream(worktree, repo.root)) {
    reserve(
      WORKTREE_ENTRY_BYTES +
        retainedStringBytes(entry.path) +
        retainedStringBytes(entry.stat.target ?? ""),
    );
    worktreeEntries.set(entry.path, entry);
    if (trackedPaths.has(entry.path)) continue;
    for (
      let slash = entry.path.indexOf("/");
      slash !== -1;
      slash = entry.path.indexOf("/", slash + 1)
    ) {
      const directory = entry.path.slice(0, slash);
      if (untrackedDirectories.has(directory)) continue;
      reserve(DIRECTORY_ENTRY_BYTES + retainedStringBytes(directory));
      untrackedDirectories.add(directory);
    }
  }
  return { index, worktree: worktreeEntries, untrackedDirectories };
}

function retainedStringBytes(value: string): number {
  return 48 + value.length * 2;
}

function differsFromHead(entry: IndexEntry, head: TargetEntry | undefined): boolean {
  if (head === undefined) return true;
  return entry.oid !== head.oid || entry.mode !== Number.parseInt(head.mode, 8);
}
