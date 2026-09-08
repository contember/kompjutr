import type { RealPath, ScanEntry } from "@kompjutr/drive";
import { toHex, utf8 } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { hashObject, MAX_OBJECT_BYTES, objectHeader } from "../../common/objects.js";
import { joinPath, relativeTo } from "../../common/paths.js";
import { Sha1 } from "../../common/sha1.js";
import { comparePaths } from "../../common/streams.js";
import { type IndexEntry, PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import { sharedRepoStoreMutations, writeObjectsOwned } from "../../store/repository/shared.js";
import type { Repository } from "../repository/repository.js";
import { gitModeFor, type Worktree, type WorktreeStat } from "./worktree.js";
import {
  readWorktreeRealpath,
  readWorktreeScanPage,
  WORKTREE_SCAN_PAGE,
  type WorktreePath,
} from "./worktree-io-walk.js";

/** Bytes pulled from the working tree at a time when a file is streamed. */
const READ_CHUNK = 64 * 1024;

/**
 * Below this, a file is read in one go. Streaming costs a second pass over
 * the content — the hash pass and the store pass — which is a bad trade for
 * a file that was never going to strain anything.
 */
const STREAM_ABOVE = 512 * 1024;

/** Files held while one bulk hash pass is assembled. */
const HASH_BATCH = 1000;

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

export interface WorktreeHashOptions {
  write?: boolean;
}

/** Cursor shared by strictly ordered hash windows within one operation. */
export interface WorktreeHashCursor {
  root: RealPath | null;
  after: string | undefined;
  excludeRoots: readonly string[];
  canonicalExcludeRoots: readonly string[] | null;
}

export function createWorktreeHashCursor(excludeRoots: readonly string[] = []): WorktreeHashCursor {
  return { root: null, after: undefined, excludeRoots, canonicalExcludeRoots: null };
}

/**
 * Hash several working-tree paths through bounded bulk reads.
 *
 * Missing files are absent from the result. Large files keep the streaming
 * path, while small blobs share one bounded object batch when they are stored.
 */
export function hashWorktreePaths(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions = {},
): Map<string, HashedPath> {
  return hashWorktreePathsOwned(repo, worktree, paths, options);
}

/** Internal seam for callers that retain hash inputs or results across subsequent work. */
export function hashWorktreePathsOwned(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions = {},
  cursor?: WorktreeHashCursor,
): Map<string, HashedPath> {
  if (paths.length === 0) return new Map();
  const root = cursor?.root ?? readWorktreeRealpath(worktree, repo.root);
  if (cursor !== undefined && cursor.canonicalExcludeRoots === null) {
    cursor.canonicalExcludeRoots = cursor.excludeRoots.map((path) => {
      const relative = relativeTo(repo.root, path);
      return relative === null ? path.replace(/\/+$/, "") : joinPath(root, relative);
    });
  }
  return hashWorktreePathsAtRoot(
    repo,
    worktree,
    root,
    refreshPaths(worktree, root, paths, cursor),
    options,
  );
}

export function hashWorktreePathsAtRoot(
  repo: Repository,
  worktree: Worktree,
  root: RealPath,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions,
): Map<string, HashedPath> {
  const hashed = new Map<string, HashedPath>();
  const smallFiles: WorktreePath[] = [];
  const symlinks: WorktreePath[] = [];

  for (const candidate of paths) {
    if (candidate.stat.type === "dir") continue;
    // Refuse from the stat, before any content is read: an oversized file
    // never enters memory and never reaches the object store.
    if (options.write !== false && candidate.stat.size > MAX_OBJECT_BYTES) {
      throw new GitError(
        "E2BIG",
        `${candidate.path} is ${candidate.stat.size} bytes, above the ${MAX_OBJECT_BYTES}-byte object limit`,
      );
    }
    if (candidate.stat.type === "symlink") {
      symlinks.push(candidate);
    } else if (candidate.stat.size > STREAM_ABOVE) {
      const absolute = joinPath(root, candidate.path);
      hashed.set(candidate.path, hashLargeFile(repo, worktree, absolute, candidate.stat, options));
    } else {
      smallFiles.push(candidate);
    }
  }

  const process = (identify: (bytes: Uint8Array) => string): void => {
    for (const candidate of symlinks) {
      if (candidate.stat.target === null) {
        throw new Error(`symlink scan entry has no target: ${candidate.path}`);
      }
      const bytes = utf8.encode(candidate.stat.target);
      hashed.set(candidate.path, {
        oid: identify(bytes),
        mode: gitModeFor(candidate.stat),
        stat: candidate.stat,
      });
    }

    let remaining: string[] = [];
    for (const candidate of smallFiles) {
      remaining.push(joinPath(root, candidate.path));
    }
    const byAbsolute = new Map<string, WorktreePath>();
    for (let index = 0; index < smallFiles.length; index++) {
      const absolute = remaining[index];
      const candidate = smallFiles[index];
      if (absolute !== undefined && candidate !== undefined) byAbsolute.set(absolute, candidate);
    }
    while (remaining.length > 0) {
      let selectedBytes = 0;
      let selectedEntries = 0;
      for (const absolute of remaining) {
        const candidate = byAbsolute.get(absolute);
        const contentBytes = candidate?.stat.size ?? 0;
        if (
          selectedEntries > 0 &&
          (selectedEntries === HASH_BATCH ||
            contentBytes > PACK_BLOB_BATCH_TARGET_BYTES - selectedBytes)
        ) {
          break;
        }
        selectedBytes += contentBytes;
        selectedEntries++;
      }
      if (selectedEntries === 0) {
        throw new Error("worktree hash batch made no progress");
      }
      const selected = remaining.slice(0, selectedEntries);
      const batch = worktree.readFiles(selected, {
        budget: Math.max(1, selectedBytes),
        maxBytes: Math.max(1, selectedBytes),
        deferOversized: true,
      });
      for (const [absolute, bytes] of batch.files) {
        const candidate = byAbsolute.get(absolute);
        if (candidate === undefined) continue;
        hashed.set(candidate.path, {
          oid: identify(bytes),
          mode: gitModeFor(candidate.stat),
          stat: candidate.stat,
        });
      }
      if (batch.remaining.length >= selected.length) {
        throw new Error("readFiles did not make progress");
      }
      remaining = [...batch.remaining, ...remaining.slice(selectedEntries)];
    }
  };

  if (options.write === false) {
    process((bytes) => hashObject("blob", bytes));
  } else {
    writeObjectsOwned(repo.store, (batch) => process((bytes) => batch.write("blob", bytes)));
  }
  return hashed;
}

/** Hash caller-hydrated paths without refreshing them through a full filesystem scan. */
export function hashExactWorktreePaths(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions = {},
): Map<string, HashedPath> {
  return hashExactWorktreePathsOwned(repo, worktree, paths, options);
}

/** Internal exact-path hashing seam. */
export function hashExactWorktreePathsOwned(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions = {},
): Map<string, HashedPath> {
  if (paths.length === 0) return new Map();
  const root = readWorktreeRealpath(worktree, repo.root);
  return hashWorktreePathsAtRoot(repo, worktree, root, paths, options);
}

/** Refresh scan-derived metadata immediately before hashing. */
export function refreshPaths(
  worktree: Worktree,
  root: RealPath,
  paths: readonly WorktreePath[],
  cursor?: WorktreeHashCursor,
): WorktreePath[] {
  if (cursor !== undefined) {
    if (cursor.root !== null && cursor.root !== root) {
      throw new Error("worktree hash cursor changed roots");
    }
    cursor.root = root;
    return refreshOrderedPaths(worktree, root, paths, cursor);
  }
  const wanted = new Map<string, string>();
  for (const candidate of paths) {
    const absolute = joinPath(root, candidate.path);
    wanted.set(absolute, candidate.path);
  }
  const refreshed: WorktreePath[] = [];
  if (wanted.size === 0) return refreshed;

  for (const entry of scanWorktreeEntries(worktree, root)) {
    const relative = wanted.get(entry.path);
    if (relative === undefined) continue;
    const { path: scannedPath, ...stat } = entry;
    const candidate = { path: relative, stat };
    refreshed.push(candidate);
    wanted.delete(scannedPath);
    if (wanted.size === 0) break;
  }
  return refreshed;
}

function refreshOrderedPaths(
  worktree: Worktree,
  root: RealPath,
  paths: readonly WorktreePath[],
  cursor: WorktreeHashCursor,
): WorktreePath[] {
  const wanted = new Map<string, string>();
  let previous = cursor.after;
  for (const candidate of paths) {
    if (previous !== undefined && comparePaths(previous, candidate.path) >= 0) {
      throw new Error("worktree hash windows are not strictly ordered");
    }
    wanted.set(joinPath(root, candidate.path), candidate.path);
    previous = candidate.path;
  }
  if (previous === undefined) return [];

  const through = joinPath(root, previous);
  const after = cursor.after === undefined ? undefined : joinPath(root, cursor.after);
  const refreshed: WorktreePath[] = [];
  for (const entry of scanWorktreeEntries(
    worktree,
    root,
    after,
    cursor.canonicalExcludeRoots ?? [],
  )) {
    if (comparePaths(entry.path, through) > 0) break;
    const relative = wanted.get(entry.path);
    if (relative === undefined) continue;
    const { path: scannedPath, ...stat } = entry;
    refreshed.push({ path: relative, stat });
    wanted.delete(scannedPath);
    if (wanted.size === 0) break;
  }
  cursor.after = previous;
  return refreshed;
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
  options: WorktreeHashOptions = {},
): HashedPath | null {
  return hashWorktreePathOwned(repo, worktree, relative, options);
}

/** Internal single-path hashing seam. */
export function hashWorktreePathOwned(
  repo: Repository,
  worktree: Worktree,
  relative: string,
  options: WorktreeHashOptions = {},
): HashedPath | null {
  const root = readWorktreeRealpath(worktree, repo.root);
  const absolute = joinPath(root, relative);
  const stat = worktree.stat(absolute);
  if (stat === null || stat.type === "dir") return null;
  const candidate = { path: relative, stat };
  return hashWorktreePathsAtRoot(repo, worktree, root, [candidate], options).get(relative) ?? null;
}

/** Hash, and optionally store, without ever holding the whole file. */
function hashLargeFile(
  repo: Repository,
  worktree: Worktree,
  absolute: string,
  stat: WorktreeStat,
  options: WorktreeHashOptions,
): HashedPath {
  const rangeChunks = function* (): Generator<Uint8Array> {
    for (let offset = 0; offset < stat.size; offset += READ_CHUNK) {
      const length = Math.min(READ_CHUNK, stat.size - offset);
      const chunk = worktree.readRange(absolute, offset, length);
      if (chunk.length === 0) break;
      yield chunk;
    }
  };
  const stream = worktree.readFileStream;
  const chunks = stream === undefined ? rangeChunks : () => stream.call(worktree, absolute, stat);
  if (options.write === false) {
    const hash = new Sha1().update(objectHeader("blob", stat.size));
    for (const chunk of chunks()) hash.update(chunk);
    return { oid: toHex(hash.digest()), mode: gitModeFor(stat), stat };
  }
  return {
    oid: sharedRepoStoreMutations(repo.store).writeStreamOwned("blob", stat.size, chunks),
    mode: gitModeFor(stat),
    stat,
  };
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
    rev: hashed.stat.rev,
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
  if (entry.rev !== undefined && entry.rev !== null && entry.rev !== stat.rev) return false;
  return entry.mode === Number.parseInt(gitModeFor(stat), 8);
}

function* scanWorktreeEntries(
  worktree: Worktree,
  root: RealPath,
  initialAfter?: string,
  excludeRoots: readonly string[] = [],
): Generator<ScanEntry> {
  const isExcluded = (path: string): boolean =>
    excludeRoots.some(
      (excludedRoot) => path === excludedRoot || path.startsWith(`${excludedRoot}/`),
    );
  const orderedScan = worktree.scanStream;
  if (orderedScan !== undefined) {
    for (const entry of orderedScan.call(worktree, root, {
      filesOnly: true,
      pruneDirectory: isExcluded,
    })) {
      if (initialAfter === undefined || comparePaths(entry.path, initialAfter) > 0) yield entry;
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
      if (!isExcluded(entry.path)) yield entry;
    }
    if (page.length < WORKTREE_SCAN_PAGE) return;
    after = page[page.length - 1]?.path;
  }
}
