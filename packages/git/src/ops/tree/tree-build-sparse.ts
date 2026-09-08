import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, hasErrorCode } from "../../common/errors.js";
import {
  compareTreeEntries,
  hashObject,
  MODE_TREE,
  serializeTree,
  type TreeEntry,
} from "../../common/objects.js";
import { comparePaths } from "../../common/streams.js";
import type { IndexEntry, ObjectBatch } from "../../store/index.js";
import { hasSparseSourceReceipt } from "../../store/sparse/sparse-workspace.js";
import type {
  CommitTreeSnapshotResult,
  CommitTreeSnapshotSource,
} from "../worktree/sparse-workspace.js";
import {
  basename,
  checkedBytes,
  expectedDirectoryPaths,
  parentPath,
  pathDepth,
  serializedEntryBytes,
  serializedLeafModeBytes,
  utf8Length,
  validatePathShape,
  validOid,
} from "./tree-build-common.js";

const INDEX_DIRTY = 1;
const MAX_SPARSE_TREE_PATHS = 1_000;
const MAX_SPARSE_TREE_INDEX_ROWS = MAX_SPARSE_TREE_PATHS * 4;

export interface PlannedTreeObject {
  oid: string;
  data: Uint8Array;
}

export type SparseTreeBuildPlan =
  | { available: false }
  | { available: true; tree: string; objects: PlannedTreeObject[] };

type CommitTreeSnapshot = Extract<CommitTreeSnapshotResult, { available: true }>;

function requireIndexFact(value: number | null | undefined, label: string): void {
  if (value === undefined || (value !== null && !Number.isSafeInteger(value))) {
    throw new CorruptError(`commit tree snapshot index ${label} is invalid`);
  }
}

function validateSnapshotIndexEntry(entry: IndexEntry): void {
  validatePathShape(entry.path);
  utf8Length(entry.path, "commit tree snapshot index path");
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
    bytes = checkedBytes(bytes, entryBytes, "sparse tree bytes");
  }
  return bytes;
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
    if (directory.path !== "") validatePathShape(directory.path);
    if (directory.path !== "") {
      utf8Length(directory.path, "commit tree snapshot directory path");
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
      utf8Length(entry.name, "commit tree snapshot entry name");
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
      const data = serializeTree(directory.entries);
      if (hashObject("tree", data) !== directory.oid) {
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
    const name = basename(path);
    const expected = parent.entries.find(
      (entry) => entry.name === name && (entry.mode === "40000" || entry.mode === "040000"),
    );
    if (directory.oid !== (expected?.oid ?? null)) {
      throw new CorruptError("commit tree snapshot directory ancestry is inconsistent");
    }
  }
}

/**
 * Plan a bounded tree rewrite from validated HEAD directories and exact dirty index rows.
 * No object is written until this returns a complete plan.
 */
export function planSparseTreeBuild(
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
): SparseTreeBuildPlan {
  return planSparseTreeBuildWithTrust(snapshot, baselineTreeOid, false);
}

/** Internal same-database entry; the source identity is the non-forgeable receipt. */
export function planSparseTreeBuildFromSource(
  database: SqlDatabase,
  source: CommitTreeSnapshotSource,
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
): SparseTreeBuildPlan {
  return planSparseTreeBuildWithTrust(
    snapshot,
    baselineTreeOid,
    hasSparseSourceReceipt(database, "commit-tree", source),
  );
}

