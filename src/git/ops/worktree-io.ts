// The bridge between the working tree and the object database: walking it,
// hashing what is in it, and describing an index row for a path.
//
// FROZEN SEAM: status, staging, diff, commit and clean all go through
// these. Nothing here knows about Computer or DOFS — only the `Worktree`
// interface.

import { subtreeSuccessor } from "../../fs/path.js";
import { nativeRealpathOwned, nativeScanOwned } from "../../fs/store/owned-read.js";
import type { RealPath, ScanEntry, ScanOptions } from "../../fs/types.js";
import { toHex, utf8 } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { hashObject, objectHeader } from "../common/objects.js";
import { joinPath, relativeTo } from "../common/paths.js";
import { Sha1 } from "../common/sha1.js";
import { comparePaths } from "../common/streams.js";
import type { IgnoreMatcher } from "../ignore/index.js";
import {
  type IndexEntry,
  indexScanOwned,
  PACK_BLOB_BATCH_TARGET_BYTES,
  writeObjectsOwned,
} from "../store/index.js";
import type { Repository } from "./repository.js";
import { gitModeFor, type Worktree, type WorktreeStat } from "./worktree.js";

/** Bytes pulled from the working tree at a time when a file is streamed. */
const READ_CHUNK = 64 * 1024;

/**
 * Below this, a file is read in one go. Streaming costs a second pass over
 * the content — the hash pass and the store pass — which is a bad trade for
 * a file that was never going to strain anything.
 */
const STREAM_ABOVE = 512 * 1024;

/** Rows per working-tree scan. This is also the metadata memory bound. */
export const WORKTREE_SCAN_PAGE = 1000;
const DIRTY_EXCLUDED_SCAN_ROWS = 100_000;

/** Files held while one bulk hash pass is assembled. */
const HASH_BATCH = 1000;

export const MAX_COMPILED_PATHS = 32_768;

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

/** One immutable exact/prefix pathspec projection in Git byte order. */
export interface CompiledPathspecMatcher {
  /** Preserve checkout's historical raw-exact and trailing-slash prefix semantics. */
  matches(path: string): boolean;
  /** Preserve the walker's normalized exact semantics for files and symlinks. */
  matchesEntry(path: string): boolean;
  /** Whether the directory itself or any possible descendant can match. */
  includesDirectory(path: string): boolean;
}

class ByteOrderedPathspecMatcher implements CompiledPathspecMatcher {
  readonly #checkoutAll: boolean;
  readonly #walkAll: boolean;
  readonly #exact: string[];
  readonly #checkoutPrefixes: string[];
  readonly #walkPrefixes: string[];

