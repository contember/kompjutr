// Staging: moving working-tree facts into the SQL index.
//
// The index is rows, so staging writes one row per *changed* path instead
// of rewriting a whole `.git/index` blob. The only work proportional to the
// tracked-file count is the single `SELECT` over `git_index` — everything
// after that is bounded by what actually changed.

import { contentIdKey, type IndexEntry, type IndexSink } from "../../sqlite/store.js";
import { GitError, PathspecNotFoundError } from "../errors.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths, joinSorted, joinSorted3 } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { checkoutTree, indexFromTree, matchesPaths } from "./checkout.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import {
  hashExactWorktreePaths,
  hashWorktreePaths,
  indexEntryFor,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
  worktreeHashRangeReads,
} from "./worktree-io.js";

const ADD_WINDOW_ROWS = 1000;
const ADD_RETAINED_BYTES = 16 * 1024 * 1024;
const INDEX_ROW_FIXED_BYTES = 256;
const PATH_ENTRY_FIXED_BYTES = 96;

interface AddIndexPath {
  path: string;
  entry: IndexEntry | undefined;
}

interface AddIndexSnapshot {
  paths: AddIndexPath[];
  conflicted: Set<string>;
}

interface StageCandidate {
  path: string;
  existing: IndexEntry | undefined;
  worktree: WorktreePath;
  conflicted: boolean;
}

export interface AddOptions {
  /** Repo-relative pathspecs. Empty is a no-op, like `git add` with no arguments. */
  paths: string[];
  /** Stage every change under the repository, ignoring `paths`. */
  all?: boolean;
  /** Restrict `all` to paths already in HEAD — the `commit -a` semantics. */
  trackedOnly?: boolean;
  /** Stage a path even when `.gitignore` matches it. */
  force?: boolean;
  /**
   * Roots of nested repositories, from `nestedRoots(context, repo.root)`.
   * The ops layer has no `GitContext`, so the caller resolves them.
   */
  excludeRoots?: string[];
}

/**
 * Stage working-tree changes into the index.
 *
 * A pathspec stages removals under it too, the way `git add <dir>` has
 * since git 2.0; `all` does the same across the whole repository.
 */
export function add(repo: Repository, worktree: Worktree, options: AddOptions): void {
  const all = options.all === true;
  const specs = normalizeSpecs(options.paths);
  if (!all && specs.length === 0) return;

  const force = options.force === true;
  const trackedOnly = all && options.trackedOnly === true;
  if (!all) assertPathspecsMatch(repo, worktree, specs);

  const snapshot = snapshotAddIndex(repo, all ? undefined : specs);
  let ignores: IgnoreMatcher | undefined;
  const isIgnored = (path: string): boolean => {
    if (force) return false;
    ignores ??= loadIgnoreMatcher(worktree, repo.root);
    return ignores.ignores(path, false);
  };
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  const walked = walkWorktreeEntriesStream(worktree, repo.root, {
    paths: all ? undefined : specs,
    includeIgnored: true,
  });
  // `commit -a` never adds a path HEAD does not already have.
  const head = trackedOnly ? treeStream(repo, repo.headTree()) : [];

  repo.store.indexApply((sink) => {
    const pending: StageCandidate[] = [];
    const flush = (): void => stageCandidates(repo, worktree, pending, sink);
    for (const row of joinSorted3(walked, snapshot.paths, head, {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    })) {
      if (trackedOnly && row.c === undefined) continue;
      const existing = row.b?.entry;

      if (row.a !== undefined) {
        if (row.b === undefined && isExcluded(row.path, excluded)) continue;
        if (row.b === undefined && isIgnored(row.path)) continue;
        const conflicted = snapshot.conflicted.has(row.path);
        if (!conflicted && existing !== undefined && indexMatchesStat(existing, row.a.stat)) {
          continue;
        }
        pending.push({ path: row.path, existing, worktree: row.a, conflicted });
        if (pending.length >= ADD_WINDOW_ROWS) flush();
        continue;
      }

      // A conflict-only path has no stage-zero row but still needs removal.
      if (row.b === undefined) continue;
      if (!all && !matchesPaths(row.path, specs)) continue;
      sink.remove(row.path);
    }
    flush();
  });
}

