// Staging: moving working-tree facts into the SQL index.
//
// The index is rows, so staging writes one row per *changed* path instead
// of rewriting a whole `.git/index` blob. The only work proportional to the
// tracked-file count is the single `SELECT` over `git_index` — everything
// after that is bounded by what actually changed.

import { MAX_ROUTING_CHECKOUTS } from "../../db/routing.js";
import { isOid } from "../common/bytes.js";
import { GitError, hasErrorCode, PathspecNotFoundError } from "../common/errors.js";
import {
  comparePaths,
  isCanonicalAbsolutePath,
  isCanonicalGitPath,
  isNestedPath,
  isPathRoot,
  joinPath,
  relativeTo,
} from "../common/paths.js";
import {
  array,
  blob,
  bool,
  int,
  nullable,
  number as numeric,
  OptionsSchema,
  object,
  oneOf,
  optional,
  RowShape,
  text,
  unknownArray,
} from "../common/rows.js";
import { joinSorted, joinSorted3 } from "../common/streams.js";
import { type IgnoreMatcher, loadIgnoreMatcher } from "../ignore/index.js";
import {
  contentIdKey,
  type IndexEntry,
  type IndexSink,
  type IndexStore,
  indexScanOwned,
} from "../store/index.js";
import {
  selectSparsePathsOwned,
  sparseIndexAncestorFactsOwned,
} from "../store/sparse-workspace.js";
import {
  type CompiledPathspecMatcher,
  checkoutTreeExcluding,
  indexFromTree,
  matchesPaths,
} from "./checkout.js";
import type { GitContext } from "./context.js";
import { compileReadPathspec, LS_FILES_INDEX_PAGE, type LsFilesOptions } from "./pathspec.js";
import { operationRefLogMetadata } from "./ref-log.js";
import type { Repository } from "./repository.js";
import type {
  SelectedPathRequest,
  SelectedPathResult,
  SelectedPathSpec,
  SelectedWorktreeFact,
} from "./sparse-workspace.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import { gitModeFor, type Worktree } from "./worktree.js";
import {
  compilePathspecsOwned,
  hashExactWorktreePathsOwned,
  hashWorktreePathsOwned,
  indexEntryFor,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStreamOwned,
} from "./worktree-io.js";

const ADD_WINDOW_ROWS = 1000;
const ADD_RETAINED_BYTES = 16 * 1024 * 1024;
const ADD_MAX_ROWS_PER_STREAM = 50_000;
const ADD_SELECTED_RETAINED_BYTES = 8 * 1024 * 1024;
const ADD_SELECTED_PATHS = 1_000;
const ADD_SELECTED_ROWS = 32_768;
const INDEX_ROW_FIXED_BYTES = 256;
const PATH_ENTRY_FIXED_BYTES = 96;
const SELECTED_RESULT_FIXED_BYTES = 64;
const SELECTED_ARRAY_FIXED_BYTES = 64;
const SELECTED_ARRAY_SLOT_BYTES = 8;
const SELECTED_INDEX_FIXED_BYTES = 320;
const SELECTED_WORKTREE_FIXED_BYTES = 512;
const SELECTED_ANCESTOR_RESULT_FIXED_BYTES = 64;
const SELECTED_ANCESTOR_ARRAY_FIXED_BYTES = 64;
const SELECTED_ANCESTOR_FACT_FIXED_BYTES = 64;
const SELECTED_ANCESTOR_SLOT_BYTES = 8;
const SELECTED_MERGE_FIXED_BYTES = 128;
const SELECTED_MERGE_SLOT_BYTES = 8;
const TYPED_ARRAY_BYTE_LENGTH_GETTER: unknown = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;

function structuralStringBytes(value: string): number {
  return 48 + value.length * 2;
}

export const MAX_LS_FILES_EXCLUDE_ROOTS = MAX_ROUTING_CHECKOUTS;

interface AvailableSelectedPaths extends Extract<SelectedPathResult, { available: true }> {
  structuralBytes: number;
}

interface AddIndexPath {
  path: string;
  entry: IndexEntry | undefined;
}

interface AddIndexSnapshot {
  paths: AddIndexPath[];
  conflicted: Set<string>;
}

interface AddOperationLimits {
  indexRows: number;
  worktreeRows: number;
  headRows: number;
}

interface StageCandidate {
  path: string;
  existing: IndexEntry | undefined;
  worktree: WorktreePath;
  conflicted: boolean;
}

interface StageCandidateBatch {
  rows: StageCandidate[];
}

const MALFORMED_SELECTED_INDEX_ROW = "selected add index source returned a malformed row";
const SELECTED_INDEX_ROW = new RowShape(
  {
    path: text(MALFORMED_SELECTED_INDEX_ROW).where(
      isCanonicalGitPath,
      MALFORMED_SELECTED_INDEX_ROW,
    ),
    stage: int(0, 3, MALFORMED_SELECTED_INDEX_ROW),
    mode: int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW).where(
      (mode) => [0o100644, 0o100755, 0o120000, 0o160000].includes(mode),
      MALFORMED_SELECTED_INDEX_ROW,
    ),
    oid: text(MALFORMED_SELECTED_INDEX_ROW).where(isOid, MALFORMED_SELECTED_INDEX_ROW),
    size: nullable(int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW)),
    mtime: nullable(
      int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW),
    ),
    ino: nullable(int(1, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW)),
    rev: optional(nullable(int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_INDEX_ROW))),
  },
  MALFORMED_SELECTED_INDEX_ROW,
);

