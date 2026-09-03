import { fromHex, utf8 } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { isTreeMode, type TreeEntry } from "../common/objects.js";
import { joinPath, relativeTo } from "../common/paths.js";
import { comparePaths } from "../common/streams.js";
import { contentIdKey, type IndexEntry, type IndexSink, type IndexStore } from "../store/index.js";
import type { CheckoutInternalOptions, CheckoutOptions } from "./checkout-types.js";
import { type CheckoutWriteBudget, flushCheckoutWrites } from "./checkout-writes.js";
import type { Repository } from "./repository.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import { fileModeFor, gitModeFor, type Worktree } from "./worktree.js";
import { indexMatchesStat, type WorktreePath } from "./worktree-io.js";

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

export const CHECKOUT_WINDOW_ROWS = 1_000;
export const CHECKOUT_REMOVAL_BYTES = 16 * 1024 * 1024;
export const CHECKOUT_PRUNE_BYTES = 16 * 1024 * 1024;
export const CHECKOUT_PRUNE_PATHS = 50_000;
export const CHECKOUT_PATH_FIXED_BYTES = 96;
export const CHECKOUT_UNMERGED_PATHS = 10_000;
export const CHECKOUT_UNMERGED_BYTES = 4 * 1024 * 1024;
const CHECKOUT_EXCLUDE_ROOTS = 64;
const CHECKOUT_EXCLUDE_BYTES = 1024 * 1024;

export function checkoutInternalOptions(
  repo: Repository,
  options: CheckoutOptions,
  excludeRoots: readonly string[],
): CheckoutInternalOptions {
  if (excludeRoots.length > CHECKOUT_EXCLUDE_ROOTS) {
    throw new GitError("E2BIG", `checkout exclusions exceed ${CHECKOUT_EXCLUDE_ROOTS} roots`);
  }
  const absolute: string[] = [];
  const relative: string[] = [];
  let retainedBytes = 0;
  for (const root of excludeRoots) {
    const path = relativeTo(repo.root, root);
    if (path === null || path === "") {
      throw new GitError("EINVAL", `checkout exclusion ${root} is not nested under ${repo.root}`);
    }
    retainedBytes += utf8.encode(root).byteLength + utf8.encode(path).byteLength;
    if (retainedBytes > CHECKOUT_EXCLUDE_BYTES) {
      throw new GitError("E2BIG", `checkout exclusions exceed ${CHECKOUT_EXCLUDE_BYTES} bytes`);
    }
    if (relative.includes(path)) continue;
    absolute.push(root);
    relative.push(path);
  }
  absolute.sort(comparePaths);
  relative.sort(comparePaths);
  return { ...options, excludeRoots: absolute, relativeExcludeRoots: relative };
}

export function intersectsExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
  );
}

export function readOnlyIndex(repo: Repository): IndexStore {
  return {
    indexScan: (options) => repo.checkout.indexScan(options),
    indexApply: (body) => body(NOOP_INDEX_SINK),
    indexReplace: () => {
      throw new Error("worktree-only checkout cannot replace the index");
    },
    hasConflicts: () => repo.checkout.hasConflicts(),
  };
}

export function* targetFromIndex(entries: Iterable<IndexEntry>): Generator<TargetEntry> {
  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    yield { path: entry.path, mode: entry.mode.toString(8), oid: entry.oid };
  }
}

const NOOP_INDEX_SINK: IndexSink = {
  put() {},
  remove() {},
  flush() {},
};

export function* boundedCheckoutWorktreeEntries(
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

export function* boundedCheckoutSourceRows<T>(
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

export function checkoutWriteBudget(maxBytes: number | undefined): CheckoutWriteBudget | undefined {
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new GitError("EINVAL", "checkout write byte limit must be a safe nonnegative integer");
  }
  return { maxBytes, writtenBytes: 0 };
}

export interface CheckoutCandidate {
  entry: TargetEntry;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
}

export function flushCheckoutCandidates(
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