function snapshotAddIndex(repo: Repository, specs: string[] | undefined): AddIndexSnapshot {
  const paths: AddIndexPath[] = [];
  const conflicted = new Set<string>();
  let retained = 0;
  let current: AddIndexPath | null = null;
  for (const entry of repo.store.indexScan()) {
    if (specs !== undefined && !matchesPaths(entry.path, specs)) continue;
    retained +=
      INDEX_ROW_FIXED_BYTES + retainedStringBytes(entry.path) + retainedStringBytes(entry.oid);
    if (retained > ADD_RETAINED_BYTES) {
      throw new GitError("E2BIG", `add retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
    }
    if (current === null || current.path !== entry.path) {
      current = { path: entry.path, entry: entry.stage === 0 ? entry : undefined };
      paths.push(current);
      retained += PATH_ENTRY_FIXED_BYTES + retainedStringBytes(entry.path);
    } else if (entry.stage === 0) {
      current.entry = entry;
    }
    if (entry.stage !== 0 && !conflicted.has(entry.path)) {
      retained += PATH_ENTRY_FIXED_BYTES;
      conflicted.add(entry.path);
    }
    if (retained > ADD_RETAINED_BYTES) {
      throw new GitError("E2BIG", `add retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
    }
  }
  return { paths, conflicted };
}

function stageCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: StageCandidate[],
  sink: IndexSink,
): void {
  if (candidates.length === 0) return;
  const rows = candidates.splice(0);
  const identities = repo.store.lookupBlobIds(
    rows.flatMap((row) => {
      if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat))
        return [];
      const contentId = row.worktree.stat.contentId;
      return contentId === null ? [] : [contentId];
    }),
  );
  const unresolved: WorktreePath[] = [];
  const mapped = new Map<string, string>();
  for (const row of rows) {
    if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) continue;
    const contentId = row.worktree.stat.contentId;
    const oid = contentId === null ? undefined : identities.get(contentIdKey(contentId));
    if (oid === undefined) unresolved.push(row.worktree);
    else mapped.set(row.path, oid);
  }
  const hashes = hashWorktreePaths(repo, worktree, unresolved);
  repo.store.upsertBlobIds(
    [...hashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );

  for (const row of rows) {
    let update: IndexEntry | null = null;
    if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) {
      update = indexEntryFor(row.path, {
        oid: row.existing.oid,
        mode: row.existing.mode.toString(8).padStart(6, "0"),
        stat: row.worktree.stat,
      });
    } else {
      const hashed = hashes.get(row.path);
      const oid = mapped.get(row.path);
      if (hashed !== undefined) update = indexEntryFor(row.path, hashed);
      else if (oid !== undefined) {
        update = indexEntryFor(row.path, {
          oid,
          mode: gitModeFor(row.worktree.stat),
          stat: row.worktree.stat,
        });
      }
    }
    if (update === null) {
      if (row.existing !== undefined || row.conflicted) sink.remove(row.path);
      continue;
    }
    if (row.conflicted) sink.remove(row.path);
    sink.put(update);
  }
}

function relativeExcludeRoots(root: string, paths: readonly string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => {
    const relative = relativeTo(root, path);
    return relative === null || relative === "" ? [] : [relative];
  });
}

function isExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export interface RmOptions {
  /** Repo-relative pathspecs. Empty is a no-op. */
  paths: string[];
  /** Remove only index rows and leave working-tree bytes in place. */
  cached?: boolean;
  /** Bypass content safety, but never bounds or pathspec matching. */
  force?: boolean;
  /** Permit a pathspec to select descendants of a directory. */
  recursive?: boolean;
  /** Roots of nested repositories that this operation must not cross. */
  excludeRoots?: string[];
}

interface RmIndexPath {
  path: string;
  entry: IndexEntry | undefined;
  conflicted: boolean;
}

