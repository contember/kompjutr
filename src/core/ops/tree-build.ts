// Turning the index into a tree hierarchy.
//
// This is the operation Computer's client cannot survive: isomorphic-git
// materialises the whole `.git/index` and then a nested inode graph of the
// whole tree, and the isolate runs out of memory between 535 and 985
// tracked files. Here the index is rows and the build is a single
// bottom-up pass, so the only thing held live is the directory stack of
// the path currently being visited.

import type { MemoryReservation } from "../../memory.js";
import { type IndexEntry, type ObjectBatch, writeObjectsOwned } from "../../sqlite/store.js";
import { CorruptError, GitError } from "../errors.js";
import {
  compareTreeEntries,
  hashObject,
  MODE_TREE,
  serializeTree,
  type TreeEntry,
} from "../objects.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import type { CommitTreeSnapshotResult } from "../sparse-workspace.js";
import { comparePaths } from "../streams.js";

export const MAX_TREE_BUILD_PATH_BYTES = 2_200;
/** Maximum entries retained in one materialized tree object. */
export const MAX_TREE_BUILD_LEAF_ENTRIES = 10_000;
export const MAX_TREE_BUILD_OBJECTS = 4_096;

const INDEX_DIRTY = 1;
const MAX_SPARSE_TREE_PATHS = 1_000;
const MAX_SPARSE_TREE_INDEX_ROWS = MAX_SPARSE_TREE_PATHS * 4;
const MAX_SPARSE_TREE_RETAINED_BYTES = 8 * 1024 * 1024;
const MAX_SPARSE_TREE_PLAN_BYTES = 16 * 1024 * 1024;

export interface TreeBuildPreflightLimits {
  maxEntriesPerTree: number;
  maxTreeObjects: number;
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

interface PlannedTreeObject {
  oid: string;
  data: Uint8Array;
}

export type SparseTreeBuildPlan =
  | { available: false }
  | { available: true; tree: string; objects: PlannedTreeObject[] };

type CommitTreeSnapshot = Extract<CommitTreeSnapshotResult, { available: true }>;

/** A directory the pass is currently inside, with the entries seen so far. */
interface OpenDirectory {
  name: string;
  entries: TreeEntry[];
  retainedBytes: number;
  serializedBytes: number;
}

interface PreflightDirectory {
  serializedBytes: number;
  entries: number;
}

const ARRAY_FIXED_BYTES = 64;
const ARRAY_SLOT_BYTES = 8;
const PREFLIGHT_FIXED_BYTES = 384;
const PREFLIGHT_DIRECTORY_BYTES = 32;
const PREFLIGHT_STATS_BYTES = 96;
const BUILD_FIXED_BYTES = 384;
const OPEN_DIRECTORY_FIXED_BYTES = 128;
const TREE_ENTRY_FIXED_BYTES = 96;
const SERIALIZE_PART_FIXED_BYTES = 64;
const SERIALIZED_OBJECT_FIXED_BYTES = 64;
const BUILD_RESULT_BYTES = 96;
const OID_RETAINED_BYTES = 48 + 40 * 2;
const MODE_RETAINED_BYTES = 48 + 6 * 2;

function checkedBytes(total: number, bytes: number, label: string): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER - total) {
    throw new GitError("E2BIG", `tree-build ${label} size overflows`);
  }
  return total + bytes;
}

function segmentAllocationBytes(path: string): number {
  let segments = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) segments++;
  }
  return ARRAY_FIXED_BYTES + segments * (ARRAY_SLOT_BYTES + 48) + path.length * 2;
}

function pathSegmentCount(path: string): number {
  let segments = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) segments++;
  }
  return segments;
}

function directoryRetainedBytes(name: string): number {
  return OPEN_DIRECTORY_FIXED_BYTES + ARRAY_FIXED_BYTES + retainedStringBytes(name);
}

function treeEntryRetainedBytes(mode: string, name: string, oid: string): number {
  return (
    TREE_ENTRY_FIXED_BYTES +
    ARRAY_SLOT_BYTES +
    retainedStringBytes(mode) +
    retainedStringBytes(name) +
    retainedStringBytes(oid)
  );
}

