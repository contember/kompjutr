import { GitError, hasErrorCode, PathspecNotFoundError } from "../../common/errors.js";
import { isPathRoot } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import {
  hasSparseSourceReceipt,
  selectSparsePathsOwned,
  sparseIndexAncestorFactsOwned,
} from "../../store/sparse/sparse-workspace.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import type {
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSpec,
  SelectedWorktreeFact,
  SparseIndexAncestorResult,
} from "../worktree/sparse-workspace.js";
import {
  type CompiledPathspecMatcher,
  compilePathspecsOwned,
  type WorktreePath,
} from "../worktree/worktree-io.js";
import { ADD_RETAINED_BYTES } from "./staging-rm.js";
import { mergeSelectedAddResults } from "./staging-selected-merge.js";
import { lowerBoundSelectedPath } from "./staging-selected-shared.js";
import {
  type AvailableSelectedPaths,
  type ValidatedSelectedAncestorResult,
  validateSelectedAddResult,
  validateSelectedAncestorResult,
} from "./staging-selected-validation.js";

const ADD_SELECTED_RETAINED_BYTES = 8 * 1024 * 1024;
const ADD_SELECTED_PATHS = 1_000;
const ADD_SELECTED_ROWS = 32_768;

export function selectAddPaths(
  repo: Repository,
  specs: readonly string[],
  pathspec: CompiledPathspecMatcher,
  context: Pick<GitContext, "selectedPaths" | "sparseWorkspace"> | undefined,
): AvailableSelectedPaths | null {
  return selectAddPathsOwned(repo, specs, pathspec, context);
}

function selectAddPathsOwned(
  repo: Repository,
  specs: readonly string[],
  pathspec: CompiledPathspecMatcher,
  context: Pick<GitContext, "selectedPaths" | "sparseWorkspace"> | undefined,
): AvailableSelectedPaths | null {
  const source = context?.selectedPaths;
  if (source === undefined || specs.length > ADD_SELECTED_PATHS || specs.includes("")) return null;
  const requested: SelectedPathSpec[] = specs
    .map((path) => ({ path, recursive: false }))
    .sort((left, right) => comparePaths(left.path, right.path));
  const ancestorSource = context?.sparseWorkspace?.indexAncestorFacts;
  if (ancestorSource === undefined) {
    return selectRecursiveAddPaths(repo, requested, pathspec, source);
  }

  const exactRequest: SelectedPathRequest = {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    specs: requested,
  };
  const exact = selectAddSource(
    repo,
    source,
    exactRequest,
    (path) => hasExactRequestedPath(requested, path),
    requested.length * 4,
    requested.length,
    ADD_SELECTED_RETAINED_BYTES,
  );
  if (exact === null) return null;

  const sparseWorkspace = context?.sparseWorkspace;
  if (sparseWorkspace === undefined) return null;
  const recursive = recursiveAddSpecs(repo, requested, exact, sparseWorkspace);
  if (recursive === null) return null;
  if (recursive.length === 0) {
    return exact;
  }

  const recursiveRequest: SelectedPathRequest = {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    specs: recursive.map((path) => ({ path, recursive: true })),
  };
  const recursiveMatcher = compilePathspecsOwned(recursive);
  const selected = selectAddSource(
    repo,
    source,
    recursiveRequest,
    (path) => recursiveMatcher.matches(path),
    ADD_SELECTED_ROWS,
    ADD_SELECTED_ROWS,
    Math.min(ADD_SELECTED_RETAINED_BYTES, ADD_RETAINED_BYTES - exact.structuralBytes),
  );
  if (selected === null) return null;
  return mergeSelectedAddResults(exact, selected);
}

function selectRecursiveAddPaths(
  repo: Repository,
  requested: readonly SelectedPathSpec[],
  pathspec: CompiledPathspecMatcher,
  source: NonNullable<GitContext["selectedPaths"]>,
): AvailableSelectedPaths | null {
  const request: SelectedPathRequest = {
    repoId: repo.store.repoId,
    checkoutId: repo.checkout.checkoutId,
    root: repo.root,
    specs: requested.map((spec) => ({ path: spec.path, recursive: true })),
  };
  return selectAddSource(
    repo,
    source,
    request,
    (path) => pathspec.matches(path),
    ADD_SELECTED_ROWS,
    ADD_SELECTED_ROWS,
    ADD_SELECTED_RETAINED_BYTES,
  );
}

function selectAddSource(
  repo: Repository,
  source: NonNullable<GitContext["selectedPaths"]>,
  request: SelectedPathRequest,
  matches: (path: string) => boolean,
  maxIndexRows: number,
  maxWorktreeRows: number,
  maxStructuralBytes: number,
): AvailableSelectedPaths | null {
  const selected = selectSparsePathsOwned(source, request);
  if (hasSparseSourceReceipt(repo.checkout.db, "selected-paths", source)) {
    if (!selected.available) return null;
    return { ...selected, structuralBytes: 0, trusted: true };
  }
  try {
    const validated = validateSelectedAddResult(
      selected,
      matches,
      maxIndexRows,
      maxWorktreeRows,
      maxStructuralBytes,
    );
    return validated;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

function recursiveAddSpecs(
  repo: Repository,
  requested: readonly SelectedPathSpec[],
  exact: AvailableSelectedPaths,
  sparseWorkspace: NonNullable<GitContext["sparseWorkspace"]>,
): string[] | null {
  const recursive = new Set<string>();
  for (const row of exact.worktree) {
    if (row.stat.type === "dir") recursive.add(row.path);
  }
  const candidates = requested.flatMap((spec) => (recursive.has(spec.path) ? [] : [spec.path]));
  if (candidates.length === 0) return [...recursive].sort(comparePaths);

  const retainedHeadroom = Math.min(
    ADD_SELECTED_RETAINED_BYTES,
    ADD_RETAINED_BYTES - exact.structuralBytes,
  );
  let result: SparseIndexAncestorResult;
  try {
    result = sparseIndexAncestorFactsOwned(sparseWorkspace, {
      checkoutId: repo.checkout.checkoutId,
      ancestors: candidates,
    });
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  let validated: ValidatedSelectedAncestorResult | null;
  if (hasSparseSourceReceipt(repo.checkout.db, "workspace", sparseWorkspace)) {
    validated = { facts: result.facts, structuralBytes: 0 };
  } else {
    try {
      validated = validateSelectedAncestorResult(result, candidates, exact.index, retainedHeadroom);
    } catch (error) {
      if (hasErrorCode(error, "E2BIG")) return null;
      throw error;
    }
    if (validated === null) return null;
  }
  const facts = validated.facts;
  for (let ordinal = 0; ordinal < candidates.length; ordinal++) {
    const path = candidates[ordinal];
    const fact = facts[ordinal];
    if (path === undefined || fact === undefined) {
      throw new GitError("ECORRUPT", "selected add ancestor source lost a validated fact");
    }
    if (fact.descendant) recursive.add(path);
  }
  const recursivePaths = [...recursive].sort(comparePaths);
  return recursivePaths;
}

function hasExactRequestedPath(requested: readonly SelectedPathSpec[], path: string): boolean {
  const at = lowerBoundSelectedPath(requested, path);
  return requested[at]?.path === path;
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