const MALFORMED_SELECTED_WORKTREE_ROW = "selected add worktree source returned a malformed row";
const SELECTED_WORKTREE_ROW = new RowShape(
  {
    path: text(MALFORMED_SELECTED_WORKTREE_ROW).where(
      isCanonicalGitPath,
      MALFORMED_SELECTED_WORKTREE_ROW,
    ),
    stat: object(
      {
        type: oneOf(["file", "dir", "symlink"], MALFORMED_SELECTED_WORKTREE_ROW),
        mode: int(0, 0o7777, MALFORMED_SELECTED_WORKTREE_ROW),
        size: int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        mtime: int(
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          MALFORMED_SELECTED_WORKTREE_ROW,
        ),
        ino: int(1, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        nlink: int(1, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        rev: int(0, Number.MAX_SAFE_INTEGER, MALFORMED_SELECTED_WORKTREE_ROW),
        target: nullable(text(MALFORMED_SELECTED_WORKTREE_ROW)),
        contentId: nullable(blob(MALFORMED_SELECTED_WORKTREE_ROW)),
      },
      MALFORMED_SELECTED_WORKTREE_ROW,
    ),
  },
  MALFORMED_SELECTED_WORKTREE_ROW,
);

const MALFORMED_SELECTED_ANCESTOR_FACT = "selected add ancestor source returned malformed facts";
const SELECTED_ANCESTOR_FACT_ROW = new RowShape(
  {
    path: text(MALFORMED_SELECTED_ANCESTOR_FACT).where(
      isCanonicalGitPath,
      MALFORMED_SELECTED_ANCESTOR_FACT,
    ),
    exact: bool(MALFORMED_SELECTED_ANCESTOR_FACT),
    descendant: bool(MALFORMED_SELECTED_ANCESTOR_FACT),
  },
  MALFORMED_SELECTED_ANCESTOR_FACT,
);

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
    indexRows: 0,
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
        snapshotAddIndexRows(selected.index, pathspec, selected.structuralBytes, limits),
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

  const snapshot = snapshotAddIndex(index, pathspec, limits);
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
  index.indexApply((sink) => {
    const flush = (): void => stageCandidates(repo, worktree, pending, sink);
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
        const conflicted = snapshot.conflicted.has(row.path);
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
      sink.remove(row.path);
    }
    flush();
  });
}

function selectAddPaths(
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
    source,
    request,
    (path) => pathspec.matches(path),
    ADD_SELECTED_ROWS,
    ADD_SELECTED_ROWS,
    ADD_SELECTED_RETAINED_BYTES,
  );
}