function serializationWorkingBytes(entries: readonly TreeEntry[], serializedBytes: number): number {
  let longestHeaderUnits = 0;
  for (const entry of entries) {
    longestHeaderUnits = Math.max(longestHeaderUnits, entry.mode.length + entry.name.length + 2);
  }
  return (
    2 * ARRAY_FIXED_BYTES +
    entries.length * (3 * ARRAY_SLOT_BYTES + 2 * SERIALIZE_PART_FIXED_BYTES) +
    serializedBytes * 2 +
    48 +
    longestHeaderUnits * 2
  );
}

function preflightRetainedBytes(
  open: readonly string[],
  previousEntryPath: string | null,
  previousPath: string | null,
): number {
  let bytes =
    PREFLIGHT_FIXED_BYTES +
    2 * ARRAY_FIXED_BYTES +
    open.length * (2 * ARRAY_SLOT_BYTES + PREFLIGHT_DIRECTORY_BYTES);
  for (const name of open) bytes = checkedBytes(bytes, retainedStringBytes(name), "memory");
  if (previousEntryPath !== null) {
    bytes = checkedBytes(bytes, retainedStringBytes(previousEntryPath), "memory");
  }
  if (previousPath !== null && previousPath !== previousEntryPath) {
    bytes = checkedBytes(bytes, retainedStringBytes(previousPath), "memory");
  }
  return bytes;
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

function validOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function requireIndexFact(value: number | null | undefined, label: string): void {
  if (value === undefined || (value !== null && !Number.isSafeInteger(value))) {
    throw new CorruptError(`commit tree snapshot index ${label} is invalid`);
  }
}

function validateSnapshotIndexEntry(entry: IndexEntry): void {
  validatePath(entry.path);
  if (utf8Length(entry.path, "commit tree snapshot index path") > MAX_TREE_BUILD_PATH_BYTES) {
    throw new GitError("E2BIG", "commit tree snapshot index path exceeds its capacity");
  }
  if (!Number.isSafeInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) {
    throw new CorruptError("commit tree snapshot index stage is invalid");
  }
  serializedLeafModeBytes(entry.mode);
  if (typeof entry.oid !== "string" || !validOid(entry.oid)) {
    throw new CorruptError("commit tree snapshot index oid is invalid");
  }
  requireIndexFact(entry.size, "size");
  requireIndexFact(entry.mtime, "mtime");
  requireIndexFact(entry.ino, "inode");
  if (entry.rev !== undefined) requireIndexFact(entry.rev, "revision");
  if (
    (entry.size !== null && entry.size < 0) ||
    (entry.ino !== null && entry.ino <= 0) ||
    (entry.rev !== null && entry.rev !== undefined && entry.rev < 0)
  ) {
    throw new CorruptError("commit tree snapshot index metadata is invalid");
  }
}

function validateTreeMode(mode: string): void {
  if (!["40000", "040000", "100644", "100755", "120000", "160000"].includes(mode)) {
    throw new CorruptError("commit tree snapshot entry mode is invalid");
  }
}

function treeBytes(entries: readonly TreeEntry[]): number {
  let bytes = 0;
  for (const entry of entries) {
    validateTreeMode(entry.mode);
    const modeBytes = entry.mode.replace(/^0+/, "").length;
    const entryBytes = serializedEntryBytes(
      modeBytes,
      utf8Length(entry.name, "commit tree snapshot entry name"),
    );
    bytes = checkedAdd(bytes, entryBytes, MAX_SPARSE_TREE_PLAN_BYTES, "sparse tree bytes");
  }
  return bytes;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function pathDepth(path: string): number {
  if (path === "") return 0;
  let depth = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) depth++;
  }
  return depth;
}

function expectedDirectoryPaths(paths: readonly string[]): string[] {
  const expected = new Set<string>([""]);
  for (const path of paths) {
    let slash = path.indexOf("/");
    while (slash >= 0) {
      expected.add(path.slice(0, slash));
      slash = path.indexOf("/", slash + 1);
    }
  }
  return [...expected].sort(comparePaths);
}

