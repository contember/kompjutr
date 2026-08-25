// Staging: moving working-tree facts into the SQL index.
//
// The index is rows, so staging writes one row per *changed* path instead
// of rewriting a whole `.git/index` blob. The only work proportional to the
// tracked-file count is the single `SELECT` over `git_index` — everything
// after that is bounded by what actually changed.

import { contentIdKey, type IndexEntry, type IndexSink } from "../../sqlite/store.js";
import { GitError, PathspecNotFoundError } from "../errors.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { joinSorted, joinSorted3 } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { checkoutTree, indexFromTree, matchesPaths } from "./checkout.js";
import { treeStream } from "./tree-stream.js";
import {
  hashWorktreePaths,
  indexEntryFor,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
} from "./worktree-io.js";

const ADD_WINDOW_ROWS = 1000;
const ADD_RETAINED_BYTES = 16 * 1024 * 1024;
const INDEX_ROW_FIXED_BYTES = 256;
const PATH_ENTRY_FIXED_BYTES = 96;

interface AddIndexPath {
  path: string;
  entry: IndexEntry | undefined;
}

interface AddIndexSnapshot {
  paths: AddIndexPath[];
  conflicted: Set<string>;
}

interface StageCandidate {
  path: string;
  existing: IndexEntry | undefined;
  worktree: WorktreePath;
  conflicted: boolean;
}

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

  const snapshot = snapshotAddIndex(repo, all ? undefined : specs);
  let ignores: IgnoreMatcher | undefined;
  const isIgnored = (path: string): boolean => {
    if (force) return false;
    ignores ??= loadIgnoreMatcher(worktree, repo.root);
    return ignores.ignores(path, false);
  };
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  const walked = walkWorktreeEntriesStream(worktree, repo.root, {
    paths: all ? undefined : specs,
    includeIgnored: true,
  });
  // `commit -a` never adds a path HEAD does not already have.
  const head = trackedOnly ? treeStream(repo, repo.headTree()) : [];

  repo.store.indexApply((sink) => {
    const pending: StageCandidate[] = [];
    const flush = (): void => stageCandidates(repo, worktree, pending, sink);
    for (const row of joinSorted3(walked, snapshot.paths, head, {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    })) {
      if (trackedOnly && row.c === undefined) continue;
      const existing = row.b?.entry;

      if (row.a !== undefined) {
        if (row.b === undefined && isExcluded(row.path, excluded)) continue;
        if (row.b === undefined && isIgnored(row.path)) continue;
        const conflicted = snapshot.conflicted.has(row.path);
        if (!conflicted && existing !== undefined && indexMatchesStat(existing, row.a.stat)) {
          continue;
        }
        pending.push({ path: row.path, existing, worktree: row.a, conflicted });
        if (pending.length >= ADD_WINDOW_ROWS) flush();
        continue;
      }

      // A conflict-only path has no stage-zero row but still needs removal.
      if (row.b === undefined) continue;
      if (!all && !matchesPaths(row.path, specs)) continue;
      sink.remove(row.path);
    }
    flush();
  });
}

function snapshotAddIndex(repo: Repository, specs: string[] | undefined): AddIndexSnapshot {
  const paths: AddIndexPath[] = [];
  const conflicted = new Set<string>();
  let retained = 0;
  let current: AddIndexPath | null = null;
  for (const entry of repo.store.indexScan()) {
    if (specs !== undefined && !matchesPaths(entry.path, specs)) continue;
    retained +=
      INDEX_ROW_FIXED_BYTES + retainedStringBytes(entry.path) + retainedStringBytes(entry.oid);
    if (retained > ADD_RETAINED_BYTES) {
      throw new GitError("E2BIG", `add retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
    }
    if (current === null || current.path !== entry.path) {
      current = { path: entry.path, entry: entry.stage === 0 ? entry : undefined };
      paths.push(current);
      retained += PATH_ENTRY_FIXED_BYTES + retainedStringBytes(entry.path);
    } else if (entry.stage === 0) {
      current.entry = entry;
    }
    if (entry.stage !== 0 && !conflicted.has(entry.path)) {
      retained += PATH_ENTRY_FIXED_BYTES;
      conflicted.add(entry.path);
    }
    if (retained > ADD_RETAINED_BYTES) {
      throw new GitError("E2BIG", `add retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
    }
  }
  return { paths, conflicted };
}

function stageCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: StageCandidate[],
  sink: IndexSink,
): void {
  if (candidates.length === 0) return;
  const rows = candidates.splice(0);
  const identities = repo.store.lookupBlobIds(
    rows.flatMap((row) => {
      if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat))
        return [];
      const contentId = row.worktree.stat.contentId;
      return contentId === null ? [] : [contentId];
    }),
  );
  const unresolved: WorktreePath[] = [];
  const mapped = new Map<string, string>();
  for (const row of rows) {
    if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) continue;
    const contentId = row.worktree.stat.contentId;
    const oid = contentId === null ? undefined : identities.get(contentIdKey(contentId));
    if (oid === undefined) unresolved.push(row.worktree);
    else mapped.set(row.path, oid);
  }
  const hashes = hashWorktreePaths(repo, worktree, unresolved);
  repo.store.upsertBlobIds(
    [...hashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );

  for (const row of rows) {
    let update: IndexEntry | null = null;
    if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) {
      update = indexEntryFor(row.path, {
        oid: row.existing.oid,
        mode: row.existing.mode.toString(8).padStart(6, "0"),
        stat: row.worktree.stat,
      });
    } else {
      const hashed = hashes.get(row.path);
      const oid = mapped.get(row.path);
      if (hashed !== undefined) update = indexEntryFor(row.path, hashed);
      else if (oid !== undefined) {
        update = indexEntryFor(row.path, {
          oid,
          mode: gitModeFor(row.worktree.stat),
          stat: row.worktree.stat,
        });
      }
    }
    if (update === null) {
      if (row.existing !== undefined || row.conflicted) sink.remove(row.path);
      continue;
    }
    if (row.conflicted) sink.remove(row.path);
    sink.put(update);
  }
}

function relativeExcludeRoots(root: string, paths: readonly string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => {
    const relative = relativeTo(root, path);
    return relative === null || relative === "" ? [] : [relative];
  });
}

function isExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
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
  let retained = 0;
  for (const entry of repo.store.indexScan()) {
    if (!matchesPaths(entry.path, specs)) continue;
    noteMatches(matched, specs, entry.path);
    if (!removals.has(entry.path)) {
      retained += PATH_ENTRY_FIXED_BYTES + retainedStringBytes(entry.path);
      if (retained > ADD_RETAINED_BYTES) {
        throw new GitError("E2BIG", `rm retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
      }
    }
    removals.add(entry.path);
  }
  for (const spec of specs) {
    if (!matched.has(spec)) throw new PathspecNotFoundError(spec);
  }
  if (removals.size === 0) return;

  repo.store.indexApply((sink) => {
    for (const path of removals) sink.remove(path);
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
  checkoutTree(repo, worktree, tree, {
    discardUnmerged: true,
    restoreStructure: true,
  });
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
