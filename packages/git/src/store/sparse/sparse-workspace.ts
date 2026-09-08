import { GitError, hasErrorCode } from "../../common/errors.js";
import type {
  CommitTreeSnapshotRequest,
  CommitTreeSnapshotResult,
  CommitTreeSnapshotSource,
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSource,
  SparseIndexAncestorRequest,
  SparseIndexAncestorResult,
  SparseWorkspaceDirty,
  SparseWorkspaceRequest,
  SparseWorkspaceResult,
  SparseWorkspaceSource,
} from "../core/contracts.js";

export { hasSparseSourceReceipt } from "./receipt.js";

export function selectSparsePathsOwned(
  source: SelectedPathSource,
  request: SelectedPathRequest,
): SelectedPathResult {
  try {
    return source.select(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

export function snapshotCommitTreeOwned(
  source: CommitTreeSnapshotSource,
  request: CommitTreeSnapshotRequest,
): CommitTreeSnapshotResult {
  try {
    return source.snapshot(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

export function sparseDirtyPathsOwned(
  source: SparseWorkspaceSource,
  checkoutId: number,
): Iterable<SparseWorkspaceDirty> {
  return source.dirtyPaths(checkoutId);
}

export function hydrateSparseWorkspaceOwned(
  source: SparseWorkspaceSource,
  request: SparseWorkspaceRequest,
): SparseWorkspaceResult {
  try {
    return source.hydrate(request);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

export function sparseIndexAncestorFactsOwned(
  source: SparseWorkspaceSource,
  request: SparseIndexAncestorRequest,
): SparseIndexAncestorResult {
  const result = source.indexAncestorFacts?.(request);
  if (result === undefined) {
    throw new GitError("EUNSUPPORTED", "sparse index ancestor source is unavailable");
  }
  return result;
}