  constructor(paths: readonly string[] | undefined) {
    this.#checkoutAll =
      paths === undefined || paths.length === 0 || paths.includes("") || paths.includes(".");
    this.#walkAll =
      this.#checkoutAll ||
      paths?.some((path) => {
        const normalized = path.replace(/\/+$/, "");
        return normalized === "" || normalized === ".";
      }) === true;
    this.#exact = uniqueByteOrdered(paths ?? []);
    this.#checkoutPrefixes = uniqueByteOrdered(
      (paths ?? []).map((path) => path.replace(/\/+$/, "")),
    );
    this.#walkPrefixes = this.#checkoutPrefixes.filter((path) => path !== "" && path !== ".");
  }

  matches(path: string): boolean {
    return (
      this.#checkoutAll ||
      containsByteOrdered(this.#exact, path) ||
      this.#hasPrefix(this.#checkoutPrefixes, path)
    );
  }

  matchesEntry(path: string): boolean {
    return (
      this.#walkAll ||
      containsByteOrdered(this.#walkPrefixes, path) ||
      this.#hasPrefix(this.#walkPrefixes, path)
    );
  }

  includesDirectory(path: string): boolean {
    if (this.#walkAll || this.matchesEntry(path)) return true;
    const prefix = `${path}/`;
    const at = lowerBound(this.#walkPrefixes, prefix);
    return this.#walkPrefixes[at]?.startsWith(prefix) === true;
  }

  #hasPrefix(prefixes: readonly string[], path: string): boolean {
    let slash = path.indexOf("/");
    while (slash >= 0) {
      if (containsByteOrdered(prefixes, path.slice(0, slash))) return true;
      slash = path.indexOf("/", slash + 1);
    }
    return false;
  }
}

/** Compile once when one pathspec list is reused across joins or walks. */
export function compilePathspecs(paths: readonly string[] | undefined): CompiledPathspecMatcher {
  return compilePathspecsOwned(paths);
}

/** Compile a matcher for internal callers. */
export function compilePathspecsOwned(
  paths: readonly string[] | undefined,
): ByteOrderedPathspecMatcher {
  validateCompiledPathspecs(paths);
  return new ByteOrderedPathspecMatcher(paths);
}

function validateCompiledPathspecs(paths: readonly string[] | undefined): void {
  if (paths === undefined) return;
  if (paths.length > MAX_COMPILED_PATHS) {
    throw new GitError("E2BIG", `compiled pathspec exceeds ${MAX_COMPILED_PATHS} paths`);
  }
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path === undefined) throw new GitError("EINVAL", "compiled pathspec is not dense");
  }
}

function uniqueByteOrdered(values: readonly string[]): string[] {
  const ordered = [...values].sort(comparePaths);
  const unique: string[] = [];
  for (const value of ordered) {
    if (unique[unique.length - 1] !== value) unique.push(value);
  }
  return unique;
}

function lowerBound(values: readonly string[], wanted: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value !== undefined && comparePaths(value, wanted) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function containsByteOrdered(values: readonly string[], wanted: string): boolean {
  return values[lowerBound(values, wanted)] === wanted;
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

function statFromScan(entry: ScanEntry): WorktreeStat {
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

interface WorktreeHashOptions {
  write?: boolean;
}

function readWorktreeRealpath(worktree: Worktree, path: string): RealPath {
  return nativeRealpathOwned(worktree, path) ?? worktree.realpath(path);
}

function readWorktreeScanPage(
  worktree: Worktree,
  root: RealPath,
  options: ScanOptions,
): { page: ScanEntry[] } {
  return { page: nativeScanOwned(worktree, root, options) ?? worktree.scan(root, options) };
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
): Map<string, HashedPath> {
  if (paths.length === 0) return new Map();
  const root = readWorktreeRealpath(worktree, repo.root);
  return hashWorktreePathsAtRoot(
    repo,
    worktree,
    root,
    refreshPaths(worktree, root, paths),
    options,
  );
}

function hashWorktreePathsAtRoot(
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
function refreshPaths(
  worktree: Worktree,
  root: RealPath,
  paths: readonly WorktreePath[],
): WorktreePath[] {
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
  const chunks = function* (): Generator<Uint8Array> {
    for (let offset = 0; offset < stat.size; offset += READ_CHUNK) {
      const length = Math.min(READ_CHUNK, stat.size - offset);
      const chunk = worktree.readRange(absolute, offset, length);
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
  const pathspec = compilePathspecsOwned(paths);
  const excluded: string[] = [];
  let root: RealPath | null = null;
  let scanned: Generator<WorktreePath> | null = null;
  let current: IteratorResult<WorktreePath, void> | null = null;
  const pending: { index: IndexEntry; path: WorktreePath }[] = [];

  const flush = function* (): Generator<string> {
    if (pending.length === 0) return;
    if (root === null) throw new Error("dirty path scan has no canonical root");
    const batch = pending.splice(0);
    let dirty: Set<string>;
    const refreshed = refreshPaths(
      worktree,
      root,
      batch.map((candidate) => candidate.path),
    );
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
): Generator<ScanEntry> {
  let after: string | undefined;
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
