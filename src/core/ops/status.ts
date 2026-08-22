// `status`, its three formatters, and `clean`.
//
// The cost model is the point: one `treeEntries` walk answers HEAD for
// every path, a bounded index prepass answers tracked-directory membership,
// and a paged index stream answers the merge. A file is hashed only when the
// stat data cached in `git_index` no longer holds. A repeated status over an
// untouched tree therefore reads no file content at all.

import type { IndexEntry } from "../../sqlite/store.js";
import type { GitContext } from "../context.js";
import { GitError } from "../errors.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths, joinSorted3 } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { matchesPaths, treeEntries } from "./checkout.js";
import type { StatusEntry, StatusRow } from "./kinds.js";
import {
  type BufferedStatusRow,
  flushStatusRows,
  type StatusDetail,
  type StatusOptions,
  trackedRow,
  untrackedRow,
} from "./status-rows.js";
import { FullStatusTrackerSeed, sparseStatus } from "./status-sparse.js";
import { treeStream } from "./tree-stream.js";
import {
  hashWorktreePath,
  indexMatchesStat,
  type WorktreePath,
  walkWorktree,
  walkWorktreeEntriesStream,
  walkWorktreeStream,
} from "./worktree-io.js";

export type { StatusDetail, StatusOptions } from "./status-rows.js";

/** Retained index, directory and tracked-path state for one status call. */
export const STATUS_RETAINED_BYTES = 16 * 1024 * 1024;
const STATUS_WINDOW_ROWS = 1000;
const DIRECTORY_FIXED_BYTES = 96;
const SET_ENTRY_BYTES = 48;

interface StatusIndexSnapshot {
  trackedDirs: Set<string>;
  trackedPaths: Set<string>;
  budget: RetainedStatusBudget;
  retainsTrackedPaths: boolean;
}

class RetainedStatusBudget {
  #bytes = 0;

  constructor(private readonly limit: number) {}

  add(bytes: number): void {
    if (bytes > this.limit - this.#bytes) {
      throw new GitError("E2BIG", `status retained state exceeds ${this.limit} bytes`);
    }
    this.#bytes += bytes;
  }
}

