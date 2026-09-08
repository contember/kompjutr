import { MAX_ROUTING_CHECKOUTS } from "@kompjutr/sqlite";
import { GitError } from "../../common/errors.js";
import {
  comparePaths,
  isCanonicalAbsolutePath,
  isNestedPath,
  isPathRoot,
} from "../../common/paths.js";
import {
  array,
  bool,
  number as numeric,
  OptionsSchema,
  object,
  optional,
  text,
} from "../../common/rows.js";
import { joinSorted } from "../../common/streams.js";
import { loadIgnoreMatcher } from "../../ignore/index.js";
import { indexScanOwned } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import {
  compileReadPathspec,
  LS_FILES_INDEX_PAGE,
  type LsFilesOptions,
} from "../worktree/pathspec.js";
import type { Worktree } from "../worktree/worktree.js";
import { type WorktreePath, walkWorktreeEntriesStreamOwned } from "../worktree/worktree-io.js";

export const MAX_LS_FILES_EXCLUDE_ROOTS = MAX_ROUTING_CHECKOUTS;

export interface LsFilesWorktreeOptions extends LsFilesOptions {
  /** Include unique index paths. Defaults to true unless `others` is explicit. */
  cached?: boolean;
  /** Include files and symlinks absent from every index stage. */
  others?: boolean;
  /** Apply the repository `.gitignore` hierarchy to `others`. */
  excludeStandard?: boolean;
  /** Absolute roots of other repositories that the caller resolved before the operation. */
  excludeRoots?: readonly string[];
}

interface LsFilesSelection {
  cached: boolean;
  others: boolean;
  excludeStandard: boolean;
}

const LS_FILES_WORKTREE_OPTIONS = new OptionsSchema(
  {
    paths: optional(
      array(text("ls-files paths must be strings"), "ls-files paths must be an array"),
    ),
    limits: optional(
      object(
        {
          maxWildcardTokens: optional(numeric("ls-files limits must be numbers")),
          maxMatcherWork: optional(numeric("ls-files limits must be numbers")),
        },
        "ls-files limits must be an object",
      ),
    ),
    cached: optional(bool("ls-files cached must be a boolean")),
    others: optional(bool("ls-files others must be a boolean")),
    excludeStandard: optional(bool("ls-files excludeStandard must be a boolean")),
    excludeRoots: optional(
      array(
        text("ls-files exclude roots must be strings"),
        "ls-files excludeRoots must be an array",
      ),
    ),
  },
  "ls-files options must be an object",
);

/** Unique cached paths. Literal selectors stay on indexed prefix scans. */
export function lsFiles(repo: Repository, options: LsFilesOptions = {}): string[] {
  const pathspec = compileReadPathspec(options);
  return pathspec.collect(indexPaths(repo, pathspec.scanPrefixes));
}

/** A bounded cached/untracked worktree selection. */
export function lsFilesWithWorktree(
  repo: Repository,
  worktree: Worktree,
  options: LsFilesWorktreeOptions = {},
): string[] {
  const decodedOptions = LS_FILES_WORKTREE_OPTIONS.decode(options);
  const others = decodedOptions.others === true;
  const selection: LsFilesSelection = {
    cached: decodedOptions.cached ?? !others,
    others,
    excludeStandard: decodedOptions.excludeStandard === true,
  };
  if (selection.excludeStandard && !selection.others) {
    throw new GitError("EINVAL", "ls-files excludeStandard requires others");
  }
  const pathspecOptions: LsFilesOptions = {
    paths: decodedOptions.paths,
    limits: decodedOptions.limits,
  };
  if (!selection.others) {
    const pathspec = compileReadPathspec(pathspecOptions);
    return selection.cached
      ? pathspec.collect(indexPaths(repo, pathspec.scanPrefixes))
      : pathspec.collect([]);
  }
  const excludeRoots = lsFilesExcludeRoots(repo.root, decodedOptions.excludeRoots);
  const pathspec = compileReadPathspec(pathspecOptions);
  const ignores = selection.excludeStandard
    ? loadIgnoreMatcher(worktree, repo.root, { excludeRoots })
    : undefined;
  const index = uniqueIndexPaths(repo, null);
  const walked = walkWorktreeEntriesStreamOwned(worktree, repo.root, {
    excludeRoots,
    ignores,
  });
  return pathspec.collect(selectedLsFilesPaths(index, walked, selection.cached));
}

function lsFilesExcludeRoots(root: string, paths: readonly string[] | undefined): string[] {
  if (paths === undefined) return [];
  const roots: string[] = [];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path === undefined) {
      throw new GitError("EINVAL", "ls-files exclude roots must be strings");
    }
    if (!isCanonicalAbsolutePath(path) || !isNestedPath(root, path)) {
      throw new GitError("EINVAL", "ls-files exclude roots must be canonical nested paths");
    }
    roots.push(path);
  }
  roots.sort(comparePaths);
  const coalesced: string[] = [];
  for (const path of roots) {
    const parent = coalesced[coalesced.length - 1];
    if (parent !== undefined && isPathRoot(parent, path)) continue;
    if (coalesced.length >= MAX_LS_FILES_EXCLUDE_ROOTS) {
      throw new GitError("E2BIG", `ls-files exclude roots exceeds ${MAX_LS_FILES_EXCLUDE_ROOTS}`);
    }
    coalesced.push(path);
  }
  return coalesced;
}

function* uniqueIndexPaths(
  repo: Repository,
  prefixes: readonly string[] | null,
): Generator<string> {
  let previous: string | undefined;
  for (const path of indexPaths(repo, prefixes)) {
    if (path === previous) continue;
    previous = path;
    yield path;
  }
}

function* selectedLsFilesPaths(
  index: Iterable<string>,
  worktree: Iterable<WorktreePath>,
  cached: boolean,
): Generator<string> {
  for (const row of joinSorted(index, worktree, {
    left: (path) => path,
    right: (entry) => entry.path,
  })) {
    if (row.left !== undefined) {
      if (cached) yield row.path;
    } else if (row.right !== undefined) {
      yield row.path;
    }
  }
}

function* indexPaths(repo: Repository, prefixes: readonly string[] | null): Generator<string> {
  if (prefixes === null) {
    for (const entry of indexScanOwned(repo.checkout, {
      pageSize: LS_FILES_INDEX_PAGE,
    })) {
      yield entry.path;
    }
    return;
  }
  for (const prefix of prefixes) {
    for (const entry of indexScanOwned(repo.checkout, {
      prefix,
      pageSize: LS_FILES_INDEX_PAGE,
    })) {
      yield entry.path;
    }
  }
}
