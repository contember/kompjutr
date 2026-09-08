import type { RealPath, ScanEntry, ScanOptions } from "@kompjutr/drive";
import { nativeRealpathOwned, nativeScanOwned } from "@kompjutr/drive";
import { GitError } from "../../common/errors.js";
import { joinPath, relativeTo, subtreeSuccessor } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import type { IgnoreMatcher } from "../../ignore/index.js";
import type { Worktree, WorktreeStat } from "./worktree.js";
import { type CompiledPathspecMatcher, compilePathspecs } from "./worktree-io-pathspec.js";

/** Rows per working-tree scan. This is also the metadata memory bound. */
export const WORKTREE_SCAN_PAGE = 1000;
export interface WalkOptions {
  /**
   * Absolute paths that are the root of a *different* registered
   * repository. A nested repository's files belong to it, not to this one.
   */
  excludeRoots?: string[];
  /** Restrict the walk to these repo-relative path prefixes. */
  paths?: string[];
  /** A caller-owned compiled form of `paths`. */
  pathspec?: CompiledPathspecMatcher;
  /** Skip ignored paths, and do not descend into ignored directories. */
  ignores?: IgnoreMatcher;
  /** Return ignored paths too, marked, instead of skipping them. */
  includeIgnored?: boolean;
  /** Skip directory rows when no directory-level pruning is needed. */
  filesOnly?: boolean;
  /** Yield directory metadata after using it to prune the walk. */
  includeDirectories?: boolean;
  /** Skip a directory and every descendant after its scan row is observed. */
  pruneDirectory?: (path: string) => boolean;
  /** Fail before consuming more raw filesystem rows, including directories. */
  maxScanRows?: number;
}

/** A repo-relative path and the metadata carried by its scan row. */
export interface WorktreePath {
  path: string;
  stat: WorktreeStat;
}

/**
 * Every file and symlink under the working tree, as sorted repo-relative
 * paths. Directories are not returned — git tracks files.
 *
 * There is no `.git` directory to skip: the repository lives in SQL. That
 * is the one place this design makes a walk cheaper rather than merely
 * different.
 */
export function walkWorktree(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
): string[] {
  return [...walkWorktreeStream(worktree, root, options)];
}

/**
 * The same walk, lazily and already in `comparePaths` order, so it can be
 * merged against the index and a tree without a sort.
 *
 * The filesystem's path-key order is git's tree order. `a.txt` really does
 * sort before `a/x`, since "." is 0x2E and "/" is 0x2F.
 *
 * Bound: one scan page of metadata.
 */
export function* walkWorktreeStream(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
): Generator<string> {
  for (const entry of walkWorktreeEntriesStream(worktree, root, options)) yield entry.path;
}

/** The metadata-preserving worktree walk used by every path-only projection. */
export function* walkWorktreeEntriesStream(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
): Generator<WorktreePath> {
  yield* walkWorktreeEntriesStreamCore(worktree, root, options);
}

/** Internal worktree walk over bounded scan pages. */
export function* walkWorktreeEntriesStreamOwned(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
): Generator<WorktreePath> {
  yield* walkWorktreeEntriesStreamCore(worktree, root, options);
}

