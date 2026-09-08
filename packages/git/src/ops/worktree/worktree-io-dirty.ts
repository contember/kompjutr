import type { RealPath, ScanEntry } from "@kompjutr/drive";
import { toHex } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { joinPath, relativeTo } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import { type IndexEntry, indexScanOwned } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import { gitModeFor, type Worktree } from "./worktree.js";
import {
  createWorktreeHashCursor,
  hashWorktreePathsAtRoot,
  indexMatchesStat,
  refreshPaths,
} from "./worktree-io-hash.js";
import { compilePathspecsOwned } from "./worktree-io-pathspec.js";
import {
  readWorktreeRealpath,
  readWorktreeScanPage,
  statFromScan,
  WORKTREE_SCAN_PAGE,
  type WorktreePath,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io-walk.js";

const DIRTY_EXCLUDED_SCAN_ROWS = 100_000;
const HASH_BATCH = 1000;

/**
 * Tracked paths whose working-tree content no longer matches the index.
 * A path recorded in the index but missing from disk counts as dirty.
 *
 * This is the worktree-vs-index half of `status`, kept here because
 * `checkout` needs it to refuse to overwrite local changes without ever
 * pulling in HEAD comparison.
 */
export interface DirtyPathLimits {
  maxIndexRows: number;
  indexRows: number;
  maxWorktreeRows: number;
  worktreeRows: number;
  maxHashCandidates: number;
  hashCandidates: number;
}

export function dirtyPaths(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
  limits?: DirtyPathLimits,
): string[] {
  return [...dirtyPathStream(repo, worktree, paths, limits)];
}

/** The same comparison, lazily, over a paged index scan. */
export function* dirtyPathStream(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
  limits?: DirtyPathLimits,
  excludeRoots: string[] = [],
): Generator<string> {
  yield* dirtyPathStreamOwned(repo, worktree, paths, limits, excludeRoots);
}

/** Internal dirty-path scan seam. */
export function* dirtyPathStreamOwned(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
  limits?: DirtyPathLimits,
  excludeRoots: string[] = [],
): Generator<string> {
  if (worktree.scanStream === undefined) {
    yield* dirtyPathStreamPagedOwned(repo, worktree, paths, limits, excludeRoots);
    return;
  }
  yield* dirtyPathStreamOrderedOwned(repo, worktree, paths, limits, excludeRoots);
}

function* dirtyPathStreamOrderedOwned(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
  limits?: DirtyPathLimits,
  excludeRoots: string[] = [],
): Generator<string> {
  const pathspec = compilePathspecsOwned(paths);
  const excluded: string[] = [];
  let root: RealPath | null = null;
  let scanned: Generator<WorktreePath> | null = null;
  let current: IteratorResult<WorktreePath, void> | null = null;
  const pending: { index: IndexEntry; path: WorktreePath }[] = [];
  const refreshStreamFactory = worktree.scanStream;
  let refreshIterator: Iterator<ScanEntry> | null = null;
  let refreshCurrent: IteratorResult<ScanEntry, void> | null = null;

  const refreshStreamed = (paths: readonly WorktreePath[]): WorktreePath[] => {
    const canonicalRoot = root;
    if (canonicalRoot === null || refreshStreamFactory === undefined) return [];
    if (refreshIterator === null) {
      const canonicalExcluded = excluded.map((path) => joinPath(canonicalRoot, path));
      refreshIterator = refreshStreamFactory
        .call(worktree, canonicalRoot, {
          filesOnly: true,
          pruneDirectory: (path) =>
            canonicalExcluded.some(
              (excludedRoot) => path === excludedRoot || path.startsWith(`${excludedRoot}/`),
            ),
        })
        [Symbol.iterator]();
      refreshCurrent = refreshIterator.next();
    }
    if (refreshCurrent === null) throw new Error("worktree refresh stream has no cursor");
    const refreshed: WorktreePath[] = [];
    for (const candidate of paths) {
      const absolute = joinPath(canonicalRoot, candidate.path);
      while (
        refreshCurrent.done !== true &&
        comparePaths(refreshCurrent.value.path, absolute) < 0
      ) {
        refreshCurrent = refreshIterator.next();
      }
      if (refreshCurrent.done !== true && refreshCurrent.value.path === absolute) {
        refreshed.push({ path: candidate.path, stat: statFromScan(refreshCurrent.value) });
        refreshCurrent = refreshIterator.next();
      }
    }
    return refreshed;
  };

  const flush = function* (): Generator<string> {
    if (pending.length === 0) return;
    if (root === null) throw new Error("dirty path scan has no canonical root");
    const batch = pending.splice(0);
    let dirty: Set<string>;
    const candidates = batch.map((candidate) => candidate.path);
    const refreshed = refreshStreamed(candidates);
    const current = new Map(refreshed.map((candidate) => [candidate.path, candidate]));
    const expected = new Map(batch.map((candidate) => [candidate.index.path, candidate.index]));
    const needsHash: WorktreePath[] = [];
    dirty = new Set<string>();

    for (const candidate of batch) {
      const found = current.get(candidate.index.path);
      if (found === undefined) {
        dirty.add(candidate.index.path);
        continue;
      }
      const modeMatches = candidate.index.mode === Number.parseInt(gitModeFor(found.stat), 8);
      if (!modeMatches) {
        dirty.add(candidate.index.path);
        continue;
      }
      if (found.stat.contentId !== null && toHex(found.stat.contentId) === candidate.index.oid) {
        continue;
      }
      if (indexMatchesStat(candidate.index, found.stat)) continue;
      needsHash.push(found);
    }

    if (limits !== undefined && needsHash.length > 0) {
      if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
        throw new GitError("E2BIG", `dirty-path hashing exceeds ${limits.maxHashCandidates} paths`);
      }
      limits.hashCandidates += needsHash.length;
    }

    const hashes = hashWorktreePathsAtRoot(repo, worktree, root, needsHash, { write: false });
    for (const candidate of needsHash) {
      const found = hashes.get(candidate.path);
      const index = expected.get(candidate.path);
      if (index !== undefined && (found === undefined || found.oid !== index.oid)) {
        dirty.add(candidate.path);
      }
    }
    for (const candidate of batch) {
      if (dirty.has(candidate.index.path)) yield candidate.index.path;
    }
  };

  try {
    for (const path of excludeRoots) {
      const relative = relativeTo(repo.root, path);
      if (relative === null || relative === "") continue;
      excluded.push(relative);
    }
    for (const entry of indexScanOwned(repo.checkout)) {
      if (limits !== undefined) {
        if (limits.indexRows >= limits.maxIndexRows) {
          throw new GitError("E2BIG", `dirty-path scan exceeds ${limits.maxIndexRows} index rows`);
        }
        limits.indexRows++;
      }
      if (entry.stage !== 0) continue;
      if (!pathspec.matchesEntry(entry.path)) continue;
      if (excluded.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)))
        continue;

      if (scanned === null) {
        root = readWorktreeRealpath(worktree, repo.root);
        scanned = scanDirtyWorktreeEntries(worktree, repo.root, root, limits, excludeRoots);
        current = scanned.next();
      }
      if (root === null || current === null) throw new Error("dirty path scan has no cursor");

      let cursor: IteratorResult<WorktreePath, void> = current;
      while (cursor.done !== true) {
        if (comparePaths(cursor.value.path, entry.path) < 0) cursor = scanned.next();
        else break;
      }
      current = cursor;
      if (cursor.done === true) {
        yield* flush();
        yield entry.path;
        continue;
      }
      if (cursor.value.path !== entry.path) {
        yield* flush();
        yield entry.path;
        continue;
      }

      const stat = cursor.value.stat;
      const path = { path: entry.path, stat };
      pending.push({ index: entry, path });
      current = scanned.next();
      if (pending.length >= HASH_BATCH) yield* flush();
    }
    yield* flush();
  } finally {
    scanned?.return(undefined);
    closeScanIterator(refreshIterator);
  }
}

