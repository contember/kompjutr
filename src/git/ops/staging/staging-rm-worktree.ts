import { GitError } from "../../common/errors.js";
import { comparePaths, joinPath } from "../../common/paths.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  hashExactWorktreePathsOwned,
  indexMatchesStat,
  walkWorktreeEntriesStreamOwned,
} from "../worktree/worktree-io.js";
import {
  boundedRmRows,
  relativeExcludeRoots,
  requireRmRetained,
  structuralStringBytes,
} from "./staging-rm-support.js";
import type { RmCandidate } from "./staging-rm-types.js";
import {
  RM_ARRAY_ENTRY_BYTES,
  RM_DIRECTORY_FIXED_BYTES,
  RM_REMOVE_BINDING_BYTES,
  RM_WINDOW_ROWS,
} from "./staging-rm-types.js";

export function identifyRmWorktree(
  repo: Repository,
  worktree: Worktree,
  candidates: RmCandidate[],
): void {
  for (let offset = 0; offset < candidates.length; offset += RM_WINDOW_ROWS) {
    const batch = candidates.slice(offset, offset + RM_WINDOW_ROWS);
    const pending = batch.filter(
      (candidate) =>
        !candidate.conflicted &&
        candidate.index !== undefined &&
        candidate.worktree !== undefined &&
        candidate.worktree.stat.type !== "dir" &&
        !indexMatchesStat(candidate.index, candidate.worktree.stat),
    );
    for (const candidate of batch) {
      if (
        !candidate.conflicted &&
        candidate.index !== undefined &&
        candidate.worktree !== undefined &&
        candidate.worktree.stat.type !== "dir" &&
        indexMatchesStat(candidate.index, candidate.worktree.stat)
      ) {
        candidate.worktreeMatchesIndex = true;
      }
    }
    if (pending.length === 0) continue;

    const authoritative = pending.flatMap((candidate) =>
      candidate.worktree === undefined ? [] : [candidate.worktree],
    );
    const hashes = hashExactWorktreePathsOwned(repo, worktree, authoritative, {
      write: false,
    });
    for (const candidate of pending) {
      const entry = candidate.index;
      const hashed = hashes.get(candidate.path);
      if (
        entry !== undefined &&
        hashed !== undefined &&
        hashed.oid === entry.oid &&
        Number.parseInt(hashed.mode, 8) === entry.mode
      ) {
        candidate.worktreeMatchesIndex = true;
      }
    }
  }
}

export function planRmDirectoryPrune(
  repo: Repository,
  worktree: Worktree,
  candidates: readonly RmCandidate[],
  removed: ReadonlySet<string>,
  excludeRoots: readonly string[] | undefined,
  initialRetained: number,
): { directories: string[]; retained: number } {
  const directories = new Set<string>();
  let retained = initialRetained;
  for (const { path } of candidates) {
    const parts = path.split("/");
    for (let depth = parts.length - 1; depth > 0; depth--) {
      const directory = parts.slice(0, depth).join("/");
      if (directories.has(directory)) continue;
      retained += RM_DIRECTORY_FIXED_BYTES + structuralStringBytes(directory);
      requireRmRetained(retained);
      directories.add(directory);
    }
  }
  if (directories.size === 0) return { directories: [], retained };

  const blocked = new Set<string>();
  const block = (path: string, includeSelf: boolean): void => {
    const parts = path.split("/");
    let depth = includeSelf ? parts.length : parts.length - 1;
    for (; depth > 0; depth--) {
      const directory = parts.slice(0, depth).join("/");
      if (!directories.has(directory) || blocked.has(directory)) continue;
      retained += RM_DIRECTORY_FIXED_BYTES;
      requireRmRetained(retained);
      blocked.add(directory);
    }
  };

  for (const root of relativeExcludeRoots(repo.root, excludeRoots)) block(root, true);
  for (const entry of boundedRmRows(
    walkWorktreeEntriesStreamOwned(worktree, repo.root, {
      excludeRoots: excludeRoots === undefined ? undefined : [...excludeRoots],
      includeIgnored: true,
      includeDirectories: true,
    }),
    "directory-prune worktree",
  )) {
    if (removed.has(entry.path) && entry.stat.type !== "dir") continue;
    if (entry.stat.type === "dir" && directories.has(entry.path)) continue;
    block(entry.path, entry.stat.type === "dir");
  }

  const pruned: string[] = [];
  for (const directory of directories) {
    if (blocked.has(directory)) continue;
    retained += RM_ARRAY_ENTRY_BYTES;
    requireRmRetained(retained);
    pruned.push(directory);
  }
  pruned.sort((left, right) => {
    const depth = pathDepth(right) - pathDepth(left);
    return depth === 0 ? comparePaths(left, right) : depth;
  });
  return { directories: pruned, retained };
}

function pathDepth(path: string): number {
  let depth = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) depth++;
  }
  return depth;
}

export function* physicalRmPaths(
  repo: Repository,
  candidates: readonly RmCandidate[],
): Generator<string> {
  for (const candidate of candidates) {
    if (candidate.worktree === undefined) continue;
    yield joinPath(repo.root, candidate.path);
  }
}

export function* absoluteRmPaths(repo: Repository, paths: readonly string[]): Generator<string> {
  for (const path of paths) yield joinPath(repo.root, path);
}

export function removeRmWorktreePaths(
  worktree: Worktree,
  paths: Iterable<string>,
  recursive: boolean,
): void {
  let batch: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (batch.length === 0) return;
    worktree.removeFiles(batch, { force: true, recursive });
    batch = [];
    bytes = 2;
  };
  for (const path of paths) {
    const itemBytes = jsonStringUtf8Length(path);
    if (batch.length > 0 && bytes + itemBytes + 1 > RM_REMOVE_BINDING_BYTES) flush();
    batch.push(path);
    bytes += itemBytes + 1;
  }
  flush();
}

function jsonStringUtf8Length(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    )
      bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit <= 0x7f) bytes++;
    else if (unit <= 0x7ff) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index++;
    } else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) {
      throw new GitError("E2BIG", "rm filesystem binding size overflows");
    }
  }
  return bytes;
}
