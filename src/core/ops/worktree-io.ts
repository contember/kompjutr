// The bridge between the working tree and the object database: walking it,
// hashing what is in it, and describing an index row for a path.
//
// FROZEN SEAM: status, staging, diff, commit and clean all go through
// these. Nothing here knows about Computer or DOFS — only the `Worktree`
// interface.

import { subtreeSuccessor } from "../../fs/path.js";
import { nativeRealpathOwned, nativeScanOwned } from "../../fs/store/owned-read.js";
import { scanPageRetainedBytes } from "../../fs/store/scan.js";
import type { RealPath, ScanEntry, ScanOptions } from "../../fs/types.js";
import { MemoryCoordinator, type MemoryReservation } from "../../memory.js";
import { type IndexEntry, indexScanOwned, writeObjectsOwned } from "../../sqlite/store.js";
import { toHex, utf8 } from "../bytes.js";
import { GitError } from "../errors.js";
import type { IgnoreMatcher } from "../ignore/index.js";
import { hashObject, objectHeader } from "../objects.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
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
const HASH_OWNER_BYTES = 512;
const HASH_COLLECTION_ENTRY_BYTES = 32;
const HASH_RESULT_ENTRY_BYTES = 192;
const HASH_SCAN_ENTRY_BYTES = 256;
const HASH_BATCH_ENTRY_BYTES = 128;
const HASH_BYTE_ARRAY_BYTES = 64;
const HASH_STATE_BYTES = 256;
const HASH_OID_BYTES = retainedStringBytes("0".repeat(40));
const WORKTREE_DECODED_ROW_BYTES = 256;
const PATHSPEC_MATCHER_BYTES = 256;
const PATHSPEC_ARRAY_BYTES = 64;
const PATHSPEC_ARRAY_SLOT_BYTES = 8;