function unchangedSparseTreePlan(baselineTreeOid: string | null): SparseTreeBuildPlan {
  if (baselineTreeOid !== null) {
    return { available: true, tree: baselineTreeOid, objects: [] };
  }
  const data = new Uint8Array();
  const oid = hashObject("tree", data);
  return { available: true, tree: oid, objects: [{ oid, data }] };
}

function validateSnapshotDirectories(
  snapshot: CommitTreeSnapshot,
  expectedPaths: readonly string[],
): Map<string, CommitTreeSnapshot["directories"][number]> {
  if (snapshot.directories.length !== expectedPaths.length) {
    throw new CorruptError("commit tree snapshot directory set is incomplete");
  }
  const directories = new Map<string, CommitTreeSnapshot["directories"][number]>();
  for (let ordinal = 0; ordinal < snapshot.directories.length; ordinal++) {
    const directory = snapshot.directories[ordinal];
    const expected = expectedPaths[ordinal];
    if (
      directory === undefined ||
      typeof directory !== "object" ||
      directory === null ||
      expected === undefined ||
      directory.path !== expected
    ) {
      throw new CorruptError("commit tree snapshot directories are not in strict Git order");
    }
    if (directory.path !== "") validatePath(directory.path);
    if (
      directory.path !== "" &&
      utf8Length(directory.path, "commit tree snapshot directory path") > MAX_TREE_BUILD_PATH_BYTES
    ) {
      throw new GitError("E2BIG", "commit tree snapshot directory path exceeds its capacity");
    }
    if (directory.oid !== null && !validOid(directory.oid)) {
      throw new CorruptError("commit tree snapshot directory oid is invalid");
    }
    if (!Array.isArray(directory.entries)) {
      throw new CorruptError("commit tree snapshot directory entries are invalid");
    }
    if (directory.oid === null && directory.entries.length !== 0) {
      throw new CorruptError("commit tree snapshot missing directory has entries");
    }
    let previous: TreeEntry | null = null;
    const names = new Set<string>();
    for (const entry of directory.entries) {
      if (typeof entry !== "object" || entry === null) {
        throw new CorruptError("commit tree snapshot entry is invalid");
      }
      validateTreeMode(entry.mode);
      if (
        typeof entry.name !== "string" ||
        entry.name === "" ||
        entry.name.includes("/") ||
        entry.name.includes("\0")
      ) {
        throw new CorruptError("commit tree snapshot entry name is invalid");
      }
      if (utf8Length(entry.name, "commit tree snapshot entry name") > MAX_TREE_BUILD_PATH_BYTES) {
        throw new GitError("E2BIG", "commit tree snapshot entry name exceeds its capacity");
      }
      if (typeof entry.oid !== "string" || !validOid(entry.oid)) {
        throw new CorruptError("commit tree snapshot entry oid is invalid");
      }
      if (
        names.has(entry.name) ||
        (previous !== null && compareTreeEntries(previous, entry) >= 0)
      ) {
        throw new CorruptError("commit tree snapshot entries are not in strict Git order");
      }
      names.add(entry.name);
      previous = entry;
    }
    if (directory.oid !== null) {
      treeBytes(directory.entries);
      if (hashObject("tree", serializeTree(directory.entries)) !== directory.oid) {
        throw new CorruptError("commit tree snapshot directory differs from its oid");
      }
    }
    directories.set(directory.path, directory);
  }
  return directories;
}

function requireSnapshotAncestry(
  directories: ReadonlyMap<string, CommitTreeSnapshot["directories"][number]>,
  baselineTreeOid: string | null,
): void {
  const root = directories.get("");
  if (root === undefined || root.oid !== baselineTreeOid) {
    throw new CorruptError("commit tree snapshot root differs from HEAD");
  }
  for (const [path, directory] of directories) {
    if (path === "") continue;
    const parent = directories.get(parentPath(path));
    if (parent === undefined) {
      throw new CorruptError("commit tree snapshot directory lost its parent");
    }
    const expected = parent.entries.find(
      (entry) =>
        entry.name === basename(path) && (entry.mode === "40000" || entry.mode === "040000"),
    );
    if (directory.oid !== (expected?.oid ?? null)) {
      throw new CorruptError("commit tree snapshot directory ancestry is inconsistent");
    }
  }
}

