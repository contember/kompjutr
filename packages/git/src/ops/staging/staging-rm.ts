import { utf8 } from "../../common/bytes.js";
import { GitError, PathspecNotFoundError } from "../../common/errors.js";
import { isExcluded, relativeExcludeRoots } from "../../common/paths.js";
import { joinSorted3 } from "../../common/streams.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import { type IndexEntry, type IndexSink, indexScanOwned } from "../../store/index.js";
import { MAX_INDEX_PATH_BYTES } from "../../store/schema/schema.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  type CompiledPathspecMatcher,
  compilePathspecs,
  hasGlobSyntax,
  walkWorktreeEntriesStream,
} from "../worktree/worktree-io.js";
import {
  absoluteRmPaths,
  boundedRmRows,
  identifyRmWorktree,
  newRmPrunePlan,
  noteRmPruneAncestors,
  prunedRmDirectories,
  RM_WINDOW_ROWS,
  type RmCandidate,
  type RmPrunePlan,
  removeRmWorktreePaths,
  requireRmPruneBounded,
  rmWorktreeRemovals,
} from "./staging-rm-worktree.js";

const RM_MAX_PATHSPECS = 10_000;

export interface RmOptions {
  /** Repo-relative pathspecs. Empty is a no-op. */
  paths: string[];
  /** Remove only index rows and leave working-tree bytes in place. */
  cached?: boolean;
  /** Bypass content safety, but never bounds or pathspec matching. */
  force?: boolean;
  /** Permit a pathspec to select descendants of a directory. */
  recursive?: boolean;
  /** Roots of nested repositories that this operation must not cross. */
  excludeRoots?: string[];
}

interface RmIndexPath {
  path: string;
  entry: IndexEntry | undefined;
  conflicted: boolean;
}

interface RmSpec {
  path: string;
  matcher?: CompiledPathspecMatcher;
  directoryOnly: boolean;
  matched: boolean;
  directoryMatch: boolean;
  worktreeDirectory: boolean;
}

interface RmSpecIndex {
  files: Map<string, RmSpec>;
  directories: Map<string, RmSpec>;
  globs: RmSpec[];
}

/** Remove tracked paths with Git's HEAD/index/worktree safety checks. */
export function rm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  const normalized = normalizeRmSpecs(options.paths);
  const specs = normalized.specs;
  if (specs.length === 0) return;

  const cached = options.cached === true;
  const force = options.force === true;
  const recursive = options.recursive === true;
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  const scan = scanRmSelection(repo, worktree, normalized.index, excluded, options.excludeRoots, {
    cached,
    force,
  });

  // Git resolves structural and unmatched errors in caller pathspec order.
  for (const spec of specs) {
    if (spec.worktreeDirectory) {
      throw new GitError(
        "EISDIR",
        `tracked file '${displayRmSpec(spec)}' is a directory in the working tree`,
      );
    }
    if (!spec.matched) throw new PathspecNotFoundError(displayRmSpec(spec));
    if (!recursive && spec.directoryMatch) throw rmDirectoryError(spec);
  }
  if (scan.unsafe !== undefined) throw scan.unsafe;
  requireRmPruneBounded(scan.prune);

  if (!cached) requireSharedMutationScope(repo.store.db, worktree);

  repo.store.db.transactionSync(() => {
    applyIndexOwned(repo.checkout, (sink) => {
      const selected = rmRemovalPaths(repo, normalized.index, excluded, scan.retained);
      if (cached) {
        for (const path of selected) sink.remove(path);
        return;
      }
      removeRmWorktreePaths(
        worktree,
        rmWorktreeRemovals(
          repo,
          worktree,
          removedFromIndex(sink, selected),
          scan.prune,
          options.excludeRoots,
        ),
        false,
      );
      removeRmWorktreePaths(worktree, absoluteRmPaths(repo, prunedRmDirectories(scan.prune)), true);
    });
  });
}

interface RmSelectionScan {
  unsafe: GitError | undefined;
  prune: RmPrunePlan;
  /** Every selected path when they fit one window; otherwise removal rescans the index. */
  retained: string[] | undefined;
}

/**
 * One HEAD/index/worktree pass records pathspec matches, the first unsafe
 * removal, and prune candidates. Errors are deferred because Git reports
 * pathspec errors before safety errors.
 */