function selectAddSource(
  source: NonNullable<GitContext["selectedPaths"]>,
  request: SelectedPathRequest,
  matches: (path: string) => boolean,
  maxIndexRows: number,
  maxWorktreeRows: number,
  maxStructuralBytes: number,
): AvailableSelectedPaths | null {
  const selected: unknown = selectSparsePathsOwned(source, request);
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
  let result: unknown;
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
  try {
    validated = validateSelectedAncestorResult(result, candidates, exact.index, retainedHeadroom);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  if (validated === null) {
    return null;
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

interface ValidatedSelectedAncestorFact {
  path: string;
  exact: boolean;
  descendant: boolean;
}

interface ValidatedSelectedAncestorResult {
  facts: ValidatedSelectedAncestorFact[];
  structuralBytes: number;
}

function validateSelectedAncestorResult(
  result: unknown,
  expected: readonly string[],
  exactIndex: readonly IndexEntry[],
  retainedLimit: number,
): ValidatedSelectedAncestorResult | null {
  const decoded = new RowShape(
    {
      facts: unknownArray("selected add ancestor source returned invalid state"),
    },
    "selected add ancestor source returned a malformed result",
  ).decode(result);
  const factsLength = decoded.facts.length;
  if (factsLength !== expected.length) {
    throw new GitError("ECORRUPT", "selected add ancestor source returned invalid state");
  }
  let minimumRetained = SELECTED_ANCESTOR_RESULT_FIXED_BYTES + SELECTED_ANCESTOR_ARRAY_FIXED_BYTES;
  minimumRetained = addSelectedStructuralBytes(
    minimumRetained,
    factsLength * SELECTED_ANCESTOR_SLOT_BYTES,
  );
  if (minimumRetained > retainedLimit) return null;
  const snapshot: ValidatedSelectedAncestorFact[] = [];
  let previous: string | undefined;
  for (let ordinal = 0; ordinal < factsLength; ordinal++) {
    if (!Object.hasOwn(decoded.facts, ordinal)) {
      throw new GitError("ECORRUPT", "selected add ancestor source returned sparse facts");
    }
    const fact = SELECTED_ANCESTOR_FACT_ROW.decode(decoded.facts[ordinal]);
    const expectedPath = expected[ordinal];
    if (
      expectedPath === undefined ||
      fact.path !== expectedPath ||
      fact.exact !== hasExactSelectedIndexPath(exactIndex, fact.path) ||
      (previous !== undefined && comparePaths(previous, fact.path) >= 0)
    ) {
      throw new GitError("ECORRUPT", "selected add ancestor source returned malformed facts");
    }
    minimumRetained = addSelectedStructuralBytes(
      minimumRetained,
      SELECTED_ANCESTOR_FACT_FIXED_BYTES + fact.path.length * 2,
    );
    if (minimumRetained > retainedLimit) return null;
    snapshot.push(fact);
    previous = fact.path;
  }
  return { facts: snapshot, structuralBytes: minimumRetained };
}

function validateSelectedAddResult(
  selected: unknown,
  matches: (path: string) => boolean,
  maxIndexRows: number,
  maxWorktreeRows: number,
  maxStructuralBytes: number,
): AvailableSelectedPaths | null {
  const availability = new RowShape(
    { available: bool("selected add source returned invalid availability") },
    "selected add source returned a malformed result",
  ).decode(selected);
  if (!availability.available) return null;
  const decoded = new RowShape(
    {
      index: unknownArray("selected add source returned invalid state"),
      worktree: unknownArray("selected add source returned invalid state"),
    },
    "selected add source returned a malformed result",
  ).decode(selected);
  const indexLength = decoded.index.length;
  const worktreeLength = decoded.worktree.length;
  if (indexLength > maxIndexRows || worktreeLength > maxWorktreeRows) {
    throw new GitError("ECORRUPT", "selected add source returned excessive facts");
  }
  let minimumRetained = SELECTED_RESULT_FIXED_BYTES + SELECTED_ARRAY_FIXED_BYTES * 2;
  minimumRetained = addSelectedStructuralBytes(
    minimumRetained,
    (indexLength + worktreeLength) * SELECTED_ARRAY_SLOT_BYTES,
  );
  if (minimumRetained > maxStructuralBytes) return null;
  const snapshotIndex: IndexEntry[] = [];
  let previousIndex: IndexEntry | undefined;
  for (let ordinal = 0; ordinal < indexLength; ordinal++) {
    if (!Object.hasOwn(decoded.index, ordinal)) {
      throw new GitError("ECORRUPT", "selected add index source returned sparse rows");
    }
    const entry = SELECTED_INDEX_ROW.decode(decoded.index[ordinal]);
    if (
      !matches(entry.path) ||
      (previousIndex !== undefined &&
        (comparePaths(previousIndex.path, entry.path) > 0 ||
          (previousIndex.path === entry.path && previousIndex.stage >= entry.stage)))
    ) {
      throw new GitError("ECORRUPT", "selected add index source returned an unrelated path");
    }
    minimumRetained = addSelectedStructuralBytes(
      minimumRetained,
      SELECTED_INDEX_FIXED_BYTES +
        structuralStringBytes(entry.path) +
        structuralStringBytes(entry.oid),
    );
    if (minimumRetained > maxStructuralBytes) return null;
    snapshotIndex.push(entry);
    previousIndex = entry;
  }
  const snapshotWorktree: SelectedWorktreeFact[] = [];
  let previousWorktree: SelectedWorktreeFact | undefined;
  for (let ordinal = 0; ordinal < worktreeLength; ordinal++) {
    if (!Object.hasOwn(decoded.worktree, ordinal)) {
      throw new GitError("ECORRUPT", "selected add worktree source returned sparse rows");
    }
    const fields = decodeSelectedWorktreeFields(decoded.worktree[ordinal]);
    if (
      !matches(fields.path) ||
      (previousWorktree !== undefined && comparePaths(previousWorktree.path, fields.path) >= 0)
    ) {
      throw new GitError("ECORRUPT", "selected add worktree source returned an unrelated path");
    }
    minimumRetained = addSelectedStructuralBytes(
      minimumRetained,
      SELECTED_WORKTREE_FIXED_BYTES +
        structuralStringBytes(fields.path) +
        structuralStringBytes(fields.target ?? "") +
        fields.contentBytes,
    );
    if (minimumRetained > maxStructuralBytes) return null;
    const entry = snapshotSelectedWorktreeFact(fields);
    snapshotWorktree.push(entry);
    previousWorktree = entry;
  }
  return {
    available: true,
    index: snapshotIndex,
    worktree: snapshotWorktree,
    structuralBytes: minimumRetained,
  };
}

function addSelectedStructuralBytes(current: number, added: number): number {
  if (!Number.isSafeInteger(added) || added < 0 || current > Number.MAX_SAFE_INTEGER - added) {
    throw new GitError("E2BIG", "selected add state is too large");
  }
  return current + added;
}

function selectedUtf8Bytes(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return null;
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return null;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  return bytes;
}

interface ValidatedSelectedWorktreeFields {
  path: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  mtime: number;
  ino: number;
  nlink: number;
  rev: number;
  target: string | null;
  contentId: Uint8Array | null;
  contentBytes: number;
}

function decodeSelectedWorktreeFields(value: unknown): ValidatedSelectedWorktreeFields {
  const row = SELECTED_WORKTREE_ROW.decode(value);
  const { path, stat } = row;
  const { type, mode, size, mtime, ino, nlink, rev, target, contentId } = stat;
  if (type === "dir" && (size !== 0 || target !== null || contentId !== null)) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  if (type === "file" && target !== null) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  if (
    type === "symlink" &&
    (typeof target !== "string" || selectedUtf8Bytes(target) !== size || contentId !== null)
  ) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  const contentBytes = contentId === null ? 0 : selectedContentIdBytes(contentId);
  if (contentBytes === null) {
    throw new GitError("ECORRUPT", MALFORMED_SELECTED_WORKTREE_ROW);
  }
  return {
    path,
    type,
    mode,
    size,
    mtime,
    ino,
    nlink,
    rev,
    target,
    contentId,
    contentBytes,
  };
}

function selectedContentIdBytes(value: Uint8Array): number | null {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") return null;
  let bytes: unknown;
  try {
    bytes = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  } catch {
    return null;
  }
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function snapshotSelectedWorktreeFact(
  fields: ValidatedSelectedWorktreeFields,
): SelectedWorktreeFact {
  return {
    path: fields.path,
    stat: {
      type: fields.type,
      mode: fields.mode,
      size: fields.size,
      mtime: fields.mtime,
      ino: fields.ino,
      nlink: fields.nlink,
      rev: fields.rev,
      target: fields.target,
      contentId: fields.contentId === null ? null : new Uint8Array(fields.contentId),
    },
  };
}

function hasExactRequestedPath(requested: readonly SelectedPathSpec[], path: string): boolean {
  const at = lowerBoundSelectedPath(requested, path);
  return requested[at]?.path === path;
}

function hasExactSelectedIndexPath(rows: readonly IndexEntry[], path: string): boolean {
  return rows[lowerBoundSelectedPath(rows, path)]?.path === path;
}

function mergeSelectedAddResults(
  exact: AvailableSelectedPaths,
  recursive: AvailableSelectedPaths,
): AvailableSelectedPaths | null {
  const slots =
    exact.index.length + recursive.index.length + exact.worktree.length + recursive.worktree.length;
  const mergeCharge = SELECTED_MERGE_FIXED_BYTES + slots * SELECTED_MERGE_SLOT_BYTES;
  if (
    !Number.isSafeInteger(mergeCharge) ||
    exact.structuralBytes > ADD_RETAINED_BYTES - recursive.structuralBytes ||
    exact.structuralBytes + recursive.structuralBytes > ADD_RETAINED_BYTES - mergeCharge
  ) {
    return null;
  }
  return {
    available: true,
    index: mergeSelectedIndexRows(exact.index, recursive.index),
    worktree: mergeSelectedWorktreeRows(exact.worktree, recursive.worktree),
    structuralBytes: exact.structuralBytes + recursive.structuralBytes + mergeCharge,
  };
}

function mergeSelectedIndexRows(
  left: readonly IndexEntry[],
  right: readonly IndexEntry[],
): IndexEntry[] {
  const rows: IndexEntry[] = [];
  let leftAt = 0;
  let rightAt = 0;
  while (leftAt < left.length || rightAt < right.length) {
    const a = left[leftAt];
    const b = right[rightAt];
    if (a === undefined) {
      if (b !== undefined) rows.push(b);
      rightAt++;
      continue;
    }
    if (b === undefined) {
      rows.push(a);
      leftAt++;
      continue;
    }
    const order = comparePaths(a.path, b.path) || a.stage - b.stage;
    if (order < 0) {
      rows.push(a);
      leftAt++;
    } else if (order > 0) {
      rows.push(b);
      rightAt++;
    } else {
      if (!sameIndexEntry(a, b)) {
        throw new GitError("ECORRUPT", "selected add index sources disagreed on a row");
      }
      rows.push(a);
      leftAt++;
      rightAt++;
    }
  }
  return rows;
}

function sameIndexEntry(left: IndexEntry, right: IndexEntry): boolean {
  return (
    left.path === right.path &&
    left.stage === right.stage &&
    left.mode === right.mode &&
    left.oid === right.oid &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.ino === right.ino &&
    left.rev === right.rev
  );
}

function mergeSelectedWorktreeRows(
  left: readonly SelectedWorktreeFact[],
  right: readonly SelectedWorktreeFact[],
): SelectedWorktreeFact[] {
  const rows: SelectedWorktreeFact[] = [];
  let leftAt = 0;
  let rightAt = 0;
  while (leftAt < left.length || rightAt < right.length) {
    const a = left[leftAt];
    const b = right[rightAt];
    if (a === undefined) {
      if (b !== undefined) rows.push(b);
      rightAt++;
      continue;
    }
    if (b === undefined) {
      rows.push(a);
      leftAt++;
      continue;
    }
    const order = comparePaths(a.path, b.path);
    if (order < 0) {
      rows.push(a);
      leftAt++;
    } else if (order > 0) {
      rows.push(b);
      rightAt++;
    } else {
      if (!sameWorktreeFact(a, b)) {
        throw new GitError("ECORRUPT", "selected add worktree sources disagreed on a row");
      }
      rows.push(a);
      leftAt++;
      rightAt++;
    }
  }
  return rows;
}

function sameWorktreeFact(left: SelectedWorktreeFact, right: SelectedWorktreeFact): boolean {
  const a = left.stat;
  const b = right.stat;
  return (
    left.path === right.path &&
    a.type === b.type &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.rev === b.rev &&
    a.target === b.target &&
    sameBytes(a.contentId, b.contentId)
  );
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function* selectedWorktreeFiles(
  rows: readonly SelectedWorktreeFact[],
  pathspec: CompiledPathspecMatcher,
): Generator<WorktreePath> {
  for (const row of rows) {
    if (row.stat.type !== "dir" && pathspec.matches(row.path)) yield row;
  }
}

function assertSelectedPathspecsMatch(
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

function lowerBoundSelectedPath<T extends { path: string }>(
  rows: readonly T[],
  path: string,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = rows[middle];
    if (candidate !== undefined && comparePaths(candidate.path, path) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function snapshotAddIndex(
  index: IndexStore,
  pathspec: CompiledPathspecMatcher | undefined,
  limits: AddOperationLimits,
): AddIndexSnapshot {
  return snapshotAddIndexRows(indexScanOwned(index), pathspec, 0, limits);
}

function snapshotAddIndexRows(
  entries: Iterable<IndexEntry>,
  pathspec: CompiledPathspecMatcher | undefined,
  initialRetained: number,
  limits: AddOperationLimits,
): AddIndexSnapshot {
  const paths: AddIndexPath[] = [];
  const conflicted = new Set<string>();
  let retained = initialRetained;
  let current: AddIndexPath | null = null;
  for (const entry of entries) {
    if (limits.indexRows >= ADD_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `add index scan exceeds ${ADD_MAX_ROWS_PER_STREAM} rows`);
    }
    limits.indexRows++;
    if (pathspec !== undefined && !pathspec.matches(entry.path)) continue;
    const rowRetained =
      INDEX_ROW_FIXED_BYTES + structuralStringBytes(entry.path) + structuralStringBytes(entry.oid);
    retained += rowRetained;
    if (retained > ADD_RETAINED_BYTES) {
      throw new GitError("E2BIG", `add retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
    }
    if (current === null || current.path !== entry.path) {
      current = { path: entry.path, entry: entry.stage === 0 ? entry : undefined };
      paths.push(current);
      const pathRetained = PATH_ENTRY_FIXED_BYTES;
      retained += pathRetained;
    } else if (entry.stage === 0) {
      current.entry = entry;
    }
    if (entry.stage !== 0 && !conflicted.has(entry.path)) {
      retained += PATH_ENTRY_FIXED_BYTES;
      conflicted.add(entry.path);
    }
    if (retained > ADD_RETAINED_BYTES) {
      throw new GitError("E2BIG", `add retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
    }
  }
  return { paths, conflicted };
}

function* boundedAddWorktreeRows(
  entries: Iterable<WorktreePath>,
  limits: AddOperationLimits,
): Generator<WorktreePath> {
  for (const entry of entries) {
    if (limits.worktreeRows >= ADD_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `add worktree scan exceeds ${ADD_MAX_ROWS_PER_STREAM} rows`);
    }
    limits.worktreeRows++;
    yield entry;
  }
}

function* boundedAddHeadRows(
  entries: Iterable<TargetEntry>,
  limits: AddOperationLimits,
): Generator<TargetEntry> {
  for (const entry of entries) {
    if (limits.headRows >= ADD_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `add HEAD scan exceeds ${ADD_MAX_ROWS_PER_STREAM} rows`);
    }
    limits.headRows++;
    yield entry;
  }
}

function stageCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: StageCandidateBatch,
  sink: IndexSink,
): void {
  if (candidates.rows.length === 0) return;
  try {
    const rows = candidates.rows;
    const identities = repo.store.lookupBlobIds(
      rows.flatMap((row) => {
        if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat))
          return [];
        const contentId = row.worktree.stat.contentId;
        return contentId === null ? [] : [contentId];
      }),
    );
    const unresolved: WorktreePath[] = [];
    const mapped = new Map<string, string>();
    for (const row of rows) {
      if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) continue;
      const contentId = row.worktree.stat.contentId;
      const oid = contentId === null ? undefined : identities.get(contentIdKey(contentId));
      if (oid === undefined) {
        unresolved.push(row.worktree);
      } else {
        mapped.set(row.path, oid);
      }
    }
    const hashes = hashWorktreePathsOwned(repo, worktree, unresolved);
    repo.store.upsertBlobIds(
      [...hashes.values()].flatMap((hashed) => {
        const contentId = hashed.stat.contentId;
        return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
      }),
    );

    for (const row of rows) {
      let update: IndexEntry | null = null;
      if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) {
        update = indexEntryFor(row.path, {
          oid: row.existing.oid,
          mode: row.existing.mode.toString(8).padStart(6, "0"),
          stat: row.worktree.stat,
        });
      } else {
        const hashed = hashes.get(row.path);
        const oid = mapped.get(row.path);
        if (hashed !== undefined) update = indexEntryFor(row.path, hashed);
        else if (oid !== undefined) {
          update = indexEntryFor(row.path, {
            oid,
            mode: gitModeFor(row.worktree.stat),
            stat: row.worktree.stat,
          });
        }
      }
      if (update === null) {
        if (row.existing !== undefined || row.conflicted) sink.remove(row.path);
        continue;
      }
      if (row.conflicted) sink.remove(row.path);
      sink.put(update);
    }
  } finally {
    candidates.rows.length = 0;
  }
}

function retainStageCandidate(batch: StageCandidateBatch, candidate: StageCandidate): void {
  batch.rows.push(candidate);
}

function relativeExcludeRoots(root: string, paths: readonly string[] | undefined): string[] {
  const relatives: string[] = [];
  for (const path of paths ?? []) {
    const relative = relativeTo(root, path);
    if (relative === null || relative === "") continue;
    relatives.push(relative);
  }
  return relatives;
}

function isExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathRoot(root, path));
}

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
  directoryOnly: boolean;
  matched: boolean;
  directoryMatch: boolean;
  worktreeDirectory: boolean;
}