export function status(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusDetail[] {
  // Sorted over the rows, which is the output — a collapsed `dir/` entry
  // does not sort where the file that produced it did.
  return [...statusStream(repo, worktree, options)].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
}

/** Eager status with an optional same-database sparse fast path. */
export function eagerStatus(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  context: Pick<GitContext, "sparseWorkspace" | "indexTracker">,
): StatusDetail[] {
  const source = context.sparseWorkspace;
  const tracker = context.indexTracker;
  if (
    source === undefined ||
    tracker === undefined ||
    (options.paths?.length ?? 0) > 0 ||
    (options.excludeRoots?.length ?? 0) > 0
  ) {
    return status(repo, worktree, options);
  }

  const state = source.readState(repo.store.repoId);
  if (!state.available) {
    const baselineTreeOid = repo.headTree();
    const seed = new FullStatusTrackerSeed();
    const rows = [...statusStreamInternal(repo, worktree, options, baselineTreeOid, seed)].sort(
      (left, right) => comparePaths(left.path, right.path),
    );
    if (seed.resealable) {
      tracker.reseal(repo.store.repoId, baselineTreeOid, seed.entries());
    }
    return rows;
  }

  const sparse = sparseStatus(repo, worktree, options, context, state.baselineTreeOid);
  return sparse ?? status(repo, worktree, options);
}

/**
 * The same rows, lazily. HEAD, the index and the working tree are all
 * path-ordered, so one three-way merge answers every path with one item of
 * state per side instead of two maps and a materialised walk.
 *
 * What is still proportional to the repository: tracked path keys and the set
 * of directories that hold something tracked, which `-unormal` collapsing
 * has to know before it can decide. Full index rows remain paged.
 */
export function* statusStream(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): Generator<StatusDetail> {
  yield* statusStreamInternal(repo, worktree, options, repo.headTree());
}

function* statusStreamInternal(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  headTreeOid: string | null,
  seed?: FullStatusTrackerSeed,
): Generator<StatusDetail> {
  const collapse = (options.untrackedFiles ?? "normal") === "normal";
  const excluded = excludedRoots(repo.root, options.excludeRoots);
  const snapshot = snapshotStatusIndex(repo, collapse, collapse || excluded.length > 0);
  const ignores = options.ignores ?? loadIgnoreMatcher(worktree, repo.root);
  const prunable = prunableExcludeRoots(excluded, snapshot.trackedPaths);
  const buffered: BufferedStatusRow[] = [];
  let sourceRows = 0;
  let collapsed: string | null = null;

  for (const row of joinSorted3(
    treeStream(repo, headTreeOid),
    statusIndexEntries(repo.store.indexScan(), seed),
    worktreeEntries(repo, worktree, options, ignores, prunable),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    sourceRows++;
    if (row.a !== undefined || row.b !== undefined) {
      if (snapshot.retainsTrackedPaths) retainTrackedPath(snapshot, row.path);
      const matches = matchesPaths(row.path, options.paths);
      if (matches || seed !== undefined) {
        const detail = trackedRow(row.path, row.a, row.b, row.c);
        seed?.observeTracked(row.a, row.b, row.c, detail);
        if (matches && detail !== null) buffered.push(detail);
      }
      // A tracked path is never also untracked, whatever is on disk.
    } else if (row.c !== undefined) {
      seed?.observeUntracked(row.path);
      if (
        isExcluded(row.path, excluded) ||
        (options.includeIgnored !== true && ignores.ignores(row.path, false))
      ) {
        if (sourceRows >= STATUS_WINDOW_ROWS) {
          yield* flushStatusRows(repo, worktree, buffered, seed);
          sourceRows = 0;
        }
        continue;
      }
      let path = row.path;
      if (collapse) {
        if (collapsed !== null && path.startsWith(`${collapsed}/`)) {
          if (sourceRows >= STATUS_WINDOW_ROWS) {
            yield* flushStatusRows(repo, worktree, buffered, seed);
            sourceRows = 0;
          }
          continue;
        }
        const directory = shallowestUntrackedDirectory(path, snapshot.trackedDirs);
        if (directory !== null && matchesPaths(directory, options.paths)) {
          collapsed = directory;
          path = `${directory}/`;
        }
      }
      if (
        (matchesPaths(path, options.paths) || matchesPaths(row.path, options.paths)) &&
        // A tracked file replaced by a directory is a deletion, not a new directory.
        (!collapse || !snapshot.trackedPaths.has(stripSlash(path)))
      ) {
        buffered.push({ kind: "ready", detail: untrackedRow(path) });
      }
    }

    if (sourceRows >= STATUS_WINDOW_ROWS) {
      yield* flushStatusRows(repo, worktree, buffered, seed);
      sourceRows = 0;
    }
  }
  yield* flushStatusRows(repo, worktree, buffered, seed);
  seed?.finish();
}

function* statusIndexEntries(
  entries: Iterable<IndexEntry>,
  seed: FullStatusTrackerSeed | undefined,
): Generator<IndexEntry> {
  for (const entry of entries) {
    if (entry.stage === 0) yield entry;
    else seed?.observeConflict(entry.path);
  }
}

function worktreeFiles(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
): Generator<string> {
  return walkWorktreeStream(worktree, repo.root, worktreeWalkOptions(worktree, repo, options));
}

function worktreeEntries(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  ignores: IgnoreMatcher,
  excludeRoots: string[],
): Generator<WorktreePath> {
  return walkWorktreeEntriesStream(worktree, repo.root, {
    excludeRoots,
    paths: options.paths,
    ignores,
    // Tracked paths remain visible even when a later ignore rule matches.
    includeIgnored: true,
  });
}

interface ExcludedRoot {
  absolute: string;
  relative: string;
}

function excludedRoots(root: string, roots: string[] | undefined): ExcludedRoot[] {
  return (roots ?? []).flatMap((candidate) => {
    const relative = relativeTo(root, candidate);
    return relative === null || relative === "" ? [] : [{ absolute: candidate, relative }];
  });
}

function prunableExcludeRoots(
  roots: readonly ExcludedRoot[],
  trackedPaths: ReadonlySet<string>,
): string[] {
  return roots
    .filter((root) => !hasTrackedPath(root.relative, trackedPaths))
    .map((root) => root.absolute);
}

function hasTrackedPath(root: string, trackedPaths: ReadonlySet<string>): boolean {
  for (const path of trackedPaths) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  return false;
}

function isExcluded(path: string, roots: readonly ExcludedRoot[]): boolean {
  return roots.some((root) => path === root.relative || path.startsWith(`${root.relative}/`));
}

function worktreeWalkOptions(
  worktree: Worktree,
  repo: Repository,
  options: StatusOptions,
): {
  excludeRoots: string[] | undefined;
  paths: string[] | undefined;
  ignores: IgnoreMatcher;
  includeIgnored: boolean | undefined;
} {
  return {
    excludeRoots: options.excludeRoots,
    paths: options.paths,
    ignores: options.ignores ?? loadIgnoreMatcher(worktree, repo.root),
    includeIgnored: options.includeIgnored,
  };
}

/**
 * Snapshot only stage-zero path keys. Normal untracked collapsing needs all
 * tracked directories before the merge reaches its first worktree path.
 */
function snapshotStatusIndex(
  repo: Repository,
  includeDirectories: boolean,
  includeTrackedPaths: boolean,
): StatusIndexSnapshot {
  const budget = new RetainedStatusBudget(STATUS_RETAINED_BYTES);
  const trackedDirs = new Set<string>();
  const trackedPaths = new Set<string>();
  if (!includeDirectories && !includeTrackedPaths) {
    return { trackedDirs, trackedPaths, budget, retainsTrackedPaths: false };
  }
  for (const entry of repo.store.indexScan()) {
    if (entry.stage !== 0) continue;
    if (includeTrackedPaths) {
      budget.add(trackedPathRetainedBytes(entry.path));
      trackedPaths.add(entry.path);
    }
    if (!includeDirectories) continue;
    for (
      let slash = entry.path.indexOf("/");
      slash !== -1;
      slash = entry.path.indexOf("/", slash + 1)
    ) {
      const directory = entry.path.slice(0, slash);
      if (trackedDirs.has(directory)) continue;
      budget.add(DIRECTORY_FIXED_BYTES + retainedStringBytes(directory));
      trackedDirs.add(directory);
    }
  }
  return { trackedDirs, trackedPaths, budget, retainsTrackedPaths: includeTrackedPaths };
}

function retainTrackedPath(snapshot: StatusIndexSnapshot, path: string): void {
  if (snapshot.trackedPaths.has(path)) return;
  snapshot.budget.add(SET_ENTRY_BYTES + retainedStringBytes(path));
  snapshot.trackedPaths.add(path);
}

/** @internal Charge when one path and all its directory prefixes are new. */
export function statusIndexRetainedBytes(entry: IndexEntry): number {
  let bytes = trackedPathRetainedBytes(entry.path);
  for (
    let slash = entry.path.indexOf("/");
    slash !== -1;
    slash = entry.path.indexOf("/", slash + 1)
  ) {
    bytes += DIRECTORY_FIXED_BYTES + retainedStringBytes(entry.path.slice(0, slash));
  }
  return bytes;
}

function trackedPathRetainedBytes(path: string): number {
  return SET_ENTRY_BYTES + retainedStringBytes(path);
}

function shallowestUntrackedDirectory(file: string, tracked: Set<string>): string | null {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!tracked.has(directory)) return directory;
  }
  return null;
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** O(tracked). Only `statusMatrix`, which is not on the client surface, still needs it. */
function stagedIndex(repo: Repository): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const entry of repo.store.indexScan()) {
    if (entry.stage === 0) index.set(entry.path, entry);
  }
  return index;
}