interface RmSpec {
  path: string;
  directoryOnly: boolean;
  matched: boolean;
  directoryMatch: boolean;
  worktreeDirectory: boolean;
}

interface RmSpecIndex {
  files: Map<string, RmSpec>;
  directories: Map<string, RmSpec>;
}

interface RmCandidate {
  path: string;
  head: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
  conflicted: boolean;
  worktreeMatchesIndex: boolean;
}

const RM_WINDOW_ROWS = 1_000;
const RM_MAX_ROWS_PER_STREAM = 50_000;
const RM_MAX_PATHSPECS = 10_000;
const RM_MAX_PATH_BYTES = 2_200;
const RM_MAX_HASH_CANDIDATES = 10_000;
const RM_MAX_HASH_BYTES = 32 * 1024 * 1024;
const RM_MAX_HASH_RANGE_READS = 64;
const RM_MAX_HASH_BATCHES = 16;
const RM_CANDIDATE_FIXED_BYTES = 320;
const RM_DIRECTORY_FIXED_BYTES = 96;
const RM_SPEC_FIXED_BYTES = 192;
const RM_ARRAY_ENTRY_BYTES = 8;
const RM_REMOVE_BINDING_BYTES = 1_000_000;
const RM_EXECUTION_HEADROOM_BYTES = 4 * 1024 * 1024;

/** Remove tracked paths with Git's HEAD/index/worktree safety checks. */
export function rm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  const normalized = normalizeRmSpecs(options.paths);
  const specs = normalized.specs;
  if (specs.length === 0) return;

  const cached = options.cached === true;
  const force = options.force === true;
  const recursive = options.recursive === true;
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  const candidates: RmCandidate[] = [];
  const removed = new Set<string>();
  let retained = normalized.retained;

  for (const row of joinSorted3(
    boundedRmRows(treeStream(repo, repo.headTree()), "HEAD"),
    rmIndexPaths(repo, normalized.index, excluded),
    boundedRmRows(
      walkWorktreeEntriesStream(worktree, repo.root, {
        excludeRoots: options.excludeRoots,
        includeIgnored: true,
        includeDirectories: true,
      }),
      "worktree",
    ),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    const selected = row.b;
    if (selected === undefined) continue;
    noteRmMatches(normalized.index, selected.path, row.c?.stat.type === "dir");
    retained +=
      RM_CANDIDATE_FIXED_BYTES +
      retainedStringBytes(selected.path) +
      retainedStringBytes(selected.entry?.oid ?? "") +
      retainedStringBytes(row.a?.oid ?? "") +
      retainedStringBytes(row.c?.stat.target ?? "");
    requireRmRetained(retained);
    removed.add(selected.path);
    candidates.push({
      path: selected.path,
      head: row.a,
      index: selected.entry,
      worktree: row.c,
      conflicted: selected.conflicted,
      worktreeMatchesIndex: false,
    });
  }

  // Git resolves structural and unmatched errors in caller pathspec order.
  for (const spec of specs) {
    if (spec.worktreeDirectory) {
      throw new GitError(
        "EISDIR",
        `tracked file '${displayRmSpec(spec)}' is a directory in the working tree`,
      );
    }
    if (!spec.matched) throw new PathspecNotFoundError(displayRmSpec(spec));
    if (!recursive && spec.directoryMatch) throw rmDirectoryError(spec);
  }
  if (candidates.length === 0) return;

  if (!force) {
    identifyRmWorktree(repo, worktree, candidates);
    for (const candidate of candidates) {
      if (candidate.conflicted) continue;
      const entry = candidate.index;
      if (entry === undefined) {
        throw new GitError("EUNSAFEREMOVE", `cannot prove index state for '${candidate.path}'`);
      }
      const headMatches =
        candidate.head !== undefined &&
        candidate.head.oid === entry.oid &&
        Number.parseInt(candidate.head.mode, 8) === entry.mode;
      const missingWorktree = candidate.worktree === undefined;
      const safe = cached
        ? headMatches || candidate.worktreeMatchesIndex
        : missingWorktree || (headMatches && candidate.worktreeMatchesIndex);
      if (!safe) {
        throw new GitError(
          "EUNSAFEREMOVE",
          `path '${candidate.path}' has staged or working-tree changes`,
        );
      }
    }
  }

  let pruned: string[] = [];
  if (!cached) {
    const planned = planRmDirectoryPrune(
      repo,
      worktree,
      candidates,
      removed,
      options.excludeRoots,
      retained,
    );
    pruned = planned.directories;
    retained = planned.retained;
  }
  requireRmRetained(retained);

  if (!cached) {
    for (const candidate of candidates) {
      if (candidate.worktree === undefined) continue;
      validateRmRemovalPath(joinPath(repo.root, candidate.path));
    }
    for (const directory of pruned) validateRmRemovalPath(joinPath(repo.root, directory));
  }

  repo.store.db.transactionSync(() => {
    if (!cached) {
      removeRmWorktreePaths(worktree, physicalRmPaths(repo, candidates), false);
      removeRmWorktreePaths(worktree, absoluteRmPaths(repo, pruned), true);
    }
    repo.store.indexApply((sink) => {
      for (const candidate of candidates) sink.remove(candidate.path);
    });
  });
}