function scanRmSelection(
  repo: Repository,
  worktree: Worktree,
  specs: RmSpecIndex,
  excluded: readonly string[],
  excludeRoots: readonly string[] | undefined,
  mode: { cached: boolean; force: boolean },
): RmSelectionScan {
  const prune = newRmPrunePlan();
  let retained: string[] | undefined = [];
  const batch: RmCandidate[] = [];
  let unsafe: GitError | undefined;
  const flush = (): void => {
    identifyRmWorktree(repo, worktree, batch);
    for (const candidate of batch) unsafe ??= rmCandidateUnsafe(candidate, mode.cached);
    batch.length = 0;
  };

  for (const row of rmRows(repo, worktree, specs, excluded, excludeRoots)) {
    const selected = row.b;
    if (selected === undefined) continue;
    noteRmMatches(specs, selected.path, row.c?.stat.type === "dir");
    if (!mode.cached) noteRmPruneAncestors(prune, selected.path);
    if (retained !== undefined) {
      if (retained.length === RM_WINDOW_ROWS) retained = undefined;
      else retained.push(selected.path);
    }
    if (mode.force) continue;
    batch.push({
      path: selected.path,
      head: row.a,
      index: selected.entry,
      worktree: row.c,
      conflicted: selected.conflicted,
      worktreeMatchesIndex: false,
    });
    if (batch.length === RM_WINDOW_ROWS) flush();
  }
  if (batch.length > 0) flush();
  return { unsafe, prune, retained };
}

function rmCandidateUnsafe(candidate: RmCandidate, cached: boolean): GitError | undefined {
  if (candidate.conflicted) return undefined;
  const entry = candidate.index;
  if (entry === undefined) {
    return new GitError("EUNSAFEREMOVE", `cannot prove index state for '${candidate.path}'`);
  }
  const headMatches =
    candidate.head !== undefined &&
    candidate.head.oid === entry.oid &&
    Number.parseInt(candidate.head.mode, 8) === entry.mode;
  const missingWorktree = candidate.worktree === undefined;
  const safe = cached
    ? headMatches || candidate.worktreeMatchesIndex
    : missingWorktree || (headMatches && candidate.worktreeMatchesIndex);
  if (safe) return undefined;
  return new GitError(
    "EUNSAFEREMOVE",
    `path '${candidate.path}' has staged or working-tree changes`,
  );
}

function* removedFromIndex(sink: IndexSink, paths: Iterable<string>): Generator<string> {
  for (const path of paths) {
    sink.remove(path);
    yield path;
  }
}

function* rmRemovalPaths(
  repo: Repository,
  specs: RmSpecIndex,
  excluded: readonly string[],
  retained: readonly string[] | undefined,
): Generator<string> {
  if (retained !== undefined) {
    yield* retained;
    return;
  }
  for (const page of rmSelectedPages(repo, specs, excluded)) yield* page;
}

function* rmRows(
  repo: Repository,
  worktree: Worktree,
  specs: RmSpecIndex,
  excluded: readonly string[],
  excludeRoots: readonly string[] | undefined,
) {
  yield* joinSorted3(
    boundedRmRows(treeStream(repo, repo.headTree()), "HEAD"),
    rmIndexPaths(repo, specs, excluded),
    boundedRmRows(
      walkWorktreeEntriesStream(worktree, repo.root, {
        excludeRoots: excludeRoots === undefined ? undefined : [...excludeRoots],
        includeIgnored: true,
        includeDirectories: true,
      }),
      "worktree",
    ),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  );
}

function* rmSelectedPages(
  repo: Repository,
  specs: RmSpecIndex,
  excluded: readonly string[],
): Generator<string[]> {
  let after: { path: string; stage: number } | undefined;
  let previousPath: string | undefined;
  for (;;) {
    const page: IndexEntry[] = [];
    for (const entry of indexScanOwned(repo.checkout, { after, pageSize: 1_000 })) {
      page.push(entry);
      if (page.length === 1_000) break;
    }
    if (page.length === 0) return;
    const last = page[page.length - 1];
    if (last === undefined) return;
    after = { path: last.path, stage: last.stage };
    const selected: string[] = [];
    for (const entry of page) {
      if (entry.path === previousPath) continue;
      previousPath = entry.path;
      if (matchesRmSpecs(specs, entry.path) && !isExcluded(entry.path, excluded)) {
        selected.push(entry.path);
      }
    }
    if (selected.length > 0) yield selected;
    if (page.length < 1_000) return;
  }
}