/**
 * Plan a bounded tree rewrite from authenticated HEAD directories and exact dirty index rows.
 * No object is written until this returns a complete plan.
 */
export function planSparseTreeBuild(
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
): SparseTreeBuildPlan {
  if (snapshot.baselineTreeOid !== baselineTreeOid) {
    throw new CorruptError("commit tree snapshot baseline differs from HEAD");
  }
  if (!Number.isSafeInteger(snapshot.retainedBytes) || snapshot.retainedBytes < 0) {
    throw new CorruptError("commit tree snapshot retained size is invalid");
  }
  if (
    !Array.isArray(snapshot.dirty) ||
    !Array.isArray(snapshot.index) ||
    !Array.isArray(snapshot.directories)
  ) {
    throw new CorruptError("commit tree snapshot row collections are invalid");
  }
  let capacityExceeded = snapshot.retainedBytes > MAX_SPARSE_TREE_RETAINED_BYTES;
  if (snapshot.dirty.length > MAX_SPARSE_TREE_PATHS) capacityExceeded = true;
  if (snapshot.index.length > MAX_SPARSE_TREE_INDEX_ROWS) capacityExceeded = true;
  if (snapshot.directories.length > MAX_SPARSE_TREE_PATHS) capacityExceeded = true;

  const dirtyByPath = new Map<string, number>();
  let previousDirty: string | null = null;
  for (const entry of snapshot.dirty) {
    if (typeof entry !== "object" || entry === null) {
      throw new CorruptError("commit tree snapshot dirty row is invalid");
    }
    validatePath(entry.path);
    if (utf8Length(entry.path, "commit tree snapshot dirty path") > MAX_TREE_BUILD_PATH_BYTES) {
      throw new GitError("E2BIG", "commit tree snapshot dirty path exceeds its capacity");
    }
    if (
      !Number.isSafeInteger(entry.flags) ||
      entry.flags < 1 ||
      entry.flags > 3 ||
      (previousDirty !== null && comparePaths(previousDirty, entry.path) >= 0)
    ) {
      throw new CorruptError("commit tree snapshot dirty rows are malformed or unordered");
    }
    dirtyByPath.set(entry.path, entry.flags);
    previousDirty = entry.path;
  }

  const indexByPath = new Map<string, IndexEntry[]>();
  let previousIndex: IndexEntry | null = null;
  for (const entry of snapshot.index) {
    if (typeof entry !== "object" || entry === null) {
      throw new CorruptError("commit tree snapshot index row is invalid");
    }
    validateSnapshotIndexEntry(entry);
    if (
      !dirtyByPath.has(entry.path) ||
      (previousIndex !== null &&
        (comparePaths(previousIndex.path, entry.path) > 0 ||
          (previousIndex.path === entry.path && previousIndex.stage >= entry.stage)))
    ) {
      throw new CorruptError("commit tree snapshot index rows are incomplete or unordered");
    }
    const group = indexByPath.get(entry.path);
    if (group === undefined) indexByPath.set(entry.path, [entry]);
    else group.push(entry);
    previousIndex = entry;
  }

  if (snapshot.dirty.length === 0) {
    if (snapshot.index.length !== 0 || snapshot.directories.length !== 0) {
      throw new CorruptError("clean commit tree snapshot retained selected rows");
    }
    if (capacityExceeded) return { available: false };
    return unchangedSparseTreePlan(baselineTreeOid);
  }

  const expectedPaths = expectedDirectoryPaths(snapshot.dirty.map((entry) => entry.path));
  const directories = validateSnapshotDirectories(snapshot, expectedPaths);
  requireSnapshotAncestry(directories, baselineTreeOid);
  if (capacityExceeded) return { available: false };

  const dirtyIndexPaths = snapshot.dirty
    .filter((entry) => (entry.flags & INDEX_DIRTY) !== 0)
    .map((entry) => entry.path);
  if (dirtyIndexPaths.length === 0) {
    return unchangedSparseTreePlan(baselineTreeOid);
  }

  const dirtyByParent = new Map<string, string[]>();
  const affectedDirectories = new Set<string>([""]);
  for (const path of dirtyIndexPaths) {
    const parent = parentPath(path);
    const siblings = dirtyByParent.get(parent);
    if (siblings === undefined) dirtyByParent.set(parent, [path]);
    else siblings.push(path);
    let ancestor = parent;
    for (;;) {
      affectedDirectories.add(ancestor);
      if (ancestor === "") break;
      ancestor = parentPath(ancestor);
    }
  }

  const order = [...affectedDirectories].sort((left, right) => {
    const depth = pathDepth(right) - pathDepth(left);
    return depth === 0 ? comparePaths(left, right) : depth;
  });
  const results = new Map<string, string | null>();
  const childrenByParent = new Map<string, Array<{ path: string; oid: string | null }>>();
  const objects: PlannedTreeObject[] = [];
  let plannedBytes = 0;

  const recordResult = (path: string, oid: string | null): void => {
    results.set(path, oid);
    if (path === "") return;
    const parent = parentPath(path);
    const children = childrenByParent.get(parent);
    const result = { path, oid };
    if (children === undefined) childrenByParent.set(parent, [result]);
    else children.push(result);
  };

  for (const path of order) {
    const baseline = directories.get(path);
    if (baseline === undefined) {
      throw new CorruptError("commit tree snapshot omitted an affected directory");
    }
    const entries = new Map<string, TreeEntry>();
    for (const entry of baseline.entries) entries.set(entry.name, entry);

    for (const dirtyPath of dirtyByParent.get(path) ?? []) {
      const name = basename(dirtyPath);
      entries.delete(name);
      const stageZero = indexByPath.get(dirtyPath)?.find((entry) => entry.stage === 0);
      if (stageZero !== undefined) {
        entries.set(name, { mode: stageZero.mode.toString(8), name, oid: stageZero.oid });
      }
    }

    for (const child of childrenByParent.get(path) ?? []) {
      const childPath = child.path;
      const childOid = child.oid;
      const name = basename(childPath);
      const exactStageZero = indexByPath.get(childPath)?.find((entry) => entry.stage === 0);
      if (exactStageZero !== undefined) {
        if (childOid !== null) {
          throw new CorruptError("commit tree snapshot index contains a file above another file");
        }
        continue;
      }
      if (childOid === null) entries.delete(name);
      else entries.set(name, { mode: MODE_TREE, name, oid: childOid });
    }

    if (path !== "" && entries.size === 0) {
      recordResult(path, null);
      continue;
    }
    const treeEntries = [...entries.values()];
    const bytes = treeBytes(treeEntries);
    if (bytes > MAX_SPARSE_TREE_PLAN_BYTES - plannedBytes) return { available: false };
    const data = serializeTree(treeEntries);
    if (data.length !== bytes) {
      throw new CorruptError("commit tree snapshot serialized size is inconsistent");
    }
    const oid = hashObject("tree", data);
    recordResult(path, oid);
    if (oid !== baseline.oid) {
      plannedBytes += bytes;
      objects.push({ oid, data });
    }
  }

  const tree = results.get("");
  if (tree === undefined || tree === null) {
    throw new CorruptError("commit tree snapshot lost its root result");
  }
  return { available: true, tree, objects };
}

