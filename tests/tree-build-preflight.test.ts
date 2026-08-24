import { describe, expect, it } from "vitest";
import {
  MAX_TREE_BUILD_PATH_BYTES,
  preflightTreeBuild,
  type TreeBuildPreflightLimits,
} from "../src/core/ops/tree-build.js";
import type { IndexEntry } from "../src/sqlite/store.js";

const OID = "1".repeat(40);
const LIMITS: TreeBuildPreflightLimits = {
  maxLeafEntries: 10,
  maxTotalPathBytes: 1_000,
  maxTreeObjects: 10,
  maxSerializedTreeBytes: 1_000,
};

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
    expect(preflightTreeBuild([entry("a.txt"), entry("dir/b", 0o100755)], LIMITS)).toEqual({
      leafEntries: 2,
      totalPathBytes: 10,
      treeObjects: 2,
      serializedTreeBytes: 92,
      maxSingleTreeBytes: 63,
    });
  });

  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    expect(preflightTreeBuild([entry("😀/é")], LIMITS)).toEqual({
      leafEntries: 1,
      totalPathBytes: 7,
      treeObjects: 2,
      serializedTreeBytes: 61,
      maxSingleTreeBytes: 31,
    });
  });

  it("accepts exact limits and rejects each next retained unit", () => {
    const entries = [entry("a.txt"), entry("dir/b", 0o100755)];
    const exact: TreeBuildPreflightLimits = {
      maxLeafEntries: 2,
      maxTotalPathBytes: 10,
      maxTreeObjects: 2,
      maxSerializedTreeBytes: 92,
    };
    expect(preflightTreeBuild(entries, exact)).toMatchObject({
      leafEntries: 2,
      treeObjects: 2,
    });
    for (const limits of [
      { ...exact, maxLeafEntries: 1 },
      { ...exact, maxTotalPathBytes: 9 },
      { ...exact, maxTreeObjects: 1 },
      { ...exact, maxSerializedTreeBytes: 91 },
    ]) {
      expect(() => preflightTreeBuild(entries, limits)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
    }
  });

  it("counts an empty root tree while ignoring non-zero stages", () => {
    expect(
      preflightTreeBuild(
        [
          entry("conflict.txt", 0o100644, 1),
          entry("conflict.txt", 0o100644, 2),
          entry("conflict.txt", 0o100644, 3),
        ],
        LIMITS,
      ),
    ).toEqual({
      leafEntries: 0,
      totalPathBytes: 0,
      treeObjects: 1,
      serializedTreeBytes: 0,
      maxSingleTreeBytes: 0,
    });
  });

  it("rejects unsorted, nested-file, malformed, and oversized paths", () => {
    for (const entries of [
      [entry("b"), entry("a")],
      [entry("a"), entry("a/b")],
      [entry("a//b")],
      [entry("x".repeat(MAX_TREE_BUILD_PATH_BYTES + 1))],
    ]) {
      expect(() => preflightTreeBuild(entries, LIMITS)).toThrow();
    }
  });
});