interface RmSpecIndex {
  files: Map<string, RmSpec>;
  directories: Map<string, RmSpec>;
}

interface RmCandidate {
  path: string;
  head: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
  conflicted: boolean;
  worktreeMatchesIndex: boolean;
}

const RM_WINDOW_ROWS = 1_000;
const RM_MAX_ROWS_PER_STREAM = 50_000;
const RM_MAX_PATHSPECS = 10_000;
const RM_CANDIDATE_FIXED_BYTES = 320;
const RM_DIRECTORY_FIXED_BYTES = 96;
const RM_SPEC_FIXED_BYTES = 192;
const RM_ARRAY_ENTRY_BYTES = 8;
const RM_REMOVE_BINDING_BYTES = 1_000_000;
const RM_EXECUTION_HEADROOM_BYTES = 4 * 1024 * 1024;

/** Remove tracked paths with Git's HEAD/index/worktree safety checks. */
export function rm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  runRm(repo, worktree, options);
}

function runRm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  const normalized = normalizeRmSpecs(options.paths);
  const specs = normalized.specs;
  if (specs.length === 0) return;

  const cached = options.cached === true;
  const force = options.force === true;
  const recursive = options.recursive === true;
  const excluded = relativeExcludeRoots(repo.root, options.excludeRoots);
  const candidates: RmCandidate[] = [];
  const removed = new Set<string>();
  let retained = normalized.retained;

  for (const row of joinSorted3(
    boundedRmRows(treeStream(repo, repo.headTree()), "HEAD"),
    rmIndexPaths(repo, normalized.index, excluded),
    boundedRmRows(
      walkWorktreeEntriesStreamOwned(worktree, repo.root, {
        excludeRoots: options.excludeRoots,
        includeIgnored: true,
        includeDirectories: true,
      }),
      "worktree",
    ),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
  )) {
    const selected = row.b;
    if (selected === undefined) continue;
    noteRmMatches(normalized.index, selected.path, row.c?.stat.type === "dir");
    retained +=
      RM_CANDIDATE_FIXED_BYTES +
      structuralStringBytes(selected.path) +
      structuralStringBytes(selected.entry?.oid ?? "") +
      structuralStringBytes(row.a?.oid ?? "") +
      structuralStringBytes(row.c?.stat.target ?? "") +
      (row.c?.stat.contentId?.byteLength ?? 0);
    requireRmRetained(retained);
    removed.add(selected.path);
    candidates.push({
      path: selected.path,
      head: row.a,
      index: selected.entry,
      worktree: row.c,
      conflicted: selected.conflicted,
      worktreeMatchesIndex: false,
    });
  }

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
  if (candidates.length === 0) return;

  if (!force) {
    identifyRmWorktree(repo, worktree, candidates);
    for (const candidate of candidates) {
      if (candidate.conflicted) continue;
      const entry = candidate.index;
      if (entry === undefined) {
        throw new GitError("EUNSAFEREMOVE", `cannot prove index state for '${candidate.path}'`);
      }
      const headMatches =
        candidate.head !== undefined &&
        candidate.head.oid === entry.oid &&
        Number.parseInt(candidate.head.mode, 8) === entry.mode;
      const missingWorktree = candidate.worktree === undefined;
      const safe = cached
        ? headMatches || candidate.worktreeMatchesIndex
        : missingWorktree || (headMatches && candidate.worktreeMatchesIndex);
      if (!safe) {
        throw new GitError(
          "EUNSAFEREMOVE",
          `path '${candidate.path}' has staged or working-tree changes`,
        );
      }
    }
  }

  let pruned: string[] = [];
  if (!cached) {
    const planned = planRmDirectoryPrune(
      repo,
      worktree,
      candidates,
      removed,
      options.excludeRoots,
      retained,
    );
    pruned = planned.directories;
    retained = planned.retained;
  }
  requireRmRetained(retained);

  repo.store.db.transactionSync(() => {
    if (!cached) {
      removeRmWorktreePaths(worktree, physicalRmPaths(repo, candidates), false);
      removeRmWorktreePaths(worktree, absoluteRmPaths(repo, pruned), true);
    }
    repo.checkout.indexApply((sink) => {
      for (const candidate of candidates) sink.remove(candidate.path);
    });
  });
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

