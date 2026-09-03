import { GitError } from "../../common/errors.js";
import { joinPath, relativeTo } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../../ignore/index.js";
import { matchesPaths } from "../checkout/checkout.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktree } from "../worktree/worktree-io.js";
import { statusStream } from "./status-core.js";
import { excludedRoots, isExcluded } from "./status-full.js";
import { stagedIndex } from "./status-matrix.js";
import type { StatusOptions } from "./status-rows.js";
import {
  type CleanOptions,
  DIRECTORY_FIXED_BYTES,
  STATUS_RETAINED_BYTES,
  STATUS_WINDOW_ROWS,
  statusStringBytes,
} from "./status-types.js";

// -- clean -------------------------------------------------------------

/**
 * Remove untracked paths, returning them as git's `clean -n` names them:
 * a directory removed whole keeps its trailing slash.
 *
 * Ignored files are never touched, and a directory holding one is not
 * removed whole — its untracked contents are removed around it, which is
 * what `git clean -d` does.
 */
export function clean(repo: Repository, worktree: Worktree, options: CleanOptions = {}): string[] {
  const index = stagedIndex(repo);
  const ignores = options.ignores ?? loadIgnoreMatcher(worktree, repo.root);
  const statusOptions: StatusOptions = {
    paths: options.paths,
    excludeRoots: options.excludeRoots,
    ignores,
    renames: false,
  };
  const collapsed = untrackedEntries(repo, worktree, statusOptions);
  if (options.directories !== true) {
    const files = collapsed.filter((entry) => !entry.endsWith("/"));
    return removeAll(repo, worktree, files, options);
  }

  const snapshot = snapshotCleanWorktree(repo, worktree, options, ignores);
  const visible = new Set<string>(snapshot.visible);
  const ignored = snapshot.ignored;
  const untracked = [...visible].filter((path) => !index.has(path));
  const directories = cleanableDirectories(snapshot.directories, [
    ...index.keys(),
    ...ignored,
    ...snapshot.protectedDirectories,
  ]);
  const entries = minimalCleanEntries([
    ...collapsed.flatMap((entry) => expandAroundIgnored(entry, untracked, ignored)),
    ...directories.map((path) => `${path}/`),
  ]);
  return removeAll(repo, worktree, entries, options);
}

/** The untracked half of `status`, which is what `clean` acts on. */
function untrackedEntries(repo: Repository, worktree: Worktree, options: StatusOptions): string[] {
  const out: string[] = [];
  for (const row of statusStream(repo, worktree, options)) {
    if (row.worktree === "?") out.push(row.path);
  }
  return out.sort(comparePaths);
}

/**
 * A directory that holds an ignored file cannot go as a unit, so replace
 * it with the entries one level down and try again there.
 */
function expandAroundIgnored(entry: string, untracked: string[], ignored: string[]): string[] {
  if (!entry.endsWith("/")) return [entry];
  const prefix = entry;
  if (!ignored.some((path) => path.startsWith(prefix))) return [entry];
  const children = new Set<string>();
  for (const path of untracked) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    children.add(slash === -1 ? path : `${prefix}${rest.slice(0, slash)}/`);
  }
  return [...children].flatMap((child) => expandAroundIgnored(child, untracked, ignored));
}

interface CleanWorktreeSnapshot {
  visible: string[];
  ignored: string[];
  directories: string[];
  protectedDirectories: string[];
}

