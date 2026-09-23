import { CorruptError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SelectedPathResult,
  SparseWorkspaceResult,
  SparseWorkspaceRow,
  SparseWorktreeLeaf,
} from "../../store/core/contracts.js";
import type { IndexEntry } from "../../store/index.js";
import type { SparseCheckoutCandidate } from "./sparse-checkout-operation.js";

type AvailableSparseWorkspaceResult = Extract<SparseWorkspaceResult, { available: true }>;

export function selectedSparseWorkspaceRows(
  candidates: readonly SparseCheckoutCandidate[],
  selected: Extract<SelectedPathResult, { available: true }>,
): AvailableSparseWorkspaceResult {
  const rows: SparseWorkspaceRow[] = [];
  let indexAt = 0;
  let worktreeAt = 0;
  for (const candidate of candidates) {
    const indexRows: IndexEntry[] = [];
    let indexEntry = selected.index[indexAt];
    if (indexEntry !== undefined && comparePaths(indexEntry.path, candidate.path) < 0) {
      throw new CorruptError("selected sparse checkout returned an unrelated index path");
    }
    while (indexEntry !== undefined && indexEntry.path === candidate.path) {
      indexRows.push(indexEntry);
      indexAt++;
      indexEntry = selected.index[indexAt];
    }

    let worktree: SparseWorktreeLeaf | null = null;
    const worktreeEntry = selected.worktree[worktreeAt];
    if (worktreeEntry !== undefined && comparePaths(worktreeEntry.path, candidate.path) < 0) {
      throw new CorruptError("selected sparse checkout returned an unrelated worktree path");
    }
    if (worktreeEntry?.path === candidate.path) {
      worktree = worktreeEntry.stat;
      worktreeAt++;
    }
    rows.push({
      path: candidate.path,
      baseline: candidate.before === undefined ? null : candidate.before,
      current: candidate.after === undefined ? null : candidate.after,
      index: indexRows,
      worktree,
    });
  }
  if (indexAt !== selected.index.length) {
    throw new CorruptError("selected sparse checkout returned an unrelated index path");
  }
  if (worktreeAt !== selected.worktree.length) {
    throw new CorruptError("selected sparse checkout returned an unrelated worktree path");
  }
  return { available: true, rows };
}