function planSparseTreeBuildWithTrust(
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
  trusted: boolean,
): SparseTreeBuildPlan {
  try {
    return planSparseTreeBuildOwned(snapshot, baselineTreeOid, trusted);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

function planSparseTreeBuildOwned(
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
  trusted: boolean,
): SparseTreeBuildPlan {
  if (snapshot.baselineTreeOid !== baselineTreeOid) {
    throw new CorruptError("commit tree snapshot baseline differs from HEAD");
  }
  if (
    !Array.isArray(snapshot.dirty) ||
    !Array.isArray(snapshot.index) ||
    !Array.isArray(snapshot.directories)
  ) {
    throw new CorruptError("commit tree snapshot row collections are invalid");
  }
  let capacityExceeded = false;
  if (snapshot.dirty.length > MAX_SPARSE_TREE_PATHS) capacityExceeded = true;
  if (snapshot.index.length > MAX_SPARSE_TREE_INDEX_ROWS) capacityExceeded = true;
  if (snapshot.directories.length > MAX_SPARSE_TREE_PATHS) capacityExceeded = true;

  const dirtyByPath = new Map<string, number>();
  let previousDirty: string | null = null;
  for (const entry of snapshot.dirty) {
    if (!trusted) {
      if (typeof entry !== "object" || entry === null) {
        throw new CorruptError("commit tree snapshot dirty row is invalid");
      }
      validatePathShape(entry.path);
      utf8Length(entry.path, "commit tree snapshot dirty path");
      if (
        !Number.isSafeInteger(entry.flags) ||
        entry.flags < 1 ||
        entry.flags > 3 ||
        (previousDirty !== null && comparePaths(previousDirty, entry.path) >= 0)
      ) {
        throw new CorruptError("commit tree snapshot dirty rows are malformed or unordered");
      }
    }
    dirtyByPath.set(entry.path, entry.flags);
    previousDirty = entry.path;
  }

  const indexByPath = new Map<string, IndexEntry[]>();
  let previousIndex: IndexEntry | null = null;
  for (const entry of snapshot.index) {
    if (!trusted) {
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
    }
    const group = indexByPath.get(entry.path);
    if (group === undefined) indexByPath.set(entry.path, [entry]);
    else group.push(entry);
    previousIndex = entry;
  }

  if (snapshot.dirty.length === 0) {
    if (snapshot.index.length !== 0 || snapshot.directories.length !== 0) {
      throw new CorruptError("clean commit tree snapshot returned selected rows");
    }
    if (capacityExceeded) return { available: false };
    return unchangedSparseTreePlan(baselineTreeOid);
  }

  const expectedPaths = expectedDirectoryPaths(snapshot.dirty);
  const directories = trusted
    ? new Map(snapshot.directories.map((directory) => [directory.path, directory]))
    : validateSnapshotDirectories(snapshot, expectedPaths);
  if (!trusted) requireSnapshotAncestry(directories, baselineTreeOid);
  if (capacityExceeded) return { available: false };

  const dirtyIndexPaths: string[] = [];
  for (const entry of snapshot.dirty) {
    if ((entry.flags & INDEX_DIRTY) !== 0) dirtyIndexPaths.push(entry.path);
  }
  if (dirtyIndexPaths.length === 0) {
    return unchangedSparseTreePlan(baselineTreeOid);
  }

  const dirtyByParent = new Map<string, string[]>();
  const affectedDirectories = new Set<string>([""]);
  for (const path of dirtyIndexPaths) {
    const parent = parentPath(path);
    const siblings = dirtyByParent.get(parent);
    if (siblings === undefined) {
      dirtyByParent.set(parent, [path]);
    } else {
      siblings.push(path);
    }
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

  const recordResult = (path: string, oid: string | null): void => {
    results.set(path, oid);
    if (path === "") return;
    const parent = parentPath(path);
    const children = childrenByParent.get(parent);
    const result = { path, oid };
    if (children === undefined) {
      childrenByParent.set(parent, [result]);
    } else children.push(result);
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
      else {
        entries.set(name, { mode: MODE_TREE, name, oid: childOid });
      }
    }

    if (path !== "" && entries.size === 0) {
      recordResult(path, null);
      continue;
    }
    const treeEntries = [...entries.values()];
    const bytes = treeBytes(treeEntries);
    const data = serializeTree(treeEntries);
    if (data.length !== bytes) {
      throw new CorruptError("commit tree snapshot serialized size is inconsistent");
    }
    const oid = hashObject("tree", data);
    recordResult(path, oid);
    if (oid !== baseline.oid) {
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