function* rmIndexPaths(
  repo: Repository,
  specs: RmSpecIndex,
  excluded: readonly string[],
): Generator<RmIndexPath> {
  let current: RmIndexPath | null = null;
  for (const entry of boundedRmRows(indexScanOwned(repo.checkout), "index")) {
    if (!matchesRmSpecs(specs, entry.path) || isExcluded(entry.path, excluded)) continue;
    if (current === null || current.path !== entry.path) {
      if (current !== null) yield current;
      current = {
        path: entry.path,
        entry: entry.stage === 0 ? entry : undefined,
        conflicted: entry.stage !== 0,
      };
      continue;
    }
    if (entry.stage === 0) current.entry = entry;
    else current.conflicted = true;
  }
  if (current !== null) yield current;
}

function normalizeRmSpecs(paths: readonly string[]): {
  specs: RmSpec[];
  index: RmSpecIndex;
} {
  if (paths.length > RM_MAX_PATHSPECS) {
    throw new GitError("E2BIG", `rm pathspec count exceeds ${RM_MAX_PATHSPECS}`);
  }
  const specs: RmSpec[] = [];
  const files = new Map<string, RmSpec>();
  const directories = new Map<string, RmSpec>();
  const globs: RmSpec[] = [];
  for (const raw of paths) {
    let path: string;
    let directoryOnly: boolean;
    path = raw;
    while (path.startsWith("./")) path = path.slice(2);
    directoryOnly = path === "." || path.endsWith("/");
    while (path.endsWith("/")) path = path.slice(0, -1);
    if (path === ".") {
      path = "";
      directoryOnly = true;
    }
    if (path.length > MAX_INDEX_PATH_BYTES || utf8.encode(path).length > MAX_INDEX_PATH_BYTES) {
      throw new GitError("E2BIG", `rm pathspec exceeds ${MAX_INDEX_PATH_BYTES} UTF-8 bytes`);
    }
    if (hasGlobSyntax(path)) {
      if (globs.some((spec) => spec.path === path)) continue;
      const spec: RmSpec = {
        path,
        matcher: compilePathspecs([path]),
        directoryOnly: false,
        matched: false,
        directoryMatch: false,
        worktreeDirectory: false,
      };
      globs.push(spec);
      specs.push(spec);
      continue;
    }
    const seen = directoryOnly ? directories : files;
    if (seen.has(path)) continue;
    const spec: RmSpec = {
      path,
      directoryOnly,
      matched: false,
      directoryMatch: false,
      worktreeDirectory: false,
    };
    seen.set(path, spec);
    specs.push(spec);
  }
  return {
    specs,
    index: { files, directories, globs },
  };
}

function matchesRmSpecs(specs: RmSpecIndex, path: string): boolean {
  return visitMatchingRmSpecs(specs, path, () => {});
}

function noteRmMatches(specs: RmSpecIndex, path: string, worktreeDirectory: boolean): void {
  visitMatchingRmSpecs(specs, path, (spec) => {
    spec.matched = true;
    if (spec.matcher === undefined && (spec.directoryOnly || path !== spec.path)) {
      spec.directoryMatch = true;
    }
    if (
      !spec.directoryOnly &&
      worktreeDirectory &&
      (spec.matcher !== undefined || path === spec.path)
    ) {
      spec.worktreeDirectory = true;
    }
  });
}

function visitMatchingRmSpecs(
  specs: RmSpecIndex,
  path: string,
  visit: (spec: RmSpec) => void,
): boolean {
  let matched = false;
  const found = (spec: RmSpec | undefined): void => {
    if (spec === undefined) return;
    matched = true;
    visit(spec);
  };
  found(specs.files.get(""));
  found(specs.directories.get(""));
  found(specs.files.get(path));
  for (const spec of specs.globs) {
    if (spec.matcher?.matches(path)) found(spec);
  }
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    found(specs.files.get(prefix));
    found(specs.directories.get(prefix));
  }
  return matched;
}

function displayRmSpec(spec: RmSpec): string {
  if (spec.path === "") return ".";
  return spec.directoryOnly ? `${spec.path}/` : spec.path;
}

function rmDirectoryError(spec: RmSpec): GitError {
  return new GitError(
    "EISDIR",
    `not removing '${displayRmSpec(spec)}' recursively without recursive`,
  );
}