/** Materialize a fully preflighted sparse plan in bottom-up order. */
export function writeSparseTreePlanInBatch(batch: ObjectBatch, plan: SparseTreeBuildPlan): string {
  if (!plan.available) throw new Error("cannot write an unavailable sparse tree plan");
  for (const object of plan.objects) {
    if (batch.write("tree", object.data) !== object.oid) {
      throw new CorruptError("sparse tree plan identity changed during publication");
    }
  }
  return plan.tree;
}

function validatePath(path: string): string[] {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
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
  reservation: MemoryReservation,
): TreeBuildPreflightStats {
  const maxEntriesPerTree = requireLimit(limits.maxEntriesPerTree, "tree-entry");
  const maxTreeObjects = requireLimit(limits.maxTreeObjects, "tree-object");
  if (maxTreeObjects < 1) throw new GitError("E2BIG", "tree build requires its root tree");

  reservation.set("tree", PREFLIGHT_FIXED_BYTES + 2 * ARRAY_FIXED_BYTES);
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
    reservation.set(
      "tree",
      checkedBytes(
        preflightRetainedBytes(open, previousEntryPath, previousPath),
        retainedStringBytes(entry.path) + segmentAllocationBytes(entry.path),
        "memory",
      ),
    );
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
    if (pathLength > MAX_TREE_BUILD_PATH_BYTES) {
      throw new GitError(
        "E2BIG",
        `tree-build index path exceeds ${MAX_TREE_BUILD_PATH_BYTES} UTF-8 bytes`,
      );
    }
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
      if (treeObjects >= maxTreeObjects) {
        throw new GitError("E2BIG", `tree build exceeds ${maxTreeObjects} tree objects`);
      }
      const name = segments[level];
      if (name === undefined) throw new CorruptError("tree-build directory segment is missing");
      const bytes = serializedEntryBytes(5, utf8Length(name, "tree-build directory name"));
      serializedTreeBytes = checkedBytes(serializedTreeBytes, bytes, "serialized diagnostic");
      const parent = stack[stack.length - 1];
      if (parent === undefined) throw new CorruptError("tree-build preflight lost its parent");
      retainEntry(parent, bytes);
      stack.push({ serializedBytes: 0, entries: 0 });
      open.push(name);
      treeObjects++;
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
    reservation.set("tree", preflightRetainedBytes(open, previousEntryPath, previousPath));
  }

  closeTo(0);
  const root = stack[0];
  if (root === undefined) throw new CorruptError("tree-build preflight lost its root");
  maxSingleTreeBytes = Math.max(maxSingleTreeBytes, root.serializedBytes);
  reservation.set("tree", PREFLIGHT_STATS_BYTES);
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
  const reservation = repo.store.reserveMemory();
  try {
    return writeObjectsOwned(repo.store, reservation, (batch) =>
      buildTreeInBatch(batch, entries, reservation),
    );
  } finally {
    reservation.dispose();
  }
}

