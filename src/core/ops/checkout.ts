// Materialising a tree into the working tree, and keeping the SQL index in
// step with it.

import type { BlobIdMapping, IndexEntry, IndexSink } from "../../sqlite/store.js";
import { fromHex } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { isTreeMode, type TreeEntry } from "../objects.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import { joinSorted, joinSorted3 } from "../streams.js";
import { fileModeFor, type Worktree } from "../worktree.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import { indexMatchesStat, walkWorktreeEntriesStream } from "./worktree-io.js";

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

const CHECKOUT_WINDOW_ROWS = 1_000;
const CHECKOUT_REMOVAL_BYTES = 16 * 1024 * 1024;
const CHECKOUT_BLOB_BYTES = 3 * 1024 * 1024;
const CHECKOUT_PATH_FIXED_BYTES = 96;
const textDecoder = new TextDecoder();

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
  const removed: string[] = [];

  // Remove obsolete paths before writing replacements. This also handles a
  // directory-to-file transition without retaining the whole target tree.
  repo.store.indexApply((sink) => {
    let retainedBytes = 0;
    for (const row of joinSorted(treeStream(repo, treeOid), stageZero(repo.store.indexScan()), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      const entry = row.left;
      const existing = row.right;
      if (entry !== undefined || existing === undefined || options.prune === false) continue;
      if (!matchesPaths(existing.path, options.paths)) continue;
      retainedBytes += CHECKOUT_PATH_FIXED_BYTES + existing.path.length * 2;
      if (retainedBytes > CHECKOUT_REMOVAL_BYTES) {
        throw new GitError(
          "E2BIG",
          `checkout removal state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
        );
      }
      removed.push(existing.path);
    }
    for (let offset = 0; offset < removed.length; offset += CHECKOUT_WINDOW_ROWS) {
      flushRemovals(repo, worktree, removed.slice(offset, offset + CHECKOUT_WINDOW_ROWS), sink);
    }
  });
  if (removed.length > 0) pruneEmptyDirectories(repo, worktree, removed);

  const written: TargetEntry[] = [];
  repo.store.indexApply((sink) => {
    for (const row of joinSorted3(
      treeStream(repo, treeOid),
      stageZero(repo.store.indexScan()),
      walkWorktreeEntriesStream(worktree, repo.root, { includeIgnored: true }),
      { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
    )) {
      const entry = row.a;
      if (entry === undefined || !matchesPaths(entry.path, options.paths)) continue;
      if (entry.mode === "160000") continue; // submodules are out of scope
      const existing = row.b;
      const unchanged =
        existing !== undefined &&
        existing.oid === entry.oid &&
        existing.mode === Number.parseInt(entry.mode, 8) &&
        row.c !== undefined &&
        indexMatchesStat(existing, row.c.stat);
      if (unchanged) continue;
      written.push(entry);
      if (written.length >= CHECKOUT_WINDOW_ROWS) flushWrites(repo, worktree, written, sink);
    }
    flushWrites(repo, worktree, written, sink);
  });
}

function flushRemovals(
  repo: Repository,
  worktree: Worktree,
  removed: string[],
  sink: IndexSink,
): void {
  if (removed.length === 0) return;
  worktree.removeFiles(removed.map((path) => joinPath(repo.root, path)));
  for (const path of removed) sink.remove(path);
  sink.flush();
}

function flushWrites(
  repo: Repository,
  worktree: Worktree,
  entries: TargetEntry[],
  sink: IndexSink,
): void {
  if (entries.length === 0) return;
  let pending = entries.splice(0, entries.length);
  while (pending.length > 0) {
    const batch = repo.readBlobs(
      pending.map((entry) => entry.oid),
      {
        budgetBytes: CHECKOUT_BLOB_BYTES,
      },
    );
    const writes = [];
    const indexEntries: IndexEntry[] = [];
    const mappings: BlobIdMapping[] = [];
    const deferred: TargetEntry[] = [];
    for (const entry of pending) {
      const data = batch.blobs.get(entry.oid);
      if (data === undefined) {
        deferred.push(entry);
        continue;
      }
      const contentId = fromHex(entry.oid);
      const absolute = joinPath(repo.root, entry.path);
      writes.push(
        entry.mode === "120000"
          ? { path: absolute, target: textDecoder.decode(data), contentId }
          : { path: absolute, bytes: data, mode: fileModeFor(entry.mode), contentId },
      );
      indexEntries.push({
        path: entry.path,
        stage: 0,
        mode: Number.parseInt(entry.mode, 8),
        oid: entry.oid,
        size: data.length,
        mtime: null,
        ino: null,
      });
      mappings.push({ contentId, oid: entry.oid });
    }
    worktree.writeFiles(writes);
    repo.store.upsertBlobIds(mappings);
    for (const entry of indexEntries) {
      sink.remove(entry.path);
      sink.put(entry);
    }
    sink.flush();
    if (deferred.length === pending.length) {
      throw new CorruptError("checkout blob batch made no progress");
    }
    pending = deferred;
  }
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
    worktree.writeFiles([
      {
        path: absolute,
        target: new TextDecoder().decode(data),
        contentId: fromHex(entry.oid),
      },
    ]);
  } else {
    worktree.writeFiles([
      {
        path: absolute,
        bytes: data,
        mode: fileModeFor(entry.mode),
        contentId: fromHex(entry.oid),
      },
    ]);
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
    if (worktree.stat(absolute)?.type === "dir" && worktree.readdir(absolute).length === 0) {
      worktree.rmdir(absolute);
    }
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
