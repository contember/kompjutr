import { describe, expect, it } from "vitest";
import { hashObject, MODE_FILE, serializeTree } from "../packages/git/src/common/objects.js";
import {
  planSparseTreeBuild,
  preflightTreeBuild,
  type TreeBuildPreflightLimits,
} from "../packages/git/src/ops/tree/tree-build.js";
import type { CommitTreeSnapshotResult } from "../packages/git/src/ops/worktree/sparse-workspace.js";
import type { IndexEntry } from "../packages/git/src/store/index.js";

const OID = "1".repeat(40);
const FORMER_TREE_OBJECT_LIMIT = 4_096;
const LIMITS: TreeBuildPreflightLimits = {
  maxEntriesPerTree: 10,
};

function preflight(entries: Iterable<IndexEntry>, limits: TreeBuildPreflightLimits = LIMITS) {
  return preflightTreeBuild(entries, limits);
}

function entry(path: string, mode = 0o100644, stage = 0): IndexEntry {
  return {
    path,
    stage,
    mode,
    oid: OID,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}

describe("tree-build preflight", () => {
  it("measures leaves, full paths, directory trees, and serialized bytes", () => {
    expect(preflight([entry("a.txt"), entry("dir/b", 0o100755)])).toEqual({
      leafEntries: 2,
      totalPathBytes: 10,
      treeObjects: 2,
      serializedTreeBytes: 92,
      maxSingleTreeBytes: 63,
    });
  });

  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    expect(preflight([entry("😀/é")])).toEqual({
      leafEntries: 1,
      totalPathBytes: 7,
      treeObjects: 2,
      serializedTreeBytes: 61,
      maxSingleTreeBytes: 31,
    });
  });

  it("accepts the exact per-tree entry limit and rejects the next entry", () => {
    const entries = [entry("a.txt"), entry("dir/b", 0o100755)];
    const exact: TreeBuildPreflightLimits = {
      maxEntriesPerTree: 2,
    };
    expect(preflight(entries, exact)).toMatchObject({
      leafEntries: 2,
      treeObjects: 2,
    });
    expect(() => preflight(entries, { maxEntriesPerTree: 1 })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("bounds entries per tree object rather than cumulative leaves", () => {
    const distributed = function* (): Generator<IndexEntry> {
      for (const directory of ["a", "b"]) {
        for (let index = 0; index <= 5_000; index++) {
          yield entry(`${directory}/f${index.toString().padStart(5, "0")}`);
        }
      }
    };
    const limits: TreeBuildPreflightLimits = {
      maxEntriesPerTree: 10_000,
    };

    expect(preflight(distributed(), limits)).toMatchObject({
      leafEntries: 10_002,
      treeObjects: 3,
    });

    const flat = function* (): Generator<IndexEntry> {
      for (let index = 0; index <= limits.maxEntriesPerTree; index++) {
        yield entry(`f${index.toString().padStart(5, "0")}`);
      }
    };
    expect(() => preflight(flat(), limits)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("preflights beyond the former 4,096-tree-object boundary", () => {
    const entries = function* (): Generator<IndexEntry> {
      for (let index = 0; index < FORMER_TREE_OBJECT_LIMIT; index++) {
        const ordinal = index.toString().padStart(4, "0");
        yield entry(`d${ordinal}/f${ordinal}`);
      }
    };

    expect(preflight(entries(), { maxEntriesPerTree: FORMER_TREE_OBJECT_LIMIT })).toMatchObject({
      leafEntries: FORMER_TREE_OBJECT_LIMIT,
      treeObjects: FORMER_TREE_OBJECT_LIMIT + 1,
    });
  });

  it("counts an empty root tree while ignoring non-zero stages", () => {
    expect(
      preflight([
        entry("conflict.txt", 0o100644, 1),
        entry("conflict.txt", 0o100644, 2),
        entry("conflict.txt", 0o100644, 3),
      ]),
    ).toEqual({
      leafEntries: 0,
      totalPathBytes: 0,
      treeObjects: 1,
      serializedTreeBytes: 0,
      maxSingleTreeBytes: 0,
    });
  });

  it("keeps cumulative path and serialization bytes as diagnostics", () => {
    const suffix = "x".repeat(2_100);
    const entries = function* (): Generator<IndexEntry> {
      for (let directory = 0; directory < 4_000; directory++) {
        const name = `d${directory.toString().padStart(4, "0")}`;
        yield entry(`${name}/a-${suffix}`);
        yield entry(`${name}/b-${suffix}`);
      }
    };

    const stats = preflight(entries(), { maxEntriesPerTree: 8_000 });
    expect(stats.totalPathBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(stats.serializedTreeBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(stats.maxSingleTreeBytes).toBeLessThan(1024 * 1024);
  });

  it("rejects unsorted, nested-file, and malformed paths", () => {
    for (const entries of [[entry("b"), entry("a")], [entry("a"), entry("a/b")], [entry("a//b")]]) {
      expect(() => preflight(entries)).toThrow();
    }

    expect(preflight([entry("x".repeat(2_201))])).toMatchObject({ leafEntries: 1 });
  });

  it("plans beyond the former 8 MiB state and 16 MiB object ceilings", () => {
    const treeEntries = Array.from({ length: 8_192 }, (_, index) => ({
      mode: MODE_FILE,
      name: `p${index.toString().padStart(4, "0")}${"ࠀ".repeat(682)}`,
      oid: OID,
    }));
    const baselineData = serializeTree(treeEntries);
    expect(baselineData.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    const baseline = hashObject("tree", baselineData);
    const changedPath = treeEntries[0]?.name;
    if (changedPath === undefined) throw new Error("large sparse plan fixture is empty");
    const snapshot = {
      available: true,
      baselineTreeOid: baseline,
      dirty: [{ path: changedPath, flags: 1 }],
      index: [{ ...entry(changedPath), oid: "2".repeat(40) }],
      directories: [{ path: "", oid: baseline, entries: treeEntries }],
    } satisfies Extract<CommitTreeSnapshotResult, { available: true }>;

    const standalone = planSparseTreeBuild(snapshot, baseline);
    expect(standalone.available).toBe(true);
    if (!standalone.available) throw new Error("large standalone sparse plan was unavailable");
    expect(standalone.objects[0]?.data.byteLength).toBeGreaterThan(16 * 1024 * 1024);
  });
});