/** Build trees in a caller-owned batch so a commit can share the same flush. */
export function buildTreeInBatch(
  batch: ObjectBatch,
  entries: Iterable<IndexEntry>,
  reservation: MemoryReservation,
): string {
  let retainedBytes =
    BUILD_FIXED_BYTES + 2 * ARRAY_FIXED_BYTES + ARRAY_SLOT_BYTES + directoryRetainedBytes("");
  reservation.set("tree", retainedBytes);
  const stack: OpenDirectory[] = [
    { name: "", entries: [], retainedBytes: directoryRetainedBytes(""), serializedBytes: 0 },
  ];
  // Segment names of the directories currently open below the root.
  const open: string[] = [];
  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    if (typeof entry.path !== "string") {
      throw new CorruptError("tree-build index path is invalid");
    }
    const segmentCount = pathSegmentCount(entry.path);
    reservation.set(
      "tree",
      checkedBytes(
        retainedBytes,
        retainedStringBytes(entry.path) +
          segmentAllocationBytes(entry.path) +
          segmentCount * (OPEN_DIRECTORY_FIXED_BYTES + ARRAY_FIXED_BYTES + 2 * ARRAY_SLOT_BYTES) +
          TREE_ENTRY_FIXED_BYTES +
          ARRAY_SLOT_BYTES +
          MODE_RETAINED_BYTES +
          OID_RETAINED_BYTES,
        "memory",
      ),
    );
    const segments = validatePath(entry.path);
    const depth = segments.length - 1;

    let shared = 0;
    while (shared < depth && shared < open.length && open[shared] === segments[shared]) shared++;
    while (open.length > shared) {
      retainedBytes = closeTop(batch, stack, open, reservation, retainedBytes);
    }
    for (let level = shared; level < depth; level++) {
      const name = segments[level];
      if (name === undefined) throw new CorruptError("tree-build directory segment is missing");
      const directoryBytes = directoryRetainedBytes(name);
      retainedBytes = checkedBytes(retainedBytes, directoryBytes + 2 * ARRAY_SLOT_BYTES, "memory");
      reservation.set("tree", retainedBytes);
      stack.push({ name, entries: [], retainedBytes: directoryBytes, serializedBytes: 0 });
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
    const entryBytes = treeEntryRetainedBytes(mode, name, entry.oid);
    retainedBytes = checkedBytes(retainedBytes, entryBytes, "memory");
    reservation.set("tree", retainedBytes);
    parent.entries.push({
      mode,
      name,
      oid: entry.oid,
    });
    parent.retainedBytes = checkedBytes(parent.retainedBytes, entryBytes, "memory");
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
    retainedBytes = closeTop(batch, stack, open, reservation, retainedBytes);
  }
  const root = stack[0];
  if (root === undefined) throw new CorruptError("tree-build execution lost its root");
  return writeTree(batch, root.entries, root.serializedBytes, reservation, retainedBytes, true);
}

