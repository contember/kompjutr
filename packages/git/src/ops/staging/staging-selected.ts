import { GitError, hasErrorCode, PathspecNotFoundError } from "../../common/errors.js";
import { isPathRoot } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSpec,
  SelectedWorktreeFact,
  SparseIndexAncestorResult,
  SparseWorkspaceSource,
} from "../../store/core/contracts.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import type { CompiledPathspecMatcher, WorktreePath } from "../worktree/worktree-io.js";
import { mergeSelectedAddResults } from "./staging-selected-merge.js";
import { type AvailableSelectedPaths, lowerBoundSelectedPath } from "./staging-selected-shared.js";

const ADD_SELECTED_PATHS = 1_000;

type SelectedPathSource = NonNullable<GitContext["selectedPaths"]>;
type IndexAncestorFacts = NonNullable<SparseWorkspaceSource["indexAncestorFacts"]>;

export function selectAddPaths(
  repo: Repository,
  specs: readonly string[],
  context: Pick<GitContext, "selectedPaths" | "sparseWorkspace"> | undefined,
): AvailableSelectedPaths | null {
  const source = context?.selectedPaths;
  if (source === undefined || specs.length > ADD_SELECTED_PATHS || specs.includes("")) return null;
  const requested: SelectedPathSpec[] = specs
    .map((path) => ({ path, recursive: false }))
    .sort((left, right) => comparePaths(left.path, right.path));
  const ancestorFacts = context?.sparseWorkspace?.indexAncestorFacts;
  if (ancestorFacts === undefined) {
    return selectAddSource(
      source,
      selectedPathRequest(
        repo,
        requested.map((spec) => ({ path: spec.path, recursive: true })),
      ),
    );
  }

  const exact = selectAddSource(source, selectedPathRequest(repo, requested));
  if (exact === null) return null;
  const recursive = recursiveAddSpecs(repo, requested, exact, ancestorFacts);
  if (recursive === null) return null;
  if (recursive.length === 0) return exact;

  const selected = selectAddSource(
    source,
    selectedPathRequest(
      repo,
      recursive.map((path) => ({ path, recursive: true })),
    ),
  );
  if (selected === null) return null;
  return mergeSelectedAddResults(exact, selected);
}

function selectedPathRequest(repo: Repository, specs: SelectedPathSpec[]): SelectedPathRequest {
  return {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    specs,
  };
}

function selectAddSource(
  source: SelectedPathSource,
  request: SelectedPathRequest,
): AvailableSelectedPaths | null {
  try {
    const selected = source.select(request);
    return selected.available ? selected : null;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

function recursiveAddSpecs(
  repo: Repository,
  requested: readonly SelectedPathSpec[],
  exact: AvailableSelectedPaths,
  ancestorFacts: IndexAncestorFacts,
): string[] | null {
  const recursive = new Set<string>();
  for (const row of exact.worktree) {
    if (row.stat.type === "dir") recursive.add(row.path);
  }
  const candidates = requested.flatMap((spec) => (recursive.has(spec.path) ? [] : [spec.path]));
  if (candidates.length === 0) return [...recursive].sort(comparePaths);

  let result: SparseIndexAncestorResult;
  try {
    result = ancestorFacts({ checkoutId: repo.checkout.checkoutId, ancestors: candidates });
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  for (let ordinal = 0; ordinal < candidates.length; ordinal++) {
    const path = candidates[ordinal];
    const fact = result.facts[ordinal];
    if (path === undefined || fact === undefined) {
      throw new GitError("ECORRUPT", "selected add ancestor source lost a fact");
    }
    if (fact.descendant) recursive.add(path);
  }
  return [...recursive].sort(comparePaths);
}

export function* selectedWorktreeFiles(
  rows: readonly SelectedWorktreeFact[],
  pathspec: CompiledPathspecMatcher,
): Generator<WorktreePath> {
  for (const row of rows) {
    if (row.stat.type !== "dir" && pathspec.matches(row.path)) yield row;
  }
}

export function assertSelectedPathspecsMatch(
  specs: readonly string[],
  selected: Extract<SelectedPathResult, { available: true }>,
): void {
  for (const spec of specs) {
    if (hasExactSelectedPath(selected.worktree, spec)) continue;
    const at = lowerBoundSelectedPath(selected.index, spec);
    const path = selected.index[at]?.path;
    if (path !== undefined && isPathRoot(spec, path)) continue;
    throw new PathspecNotFoundError(spec);
  }
}

function hasExactSelectedPath(rows: readonly SelectedWorktreeFact[], path: string): boolean {
  return rows[lowerBoundSelectedPath(rows, path)]?.path === path;
}
