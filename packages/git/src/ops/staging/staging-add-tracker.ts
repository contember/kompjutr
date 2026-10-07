import { hasErrorCode } from "../../common/errors.js";
import type { SparseWorkspaceRow, SparseWorkspaceSource } from "../../store/core/contracts.js";
import type { IndexEntry } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import { hydrateSparseCandidates, sparseCandidatePaths } from "../worktree/sparse-candidates.js";
import type { WorktreePath } from "../worktree/worktree-io.js";

export interface TrackedAddSources {
  index: IndexEntry[];
  worktree: WorktreePath[];
  head: TargetEntry[];
}

/**
 * Whole-tree add inputs restricted to the complete tracker's candidates, the
 * set sparse status hydrates. Null means the tracker cannot answer and the
 * caller takes the full scan.
 */
export function trackedAddSources(
  repo: Repository,
  source: SparseWorkspaceSource | undefined,
): TrackedAddSources | null {
  if (source === undefined) return null;
  try {
    const state = source.readState(repo.checkout.checkoutId);
    if (!state.available) return null;
    const currentTreeOid = repo.headTree();
    const paths = sparseCandidatePaths(
      repo,
      source.dirtyPaths(repo.checkout.checkoutId),
      state.baselineTreeOid,
      currentTreeOid,
    );
    if (paths === null) return null;
    if (paths.length === 0) return { index: [], worktree: [], head: [] };
    const rows = hydrateSparseCandidates(
      repo,
      source,
      state.baselineTreeOid,
      currentTreeOid,
      paths,
    );
    return rows === null ? null : trackedRows(rows);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

function trackedRows(rows: readonly SparseWorkspaceRow[]): TrackedAddSources {
  const sources: TrackedAddSources = { index: [], worktree: [], head: [] };
  for (const row of rows) {
    sources.index.push(...row.index);
    if (row.worktree !== null && row.worktree.type !== "dir") {
      sources.worktree.push({ path: row.path, stat: row.worktree });
    }
    if (row.current !== null) {
      sources.head.push({ path: row.path, mode: row.current.mode, oid: row.current.oid });
    }
  }
  return sources;
}
