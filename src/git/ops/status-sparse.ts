import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import { contentIdKey, type IndexEntry } from "../store/index.js";
import {
  hydrateSparseWorkspaceOwned,
  sparseDirtyPathsOwned,
  sparseIndexAncestorFactsOwned,
} from "../store/sparse-workspace.js";
import type { TargetEntry } from "./checkout.js";
import type { GitContext, IndexTrackerSeedEntry } from "./context.js";
import type { Repository } from "./repository.js";
import type {
  SparseIndexAncestorFact,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
} from "./sparse-workspace.js";
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
import { gitModeFor, type Worktree } from "./worktree.js";
import {
  type HashedPath,
  hashExactWorktreePathsOwned,
  indexMatchesStat,
  type WorktreePath,
} from "./worktree-io.js";

const SPARSE_STATUS_PATHS = 1_000;
const SPARSE_STATUS_ANCESTORS = 32_768;
const SPARSE_INDEX_DIRTY = 1;
const SPARSE_WORKTREE_DIRTY = 2;

/** Bounded dirty-leaf snapshot collected only by the eager repair pass. */
export class FullStatusTrackerSeed {
  #entries = new Map<string, number>();
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
    if (!trackerPathRepresentable(path)) {
      this.#disable();
      return;
    }
    this.#entries.set(path, flags);
  }

  #disable(): void {
    this.#available = false;
    this.#entries = new Map();
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
  let prepared: PreparedSparseStatus | null;
  try {
    prepared = prepareSparseStatus(repo, worktree, options, context, baselineTreeOid);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  if (prepared === null) return null;
  if (prepared.reseal !== null) {
    tracker.reseal(repo.checkout.checkoutId, prepared.reseal.currentTreeOid, prepared.reseal.seed);
  }
  return prepared.details;
}

interface PreparedSparseStatus {
  details: StatusDetail[];
  reseal: { currentTreeOid: string | null; seed: IndexTrackerSeedEntry[] } | null;
}

