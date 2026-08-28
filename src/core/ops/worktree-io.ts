// The bridge between the working tree and the object database: walking it,
// hashing what is in it, and describing an index row for a path.
//
// FROZEN SEAM: status, staging, diff, commit and clean all go through
// these. Nothing here knows about Computer or DOFS — only the `Worktree`
// interface.

import { subtreeSuccessor } from "../../fs/path.js";
import type { ScanEntry } from "../../fs/types.js";
import type { IndexEntry } from "../../sqlite/store.js";
import { toHex, utf8 } from "../bytes.js";
import { GitError } from "../errors.js";
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

/** Rows per working-tree scan. This is also the metadata memory bound. */
export const WORKTREE_SCAN_PAGE = 1000;
const DIRTY_EXCLUDED_SCAN_ROWS = 100_000;

/** Files held while one bulk hash pass is assembled. */
const HASH_BATCH = 1000;

export const MAX_COMPILED_PATHS = 32_768;
export const MAX_COMPILED_PATHSPEC_BYTES = 1024 * 1024;

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
  validateCompiledPathspecs(paths);
  return new ByteOrderedPathspecMatcher(paths);
}

function validateCompiledPathspecs(paths: readonly string[] | undefined): void {
  if (paths === undefined) return;
  if (paths.length > MAX_COMPILED_PATHS) {
    throw new GitError("E2BIG", `compiled pathspec exceeds ${MAX_COMPILED_PATHS} paths`);
  }
  let inputBytes = 0;
  let requestBytes = 2;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path === undefined) throw new GitError("EINVAL", "compiled pathspec is not dense");
    const sizes = pathspecBytes(path);
    const separator = index === 0 ? 0 : 1;
    if (
      sizes.input > MAX_COMPILED_PATHSPEC_BYTES - inputBytes ||
      sizes.request + separator > MAX_COMPILED_PATHSPEC_BYTES - requestBytes
    ) {
      throw new GitError("E2BIG", `compiled pathspec exceeds ${MAX_COMPILED_PATHSPEC_BYTES} bytes`);
    }
    inputBytes += sizes.input;
    requestBytes += sizes.request + separator;
  }
}

function pathspecBytes(value: string): { input: number; request: number } {
  let input = 0;
  let request = 2;
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
    ) {
      input++;
      request += 2;
    } else if (unit < 0x20) {
      input++;
      request += 6;
    } else if (unit < 0x80) {
      input++;
      request++;
    } else if (unit < 0x800) {
      input += 2;
      request += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        input += 4;
        request += 4;
        index++;
      } else {
        input += 3;
        request += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      input += 3;
      request += 6;
    } else {
      input += 3;
      request += 3;
    }
    if (input > MAX_COMPILED_PATHSPEC_BYTES || request > MAX_COMPILED_PATHSPEC_BYTES) break;
  }
  return { input, request };
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

/** Number of bounded filesystem range reads used to hash large regular files. */
export function worktreeHashRangeReads(paths: readonly WorktreePath[]): number {
  let reads = 0;
  for (const path of paths) {
    if (path.stat.type !== "file" || path.stat.size <= STREAM_ABOVE) continue;
    reads += Math.ceil(path.stat.size / READ_CHUNK);
    if (!Number.isSafeInteger(reads)) return Number.MAX_SAFE_INTEGER;
  }
  return reads;
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
  const pathspec = options.pathspec ?? compilePathspecs(options.paths);
  const base = worktree.realpath(lexicalRoot);
  const excluded = new Set(
    (options.excludeRoots ?? []).map((path) => {
      const relative = relativeTo(lexicalRoot, path);
      return relative === null ? path.replace(/\/+$/, "") : joinPath(base, relative);
    }),
  );
  let after: string | undefined;
  let afterSubtree: string | undefined;
  let scannedRows = 0;
  const pruned: Array<{ directory: string; lower: string; upper: string }> = [];

  while (true) {
    const entries =
      afterSubtree === undefined
        ? worktree.scan(base, { after, filesOnly: options.filesOnly, limit: WORKTREE_SCAN_PAGE })
        : worktree.scan(base, {
            afterSubtree,
            filesOnly: options.filesOnly,
            limit: WORKTREE_SCAN_PAGE,
          });
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
          pruned.push(prunedRange(entry.path));
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
          pruned.push(prunedRange(entry.path));
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
  options: { write?: boolean } = {},
): Map<string, HashedPath> {
  if (paths.length === 0) return new Map();
  const root = worktree.realpath(repo.root);
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
  root: string,
  paths: readonly WorktreePath[],
  options: { write?: boolean },
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

    let remaining = smallFiles.map((candidate) => joinPath(root, candidate.path));
    const byAbsolute = new Map(
      smallFiles.map((candidate) => [joinPath(root, candidate.path), candidate]),
    );
    while (remaining.length > 0) {
      const batch = worktree.readFiles(remaining);
      for (const [absolute, bytes] of batch.files) {
        const candidate = byAbsolute.get(absolute);
        if (candidate === undefined) continue;
        hashed.set(candidate.path, {
          oid: identify(bytes),
          mode: gitModeFor(candidate.stat),
          stat: candidate.stat,
        });
      }
      if (batch.remaining.length >= remaining.length) {
        throw new Error("readFiles did not make progress");
      }
      remaining = batch.remaining;
    }
  };

  if (options.write === false) {
    process((bytes) => hashObject("blob", bytes));
  } else {
    repo.store.writeObjects((batch) => process((bytes) => batch.write("blob", bytes)));
  }
  return hashed;
}

