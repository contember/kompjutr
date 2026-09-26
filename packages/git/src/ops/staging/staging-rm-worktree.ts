import { GitError } from "../../common/errors.js";
import { comparePaths, joinPath, relativeExcludeRoots } from "../../common/paths.js";
import { joinSorted } from "../../common/streams.js";
import type { IndexEntry } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  hashExactWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
} from "../worktree/worktree-io.js";

const RM_MAX_ROWS_PER_STREAM = 50_000;
const RM_MAX_DIRECTORIES = 10_000;
const RM_WINDOW_ROWS = 1_000;
const RM_REMOVE_BINDING_BYTES = 1_000_000;

export interface RmCandidate {
  path: string;
  head: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
  conflicted: boolean;
  worktreeMatchesIndex: boolean;
}

export function* boundedRmRows<T>(rows: Iterable<T>, label: string): Generator<T> {
  let count = 0;
  for (const row of rows) {
    if (count >= RM_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `rm ${label} scan exceeds ${RM_MAX_ROWS_PER_STREAM} rows`);
    }
    count++;
    yield row;
  }
}

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
    const hashes = hashExactWorktreePaths(repo, worktree, authoritative, {
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
  selectedPaths: () => Generator<string>,
  excludeRoots: readonly string[] | undefined,
): string[] {
  const directories = new Set<string>();
  for (const path of selectedPaths()) {
    const parts = path.split("/");
    for (let depth = parts.length - 1; depth > 0; depth--) {
      const directory = parts.slice(0, depth).join("/");
      if (directories.has(directory)) continue;
      if (directories.size >= RM_MAX_DIRECTORIES) {
        throw new GitError("E2BIG", `rm directory prune exceeds ${RM_MAX_DIRECTORIES} directories`);
      }
      directories.add(directory);
    }
  }
  if (directories.size === 0) return [];

  const blocked = new Set<string>();
  const block = (path: string, includeSelf: boolean): void => {
    const parts = path.split("/");
    let depth = includeSelf ? parts.length : parts.length - 1;
    for (; depth > 0; depth--) {
      const directory = parts.slice(0, depth).join("/");
      if (!directories.has(directory) || blocked.has(directory)) continue;
      blocked.add(directory);
    }
  };

  for (const root of relativeExcludeRoots(repo.root, excludeRoots)) block(root, true);
  for (const row of joinSorted(
    selectedPaths(),
    boundedRmRows(
      walkWorktreeEntriesStream(worktree, repo.root, {
        excludeRoots: excludeRoots === undefined ? undefined : [...excludeRoots],
        includeIgnored: true,
        includeDirectories: true,
      }),
      "directory-prune worktree",
    ),
    { left: (path) => path, right: (entry) => entry.path },
  )) {
    const entry = row.right;
    if (entry === undefined) continue;
    if (row.left !== undefined && entry.stat.type !== "dir") continue;
    if (entry.stat.type === "dir" && directories.has(entry.path)) continue;
    block(entry.path, entry.stat.type === "dir");
  }

  const pruned: string[] = [];
  for (const directory of directories) {
    if (blocked.has(directory)) continue;
    pruned.push(directory);
  }
  pruned.sort((left, right) => {
    const depth = pathDepth(right) - pathDepth(left);
    return depth === 0 ? comparePaths(left, right) : depth;
  });
  return pruned;
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
  worktree: Worktree,
  selectedPages: Iterable<readonly string[]>,
  excludeRoots: readonly string[] | undefined,
): Generator<string> {
  const entries = boundedRmRows(
    walkWorktreeEntriesStream(worktree, repo.root, {
      excludeRoots: excludeRoots === undefined ? undefined : [...excludeRoots],
      includeIgnored: true,
      includeDirectories: true,
    }),
    "removal worktree",
  )[Symbol.iterator]();
  let current = entries.next();
  try {
    for (const page of selectedPages) {
      for (const path of page) {
        while (!current.done && comparePaths(current.value.path, path) < 0) {
          current = entries.next();
        }
        if (!current.done && current.value.path === path) yield joinPath(repo.root, path);
      }
    }
  } finally {
    entries.return?.(undefined);
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