function* dirtyPathStreamPagedOwned(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
  limits?: DirtyPathLimits,
  excludeRoots: string[] = [],
): Generator<string> {
  const pathspec = compilePathspecsOwned(paths);
  const excluded: string[] = [];
  let root: RealPath | null = null;
  let scanned: Generator<WorktreePath> | null = null;
  let current: IteratorResult<WorktreePath, void> | null = null;
  const pending: { index: IndexEntry; path: WorktreePath }[] = [];
  const hashCursor = createWorktreeHashCursor(excludeRoots);

  const flush = function* (): Generator<string> {
    if (pending.length === 0) return;
    if (root === null) throw new Error("dirty path scan has no canonical root");
    const batch = pending.splice(0);
    const refreshed = refreshPaths(
      worktree,
      root,
      batch.map((candidate) => candidate.path),
      hashCursor,
    );
    const refreshedByPath = new Map(refreshed.map((candidate) => [candidate.path, candidate]));
    const expected = new Map(batch.map((candidate) => [candidate.index.path, candidate.index]));
    const needsHash: WorktreePath[] = [];
    const dirty = new Set<string>();

    for (const candidate of batch) {
      const found = refreshedByPath.get(candidate.index.path);
      if (found === undefined) {
        dirty.add(candidate.index.path);
        continue;
      }
      const modeMatches = candidate.index.mode === Number.parseInt(gitModeFor(found.stat), 8);
      if (!modeMatches) {
        dirty.add(candidate.index.path);
        continue;
      }
      if (found.stat.contentId !== null && toHex(found.stat.contentId) === candidate.index.oid) {
        continue;
      }
      if (indexMatchesStat(candidate.index, found.stat)) continue;
      needsHash.push(found);
    }

    if (limits !== undefined && needsHash.length > 0) {
      if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
        throw new GitError("E2BIG", `dirty-path hashing exceeds ${limits.maxHashCandidates} paths`);
      }
      limits.hashCandidates += needsHash.length;
    }

    const hashes = hashWorktreePathsAtRoot(repo, worktree, root, needsHash, { write: false });
    for (const candidate of needsHash) {
      const found = hashes.get(candidate.path);
      const index = expected.get(candidate.path);
      if (index !== undefined && (found === undefined || found.oid !== index.oid)) {
        dirty.add(candidate.path);
      }
    }
    for (const candidate of batch) {
      if (dirty.has(candidate.index.path)) yield candidate.index.path;
    }
  };

  for (const path of excludeRoots) {
    const relative = relativeTo(repo.root, path);
    if (relative === null || relative === "") continue;
    excluded.push(relative);
  }
  for (const entry of indexScanOwned(repo.checkout)) {
    if (limits !== undefined) {
      if (limits.indexRows >= limits.maxIndexRows) {
        throw new GitError("E2BIG", `dirty-path scan exceeds ${limits.maxIndexRows} index rows`);
      }
      limits.indexRows++;
    }
    if (entry.stage !== 0) continue;
    if (!pathspec.matchesEntry(entry.path)) continue;
    if (excluded.some((root) => entry.path === root || entry.path.startsWith(`${root}/`))) continue;

    if (scanned === null) {
      root = readWorktreeRealpath(worktree, repo.root);
      scanned = scanDirtyWorktreeEntries(worktree, repo.root, root, limits, excludeRoots);
      current = scanned.next();
    }
    if (root === null || current === null) throw new Error("dirty path scan has no cursor");

    let cursor: IteratorResult<WorktreePath, void> = current;
    while (cursor.done !== true) {
      if (comparePaths(cursor.value.path, entry.path) < 0) cursor = scanned.next();
      else break;
    }
    current = cursor;
    if (cursor.done === true) {
      yield* flush();
      yield entry.path;
      continue;
    }
    if (cursor.value.path !== entry.path) {
      yield* flush();
      yield entry.path;
      continue;
    }

    const stat = cursor.value.stat;
    const path = { path: entry.path, stat };
    pending.push({ index: entry, path });
    current = scanned.next();
    if (pending.length >= HASH_BATCH) yield* flush();
  }
  yield* flush();
}

