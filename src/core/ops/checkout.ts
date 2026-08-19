// Materialising a tree into the working tree, and keeping the SQL index in
// step with it.

import type { IndexEntry } from "../../sqlite/store.js";
import { isTreeMode, type TreeEntry } from "../objects.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import { fileModeFor, type Worktree } from "../worktree.js";

export interface TargetEntry {
  path: string;
  mode: string;
  oid: string;
}

/** Every blob, symlink and gitlink under a tree, keyed by repo-relative path. */
export function treeEntries(repo: Repository, treeOid: string | null): Map<string, TargetEntry> {
  const out = new Map<string, TargetEntry>();
  if (treeOid === null) return out;
  for (const { path, entry } of repo.walkTree(treeOid)) {
    out.set(path, { path, mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Does `path` fall under one of the pathspecs? An empty list matches all. */
export function matchesPaths(path: string, paths: string[] | undefined): boolean {
  if (paths === undefined || paths.length === 0) return true;
  return paths.some(
    (spec) =>
      spec === "" ||
      spec === "." ||
      path === spec ||
      path.startsWith(`${spec.replace(/\/+$/, "")}/`),
  );
}

export interface CheckoutOptions {
  /** Restrict the update to these repo-relative pathspecs. */
  paths?: string[];
  /** Remove tracked files that the target tree does not have. */
  prune?: boolean;
}

/**
 * Bring the working tree and the index to `treeOid`. Entries already
 * matching are left alone, so a checkout that changes one file touches one
 * file.
 */
export function checkoutTree(
  repo: Repository,
  worktree: Worktree,
  treeOid: string | null,
  options: CheckoutOptions = {},
): void {
  const target = treeEntries(repo, treeOid);
  const current = new Map<string, IndexEntry>();
  for (const entry of repo.store.indexEntries()) {
    if (entry.stage === 0) current.set(entry.path, entry);
  }

  const written: IndexEntry[] = [];
  for (const entry of target.values()) {
    if (!matchesPaths(entry.path, options.paths)) continue;
    if (entry.mode === "160000") continue; // submodules are out of scope
    const absolute = joinPath(repo.root, entry.path);
    const existing = current.get(entry.path);
    const stat = worktree.stat(absolute);
    const unchanged =
      existing !== undefined &&
      existing.oid === entry.oid &&
      existing.mode === Number.parseInt(entry.mode, 8) &&
      stat !== null &&
      stat.size === existing.size &&
      stat.mtime === existing.mtime;
    if (unchanged) continue;
    written.push(writeEntry(repo, worktree, entry));
  }

  const removed: string[] = [];
  if (options.prune !== false) {
    for (const [path] of current) {
      if (target.has(path)) continue;
      if (!matchesPaths(path, options.paths)) continue;
      worktree.unlink(joinPath(repo.root, path));
      removed.push(path);
    }
  }

  repo.store.db.transactionSync(() => {
    for (const path of removed) repo.store.indexRemove(path);
    for (const entry of written) repo.store.indexPut(entry);
  });

  if (removed.length > 0) pruneEmptyDirectories(repo, worktree, removed);
}

/** Write one tree entry to disk and describe the index row it deserves. */
export function writeEntry(repo: Repository, worktree: Worktree, entry: TargetEntry): IndexEntry {
  const absolute = joinPath(repo.root, entry.path);
  const data = repo.readBlob(entry.oid);
  if (entry.mode === "120000") {
    worktree.unlink(absolute);
    worktree.symlink(new TextDecoder().decode(data), absolute);
  } else {
    worktree.writeFile(absolute, data, fileModeFor(entry.mode));
  }
  const stat = worktree.stat(absolute);
  return {
    path: entry.path,
    stage: 0,
    mode: Number.parseInt(entry.mode, 8),
    oid: entry.oid,
    size: stat?.size ?? data.length,
    mtime: stat?.mtime ?? null,
    ino: stat?.ino ?? null,
  };
}

/** Drop directories left empty by a checkout, deepest first, like git. */
function pruneEmptyDirectories(repo: Repository, worktree: Worktree, removed: string[]): void {
  const directories = new Set<string>();
  for (const path of removed) {
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) directories.add(parts.slice(0, i).join("/"));
  }
  const deepestFirst = [...directories].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const directory of deepestFirst) {
    const absolute = joinPath(repo.root, directory);
    if (worktree.readdir(absolute).length === 0) worktree.rmdir(absolute);
  }
}

/** Index rows describing a tree exactly, without touching the working tree. */
export function indexFromTree(repo: Repository, treeOid: string | null): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const entry of treeEntries(repo, treeOid).values()) {
    out.push({
      path: entry.path,
      stage: 0,
      mode: Number.parseInt(entry.mode, 8),
      oid: entry.oid,
      size: null,
      mtime: null,
      ino: null,
    });
  }
  return out;
}

export function isTree(entry: TreeEntry): boolean {
  return isTreeMode(entry.mode);
}
