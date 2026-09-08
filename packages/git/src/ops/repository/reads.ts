// Read-only queries over the object database. These back `log`, `show`,
// `rev-parse`, `ls-tree`, `ls-files` and `cat-file`.

import {
  CorruptError,
  GitError,
  ObjectNotFoundError,
  RefNotFoundError,
} from "../../common/errors.js";
import {
  type Commit,
  displayMode,
  isTreeMode,
  type ObjectType,
  type Person,
  parseTree,
  type TreeEntry,
  typeForMode,
} from "../../common/objects.js";
import { MAX_LOG_COMMITS, readAuthenticatedObjectOwned } from "../../store/index.js";
import { matchesPaths } from "../checkout/checkout.js";
import { diffTrees } from "../diff/diff.js";
import { statusFormatOptions } from "../status/status-format.js";
import { compileReadPathspec, type LsFilesOptions } from "../worktree/pathspec.js";
import {
  type PrunedCommitWalkDecision,
  type Repository,
  walkIndexedOwned,
  walkOwned,
  walkPrunedOwned,
} from "./repository.js";

const LINEAR_RANGE_ERROR = "log range is not a complete single-parent chain";

/** Matches `CommitView` on Computer's GitClient surface. */
export interface CommitView {
  oid: string;
  message: string;
  tree: string;
  parent: string[];
  author: Person;
  committer: Person;
}

export interface LogOptions {
  ref?: string;
  depth?: number;
  paths?: string[];
  firstParent?: boolean;
}

export interface ShowOptions {
  ref: string;
  patch?: boolean;
  mainline?: number;
}

export interface ShowResult {
  commit: CommitView;
  patch?: string;
}

