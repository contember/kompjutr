import { CorruptError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type { SparseWorkspaceRow, SparseWorkspaceSource } from "../../store/core/contracts.js";
import type { Repository } from "../repository/repository.js";

/** One hydration window; a larger candidate set falls back to the full walk. */
const SPARSE_CANDIDATE_PATHS = 1_000;

/**
 * Paths a complete index tracker cannot vouch for: its dirty rows plus the
 * baseline-to-HEAD diff. Every other path has HEAD, index and worktree equal.
 * Null when more than one window of distinct paths passes `include`.
 */
export function sparseCandidatePaths(
  repo: Repository,
  dirty: Iterable<{ path: string }>,
  baselineTreeOid: string | null,
  currentTreeOid: string | null,
  include: (path: string) => boolean = () => true,
): string[] | null {
  const paths = new Set<string>();
  const add = (path: string): boolean => {
    if (!include(path) || paths.has(path)) return true;
    if (paths.size === SPARSE_CANDIDATE_PATHS) return false;
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

/** Hydrate sorted candidates; the rows come back one per path, in order. */
export function hydrateSparseCandidates(
  repo: Repository,
  source: SparseWorkspaceSource,
  baselineTreeOid: string | null,
  currentTreeOid: string | null,
  paths: string[],
): SparseWorkspaceRow[] | null {
  const hydrated = source.hydrate({
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    baselineTreeOid,
    currentTreeOid,
    paths,
  });
  if (!hydrated.available) return null;
  if (hydrated.rows.length !== paths.length) {
    throw new CorruptError("sparse hydration returned the wrong row count");
  }
  for (let ordinal = 0; ordinal < paths.length; ordinal++) {
    if (hydrated.rows[ordinal]?.path !== paths[ordinal]) {
      throw new CorruptError("sparse hydration returned unordered rows");
    }
  }
  return hydrated.rows;
}
