// Materialising a tree into the working tree, and keeping the SQL index in
// step with it.

import {
  contentIdKey,
  type IndexEntry,
  type IndexSink,
  type IndexStore,
} from "../../sqlite/store.js";
import { fromHex, utf8 } from "../bytes.js";
import { GitError } from "../errors.js";
import { isTreeMode, type TreeEntry } from "../objects.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { comparePaths, joinSorted, joinSorted3 } from "../streams.js";
import { fileModeFor, gitModeFor, type Worktree } from "../worktree.js";
import { type CheckoutWriteBudget, flushCheckoutWrites } from "./checkout-writes.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import { indexMatchesStat, type WorktreePath, walkWorktreeEntriesStream } from "./worktree-io.js";

export { checkoutSparseChanges, type SparseCheckoutChange } from "./sparse-checkout.js";
export type { TargetEntry } from "./tree-stream.js";
export { type CompiledPathspecMatcher, compilePathspecs } from "./worktree-io.js";

/**
 * Every blob, symlink and gitlink under a tree, keyed by repo-relative path.
 * O(tree). `treeStream` is the bounded form; this stays for the callers that
 * genuinely need random access.
 */
export function treeEntries(repo: Repository, treeOid: string | null): Map<string, TargetEntry> {
  const out = new Map<string, TargetEntry>();
  for (const entry of treeStream(repo, treeOid)) out.set(entry.path, entry);
  return out;
}

/** Does `path` fall under one of the pathspecs? An empty list matches all. */
export function matchesPaths(path: string, paths: string[] | undefined): boolean {
  if (paths === undefined || paths.length === 0) return true;
  return paths.some(
    (spec) =>
      spec === "" ||
      spec === "." ||
      path === spec ||
      path.startsWith(`${spec.replace(/\/+$/, "")}/`),
  );
}

export interface CheckoutOptions {
  /** Restrict the update to these repo-relative pathspecs. */
  paths?: string[];
  /** Remove tracked files that the target tree does not have. */
  prune?: boolean;
  /** Keep local changes to entries that are identical in the index and target. */
  preserveMatchingIndex?: boolean;
  /** Remove worktree entries whose type prevents materialising the target. */
  restoreStructure?: boolean;
  /** Discard conflict stages before hard materialisation. */
  discardUnmerged?: boolean;
  /** Bound each paged worktree traversal used by checkout. */
  maxWorktreeRowsPerPass?: number;
  /** Bound each tree and index traversal used by checkout. */
  maxSourceRowsPerPass?: number;
  /** Bound aggregate blob bytes materialised into the worktree. */
  maxWriteBytes?: number;
}

const CHECKOUT_WINDOW_ROWS = 1_000;
const CHECKOUT_REMOVAL_BYTES = 16 * 1024 * 1024;
const CHECKOUT_PRUNE_BYTES = 16 * 1024 * 1024;
const CHECKOUT_PRUNE_PATHS = 50_000;
const CHECKOUT_REMOVE_BINDING_BYTES = 1_000_000;
const CHECKOUT_REMOVE_BATCHES = 16;
const CHECKOUT_PATH_FIXED_BYTES = 96;
const CHECKOUT_UNMERGED_PATHS = 10_000;
const CHECKOUT_UNMERGED_BYTES = 4 * 1024 * 1024;

/**
 * Bring the working tree and the index to `treeOid`. Entries already
 * matching are left alone, so a checkout that changes one file touches one
 * file.
 */