/** Hash caller-hydrated paths without refreshing them through a full filesystem scan. */
export function hashExactWorktreePaths(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  options: { write?: boolean } = {},
): Map<string, HashedPath> {
  if (paths.length === 0) return new Map();
  return hashWorktreePathsAtRoot(repo, worktree, worktree.realpath(repo.root), paths, options);
}

/** Refresh scan-derived metadata immediately before hashing. */
function refreshPaths(
  worktree: Worktree,
  root: string,
  paths: readonly WorktreePath[],
): WorktreePath[] {
  const wanted = new Map(
    paths.map((candidate) => [joinPath(root, candidate.path), candidate.path]),
  );
  const refreshed: WorktreePath[] = [];
  if (wanted.size === 0) return refreshed;

  for (const entry of scanWorktreeEntries(worktree, root)) {
    const relative = wanted.get(entry.path);
    if (relative === undefined) continue;
    refreshed.push({ path: relative, stat: entry });
    wanted.delete(entry.path);
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
  options: { write?: boolean } = {},
): HashedPath | null {
  const root = worktree.realpath(repo.root);
  const absolute = joinPath(root, relative);
  const stat = worktree.stat(absolute);
  if (stat === null || stat.type === "dir") return null;
  return (
    hashWorktreePathsAtRoot(repo, worktree, root, [{ path: relative, stat }], options).get(
      relative,
    ) ?? null
  );
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
export interface DirtyPathLimits {
  maxIndexRows: number;
  indexRows: number;
  maxWorktreeRows: number;
  worktreeRows: number;
  maxHashCandidates: number;
  hashCandidates: number;
  maxHashBytes: number;
  hashBytes: number;
  maxHashRangeReads: number;
  hashRangeReads: number;
  maxHashBatches: number;
  hashBatches: number;
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
  const pathspec = compilePathspecs(paths);
  const excluded = excludeRoots.flatMap((path) => {
    const relative = relativeTo(repo.root, path);
    return relative === null || relative === "" ? [] : [relative];
  });
  let root: string | null = null;
  let scanned: Generator<WorktreePath> | null = null;
  let current: IteratorResult<WorktreePath, void> | null = null;
  const pending: { index: IndexEntry; path: WorktreePath }[] = [];

  const flush = function* (): Generator<string> {
    if (pending.length === 0) return;
    if (root === null) throw new Error("dirty path scan has no canonical root");
    const batch = pending.splice(0);
    const refreshed = refreshPaths(
      worktree,
      root,
      batch.map((candidate) => candidate.path),
    );
    const current = new Map(refreshed.map((candidate) => [candidate.path, candidate]));
    const expected = new Map(batch.map((candidate) => [candidate.index.path, candidate.index]));
    const needsHash: WorktreePath[] = [];
    const dirty = new Set<string>();

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
      if (limits.hashBatches >= limits.maxHashBatches) {
        throw new GitError("E2BIG", `dirty-path hashing exceeds ${limits.maxHashBatches} batches`);
      }
      if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
        throw new GitError("E2BIG", `dirty-path hashing exceeds ${limits.maxHashCandidates} paths`);
      }
      limits.hashBatches++;
      limits.hashCandidates += needsHash.length;
      const rangeReads = worktreeHashRangeReads(needsHash);
      if (rangeReads > limits.maxHashRangeReads - limits.hashRangeReads) {
        throw new GitError(
          "E2BIG",
          `dirty-path hashing exceeds ${limits.maxHashRangeReads} range reads`,
        );
      }
      limits.hashRangeReads += rangeReads;
      for (const candidate of needsHash) {
        if (candidate.stat.size > limits.maxHashBytes - limits.hashBytes) {
          throw new GitError("E2BIG", `dirty-path hashing exceeds ${limits.maxHashBytes} bytes`);
        }
        limits.hashBytes += candidate.stat.size;
      }
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
      if (dirty.has(candidate.index.path)) {
        yield candidate.index.path;
      }
    }
  };

  for (const entry of repo.checkout.indexScan()) {
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
      const canonical = worktree.realpath(repo.root);
      root = canonical;
      scanned = scanDirtyWorktreeEntries(worktree, repo.root, canonical, limits, excludeRoots);
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
    current = scanned.next();
    pending.push({ index: entry, path: { path: entry.path, stat } });
    if (pending.length >= HASH_BATCH) yield* flush();
  }
  yield* flush();
}

function* scanDirtyWorktreeEntries(
  worktree: Worktree,
  lexicalRoot: string,
  canonicalRoot: string,
  limits: DirtyPathLimits | undefined,
  excludeRoots: string[],
): Generator<WorktreePath> {
  if (excludeRoots.length === 0) {
    for (const stat of scanWorktreeEntries(worktree, canonicalRoot, limits)) {
      const path = relativeTo(canonicalRoot, stat.path);
      if (path !== null) yield { path, stat };
    }
    return;
  }
  for (const entry of walkWorktreeEntriesStream(worktree, lexicalRoot, {
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
  root: string,
  limits?: DirtyPathLimits,
): Generator<ScanEntry> {
  let after: string | undefined;
  while (true) {
    const page = worktree.scan(root, {
      after,
      filesOnly: true,
      limit: WORKTREE_SCAN_PAGE,
    });
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
