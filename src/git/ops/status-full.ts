import { CorruptError, GitError } from "../common/errors.js";
import { relativeTo } from "../common/paths.js";
import { joinSorted, joinSorted3 } from "../common/streams.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import type { IndexEntry } from "../store/index.js";
import { matchesPaths } from "./checkout.js";
import {
  type ExactRenameClassification,
  ExactRenameClassifier,
  renameDetectionEnabled,
} from "./rename-detection.js";
import type { Repository } from "./repository.js";
import {
  type BufferedStatusRow,
  flushStatusRows,
  ignoredRow,
  octalMode,
  renameRow,
  type StatusDetail,
  type StatusOptions,
  statusIndexGroups,
  trackedRow,
  unmergedRow,
  untrackedRow,
} from "./status-rows.js";
import type { FullStatusTrackerSeed } from "./status-sparse-tracker.js";
import {
  DIRECTORY_FIXED_BYTES,
  STATUS_RETAINED_BYTES,
  STATUS_WINDOW_ROWS,
  statusStringBytes,
} from "./status-types.js";
import { treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";
import {
  createWorktreeHashCursor,
  type WorktreePath,
  walkWorktreeEntriesStream,
  walkWorktreeStream,
} from "./worktree-io.js";

const SET_ENTRY_BYTES = 48;

interface StatusIndexSnapshot {
  trackedDirs: Set<string>;
  trackedPaths: Set<string>;
  budget: RetainedStatusBudget;
  retainsTrackedPaths: boolean;
}

export interface FullStatusPrepass {
  snapshot: StatusIndexSnapshot;
  excluded: ExcludedRoot[];
  renames: ExactRenameClassification | undefined;
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

export function fullStatusPrepass(
  repo: Repository,
  headTreeOid: string | null,
  options: StatusOptions,
): FullStatusPrepass {
  const collapse = (options.untrackedFiles ?? "normal") === "normal";
  const excluded = excludedRoots(repo.root, options.excludeRoots);
  const includeTrackedPaths = collapse || excluded.length > 0;
  if (!renameDetectionEnabled(repo, "status", options.renames)) {
    return {
      snapshot: snapshotStatusIndex(repo, collapse, includeTrackedPaths),
      excluded,
      renames: undefined,
    };
  }

  const snapshot = emptyStatusIndexSnapshot(includeTrackedPaths);
  const classifier = new ExactRenameClassifier();
  let classifying = true;
  for (const row of joinSorted(
    treeStream(repo, headTreeOid),
    statusIndexGroups(repo.checkout.indexScan()),
    {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    },
  )) {
    if (row.right !== undefined) retainStatusIndexPath(snapshot, row.right.path, collapse);
    if (!classifying || !matchesPaths(row.path, options.paths) || row.right?.kind === "unmerged") {
      continue;
    }
    const head = row.left;
    const index = row.right?.entry;
    let retained = true;
    if (head !== undefined && index === undefined && isRenameMode(head.mode)) {
      retained = classifier.addSource({ path: row.path, mode: head.mode, oid: head.oid });
    } else if (head === undefined && index !== undefined && index.mode !== 0o160000) {
      retained = classifier.addDestination({
        path: row.path,
        mode: octalMode(index.mode),
        oid: index.oid,
      });
    }
    if (!retained) {
      classifying = false;
      if (!collapse && !includeTrackedPaths) break;
    }
  }
  return { snapshot, excluded, renames: classifier.finish() };
}

export function* applyStatusRenames(
  rows: Iterable<StatusDetail>,
  classification: ExactRenameClassification | undefined,
): Generator<StatusDetail> {
  if (classification === undefined || classification.kind === "fallback") {
    yield* rows;
    return;
  }
  const sources = new Set(classification.renames.map((rename) => rename.source.path));
  const destinations = new Map(
    classification.renames.map((rename) => [rename.destination.path, rename]),
  );
  for (const row of rows) {
    if (sources.has(row.path) && row.ignored !== true && row.worktree !== "?") continue;
    const rename = destinations.get(row.path);
    if (rename === undefined) {
      yield row;
      continue;
    }
    if (row.ignored === true || row.unmerged === true || row.renamed === true) {
      throw new CorruptError("status rename destination is not an ordinary staged addition");
    }
    yield renameRow(rename, row);
  }
}

function isRenameMode(mode: string): boolean {
  return mode === "100644" || mode === "100755" || mode === "120000";
}

export function* statusStreamInternal(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  headTreeOid: string | null,
  prepass: FullStatusPrepass,
  seed?: FullStatusTrackerSeed,
): Generator<StatusDetail> {
  const untrackedMode = options.untrackedFiles ?? "normal";
  const collapse = untrackedMode === "normal";
  const { excluded, snapshot } = prepass;
  const ignores = options.ignores ?? loadIgnoreMatcher(worktree, repo.root);
  const prunable = prunableExcludeRoots(excluded, snapshot.trackedPaths);
  const buffered: BufferedStatusRow[] = [];
  const hashCursor = createWorktreeHashCursor();
  let sourceRows = 0;
  let collapsedIgnored: string | null = null;
  let collapsedUntracked: string | null = null;
  const observeUntracked = (candidate: string): void => {
    seed?.observeUntracked(candidate);
    if (untrackedMode === "no") return;
    const ignored = ignores.ignores(candidate, false);
    if (isExcluded(candidate, excluded) || (options.includeIgnored !== true && ignored)) return;

    let path = candidate;
    if (collapse) {
      if (
        (collapsedIgnored !== null && path.startsWith(`${collapsedIgnored}/`)) ||
        (!ignored && collapsedUntracked !== null && path.startsWith(`${collapsedUntracked}/`))
      ) {
        return;
      }
      const directory = ignored
        ? shallowestIgnoredDirectory(path, snapshot.trackedDirs, ignores)
        : shallowestUntrackedDirectory(path, snapshot.trackedDirs);
      if (directory !== null && matchesPaths(directory, options.paths)) {
        if (ignored) collapsedIgnored = directory;
        else collapsedUntracked = directory;
        path = `${directory}/`;
      }
    }
    if (
      (matchesPaths(path, options.paths) || matchesPaths(candidate, options.paths)) &&
      // A tracked file replaced by a directory is a deletion, not a new directory.
      (!collapse || !path.endsWith("/") || !snapshot.trackedPaths.has(stripSlash(path)))
    ) {
      buffered.push({ kind: "ready", detail: ignored ? ignoredRow(path) : untrackedRow(path) });
    }
  };

  for (const row of joinSorted3(
    treeStream(repo, headTreeOid),
    statusIndexGroups(repo.checkout.indexScan()),
    worktreeEntries(repo, worktree, options, ignores, prunable, snapshot, seed === undefined),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    sourceRows++;
    if (row.a !== undefined || row.b !== undefined) {
      if (snapshot.retainsTrackedPaths) retainTrackedPath(snapshot, row.path);
      const matches = matchesPaths(row.path, options.paths);
      if (matches || seed !== undefined) {
        const detail: BufferedStatusRow | null =
          row.b?.kind === "unmerged"
            ? { kind: "ready", detail: unmergedRow(row.b, row.c) }
            : trackedRow(row.path, row.a, row.b?.entry, row.c);
        if (row.b?.kind === "unmerged") seed?.observeConflict(row.path);
        else seed?.observeTracked(row.a, row.b?.entry, row.c, detail);
        if (matches && detail !== null) buffered.push(detail);
      }
      if (row.b === undefined && row.c !== undefined) observeUntracked(row.path);
    } else if (row.c !== undefined) {
      observeUntracked(row.path);
    }

    if (sourceRows >= STATUS_WINDOW_ROWS) {
      yield* flushStatusRows(repo, worktree, buffered, seed, false, undefined, hashCursor);
      sourceRows = 0;
    }
  }
  yield* flushStatusRows(repo, worktree, buffered, seed, false, undefined, hashCursor);
  seed?.finish();
}

export function worktreeFiles(
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
  snapshot: StatusIndexSnapshot,
  allowIgnoredPrune: boolean,
): Generator<WorktreePath> {
  return walkWorktreeEntriesStream(worktree, repo.root, {
    excludeRoots,
    paths: options.paths,
    ignores,
    // Tracked paths remain visible even when a later ignore rule matches.
    includeIgnored: true,
    pruneDirectory:
      allowIgnoredPrune && options.includeIgnored !== true && snapshot.retainsTrackedPaths
        ? (path) => ignores.ignores(path, true) && !hasTrackedPath(path, snapshot.trackedPaths)
        : undefined,
  });
}

export interface ExcludedRoot {
  absolute: string;
  relative: string;
}

export function excludedRoots(root: string, roots: string[] | undefined): ExcludedRoot[] {
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

export function isExcluded(path: string, roots: readonly ExcludedRoot[]): boolean {
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
 * Snapshot one path per validated index group. Normal untracked collapsing
 * treats unmerged stages as tracked and needs every tracked directory early.
 */
function snapshotStatusIndex(
  repo: Repository,
  includeDirectories: boolean,
  includeTrackedPaths: boolean,
): StatusIndexSnapshot {
  const snapshot = emptyStatusIndexSnapshot(includeTrackedPaths);
  if (!includeDirectories && !includeTrackedPaths) return snapshot;
  for (const group of statusIndexGroups(repo.checkout.indexScan())) {
    retainStatusIndexPath(snapshot, group.path, includeDirectories);
  }
  return snapshot;
}

function emptyStatusIndexSnapshot(retainsTrackedPaths: boolean): StatusIndexSnapshot {
  const budget = new RetainedStatusBudget(STATUS_RETAINED_BYTES);
  const trackedDirs = new Set<string>();
  const trackedPaths = new Set<string>();
  return { trackedDirs, trackedPaths, budget, retainsTrackedPaths };
}

function retainStatusIndexPath(
  snapshot: StatusIndexSnapshot,
  path: string,
  includeDirectories: boolean,
): void {
  if (snapshot.retainsTrackedPaths && !snapshot.trackedPaths.has(path)) {
    snapshot.budget.add(trackedPathRetainedBytes(path));
    snapshot.trackedPaths.add(path);
  }
  if (!includeDirectories) return;
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const directory = path.slice(0, slash);
    if (snapshot.trackedDirs.has(directory)) continue;
    snapshot.budget.add(DIRECTORY_FIXED_BYTES + statusStringBytes(directory));
    snapshot.trackedDirs.add(directory);
  }
}

function retainTrackedPath(snapshot: StatusIndexSnapshot, path: string): void {
  if (snapshot.trackedPaths.has(path)) return;
  snapshot.budget.add(SET_ENTRY_BYTES + statusStringBytes(path));
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
    bytes += DIRECTORY_FIXED_BYTES + statusStringBytes(entry.path.slice(0, slash));
  }
  return bytes;
}

function trackedPathRetainedBytes(path: string): number {
  return SET_ENTRY_BYTES + statusStringBytes(path);
}

function shallowestUntrackedDirectory(file: string, tracked: Set<string>): string | null {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!tracked.has(directory)) return directory;
  }
  return null;
}

function shallowestIgnoredDirectory(
  file: string,
  tracked: Set<string>,
  ignores: IgnoreMatcher,
): string | null {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!tracked.has(directory) && ignores.ignores(directory, true)) return directory;
  }
  return null;
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
