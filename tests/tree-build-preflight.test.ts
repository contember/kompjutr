import { describe, expect, it } from "vitest";
import {
  MAX_TREE_BUILD_PATH_BYTES,
  preflightTreeBuild,
  type TreeBuildPreflightLimits,
} from "../src/core/ops/tree-build.js";
import { MAX_OPERATION_MEMORY_BYTES, MemoryCoordinator } from "../src/memory.js";
import type { IndexEntry } from "../src/sqlite/store.js";

const OID = "1".repeat(40);
const LIMITS: TreeBuildPreflightLimits = {
  maxEntriesPerTree: 10,
  maxTreeObjects: 10,
};

function preflight(entries: Iterable<IndexEntry>, limits: TreeBuildPreflightLimits = LIMITS) {
  const reservation = new MemoryCoordinator().reserve();
  try {
    return preflightTreeBuild(entries, limits, reservation);
  } finally {
    reservation.dispose();
  }
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

  it("accepts exact structural limits and rejects each next unit", () => {
    const entries = [entry("a.txt"), entry("dir/b", 0o100755)];
    const exact: TreeBuildPreflightLimits = {
      maxEntriesPerTree: 2,
      maxTreeObjects: 2,
    };
    expect(preflight(entries, exact)).toMatchObject({
      leafEntries: 2,
      treeObjects: 2,
    });
    for (const limits of [
      { ...exact, maxEntriesPerTree: 1 },
      { ...exact, maxTreeObjects: 1 },
    ]) {
      expect(() => preflight(entries, limits)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
    }
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
      maxTreeObjects: 3,
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

    const stats = preflight(entries(), { maxEntriesPerTree: 8_000, maxTreeObjects: 4_001 });
    expect(stats.totalPathBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(stats.serializedTreeBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(stats.maxSingleTreeBytes).toBeLessThan(1024 * 1024);
  });

  it("composes preflight state at the exact shared memory ceiling and releases it", () => {
    const rows = [entry("deep/path/to/file.txt")];
    const measured = new MemoryCoordinator();
    const measuredReservation = measured.reserve();
    preflightTreeBuild(rows, LIMITS, measuredReservation);
    const operationBytes = measuredReservation.highWaterBytes;
    measuredReservation.dispose();
    measured.assertIdle();

    const exact = new MemoryCoordinator();
    const exactBlocker = exact.reserve();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactReservation = exact.reserve();
    try {
      expect(preflightTreeBuild(rows, LIMITS, exactReservation)).toMatchObject({ leafEntries: 1 });
      expect(exact.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactReservation.dispose();
      exactBlocker.dispose();
    }
    exact.assertIdle();

    const excess = new MemoryCoordinator();
    const excessBlocker = excess.reserve();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const excessReservation = excess.reserve();
    try {
      expect(() => preflightTreeBuild(rows, LIMITS, excessReservation)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
    } finally {
      excessReservation.dispose();
      excessBlocker.dispose();
    }
    excess.assertIdle();
  });

  it("rejects unsorted, nested-file, malformed, and oversized paths", () => {
    for (const entries of [
      [entry("b"), entry("a")],
      [entry("a"), entry("a/b")],
      [entry("a//b")],
      [entry("x".repeat(MAX_TREE_BUILD_PATH_BYTES + 1))],
    ]) {
      expect(() => preflight(entries)).toThrow();
    }
  });
});