function* walkWorktreeEntriesStreamCore(
  worktree: Worktree,
  root: string,
  options: WalkOptions,
): Generator<WorktreePath> {
  if (
    options.maxScanRows !== undefined &&
    (!Number.isSafeInteger(options.maxScanRows) || options.maxScanRows < 0)
  ) {
    throw new GitError("EINVAL", "worktree scan row limit must be a safe nonnegative integer");
  }
  if (
    options.filesOnly === true &&
    ((options.excludeRoots?.length ?? 0) > 0 ||
      (options.paths?.length ?? 0) > 0 ||
      options.pathspec !== undefined ||
      options.ignores !== undefined ||
      options.pruneDirectory !== undefined)
  ) {
    throw new Error("files-only worktree walks cannot prune directories");
  }
  const lexicalRoot = root.replace(/\/+$/, "") || "/";
  const base = readWorktreeRealpath(worktree, lexicalRoot);
  const excluded = new Set<string>();
  let after: string | undefined;
  let afterSubtree: string | undefined;
  let scannedRows = 0;
  const pruned: Array<{ directory: string; lower: string; upper: string }> = [];
  let pathspec = options.pathspec;

  if (pathspec === undefined) {
    pathspec = compilePathspecs(options.paths);
  }
  for (const path of options.excludeRoots ?? []) {
    const relative = relativeTo(lexicalRoot, path);
    const excludedPath = relative === null ? path.replace(/\/+$/, "") : joinPath(base, relative);
    excluded.add(excludedPath);
  }
  const orderedScan = worktree.scanStream;
  if (orderedScan !== undefined) {
    const prunedDirectories = new Set<string>();
    for (const entry of orderedScan.call(worktree, base, {
      filesOnly: options.filesOnly,
      pruneDirectory: (path) => prunedDirectories.delete(path),
    })) {
      if (options.maxScanRows !== undefined && scannedRows >= options.maxScanRows) {
        throw new GitError("E2BIG", `worktree scan exceeds ${options.maxScanRows} rows`);
      }
      scannedRows++;
      const relative = relativeTo(base, entry.path);
      if (relative === null) continue;
      if (excluded.has(entry.path)) {
        if (entry.type === "dir") prunedDirectories.add(entry.path);
        continue;
      }
      if (entry.type === "dir") {
        const outsidePathspec = !pathspec.includesDirectory(relative);
        const ignored =
          options.includeIgnored !== true && options.ignores?.ignores(relative, true) === true;
        if (outsidePathspec || ignored || options.pruneDirectory?.(relative) === true) {
          prunedDirectories.add(entry.path);
          continue;
        }
        if (options.includeDirectories === true) {
          yield { path: relative, stat: statFromScan(entry) };
        }
        continue;
      }
      if (!pathspec.matchesEntry(relative)) continue;
      if (options.includeIgnored !== true && options.ignores?.ignores(relative, false) === true) {
        continue;
      }
      yield { path: relative, stat: statFromScan(entry) };
    }
    return;
  }
  while (true) {
    const read =
      afterSubtree === undefined
        ? readWorktreeScanPage(worktree, base, {
            after,
            filesOnly: options.filesOnly,
            limit: WORKTREE_SCAN_PAGE,
          })
        : readWorktreeScanPage(worktree, base, {
            afterSubtree,
            filesOnly: options.filesOnly,
            limit: WORKTREE_SCAN_PAGE,
          });
    const entries = read.page;
    afterSubtree = undefined;
    if (entries.length === 0) return;

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry === undefined) continue;
      if (options.maxScanRows !== undefined && scannedRows >= options.maxScanRows) {
        throw new GitError("E2BIG", `worktree scan exceeds ${options.maxScanRows} rows`);
      }
      scannedRows++;
      after = entry.path;

      while (
        pruned.length > 0 &&
        comparePaths(entry.path, pruned[pruned.length - 1]?.upper ?? "") >= 0
      ) {
        pruned.pop();
      }
      const active = pruned[pruned.length - 1];
      if (active !== undefined && comparePaths(entry.path, active.lower) >= 0) continue;

      const relative = relativeTo(base, entry.path);
      if (relative === null) continue;

      if (excluded.has(entry.path)) {
        if (entry.type === "dir") {
          retainPrunedRange(pruned, entry.path);
        }
        continue;
      }

      if (entry.type === "dir") {
        const outsidePathspec = !pathspec.includesDirectory(relative);
        // git never descends into an ignored directory, which is also why a
        // re-include below one cannot take effect.
        const ignored =
          options.includeIgnored !== true && options.ignores?.ignores(relative, true) === true;
        if (outsidePathspec || ignored || options.pruneDirectory?.(relative) === true) {
          retainPrunedRange(pruned, entry.path);
          continue;
        }
        if (options.includeDirectories === true) {
          yield { path: relative, stat: statFromScan(entry) };
        }
        continue;
      }

      if (!pathspec.matchesEntry(relative)) continue;
      if (options.includeIgnored !== true && options.ignores?.ignores(relative, false) === true) {
        continue;
      }
      yield { path: relative, stat: statFromScan(entry) };
    }

    if (entries.length < WORKTREE_SCAN_PAGE) return;

    const active = pruned[pruned.length - 1];
    const last = entries[entries.length - 1];
    if (
      active !== undefined &&
      last !== undefined &&
      comparePaths(last.path, active.lower) >= 0 &&
      comparePaths(last.path, active.upper) < 0
    ) {
      after = undefined;
      afterSubtree = active.directory;
      pruned.pop();
    }
  }
}

function retainPrunedRange(
  ranges: Array<{ directory: string; lower: string; upper: string }>,
  path: string,
): void {
  ranges.push(prunedRange(path));
}

export function statFromScan(entry: ScanEntry): WorktreeStat {
  return {
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    mtime: entry.mtime,
    ino: entry.ino,
    nlink: entry.nlink,
    rev: entry.rev,
    target: entry.target,
    contentId: entry.contentId,
  };
}

function prunedRange(directory: string): { directory: string; lower: string; upper: string } {
  return {
    directory,
    lower: `${directory}/`,
    upper: subtreeSuccessor(directory),
  };
}

export function readWorktreeRealpath(worktree: Worktree, path: string): RealPath {
  return nativeRealpathOwned(worktree, path) ?? worktree.realpath(path);
}

export function readWorktreeScanPage(
  worktree: Worktree,
  root: RealPath,
  options: ScanOptions,
): { page: ScanEntry[] } {
  return { page: nativeScanOwned(worktree, root, options) ?? worktree.scan(root, options) };
}