function retainedStringUnits(units: number): number {
  return 48 + units * 2;
}

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
  readonly #reservation: MemoryReservation;
  readonly #checkoutAll: boolean;
  readonly #walkAll: boolean;
  readonly #exact: string[];
  readonly #checkoutPrefixes: string[];
  readonly #walkPrefixes: string[];

  constructor(paths: readonly string[] | undefined, reservation: MemoryReservation) {
    this.#reservation = reservation;
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
    const transient = this.#reservation.scope();
    transient.set("other", retainedStringUnits(path.length + 1));
    try {
      const prefix = `${path}/`;
      const at = lowerBound(this.#walkPrefixes, prefix);
      return this.#walkPrefixes[at]?.startsWith(prefix) === true;
    } finally {
      transient.dispose();
    }
  }

  #hasPrefix(prefixes: readonly string[], path: string): boolean {
    const transient = this.#reservation.scope();
    transient.set("other", retainedStringUnits(path.length));
    try {
      let slash = path.indexOf("/");
      while (slash >= 0) {
        if (containsByteOrdered(prefixes, path.slice(0, slash))) return true;
        slash = path.indexOf("/", slash + 1);
      }
      return false;
    } finally {
      transient.dispose();
    }
  }

  retainedBytes(): number {
    let bytes =
      PATHSPEC_MATCHER_BYTES +
      3 * PATHSPEC_ARRAY_BYTES +
      (this.#exact.length + this.#checkoutPrefixes.length + this.#walkPrefixes.length) *
        PATHSPEC_ARRAY_SLOT_BYTES;
    for (const path of this.#exact) bytes += retainedStringBytes(path);
    for (const path of this.#checkoutPrefixes) bytes += retainedStringBytes(path);
    return bytes;
  }
}

const COMPILED_PATHSPEC_RELEASES = new WeakMap<CompiledPathspecMatcher, () => void>();

/** Compile once when one pathspec list is reused across joins or walks. */
export function compilePathspecs(paths: readonly string[] | undefined): CompiledPathspecMatcher {
  const coordinator = new MemoryCoordinator();
  const reservation = coordinator.reserve();
  try {
    const matcher = compilePathspecsOwned(paths, reservation);
    COMPILED_PATHSPEC_RELEASES.set(matcher, () => {
      reservation.dispose();
      coordinator.assertIdle();
    });
    return matcher;
  } catch (error) {
    reservation.dispose();
    coordinator.assertIdle();
    throw error;
  }
}

/** Release a standalone compiled matcher after its final consumer. */
export function releaseCompiledPathspecs(matcher: CompiledPathspecMatcher | undefined): void {
  if (matcher === undefined) return;
  const release = COMPILED_PATHSPEC_RELEASES.get(matcher);
  if (release === undefined) return;
  COMPILED_PATHSPEC_RELEASES.delete(matcher);
  release();
}

/** Compile a matcher whose lifetime is owned by an existing operation reservation. */
export function compilePathspecsOwned(
  paths: readonly string[] | undefined,
  reservation: MemoryReservation,
): ByteOrderedPathspecMatcher {
  validateCompiledPathspecs(paths);
  reservation.set("other", compiledPathspecConstructionBytes(paths));
  try {
    const matcher = new ByteOrderedPathspecMatcher(paths, reservation);
    reservation.set("other", matcher.retainedBytes());
    return matcher;
  } catch (error) {
    reservation.clear("other");
    throw error;
  }
}

function compiledPathspecConstructionBytes(paths: readonly string[] | undefined): number {
  const values = paths ?? [];
  let strings = 0;
  for (const path of values) strings += 2 * retainedStringUnits(path.length);
  return (
    PATHSPEC_MATCHER_BYTES +
    4 * PATHSPEC_ARRAY_BYTES +
    values.length * 4 * PATHSPEC_ARRAY_SLOT_BYTES +
    strings
  );
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

/** Internal worktree walk whose physical page and decoded row use caller memory. */
export function* walkWorktreeEntriesStreamOwned(
  worktree: Worktree,
  root: string,
  reservation: MemoryReservation,
  options: WalkOptions = {},
): Generator<WorktreePath> {
  const memory = new WorktreeHashMemory(reservation);
  try {
    yield* walkWorktreeEntriesStreamCore(worktree, root, options, memory);
  } finally {
    reservation.clear("other");
  }
}

function* walkWorktreeEntriesStreamCore(
  worktree: Worktree,
  root: string,
  options: WalkOptions,
  memory?: WorktreeHashMemory,
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
  const lexicalRoot =
    memory?.construct(root.length, () => root.replace(/\/+$/, "") || "/") ??
    (root.replace(/\/+$/, "") || "/");
  const baseRead = readWorktreeRealpath(worktree, lexicalRoot, memory);
  const base = baseRead.path;
  const excluded = new Set<string>();
  let after: string | undefined;
  let afterSubtree: string | undefined;
  let scannedRows = 0;
  const pruned: Array<{ directory: string; lower: string; upper: string; bytes: number }> = [];
  let pageMemory: MemoryReservation | null = null;
  let cursorMemory: MemoryReservation | null = null;
  let pathspecMemory: MemoryReservation | null = null;
  let releaseLocalPathspec = false;
  let pathspec = options.pathspec;

  try {
    if (pathspec === undefined) {
      if (memory === undefined) {
        pathspec = compilePathspecs(options.paths);
        releaseLocalPathspec = true;
      } else {
        pathspecMemory = memory.scope();
        pathspec = compilePathspecsOwned(options.paths, pathspecMemory);
      }
    }
    for (const path of options.excludeRoots ?? []) {
      const slotBytes = HASH_COLLECTION_ENTRY_BYTES;
      memory?.add(slotBytes);
      const relativeMemory = memory?.scope() ?? null;
      relativeMemory?.set("other", retainedStringUnits(path.length));
      let excludedPath: string;
      try {
        const relative = relativeTo(lexicalRoot, path);
        excludedPath =
          relative === null
            ? (memory?.construct(path.length, () => path.replace(/\/+$/, "")) ??
              path.replace(/\/+$/, ""))
            : (memory?.construct(base.length + 1 + relative.length, () =>
                joinPath(base, relative),
              ) ?? joinPath(base, relative));
        excluded.add(excludedPath);
      } catch (error) {
        memory?.release(slotBytes);
        throw error;
      } finally {
        relativeMemory?.dispose();
      }
    }
    while (true) {
      const read =
        afterSubtree === undefined
          ? readWorktreeScanPage(
              worktree,
              base,
              { after, filesOnly: options.filesOnly, limit: WORKTREE_SCAN_PAGE },
              memory,
            )
          : readWorktreeScanPage(
              worktree,
              base,
              {
                afterSubtree,
                filesOnly: options.filesOnly,
                limit: WORKTREE_SCAN_PAGE,
              },
              memory,
            );
      const entries = read.page;
      pageMemory?.dispose();
      pageMemory = read.pageMemory;
      cursorMemory?.dispose();
      cursorMemory = null;
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
          const expired = pruned.pop();
          if (expired !== undefined) memory?.release(expired.bytes);
        }
        const active = pruned[pruned.length - 1];
        if (active !== undefined && comparePaths(entry.path, active.lower) >= 0) continue;

        const decodedMemory = memory?.scope() ?? null;
        decodedMemory?.set(
          "other",
          WORKTREE_DECODED_ROW_BYTES + retainedStringUnits(entry.path.length),
        );
        try {
          const relative = relativeTo(base, entry.path);
          if (relative === null) continue;
          decodedMemory?.set("other", WORKTREE_DECODED_ROW_BYTES + retainedStringBytes(relative));

          if (excluded.has(entry.path)) {
            if (entry.type === "dir") {
              retainPrunedRange(pruned, entry.path, memory);
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
              retainPrunedRange(pruned, entry.path, memory);
              continue;
            }
            if (options.includeDirectories === true) {
              yield { path: relative, stat: statFromScan(entry) };
            }
            continue;
          }

          if (!pathspec.matchesEntry(relative)) continue;
          if (
            options.includeIgnored !== true &&
            options.ignores?.ignores(relative, false) === true
          ) {
            continue;
          }
          yield { path: relative, stat: statFromScan(entry) };
        } finally {
          decodedMemory?.dispose();
        }
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
        const skipped = pruned.pop();
        if (skipped !== undefined) memory?.release(skipped.bytes);
      } else if (after !== undefined && memory !== undefined) {
        cursorMemory = memory.scope();
        cursorMemory.set("other", retainedStringBytes(after));
      }
    }
  } finally {
    cursorMemory?.dispose();
    pageMemory?.dispose();
    for (const range of pruned) memory?.release(range.bytes);
    releaseWorktreeRealpath(baseRead, memory);
    pathspecMemory?.dispose();
    if (releaseLocalPathspec) releaseCompiledPathspecs(pathspec);
  }
}

function retainPrunedRange(
  ranges: Array<{ directory: string; lower: string; upper: string; bytes: number }>,
  path: string,
  memory: WorktreeHashMemory | undefined,
): void {
  const predicted =
    HASH_COLLECTION_ENTRY_BYTES +
    retainedStringBytes(path) +
    retainedStringUnits(path.length + 1) * 2;
  memory?.add(predicted);
  try {
    const range = prunedRange(path);
    const bytes =
      HASH_COLLECTION_ENTRY_BYTES +
      retainedStringBytes(range.directory) +
      retainedStringBytes(range.lower) +
      retainedStringBytes(range.upper);
    if (memory !== undefined) {
      if (bytes > predicted) memory.add(bytes - predicted);
      else if (bytes < predicted) memory.release(predicted - bytes);
    }
    ranges.push({ ...range, bytes });
  } catch (error) {
    memory?.release(predicted);
    throw error;
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

interface WorktreeHashOptions {
  write?: boolean;
}

class WorktreeHashMemory {
  readonly #reservation: MemoryReservation;
  #retained = HASH_OWNER_BYTES;

  constructor(reservation: MemoryReservation) {
    this.#reservation = reservation;
    this.#reservation.set("other", this.#retained);
  }

  get remainingBytes(): number {
    return this.#reservation.remainingBytes;
  }

  add(bytes: number): void {
    const next = this.#retained + bytes;
    this.#reservation.set("other", next);
    this.#retained = next;
  }

  construct<T extends string>(units: number, construct: () => T): T {
    const predicted = retainedStringUnits(units);
    this.add(predicted);
    try {
      const value = construct();
      const actual = retainedStringBytes(value);
      if (actual > predicted) this.add(actual - predicted);
      else if (actual < predicted) this.release(predicted - actual);
      return value;
    } catch (error) {
      this.release(predicted);
      throw error;
    }
  }

  release(bytes: number): void {
    this.#retained -= bytes;
    if (this.#retained < HASH_OWNER_BYTES) {
      throw new Error("worktree hash memory accounting is corrupt");
    }
    this.#reservation.set("other", this.#retained);
  }

  scope(): MemoryReservation {
    return this.#reservation.scope();
  }
}

interface WorktreeRealpathRead {
  path: RealPath;
  nativeMemory: MemoryReservation | null;
  fallbackBytes: number;
}

function readWorktreeRealpath(
  worktree: Worktree,
  path: string,
  memory?: WorktreeHashMemory,
): WorktreeRealpathRead {
  if (memory === undefined) {
    return { path: worktree.realpath(path), nativeMemory: null, fallbackBytes: 0 };
  }
  const nativeMemory = memory.scope();
  try {
    const native = nativeRealpathOwned(worktree, path, nativeMemory);
    if (native !== null) return { path: native, nativeMemory, fallbackBytes: 0 };
  } catch (error) {
    nativeMemory.dispose();
    throw error;
  }
  nativeMemory.dispose();
  const fallback = worktree.realpath(path);
  const fallbackBytes = retainedStringBytes(fallback);
  memory.add(fallbackBytes);
  return { path: fallback, nativeMemory: null, fallbackBytes };
}

function releaseWorktreeRealpath(read: WorktreeRealpathRead, memory?: WorktreeHashMemory): void {
  read.nativeMemory?.dispose();
  if (read.fallbackBytes > 0) memory?.release(read.fallbackBytes);
}

function readWorktreeScanPage(
  worktree: Worktree,
  root: RealPath,
  options: ScanOptions,
  memory?: WorktreeHashMemory,
): { page: ScanEntry[]; pageMemory: MemoryReservation | null } {
  if (memory === undefined) return { page: worktree.scan(root, options), pageMemory: null };
  const nativeMemory = memory.scope();
  try {
    const native = nativeScanOwned(worktree, root, options, nativeMemory);
    if (native !== null) return { page: native, pageMemory: nativeMemory };
  } catch (error) {
    nativeMemory.dispose();
    throw error;
  }
  nativeMemory.dispose();

  // Compatibility providers keep their established materializing behavior.
  const page = worktree.scan(root, options);
  const fallbackMemory = memory.scope();
  try {
    fallbackMemory.set("other", scanPageRetainedBytes(page));
    return { page, pageMemory: fallbackMemory };
  } catch (error) {
    fallbackMemory.dispose();
    throw error;
  }
}

function worktreePathRetainedBytes(candidate: WorktreePath): number {
  return (
    HASH_COLLECTION_ENTRY_BYTES +
    retainedStringBytes(candidate.path) +
    worktreeStatRetainedBytes(candidate.stat)
  );
}

function worktreeStatRetainedBytes(stat: WorktreeStat): number {
  return (
    HASH_SCAN_ENTRY_BYTES +
    retainedStringBytes(stat.target ?? "") +
    (stat.contentId?.byteLength ?? 0)
  );
}

function hashResultRetainedBytes(): number {
  return HASH_RESULT_ENTRY_BYTES + HASH_OID_BYTES;
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
  const reservation = repo.store.reserveMemory();
  try {
    return hashWorktreePathsOwned(repo, worktree, paths, reservation, options);
  } finally {
    reservation.dispose();
  }
}

/** Internal seam for callers that retain hash inputs or results across subsequent work. */
export function hashWorktreePathsOwned(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  reservation: MemoryReservation,
  options: WorktreeHashOptions = {},
): Map<string, HashedPath> {
  if (!repo.store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "worktree hash reservation belongs to another repository");
  }
  const memory = new WorktreeHashMemory(reservation);
  if (paths.length === 0) return new Map();
  const rootRead = readWorktreeRealpath(worktree, repo.root, memory);
  try {
    return hashWorktreePathsAtRoot(
      repo,
      worktree,
      rootRead.path,
      refreshPaths(worktree, rootRead.path, paths, memory),
      options,
      memory,
    );
  } finally {
    releaseWorktreeRealpath(rootRead, memory);
  }
}

function hashWorktreePathsAtRoot(
  repo: Repository,
  worktree: Worktree,
  root: RealPath,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions,
  memory: WorktreeHashMemory,
): Map<string, HashedPath> {
  const hashed = new Map<string, HashedPath>();
  const smallFiles: WorktreePath[] = [];
  const symlinks: WorktreePath[] = [];

  for (const candidate of paths) {
    if (candidate.stat.type === "dir") continue;
    if (candidate.stat.type === "symlink") {
      memory.add(HASH_COLLECTION_ENTRY_BYTES);
      symlinks.push(candidate);
    } else if (candidate.stat.size > STREAM_ABOVE) {
      const absolute = memory.construct(root.length + 1 + candidate.path.length, () =>
        joinPath(root, candidate.path),
      );
      const absoluteBytes = retainedStringBytes(absolute);
      memory.add(hashResultRetainedBytes());
      try {
        hashed.set(
          candidate.path,
          hashLargeFile(repo, worktree, absolute, candidate.stat, options, memory),
        );
      } finally {
        memory.release(absoluteBytes);
      }
    } else {
      memory.add(HASH_COLLECTION_ENTRY_BYTES);
      smallFiles.push(candidate);
    }
  }

  const process = (identify: (bytes: Uint8Array) => string): void => {
    for (const candidate of symlinks) {
      if (candidate.stat.target === null) {
        throw new Error(`symlink scan entry has no target: ${candidate.path}`);
      }
      const encodedBytes = utf8ByteLength(candidate.stat.target);
      const current = memory.scope();
      current.set("other", HASH_BYTE_ARRAY_BYTES + encodedBytes + HASH_STATE_BYTES);
      try {
        const bytes = utf8.encode(candidate.stat.target);
        memory.add(hashResultRetainedBytes());
        hashed.set(candidate.path, {
          oid: identify(bytes),
          mode: gitModeFor(candidate.stat),
          stat: candidate.stat,
        });
      } finally {
        current.dispose();
      }
    }

    let remaining: string[] = [];
    let remainingBytes = 0;
    for (const candidate of smallFiles) {
      memory.add(HASH_COLLECTION_ENTRY_BYTES);
      remainingBytes += HASH_COLLECTION_ENTRY_BYTES;
      const absolute = memory.construct(root.length + 1 + candidate.path.length, () =>
        joinPath(root, candidate.path),
      );
      remainingBytes += retainedStringBytes(absolute);
      remaining.push(absolute);
    }
    const byAbsolute = new Map<string, WorktreePath>();
    memory.add(HASH_COLLECTION_ENTRY_BYTES * smallFiles.length);
    for (let index = 0; index < smallFiles.length; index++) {
      const absolute = remaining[index];
      const candidate = smallFiles[index];
      if (absolute !== undefined && candidate !== undefined) byAbsolute.set(absolute, candidate);
    }
    while (remaining.length > 0) {
      let selectedBytes = 0;
      let selectedEntries = 0;
      const available = memory.remainingBytes;
      for (const absolute of remaining) {
        const candidate = byAbsolute.get(absolute);
        const contentBytes = candidate?.stat.size ?? 0;
        const next = selectedBytes + contentBytes + HASH_BATCH_ENTRY_BYTES;
        if (next > available) break;
        selectedBytes += contentBytes;
        selectedEntries++;
      }
      if (selectedEntries === 0) {
        const first = byAbsolute.get(remaining[0] ?? "");
        const required = HASH_BATCH_ENTRY_BYTES + (first?.stat.size ?? 0);
        const current = memory.scope();
        try {
          current.set("other", required);
        } finally {
          current.dispose();
        }
        throw new Error("worktree hash batch made no memory progress");
      }
      const current = memory.scope();
      current.set(
        "other",
        selectedBytes +
          selectedEntries * HASH_BATCH_ENTRY_BYTES +
          HASH_STATE_BYTES +
          remaining.length * HASH_COLLECTION_ENTRY_BYTES,
      );
      try {
        const batch = worktree.readFiles(remaining, {
          budget: Math.max(1, selectedBytes),
          maxBytes: Math.max(1, selectedBytes),
          deferOversized: true,
        });
        for (const [absolute, bytes] of batch.files) {
          const candidate = byAbsolute.get(absolute);
          if (candidate === undefined) continue;
          memory.add(hashResultRetainedBytes());
          hashed.set(candidate.path, {
            oid: identify(bytes),
            mode: gitModeFor(candidate.stat),
            stat: candidate.stat,
          });
        }
        if (batch.remaining.length >= remaining.length) {
          throw new Error("readFiles did not make progress");
        }
        const oldSlots = HASH_COLLECTION_ENTRY_BYTES * remaining.length;
        const nextSlots = HASH_COLLECTION_ENTRY_BYTES * batch.remaining.length;
        let nextRemainingBytes = nextSlots;
        for (const absolute of batch.remaining) {
          nextRemainingBytes += retainedStringBytes(absolute);
        }
        const oldStrings = remainingBytes - oldSlots;
        const nextStrings = nextRemainingBytes - nextSlots;
        memory.add(nextSlots);
        memory.release(oldSlots + oldStrings - nextStrings);
        remaining = batch.remaining;
        remainingBytes = nextRemainingBytes;
      } finally {
        current.dispose();
      }
    }
    memory.release(remainingBytes);
    memory.release(HASH_COLLECTION_ENTRY_BYTES * smallFiles.length);
  };

  if (options.write === false) {
    process((bytes) => hashObject("blob", bytes));
  } else {
    const writeMemory = memory.scope();
    try {
      writeObjectsOwned(repo.store, writeMemory, (batch) =>
        process((bytes) => batch.write("blob", bytes)),
      );
    } finally {
      writeMemory.dispose();
    }
  }
  memory.release(HASH_COLLECTION_ENTRY_BYTES * (smallFiles.length + symlinks.length));
  return hashed;
}

/** Hash caller-hydrated paths without refreshing them through a full filesystem scan. */
export function hashExactWorktreePaths(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  options: WorktreeHashOptions = {},
): Map<string, HashedPath> {
  const reservation = repo.store.reserveMemory();
  try {
    return hashExactWorktreePathsOwned(repo, worktree, paths, reservation, options);
  } finally {
    reservation.dispose();
  }
}

/** Internal exact-path hashing under a caller-owned dedicated reservation. */
export function hashExactWorktreePathsOwned(
  repo: Repository,
  worktree: Worktree,
  paths: readonly WorktreePath[],
  reservation: MemoryReservation,
  options: WorktreeHashOptions = {},
): Map<string, HashedPath> {
  if (!repo.store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "worktree hash reservation belongs to another repository");
  }
  const memory = new WorktreeHashMemory(reservation);
  if (paths.length === 0) return new Map();
  const rootRead = readWorktreeRealpath(worktree, repo.root, memory);
  try {
    return hashWorktreePathsAtRoot(repo, worktree, rootRead.path, paths, options, memory);
  } finally {
    releaseWorktreeRealpath(rootRead, memory);
  }
}

/** Refresh scan-derived metadata immediately before hashing. */
function refreshPaths(
  worktree: Worktree,
  root: RealPath,
  paths: readonly WorktreePath[],
  memory: WorktreeHashMemory,
): WorktreePath[] {
  const wanted = new Map<string, string>();
  let wantedBytes = 0;
  for (const candidate of paths) {
    memory.add(HASH_COLLECTION_ENTRY_BYTES);
    const absolute = memory.construct(root.length + 1 + candidate.path.length, () =>
      joinPath(root, candidate.path),
    );
    const bytes = HASH_COLLECTION_ENTRY_BYTES + retainedStringBytes(absolute);
    wantedBytes += bytes;
    wanted.set(absolute, candidate.path);
  }
  const refreshed: WorktreePath[] = [];
  if (wanted.size === 0) return refreshed;

  for (const entry of scanWorktreeEntries(worktree, root, undefined, memory)) {
    const relative = wanted.get(entry.path);
    if (relative === undefined) continue;
    const retainedStatBytes =
      HASH_SCAN_ENTRY_BYTES +
      retainedStringBytes(entry.target ?? "") +
      (entry.contentId?.byteLength ?? 0);
    memory.add(retainedStatBytes);
    const { path: scannedPath, ...stat } = entry;
    const candidate = { path: relative, stat };
    refreshed.push(candidate);
    const wantedEntryBytes = HASH_COLLECTION_ENTRY_BYTES + retainedStringBytes(scannedPath);
    wantedBytes -= wantedEntryBytes;
    memory.release(wantedEntryBytes);
    wanted.delete(scannedPath);
    if (wanted.size === 0) break;
  }
  memory.release(wantedBytes);
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
  const reservation = repo.store.reserveMemory();
  try {
    return hashWorktreePathOwned(repo, worktree, relative, reservation, options);
  } finally {
    reservation.dispose();
  }
}

/** Internal single-path hashing under a caller-owned dedicated reservation. */
export function hashWorktreePathOwned(
  repo: Repository,
  worktree: Worktree,
  relative: string,
  reservation: MemoryReservation,
  options: WorktreeHashOptions = {},
): HashedPath | null {
  if (!repo.store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "worktree hash reservation belongs to another repository");
  }
  const memory = new WorktreeHashMemory(reservation);
  const rootRead = readWorktreeRealpath(worktree, repo.root, memory);
  const absolute = memory.construct(rootRead.path.length + 1 + relative.length, () =>
    joinPath(rootRead.path, relative),
  );
  const absoluteBytes = retainedStringBytes(absolute);
  try {
    const stat = worktree.stat(absolute);
    if (stat === null || stat.type === "dir") return null;
    const candidate = { path: relative, stat };
    memory.add(worktreeStatRetainedBytes(stat));
    return (
      hashWorktreePathsAtRoot(repo, worktree, rootRead.path, [candidate], options, memory).get(
        relative,
      ) ?? null
    );
  } finally {
    memory.release(absoluteBytes);
    releaseWorktreeRealpath(rootRead, memory);
  }
}

