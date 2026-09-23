import type { ScanEntry } from "@kompjutr/drive";
import { CorruptError, GitError } from "../../common/errors.js";
import { joinPath, relativeTo } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import type { IgnoreMatcher } from "../../ignore/index.js";
import type { Worktree, WorktreeStat } from "./worktree.js";
import { type CompiledPathspecMatcher, compilePathspecs } from "./worktree-io-pathspec.js";

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
 * Bound: the drive's scan window of metadata.
 */
export function* walkWorktreeStream(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
): Generator<string> {
  for (const entry of walkWorktreeEntriesStream(worktree, root, options)) yield entry.path;
}

/** The metadata-preserving worktree walk over bounded scan pages. */
export function* walkWorktreeEntriesStream(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
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
  const base = worktree.realpath(lexicalRoot);
  const excluded = new Set<string>();
  const prunedDirectories = new Set<string>();
  const pathspec = options.pathspec ?? compilePathspecs(options.paths);
  let scannedRows = 0;

  for (const path of options.excludeRoots ?? []) {
    const relative = relativeTo(lexicalRoot, path);
    const excludedPath = relative === null ? path.replace(/\/+$/, "") : joinPath(base, relative);
    excluded.add(excludedPath);
  }
  for (const entry of strictlyOrderedScan(
    worktree.scanStream(base, {
      filesOnly: options.filesOnly,
      pruneDirectory: (path) => prunedDirectories.delete(path),
    }),
  )) {
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
      // git never descends into an ignored directory, which is also why a
      // re-include below one cannot take effect.
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
}

/**
 * Every merge join over a drive scan assumes strict `comparePaths` order; a
 * repeated or backward row would silently corrupt the join or never end.
 */
export function* strictlyOrderedScan(entries: Iterable<ScanEntry>): Generator<ScanEntry> {
  let previous: string | undefined;
  for (const entry of entries) {
    if (previous !== undefined && comparePaths(entry.path, previous) <= 0) {
      throw new CorruptError(`worktree scan is not strictly ordered at ${entry.path}`);
    }
    previous = entry.path;
    yield entry;
  }
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
