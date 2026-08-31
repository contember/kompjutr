// Read-only queries over the object database. These back `log`, `show`,
// `rev-parse`, `ls-tree`, `ls-files` and `cat-file`.

import { readAuthenticatedObjectOwned } from "../../sqlite/store.js";
import { CorruptError, GitError, ObjectNotFoundError, RefNotFoundError } from "../errors.js";
import {
  type Commit,
  displayMode,
  isTreeMode,
  type ObjectType,
  type Person,
  parseTree,
  type TreeEntry,
  typeForMode,
} from "../objects.js";
import { type Repository, walkIndexedOwned, walkOwned } from "../repository.js";
import { compileReadPathspec, type LsFilesOptions } from "./pathspec.js";

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

export function log(
  repo: Repository,
  options: { ref?: string; depth?: number } = {},
): CommitView[] {
  const start =
    repo.head().oid !== null || options.ref !== undefined ? (options.ref ?? "HEAD") : null;
  if (start === null) return [];
  const oid = repo.revParse(start);
  const bounded = options.depth !== undefined && options.depth <= 256;
  if (bounded) {
    const collected: { oid: string; commit: Commit }[] = [];
    for (const entry of walkOwned(repo, oid)) {
      collected.push(entry);
      if (options.depth !== undefined && collected.length >= options.depth) break;
    }
    repo.validateCommitWalk(collected);
    return collected.map(({ oid: commitOid, commit }) => parsedCommitView(commitOid, commit));
  }
  const out: CommitView[] = [];
  for (const { oid: commitOid, commit } of walkIndexedOwned(repo, oid)) {
    out.push(parsedCommitView(commitOid, commit));
    if (options.depth !== undefined && out.length >= options.depth) break;
  }
  return out;
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
    if (depth === undefined || out.length < depth) {
      out.push(parsedCommitView(entry.oid, entry.commit));
    }
    expected = entry.commit.parent[0]!;
  }
  throw unsupportedLinearRange();
}

function unsupportedLinearRange(): GitError {
  return new GitError("EUNSUPPORTED", LINEAR_RANGE_ERROR);
}

export function show(repo: Repository, ref: string): CommitView {
  return commitView(repo, repo.peel(repo.revParse(ref)));
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
