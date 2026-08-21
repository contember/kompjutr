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
const SCAN_PAGE = 1000;

/** Files held while one bulk hash pass is assembled. */
const HASH_BATCH = 1000;

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
  /** Skip directory rows when no directory-level pruning is needed. */
  filesOnly?: boolean;
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
  if (
    options.filesOnly === true &&
    ((options.excludeRoots?.length ?? 0) > 0 ||
      (options.paths?.length ?? 0) > 0 ||
      options.ignores !== undefined)
  ) {
    throw new Error("files-only worktree walks cannot prune directories");
  }
  const lexicalRoot = root.replace(/\/+$/, "") || "/";
  const base = worktree.realpath(lexicalRoot);
  const excluded = new Set(
    (options.excludeRoots ?? []).map((path) => {
      const relative = relativeTo(lexicalRoot, path);
      return relative === null ? path.replace(/\/+$/, "") : joinPath(base, relative);
    }),
  );
  let after: string | undefined;
  let afterSubtree: string | undefined;
  const pruned: Array<{ directory: string; lower: string; upper: string }> = [];

  while (true) {
    const entries =
      afterSubtree === undefined
        ? worktree.scan(base, { after, filesOnly: options.filesOnly, limit: SCAN_PAGE })
        : worktree.scan(base, {
            afterSubtree,
            filesOnly: options.filesOnly,
            limit: SCAN_PAGE,
          });
    afterSubtree = undefined;
    if (entries.length === 0) return;

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry === undefined) continue;
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
        const outsidePathspec = !withinPathspec(relative, options.paths, true);
        // git never descends into an ignored directory, which is also why a
        // re-include below one cannot take effect.
        const ignored =
          options.includeIgnored !== true && options.ignores?.ignores(relative, true) === true;
        if (outsidePathspec || ignored) {
          pruned.push(prunedRange(entry.path));
        }
        continue;
      }

      if (!withinPathspec(relative, options.paths, false)) continue;
      if (options.includeIgnored !== true && options.ignores?.ignores(relative, false) === true) {
        continue;
      }
      yield { path: relative, stat: statFromScan(entry) };
    }

    if (entries.length < SCAN_PAGE) return;

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
export function dirtyPaths(repo: Repository, worktree: Worktree, paths?: string[]): string[] {
  return [...dirtyPathStream(repo, worktree, paths)];
}

/** The same comparison, lazily, over a paged index scan. */
export function* dirtyPathStream(
  repo: Repository,
  worktree: Worktree,
  paths?: string[],
): Generator<string> {
  let root: string | null = null;
  let scanned: Generator<ScanEntry> | null = null;
  let current: IteratorResult<ScanEntry, void> | null = null;
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

  for (const entry of repo.store.indexScan()) {
    if (entry.stage !== 0) continue;
    if (paths !== undefined && !withinPathspec(entry.path, paths, false)) continue;

    if (scanned === null) {
      const canonical = worktree.realpath(repo.root);
      root = canonical;
      scanned = scanWorktreeEntries(worktree, canonical);
      current = scanned.next();
    }
    if (root === null || current === null) throw new Error("dirty path scan has no cursor");

    let cursor: IteratorResult<ScanEntry, void> = current;
    while (cursor.done !== true) {
      const relative = relativeTo(root, cursor.value.path);
      if (relative === null || comparePaths(relative, entry.path) < 0) cursor = scanned.next();
      else break;
    }
    current = cursor;
    if (cursor.done === true) {
      yield* flush();
      yield entry.path;
      continue;
    }
    const relative = relativeTo(root, cursor.value.path);
    if (relative !== entry.path) {
      yield* flush();
      yield entry.path;
      continue;
    }

    const stat = cursor.value;
    current = scanned.next();
    pending.push({ index: entry, path: { path: entry.path, stat } });
    if (pending.length >= HASH_BATCH) yield* flush();
  }
  yield* flush();
}

/** Files and symlinks from a paged scan over an already canonical root. */
function* scanWorktreeEntries(worktree: Worktree, root: string): Generator<ScanEntry> {
  let after: string | undefined;
  while (true) {
    const page = worktree.scan(root, { after, filesOnly: true, limit: SCAN_PAGE });
    if (page.length === 0) return;
    yield* page;
    if (page.length < SCAN_PAGE) return;
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
