// `status`, its three formatters, and `clean`.
//
// The cost model is the point: one `treeEntries` walk answers HEAD for
// every path, a bounded index prepass answers tracked-directory membership,
// and a paged index stream answers the merge. A file is hashed only when the
// stat data cached in `git_index` no longer holds. A repeated status over an
// untouched tree therefore reads no file content at all.

import { contentIdKey, type IndexEntry } from "../../sqlite/store.js";
import { ZERO_OID } from "../bytes.js";
import type { GitContext, IndexTrackerSeedEntry } from "../context.js";
import { CorruptError, GitError } from "../errors.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import type { SparseWorkspaceResult, SparseWorkspaceRow } from "../sparse-workspace.js";
import { comparePaths, joinSorted3 } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { matchesPaths, type TargetEntry, treeEntries } from "./checkout.js";
import type { StatusEntry, StatusRow } from "./kinds.js";
import { treeStream } from "./tree-stream.js";
import {
  type HashedPath,
  hashExactWorktreePaths,
  hashWorktreePath,
  hashWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
  walkWorktree,
  walkWorktreeEntriesStream,
  walkWorktreeStream,
} from "./worktree-io.js";

/** A mode column in porcelain v2, and the mode of an absent side. */
const ABSENT_MODE = "000000";

/** Retained index, directory and tracked-path state for one status call. */
export const STATUS_RETAINED_BYTES = 16 * 1024 * 1024;
const STATUS_WINDOW_ROWS = 1000;
const DIRECTORY_FIXED_BYTES = 96;
const SET_ENTRY_BYTES = 48;
const SPARSE_STATUS_PATHS = 1_000;
const SPARSE_INDEX_DIRTY = 1;
const SPARSE_WORKTREE_DIRTY = 2;
const FULL_STATUS_TRACKER_ROWS = 32_000;
const FULL_STATUS_TRACKER_BYTES = 16 * 1024 * 1024;
const FULL_STATUS_TRACKER_FIXED_BYTES = 256;
const FULL_STATUS_TRACKER_ROW_BYTES = 256;
const TRACKER_PATH_BYTES = 2_200;

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

interface PendingTrackedRow {
  path: string;
  headMode: string;
  indexMode: string;
  worktree: WorktreePath;
  headOid: string;
  indexOid: string;
  staged: StatusEntry["index"];
}

type BufferedStatusRow =
  | { kind: "ready"; detail: StatusDetail }
  | { kind: "hash"; tracked: PendingTrackedRow };

/** Bounded dirty-leaf snapshot collected only by the eager repair pass. */
class FullStatusTrackerSeed {
  #entries = new Map<string, number>();
  #retainedBytes = FULL_STATUS_TRACKER_FIXED_BYTES;
  #available = true;
  #finished = false;

  get resealable(): boolean {
    return this.#available && this.#finished;
  }

  observeConflict(path: string): void {
    this.#mark(path, SPARSE_INDEX_DIRTY | SPARSE_WORKTREE_DIRTY);
  }

  observeUntracked(path: string): void {
    this.#mark(path, SPARSE_WORKTREE_DIRTY);
  }

  observeTracked(
    head: TargetEntry | undefined,
    entry: IndexEntry | undefined,
    worktree: WorktreePath | undefined,
    buffered: BufferedStatusRow | null,
  ): void {
    let flags = 0;
    if (
      entry?.mode === 0o160000 ||
      (head === undefined) !== (entry === undefined) ||
      (head !== undefined &&
        entry !== undefined &&
        (head.oid !== entry.oid || head.mode !== octalMode(entry.mode)))
    ) {
      flags |= SPARSE_INDEX_DIRTY;
    }

    if (entry === undefined) {
      if (worktree !== undefined) flags |= SPARSE_WORKTREE_DIRTY;
    } else if (entry.mode !== 0o160000) {
      if (worktree === undefined) flags |= SPARSE_WORKTREE_DIRTY;
      else if (buffered?.kind === "ready" && buffered.detail.worktree !== " ") {
        flags |= SPARSE_WORKTREE_DIRTY;
      }
    }
    this.#mark(head?.path ?? entry?.path ?? worktree?.path ?? "", flags);
  }

