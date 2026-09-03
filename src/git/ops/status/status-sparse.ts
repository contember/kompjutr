import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../../ignore/index.js";
import { contentIdKey, type IndexEntry } from "../../store/index.js";
import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
import {
  hasSparseSourceReceipt,
  hydrateSparseWorkspaceOwned,
  sparseDirtyPathsOwned,
  sparseIndexAncestorFactsOwned,
} from "../../store/sparse/sparse-workspace.js";
import type { TargetEntry } from "../checkout/checkout.js";
import type { GitContext, IndexTrackerSeedEntry } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import type {
  SparseIndexAncestorFact,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
} from "../worktree/sparse-workspace.js";
import { gitModeFor, type Worktree } from "../worktree/worktree.js";
import {
  type HashedPath,
  hashExactWorktreePathsOwned,
  indexMatchesStat,
  type WorktreePath,
} from "../worktree/worktree-io.js";
import {
  type ExactRenameClassification,
  ExactRenameClassifier,
  renameDetectionEnabled,
} from "./rename-detection.js";
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

const SPARSE_STATUS_PATHS = 1_000;
const SPARSE_STATUS_ANCESTORS = 32_768;
const SPARSE_INDEX_DIRTY = 1;
const SPARSE_WORKTREE_DIRTY = 2;

export { FullStatusTrackerSeed } from "./status-sparse-tracker.js";

export function sparseStatus(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions,
  context: Pick<GitContext, "sparseWorkspace" | "indexTracker">,
  baselineTreeOid: string | null,
): SparseStatusResult | null {
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
  return { details: prepared.details, renames: prepared.renames };
}

export interface SparseStatusResult {
  details: StatusDetail[];
  renames: ExactRenameClassification | undefined;
}

interface PreparedSparseStatus {
  details: StatusDetail[];
  renames: ExactRenameClassification | undefined;
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
  const renameClassifier = renameDetectionEnabled(repo, "status", options.renames)
    ? new ExactRenameClassifier()
    : undefined;
  if (candidates.length === 0) {
    return { details: [], renames: renameClassifier?.finish(), reseal: null };
  }

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
  let classifyingRenames = renameClassifier !== undefined;
  const ignoredUntracked = new Set<string>();
  const reportableUntracked: string[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const path = candidates[index];
    const row = hydrated.rows[index];
    if (path === undefined || row === undefined || row.path !== path) {
      throw new CorruptError("sparse status hydration returned unordered rows");
    }
    const group = oneStatusIndexGroup(row.index, row.path);
    if (renameClassifier !== undefined && classifyingRenames && group?.kind !== "unmerged") {
      const stage = group?.entry;
      let retained = true;
      if (row.current !== null && stage === undefined && isRenameMode(row.current.mode)) {
        retained = renameClassifier.addSource({ path, ...row.current });
      } else if (row.current === null && stage !== undefined && stage.mode !== 0o160000) {
        retained = renameClassifier.addDestination({
          path,
          mode: octalMode(stage.mode),
          oid: stage.oid,
        });
      }
      if (!retained) classifyingRenames = false;
    }
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
        ancestorFacts = hasSparseSourceReceipt(repo.checkout.db, "workspace", source)
          ? new Map(result.facts.map((fact) => [fact.path, fact]))
          : validatedAncestorFacts(ancestors.paths, result.facts);
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
  return {
    details,
    renames: renameClassifier?.finish(),
    reseal: { currentTreeOid, seed },
  };
}

function isRenameMode(mode: string): boolean {
  return mode === "100644" || mode === "100755" || mode === "120000";
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
  sharedRepoStoreMutations(repo.store).upsertBlobIdsOwned(
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