function closeTop(
  batch: ObjectBatch,
  stack: OpenDirectory[],
  open: string[],
  reservation: MemoryReservation,
  retainedBytes: number,
): number {
  const finished = stack[stack.length - 1];
  const parent = stack[stack.length - 2];
  if (finished === undefined || parent === undefined) {
    throw new CorruptError("tree-build execution stack is invalid");
  }
  const prospectiveBytes =
    TREE_ENTRY_FIXED_BYTES +
    ARRAY_SLOT_BYTES +
    retainedStringBytes(MODE_TREE) +
    retainedStringBytes(finished.name) +
    OID_RETAINED_BYTES;
  const oid = writeTree(
    batch,
    finished.entries,
    finished.serializedBytes,
    reservation,
    checkedBytes(retainedBytes, prospectiveBytes, "memory"),
    false,
  );
  stack.pop();
  open.pop();
  parent.entries.push({
    mode: MODE_TREE,
    name: finished.name,
    oid,
  });
  parent.retainedBytes = checkedBytes(parent.retainedBytes, prospectiveBytes, "memory");
  parent.serializedBytes = checkedBytes(
    parent.serializedBytes,
    serializedEntryBytes(5, utf8Length(finished.name, "tree-build directory name")),
    "serialized object",
  );
  const released = finished.retainedBytes + 2 * ARRAY_SLOT_BYTES;
  if (released > retainedBytes) throw new CorruptError("tree-build memory accounting underflow");
  const next = retainedBytes - released + prospectiveBytes;
  reservation.set("tree", next);
  return next;
}

/** The batch hashes before flushing, and its insert ignores objects already present. */
function writeTree(
  batch: ObjectBatch,
  entries: TreeEntry[],
  serializedBytes: number,
  reservation: MemoryReservation,
  retainedBytes: number,
  root: boolean,
): string {
  const resultBytes = root ? BUILD_RESULT_BYTES + OID_RETAINED_BYTES : 0;
  reservation.set(
    "tree",
    checkedBytes(
      retainedBytes,
      serializationWorkingBytes(entries, serializedBytes) + resultBytes,
      "memory",
    ),
  );
  const data = serializeTree(entries);
  if (data.length !== serializedBytes) {
    throw new CorruptError("tree-build serialized size is inconsistent");
  }
  reservation.set(
    "tree",
    checkedBytes(
      retainedBytes,
      SERIALIZED_OBJECT_FIXED_BYTES + serializedBytes + resultBytes,
      "memory",
    ),
  );
  const oid = batch.write("tree", data);
  if (root) reservation.set("tree", BUILD_RESULT_BYTES + retainedStringBytes(oid));
  return oid;
}