/** Matches `TreeEntryView` on Computer's GitClient surface. */
export interface TreeEntryView {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

export interface LsTreeOptions {
  recursive?: boolean;
}

export const MAX_LS_TREE_ENTRIES = 10_000;

function parsedCommitView(oid: string, commit: Commit): CommitView {
  return {
    oid,
    message: commit.message,
    tree: commit.tree,
    parent: commit.parent,
    author: commit.author,
    committer: commit.committer,
  };
}

export function commitView(repo: Repository, oid: string): CommitView {
  return parsedCommitView(oid, repo.readCommit(oid));
}

export function log(repo: Repository, options: LogOptions = {}): CommitView[] {
  validateLogOptions(options);
  const start =
    repo.head().oid !== null || options.ref !== undefined ? (options.ref ?? "HEAD") : null;
  if (start === null) return [];
  const oid = repo.revParse(start);
  const paths = options.paths?.length === 0 ? undefined : options.paths;
  if (paths !== undefined) return pathLog(repo, oid, paths, options);
  const bounded = options.depth !== undefined && options.depth <= 256;
  const selected: CommitView[] = [];
  const walked: { oid: string; commit: Commit }[] = [];
  const entries =
    options.firstParent === true
      ? bounded
        ? walkFirstParentOwned(repo, oid)
        : walkFirstParentIndexed(repo, oid)
      : bounded
        ? walkOwned(repo, oid)
        : walkIndexedOwned(repo, oid);
  const validateWalk = options.firstParent !== true && bounded;
  for (const entry of entries) {
    if (validateWalk) walked.push(entry);
    selected.push(parsedCommitView(entry.oid, entry.commit));
    if (options.depth !== undefined && selected.length >= options.depth) break;
  }
  if (validateWalk) repo.validateCommitWalk(walked);
  return selected;
}

function pathLog(
  repo: Repository,
  oid: string,
  paths: string[],
  options: LogOptions,
): CommitView[] {
  const selected: CommitView[] = [];
  const walked: { oid: string; commit: Commit }[] = [];
  const boundary = repo.shallow();
  for (const entry of walkPrunedOwned(repo, oid, ({ oid: commitOid, commit }) =>
    pathHistoryDecision(repo, commitOid, commit, paths, boundary, options.firstParent === true),
  )) {
    walked.push(entry);
    if (!entry.include) continue;
    selected.push(parsedCommitView(entry.oid, entry.commit));
    if (options.depth !== undefined && selected.length >= options.depth) break;
  }
  repo.validateCommitWalk(walked);
  return selected;
}

function validateLogOptions(options: LogOptions): void {
  if (options.firstParent !== undefined && typeof options.firstParent !== "boolean") {
    throw new GitError("EINVAL", "log firstParent must be a boolean");
  }
  if (options.paths !== undefined) {
    for (const path of options.paths) {
      if (typeof path !== "string") throw new GitError("EINVAL", "log paths must be strings");
    }
  }
}

function* walkFirstParentOwned(
  repo: Repository,
  start: string,
): Generator<{ oid: string; commit: Commit }> {
  const boundary = repo.shallow();
  const seen = new Set<string>();
  let oid: string | undefined = repo.peel(start);
  while (oid !== undefined) {
    if (seen.has(oid)) throw new CorruptError("commit graph contains a cycle");
    if (seen.size >= MAX_LOG_COMMITS) {
      throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
    }
    seen.add(oid);
    const commit = repo.readCommit(oid);
    yield { oid, commit };
    oid = boundary.has(oid) ? undefined : commit.parent[0];
  }
}

function* walkFirstParentIndexed(
  repo: Repository,
  start: string,
): Generator<{ oid: string; commit: Commit }> {
  const boundary = repo.shallow();
  let expected: string | undefined = repo.peel(start);
  for (const entry of walkIndexedOwned(repo, expected)) {
    if (entry.oid !== expected) continue;
    yield entry;
    expected = boundary.has(entry.oid) ? undefined : entry.commit.parent[0];
    if (expected === undefined) return;
  }
  throw new CorruptError("first-parent walk did not reach its expected commit");
}

function pathHistoryDecision(
  repo: Repository,
  oid: string,
  commit: Commit,
  paths: string[],
  boundary: ReadonlySet<string> | undefined,
  firstParent = false,
): PrunedCommitWalkDecision {
  if (boundary?.has(oid) === true || commit.parent.length === 0) {
    return { include: treesDifferAtPaths(repo, null, commit.tree, paths), parents: [] };
  }
  if (firstParent) {
    const parent = commit.parent[0];
    if (parent === undefined) return { include: true, parents: [] };
    return {
      include: treesDifferAtPaths(repo, repo.readCommit(parent).tree, commit.tree, paths),
      parents: [parent],
    };
  }
  const treesame: string[] = [];
  for (const parent of commit.parent) {
    if (!treesDifferAtPaths(repo, repo.readCommit(parent).tree, commit.tree, paths)) {
      treesame.push(parent);
    }
  }
  if (commit.parent.length > 1 && treesame.length > 0) {
    return { include: false, parents: [treesame[0]!] };
  }
  return { include: treesame.length === 0, parents: commit.parent };
}

function treesDifferAtPaths(
  repo: Repository,
  before: string | null,
  after: string | null,
  paths: string[],
): boolean {
  for (const row of repo.walkTreeDiff(before, after)) {
    if (matchesPaths(row.path, paths)) return true;
  }
  return false;
}

/**
 * Read the right side of a range only when it reaches the exclusive left tip
 * through a complete single-parent chain.
 */
export function linearLogRange(
  repo: Repository,
  left: string,
  right: string,
  depth?: number,
  options: Pick<LogOptions, "paths"> = {},
): CommitView[] {
  const leftOid = repo.peel(repo.revParse(left));
  const rightOid = repo.peel(repo.revParse(right));
  if (leftOid === rightOid) return [];

  const boundary = repo.shallow();
  const out: CommitView[] = [];
  let expected = rightOid;
  for (const entry of walkIndexedOwned(repo, rightOid)) {
    if (entry.oid !== expected) throw unsupportedLinearRange();
    if (entry.oid === leftOid) return out;
    if (boundary.has(entry.oid) || entry.commit.parent.length !== 1) {
      throw unsupportedLinearRange();
    }
    if (
      (options.paths === undefined ||
        pathHistoryDecision(repo, entry.oid, entry.commit, options.paths, boundary).include) &&
      (depth === undefined || out.length < depth)
    ) {
      out.push(parsedCommitView(entry.oid, entry.commit));
    }
    expected = entry.commit.parent[0]!;
  }
  throw unsupportedLinearRange();
}

function unsupportedLinearRange(): GitError {
  return new GitError("EUNSUPPORTED", LINEAR_RANGE_ERROR);
}

export function show(repo: Repository, options: ShowOptions): ShowResult {
  validateShowOptions(options);
  const oid = repo.peel(repo.revParse(options.ref));
  const commit = repo.readCommit(oid);
  const view = parsedCommitView(oid, commit);
  if (options.patch !== true) return { commit: view };
  const beforeTree = showParentTree(repo, oid, commit, options.mainline);
  const quoteNonAscii = statusFormatOptions(repo).quotePath ?? true;
  return {
    commit: view,
    patch: diffTrees(repo, beforeTree, commit.tree, {}, { quotePaths: true, quoteNonAscii }),
  };
}

function validateShowOptions(options: ShowOptions): void {
  if (options.patch !== undefined && typeof options.patch !== "boolean") {
    throw new GitError("EINVAL", "show patch must be a boolean");
  }
  if (
    options.mainline !== undefined &&
    (!Number.isSafeInteger(options.mainline) || options.mainline < 1)
  ) {
    throw new GitError("EINVAL", "show mainline must be a positive safe integer");
  }
}

function showParentTree(
  repo: Repository,
  oid: string,
  commit: Commit,
  mainline: number | undefined,
): string | null {
  if (repo.shallow().has(oid) || commit.parent.length === 0) {
    if (mainline !== undefined && mainline !== 1) {
      throw new GitError("EINVAL", "root show accepts only mainline 1");
    }
    return null;
  }
  if (commit.parent.length > 1 && mainline === undefined) {
    throw new GitError("EINVAL", "merge show requires an explicit mainline");
  }
  const selected = mainline ?? 1;
  const parent = commit.parent[selected - 1];
  if (parent === undefined) {
    throw new GitError(
      "EINVAL",
      `show mainline ${selected} exceeds ${commit.parent.length} parents`,
    );
  }
  return repo.readCommit(parent).tree;
}

function treeEntryView(path: string, entry: TreeEntry): TreeEntryView {
  return {
    mode: displayMode(entry.mode),
    path,
    oid: entry.oid,
    type: typeForMode(entry.mode),
  };
}

export function collectRecursiveTreeEntries(
  entries: Iterable<{ path: string; entry: TreeEntry }>,
): TreeEntryView[] {
  const out: TreeEntryView[] = [];
  for (const { path, entry } of entries) {
    if (out.length >= MAX_LS_TREE_ENTRIES) {
      throw new GitError("E2BIG", `recursive ls-tree exceeds ${MAX_LS_TREE_ENTRIES} entries`);
    }
    out.push(treeEntryView(path, entry));
  }
  return out;
}

export function collectDirectTreeEntries(
  entries: readonly TreeEntry[],
  prefix: string,
): TreeEntryView[] {
  const out: TreeEntryView[] = [];
  for (const entry of entries) {
    out.push(treeEntryView(prefix === "" ? entry.name : `${prefix}${entry.name}`, entry));
  }
  return out;
}

export function lsTree(
  repo: Repository,
  ref: string,
  path = "",
  options: LsTreeOptions = {},
): TreeEntryView[] {
  const recursive = Reflect.get(options, "recursive");
  if (recursive !== undefined && typeof recursive !== "boolean") {
    throw new GitError("EINVAL", "ls-tree recursive must be a boolean");
  }
  const commitish = repo.revParse(ref);
  const rootTree = treeOf(repo, commitish);
  let treeOid = rootTree;
  if (path !== "") {
    const found = repo.resolveTreePath(rootTree, path);
    if (found === null) throw new RefNotFoundError(`${ref}:${path}`);
    if (!isTreeMode(found.mode)) {
      return collectRecursiveTreeEntries([{ path, entry: found }]);
    }
    treeOid = found.oid;
  }
  const base = path.replace(/\/+$/, "");
  if (recursive === true) {
    return collectRecursiveTreeEntries(recursiveTreeEntries(repo, treeOid, base));
  }
  const prefix = base === "" ? "" : `${base}/`;
  return readDirectTreeEntries(repo, treeOid, prefix);
}

function readDirectTreeEntries(repo: Repository, treeOid: string, prefix: string): TreeEntryView[] {
  const metadata = repo.store.typeAndSize(treeOid);
  if (metadata === null) throw new ObjectNotFoundError(treeOid);
  const object = readAuthenticatedObjectOwned(repo.store, treeOid, "tree");
  if (object === null) throw new ObjectNotFoundError(treeOid);
  if (object.data.length !== metadata.size) {
    throw new CorruptError("tree source size changed during ls-tree");
  }
  return parseTree(object.data).map((entry) =>
    treeEntryView(prefix === "" ? entry.name : `${prefix}${entry.name}`, entry),
  );
}

/** The tree of a commit, or the object itself when it already is a tree. */
export function treeOf(repo: Repository, oid: string): string {
  const peeled = repo.peel(oid, "commit");
  const type = repo.typeOf(peeled);
  if (type === "tree") return peeled;
  if (type === "commit") return repo.readCommit(peeled).tree;
  throw new ObjectNotFoundError(oid);
}

export function lsFilesAtRef(
  repo: Repository,
  ref: string,
  options: LsFilesOptions = {},
): string[] {
  const pathspec = compileReadPathspec(options);
  const tree = repo.resolveTreeRevision(ref);
  return pathspec.collect(treePaths(repo, tree));
}

/** Derived tree rows are one authenticated, allocation-bounded SQL traversal. */
function* treePaths(repo: Repository, tree: string): Generator<string> {
  for (const { path } of repo.store.walkTree(tree)) yield path;
}

function* recursiveTreeEntries(
  repo: Repository,
  tree: string,
  prefix: string,
): Generator<{ path: string; entry: TreeEntry }> {
  for (const entry of repo.store.walkTree(tree)) {
    const slash = entry.path.lastIndexOf("/");
    const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
    yield {
      path,
      entry: { mode: entry.mode, name: entry.path.slice(slash + 1), oid: entry.oid },
    };
  }
}

export interface CatFileResult {
  oid: string;
  bytes: Uint8Array;
  type: ObjectType;
}

export function catFile(repo: Repository, spec: string, filepath?: string): CatFileResult {
  const expression = filepath === undefined ? spec : `${spec}:${filepath}`;
  const oid = repo.resolveRevision(expression).oid;
  const object = repo.read(oid);
  return { oid, bytes: object.data, type: object.type };
}
