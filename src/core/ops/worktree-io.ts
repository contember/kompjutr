// The bridge between the working tree and the object database: walking it,
// hashing what is in it, and describing an index row for a path.
//
// FROZEN SEAM: status, staging, diff, commit and clean all go through
// these. Nothing here knows about Computer or DOFS — only the `Worktree`
// interface.

import type { IndexEntry } from "../../sqlite/store.js";
import { toHex, utf8 } from "../bytes.js";
import type { IgnoreMatcher } from "../ignore/index.js";
import { hashObject, objectHeader } from "../objects.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { Sha1 } from "../sha1.js";
import { comparePaths } from "../streams.js";
import { gitModeFor, type Worktree, type WorktreeStat } from "../worktree.js";

/** Bytes pulled from the working tree at a time when a file is streamed. */
const READ_CHUNK = 64 * 1024;

/**
 * Below this, a file is read in one go. Streaming costs a second pass over
 * the content — the hash pass and the store pass — which is a bad trade for
 * a file that was never going to strain anything.
 */
const STREAM_ABOVE = 512 * 1024;

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
  return [...walkWorktreeStream(worktree, root, options)];
}

/**
 * The same walk, lazily and already in `comparePaths` order, so it can be
 * merged against the index and a tree without a sort.
 *
 * Siblings are ordered the way git orders tree entries — a directory compares
 * as `name/` — because that, not the bare name, is what makes the emitted full
 * paths ascend. `a.txt` really does sort before `a/x`, since "." is 0x2E and
 * "/" is 0x2F.
 *
 * Bound: O(sum of the widths of the directories currently open).
 */
export function* walkWorktreeStream(
  worktree: Worktree,
  root: string,
  options: WalkOptions = {},
): Generator<string> {
  const base = root.replace(/\/+$/, "") || "/";
  const excluded = new Set((options.excludeRoots ?? []).map((path) => path.replace(/\/+$/, "")));
  yield* walkDirectory(worktree, base, base, excluded, options);
}

function* walkDirectory(
  worktree: Worktree,
  root: string,
  directory: string,
  excluded: Set<string>,
  options: WalkOptions,
): Generator<string> {
  const entries = worktree.readdir(directory);
  entries.sort((left, right) =>
    comparePaths(sortKey(left.name, left.type), sortKey(right.name, right.type)),
  );

  for (const entry of entries) {
    const absolute = joinPath(directory, entry.name);
    if (excluded.has(absolute)) continue;
    const relative = relativeTo(root, absolute);
    if (relative === null) continue;
    if (entry.type === "dir") {
      if (!withinPathspec(relative, options.paths, true)) continue;
      // git never descends into an ignored directory, which is also why a
      // re-include below one cannot take effect.
      if (options.includeIgnored !== true && options.ignores?.ignores(relative, true) === true) {
        continue;
      }
      yield* walkDirectory(worktree, root, absolute, excluded, options);
      continue;
    }
    if (!withinPathspec(relative, options.paths, false)) continue;
    if (options.includeIgnored !== true && options.ignores?.ignores(relative, false) === true) {
      continue;
    }
    yield relative;
  }
}

/** git's tree-entry rule: a directory sorts as though its name ended in "/". */
function sortKey(name: string, type: string): string {
  return type === "dir" ? `${name}/` : name;
}

/**
 * Pathspec matching for the walk. A directory is kept when it could still
 * contain a match; a file only when it matches outright.
 */
function withinPathspec(
  relative: string,
  paths: string[] | undefined,
  isDirectory: boolean,
): boolean {
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
export function worktreeBytes(
  worktree: Worktree,
  absolute: string,
  stat: WorktreeStat,
): Uint8Array {
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
  if (stat === null || stat.type === "dir") return null;
  if (stat.type !== "symlink" && stat.size > STREAM_ABOVE) {
    return hashLargeFile(repo, worktree, absolute, stat, options);
  }
  const bytes = worktreeBytes(worktree, absolute, stat);
  const oid = options.write === false ? hashObject("blob", bytes) : repo.store.write("blob", bytes);
  return { oid, mode: gitModeFor(stat), stat };
}

/** Hash, and optionally store, without ever holding the whole file. */
function hashLargeFile(
  repo: Repository,
  worktree: Worktree,
  absolute: string,
  stat: WorktreeStat,
  options: { write?: boolean },
): HashedPath {
  const chunks = function* (): Generator<Uint8Array> {
    for (let offset = 0; offset < stat.size; offset += READ_CHUNK) {
      const chunk = worktree.readRange(absolute, offset, Math.min(READ_CHUNK, stat.size - offset));
      if (chunk.length === 0) break;
      yield chunk;
    }
  };
  if (options.write === false) {
    const hash = new Sha1().update(objectHeader("blob", stat.size));
    for (const chunk of chunks()) hash.update(chunk);
    return { oid: toHex(hash.digest()), mode: gitModeFor(stat), stat };
  }
  return {
    oid: repo.store.writeStream("blob", stat.size, chunks),
    mode: gitModeFor(stat),
    stat,
  };
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
  return [...dirtyPathStream(repo, worktree, paths)];
}

/** The same comparison, lazily, over a paged index scan. */
export function* dirtyPathStream(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
): Generator<string> {
  for (const entry of repo.store.indexScan()) {
    if (entry.stage !== 0) continue;
    if (paths !== undefined && !withinPathspec(entry.path, paths, false)) continue;
    const absolute = joinPath(repo.root, entry.path);
    const stat = worktree.stat(absolute);
    if (stat === null) {
      yield entry.path;
      continue;
    }
    if (indexMatchesStat(entry, stat)) continue;
    const hashed = hashWorktreePath(repo, worktree, entry.path, { write: false });
    if (hashed === null || hashed.oid !== entry.oid) yield entry.path;
  }
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
