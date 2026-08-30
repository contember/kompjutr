import { describe, expect, it } from "vitest";
import { hashObject, MODE_FILE, serializeTree } from "../src/core/objects.js";
import {
  planSparseTreeBuild,
  preflightTreeBuild,
  type TreeBuildPreflightLimits,
} from "../src/core/ops/tree-build.js";
import type { CommitTreeSnapshotResult } from "../src/core/sparse-workspace.js";
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

  it("rejects unsorted, nested-file, and malformed paths", () => {
    for (const entries of [[entry("b"), entry("a")], [entry("a"), entry("a/b")], [entry("a//b")]]) {
      expect(() => preflight(entries)).toThrow();
    }

    expect(preflight([entry("x".repeat(2_201))])).toMatchObject({ leafEntries: 1 });
  });

  it("plans beyond the former 8 MiB state and 16 MiB object ceilings at exact aggregate memory", () => {
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
    const retainedBytes = 8 * 1024 * 1024 + 1;
    const snapshot = {
      available: true,
      baselineTreeOid: baseline,
      dirty: [{ path: changedPath, flags: 1 }],
      index: [{ ...entry(changedPath), oid: "2".repeat(40) }],
      directories: [{ path: "", oid: baseline, entries: treeEntries }],
      retainedBytes,
    } satisfies Extract<CommitTreeSnapshotResult, { available: true }>;

    const standalone = planSparseTreeBuild(snapshot, baseline);
    expect(standalone.available).toBe(true);
    if (!standalone.available) throw new Error("large standalone sparse plan was unavailable");
    expect(standalone.objects[0]?.data.byteLength).toBeGreaterThan(16 * 1024 * 1024);

    const measured = new MemoryCoordinator();
    const measuredOwner = measured.reserve();
    measuredOwner.set("other", retainedBytes);
    const measuredPlan = planSparseTreeBuild(snapshot, baseline, measuredOwner);
    expect(measuredPlan.available).toBe(true);
    const operationBytes = measuredOwner.highWaterBytes;
    measuredOwner.dispose();
    measured.assertIdle();

    for (const excess of [0, 1]) {
      const coordinator = new MemoryCoordinator();
      const blocker = coordinator.reserve();
      blocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + excess);
      const owner = coordinator.reserve();
      try {
        owner.set("other", retainedBytes);
        const plan = planSparseTreeBuild(snapshot, baseline, owner);
        if (excess === 0) expect(plan.available).toBe(true);
        else expect(plan).toEqual({ available: false });
      } finally {
        owner.dispose();
        blocker.dispose();
      }
      coordinator.assertIdle();
    }
  });
});