function* rmIndexPaths(
  repo: Repository,
  specs: RmSpecIndex,
  excluded: readonly string[],
): Generator<RmIndexPath> {
  let current: RmIndexPath | null = null;
  for (const entry of boundedRmRows(repo.store.indexScan(), "index")) {
    if (!matchesRmSpecs(specs, entry.path) || isExcluded(entry.path, excluded)) continue;
    if (current === null || current.path !== entry.path) {
      if (current !== null) yield current;
      current = {
        path: entry.path,
        entry: entry.stage === 0 ? entry : undefined,
        conflicted: entry.stage !== 0,
      };
      continue;
    }
    if (entry.stage === 0) current.entry = entry;
    else current.conflicted = true;
  }
  if (current !== null) yield current;
}

function identifyRmWorktree(repo: Repository, worktree: Worktree, candidates: RmCandidate[]): void {
  let hashCandidates = 0;
  let hashBytes = 0;
  let hashRangeReads = 0;
  let hashBatches = 0;

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
    hashBatches++;
    hashCandidates += authoritative.length;
    hashRangeReads += worktreeHashRangeReads(authoritative);
    for (const candidate of authoritative) hashBytes += candidate.stat.size;
    if (
      hashBatches > RM_MAX_HASH_BATCHES ||
      hashCandidates > RM_MAX_HASH_CANDIDATES ||
      hashBytes > RM_MAX_HASH_BYTES ||
      hashRangeReads > RM_MAX_HASH_RANGE_READS
    ) {
      throw new GitError("E2BIG", "rm working-tree safety proof exceeds its structural limit");
    }
    const hashes = hashExactWorktreePaths(repo, worktree, authoritative, { write: false });
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

function planRmDirectoryPrune(
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
      retained += RM_DIRECTORY_FIXED_BYTES + retainedStringBytes(directory);
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
    walkWorktreeEntriesStream(worktree, repo.root, {
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
    const depth = right.split("/").length - left.split("/").length;
    return depth === 0 ? comparePaths(left, right) : depth;
  });
  return { directories: pruned, retained };
}

function normalizeRmSpecs(paths: readonly string[]): {
  specs: RmSpec[];
  index: RmSpecIndex;
  retained: number;
} {
  if (paths.length > RM_MAX_PATHSPECS) {
    throw new GitError("E2BIG", `rm pathspec count exceeds ${RM_MAX_PATHSPECS}`);
  }
  const specs: RmSpec[] = [];
  const files = new Map<string, RmSpec>();
  const directories = new Map<string, RmSpec>();
  let retained = RM_EXECUTION_HEADROOM_BYTES;
  for (const raw of paths) {
    if (utf8Length(raw) > RM_MAX_PATH_BYTES) {
      throw new GitError("E2BIG", `rm pathspec exceeds ${RM_MAX_PATH_BYTES} UTF-8 bytes`);
    }
    let path = raw;
    while (path.startsWith("./")) path = path.slice(2);
    let directoryOnly = path === "." || path.endsWith("/");
    while (path.endsWith("/")) path = path.slice(0, -1);
    if (path === ".") {
      path = "";
      directoryOnly = true;
    }
    const seen = directoryOnly ? directories : files;
    if (seen.has(path)) continue;
    const additional = RM_SPEC_FIXED_BYTES + RM_ARRAY_ENTRY_BYTES + retainedStringBytes(path);
    requireRmRetained(retained + additional);
    retained += additional;
    const spec: RmSpec = {
      path,
      directoryOnly,
      matched: false,
      directoryMatch: false,
      worktreeDirectory: false,
    };
    seen.set(path, spec);
    specs.push(spec);
  }
  return { specs, index: { files, directories }, retained };
}

function matchesRmSpecs(specs: RmSpecIndex, path: string): boolean {
  return visitMatchingRmSpecs(specs, path, () => {});
}

function noteRmMatches(specs: RmSpecIndex, path: string, worktreeDirectory: boolean): void {
  visitMatchingRmSpecs(specs, path, (spec) => {
    spec.matched = true;
    if (spec.directoryOnly || path !== spec.path) spec.directoryMatch = true;
    if (!spec.directoryOnly && path === spec.path && worktreeDirectory) {
      spec.worktreeDirectory = true;
    }
  });
}

function visitMatchingRmSpecs(
  specs: RmSpecIndex,
  path: string,
  visit: (spec: RmSpec) => void,
): boolean {
  let matched = false;
  const found = (spec: RmSpec | undefined): void => {
    if (spec === undefined) return;
    matched = true;
    visit(spec);
  };
  found(specs.files.get(""));
  found(specs.directories.get(""));
  found(specs.files.get(path));
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    found(specs.files.get(prefix));
    found(specs.directories.get(prefix));
  }
  return matched;
}

