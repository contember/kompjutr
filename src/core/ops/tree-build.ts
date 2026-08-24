// Turning the index into a tree hierarchy.
//
// This is the operation Computer's client cannot survive: isomorphic-git
// materialises the whole `.git/index` and then a nested inode graph of the
// whole tree, and the isolate runs out of memory between 535 and 985
// tracked files. Here the index is rows and the build is a single
// bottom-up pass, so the only thing held live is the directory stack of
// the path currently being visited.

import type { IndexEntry, ObjectBatch } from "../../sqlite/store.js";
import { CorruptError, GitError } from "../errors.js";
import { MODE_TREE, serializeTree, type TreeEntry } from "../objects.js";
import type { Repository } from "../repository.js";
import { comparePaths } from "../streams.js";

export const MAX_TREE_BUILD_PATH_BYTES = 2_200;

export interface TreeBuildPreflightLimits {
  maxLeafEntries: number;
  maxTotalPathBytes: number;
  maxTreeObjects: number;
  maxSerializedTreeBytes: number;
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
}

interface PreflightDirectory {
  serializedBytes: number;
}

function requireLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid tree-build ${label} limit`);
  }
  return value;
}

function utf8Length(value: string, label: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new CorruptError(`${label} is not canonical UTF-16`);
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", `${label} size overflows`);
  }
  return bytes;
}

function checkedAdd(total: number, bytes: number, limit: number, label: string): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit - total) {
    throw new GitError("E2BIG", `tree build exceeds ${limit} ${label}`);
  }
  return total + bytes;
}

function serializedEntryBytes(modeBytes: number, nameBytes: number): number {
  // `<mode> <name>\0<20-byte oid>`.
  return modeBytes + nameBytes + 22;
}

function serializedLeafModeBytes(mode: number): number {
  if (mode !== 0o100644 && mode !== 0o100755 && mode !== 0o120000 && mode !== 0o160000) {
    throw new CorruptError("tree-build index mode is invalid");
  }
  return 6;
}

function validatePath(path: string): string[] {
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
    throw new CorruptError("tree-build index path is invalid");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\0")) {
      throw new CorruptError("tree-build index path is invalid");
    }
  }
  return segments;
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
  const maxLeafEntries = requireLimit(limits.maxLeafEntries, "leaf-entry");
  const maxTotalPathBytes = requireLimit(limits.maxTotalPathBytes, "path-byte");
  const maxTreeObjects = requireLimit(limits.maxTreeObjects, "tree-object");
  const maxSerializedTreeBytes = requireLimit(
    limits.maxSerializedTreeBytes,
    "serialized-tree-byte",
  );
  if (maxTreeObjects < 1) throw new GitError("E2BIG", "tree build requires its root tree");

  const stack: PreflightDirectory[] = [{ serializedBytes: 0 }];
  const open: string[] = [];
  let previousEntry: { path: string; stage: number } | null = null;
  let previousPath: string | null = null;
  let leafEntries = 0;
  let totalPathBytes = 0;
  let treeObjects = 1;
  let serializedTreeBytes = 0;
  let maxSingleTreeBytes = 0;

  const retainSerialized = (bytes: number): void => {
    serializedTreeBytes = checkedAdd(
      serializedTreeBytes,
      bytes,
      maxSerializedTreeBytes,
      "serialized tree bytes",
    );
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
    if (!Number.isSafeInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) {
      throw new CorruptError("tree-build index stage is invalid");
    }
    if (previousEntry !== null) {
      const order = comparePaths(previousEntry.path, entry.path);
      if (order > 0 || (order === 0 && previousEntry.stage >= entry.stage)) {
        throw new CorruptError("tree-build index entries are not in strict Git order");
      }
    }
    previousEntry = { path: entry.path, stage: entry.stage };
    if (entry.stage !== 0) continue;
    if (leafEntries >= maxLeafEntries) {
      throw new GitError("E2BIG", `tree build exceeds ${maxLeafEntries} leaf entries`);
    }
    const pathLength = utf8Length(entry.path, "tree-build index path");
    if (pathLength > MAX_TREE_BUILD_PATH_BYTES) {
      throw new GitError(
        "E2BIG",
        `tree-build index path exceeds ${MAX_TREE_BUILD_PATH_BYTES} UTF-8 bytes`,
      );
    }
    totalPathBytes = checkedAdd(totalPathBytes, pathLength, maxTotalPathBytes, "full-path bytes");
    if (previousPath !== null) {
      if (comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("tree-build stage-zero paths are not in strict Git order");
      }
      if (entry.path.startsWith(`${previousPath}/`)) {
        throw new CorruptError("tree-build index contains a file below another file");
      }
    }

    const segments = validatePath(entry.path);
    const depth = segments.length - 1;
    let shared = 0;
    while (shared < depth && shared < open.length && open[shared] === segments[shared]) shared++;
    closeTo(shared);
    for (let level = shared; level < depth; level++) {
      if (treeObjects >= maxTreeObjects) {
        throw new GitError("E2BIG", `tree build exceeds ${maxTreeObjects} tree objects`);
      }
      const name = segments[level];
      if (name === undefined) throw new CorruptError("tree-build directory segment is missing");
      const bytes = serializedEntryBytes(5, utf8Length(name, "tree-build directory name"));
      retainSerialized(bytes);
      const parent = stack[stack.length - 1];
      if (parent === undefined) throw new CorruptError("tree-build preflight lost its parent");
      parent.serializedBytes += bytes;
      stack.push({ serializedBytes: 0 });
      open.push(name);
      treeObjects++;
    }

    const name = segments[depth];
    if (name === undefined) throw new CorruptError("tree-build leaf name is missing");
    const leafBytes = serializedEntryBytes(
      serializedLeafModeBytes(entry.mode),
      utf8Length(name, "tree-build leaf name"),
    );
    retainSerialized(leafBytes);
    const parent = stack[stack.length - 1];
    if (parent === undefined) throw new CorruptError("tree-build preflight lost its leaf parent");
    parent.serializedBytes += leafBytes;
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
 * `RepoStore.indexScan()` yields: SQLite orders TEXT by UTF-8 bytes,
 * and a byte-ordered path list visits each directory contiguously and in
 * exactly the order git's tree rule ("a subtree sorts as `name/`") puts
 * its entries in. Re-sorting here would cost a second full-index pass for
 * nothing.
 */
export function buildTree(repo: Repository, entries: Iterable<IndexEntry>): string {
  return repo.store.writeObjects((batch) => buildTreeInBatch(batch, entries));
}

/** Build trees in a caller-owned batch so a commit can share the same flush. */
export function buildTreeInBatch(batch: ObjectBatch, entries: Iterable<IndexEntry>): string {
  const stack: OpenDirectory[] = [{ name: "", entries: [] }];
  // Segment names of the directories currently open below the root.
  const open: string[] = [];

  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    const segments = entry.path.split("/");
    const depth = segments.length - 1;

    let shared = 0;
    while (shared < depth && shared < open.length && open[shared] === segments[shared]) shared++;
    while (open.length > shared) closeTop(batch, stack, open);
    for (let level = shared; level < depth; level++) {
      stack.push({ name: segments[level]!, entries: [] });
      open.push(segments[level]!);
    }

    stack[stack.length - 1]!.entries.push({
      mode: entry.mode.toString(8),
      name: segments[depth]!,
      oid: entry.oid,
    });
  }

  while (open.length > 0) closeTop(batch, stack, open);
  return writeTree(batch, stack[0]!.entries);
}

function closeTop(batch: ObjectBatch, stack: OpenDirectory[], open: string[]): void {
  const finished = stack.pop()!;
  open.pop();
  stack[stack.length - 1]!.entries.push({
    mode: MODE_TREE,
    name: finished.name,
    oid: writeTree(batch, finished.entries),
  });
}

/** The batch hashes before flushing, and its insert ignores objects already present. */
function writeTree(batch: ObjectBatch, entries: TreeEntry[]): string {
  return batch.write("tree", serializeTree(entries));
}