function prepareSparseStatus(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  context: Pick<GitContext, "sparseWorkspace" | "indexTracker">,
  baselineTreeOid: string | null,
): PreparedSparseStatus | null {
  const source = context.sparseWorkspace;
  if (source === undefined || context.indexTracker === undefined) return null;
  const currentTreeOid = repo.headTree();
  let candidates: string[] | null;
  try {
    candidates = sparseStatusCandidates(
      repo,
      sparseDirtyPathsOwned(source, repo.checkout.checkoutId),
      baselineTreeOid,
      currentTreeOid,
    );
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  if (candidates === null) return null;
  if (candidates.length === 0) return { details: [], reseal: null };

  const hydrated: SparseWorkspaceResult = hydrateSparseWorkspaceOwned(source, {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    baselineTreeOid,
    currentTreeOid,
    paths: candidates,
  });
  if (!hydrated.available) return null;
  if (hydrated.rows.length !== candidates.length) {
    throw new CorruptError("sparse status hydration returned the wrong row count");
  }
  const untrackedMode = options.untrackedFiles ?? "normal";
  let ignores = options.ignores;
  const ignoredUntracked = new Set<string>();
  const reportableUntracked: string[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const path = candidates[index];
    const row = hydrated.rows[index];
    if (path === undefined || row === undefined || row.path !== path) {
      throw new CorruptError("sparse status hydration returned unordered rows");
    }
    const group = oneStatusIndexGroup(row.index, row.path);
    if (group !== undefined || sparseWorktreePath(row) === undefined || untrackedMode === "no") {
      continue;
    }
    if (ignores === undefined) ignores = loadIgnoreMatcher(worktree, repo.root);
    const ignored = ignores.ignores(path, false);
    if (ignored) ignoredUntracked.add(path);
    if (options.includeIgnored === true || !ignored) reportableUntracked.push(path);
  }

  let ancestorFacts = new Map<string, SparseIndexAncestorFact>();
  if (untrackedMode === "normal" && reportableUntracked.length !== 0) {
    try {
      const ancestors = sparseUntrackedAncestors(reportableUntracked);
      if (ancestors.paths.length !== 0) {
        if (source.indexAncestorFacts === undefined) return null;
        const result = sparseIndexAncestorFactsOwned(source, {
          checkoutId: repo.checkout.checkoutId,
          ancestors: ancestors.paths,
        });
        if (result.facts.length !== ancestors.paths.length) {
          throw new CorruptError("sparse index ancestor lookup returned the wrong fact count");
        }
        ancestorFacts = validatedAncestorFacts(ancestors.paths, result.facts);
      }
    } catch (error) {
      if (hasErrorCode(error, "E2BIG")) return null;
      throw error;
    }
  }

  const worktreeComparison = compareSparseWorktree(repo, worktree, hydrated.rows);
  const buffered: BufferedStatusRow[] = [];
  const retained = new Map<string, number>();
  const collapsedIgnored = new Set<string>();
  const collapsedUntracked = new Set<string>();
  for (let index = 0; index < candidates.length; index++) {
    const path = candidates[index];
    const row = hydrated.rows[index];
    if (path === undefined || row === undefined)
      throw new CorruptError("sparse status row missing");
    const group = oneStatusIndexGroup(row.index, row.path);
    const stage = group?.kind === "tracked" ? group.entry : undefined;
    const worktreePath = sparseWorktreePath(row);
    const untracked = group === undefined && worktreePath !== undefined;
    const ignored = ignoredUntracked.has(path);
    if (group?.kind === "unmerged") {
      buffered.push({ kind: "ready", detail: unmergedRow(group, worktreePath) });
    } else {
      const detail = trackedRow(path, sparseTarget(path, row), stage, worktreePath);
      if (detail !== null) buffered.push(detail);
    }
    if (untracked && untrackedMode !== "no") {
      if (options.includeIgnored !== true && ignored) {
        retained.set(path, SPARSE_WORKTREE_DIRTY);
      } else {
        const reportedPath =
          untrackedMode === "normal"
            ? sparseCollapsedUntrackedPath(path, ignored, ancestorFacts, ignores)
            : path;
        const collapsed = ignored ? collapsedIgnored : collapsedUntracked;
        if (reportedPath !== null && !collapsed.has(reportedPath)) {
          collapsed.add(reportedPath);
          buffered.push({
            kind: "ready",
            detail: ignored ? ignoredRow(reportedPath) : untrackedRow(reportedPath),
          });
        }
      }
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
  return { details, reseal: { currentTreeOid, seed } };
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
  const hashed = hashExactWorktreePathsOwned(repo, worktree, unresolved, {
    write: false,
  });
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
  const add = (path: string): boolean => {
    if (paths.has(path)) return true;
    if (paths.size === SPARSE_STATUS_PATHS) return false;
    paths.add(path);
    return true;
  };
  for (const entry of dirty) {
    if (!add(entry.path)) {
      return null;
    }
  }
  for (const entry of repo.store.walkTreeDiff(baselineTreeOid, currentTreeOid)) {
    if (!add(entry.path)) {
      return null;
    }
  }
  return [...paths].sort(comparePaths);
}

function sparseUntrackedAncestors(paths: readonly string[]): { paths: string[] } {
  const ancestors = new Set<string>();
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      const ancestor = path.slice(0, slash);
      if (ancestors.has(ancestor)) continue;
      if (ancestors.size === SPARSE_STATUS_ANCESTORS) {
        throw new GitError("E2BIG", "sparse status has too many untracked ancestors");
      }
      ancestors.add(ancestor);
    }
  }
  return { paths: [...ancestors].sort(comparePaths) };
}

function validatedAncestorFacts(
  ancestors: readonly string[],
  facts: readonly SparseIndexAncestorFact[],
): Map<string, SparseIndexAncestorFact> {
  const result = new Map<string, SparseIndexAncestorFact>();
  for (let index = 0; index < ancestors.length; index++) {
    const path = ancestors[index];
    const fact = facts[index];
    if (
      path === undefined ||
      fact === undefined ||
      fact.path !== path ||
      typeof fact.exact !== "boolean" ||
      typeof fact.descendant !== "boolean"
    ) {
      throw new CorruptError("sparse index ancestor lookup returned unordered facts");
    }
    result.set(path, fact);
  }
  return result;
}

function sparseCollapsedUntrackedPath(
  path: string,
  ignored: boolean,
  facts: ReadonlyMap<string, SparseIndexAncestorFact>,
  ignores: IgnoreMatcher | undefined,
): string | null {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const directory = path.slice(0, slash);
    const fact = facts.get(directory);
    if (fact === undefined) {
      throw new CorruptError("sparse index ancestor lookup omitted a path");
    }
    if (!fact.descendant && (!ignored || ignores?.ignores(directory, true) === true)) {
      return fact.exact ? null : `${directory}/`;
    }
  }
  return path;
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
  let segmentStart = 0;
  for (let at = 0; at < path.length; at++) {
    const unit = path.charCodeAt(at);
    if (unit === 0x2f) {
      if (!validTrackerSegment(path, segmentStart, at)) return false;
      segmentStart = at + 1;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(++at);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
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