function displayRmSpec(spec: RmSpec): string {
  if (spec.path === "") return ".";
  return spec.directoryOnly ? `${spec.path}/` : spec.path;
}

function rmDirectoryError(spec: RmSpec): GitError {
  return new GitError(
    "EISDIR",
    `not removing '${displayRmSpec(spec)}' recursively without recursive`,
  );
}

function* physicalRmPaths(repo: Repository, candidates: readonly RmCandidate[]): Generator<string> {
  for (const candidate of candidates) {
    if (candidate.worktree !== undefined) yield joinPath(repo.root, candidate.path);
  }
}

function* absoluteRmPaths(repo: Repository, paths: readonly string[]): Generator<string> {
  for (const path of paths) yield joinPath(repo.root, path);
}

function validateRmRemovalPath(path: string): void {
  if (utf8Length(JSON.stringify(path)) + 3 > RM_REMOVE_BINDING_BYTES) {
    throw new GitError("E2BIG", "rm filesystem path exceeds its binding limit");
  }
}

function removeRmWorktreePaths(
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
    const itemBytes = utf8Length(JSON.stringify(path));
    if (batch.length > 0 && bytes + itemBytes + 1 > RM_REMOVE_BINDING_BYTES) flush();
    batch.push(path);
    bytes += itemBytes + 1;
  }
  flush();
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes++;
    else if (unit <= 0x7ff) bytes += 2;
    else if ((unit & 0xfc00) === 0xd800 && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function* boundedRmRows<T>(rows: Iterable<T>, label: string): Generator<T> {
  let count = 0;
  for (const row of rows) {
    if (count >= RM_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `rm ${label} scan exceeds ${RM_MAX_ROWS_PER_STREAM} rows`);
    }
    count++;
    yield row;
  }
}

