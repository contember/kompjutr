import { GitError, PathspecNotFoundError } from "../../common/errors.js";
import { comparePaths, joinPath } from "../../common/paths.js";
import { joinSorted3 } from "../../common/streams.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../../ignore/index.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import { type IndexEntry, type IndexStore, indexScanOwned } from "../../store/index.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  type CompiledPathspecMatcher,
  compilePathspecsOwned,
  createWorktreeHashCursor,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStreamOwned,
} from "../worktree/worktree-io.js";
import {
  type AddIndexSnapshot,
  type AddOperationLimits,
  addIndexSource,
  boundedAddHeadRows,
  boundedAddWorktreeRows,
  retainStageCandidate,
  type StageCandidateBatch,
  stageCandidates,
} from "./staging-add-stage.js";
import { isExcluded, relativeExcludeRoots } from "./staging-rm.js";
import {
  assertSelectedPathspecsMatch,
  selectAddPaths,
  selectedWorktreeFiles,
} from "./staging-selected.js";

const ADD_WINDOW_ROWS = 1000;
const ADD_MAX_ROWS_PER_STREAM = 50_000;

export interface AddOptions {
  /** Repo-relative pathspecs. Empty is a no-op, like `git add` with no arguments. */
  paths: string[];
  /** Stage every change under the repository, ignoring `paths`. */
  all?: boolean;
  /** Restrict `all` to paths already in HEAD — the `commit -a` semantics. */
  trackedOnly?: boolean;
  /** Stage a path even when `.gitignore` matches it. */
  force?: boolean;
  /**
   * Roots of nested repositories, from `nestedRoots(context, repo.root)`.
   * The caller resolves these before entering the staging operation.
   */
  excludeRoots?: string[];
}

export type AddLiteralPathsResult =
  | { outcome: "staged" }
  | { outcome: "ignored"; paths: readonly string[] };

/**
 * Stage working-tree changes into the index.
 *
 * A pathspec stages removals under it too, the way `git add <dir>` has
 * since git 2.0; `all` does the same across the whole repository.
 */
export function add(
  repo: Repository,
  worktree: Worktree,
  options: AddOptions,
  context?: Pick<GitContext, "selectedPaths" | "sparseWorkspace">,
  index: IndexStore = repo.checkout,
): void {
  repo.store.runScratchAwareOperation(() => {
    runAdd(repo, worktree, options, normalizeAddSpecs(options.paths), context, index);
  });
}

/** Stage already-normalized literal paths without rewriting their bytes. */
export function addLiteralPaths(
  repo: Repository,
  worktree: Worktree,
  options: AddOptions,
  context?: Pick<GitContext, "selectedPaths" | "sparseWorkspace">,
): AddLiteralPathsResult {
  return repo.store.runScratchAwareOperation(() => {
    if (options.all === true) {
      throw new GitError("EINVAL", "literal add requires explicit paths");
    }
    compilePathspecsOwned(options.paths);
    const specs = uniqueSpecs(options.paths);
    const preflight =
      options.force === true
        ? { ignored: [] }
        : preflightLiteralAdd(repo, worktree, specs, options.excludeRoots);
    runAdd(repo, worktree, options, specs, context, repo.checkout, preflight.ignores);
    return preflight.ignored.length === 0
      ? { outcome: "staged" }
      : { outcome: "ignored", paths: preflight.ignored };
  });
}

function runAdd(
  repo: Repository,
  worktree: Worktree,
  options: AddOptions,
  specs: string[],
  context: Pick<GitContext, "selectedPaths" | "sparseWorkspace"> | undefined,
  index: IndexStore,
  preloadedIgnores?: IgnoreMatcher,
): void {
  const all = options.all === true;
  if (!all && specs.length === 0) return;

  const limits: AddOperationLimits = {
    worktreeRows: 0,
    headRows: 0,
  };
  const force = options.force === true;
  const trackedOnly = all && options.trackedOnly === true;
  let pathspec: CompiledPathspecMatcher | undefined;
  pathspec = all ? undefined : compilePathspecsOwned(specs);
  if (!all && pathspec !== undefined) {
    const selected =
      index === repo.checkout ? selectAddPaths(repo, specs, pathspec, context) : null;
    if (selected !== null) {
      assertSelectedPathspecsMatch(specs, selected);
      applyAdd(
        repo,
        worktree,
        options,
        addIndexSource(selected.index, pathspec),
        selectedWorktreeFiles(selected.worktree, pathspec),
        pathspec,
        force,
        false,
        index,
        limits,
        preloadedIgnores,
      );
      return;
    }
    assertPathspecsMatch(repo, worktree, specs, index);
  }

  const snapshot = addIndexSource(indexScanOwned(index), pathspec);
  const walked = walkWorktreeEntriesStreamOwned(worktree, repo.root, {
    pathspec,
    excludeRoots: options.excludeRoots,
    includeIgnored: true,
    maxScanRows: ADD_MAX_ROWS_PER_STREAM,
  });
  applyAdd(
    repo,
    worktree,
    options,
    snapshot,
    walked,
    pathspec,
    force,
    trackedOnly,
    index,
    limits,
    preloadedIgnores,
  );
}