/** Hash, and optionally store, without ever holding the whole file. */
function hashLargeFile(
  repo: Repository,
  worktree: Worktree,
  absolute: string,
  stat: WorktreeStat,
  options: WorktreeHashOptions,
  memory: WorktreeHashMemory,
): HashedPath {
  const chunks = function* (): Generator<Uint8Array> {
    for (let offset = 0; offset < stat.size; offset += READ_CHUNK) {
      const length = Math.min(READ_CHUNK, stat.size - offset);
      const current = memory.scope();
      current.set("other", HASH_BYTE_ARRAY_BYTES + length);
      try {
        const chunk = worktree.readRange(absolute, offset, length);
        if (chunk.length === 0) break;
        yield chunk;
      } finally {
        current.dispose();
      }
    }
  };
  if (options.write === false) {
    const hashState = memory.scope();
    hashState.set("other", HASH_STATE_BYTES);
    try {
      const hash = new Sha1().update(objectHeader("blob", stat.size));
      for (const chunk of chunks()) hash.update(chunk);
      return { oid: toHex(hash.digest()), mode: gitModeFor(stat), stat };
    } finally {
      hashState.dispose();
    }
  }
  const hashState = memory.scope();
  hashState.set("other", HASH_STATE_BYTES);
  try {
    return {
      oid: repo.store.writeStream("blob", stat.size, chunks),
      mode: gitModeFor(stat),
      stat,
    };
  } finally {
    hashState.dispose();
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
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
  const reservation = repo.store.reserveMemory();
  try {
    yield* dirtyPathStreamOwned(repo, worktree, reservation, paths, limits, excludeRoots);
  } finally {
    reservation.dispose();
  }
}

/** Internal dirty-path scan under a caller-owned dedicated reservation. */
export function* dirtyPathStreamOwned(
  repo: Repository,
  worktree: Worktree,
  reservation: MemoryReservation,
  paths?: string[],
  limits?: DirtyPathLimits,
  excludeRoots: string[] = [],
): Generator<string> {
  if (!repo.store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "dirty-path reservation belongs to another repository");
  }
  let retained = HASH_OWNER_BYTES;
  reservation.set("other", retained);
  const add = (bytes: number): void => {
    const next = retained + bytes;
    reservation.set("other", next);
    retained = next;
  };
  const release = (bytes: number): void => {
    retained -= bytes;
    if (retained < HASH_OWNER_BYTES) throw new Error("dirty-path memory accounting is corrupt");
    reservation.set("other", retained);
  };
  const pathspecMemory = reservation.scope();
  let pathspec: CompiledPathspecMatcher;
  try {
    pathspec = compilePathspecsOwned(paths, pathspecMemory);
  } catch (error) {
    pathspecMemory.dispose();
    reservation.clear("other");
    throw error;
  }
  const excluded: string[] = [];
  let root: RealPath | null = null;
  let rootRead: WorktreeRealpathRead | null = null;
  let scanned: Generator<WorktreePath> | null = null;
  let current: IteratorResult<WorktreePath, void> | null = null;
  const pending: { index: IndexEntry; path: WorktreePath }[] = [];
  let pendingBytes = 0;
  const indexMemory = reservation.scope();
  const worktreeMemory = reservation.scope();
  const scanMemory = new WorktreeHashMemory(worktreeMemory);

  const flush = function* (): Generator<string> {
    if (pending.length === 0) return;
    if (root === null) throw new Error("dirty path scan has no canonical root");
    const batch = pending.splice(0);
    const batchBytes = pendingBytes;
    pendingBytes = 0;
    const flushMemory = reservation.scope();
    flushMemory.set("other", HASH_COLLECTION_ENTRY_BYTES * batch.length * 5);
    try {
      const hashReservation = reservation.scope();
      let dirty: Set<string>;
      try {
        const hashMemory = new WorktreeHashMemory(hashReservation);
        const refreshed = refreshPaths(
          worktree,
          root,
          batch.map((candidate) => candidate.path),
          hashMemory,
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
          if (
            found.stat.contentId !== null &&
            toHex(found.stat.contentId) === candidate.index.oid
          ) {
            continue;
          }
          if (indexMatchesStat(candidate.index, found.stat)) continue;
          needsHash.push(found);
        }

        if (limits !== undefined && needsHash.length > 0) {
          if (needsHash.length > limits.maxHashCandidates - limits.hashCandidates) {
            throw new GitError(
              "E2BIG",
              `dirty-path hashing exceeds ${limits.maxHashCandidates} paths`,
            );
          }
          limits.hashCandidates += needsHash.length;
        }

        const hashes = hashWorktreePathsAtRoot(
          repo,
          worktree,
          root,
          needsHash,
          { write: false },
          hashMemory,
        );
        for (const candidate of needsHash) {
          const found = hashes.get(candidate.path);
          const index = expected.get(candidate.path);
          if (index !== undefined && (found === undefined || found.oid !== index.oid)) {
            dirty.add(candidate.path);
          }
        }
      } finally {
        hashReservation.dispose();
      }
      for (const candidate of batch) {
        if (dirty.has(candidate.index.path)) yield candidate.index.path;
      }
    } finally {
      flushMemory.dispose();
      release(batchBytes);
    }
  };

  try {
    for (const path of excludeRoots) {
      const current = reservation.scope();
      current.set("other", retainedStringUnits(path.length));
      try {
        const relative = relativeTo(repo.root, path);
        if (relative === null || relative === "") continue;
        const bytes = HASH_COLLECTION_ENTRY_BYTES + retainedStringBytes(relative);
        add(bytes);
        excluded.push(relative);
      } finally {
        current.dispose();
      }
    }
    for (const entry of indexScanOwned(repo.checkout, indexMemory)) {
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
        rootRead = readWorktreeRealpath(worktree, repo.root, scanMemory);
        root = rootRead.path;
        scanned = scanDirtyWorktreeEntries(
          worktree,
          repo.root,
          rootRead.path,
          limits,
          excludeRoots,
          scanMemory,
        );
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
      const bytes =
        HASH_COLLECTION_ENTRY_BYTES +
        worktreePathRetainedBytes({ path: entry.path, stat }) +
        retainedStringBytes(entry.path) +
        retainedStringBytes(entry.oid);
      add(bytes);
      pendingBytes += bytes;
      const path = { path: entry.path, stat };
      pending.push({ index: entry, path });
      current = scanned.next();
      if (pending.length >= HASH_BATCH) yield* flush();
    }
    yield* flush();
  } finally {
    if (rootRead !== null) releaseWorktreeRealpath(rootRead, scanMemory);
    worktreeMemory.dispose();
    indexMemory.dispose();
    pathspecMemory.dispose();
  }
}

