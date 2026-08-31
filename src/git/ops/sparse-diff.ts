import { utf8 } from "../common/bytes.js";
import { CorruptError, hasErrorCode } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";
import { matchesPaths } from "./checkout.js";
import {
  compareIdentities,
  type DiffOptions,
  type EndpointIdentity,
  type PendingChange,
  type WorkingCandidate,
} from "./diff-internal.js";
import type { Repository } from "./repository.js";
import type { SparseWorkspaceRow, SparseWorkspaceSource } from "./sparse-workspace.js";
import type { TargetEntry } from "./tree-stream.js";
import type { WorktreePath } from "./worktree-io.js";

const SPARSE_DIFF_PATHS = 1000;
const SPARSE_DIFF_RETAINED_BYTES = 16 * 1024 * 1024;
const SPARSE_DIFF_ROW_BYTES = 1024;

export function sparseCommitPair(
  repo: Repository,
  beforeTreeOid: string | null,
  afterTreeOid: string | null,
  options: DiffOptions,
): PendingChange[] | null {
  const changes: PendingChange[] = [];
  let matchingEntries = 0;
  let retainedBytes = 0;
  try {
    for (const entry of repo.walkTreeDiff(beforeTreeOid, afterTreeOid)) {
      if (!matchesPaths(entry.path, options.paths)) continue;
      if (matchingEntries >= SPARSE_DIFF_PATHS) return null;
      matchingEntries++;
      retainedBytes += SPARSE_DIFF_ROW_BYTES + utf8.encode(entry.path).length;
      if (retainedBytes > SPARSE_DIFF_RETAINED_BYTES) return null;
      const change = compareIdentities(
        entry.path,
        treePartsIdentity(entry.beforeMode, entry.beforeOid),
        treePartsIdentity(entry.afterMode, entry.afterOid),
      );
      if (change !== null) changes.push(change);
    }
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  return changes;
}

export function sparseWorkingCandidates(
  repo: Repository,
  source: SparseWorkspaceSource,
  currentTreeOid: string | null,
  options: DiffOptions,
): WorkingCandidate[] | null {
  try {
    const state = source.readState(repo.checkout.checkoutId);
    if (!state.available) return null;
    const paths = sparseWorkingPaths(
      repo,
      source.dirtyPaths(repo.checkout.checkoutId),
      state.baselineTreeOid,
      currentTreeOid,
      options.paths,
    );
    if (paths === null) return null;
    if (paths.length === 0) return [];

    const hydrated = source.hydrate({
      repoId: repo.store.repoId,
      checkoutId: repo.checkout.checkoutId,
      root: repo.root,
      baselineTreeOid: state.baselineTreeOid,
      currentTreeOid,
      paths,
    });
    if (!hydrated.available) return null;
    if (hydrated.rows.length !== paths.length) {
      throw new CorruptError("sparse diff hydration returned the wrong row count");
    }

    const candidates: WorkingCandidate[] = [];
    for (let ordinal = 0; ordinal < paths.length; ordinal++) {
      const path = paths[ordinal];
      const row = hydrated.rows[ordinal];
      if (path === undefined || row === undefined || row.path !== path) {
        throw new CorruptError("sparse diff hydration returned unordered rows");
      }
      const stage = row.index.find((entry) => entry.stage === 0);
      if (row.current === null && stage === undefined) continue;
      candidates.push({
        path,
        before: sparseTarget(path, row),
        index: stage !== undefined && stage.mode !== 0o160000 ? stage : undefined,
        worktree: sparseWorktreePath(row),
      });
    }
    return candidates;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

function sparseWorkingPaths(
  repo: Repository,
  dirty: Iterable<{ path: string }>,
  baselineTreeOid: string | null,
  currentTreeOid: string | null,
  pathspecs: string[] | undefined,
): string[] | null {
  const paths = new Set<string>();
  let retainedBytes = 0;
  const add = (path: string): boolean => {
    if (!matchesPaths(path, pathspecs) || paths.has(path)) return true;
    retainedBytes += SPARSE_DIFF_ROW_BYTES + utf8.encode(path).length;
    if (paths.size >= SPARSE_DIFF_PATHS || retainedBytes > SPARSE_DIFF_RETAINED_BYTES) return false;
    paths.add(path);
    return true;
  };
  for (const entry of dirty) {
    if (!add(entry.path)) return null;
  }
  for (const entry of repo.walkTreeDiff(baselineTreeOid, currentTreeOid)) {
    if (!add(entry.path)) return null;
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

function treePartsIdentity(mode: string | null, oid: string | null): EndpointIdentity | null {
  if (mode === null || oid === null || mode === "160000") return null;
  return { mode, oid, worktree: null };
}