  observeHashed(path: string, dirty: boolean): void {
    if (dirty) this.#mark(path, SPARSE_WORKTREE_DIRTY);
  }

  finish(): void {
    this.#finished = true;
  }

  *entries(): Generator<IndexTrackerSeedEntry> {
    for (const [path, flags] of this.#entries) yield { path, flags };
  }

  #mark(path: string, flags: number): void {
    if (!this.#available || flags === 0) return;
    const previous = this.#entries.get(path);
    if (previous !== undefined) {
      this.#entries.set(path, previous | flags);
      return;
    }
    const retained = FULL_STATUS_TRACKER_ROW_BYTES + path.length * 2;
    if (
      this.#entries.size === FULL_STATUS_TRACKER_ROWS ||
      retained >= FULL_STATUS_TRACKER_BYTES - this.#retainedBytes ||
      !trackerPathRepresentable(path)
    ) {
      this.#available = false;
      this.#entries = new Map();
      return;
    }
    this.#entries.set(path, flags);
    this.#retainedBytes += retained;
  }
}

/**
 * A `StatusEntry` plus the columns porcelain v2 prints. `status` returns
 * these so the v2 formatter needs no second pass over the repository;
 * anything wanting Computer's narrower shape can use it as-is.
 */
export interface StatusDetail extends StatusEntry {
  /** Mode in HEAD, in the index and on disk; "000000" where absent. */
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  /** Oid in HEAD and in the index; all-zero where absent. */
  headOid: string;
  indexOid: string;
}

export interface StatusOptions {
  /** Restrict to these repo-relative pathspecs: exact or directory prefix. */
  paths?: string[];
  /** Roots of repositories nested inside this one; their files are theirs. */
  excludeRoots?: string[];
  /** Report ignored paths too, as untracked. git's `--ignored`. */
  includeIgnored?: boolean;
  /** Override the ignore rules. Defaults to the working tree's `.gitignore`s. */
  ignores?: IgnoreMatcher;
  /**
   * "normal" (git's default) collapses a wholly untracked directory into
   * one `dir/` entry; "all" lists every file under it.
   */
  untrackedFiles?: "normal" | "all";
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

function sparseStatus(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  context: Pick<GitContext, "sparseWorkspace" | "indexTracker">,
  baselineTreeOid: string | null,
): StatusDetail[] | null {
  const source = context.sparseWorkspace;
  const tracker = context.indexTracker;
  if (source === undefined || tracker === undefined) return null;
  const currentTreeOid = repo.headTree();
  let candidates: string[] | null;
  try {
    candidates = sparseStatusCandidates(
      repo,
      source.dirtyPaths(repo.store.repoId),
      baselineTreeOid,
      currentTreeOid,
    );
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  if (candidates === null) return null;
  if (candidates.length === 0) return [];

  let hydrated: SparseWorkspaceResult;
  try {
    hydrated = source.hydrate({
      repoId: repo.store.repoId,
      root: repo.root,
      baselineTreeOid,
      currentTreeOid,
      paths: candidates,
    });
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  if (!hydrated.available) return null;
  if (hydrated.rows.length !== candidates.length) {
    throw new CorruptError("sparse status hydration returned the wrong row count");
  }

  let ignores = options.ignores;
  const ignoredUntracked = new Set<string>();
  for (let index = 0; index < candidates.length; index++) {
    const path = candidates[index];
    const row = hydrated.rows[index];
    if (path === undefined || row === undefined || row.path !== path) {
      throw new CorruptError("sparse status hydration returned unordered rows");
    }
    const stage = row.index.find((entry) => entry.stage === 0);
    const untracked =
      row.current === null && stage === undefined && sparseWorktreePath(row) !== undefined;
    if (!untracked) continue;
    if (ignores === undefined) ignores = loadIgnoreMatcher(worktree, repo.root);
    const ignored = ignores.ignores(path, false);
    if (ignored) ignoredUntracked.add(path);
    const reportable = options.includeIgnored === true || !ignored;
    if (reportable && (options.untrackedFiles ?? "normal") === "normal") return null;
  }

  const worktreeComparison = compareSparseWorktree(repo, worktree, hydrated.rows);
  const buffered: BufferedStatusRow[] = [];
  const retained = new Map<string, number>();
  for (let index = 0; index < candidates.length; index++) {
    const path = candidates[index];
    const row = hydrated.rows[index];
    if (path === undefined || row === undefined)
      throw new CorruptError("sparse status row missing");
    const stage = row.index.find((entry) => entry.stage === 0);
    const worktreePath = sparseWorktreePath(row);
    const untracked = row.current === null && stage === undefined && worktreePath !== undefined;
    const ignored = ignoredUntracked.has(path);
    if (untracked && options.includeIgnored !== true && ignored) {
      retained.set(path, SPARSE_WORKTREE_DIRTY);
    } else if (untracked) {
      buffered.push({ kind: "ready", detail: untrackedRow(path) });
    } else {
      const detail = trackedRow(path, sparseTarget(path, row), stage, worktreePath);
      if (detail !== null) buffered.push(detail);
    }
    let flags = retained.get(path) ?? 0;
    if (sparseIndexDirty(row, stage) || stage?.mode === 0o160000) flags |= SPARSE_INDEX_DIRTY;
    if (worktreeComparison.dirty.has(path)) flags |= SPARSE_WORKTREE_DIRTY;
    if (flags !== 0) retained.set(path, flags);
  }

  const details = [
    ...flushStatusRows(repo, worktree, buffered, undefined, true, worktreeComparison.hashes),
  ];
  const seed: IndexTrackerSeedEntry[] = [];
  for (const path of candidates) {
    const flags = retained.get(path);
    if (flags !== undefined) seed.push({ path, flags });
  }
  tracker.reseal(repo.store.repoId, currentTreeOid, seed);
  return details;
}

function sparseIndexDirty(row: SparseWorkspaceRow, stage: IndexEntry | undefined): boolean {
  if (row.index.some((entry) => entry.stage !== 0)) return true;
  if (row.current === null) return stage !== undefined;
  return (
    stage === undefined ||
    stage.oid !== row.current.oid ||
    octalMode(stage.mode) !== row.current.mode
  );
}

function compareSparseWorktree(
  repo: Repository,
  worktree: Worktree,
  rows: readonly SparseWorkspaceRow[],
): { dirty: Set<string>; hashes: Map<string, HashedPath> } {
  const dirty = new Set<string>();
  const pending: Array<{ entry: IndexEntry; worktree: WorktreePath }> = [];
  for (const row of rows) {
    const entry = row.index.find((candidate) => candidate.stage === 0);
    const candidate = sparseWorktreePath(row);
    if (entry === undefined) {
      if (candidate !== undefined) dirty.add(row.path);
      continue;
    }
    if (entry.mode === 0o160000) continue;
    if (candidate === undefined) {
      dirty.add(row.path);
      continue;
    }
    if (entry.mode !== Number.parseInt(gitModeFor(candidate.stat), 8)) {
      dirty.add(row.path);
      continue;
    }
    if (!indexMatchesStat(entry, candidate.stat)) pending.push({ entry, worktree: candidate });
  }

  const mapped = repo.store.lookupBlobIds(
    pending.flatMap(({ worktree: candidate }) => {
      const contentId = candidate.stat.contentId;
      return contentId === null ? [] : [contentId];
    }),
  );
  const unresolved: WorktreePath[] = [];
  for (const candidate of pending) {
    const contentId = candidate.worktree.stat.contentId;
    const oid = contentId === null ? undefined : mapped.get(contentIdKey(contentId));
    if (oid === undefined) unresolved.push(candidate.worktree);
    else if (oid !== candidate.entry.oid) dirty.add(candidate.entry.path);
  }
  const hashed = hashExactWorktreePaths(repo, worktree, unresolved, { write: false });
  repo.store.upsertBlobIds(
    [...hashed.values()].flatMap((value) => {
      const contentId = value.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: value.oid }];
    }),
  );
  const expected = new Map(pending.map((candidate) => [candidate.entry.path, candidate.entry.oid]));
  for (const candidate of unresolved) {
    if (hashed.get(candidate.path)?.oid !== expected.get(candidate.path)) dirty.add(candidate.path);
  }
  return { dirty, hashes: hashed };
}

function sparseStatusCandidates(
  repo: Repository,
  dirty: Iterable<{ path: string }>,
  baselineTreeOid: string | null,
  currentTreeOid: string | null,
): string[] | null {
  const paths = new Set<string>();
  for (const entry of dirty) {
    paths.add(entry.path);
    if (paths.size > SPARSE_STATUS_PATHS) return null;
  }
  for (const entry of repo.walkTreeDiff(baselineTreeOid, currentTreeOid)) {
    paths.add(entry.path);
    if (paths.size > SPARSE_STATUS_PATHS) return null;
  }
  return [...paths].sort(comparePaths);
}

function sparseTarget(path: string, row: SparseWorkspaceRow): TargetEntry | undefined {
  return row.current === null ? undefined : { path, mode: row.current.mode, oid: row.current.oid };
}

function sparseWorktreePath(row: SparseWorkspaceRow): WorktreePath | undefined {
  if (row.worktree === null || row.worktree.type === "dir") return undefined;
  return { path: row.path, stat: row.worktree };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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

function trackedRow(
  path: string,
  head: TargetEntry | undefined,
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
): BufferedStatusRow | null {
  const headMode = head?.mode ?? ABSENT_MODE;
  const headOid = head?.oid ?? ZERO_OID;
  const indexMode = entry === undefined ? ABSENT_MODE : octalMode(entry.mode);
  const indexOid = entry?.oid ?? ZERO_OID;

  let staged: StatusEntry["index"] = " ";
  if (head === undefined) staged = entry === undefined ? " " : "A";
  else if (entry === undefined) staged = "D";
  else if (head.oid !== entry.oid || head.mode !== indexMode) staged = "M";

  const state = worktreeState(entry, worktree, {
    path,
    headMode,
    indexMode,
    headOid,
    indexOid,
    staged,
  });
  if (state.kind === "hash") return state;
  const { code, mode } = state;
  if (staged === " " && code === " ") return null;
  return {
    kind: "ready",
    detail: statusDetail(path, staged, code, headMode, indexMode, mode, headOid, indexOid),
  };
}

/** The working-tree half of a tracked path, hashing only when it must. */
function worktreeState(
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
  pending: Omit<PendingTrackedRow, "worktree">,
):
  | { kind: "ready"; code: StatusEntry["worktree"]; mode: string }
  | { kind: "hash"; tracked: PendingTrackedRow } {
  // Not in the index: the file, if any, shows up as untracked instead.
  if (entry === undefined) return { kind: "ready", code: " ", mode: ABSENT_MODE };
  // Submodules are out of scope; nothing on disk describes their state.
  if (entry.mode === 0o160000) {
    return { kind: "ready", code: " ", mode: octalMode(entry.mode) };
  }

  if (worktree === undefined) return { kind: "ready", code: "D", mode: ABSENT_MODE };
  const mode = gitModeFor(worktree.stat);
  if (indexMatchesStat(entry, worktree.stat)) return { kind: "ready", code: " ", mode };
  return { kind: "hash", tracked: { ...pending, worktree } };
}

function* flushStatusRows(
  repo: Repository,
  worktree: Worktree,
  buffered: BufferedStatusRow[],
  seed?: FullStatusTrackerSeed,
  exact = false,
  knownHashes: ReadonlyMap<string, HashedPath> = new Map(),
): Generator<StatusDetail> {
  if (buffered.length === 0) return;
  const rows = buffered.splice(0);
  const pending = rows.flatMap((row) => (row.kind === "hash" ? [row.tracked] : []));
  const mapped = repo.store.lookupBlobIds(
    pending.flatMap((row) => {
      const contentId = row.worktree.stat.contentId;
      return contentId === null || row.worktree.stat.type === "dir" ? [] : [contentId];
    }),
  );
  const mappedOids = new Map<string, string>();
  const unresolved: WorktreePath[] = [];
  for (const row of pending) {
    const contentId = row.worktree.stat.contentId;
    const oid =
      contentId === null || row.worktree.stat.type === "dir"
        ? undefined
        : mapped.get(contentIdKey(contentId));
    if (oid === undefined) {
      if (!knownHashes.has(row.path)) unresolved.push(row.worktree);
    } else mappedOids.set(row.path, oid);
  }
  const freshHashes = exact
    ? hashExactWorktreePaths(repo, worktree, unresolved, { write: false })
    : hashWorktreePaths(repo, worktree, unresolved, { write: false });
  repo.store.upsertBlobIds(
    [...freshHashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );
  const hashes = new Map(knownHashes);
  for (const [path, hashed] of freshHashes) hashes.set(path, hashed);
  for (const row of rows) {
    if (row.kind === "ready") {
      yield row.detail;
      continue;
    }
    const tracked = row.tracked;
    const hashed = hashes.get(tracked.path);
    const actualOid = mappedOids.get(tracked.path) ?? hashed?.oid;
    const actualMode = hashed?.mode ?? gitModeFor(tracked.worktree.stat);
    const code: StatusEntry["worktree"] =
      actualOid === undefined
        ? "D"
        : actualOid !== tracked.indexOid || actualMode !== tracked.indexMode
          ? "M"
          : " ";
    seed?.observeHashed(tracked.path, code !== " ");
    if (tracked.staged === " " && code === " ") continue;
    yield statusDetail(
      tracked.path,
      tracked.staged,
      code,
      tracked.headMode,
      tracked.indexMode,
      actualOid === undefined ? ABSENT_MODE : actualMode,
      tracked.headOid,
      tracked.indexOid,
    );
  }
}

function statusDetail(
  path: string,
  staged: StatusEntry["index"],
  code: StatusEntry["worktree"],
  headMode: string,
  indexMode: string,
  worktreeMode: string,
  headOid: string,
  indexOid: string,
): StatusDetail {
  return {
    path,
    index: staged,
    worktree: code,
    headMode,
    indexMode,
    worktreeMode,
    headOid,
    indexOid,
  };
}

function untrackedRow(path: string): StatusDetail {
  return statusDetail(path, " ", "?", ABSENT_MODE, ABSENT_MODE, ABSENT_MODE, ZERO_OID, ZERO_OID);
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

function retainedStringBytes(value: string): number {
  return 48 + value.length * 2;
}

function trackerPathRepresentable(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("\0")) {
    return false;
  }
  let bytes = 0;
  let segmentStart = 0;
  for (let at = 0; at < path.length; at++) {
    const unit = path.charCodeAt(at);
    if (unit === 0x2f) {
      if (!validTrackerSegment(path, segmentStart, at)) return false;
      segmentStart = at + 1;
      bytes++;
    } else if (unit < 0x80) {
      bytes++;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(++at);
      if (next < 0xdc00 || next > 0xdfff) return false;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    } else {
      bytes += 3;
    }
    if (bytes > TRACKER_PATH_BYTES) return false;
  }
  return validTrackerSegment(path, segmentStart, path.length);
}

function validTrackerSegment(path: string, start: number, end: number): boolean {
  const length = end - start;
  return !(
    length === 0 ||
    (length === 1 && path.charCodeAt(start) === 0x2e) ||
    (length === 2 && path.charCodeAt(start) === 0x2e && path.charCodeAt(start + 1) === 0x2e)
  );
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

function octalMode(mode: number): string {
  return mode.toString(8).padStart(6, "0");
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