/** Classify files and otherwise invisible empty directories in one paged traversal. */
function snapshotCleanWorktree(
  repo: Repository,
  worktree: Worktree,
  options: CleanOptions,
  ignores: IgnoreMatcher,
): CleanWorktreeSnapshot {
  const excluded = excludedRoots(repo.root, options.excludeRoots);
  const visible: string[] = [];
  const ignored: string[] = [];
  const directories: string[] = [];
  const protectedDirectories = excluded.map((root) => root.relative);
  let retainedBytes = 0;
  const retain = (path: string): void => {
    retainedBytes += DIRECTORY_FIXED_BYTES + statusStringBytes(path);
    if (retainedBytes > STATUS_RETAINED_BYTES) {
      throw new GitError("E2BIG", `clean retained state exceeds ${STATUS_RETAINED_BYTES} bytes`);
    }
  };
  for (const path of protectedDirectories) retain(path);

  const root = worktree.realpath(repo.root);
  let ignoredRoot: string | null = null;
  let after: string | undefined;
  while (true) {
    const page = worktree.scan(root, { after, limit: STATUS_WINDOW_ROWS });
    if (page.length === 0) break;
    for (const entry of page) {
      const path = relativeTo(root, entry.path);
      if (path === null || path === "") continue;
      if (ignoredRoot !== null && !path.startsWith(`${ignoredRoot}/`)) ignoredRoot = null;
      if (isExcluded(path, excluded)) continue;
      if (entry.type === "dir") {
        if (ignoredRoot !== null) continue;
        if (ignores.ignores(path, true)) {
          retain(path);
          ignored.push(path);
          protectedDirectories.push(path);
          ignoredRoot = path;
          continue;
        }
        if (!matchesPaths(path, options.paths)) continue;
        retain(path);
        directories.push(path);
        continue;
      }
      if (ignoredRoot !== null || !matchesPaths(path, options.paths)) continue;
      retain(path);
      if (ignores.ignores(path, false)) ignored.push(path);
      else visible.push(path);
    }
    const tail = page[page.length - 1];
    if (tail === undefined || page.length < STATUS_WINDOW_ROWS) break;
    after = tail.path;
  }
  return { visible, ignored, directories, protectedDirectories };
}

/** Include empty directories that status cannot report because Git tracks no directories. */
function cleanableDirectories(directories: string[], protectedPaths: string[]): string[] {
  const protectedDirectories = new Set<string>();
  let retainedBytes = 0;
  const protect = (path: string): void => {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      const directory = path.slice(0, slash);
      if (protectedDirectories.has(directory)) continue;
      retainedBytes += DIRECTORY_FIXED_BYTES + statusStringBytes(directory);
      if (retainedBytes > STATUS_RETAINED_BYTES) {
        throw new GitError("E2BIG", `clean retained state exceeds ${STATUS_RETAINED_BYTES} bytes`);
      }
      protectedDirectories.add(directory);
    }
    if (!protectedDirectories.has(path)) {
      retainedBytes += DIRECTORY_FIXED_BYTES + statusStringBytes(path);
      if (retainedBytes > STATUS_RETAINED_BYTES) {
        throw new GitError("E2BIG", `clean retained state exceeds ${STATUS_RETAINED_BYTES} bytes`);
      }
      protectedDirectories.add(path);
    }
  };
  for (const path of protectedPaths) protect(path);
  return directories.filter((path) => !protectedDirectories.has(path));
}

function minimalCleanEntries(entries: string[]): string[] {
  const sorted = entries.sort(comparePaths);
  const out: string[] = [];
  let directory: string | null = null;
  for (const entry of sorted) {
    if (directory !== null && entry.startsWith(directory)) continue;
    const previous = out[out.length - 1];
    if (entry === previous) continue;
    out.push(entry);
    directory = entry.endsWith("/") ? entry : null;
  }
  return out;
}

function removeAll(
  repo: Repository,
  worktree: Worktree,
  entries: string[],
  options: CleanOptions,
): string[] {
  if (options.dryRun === true) return entries;
  for (const entry of entries) {
    if (entry.endsWith("/")) removeDirectory(repo, worktree, stripSlash(entry));
    else worktree.unlink(joinPath(repo.root, entry));
  }
  return entries;
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function removeDirectory(repo: Repository, worktree: Worktree, directory: string): void {
  const contents = walkWorktree(worktree, repo.root, {
    paths: [directory],
    includeIgnored: true,
  });
  const directories = new Set<string>([directory]);
  const rootDepth = directory.split("/").length;
  for (const path of contents) {
    worktree.unlink(joinPath(repo.root, path));
    const parts = path.split("/");
    for (let depth = rootDepth; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  const deepestFirst = [...directories].sort((a, b) => {
    const depth = b.split("/").length - a.split("/").length;
    return depth === 0 ? comparePaths(a, b) : depth;
  });
  for (const path of deepestFirst) worktree.rmdir(joinPath(repo.root, path));
}
