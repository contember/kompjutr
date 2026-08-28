// Read-only queries over the object database. These back `log`, `show`,
// `rev-parse`, `ls-tree`, `ls-files` and `cat-file`.

import { GitError, ObjectNotFoundError, RefNotFoundError } from "../errors.js";
import {
  type Commit,
  displayMode,
  isTreeMode,
  type ObjectType,
  type Person,
  type TreeEntry,
  typeForMode,
} from "../objects.js";
import type { Repository } from "../repository.js";
import { compileReadPathspec, type LsFilesOptions } from "./pathspec.js";

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
export const MAX_LS_TREE_RETAINED_BYTES = 16 * 1024 * 1024;
const LS_TREE_ENTRY_BYTES = 256;

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
    for (const entry of repo.walk(oid)) {
      collected.push(entry);
      if (options.depth !== undefined && collected.length >= options.depth) break;
    }
    repo.validateCommitWalk(collected);
    return collected.map(({ oid: commitOid, commit }) => parsedCommitView(commitOid, commit));
  }
  const out: CommitView[] = [];
  for (const { oid: commitOid, commit } of repo.walkIndexed(oid)) {
    out.push(parsedCommitView(commitOid, commit));
    if (options.depth !== undefined && out.length >= options.depth) break;
  }
  return out;
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
  let retainedBytes = 0;
  for (const { path, entry } of entries) {
    if (out.length >= MAX_LS_TREE_ENTRIES) {
      throw new GitError("E2BIG", `recursive ls-tree exceeds ${MAX_LS_TREE_ENTRIES} entries`);
    }
    const rowBytes = LS_TREE_ENTRY_BYTES + path.length * 2;
    if (!Number.isSafeInteger(rowBytes) || rowBytes > MAX_LS_TREE_RETAINED_BYTES - retainedBytes) {
      throw new GitError(
        "E2BIG",
        `recursive ls-tree exceeds ${MAX_LS_TREE_RETAINED_BYTES} retained bytes`,
      );
    }
    retainedBytes += rowBytes;
    out.push(treeEntryView(path, entry));
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
      return [treeEntryView(path, found)];
    }
    treeOid = found.oid;
  }
  const base = path.replace(/\/+$/, "");
  if (recursive === true) {
    return collectRecursiveTreeEntries(repo.walkTree(treeOid, base));
  }
  const prefix = base === "" ? "" : `${base}/`;
  return repo.readTree(treeOid).map((entry) => treeEntryView(`${prefix}${entry.name}`, entry));
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
  for (const { path } of repo.walkTree(tree)) yield path;
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
