import { contentIdKey, type IndexEntry } from "../../sqlite/store.js";
import type { GitContext, IndexTrackerSeedEntry } from "../context.js";
import { CorruptError, hasErrorCode } from "../errors.js";
import { loadIgnoreMatcher } from "../ignore/index.js";
import type { Repository } from "../repository.js";
import type { SparseWorkspaceResult, SparseWorkspaceRow } from "../sparse-workspace.js";
import { comparePaths } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import type { TargetEntry } from "./checkout.js";
import {
  type BufferedStatusRow,
  flushStatusRows,
  ignoredRow,
  octalMode,
  oneStatusIndexGroup,
  type StatusDetail,
  type StatusIndexGroup,
  type StatusOptions,
  trackedRow,
  unmergedRow,
  untrackedRow,
} from "./status-rows.js";
import {
  type HashedPath,
  hashExactWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
} from "./worktree-io.js";

const SPARSE_STATUS_PATHS = 1_000;
const SPARSE_INDEX_DIRTY = 1;
const SPARSE_WORKTREE_DIRTY = 2;
const FULL_STATUS_TRACKER_ROWS = 32_000;
const FULL_STATUS_TRACKER_BYTES = 16 * 1024 * 1024;
const FULL_STATUS_TRACKER_FIXED_BYTES = 256;
const FULL_STATUS_TRACKER_ROW_BYTES = 256;
const TRACKER_PATH_BYTES = 2_200;

/** Bounded dirty-leaf snapshot collected only by the eager repair pass. */
export class FullStatusTrackerSeed {
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

export function sparseStatus(
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
      source.dirtyPaths(repo.checkout.checkoutId),
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
      checkoutId: repo.checkout.checkoutId,
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
    const group = oneStatusIndexGroup(row.index, row.path);
    const untracked =
      row.current === null && group === undefined && sparseWorktreePath(row) !== undefined;
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
    const group = oneStatusIndexGroup(row.index, row.path);
    const stage = group?.kind === "tracked" ? group.entry : undefined;
    const worktreePath = sparseWorktreePath(row);
    const untracked = row.current === null && group === undefined && worktreePath !== undefined;
    const ignored = ignoredUntracked.has(path);
    if (untracked && options.includeIgnored !== true && ignored) {
      retained.set(path, SPARSE_WORKTREE_DIRTY);
    } else if (untracked) {
      buffered.push({
        kind: "ready",
        detail: ignored ? ignoredRow(path) : untrackedRow(path),
      });
    } else if (group?.kind === "unmerged") {
      buffered.push({ kind: "ready", detail: unmergedRow(group, worktreePath) });
    } else {
      const detail = trackedRow(path, sparseTarget(path, row), stage, worktreePath);
      if (detail !== null) buffered.push(detail);
    }
    let flags = retained.get(path) ?? 0;
    if (sparseIndexDirty(row, group) || stage?.mode === 0o160000) flags |= SPARSE_INDEX_DIRTY;
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
  tracker.reseal(repo.checkout.checkoutId, currentTreeOid, seed);
  return details;
}

function sparseIndexDirty(row: SparseWorkspaceRow, group: StatusIndexGroup | undefined): boolean {
  if (group?.kind === "unmerged") return true;
  const stage = group?.entry;
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
    const group = oneStatusIndexGroup(row.index, row.path);
    if (group?.kind === "unmerged") {
      dirty.add(row.path);
      continue;
    }
    const entry = group?.entry;
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
