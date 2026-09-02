import { GitError, PathspecNotFoundError } from "../common/errors.js";
import { comparePaths, isPathRoot, joinPath, relativeTo } from "../common/paths.js";
import { joinSorted3 } from "../common/streams.js";
import { applyIndexOwned } from "../store/checkout.js";
import { type IndexEntry, indexScanOwned } from "../store/index.js";
import type { Repository } from "./repository.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";
import {
  hashExactWorktreePathsOwned,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io.js";

export const ADD_RETAINED_BYTES = 16 * 1024 * 1024;

export function structuralStringBytes(value: string): number {
  return 48 + value.length * 2;
}

export function relativeExcludeRoots(root: string, paths: readonly string[] | undefined): string[] {
  const relatives: string[] = [];
  for (const path of paths ?? []) {
    const relative = relativeTo(root, path);
    if (relative === null || relative === "") continue;
    relatives.push(relative);
  }
  return relatives;
}

export function isExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathRoot(root, path));
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
const RM_CANDIDATE_FIXED_BYTES = 320;
const RM_DIRECTORY_FIXED_BYTES = 96;
const RM_SPEC_FIXED_BYTES = 192;
const RM_ARRAY_ENTRY_BYTES = 8;
const RM_REMOVE_BINDING_BYTES = 1_000_000;
const RM_EXECUTION_HEADROOM_BYTES = 4 * 1024 * 1024;

/** Remove tracked paths with Git's HEAD/index/worktree safety checks. */
export function rm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  runRm(repo, worktree, options);
}

function runRm(repo: Repository, worktree: Worktree, options: RmOptions): void {
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
      walkWorktreeEntriesStreamOwned(worktree, repo.root, {
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
      structuralStringBytes(selected.path) +
      structuralStringBytes(selected.entry?.oid ?? "") +
      structuralStringBytes(row.a?.oid ?? "") +
      structuralStringBytes(row.c?.stat.target ?? "") +
      (row.c?.stat.contentId?.byteLength ?? 0);
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

  repo.store.db.transactionSync(() => {
    if (!cached) {
      removeRmWorktreePaths(worktree, physicalRmPaths(repo, candidates), false);
      removeRmWorktreePaths(worktree, absoluteRmPaths(repo, pruned), true);
    }
    applyIndexOwned(repo.checkout, (sink) => {
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
  for (const entry of boundedRmRows(indexScanOwned(repo.checkout), "index")) {
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
    let path: string;
    let directoryOnly: boolean;
    path = raw;
    while (path.startsWith("./")) path = path.slice(2);
    directoryOnly = path === "." || path.endsWith("/");
    while (path.endsWith("/")) path = path.slice(0, -1);
    if (path === ".") {
      path = "";
      directoryOnly = true;
    }
    const seen = directoryOnly ? directories : files;
    if (seen.has(path)) continue;
    const additional = RM_SPEC_FIXED_BYTES + RM_ARRAY_ENTRY_BYTES + structuralStringBytes(path);
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
  return {
    specs,
    index: { files, directories },
    retained,
  };
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
    if (candidate.worktree === undefined) continue;
    yield joinPath(repo.root, candidate.path);
  }
}

function* absoluteRmPaths(repo: Repository, paths: readonly string[]): Generator<string> {
  for (const path of paths) yield joinPath(repo.root, path);
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