function applyAdd(
  repo: Repository,
  worktree: Worktree,
  options: AddOptions,
  snapshot: AddIndexSnapshot,
  walked: Iterable<WorktreePath>,
  pathspec: CompiledPathspecMatcher | undefined,
  force: boolean,
  trackedOnly: boolean,
  index: IndexStore,
  limits: AddOperationLimits,
  preloadedIgnores?: IgnoreMatcher,
): void {
  let ignores = preloadedIgnores;
  const isIgnored = (path: string): boolean => {
    if (force) return false;
    ignores ??= loadIgnoreMatcher(worktree, repo.root, { excludeRoots: options.excludeRoots });
    return ignores.ignores(path, false);
  };
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  // `commit -a` never adds a path HEAD does not already have.
  const head = trackedOnly ? treeStream(repo, repo.headTree()) : [];
  const pending: StageCandidateBatch = {
    rows: [],
  };
  const hashCursor = createWorktreeHashCursor();
  applyIndexOwned(index, (sink) => {
    const flush = (): void => stageCandidates(repo, worktree, pending, sink, hashCursor);
    for (const row of joinSorted3(
      boundedAddWorktreeRows(walked, limits),
      snapshot.paths,
      boundedAddHeadRows(head, limits),
      {
        a: (entry) => entry.path,
        b: (entry) => entry.path,
        c: (entry) => entry.path,
      },
    )) {
      if (trackedOnly && row.c === undefined) continue;
      const existing = row.b?.entry;

      if (row.a !== undefined) {
        if (row.b === undefined && isExcluded(row.path, excluded)) continue;
        if (row.b === undefined && isIgnored(row.path)) continue;
        const conflicted = row.b?.conflicted ?? false;
        if (!conflicted && existing !== undefined && indexMatchesStat(existing, row.a.stat)) {
          continue;
        }
        retainStageCandidate(pending, {
          path: row.path,
          existing,
          worktree: row.a,
          conflicted,
        });
        if (pending.rows.length >= ADD_WINDOW_ROWS) flush();
        continue;
      }

      // A conflict-only path has no stage-zero row but still needs removal.
      if (row.b === undefined) continue;
      if (pathspec !== undefined && !pathspec.matches(row.path)) continue;
      flush();
      sink.remove(row.path);
    }
    flush();
  });
}

/** Repo-relative pathspecs, without the "./" and trailing-slash noise. */
function normalizeAddSpecs(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let spec: string;
    spec = raw.trim();
    while (spec.startsWith("./")) spec = spec.slice(2);
    spec = spec.replace(/\/+$/, "");
    if (spec === ".") spec = "";
    if (!out.includes(spec)) out.push(spec);
    else continue;
  }
  return out;
}

function uniqueSpecs(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

interface LiteralAddPreflight {
  ignored: string[];
  ignores?: IgnoreMatcher;
}

function preflightLiteralAdd(
  repo: Repository,
  worktree: Worktree,
  specs: readonly string[],
  excludeRoots: readonly string[] | undefined,
): LiteralAddPreflight {
  const excluded = relativeExcludeRoots(repo.root, excludeRoots);
  const ignored: string[] = [];
  let ignores: IgnoreMatcher | undefined;
  for (const spec of specs) {
    if (spec === "" || isExcluded(spec, excluded)) continue;
    const absolute = joinPath(repo.root, spec);
    const stat = worktree.stat(absolute);
    if (stat === null || (stat.type !== "dir" && literalSelectionIsExactTracked(repo, spec))) {
      continue;
    }
    ignores ??= loadIgnoreMatcher(worktree, repo.root, { excludeRoots: [...(excludeRoots ?? [])] });
    if (ignores.ignores(spec, stat.type === "dir")) {
      ignored.push(spec);
    }
  }
  ignored.sort(comparePaths);
  return { ignored, ignores };
}

function literalSelectionIsExactTracked(repo: Repository, spec: string): boolean {
  const entries = indexScanOwned(repo.checkout, { prefix: spec, pageSize: 1 });
  try {
    const exact = entries.next();
    return exact.done !== true && exact.value.path === spec;
  } finally {
    entries.return?.();
  }
}

/**
 * Real git exits 128 with `pathspec '<x>' did not match any files`. A path
 * that exists but is ignored is not that case: `add` skips it silently,
 * which is what isomorphic-git does and therefore what Computer promises.
 *
 * Checked before the walk, and in O(pathspecs): anything the walk would
 * match lives under a directory that exists on disk, and anything tracked
 * shows up in a prefix scan of the index. Neither needs the whole tree.
 */
function assertPathspecsMatch(
  repo: Repository,
  worktree: Worktree,
  specs: string[],
  index: IndexStore,
): void {
  for (const spec of specs) {
    if (spec === "") continue;
    const absolute = joinPath(repo.root, spec);
    const stat = worktree.stat(absolute);
    if (stat !== null) continue;
    const entries = indexScanOwned(index, { prefix: spec, pageSize: 1 });
    let tracked: IteratorResult<IndexEntry>;
    try {
      tracked = entries.next();
    } finally {
      entries.return?.();
    }
    if (tracked.done !== true) continue;
    throw new PathspecNotFoundError(spec);
  }
}
