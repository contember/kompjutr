// Turning the index into a tree hierarchy with one bottom-up pass.

import { CorruptError, GitError } from "../common/errors.js";
import { MODE_TREE, serializeTree, type TreeEntry } from "../common/objects.js";
import { comparePaths } from "../common/streams.js";
import type { IndexEntry, ObjectBatch } from "../store/index.js";
import { writeObjectsOwned } from "../store/shared.js";
import type { Repository } from "./repository.js";
import {
  checkedBytes,
  requireLimit,
  serializedEntryBytes,
  serializedLeafModeBytes,
  utf8Length,
  validatePath,
  validOid,
} from "./tree-build-common.js";

/** Maximum entries retained in one materialized tree object. */
export const MAX_TREE_BUILD_LEAF_ENTRIES = 10_000;

export interface TreeBuildPreflightLimits {
  maxEntriesPerTree: number;
}

export interface TreeBuildPreflightStats {
  leafEntries: number;
  totalPathBytes: number;
  /** Includes the root tree, including when the index is empty. */
  treeObjects: number;
  /** Sum of the raw serialized bytes of every tree object. */
  serializedTreeBytes: number;
  maxSingleTreeBytes: number;
}

/** A directory the pass is currently inside, with the entries seen so far. */
interface OpenDirectory {
  name: string;
  entries: TreeEntry[];
  serializedBytes: number;
}

interface PreflightDirectory {
  serializedBytes: number;
  entries: number;
}

/**
 * Measure one sorted stage-zero index before tree construction allocates directory entries.
 *
 * The iterable is consumed once. Reopen the index scan for `buildTreeInBatch` after this
 * succeeds.
 */
export function preflightTreeBuild(
  entries: Iterable<IndexEntry>,
  limits: TreeBuildPreflightLimits,
): TreeBuildPreflightStats {
  const maxEntriesPerTree = requireLimit(limits.maxEntriesPerTree, "tree-entry");

  const stack: PreflightDirectory[] = [{ serializedBytes: 0, entries: 0 }];
  const open: string[] = [];
  let previousEntryPath: string | null = null;
  let previousEntryStage: number | null = null;
  let previousPath: string | null = null;
  let leafEntries = 0;
  let totalPathBytes = 0;
  let treeObjects = 1;
  let serializedTreeBytes = 0;
  let maxSingleTreeBytes = 0;

  const retainEntry = (directory: PreflightDirectory, bytes: number): void => {
    if (directory.entries >= maxEntriesPerTree) {
      throw new GitError(
        "E2BIG",
        `tree build exceeds ${maxEntriesPerTree} entries in one tree object`,
      );
    }
    directory.entries++;
    directory.serializedBytes += bytes;
  };

  const closeTo = (depth: number): void => {
    while (open.length > depth) {
      const finished = stack.pop();
      if (finished === undefined) throw new CorruptError("tree-build preflight stack is empty");
      maxSingleTreeBytes = Math.max(maxSingleTreeBytes, finished.serializedBytes);
      open.pop();
    }
  };

  for (const entry of entries) {
    if (typeof entry.path !== "string") {
      throw new CorruptError("tree-build index path is invalid");
    }
    if (!Number.isSafeInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) {
      throw new CorruptError("tree-build index stage is invalid");
    }
    if (previousEntryPath !== null && previousEntryStage !== null) {
      const order = comparePaths(previousEntryPath, entry.path);
      if (order > 0 || (order === 0 && previousEntryStage >= entry.stage)) {
        throw new CorruptError("tree-build index entries are not in strict Git order");
      }
    }
    previousEntryPath = entry.path;
    previousEntryStage = entry.stage;
    if (entry.stage !== 0) continue;
    const pathLength = utf8Length(entry.path, "tree-build index path");
    totalPathBytes = checkedBytes(totalPathBytes, pathLength, "full-path diagnostic");
    if (previousPath !== null) {
      if (comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("tree-build stage-zero paths are not in strict Git order");
      }
      if (entry.path.startsWith(`${previousPath}/`)) {
        throw new CorruptError("tree-build index contains a file below another file");
      }
    }
    if (!validOid(entry.oid)) throw new CorruptError("tree-build index oid is invalid");

    const segments = validatePath(entry.path);
    const depth = segments.length - 1;
    let shared = 0;
    while (shared < depth && shared < open.length && open[shared] === segments[shared]) shared++;
    closeTo(shared);
    for (let level = shared; level < depth; level++) {
      const name = segments[level];
      if (name === undefined) throw new CorruptError("tree-build directory segment is missing");
      const bytes = serializedEntryBytes(5, utf8Length(name, "tree-build directory name"));
      serializedTreeBytes = checkedBytes(serializedTreeBytes, bytes, "serialized diagnostic");
      const parent = stack[stack.length - 1];
      if (parent === undefined) throw new CorruptError("tree-build preflight lost its parent");
      retainEntry(parent, bytes);
      stack.push({ serializedBytes: 0, entries: 0 });
      open.push(name);
      treeObjects = checkedBytes(treeObjects, 1, "tree-object diagnostic");
    }

    const name = segments[depth];
    if (name === undefined) throw new CorruptError("tree-build leaf name is missing");
    const leafBytes = serializedEntryBytes(
      serializedLeafModeBytes(entry.mode),
      utf8Length(name, "tree-build leaf name"),
    );
    serializedTreeBytes = checkedBytes(serializedTreeBytes, leafBytes, "serialized diagnostic");
    const parent = stack[stack.length - 1];
    if (parent === undefined) throw new CorruptError("tree-build preflight lost its leaf parent");
    retainEntry(parent, leafBytes);
    leafEntries++;
    previousPath = entry.path;
  }

  closeTo(0);
  const root = stack[0];
  if (root === undefined) throw new CorruptError("tree-build preflight lost its root");
  maxSingleTreeBytes = Math.max(maxSingleTreeBytes, root.serializedBytes);
  return {
    leafEntries,
    totalPathBytes,
    treeObjects,
    serializedTreeBytes,
    maxSingleTreeBytes,
  };
}