function* scanDirtyWorktreeEntries(
  worktree: Worktree,
  lexicalRoot: string,
  canonicalRoot: RealPath,
  limits: DirtyPathLimits | undefined,
  excludeRoots: string[],
  memory: WorktreeHashMemory,
): Generator<WorktreePath> {
  if (excludeRoots.length === 0) {
    for (const stat of scanWorktreeEntries(worktree, canonicalRoot, limits, memory)) {
      const current = memory.scope();
      current.set("other", WORKTREE_DECODED_ROW_BYTES + retainedStringUnits(stat.path.length));
      try {
        const path = relativeTo(canonicalRoot, stat.path);
        if (path !== null) {
          current.set("other", WORKTREE_DECODED_ROW_BYTES + retainedStringBytes(path));
          yield { path, stat: statFromScan(stat) };
        }
      } finally {
        current.dispose();
      }
    }
    return;
  }
  const ownedWalk = memory.scope();
  try {
    for (const entry of walkWorktreeEntriesStreamOwned(worktree, lexicalRoot, ownedWalk, {
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
  } finally {
    ownedWalk.dispose();
  }
}

/** Files and symlinks from a paged scan over an already canonical root. */
function* scanWorktreeEntries(
  worktree: Worktree,
  root: RealPath,
  limits?: DirtyPathLimits,
  memory?: WorktreeHashMemory,
): Generator<ScanEntry> {
  let after: string | undefined;
  let pageMemory: MemoryReservation | null = null;
  let cursorMemory: MemoryReservation | null = null;
  try {
    while (true) {
      const read = readWorktreeScanPage(
        worktree,
        root,
        { after, filesOnly: true, limit: WORKTREE_SCAN_PAGE },
        memory,
      );
      const page = read.page;
      pageMemory?.dispose();
      pageMemory = read.pageMemory;
      cursorMemory?.dispose();
      cursorMemory = null;
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
      if (after !== undefined && memory !== undefined) {
        cursorMemory = memory.scope();
        cursorMemory.set("other", retainedStringBytes(after));
      }
    }
  } finally {
    cursorMemory?.dispose();
    pageMemory?.dispose();
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