export function checkoutTree(
  repo: Repository,
  worktree: Worktree,
  treeOid: string | null,
  options: CheckoutOptions = {},
  index: IndexStore = repo.checkout,
): void {
  const writeBudget = checkoutWriteBudget(options.maxWriteBytes);
  if (options.discardUnmerged === true) {
    discardUnmergedPaths(
      repo,
      worktree,
      options.maxWorktreeRowsPerPass,
      options.maxSourceRowsPerPass,
      index,
    );
  }
  const preservedRemovals =
    options.restoreStructure === true
      ? restoreStructuralConflicts(repo, worktree, treeOid, options, index)
      : new Set<string>();
  const removed: string[] = [];
  let prunePlan: CheckoutPrunePlan | undefined;

  // Remove obsolete paths before writing replacements. This also handles a
  // directory-to-file transition without retaining the whole target tree.
  index.indexApply((sink) => {
    let retainedBytes = 0;
    for (const row of joinSorted(
      boundedCheckoutSourceRows(treeStream(repo, treeOid), options.maxSourceRowsPerPass, "tree"),
      stageZero(
        boundedCheckoutSourceRows(index.indexScan(), options.maxSourceRowsPerPass, "index"),
      ),
      {
        left: (entry) => entry.path,
        right: (entry) => entry.path,
      },
    )) {
      const entry = row.left;
      const existing = row.right;
      if (entry !== undefined || existing === undefined || options.prune === false) continue;
      if (!matchesPaths(existing.path, options.paths)) continue;
      retainedBytes += CHECKOUT_PATH_FIXED_BYTES + existing.path.length * 2;
      if (retainedBytes > CHECKOUT_REMOVAL_BYTES) {
        throw new GitError(
          "E2BIG",
          `checkout removal state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
        );
      }
      removed.push(existing.path);
    }
    if (removed.length > 0) {
      prunePlan = planEmptyDirectories(
        repo,
        worktree,
        removed,
        preservedRemovals,
        options.maxWorktreeRowsPerPass,
      );
    }
    flushRemovals(repo, worktree, removed, preservedRemovals, sink);
  });
  if (prunePlan !== undefined) pruneEmptyDirectories(repo, worktree, prunePlan);

  const written: TargetEntry[] = [];
  const candidates: CheckoutCandidate[] = [];
  index.indexApply((sink) => {
    for (const row of joinSorted3(
      boundedCheckoutSourceRows(treeStream(repo, treeOid), options.maxSourceRowsPerPass, "tree"),
      stageZero(
        boundedCheckoutSourceRows(index.indexScan(), options.maxSourceRowsPerPass, "index"),
      ),
      boundedCheckoutWorktreeEntries(
        walkWorktreeEntriesStream(worktree, repo.root, {
          includeIgnored: true,
          maxScanRows: options.maxWorktreeRowsPerPass,
        }),
        options.maxWorktreeRowsPerPass,
      ),
      { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
    )) {
      const entry = row.a;
      if (entry === undefined || !matchesPaths(entry.path, options.paths)) continue;
      if (entry.mode === "160000") continue; // submodules are out of scope
      if (
        options.preserveMatchingIndex === true &&
        row.b !== undefined &&
        row.b.oid === entry.oid &&
        row.b.mode === Number.parseInt(entry.mode, 8)
      ) {
        continue;
      }
      candidates.push({ entry, index: row.b, worktree: row.c });
      if (candidates.length >= CHECKOUT_WINDOW_ROWS) {
        flushCheckoutCandidates(repo, worktree, candidates, written, sink, writeBudget);
      }
    }
    flushCheckoutCandidates(repo, worktree, candidates, written, sink, writeBudget);
    flushCheckoutWrites(repo, worktree, written, sink, writeBudget);
  });
}

function discardUnmergedPaths(
  repo: Repository,
  worktree: Worktree,
  maxWorktreeRows: number | undefined,
  maxSourceRows: number | undefined,
  index: IndexStore,
): void {
  const paths: string[] = [];
  let previousUnmerged: string | null = null;
  let retainedBytes = 0;
  for (const entry of boundedCheckoutSourceRows(index.indexScan(), maxSourceRows, "index")) {
    if (entry.stage === 0 || entry.path === previousUnmerged) continue;
    previousUnmerged = entry.path;
    if (paths.length >= CHECKOUT_UNMERGED_PATHS) {
      throw new GitError("E2BIG", `checkout conflicts exceed ${CHECKOUT_UNMERGED_PATHS} paths`);
    }
    retainedBytes += CHECKOUT_PATH_FIXED_BYTES + entry.path.length * 2;
    if (retainedBytes > CHECKOUT_UNMERGED_BYTES) {
      throw new GitError(
        "E2BIG",
        `checkout conflict paths exceed ${CHECKOUT_UNMERGED_BYTES} bytes`,
      );
    }
    paths.push(entry.path);
  }
  if (paths.length === 0) return;

  const physical: string[] = [];
  for (const row of joinSorted(
    paths,
    boundedCheckoutWorktreeEntries(
      walkWorktreeEntriesStream(worktree, repo.root, {
        includeIgnored: true,
        filesOnly: true,
        maxScanRows: maxWorktreeRows,
      }),
      maxWorktreeRows,
    ),
    { left: (path) => path, right: (entry) => entry.path },
  )) {
    if (row.left !== undefined && row.right !== undefined) physical.push(row.left);
  }
  for (const batch of planWorktreeRemovalBatches(repo, physical, "checkout conflict removal")) {
    worktree.removeFiles(batch.map((path) => joinPath(repo.root, path)));
  }
  index.indexApply((sink) => {
    for (let offset = 0; offset < paths.length; offset += CHECKOUT_WINDOW_ROWS) {
      for (const path of paths.slice(offset, offset + CHECKOUT_WINDOW_ROWS)) sink.remove(path);
      sink.flush();
    }
  });
}

interface StructuralPath {
  path: string;
  type: "file" | "dir" | "symlink";
}

function restoreStructuralConflicts(
  repo: Repository,
  worktree: Worktree,
  treeOid: string | null,
  options: CheckoutOptions,
  index: IndexStore,
): Set<string> {
  const removals = new Set<string>();
  const preservedRemovals = new Set<string>();
  let retainedBytes = 0;
  let activeBytes = 0;
  const activeLeaves: Array<{ path: string; upper: string; bytes: number }> = [];
  for (const row of joinSorted3(
    boundedCheckoutSourceRows(treeStream(repo, treeOid), options.maxSourceRowsPerPass, "tree"),
    stageZero(boundedCheckoutSourceRows(index.indexScan(), options.maxSourceRowsPerPass, "index")),
    walkStructuralPaths(worktree, repo.root, options.maxWorktreeRowsPerPass),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    while (
      activeLeaves.length > 0 &&
      comparePaths(row.path, activeLeaves[activeLeaves.length - 1]!.upper) >= 0
    ) {
      activeBytes -= activeLeaves.pop()!.bytes;
    }
    const current = row.c;
    if (current !== undefined && current.type !== "dir" && row.a === undefined) {
      const upper = `${current.path}0`;
      const bytes = CHECKOUT_PATH_FIXED_BYTES + current.path.length * 2 + upper.length * 2;
      if (retainedBytes + activeBytes + bytes > CHECKOUT_REMOVAL_BYTES) {
        throw new GitError(
          "E2BIG",
          `checkout structural state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
        );
      }
      activeLeaves.push({ path: current.path, upper, bytes });
      activeBytes += bytes;
    }

    const target = row.a;
    if (
      target === undefined &&
      row.b !== undefined &&
      options.prune !== false &&
      matchesPaths(row.b.path, options.paths)
    ) {
      const replacedByDirectory = current?.type === "dir";
      let replacedUnderLeaf = false;
      for (let index = activeLeaves.length - 1; index >= 0; index--) {
        if (row.b.path.startsWith(`${activeLeaves[index]!.path}/`)) {
          replacedUnderLeaf = true;
          break;
        }
      }
      if ((replacedByDirectory || replacedUnderLeaf) && !preservedRemovals.has(row.b.path)) {
        retainedBytes += CHECKOUT_PATH_FIXED_BYTES + row.b.path.length * 2;
        if (retainedBytes + activeBytes > CHECKOUT_REMOVAL_BYTES) {
          throw new GitError(
            "E2BIG",
            `checkout structural state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
          );
        }
        preservedRemovals.add(row.b.path);
      }
    }
    if (
      target === undefined ||
      target.mode === "160000" ||
      !matchesPaths(target.path, options.paths)
    ) {
      continue;
    }
    const sameIndex =
      row.b !== undefined &&
      row.b.oid === target.oid &&
      row.b.mode === Number.parseInt(target.mode, 8);
    if (options.preserveMatchingIndex === true && sameIndex) continue;

    let activeLeaf: { path: string; upper: string; bytes: number } | undefined;
    for (let index = activeLeaves.length - 1; index >= 0; index--) {
      const leaf = activeLeaves[index]!;
      if (target.path.startsWith(`${leaf.path}/`)) {
        activeLeaf = leaf;
        break;
      }
    }
    const targetType = target.mode === "120000" ? "symlink" : "file";
    const structural =
      current !== undefined && current.type !== targetType ? target.path : activeLeaf?.path;
    if (structural === undefined || removals.has(structural)) continue;
    if (activeLeaf?.path === structural) {
      activeBytes -= activeLeaf.bytes;
      activeLeaves.splice(activeLeaves.indexOf(activeLeaf), 1);
    }
    retainedBytes += CHECKOUT_PATH_FIXED_BYTES + structural.length * 2;
    if (retainedBytes + activeBytes > CHECKOUT_REMOVAL_BYTES) {
      throw new GitError(
        "E2BIG",
        `checkout structural state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
      );
    }
    removals.add(structural);
  }

  const paths = [...removals].sort(comparePaths);
  for (const batch of planWorktreeRemovalBatches(repo, paths, "checkout structural removal")) {
    worktree.removeFiles(
      batch.map((path) => joinPath(repo.root, path)),
      { recursive: true },
    );
  }
  return preservedRemovals;
}

function* boundedCheckoutWorktreeEntries(
  entries: Iterable<WorktreePath>,
  maxRows: number | undefined,
): Generator<WorktreePath> {
  let rows = 0;
  for (const entry of entries) {
    if (maxRows !== undefined && rows >= maxRows) {
      throw new GitError("E2BIG", `checkout worktree scan exceeds ${maxRows} rows`);
    }
    rows++;
    yield entry;
  }
}

function* boundedCheckoutSourceRows<T>(
  entries: Iterable<T>,
  maxRows: number | undefined,
  label: "tree" | "index",
): Generator<T> {
  let rows = 0;
  for (const entry of entries) {
    if (maxRows !== undefined && rows >= maxRows) {
      throw new GitError("E2BIG", `checkout ${label} scan exceeds ${maxRows} rows`);
    }
    rows++;
    yield entry;
  }
}

function checkoutWriteBudget(maxBytes: number | undefined): CheckoutWriteBudget | undefined {
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new GitError("EINVAL", "checkout write byte limit must be a safe nonnegative integer");
  }
  return { maxBytes, writtenBytes: 0 };
}

function* walkStructuralPaths(
  worktree: Worktree,
  root: string,
  maxRows?: number,
): Generator<StructuralPath> {
  const lexicalRoot = root.replace(/\/+$/, "") || "/";
  const base = worktree.realpath(lexicalRoot);
  let after: string | undefined;
  let rows = 0;
  while (true) {
    const entries = worktree.scan(base, { after, limit: CHECKOUT_WINDOW_ROWS });
    if (entries.length === 0) return;
    for (const entry of entries) {
      if (maxRows !== undefined && rows >= maxRows) {
        throw new GitError("E2BIG", `checkout structural scan exceeds ${maxRows} rows`);
      }
      rows++;
      after = entry.path;
      const path = relativeTo(base, entry.path);
      if (path !== null && path !== "") yield { path, type: entry.type };
    }
    if (entries.length < CHECKOUT_WINDOW_ROWS) return;
  }
}

interface CheckoutCandidate {
  entry: TargetEntry;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
}

function flushCheckoutCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: CheckoutCandidate[],
  written: TargetEntry[],
  sink: IndexSink,
  writeBudget: CheckoutWriteBudget | undefined,
): void {
  if (candidates.length === 0) return;
  const contentIds: Uint8Array[] = [];
  for (const candidate of candidates) {
    const existing = candidate.index;
    const current = candidate.worktree;
    if (
      existing !== undefined &&
      current !== undefined &&
      existing.oid === candidate.entry.oid &&
      existing.mode === Number.parseInt(candidate.entry.mode, 8) &&
      !indexMatchesStat(existing, current.stat) &&
      current.stat.contentId !== null
    ) {
      contentIds.push(current.stat.contentId);
    }
  }
  const mapped = repo.store.lookupBlobIds(contentIds);

  for (const candidate of candidates.splice(0, candidates.length)) {
    const existing = candidate.index;
    const current = candidate.worktree;
    const sameIndex =
      existing !== undefined &&
      existing.oid === candidate.entry.oid &&
      existing.mode === Number.parseInt(candidate.entry.mode, 8);
    const mappedOid =
      current?.stat.contentId === null || current?.stat.contentId === undefined
        ? undefined
        : mapped.get(contentIdKey(current.stat.contentId));
    const unchanged =
      sameIndex &&
      current !== undefined &&
      (indexMatchesStat(existing, current.stat) ||
        (mappedOid === existing.oid &&
          existing.mode === Number.parseInt(gitModeFor(current.stat), 8)));
    if (unchanged) continue;
    written.push(candidate.entry);
    if (written.length >= CHECKOUT_WINDOW_ROWS) {
      flushCheckoutWrites(repo, worktree, written, sink, writeBudget);
    }
  }
}

function flushRemovals(
  repo: Repository,
  worktree: Worktree,
  removed: string[],
  preserved: ReadonlySet<string>,
  sink: IndexSink,
): void {
  if (removed.length === 0) return;
  const physical = removed.filter((path) => !preserved.has(path));
  for (const batch of planWorktreeRemovalBatches(repo, physical, "checkout tracked removal")) {
    worktree.removeFiles(batch.map((path) => joinPath(repo.root, path)));
  }
  for (let offset = 0; offset < removed.length; offset += CHECKOUT_WINDOW_ROWS) {
    for (const path of removed.slice(offset, offset + CHECKOUT_WINDOW_ROWS)) sink.remove(path);
    sink.flush();
  }
}

/** Conflict stages are not what a checkout replaces, and never were. */
export function* stageZero(entries: Iterable<IndexEntry>): Generator<IndexEntry> {
  for (const entry of entries) {
    if (entry.stage === 0) yield entry;
  }
}

/** Write one tree entry to disk and describe the index row it deserves. */
export function writeEntry(repo: Repository, worktree: Worktree, entry: TargetEntry): IndexEntry {
  const absolute = joinPath(repo.root, entry.path);
  const data = repo.readBlob(entry.oid);
  if (entry.mode === "120000") {
    worktree.writeFiles([
      {
        path: absolute,
        target: new TextDecoder().decode(data),
        contentId: fromHex(entry.oid),
      },
    ]);
  } else {
    worktree.writeFiles([
      {
        path: absolute,
        bytes: data,
        mode: fileModeFor(entry.mode),
        contentId: fromHex(entry.oid),
      },
    ]);
  }
  const stat = worktree.stat(absolute);
  return {
    path: entry.path,
    stage: 0,
    mode: Number.parseInt(entry.mode, 8),
    oid: entry.oid,
    size: stat?.size ?? data.length,
    mtime: stat?.mtime ?? null,
    ino: stat?.ino ?? null,
  };
}

interface CheckoutPrunePlan {
  batches: string[][];
}

/** Preflight the retained directory state before checkout starts removing paths. */
function planEmptyDirectories(
  repo: Repository,
  worktree: Worktree,
  removed: readonly string[],
  preserved: ReadonlySet<string>,
  maxRows: number | undefined,
): CheckoutPrunePlan {
  const directories = new Map<string, boolean>();
  const physicalRemovals = new Set<string>();
  let retainedBytes = 0;
  for (const path of removed) {
    if (!preserved.has(path)) physicalRemovals.add(path);
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const directory = path.slice(0, slash);
      if (!directories.has(directory)) {
        if (directories.size >= CHECKOUT_PRUNE_PATHS) {
          throw new GitError(
            "E2BIG",
            `checkout directory-prune state exceeds ${CHECKOUT_PRUNE_PATHS} paths`,
          );
        }
        retainedBytes += CHECKOUT_PATH_FIXED_BYTES + directory.length * 2;
        if (retainedBytes > CHECKOUT_PRUNE_BYTES) {
          throw new GitError(
            "E2BIG",
            `checkout directory-prune state exceeds ${CHECKOUT_PRUNE_BYTES} bytes`,
          );
        }
        directories.set(directory, false);
      }
      slash = directory.lastIndexOf("/");
    }
  }
  if (directories.size === 0) return { batches: [] };
  for (const entry of walkWorktreeEntriesStream(worktree, repo.root, {
    includeIgnored: true,
    includeDirectories: true,
    maxScanRows: maxRows,
  })) {
    if (physicalRemovals.has(entry.path)) continue;
    if (entry.stat.type === "dir" && directories.has(entry.path)) continue;
    let candidate = entry.path;
    while (candidate !== "") {
      if (directories.has(candidate)) directories.set(candidate, true);
      const slash = candidate.lastIndexOf("/");
      candidate = slash < 0 ? "" : candidate.slice(0, slash);
    }
  }

  const roots: string[] = [];
  for (const [directory, hasContents] of directories) {
    if (hasContents) continue;
    const slash = directory.lastIndexOf("/");
    const parent = slash < 0 ? undefined : directory.slice(0, slash);
    if (parent !== undefined && directories.get(parent) === false) continue;
    roots.push(directory);
  }
  roots.sort(comparePaths);
  return {
    batches: planWorktreeRemovalBatches(repo, roots, "checkout directory pruning"),
  };
}

