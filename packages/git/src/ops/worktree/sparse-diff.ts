import { CorruptError, hasErrorCode } from "../../common/errors.js";
import type { SparseWorkspaceRow, SparseWorkspaceSource } from "../../store/core/contracts.js";
import { matchesPaths } from "../checkout/checkout.js";
import {
  compareIdentities,
  type DiffOptions,
  type EndpointIdentity,
  type PendingChange,
  type WorkingCandidate,
} from "../diff/diff-internal.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import { hydrateSparseCandidates, sparseCandidatePaths } from "./sparse-candidates.js";
import type { WorktreePath } from "./worktree-io.js";

const SPARSE_DIFF_PATHS = 1000;

export function sparseCommitPair(
  repo: Repository,
  beforeTreeOid: string | null,
  afterTreeOid: string | null,
  options: DiffOptions,
): PendingChange[] | null {
  const changes: PendingChange[] = [];
  let matchingEntries = 0;
  try {
    for (const entry of repo.walkTreeDiff(beforeTreeOid, afterTreeOid)) {
      if (!matchesPaths(entry.path, options.paths)) continue;
      if (matchingEntries >= SPARSE_DIFF_PATHS) return null;
      matchingEntries++;
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
    const paths = sparseCandidatePaths(
      repo,
      source.dirtyPaths(repo.checkout.checkoutId),
      state.baselineTreeOid,
      currentTreeOid,
      (path) => matchesPaths(path, options.paths),
    );
    if (paths === null) return null;
    if (paths.length === 0) return [];

    const rows = hydrateSparseCandidates(
      repo,
      source,
      state.baselineTreeOid,
      currentTreeOid,
      paths,
    );
    if (rows === null) return null;

    const candidates: WorkingCandidate[] = [];
    for (let ordinal = 0; ordinal < paths.length; ordinal++) {
      const path = paths[ordinal];
      const row = rows[ordinal];
      if (path === undefined || row === undefined) {
        throw new CorruptError("sparse diff hydration lost a row");
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
