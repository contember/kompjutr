// Bounded clean-workspace checkout without traversing the full tree.

import { CorruptError, hasErrorCode } from "../common/errors.js";
import {
  hasSparseSourceReceipt,
  hydrateSparseWorkspaceOwned,
  selectSparsePathsOwned,
  sparseDirtyPathsOwned,
} from "../store/sparse-workspace.js";
import type { GitContext } from "./context.js";
import type { Repository } from "./repository.js";
import { checkoutSparseChanges, type SparseCheckoutChange } from "./sparse-checkout-apply.js";
import { selectedSparseWorkspaceRows } from "./sparse-checkout-selected.js";
import {
  sparseCheckoutWorktreeMatches,
  validateSparseCheckoutRows,
} from "./sparse-checkout-validation.js";
import type { SelectedPathResult, SparseWorkspaceResult } from "./sparse-workspace.js";
import type { TargetEntry } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";

const SPARSE_CHECKOUT_PATHS = 1_000;

export interface SparseCheckoutCandidate {
  path: string;
  before: TargetEntry | undefined;
  after: TargetEntry | undefined;
}

type AvailableSparseWorkspaceResult = Extract<SparseWorkspaceResult, { available: true }>;
interface SparseCheckoutHydration {
  result: AvailableSparseWorkspaceResult;
  trusted: boolean;
}

export function trySparseCleanCheckout(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  targetTreeOid: string,
): boolean {
  const source = context.sparseWorkspace;
  const tracker = context.indexTracker;
  if (source === undefined || tracker === undefined) return false;

  let applying = false;
  try {
    const baselineTreeOid = repo.headTree();
    const state = source.readState(repo.checkout.checkoutId);
    if (!state.available || state.baselineTreeOid !== baselineTreeOid) return false;
    for (const _entry of sparseDirtyPathsOwned(source, repo.checkout.checkoutId)) {
      return false;
    }
    if (repo.checkout.hasCheckoutBlockingIndexEntries()) return false;

    const candidates = sparseCheckoutCandidates(repo, baselineTreeOid, targetTreeOid);
    if (candidates === null) return false;
    if (candidates.length === 0) return true;

    const selected = selectSparseCheckoutRows(context, repo, candidates);
    const loaded =
      selected ??
      hydrateSparseCheckoutRows(source, repo, candidates, baselineTreeOid, targetTreeOid);
    if (loaded === null) return false;
    const hydrated = loaded.result;
    if (hydrated.rows.length !== candidates.length) {
      throw new CorruptError("sparse checkout hydration returned the wrong row count");
    }
    if (!loaded.trusted && !validateSparseCheckoutRows(candidates, hydrated.rows)) return false;
    if (!sparseCheckoutWorktreeMatches(repo, worktree, hydrated.rows)) return false;

    const changes: SparseCheckoutChange[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const row = hydrated.rows[index];
      if (candidate === undefined || row === undefined) {
        throw new CorruptError("sparse checkout hydration lost a candidate");
      }
      changes.push({
        path: candidate.path,
        before: candidate.before,
        after: candidate.after,
        worktreeType: row.worktree?.type ?? null,
      });
    }
    applying = true;
    return checkoutSparseChanges(repo, worktree, changes);
  } catch (error) {
    if (!applying && hasErrorCode(error, "E2BIG")) return false;
    throw error;
  }
}

function hydrateSparseCheckoutRows(
  source: NonNullable<GitContext["sparseWorkspace"]>,
  repo: Repository,
  candidates: readonly SparseCheckoutCandidate[],
  baselineTreeOid: string | null,
  targetTreeOid: string,
): SparseCheckoutHydration | null {
  const hydrated = hydrateSparseWorkspaceOwned(source, {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    baselineTreeOid,
    currentTreeOid: targetTreeOid,
    paths: candidates.map((candidate) => candidate.path),
  });
  return hydrated.available
    ? {
        result: hydrated,
        trusted: hasSparseSourceReceipt(repo.checkout.db, "workspace", source),
      }
    : null;
}

function selectSparseCheckoutRows(
  context: GitContext,
  repo: Repository,
  candidates: readonly SparseCheckoutCandidate[],
): SparseCheckoutHydration | null {
  const source = context.selectedPaths;
  if (source === undefined || hasStructuralCandidates(candidates)) return null;
  const selected: SelectedPathResult = selectSparsePathsOwned(source, {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    specs: candidates.map((candidate) => ({ path: candidate.path, recursive: false })),
  });
  if (!selected.available) return null;
  const trusted = hasSparseSourceReceipt(repo.checkout.db, "selected-paths", source);
  return { result: selectedSparseWorkspaceRows(candidates, selected, trusted), trusted };
}

function hasStructuralCandidates(candidates: readonly SparseCheckoutCandidate[]): boolean {
  for (let left = 0; left < candidates.length; left++) {
    const parent = candidates[left];
    if (parent === undefined) continue;
    for (let right = left + 1; right < candidates.length; right++) {
      const child = candidates[right];
      if (
        child !== undefined &&
        child.path.length > parent.path.length &&
        child.path.startsWith(parent.path) &&
        child.path.charCodeAt(parent.path.length) === 0x2f
      ) {
        return true;
      }
    }
  }
  return false;
}

function sparseCheckoutCandidates(
  repo: Repository,
  baselineTreeOid: string | null,
  targetTreeOid: string,
): SparseCheckoutCandidate[] | null {
  const candidates: SparseCheckoutCandidate[] = [];
  for (const entry of repo.store.walkTreeDiff(baselineTreeOid, targetTreeOid)) {
    if (entry.beforeMode === "160000" || entry.afterMode === "160000") {
      return null;
    }
    if (candidates.length === SPARSE_CHECKOUT_PATHS) {
      return null;
    }
    candidates.push({
      path: entry.path,
      before:
        entry.beforeMode === null || entry.beforeOid === null
          ? undefined
          : { path: entry.path, mode: entry.beforeMode, oid: entry.beforeOid },
      after:
        entry.afterMode === null || entry.afterOid === null
          ? undefined
          : { path: entry.path, mode: entry.afterMode, oid: entry.afterOid },
    });
  }
  return candidates;
}