// -- the isomorphic-git shape ------------------------------------------

/**
 * isomorphic-git's `statusMatrix`, for callers that already speak it. It
 * lists every file individually — no directory collapsing — and compares
 * content only, so a mode-only change is invisible here.
 */
export function statusMatrix(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusRow[] {
  const head = treeEntries(repo, repo.headTree());
  const index = stagedIndex(repo);
  const present = new Set<string>(worktreeFiles(repo, worktree, options));

  const paths = new Set<string>([...head.keys(), ...index.keys(), ...present]);
  const rows: StatusRow[] = [];
  for (const path of [...paths].sort()) {
    if (!matchesPaths(path, options.paths)) continue;
    const headOid = head.get(path)?.oid ?? null;
    const stageOid = index.get(path)?.oid ?? null;
    const workdirOid = worktreeOid(repo, worktree, path, index.get(path), present.has(path));
    rows.push([
      path,
      headOid === null ? 0 : 1,
      workdirOid === null ? 0 : workdirOid === headOid ? 1 : 2,
      stageOid === null ? 0 : stageOid === headOid ? 1 : stageOid === workdirOid ? 2 : 3,
    ]);
  }
  return rows;
}

function worktreeOid(
  repo: Repository,
  worktree: Worktree,
  path: string,
  entry: IndexEntry | undefined,
  present: boolean,
): string | null {
  if (!present) return null;
  if (entry !== undefined) {
    const stat = worktree.stat(joinPath(repo.root, path));
    if (stat !== null && indexMatchesStat(entry, stat)) return entry.oid;
  }
  return hashWorktreePath(repo, worktree, path, { write: false })?.oid ?? null;
}

// -- formatters --------------------------------------------------------

/** `git status --porcelain=v2`. */
export function formatPorcelainV2(entries: StatusDetail[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?") continue;
    lines.push(
      `1 ${v2Code(entry.index)}${v2Code(entry.worktree)} N... ` +
        `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
        `${entry.headOid} ${entry.indexOid} ${entry.path}`,
    );
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`? ${entry.path}`);
  return join(lines);
}

/** `git status --porcelain=v1`. */
export function formatPorcelainV1(entries: StatusEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?") continue;
    lines.push(`${entry.index}${entry.worktree} ${entry.path}`);
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`?? ${entry.path}`);
  return join(lines);
}

/**
 * `git status --short`. Identical to porcelain v1 over the states this
 * package models — the two differ only on colour, renames and path
 * quoting, none of which are represented in a `StatusEntry`.
 */
export function formatShort(entries: StatusEntry[]): string {
  return formatPorcelainV1(entries);
}

/** Porcelain v2 spells "unmodified" as a dot where v1 uses a space. */
function v2Code(code: string): string {
  return code === " " ? "." : code;
}

function join(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// -- clean -------------------------------------------------------------

export interface CleanOptions {
  paths?: string[];
  excludeRoots?: string[];
  ignores?: IgnoreMatcher;
  /** Descend into untracked directories and remove them whole (`-d`). */
  directories?: boolean;
  /** Report what would go without removing anything (`-n`). */
  dryRun?: boolean;
}

/**
 * Remove untracked paths, returning them as git's `clean -n` names them:
 * a directory removed whole keeps its trailing slash.
 *
 * Ignored files are never touched, and a directory holding one is not
 * removed whole — its untracked contents are removed around it, which is
 * what `git clean -d` does.
 */
export function clean(repo: Repository, worktree: Worktree, options: CleanOptions = {}): string[] {
  const index = stagedIndex(repo);
  const ignores = options.ignores ?? loadIgnoreMatcher(worktree, repo.root);
  const statusOptions: StatusOptions = {
    paths: options.paths,
    excludeRoots: options.excludeRoots,
    ignores,
  };
  const collapsed = untrackedEntries(repo, worktree, statusOptions);
  if (options.directories !== true) {
    const files = collapsed.filter((entry) => !entry.endsWith("/"));
    return removeAll(repo, worktree, files, options);
  }

  const visible = new Set<string>(worktreeFiles(repo, worktree, statusOptions));
  const everything = walkWorktree(worktree, repo.root, {
    excludeRoots: options.excludeRoots,
    paths: options.paths,
    includeIgnored: true,
  });
  const ignored = everything.filter((path) => !visible.has(path));
  const untracked = [...visible].filter((path) => !index.has(path));
  const entries = collapsed.flatMap((entry) => expandAroundIgnored(entry, untracked, ignored));
  return removeAll(repo, worktree, entries.sort(), options);
}

/** The untracked half of `status`, which is what `clean` acts on. */
function untrackedEntries(repo: Repository, worktree: Worktree, options: StatusOptions): string[] {
  const out: string[] = [];
  for (const row of statusStream(repo, worktree, options)) {
    if (row.worktree === "?") out.push(row.path);
  }
  return out.sort();
}

/**
 * A directory that holds an ignored file cannot go as a unit, so replace
 * it with the entries one level down and try again there.
 */
function expandAroundIgnored(entry: string, untracked: string[], ignored: string[]): string[] {
  if (!entry.endsWith("/")) return [entry];
  const prefix = entry;
  if (!ignored.some((path) => path.startsWith(prefix))) return [entry];
  const children = new Set<string>();
  for (const path of untracked) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    children.add(slash === -1 ? path : `${prefix}${rest.slice(0, slash)}/`);
  }
  return [...children].flatMap((child) => expandAroundIgnored(child, untracked, ignored));
}

function removeAll(
  repo: Repository,
  worktree: Worktree,
  entries: string[],
  options: CleanOptions,
): string[] {
  if (options.dryRun === true) return entries;
  for (const entry of entries) {
    if (entry.endsWith("/")) removeDirectory(repo, worktree, stripSlash(entry));
    else worktree.unlink(joinPath(repo.root, entry));
  }
  return entries;
}

function removeDirectory(repo: Repository, worktree: Worktree, directory: string): void {
  const contents = walkWorktree(worktree, repo.root, {
    paths: [directory],
    includeIgnored: true,
  });
  const directories = new Set<string>([directory]);
  for (const path of contents) {
    worktree.unlink(joinPath(repo.root, path));
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }
  const deepestFirst = [...directories].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const path of deepestFirst) worktree.rmdir(joinPath(repo.root, path));
}