function requireRmRetained(bytes: number): void {
  if (bytes > ADD_RETAINED_BYTES) {
    throw new GitError("E2BIG", `rm retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
  }
}

export interface ResetOptions {
  /** Unstage these paths back to `ref`, leaving the working tree alone. */
  paths?: string[];
  /** Move the current branch to `ref` and rewrite index and working tree. */
  hard?: boolean;
  /** Commit-ish to reset to. Defaults to HEAD. */
  ref?: string;
}

/**
 * `paths` and `hard` are documented as mutually exclusive; `hard` wins if
 * both arrive. A bare reset unstages everything without moving any ref.
 */
export function reset(repo: Repository, worktree: Worktree, options: ResetOptions = {}): void {
  if (options.hard === true) {
    hardReset(repo, worktree, options.ref);
    return;
  }

  const specs = normalizeSpecs(options.paths ?? []);
  const tree = targetTree(repo, options.ref);
  if (specs.length === 0) {
    // This one genuinely replaces the whole index, so the big hammer fits.
    repo.store.indexReplace(indexFromTree(repo, tree));
    return;
  }

  // Tree and index are both path-ordered, so one merge decides each path.
  repo.store.indexApply((sink) => {
    for (const row of joinSorted(indexFromTree(repo, tree), repo.store.indexScan(), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      if (!matchesPaths(row.path, specs)) continue;
      // A conflicted path repeats across stages; clearing it once is enough,
      // and indexPut only ever overwrites stage 0.
      if (row.right !== undefined && row.right.stage !== 0) sink.remove(row.path);
      if (row.left === undefined) {
        if (row.right !== undefined) sink.remove(row.path);
        continue;
      }
      sink.put(row.left);
    }
  });
}

/** Paths in the index, sorted. The `--ref` form is `lsFilesAtRef`. */
export function lsFiles(repo: Repository): string[] {
  const out: string[] = [];
  let previous: string | null = null;
  for (const entry of repo.store.indexScan()) {
    // Conflict stages repeat the path; callers want it once.
    if (entry.path === previous) continue;
    out.push(entry.path);
    previous = entry.path;
  }
  // The scan already returns them in order.
  return out;
}

/** Restore index and working tree to `ref`, dragging the current branch along. */
function hardReset(repo: Repository, worktree: Worktree, ref?: string): void {
  const commit = targetCommit(repo, ref);
  const tree = commit === null ? null : repo.readCommit(commit).tree;
  const head = repo.head();
  if (commit !== null && head.ref !== null) repo.store.setRef(head.ref, commit);
  checkoutTree(repo, worktree, tree, {
    discardUnmerged: true,
    restoreStructure: true,
  });
}

function targetCommit(repo: Repository, ref?: string): string | null {
  if (ref === undefined || ref === "HEAD") {
    const { oid } = repo.head();
    return oid === null ? null : repo.peel(oid);
  }
  return repo.peel(repo.revParse(ref));
}

function targetTree(repo: Repository, ref?: string): string | null {
  const commit = targetCommit(repo, ref);
  return commit === null ? null : repo.readCommit(commit).tree;
}

/** Repo-relative pathspecs, without the "./" and trailing-slash noise. */
function normalizeSpecs(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let spec = raw.trim();
    while (spec.startsWith("./")) spec = spec.slice(2);
    spec = spec.replace(/\/+$/, "");
    if (spec === ".") spec = "";
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

/**
 * Real git exits 128 with `pathspec '<x>' did not match any files`. A path
 * that exists but is ignored is not that case: `add` skips it silently,
 * which is what isomorphic-git does and therefore what Computer promises.
 *
 * Checked before the walk, and in O(pathspecs): anything the walk would
 * match lives under a directory that exists on disk, and anything tracked
 * shows up in a prefix scan of the index. Neither needs the whole tree.
 */
function assertPathspecsMatch(repo: Repository, worktree: Worktree, specs: string[]): void {
  for (const spec of specs) {
    if (spec === "") continue;
    if (worktree.stat(joinPath(repo.root, spec)) !== null) continue;
    const tracked = repo.store.indexScan({ prefix: spec, pageSize: 1 }).next();
    if (tracked.done !== true) continue;
    throw new PathspecNotFoundError(spec);
  }
}