/** Drop preflighted empty candidate subtrees after tracked leaves are gone. */
function pruneEmptyDirectories(
  repo: Repository,
  worktree: Worktree,
  plan: CheckoutPrunePlan,
): void {
  for (const batch of plan.batches) {
    worktree.removeFiles(
      batch.map((path) => joinPath(repo.root, path)),
      { recursive: true },
    );
  }
}

/** Keep every JSON binding below the platform ceiling before the first delete. */
function planWorktreeRemovalBatches(
  repo: Repository,
  paths: readonly string[],
  label: string,
): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (batch.length === 0) return;
    if (batches.length >= CHECKOUT_REMOVE_BATCHES) {
      throw new GitError("E2BIG", `${label} exceeds ${CHECKOUT_REMOVE_BATCHES} removal batches`);
    }
    batches.push(batch);
    batch = [];
    bytes = 2;
  };

  for (const path of paths) {
    const absolute = joinPath(repo.root, path);
    const itemBytes = utf8.encode(JSON.stringify(absolute)).byteLength;
    if (itemBytes + 2 > CHECKOUT_REMOVE_BINDING_BYTES) {
      throw new GitError("E2BIG", `${label} path exceeds ${CHECKOUT_REMOVE_BINDING_BYTES} bytes`);
    }
    const separator = batch.length === 0 ? 0 : 1;
    if (batch.length > 0 && bytes + separator + itemBytes > CHECKOUT_REMOVE_BINDING_BYTES) flush();
    batch.push(path);
    bytes += (batch.length === 1 ? 0 : 1) + itemBytes;
  }
  flush();
  return batches;
}

/** Index rows describing a tree exactly, without touching the working tree. */
export function* indexFromTree(repo: Repository, treeOid: string | null): Generator<IndexEntry> {
  for (const entry of treeStream(repo, treeOid)) {
    yield {
      path: entry.path,
      stage: 0,
      mode: Number.parseInt(entry.mode, 8),
      oid: entry.oid,
      size: null,
      mtime: null,
      ino: null,
    };
  }
}

export function isTree(entry: TreeEntry): boolean {
  return isTreeMode(entry.mode);
}
