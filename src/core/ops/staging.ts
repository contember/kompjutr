// Staging: moving working-tree facts into the SQL index.
//
// The index is rows, so staging writes one row per *changed* path instead
// of rewriting a whole `.git/index` blob. The only work proportional to the
// tracked-file count is the single `SELECT` over `git_index` — everything
// after that is bounded by what actually changed.

import type { IndexEntry } from "../../sqlite/store.js";
import { PathspecNotFoundError } from "../errors.js";
import { loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import { joinSorted, joinSorted3 } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { checkoutTree, indexFromTree, matchesPaths, stageZero } from "./checkout.js";
import { treeStream } from "./tree-stream.js";
import {
  hashWorktreePath,
  indexEntryFor,
  indexMatchesStat,
  walkWorktreeStream,
} from "./worktree-io.js";

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
  const trackedOnly = all && options.trackedOnly === true;
  if (!all) assertPathspecsMatch(repo, worktree, specs);

  // Conflict stages repeat a path, which a merge join cannot represent, so
  // they are collected first — and only when there are any at all.
  const conflicted = new Set<string>();
  if (repo.store.hasConflicts()) {
    for (const entry of repo.store.indexScan()) {
      if (entry.stage !== 0) conflicted.add(entry.path);
    }
  }

  const walked = walkWorktreeStream(worktree, repo.root, {
    excludeRoots: options.excludeRoots,
    paths: all ? undefined : specs,
    ignores: force ? undefined : loadIgnoreMatcher(worktree, repo.root),
  });
  // `commit -a` never adds a path HEAD does not already have.
  const head = trackedOnly ? treeStream(repo, repo.headTree()) : [];

  repo.store.indexApply((sink) => {
    for (const row of joinSorted3(walked, stageZero(repo.store.indexScan()), head, {
      a: (path: string) => path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    })) {
      if (trackedOnly && row.c === undefined) continue;
      const existing = row.b;

      if (row.a !== undefined) {
        const update = stage(repo, worktree, row.path, existing, conflicted);
        if (update !== null) sink.put(update);
        continue;
      }

      // Tracked but not walked: either gone, or filtered out by an ignore
      // rule — and git never ignores a path it already tracks.
      if (existing === undefined) continue;
      if (!all && !matchesPaths(row.path, specs)) continue;
      const stat = worktree.stat(joinPath(repo.root, row.path));
      if (stat === null || stat.type === "dir") {
        sink.remove(row.path);
        continue;
      }
      if (indexMatchesStat(existing, stat)) continue;
      const hashed = hashWorktreePath(repo, worktree, row.path);
      if (hashed !== null) sink.put(indexEntryFor(row.path, hashed));
    }
  });
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

  // Tree and index are both path-ordered, so one merge decides each path.
  repo.store.indexApply((sink) => {
    for (const row of joinSorted(indexFromTree(repo, tree), repo.store.indexScan(), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      if (!matchesPaths(row.path, specs)) continue;
      // A conflicted path repeats across stages; clearing it once is enough,
      // and indexPut only ever overwrites stage 0.
      if (row.right !== undefined && row.right.stage !== 0) sink.remove(row.path);
      if (row.left === undefined) {
        if (row.right !== undefined) sink.remove(row.path);
        continue;
      }
      sink.put(row.left);
    }
  });
}

/** Paths in the index, sorted. The `--ref` form is `lsFilesAtRef`. */
export function lsFiles(repo: Repository): string[] {
  const out: string[] = [];
  let previous: string | null = null;
  for (const entry of repo.store.indexScan()) {
    // Conflict stages repeat the path; callers want it once.
    if (entry.path === previous) continue;
    out.push(entry.path);
    previous = entry.path;
  }
  // The scan already returns them in order.
  return out;
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
  if (stat === null || stat.type === "dir") return null;
  if (existing !== undefined && !conflicted.has(relative) && indexMatchesStat(existing, stat)) {
    return null;
  }
  const hashed = hashWorktreePath(repo, worktree, relative);
  return hashed === null ? null : indexEntryFor(relative, hashed);
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
 *
 * Checked before the walk, and in O(pathspecs): anything the walk would
 * match lives under a directory that exists on disk, and anything tracked
 * shows up in a prefix scan of the index. Neither needs the whole tree.
 */
function assertPathspecsMatch(repo: Repository, worktree: Worktree, specs: string[]): void {
  for (const spec of specs) {
    if (spec === "") continue;
    if (worktree.stat(joinPath(repo.root, spec)) !== null) continue;
    const tracked = repo.store.indexScan({ prefix: spec, pageSize: 1 }).next();
    if (tracked.done !== true) continue;
    throw new PathspecNotFoundError(spec);
  }
}
