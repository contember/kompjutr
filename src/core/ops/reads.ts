// Read-only queries over the object database. These back `log`, `show`,
// `rev-parse`, `ls-tree`, `ls-files` and `cat-file`.

import { ObjectNotFoundError, RefNotFoundError } from "../errors.js";
import {
  type Commit,
  displayMode,
  isTreeMode,
  type ObjectType,
  type Person,
  typeForMode,
} from "../objects.js";
import type { Repository } from "../repository.js";

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

export function lsTree(repo: Repository, ref: string, path = ""): TreeEntryView[] {
  const commitish = repo.revParse(ref);
  const rootTree = treeOf(repo, commitish);
  let treeOid = rootTree;
  if (path !== "") {
    const found = repo.resolveTreePath(rootTree, path);
    if (found === null) throw new RefNotFoundError(`${ref}:${path}`);
    if (!isTreeMode(found.mode)) {
      return [
        {
          mode: displayMode(found.mode),
          path,
          oid: found.oid,
          type: typeForMode(found.mode),
        },
      ];
    }
    treeOid = found.oid;
  }
  const prefix = path === "" ? "" : `${path.replace(/\/+$/, "")}/`;
  return repo.readTree(treeOid).map((entry) => ({
    mode: displayMode(entry.mode),
    path: `${prefix}${entry.name}`,
    oid: entry.oid,
    type: typeForMode(entry.mode),
  }));
}

/** The tree of a commit, or the object itself when it already is a tree. */
export function treeOf(repo: Repository, oid: string): string {
  const peeled = repo.peel(oid, "commit");
  const type = repo.typeOf(peeled);
  if (type === "tree") return peeled;
  if (type === "commit") return repo.readCommit(peeled).tree;
  throw new ObjectNotFoundError(oid);
}

export function lsFilesAtRef(repo: Repository, ref: string): string[] {
  const tree = treeOf(repo, repo.revParse(ref));
  const out: string[] = [];
  for (const { path } of repo.walkTree(tree)) out.push(path);
  return out.sort();
}

export interface CatFileResult {
  oid: string;
  bytes: Uint8Array;
  type: ObjectType;
}

export function catFile(repo: Repository, spec: string, filepath?: string): CatFileResult {
  // `cat-file -p <oid>:<path>` shorthand.
  let ref = spec;
  let path = filepath;
  const colon = spec.indexOf(":");
  if (path === undefined && colon > 0) {
    ref = spec.slice(0, colon);
    path = spec.slice(colon + 1);
  }
  let oid = repo.revParse(ref);
  if (path !== undefined && path !== "") {
    const entry = repo.resolveTreePath(treeOf(repo, oid), path);
    if (entry === null) throw new RefNotFoundError(`${ref}:${path}`);
    oid = entry.oid;
  }
  const object = repo.read(oid);
  return { oid, bytes: object.data, type: object.type };
}