function identifyRmWorktree(repo: Repository, worktree: Worktree, candidates: RmCandidate[]): void {
  for (let offset = 0; offset < candidates.length; offset += RM_WINDOW_ROWS) {
    const batch = candidates.slice(offset, offset + RM_WINDOW_ROWS);
    const pending = batch.filter(
      (candidate) =>
        !candidate.conflicted &&
        candidate.index !== undefined &&
        candidate.worktree !== undefined &&
        candidate.worktree.stat.type !== "dir" &&
        !indexMatchesStat(candidate.index, candidate.worktree.stat),
    );
    for (const candidate of batch) {
      if (
        !candidate.conflicted &&
        candidate.index !== undefined &&
        candidate.worktree !== undefined &&
        candidate.worktree.stat.type !== "dir" &&
        indexMatchesStat(candidate.index, candidate.worktree.stat)
      ) {
        candidate.worktreeMatchesIndex = true;
      }
    }
    if (pending.length === 0) continue;

    const authoritative = pending.flatMap((candidate) =>
      candidate.worktree === undefined ? [] : [candidate.worktree],
    );
    const hashes = hashExactWorktreePathsOwned(repo, worktree, authoritative, {
      write: false,
    });
    for (const candidate of pending) {
      const entry = candidate.index;
      const hashed = hashes.get(candidate.path);
      if (
        entry !== undefined &&
        hashed !== undefined &&
        hashed.oid === entry.oid &&
        Number.parseInt(hashed.mode, 8) === entry.mode
      ) {
        candidate.worktreeMatchesIndex = true;
      }
    }
  }
}

