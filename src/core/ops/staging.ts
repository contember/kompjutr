// Staging: moving working-tree facts into the SQL index.
//
// The index is rows, so staging writes one row per *changed* path instead
// of rewriting a whole `.git/index` blob. The only work proportional to the
// tracked-file count is the single `SELECT` over `git_index` — everything
// after that is bounded by what actually changed.

import { PathspecNotFoundError } from "../errors.js";
import { loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import type { Worktree } from "../worktree.js";
import { checkoutTree, indexFromTree, matchesPaths, treeEntries } from "./checkout.js";
import { hashWorktreePath, indexEntryFor, indexMatchesStat, walkWorktree } from "./worktree-io.js";
import type { IndexEntry } from "../../sqlite/store.js";

export interface AddOptions {
  /** Repo-relative pathspecs. Empty is a no-op, like `git add` with no arguments. */
  paths: string[];
  /** Stage every change under the repository, ignoring `paths`. */
  all?: boolean;
  /** Restrict `all` to paths already in HEAD — the `commit -a` semantics. */
  trackedOnly?: boolean;
  /** Stage a path even when `.gitignore` matches it. */
  force?: boolean;
  /**
   * Roots of nested repositories, from `nestedRoots(context, repo.root)`.
   * The ops layer has no `GitContext`, so the caller resolves them.
   */
  excludeRoots?: string[];
}

/**
 * Stage working-tree changes into the index.
 *
 * A pathspec stages removals under it too, the way `git add <dir>` has
 * since git 2.0; `all` does the same across the whole repository.
 */
export function add(repo: Repository, worktree: Worktree, options: AddOptions): void {
  const all = options.all === true;
  const specs = normalizeSpecs(options.paths);
  if (!all && specs.length === 0) return;

  const force = options.force === true;
  const walked = walkWorktree(worktree, repo.root, {
    excludeRoots: options.excludeRoots,
    paths: all ? undefined : specs,
    ignores: force ? undefined : loadIgnoreMatcher(worktree, repo.root),
  });

  const tracked = new Map<string, IndexEntry>();
  const conflicted = new Set<string>();
  for (const entry of repo.store.indexEntries()) {
    if (entry.stage === 0) tracked.set(entry.path, entry);
    else conflicted.add(entry.path);
  }
  // `commit -a` never adds a path HEAD does not already have.
  const headPaths = all && options.trackedOnly === true ? treeEntries(repo, repo.headTree()) : null;

  if (!all) assertPathspecsMatch(worktree, repo.root, specs, walked, tracked.keys());

  const seen = new Set(walked);
  const updates: IndexEntry[] = [];
  const removals: string[] = [];

  for (const relative of walked) {
    if (headPaths !== null && !headPaths.has(relative)) continue;
    const update = stage(repo, worktree, relative, tracked.get(relative), conflicted);
    if (update !== null) updates.push(update);
  }

  for (const [path, existing] of tracked) {
    if (seen.has(path)) continue;
    if (!all && !matchesPaths(path, specs)) continue;
    if (headPaths !== null && !headPaths.has(path)) continue;
    const stat = worktree.stat(joinPath(repo.root, path));
    if (stat === null || stat.type === "directory") {
      removals.push(path);
      continue;
    }
    // git never ignores a tracked path, so one the walk filtered out still stages.
    if (indexMatchesStat(existing, stat)) continue;
    const hashed = hashWorktreePath(repo, worktree, path);
    if (hashed !== null) updates.push(indexEntryFor(path, hashed));
  }

  applyIndex(repo, updates, removals, conflicted);
}

export interface RmOptions {
  paths: string[];
}

/**
 * Unstage paths. Computer's `rm` is `--cached` only — it never touches the
 * working tree — and this matches that exactly.
 */
export function rm(repo: Repository, _worktree: Worktree, options: RmOptions): void {
  const specs = normalizeSpecs(options.paths);
  if (specs.length === 0) return;

  const matched = new Set<string>();
  const removals = new Set<string>();
  for (const entry of repo.store.indexEntries()) {
    if (!matchesPaths(entry.path, specs)) continue;
    noteMatches(matched, specs, entry.path);
    removals.add(entry.path);
  }
  for (const spec of specs) {
    if (!matched.has(spec)) throw new PathspecNotFoundError(spec);
  }
  if (removals.size === 0) return;

  repo.store.db.transactionSync(() => {
    for (const path of removals) repo.store.indexRemove(path);
  });
}

export interface ResetOptions {
  /** Unstage these paths back to `ref`, leaving the working tree alone. */
  paths?: string[];
  /** Move the current branch to `ref` and rewrite index and working tree. */
  hard?: boolean;
  /** Commit-ish to reset to. Defaults to HEAD. */
  ref?: string;
}

/**
 * `paths` and `hard` are documented as mutually exclusive; `hard` wins if
 * both arrive. A bare reset unstages everything without moving any ref.
 */
export function reset(repo: Repository, worktree: Worktree, options: ResetOptions = {}): void {
  if (options.hard === true) {
    hardReset(repo, worktree, options.ref);
    return;
  }

  const specs = normalizeSpecs(options.paths ?? []);
  const tree = targetTree(repo, options.ref);
  if (specs.length === 0) {
    // This one genuinely replaces the whole index, so the big hammer fits.
    repo.store.indexReplace(indexFromTree(repo, tree));
    return;
  }

  const target = treeEntries(repo, tree);
  const updates: IndexEntry[] = [];
  for (const entry of target.values()) {
    if (!matchesPaths(entry.path, specs)) continue;
    updates.push({
      path: entry.path,
      stage: 0,
      mode: Number.parseInt(entry.mode, 8),
      oid: entry.oid,
      size: null,
      mtime: null,
      ino: null,
    });
  }

  const conflicted = new Set<string>();
  const removals = new Set<string>();
  for (const entry of repo.store.indexEntries()) {
    if (!matchesPaths(entry.path, specs)) continue;
    if (entry.stage !== 0) conflicted.add(entry.path);
    if (!target.has(entry.path)) removals.add(entry.path);
  }

  applyIndex(repo, updates, [...removals], conflicted);
}

/** Paths in the index, sorted. The `--ref` form is `lsFilesAtRef`. */
export function lsFiles(repo: Repository): string[] {
  const out: string[] = [];
  let previous: string | null = null;
  for (const entry of repo.store.indexEntries()) {
    // Conflict stages repeat the path; callers want it once.
    if (entry.path === previous) continue;
    out.push(entry.path);
    previous = entry.path;
  }
  return out.sort();
}

/** Restore index and working tree to `ref`, dragging the current branch along. */
function hardReset(repo: Repository, worktree: Worktree, ref?: string): void {
  const commit = targetCommit(repo, ref);
  const tree = commit === null ? null : repo.readCommit(commit).tree;
  const head = repo.head();
  if (commit !== null && head.ref !== null) repo.store.setRef(head.ref, commit);

  if (repo.store.hasConflicts()) {
    const stages = new Set<string>();
    for (const entry of repo.store.indexEntries()) {
      if (entry.stage !== 0) stages.add(entry.path);
    }
    repo.store.db.transactionSync(() => {
      for (const path of stages) repo.store.indexRemove(path);
    });
  }

  checkoutTree(repo, worktree, tree);
}

function targetCommit(repo: Repository, ref?: string): string | null {
  if (ref === undefined || ref === "HEAD") {
    const { oid } = repo.head();
    return oid === null ? null : repo.peel(oid);
  }
  return repo.peel(repo.revParse(ref));
}

function targetTree(repo: Repository, ref?: string): string | null {
  const commit = targetCommit(repo, ref);
  return commit === null ? null : repo.readCommit(commit).tree;
}

/** The index row `relative` deserves, or null when it is already current. */
function stage(
  repo: Repository,
  worktree: Worktree,
  relative: string,
  existing: IndexEntry | undefined,
  conflicted: Set<string>,
): IndexEntry | null {
  const stat = worktree.stat(joinPath(repo.root, relative));
  if (stat === null || stat.type === "directory") return null;
  if (existing !== undefined && !conflicted.has(relative) && indexMatchesStat(existing, stat)) {
    return null;
  }
  const hashed = hashWorktreePath(repo, worktree, relative);
  return hashed === null ? null : indexEntryFor(relative, hashed);
}

/** One transaction for the whole staging change, however many rows it is. */
function applyIndex(
  repo: Repository,
  updates: IndexEntry[],
  removals: string[],
  conflicted: Set<string>,
): void {
  if (updates.length === 0 && removals.length === 0) return;
  repo.store.db.transactionSync(() => {
    for (const path of removals) repo.store.indexRemove(path);
    for (const entry of updates) {
      // indexPut only overwrites stage 0, so a conflict has to be cleared first.
      if (conflicted.has(entry.path)) repo.store.indexRemove(entry.path);
      repo.store.indexPut(entry);
    }
  });
}

/** Repo-relative pathspecs, without the "./" and trailing-slash noise. */
function normalizeSpecs(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let spec = raw.trim();
    while (spec.startsWith("./")) spec = spec.slice(2);
    spec = spec.replace(/\/+$/, "");
    if (spec === ".") spec = "";
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

function noteMatches(matched: Set<string>, specs: string[], path: string): void {
  for (const spec of specs) {
    if (!matched.has(spec) && matchesPaths(path, [spec])) matched.add(spec);
  }
}

/**
 * Real git exits 128 with `pathspec '<x>' did not match any files`. A path
 * that exists but is ignored is not that case: `add` skips it silently,
 * which is what isomorphic-git does and therefore what Computer promises.
 */
function assertPathspecsMatch(
  worktree: Worktree,
  root: string,
  specs: string[],
  walked: string[],
  tracked: Iterable<string>,
): void {
  const matched = new Set<string>();
  for (const path of walked) {
    if (matched.size === specs.length) break;
    noteMatches(matched, specs, path);
  }
  for (const path of tracked) {
    if (matched.size === specs.length) break;
    noteMatches(matched, specs, path);
  }
  for (const spec of specs) {
    if (matched.has(spec)) continue;
    if (worktree.stat(joinPath(root, spec)) !== null) continue;
    throw new PathspecNotFoundError(spec);
  }
}
