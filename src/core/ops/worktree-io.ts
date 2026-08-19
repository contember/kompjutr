// The bridge between the working tree and the object database: walking it,
// hashing what is in it, and describing an index row for a path.
//
// FROZEN SEAM: status, staging, diff, commit and clean all go through
// these. Nothing here knows about Computer or DOFS — only the `Worktree`
// interface.

import { utf8 } from "../bytes.js";
import type { IgnoreMatcher } from "../ignore/index.js";
import { hashObject } from "../objects.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { gitModeFor, type Worktree, type WorktreeStat } from "../worktree.js";
import type { IndexEntry } from "../../sqlite/store.js";

export interface WalkOptions {
  /**
   * Absolute paths that are the root of a *different* registered
   * repository. A nested repository's files belong to it, not to this one.
   */
  excludeRoots?: string[];
  /** Restrict the walk to these repo-relative path prefixes. */
  paths?: string[];
  /** Skip ignored paths, and do not descend into ignored directories. */
  ignores?: IgnoreMatcher;
  /** Return ignored paths too, marked, instead of skipping them. */
  includeIgnored?: boolean;
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
  const excluded = new Set((options.excludeRoots ?? []).map((path) => path.replace(/\/+$/, "")));
  const out: string[] = [];
  const stack: string[] = [root.replace(/\/+$/, "") || "/"];

  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of worktree.readdir(directory)) {
      const absolute = joinPath(directory, entry.name);
      if (excluded.has(absolute)) continue;
      const relative = relativeTo(root, absolute);
      if (relative === null) continue;
      if (entry.type === "directory") {
        if (!withinPathspec(relative, options.paths, true)) continue;
        // git never descends into an ignored directory, which is also why
        // a re-include below one cannot take effect.
        if (options.includeIgnored !== true && options.ignores?.ignores(relative, true) === true) {
          continue;
        }
        stack.push(absolute);
        continue;
      }
      if (!withinPathspec(relative, options.paths, false)) continue;
      if (options.includeIgnored !== true && options.ignores?.ignores(relative, false) === true) {
        continue;
      }
      out.push(relative);
    }
  }
  return out.sort();
}

/**
 * Pathspec matching for the walk. A directory is kept when it could still
 * contain a match; a file only when it matches outright.
 */
function withinPathspec(relative: string, paths: string[] | undefined, isDirectory: boolean): boolean {
  if (paths === undefined || paths.length === 0) return true;
  for (const raw of paths) {
    const spec = raw.replace(/\/+$/, "");
    if (spec === "" || spec === ".") return true;
    if (relative === spec) return true;
    if (relative.startsWith(`${spec}/`)) return true;
    if (isDirectory && spec.startsWith(`${relative}/`)) return true;
  }
  return false;
}

/** The bytes git would hash for a working-tree path: a symlink hashes its target. */
export function worktreeBytes(worktree: Worktree, absolute: string, stat: WorktreeStat): Uint8Array {
  return stat.type === "symlink"
    ? utf8.encode(worktree.readlink(absolute))
    : worktree.readFile(absolute);
}

export interface HashedPath {
  oid: string;
  /** Git tree mode: "100644", "100755" or "120000". */
  mode: string;
  stat: WorktreeStat;
}

/**
 * Hash the working-tree file at `relative`, writing the blob into the
 * object database unless `write` is false. Returns null when the path is
 * absent or is a directory.
 */
export function hashWorktreePath(
  repo: Repository,
  worktree: Worktree,
  relative: string,
  options: { write?: boolean } = {},
): HashedPath | null {
  const absolute = joinPath(repo.root, relative);
  const stat = worktree.stat(absolute);
  if (stat === null || stat.type === "directory") return null;
  const bytes = worktreeBytes(worktree, absolute, stat);
  const oid =
    options.write === false ? hashObject("blob", bytes) : repo.store.write("blob", bytes);
  return { oid, mode: gitModeFor(stat), stat };
}

/**
 * Tracked paths whose working-tree content no longer matches the index.
 * A path recorded in the index but missing from disk counts as dirty.
 *
 * This is the worktree-vs-index half of `status`, kept here because
 * `checkout` needs it to refuse to overwrite local changes without ever
 * pulling in HEAD comparison.
 */
export function dirtyPaths(repo: Repository, worktree: Worktree, paths?: string[]): string[] {
  const out: string[] = [];
  for (const entry of repo.store.indexEntries()) {
    if (entry.stage !== 0) continue;
    if (paths !== undefined && !withinPathspec(entry.path, paths, false)) continue;
    const absolute = joinPath(repo.root, entry.path);
    const stat = worktree.stat(absolute);
    if (stat === null) {
      out.push(entry.path);
      continue;
    }
    if (indexMatchesStat(entry, stat)) continue;
    const hashed = hashWorktreePath(repo, worktree, entry.path, { write: false });
    if (hashed === null || hashed.oid !== entry.oid) out.push(entry.path);
  }
  return out;
}

/** An index row describing `relative` as it currently exists on disk. */
export function indexEntryFor(relative: string, hashed: HashedPath): IndexEntry {
  return {
    path: relative,
    stage: 0,
    mode: Number.parseInt(hashed.mode, 8),
    oid: hashed.oid,
    size: hashed.stat.size,
    mtime: hashed.stat.mtime,
    ino: hashed.stat.ino,
  };
}

/**
 * Can this index entry be trusted without re-reading the file? True when
 * the working-tree facts recorded at staging time still hold.
 *
 * This is the whole point of caching stat data in `git_index`: a repeated
 * `status` over an untouched tree does no hashing at all.
 */
export function indexMatchesStat(entry: IndexEntry, stat: WorktreeStat): boolean {
  if (entry.size === null || entry.mtime === null) return false;
  if (entry.size !== stat.size || entry.mtime !== stat.mtime) return false;
  if (entry.ino !== null && stat.ino !== 0 && entry.ino !== stat.ino) return false;
  return entry.mode === Number.parseInt(gitModeFor(stat), 8);
}