function planRmDirectoryPrune(
  repo: Repository,
  worktree: Worktree,
  candidates: readonly RmCandidate[],
  removed: ReadonlySet<string>,
  excludeRoots: readonly string[] | undefined,
  initialRetained: number,
): { directories: string[]; retained: number } {
  const directories = new Set<string>();
  let retained = initialRetained;
  for (const { path } of candidates) {
    const parts = path.split("/");
    for (let depth = parts.length - 1; depth > 0; depth--) {
      const directory = parts.slice(0, depth).join("/");
      if (directories.has(directory)) continue;
      retained += RM_DIRECTORY_FIXED_BYTES + structuralStringBytes(directory);
      requireRmRetained(retained);
      directories.add(directory);
    }
  }
  if (directories.size === 0) return { directories: [], retained };

  const blocked = new Set<string>();
  const block = (path: string, includeSelf: boolean): void => {
    const parts = path.split("/");
    let depth = includeSelf ? parts.length : parts.length - 1;
    for (; depth > 0; depth--) {
      const directory = parts.slice(0, depth).join("/");
      if (!directories.has(directory) || blocked.has(directory)) continue;
      retained += RM_DIRECTORY_FIXED_BYTES;
      requireRmRetained(retained);
      blocked.add(directory);
    }
  };

  for (const root of relativeExcludeRoots(repo.root, excludeRoots)) block(root, true);
  for (const entry of boundedRmRows(
    walkWorktreeEntriesStreamOwned(worktree, repo.root, {
      excludeRoots: excludeRoots === undefined ? undefined : [...excludeRoots],
      includeIgnored: true,
      includeDirectories: true,
    }),
    "directory-prune worktree",
  )) {
    if (removed.has(entry.path) && entry.stat.type !== "dir") continue;
    if (entry.stat.type === "dir" && directories.has(entry.path)) continue;
    block(entry.path, entry.stat.type === "dir");
  }

  const pruned: string[] = [];
  for (const directory of directories) {
    if (blocked.has(directory)) continue;
    retained += RM_ARRAY_ENTRY_BYTES;
    requireRmRetained(retained);
    pruned.push(directory);
  }
  pruned.sort((left, right) => {
    const depth = pathDepth(right) - pathDepth(left);
    return depth === 0 ? comparePaths(left, right) : depth;
  });
  return { directories: pruned, retained };
}