/**
 * Write every tree the stage-0 index describes and return the root's oid.
 *
 * `entries` must be in git's byte order over the full path, which is what
 * `CheckoutStore.indexScan()` yields: SQLite orders TEXT by UTF-8 bytes,
 * and a byte-ordered path list visits each directory contiguously and in
 * exactly the order git's tree rule ("a subtree sorts as `name/`") puts
 * its entries in. Re-sorting here would cost a second full-index pass for
 * nothing.
 */
export function buildTree(repo: Repository, entries: Iterable<IndexEntry>): string {
  return writeObjectsOwned(repo.store, (batch) => buildTreeInBatch(batch, entries));
}

/** Build trees in a caller-owned batch so a commit can share the same flush. */
export function buildTreeInBatch(batch: ObjectBatch, entries: Iterable<IndexEntry>): string {
  const stack: OpenDirectory[] = [{ name: "", entries: [], serializedBytes: 0 }];
  // Segment names of the directories currently open below the root.
  const open: string[] = [];
  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    if (typeof entry.path !== "string") {
      throw new CorruptError("tree-build index path is invalid");
    }
    const segments = validatePath(entry.path);
    const depth = segments.length - 1;

    let shared = 0;
    while (shared < depth && shared < open.length && open[shared] === segments[shared]) shared++;
    while (open.length > shared) {
      closeTop(batch, stack, open);
    }
    for (let level = shared; level < depth; level++) {
      const name = segments[level];
      if (name === undefined) throw new CorruptError("tree-build directory segment is missing");
      stack.push({ name, entries: [], serializedBytes: 0 });
      open.push(name);
    }

    const parent = stack[stack.length - 1];
    const name = segments[depth];
    if (parent === undefined || name === undefined) {
      throw new CorruptError("tree-build execution lost its leaf parent");
    }
    serializedLeafModeBytes(entry.mode);
    if (!validOid(entry.oid)) throw new CorruptError("tree-build index oid is invalid");
    const mode = entry.mode.toString(8);
    parent.entries.push({
      mode,
      name,
      oid: entry.oid,
    });
    parent.serializedBytes = checkedBytes(
      parent.serializedBytes,
      serializedEntryBytes(
        serializedLeafModeBytes(entry.mode),
        utf8Length(name, "tree-build entry name"),
      ),
      "serialized object",
    );
  }

  while (open.length > 0) {
    closeTop(batch, stack, open);
  }
  const root = stack[0];
  if (root === undefined) throw new CorruptError("tree-build execution lost its root");
  return writeTree(batch, root.entries, root.serializedBytes);
}

function closeTop(batch: ObjectBatch, stack: OpenDirectory[], open: string[]): void {
  const finished = stack[stack.length - 1];
  const parent = stack[stack.length - 2];
  if (finished === undefined || parent === undefined) {
    throw new CorruptError("tree-build execution stack is invalid");
  }
  const oid = writeTree(batch, finished.entries, finished.serializedBytes);
  stack.pop();
  open.pop();
  parent.entries.push({
    mode: MODE_TREE,
    name: finished.name,
    oid,
  });
  parent.serializedBytes = checkedBytes(
    parent.serializedBytes,
    serializedEntryBytes(5, utf8Length(finished.name, "tree-build directory name")),
    "serialized object",
  );
}

/** The batch hashes before flushing, and its insert ignores objects already present. */
function writeTree(batch: ObjectBatch, entries: TreeEntry[], serializedBytes: number): string {
  const data = serializeTree(entries);
  if (data.length !== serializedBytes) {
    throw new CorruptError("tree-build serialized size is inconsistent");
  }
  return batch.write("tree", data);
}
