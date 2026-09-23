import { CorruptError, hasErrorCode } from "../../common/errors.js";
import { hashObject, MODE_TREE, serializeTree, type TreeEntry } from "../../common/objects.js";
import { comparePaths } from "../../common/streams.js";
import type { CommitTreeSnapshotResult } from "../../store/core/contracts.js";
import type { IndexEntry, ObjectBatch } from "../../store/index.js";
import {
  basename,
  checkedBytes,
  parentPath,
  pathDepth,
  serializedEntryBytes,
  utf8Length,
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

/**
 * Plan a bounded tree rewrite from the stored HEAD directories and exact dirty
 * index rows. No object is written until this returns a complete plan.
 */
export function planSparseTreeBuild(
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
): SparseTreeBuildPlan {
  try {
    return planSparseTreeBuildOwned(snapshot, baselineTreeOid);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return { available: false };
    throw error;
  }
}

function planSparseTreeBuildOwned(
  snapshot: CommitTreeSnapshot,
  baselineTreeOid: string | null,
): SparseTreeBuildPlan {
  if (snapshot.baselineTreeOid !== baselineTreeOid) {
    throw new CorruptError("commit tree snapshot baseline differs from HEAD");
  }
  if (
    snapshot.dirty.length > MAX_SPARSE_TREE_PATHS ||
    snapshot.index.length > MAX_SPARSE_TREE_INDEX_ROWS ||
    snapshot.directories.length > MAX_SPARSE_TREE_PATHS
  ) {
    return { available: false };
  }

  const indexByPath = new Map<string, IndexEntry[]>();
  for (const entry of snapshot.index) {
    const group = indexByPath.get(entry.path);
    if (group === undefined) indexByPath.set(entry.path, [entry]);
    else group.push(entry);
  }
  const directories = new Map(snapshot.directories.map((directory) => [directory.path, directory]));

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
