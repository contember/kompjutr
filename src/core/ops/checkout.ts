// Materialising a tree into the working tree, and keeping the SQL index in
// step with it.

import type { IndexEntry } from "../../sqlite/store.js";
import { isTreeMode, type TreeEntry } from "../objects.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import { joinSorted } from "../streams.js";
import { fileModeFor, type Worktree } from "../worktree.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";

export type { TargetEntry } from "./tree-stream.js";

/**
 * Every blob, symlink and gitlink under a tree, keyed by repo-relative path.
 * O(tree). `treeStream` is the bounded form; this stays for the callers that
 * genuinely need random access.
 */
export function treeEntries(repo: Repository, treeOid: string | null): Map<string, TargetEntry> {
  const out = new Map<string, TargetEntry>();
  for (const entry of treeStream(repo, treeOid)) out.set(entry.path, entry);
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
  // Target and index are both path-ordered, so one merge answers "what does
  // this path look like on each side" without either existing as a map.
  const removed: string[] = [];
  repo.store.indexApply((sink) => {
    for (const row of joinSorted(treeStream(repo, treeOid), stageZero(repo.store.indexScan()), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      const entry = row.left;
      const existing = row.right;

      if (entry === undefined) {
        if (existing === undefined || options.prune === false) continue;
        if (!matchesPaths(existing.path, options.paths)) continue;
        worktree.unlink(joinPath(repo.root, existing.path));
        removed.push(existing.path);
        sink.remove(existing.path);
        continue;
      }

      if (!matchesPaths(entry.path, options.paths)) continue;
      if (entry.mode === "160000") continue; // submodules are out of scope
      const stat = worktree.stat(joinPath(repo.root, entry.path));
      const unchanged =
        existing !== undefined &&
        existing.oid === entry.oid &&
        existing.mode === Number.parseInt(entry.mode, 8) &&
        stat !== null &&
        stat.size === existing.size &&
        stat.mtime === existing.mtime;
      if (unchanged) continue;
      sink.put(writeEntry(repo, worktree, entry));
    }
  });

  if (removed.length > 0) pruneEmptyDirectories(repo, worktree, removed);
}

/** Conflict stages are not what a checkout replaces, and never were. */
export function* stageZero(entries: Iterable<IndexEntry>): Generator<IndexEntry> {
  for (const entry of entries) {
    if (entry.stage === 0) yield entry;
  }
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
export function* indexFromTree(repo: Repository, treeOid: string | null): Generator<IndexEntry> {
  for (const entry of treeStream(repo, treeOid)) {
    yield {
      path: entry.path,
      stage: 0,
      mode: Number.parseInt(entry.mode, 8),
      oid: entry.oid,
      size: null,
      mtime: null,
      ino: null,
    };
  }
}

export function isTree(entry: TreeEntry): boolean {
  return isTreeMode(entry.mode);
}