function pathDepth(path: string): number {
  let depth = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) depth++;
  }
  return depth;
}

function normalizeRmSpecs(paths: readonly string[]): {
  specs: RmSpec[];
  index: RmSpecIndex;
  retained: number;
} {
  if (paths.length > RM_MAX_PATHSPECS) {
    throw new GitError("E2BIG", `rm pathspec count exceeds ${RM_MAX_PATHSPECS}`);
  }
  const specs: RmSpec[] = [];
  const files = new Map<string, RmSpec>();
  const directories = new Map<string, RmSpec>();
  let retained = RM_EXECUTION_HEADROOM_BYTES;
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
    const seen = directoryOnly ? directories : files;
    if (seen.has(path)) continue;
    const additional = RM_SPEC_FIXED_BYTES + RM_ARRAY_ENTRY_BYTES + structuralStringBytes(path);
    requireRmRetained(retained + additional);
    retained += additional;
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
    index: { files, directories },
    retained,
  };
}

function matchesRmSpecs(specs: RmSpecIndex, path: string): boolean {
  return visitMatchingRmSpecs(specs, path, () => {});
}

function noteRmMatches(specs: RmSpecIndex, path: string, worktreeDirectory: boolean): void {
  visitMatchingRmSpecs(specs, path, (spec) => {
    spec.matched = true;
    if (spec.directoryOnly || path !== spec.path) spec.directoryMatch = true;
    if (!spec.directoryOnly && path === spec.path && worktreeDirectory) {
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

function* physicalRmPaths(repo: Repository, candidates: readonly RmCandidate[]): Generator<string> {
  for (const candidate of candidates) {
    if (candidate.worktree === undefined) continue;
    yield joinPath(repo.root, candidate.path);
  }
}

function* absoluteRmPaths(repo: Repository, paths: readonly string[]): Generator<string> {
  for (const path of paths) yield joinPath(repo.root, path);
}

function removeRmWorktreePaths(
  worktree: Worktree,
  paths: Iterable<string>,
  recursive: boolean,
): void {
  let batch: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (batch.length === 0) return;
    worktree.removeFiles(batch, { force: true, recursive });
    batch = [];
    bytes = 2;
  };
  for (const path of paths) {
    const itemBytes = jsonStringUtf8Length(path);
    if (batch.length > 0 && bytes + itemBytes + 1 > RM_REMOVE_BINDING_BYTES) flush();
    batch.push(path);
    bytes += itemBytes + 1;
  }
  flush();
}

function jsonStringUtf8Length(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    )
      bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit <= 0x7f) bytes++;
    else if (unit <= 0x7ff) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index++;
    } else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) {
      throw new GitError("E2BIG", "rm filesystem binding size overflows");
    }
  }
  return bytes;
}