function* scanDirtyWorktreeEntries(
  worktree: Worktree,
  lexicalRoot: string,
  canonicalRoot: RealPath,
  limits: DirtyPathLimits | undefined,
  excludeRoots: string[],
): Generator<WorktreePath> {
  if (excludeRoots.length === 0) {
    for (const stat of scanWorktreeEntries(worktree, canonicalRoot, limits)) {
      const path = relativeTo(canonicalRoot, stat.path);
      if (path !== null) {
        yield { path, stat: statFromScan(stat) };
      }
    }
    return;
  }
  for (const entry of walkWorktreeEntriesStreamOwned(worktree, lexicalRoot, {
    excludeRoots,
    includeIgnored: true,
    maxScanRows: DIRTY_EXCLUDED_SCAN_ROWS,
  })) {
    if (entry.stat.type === "dir") continue;
    if (limits !== undefined) {
      if (limits.worktreeRows >= limits.maxWorktreeRows) {
        throw new GitError(
          "E2BIG",
          `dirty-path scan exceeds ${limits.maxWorktreeRows} worktree rows`,
        );
      }
      limits.worktreeRows++;
    }
    yield entry;
  }
}

/** Files and symlinks from a paged scan over an already canonical root. */
function* scanWorktreeEntries(
  worktree: Worktree,
  root: RealPath,
  limits?: DirtyPathLimits,
  initialAfter?: string,
): Generator<ScanEntry> {
  const stream = worktree.scanStream;
  if (stream !== undefined) {
    for (const entry of stream.call(worktree, root, { filesOnly: true })) {
      if (initialAfter !== undefined && comparePaths(entry.path, initialAfter) <= 0) continue;
      if (limits !== undefined) {
        if (limits.worktreeRows >= limits.maxWorktreeRows) {
          throw new GitError(
            "E2BIG",
            `dirty-path scan exceeds ${limits.maxWorktreeRows} worktree rows`,
          );
        }
        limits.worktreeRows++;
      }
      yield entry;
    }
    return;
  }
  let after = initialAfter;
  while (true) {
    const read = readWorktreeScanPage(worktree, root, {
      after,
      filesOnly: true,
      limit: WORKTREE_SCAN_PAGE,
    });
    const page = read.page;
    if (page.length === 0) return;
    for (const entry of page) {
      if (limits !== undefined) {
        if (limits.worktreeRows >= limits.maxWorktreeRows) {
          throw new GitError(
            "E2BIG",
            `dirty-path scan exceeds ${limits.maxWorktreeRows} worktree rows`,
          );
        }
        limits.worktreeRows++;
      }
      yield entry;
    }
    if (page.length < WORKTREE_SCAN_PAGE) return;
    after = page[page.length - 1]?.path;
  }
}

function closeScanIterator(iterator: Iterator<ScanEntry> | null): void {
  iterator?.return?.();
}