function* boundedRmRows<T>(rows: Iterable<T>, label: string): Generator<T> {
  let count = 0;
  for (const row of rows) {
    if (count >= RM_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `rm ${label} scan exceeds ${RM_MAX_ROWS_PER_STREAM} rows`);
    }
    count++;
    yield row;
  }
}

function requireRmRetained(bytes: number): void {
  if (bytes > ADD_RETAINED_BYTES) {
    throw new GitError("E2BIG", `rm retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
  }
}

export interface ResetOptions {
  /** Unstage these paths back to `ref`, leaving the working tree alone. */
  paths?: string[];
  /** Move the current branch to `ref` and rewrite index and working tree. */
  hard?: boolean;
  /** Commit-ish to reset to. Defaults to HEAD. */
  ref?: string;
  excludeRoots?: readonly string[];
}

export function reset(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: ResetOptions = {},
): void {
  if (options.hard === true) {
    hardReset(context, repo, worktree, options);
    return;
  }

  const specs = normalizeSpecs(options.paths ?? []);
  const tree = targetTree(repo, options.ref);
  if (specs.length === 0) {
    // This one genuinely replaces the whole index, so the big hammer fits.
    repo.checkout.indexReplace(indexFromTree(repo, tree));
    return;
  }

  // Tree and index are both path-ordered, so one merge decides each path.
  repo.checkout.indexApply((sink) => {
    for (const row of joinSorted(indexFromTree(repo, tree), repo.checkout.indexScan(), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      if (!matchesPaths(row.path, specs)) continue;
      // A conflicted path repeats across stages; clearing it once is enough,
      // and indexPut only ever overwrites stage 0.
      if (row.right !== undefined && row.right.stage !== 0) sink.remove(row.path);
      if (row.left === undefined) {
        if (row.right !== undefined) sink.remove(row.path);
        continue;
      }
      sink.put(row.left);
    }
  });
}

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
  const index = uniqueIndexPaths(repo, pathspec.scanPrefixes);
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

function hardReset(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: ResetOptions,
): void {
  repo.store.db.transactionSync(() => {
    const commit = targetCommit(repo, options.ref);
    const tree = commit === null ? null : repo.readCommit(commit).tree;
    const head = repo.head();
    if (commit !== null) {
      const metadata = operationRefLogMetadata(context, repo, "reset: hard");
      const mutation =
        head.ref === null ? { head: commit } : { puts: [{ name: head.ref, target: commit }] };
      repo.mutateRefs(mutation, metadata);
    }
    checkoutTreeExcluding(repo, worktree, tree, options.excludeRoots ?? [], {
      discardUnmerged: true,
      restoreStructure: true,
    });
  });
}

function targetCommit(repo: Repository, ref?: string): string | null {
  if (ref === undefined || ref === "HEAD") {
    const { oid } = repo.head();
    return oid === null ? null : repo.peel(oid);
  }
  return repo.peel(repo.revParse(ref));
}

function targetTree(repo: Repository, ref?: string): string | null {
  const commit = targetCommit(repo, ref);
  return commit === null ? null : repo.readCommit(commit).tree;
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

function normalizeSpecs(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let spec = raw;
    while (spec.startsWith("./")) spec = spec.slice(2);
    spec = spec.replace(/\/+$/, "");
    if (spec === ".") spec = "";
    if (!out.includes(spec)) out.push(spec);
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
