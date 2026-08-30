import { describe, expect, it } from "vitest";

import { concat } from "../src/core/bytes.js";
import { DEFAULT_TEXT_MERGE_LIMITS } from "../src/core/diff/xmerge.js";
import { hasErrorCode } from "../src/core/errors.js";
import { hashObject, MODE_FILE, serializeTree } from "../src/core/objects.js";
import {
  type IntegrationEntry,
  type IntegrationPlan,
  planIntegration,
} from "../src/core/ops/integration.js";
import {
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  requireCleanIntegrationWorktree,
  requireSafeIntegrationWorktree,
  reserveIntegrationPlan,
} from "../src/core/ops/integration-worktree.js";
import type { ProjectedMergeEntry } from "../src/core/ops/merge-projection.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { Repository } from "../src/core/repository.js";
import { comparePaths } from "../src/core/streams.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import {
  type CheckoutStore,
  PACK_BLOB_BATCH_TARGET_BYTES,
  SqliteGitDatabase,
} from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";
import { makeRepo } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

interface FileValue {
  content: string | Uint8Array;
  mode?: string;
}

interface WrittenTree {
  tree: string;
  files: Map<string, { mode: string; oid: string }>;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function writeTree(store: CheckoutStore, files: Record<string, FileValue>): WrittenTree {
  const identities = new Map<string, { mode: string; oid: string }>();
  const entries = Object.entries(files)
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([name, value]) => {
      const mode = value.mode ?? MODE_FILE;
      const oid = store.write("blob", bytes(value.content));
      identities.set(name, { mode, oid });
      return { mode, name, oid };
    });
  return { tree: store.write("tree", serializeTree(entries)), files: identities };
}

function writeIdentityTree(
  store: CheckoutStore,
  files: Record<string, { mode: string; oid: string }>,
): WrittenTree {
  const entries = Object.entries(files)
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([name, identity]) => ({ ...identity, name }));
  return {
    tree: store.write("tree", serializeTree(entries)),
    files: new Map(entries.map(({ mode, name, oid }) => [name, { mode, oid }])),
  };
}

function find(entries: readonly IntegrationEntry[], path: string): IntegrationEntry {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`missing integration entry for ${path}`);
  return entry;
}

function assertCoordinatorIdle(store: CheckoutStore): void {
  const probe = store.reserveMemory();
  try {
    probe.set("other", MAX_OPERATION_MEMORY_BYTES);
  } finally {
    probe.dispose();
  }
}

function trackWorktreeFile(
  workspace: ReturnType<typeof makeRepo>,
  path: string,
  content: Uint8Array,
): void {
  workspace.worktree.writeFile(`/${path}`, content);
  workspace.repo.checkout.indexPut({
    path,
    stage: 0,
    mode: 0o100644,
    oid: hashObject("blob", content),
    size: null,
    mtime: null,
    ino: null,
  });
}

function trackStorageIterators(workspace: ReturnType<typeof makeRepo>): {
  active: () => number;
  closed: () => number;
} {
  const originalIterate = workspace.storage.iterate.bind(workspace.storage);
  let active = 0;
  let closed = 0;
  workspace.storage.iterate = function* (query: string, ...bindings: unknown[]) {
    active++;
    try {
      yield* originalIterate(query, ...bindings);
    } finally {
      active--;
      closed++;
    }
  };
  return { active: () => active, closed: () => closed };
}

describe("bounded three-way integration plan", () => {
  it("charges the exact planning peak against concurrent operation state", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "base\n" } });
    const incoming = writeTree(store, {});
    const repo = new Repository(store);
    const measured = planIntegration(repo, {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
    });
    const peak = measured.memoryHighWaterBytes;
    measured.release();

    const exact = store.reserveMemory();
    exact.set("other", MAX_OPERATION_MEMORY_BYTES - peak);
    try {
      const plan = planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        reservation: exact,
      });
      expect(exact.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES - peak + plan.retainedBytes);
      plan.release();
      expect(exact.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES - peak);
    } finally {
      exact.dispose();
    }

    const excess = store.reserveMemory();
    excess.set("other", MAX_OPERATION_MEMORY_BYTES - peak + 1);
    try {
      expect(() =>
        planIntegration(repo, {
          baseTreeOid: base.tree,
          currentTreeOid: current.tree,
          incomingTreeOid: incoming.tree,
          reservation: excess,
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(excess.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES - peak + 1);
    } finally {
      excess.dispose();
    }
    assertCoordinatorIdle(store);
  });

  it("coordinates retained caller state through planning and maximum rebase execution reserve", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const tree = writeTree(store, { file: { content: "same\n" } });
    const repo = new Repository(store);
    const journal = store.reserveMemory();
    journal.set("other", 4 * 1024 * 1024);
    try {
      const plan = planIntegration(repo, {
        baseTreeOid: tree.tree,
        currentTreeOid: tree.tree,
        incomingTreeOid: tree.tree,
        reservation: journal,
      });
      expect(journal.currentBytes).toBe(4 * 1024 * 1024 + plan.retainedBytes);
      expect(plan.memoryHighWaterBytes).toBeGreaterThanOrEqual(plan.retainedBytes);
      const execution = reserveIntegrationPlan(repo, plan, 8 * 1024 * 1024);
      expect(journal.currentBytes).toBe(4 * 1024 * 1024 + plan.retainedBytes + 8 * 1024 * 1024);
      execution.dispose();
      plan.release();
      expect(journal.currentBytes).toBe(4 * 1024 * 1024);
    } finally {
      journal.dispose();
    }
    assertCoordinatorIdle(store);
  });

  it("admits an exact projection vector and rejects one excess byte before projecting", () => {
    const workspace = makeRepo("/");
    const entry: IntegrationEntry = {
      kind: "clean",
      path: "a",
      before: null,
      result: null,
      content: null,
    };
    const projectionAdmissionBytes = 64 + 512 + 2 + 2;
    const projectedAccesses = (availableBytes: number): number => {
      let accesses = 0;
      const plan: IntegrationPlan = {
        get entries() {
          accesses++;
          return [entry];
        },
        sourceRows: 1,
        retainedBytes: 0,
        memoryHighWaterBytes: 0,
      };
      const blocker = workspace.repo.store.reserveMemory();
      blocker.set("other", MAX_OPERATION_MEMORY_BYTES - availableBytes);
      try {
        expect(() =>
          projectIntegrationWithCollisions(
            workspace.repo,
            workspace.worktree,
            null,
            null,
            plan,
            "HEAD",
            "topic",
          ),
        ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      } finally {
        blocker.dispose();
      }
      return accesses;
    };

    const exactAccesses = projectedAccesses(projectionAdmissionBytes);
    const excessAccesses = projectedAccesses(projectionAdmissionBytes - 1);
    expect(exactAccesses).toBeGreaterThan(excessAccesses);
    expect(excessAccesses).toBe(3);
    workspace.repo.store.memory.assertIdle();
  });

  it("transfers the projected result without additive ownership", () => {
    const workspace = makeRepo("/");
    const entry: IntegrationEntry = {
      kind: "clean",
      path: "a",
      before: null,
      result: null,
      content: null,
    };
    const retainedBytes = 64 + 512 + 2 + 2;
    const plan: IntegrationPlan = {
      entries: [entry],
      sourceRows: 1,
      retainedBytes: 0,
      memoryHighWaterBytes: 0,
    };
    const owner = workspace.repo.store.reserveMemory();
    const projected = projectIntegrationWithCollisions(
      workspace.repo,
      workspace.worktree,
      null,
      null,
      plan,
      "HEAD",
      "topic",
      undefined,
      "merge",
      owner,
    );
    expect(projected).toHaveLength(1);
    expect(owner.currentBytes).toBe(retainedBytes);
    const projectionPeak = retainedBytes * 2 + 3 * 128;
    expect(owner.highWaterBytes).toBe(projectionPeak);
    owner.dispose();

    const exact = workspace.repo.store.reserveMemory();
    exact.set("other", MAX_OPERATION_MEMORY_BYTES - projectionPeak);
    expect(
      projectIntegrationWithCollisions(
        workspace.repo,
        workspace.worktree,
        null,
        null,
        plan,
        "HEAD",
        "topic",
        undefined,
        "merge",
        exact,
      ),
    ).toHaveLength(1);
    exact.dispose();

    const excess = workspace.repo.store.reserveMemory();
    excess.set("other", MAX_OPERATION_MEMORY_BYTES - projectionPeak + 1);
    expect(() =>
      projectIntegrationWithCollisions(
        workspace.repo,
        workspace.worktree,
        null,
        null,
        plan,
        "HEAD",
        "topic",
        undefined,
        "merge",
        excess,
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    excess.dispose();
    workspace.repo.store.memory.assertIdle();
  });

  it("admits touched shapes with duplicate ancestors at the exact aggregate boundary", () => {
    const workspace = makeRepo("/");
    const projected: ProjectedMergeEntry[] = [
      {
        path: "dir/sub/file~HEAD",
        logicalPath: "dir/sub/file",
        purpose: "current-relocation",
        stageZero: null,
        stages: null,
        worktree: null,
        content: null,
      },
      {
        path: "dir/sub/file~topic",
        logicalPath: "dir/sub/file",
        purpose: "incoming-relocation",
        stageZero: null,
        stages: null,
        worktree: null,
        content: null,
      },
    ];
    const measured = workspace.repo.store.reserveMemory();
    expect(projectedTouchedShape(projected, measured).map((entry) => entry.path)).toEqual([
      "dir",
      "dir/sub",
      "dir/sub/file",
      "dir/sub/file~HEAD",
      "dir/sub/file~topic",
    ]);
    expect(measured.currentBytes).toBe(924);
    const peak = measured.highWaterBytes;
    expect(peak).toBeGreaterThan(measured.currentBytes);
    measured.dispose();

    const exact = workspace.repo.store.reserveMemory();
    exact.set("other", MAX_OPERATION_MEMORY_BYTES - peak);
    const exactShape = exact.scope();
    expect(projectedTouchedShape(projected, exactShape)).toHaveLength(5);
    exactShape.dispose();
    exact.dispose();

    const excess = workspace.repo.store.reserveMemory();
    excess.set("other", MAX_OPERATION_MEMORY_BYTES - peak + 1);
    const excessShape = excess.scope();
    expect(() => projectedTouchedShape(projected, excessShape)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    excessShape.dispose();
    excess.dispose();
    workspace.repo.store.memory.assertIdle();
  });

  it("admits the exact guard path vector and rejects one excess byte before the guard scan", () => {
    const workspace = makeRepo("/");
    let pathReads = 0;
    const entries = [
      {
        get path(): string {
          pathReads++;
          return "guarded.txt";
        },
      },
    ];
    const pathVectorBytes = 128 + 8;
    const exact = workspace.repo.store.reserveMemory();
    exact.set("other", MAX_OPERATION_MEMORY_BYTES - pathVectorBytes);
    expect(() =>
      requireSafeIntegrationWorktree(
        workspace.repo,
        workspace.worktree,
        null,
        entries,
        "merge",
        undefined,
        exact,
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(pathReads).toBe(1);
    exact.dispose();

    pathReads = 0;
    workspace.storage.resetCounters();
    const excess = workspace.repo.store.reserveMemory();
    excess.set("other", MAX_OPERATION_MEMORY_BYTES - pathVectorBytes + 1);
    expect(() =>
      requireSafeIntegrationWorktree(
        workspace.repo,
        workspace.worktree,
        null,
        entries,
        "merge",
        undefined,
        excess,
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(pathReads).toBe(0);
    expect(workspace.storage.statementCount).toBe(0);
    excess.dispose();
    workspace.repo.store.memory.assertIdle();
  });

  it("streams guard hashing beyond the former cumulative byte and range thresholds", () => {
    const workspace = makeRepo("/");
    const content = new Uint8Array(32 * 1024 * 1024 + 1).fill(0x69);
    trackWorktreeFile(workspace, "large.bin", content);
    const worktree = new CountingWorktree(workspace.worktree);

    requireCleanIntegrationWorktree(workspace.repo, worktree, "merge");

    expect(worktree.rangeReads).toBe(513);
    expect(workspace.repo.store.memory.totalBytes).toBe(0);
  });

  it("finishes more than ten progressing guard hash batches", () => {
    const workspace = makeRepo("/");
    for (let ordinal = 0; ordinal < 11; ordinal++) {
      trackWorktreeFile(
        workspace,
        `batch-${ordinal.toString().padStart(2, "0")}.txt`,
        bytes(`content-${ordinal}\n`),
      );
    }
    class SingleFileBatchWorktree extends CountingWorktree {
      override readFiles(paths: readonly string[], options?: { budget?: number }) {
        const first = paths[0];
        if (first === undefined) return super.readFiles(paths, options);
        const batch = super.readFiles([first], options);
        return { files: batch.files, remaining: [...batch.remaining, ...paths.slice(1)] };
      }
    }
    const worktree = new SingleFileBatchWorktree(workspace.worktree);

    requireCleanIntegrationWorktree(workspace.repo, worktree, "merge");

    expect(worktree.bulkReadPaths).toHaveLength(11);
    expect(workspace.repo.store.memory.totalBytes).toBe(0);
  });

  it("closes the dirty-path cursor after the first dirty result", () => {
    const workspace = makeRepo("/");
    trackWorktreeFile(workspace, "dirty.txt", bytes("indexed\n"));
    workspace.worktree.writeFile("/dirty.txt", bytes("modified\n"));
    const iterators = trackStorageIterators(workspace);

    expect(() =>
      requireCleanIntegrationWorktree(workspace.repo, workspace.worktree, "merge"),
    ).toThrowError(expect.objectContaining({ code: "ECHECKOUTFAIL" }));
    expect(iterators.closed()).toBeGreaterThan(0);
    expect(iterators.active()).toBe(0);
    workspace.repo.store.memory.assertIdle();
  });

  it("releases integration guard ownership after a ranged read failure", () => {
    const workspace = makeRepo("/");
    const content = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x72);
    trackWorktreeFile(workspace, "failure.bin", content);
    class FailingRangeWorktree extends CountingWorktree {
      override readRange(path: string, offset: number, length: number): Uint8Array {
        if (this.rangeReads === 1) {
          this.rangeReads++;
          throw new Error("injected integration range failure");
        }
        return super.readRange(path, offset, length);
      }
    }
    const worktree = new FailingRangeWorktree(workspace.worktree);
    const iterators = trackStorageIterators(workspace);

    expect(() => requireCleanIntegrationWorktree(workspace.repo, worktree, "merge")).toThrow(
      "injected integration range failure",
    );
    expect(worktree.rangeReads).toBe(2);
    expect(iterators.closed()).toBeGreaterThan(0);
    expect(iterators.active()).toBe(0);
    expect(workspace.repo.store.memory.totalBytes).toBe(0);
  });

  it("merges mixed loose and packed blobs without mutation or leaked reservations", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const packedContents = {
      cleanBase: bytes("one\ncommon\nthree\n"),
      cleanIncoming: bytes("one\ncommon\nTHREE\n"),
      conflictBase: bytes("base\n"),
      conflictIncoming: bytes("incoming\n"),
    };
    const packedIdentities = {
      cleanBase: hashObject("blob", packedContents.cleanBase),
      cleanIncoming: hashObject("blob", packedContents.cleanIncoming),
      conflictBase: hashObject("blob", packedContents.conflictBase),
      conflictIncoming: hashObject("blob", packedContents.conflictIncoming),
    };
    const packChunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => packChunks.push(chunk));
    writer.header(4);
    writer.object("blob", packedContents.cleanBase);
    writer.object("blob", packedContents.cleanIncoming);
    writer.object("blob", packedContents.conflictBase);
    writer.object("blob", packedContents.conflictIncoming);
    writer.finish();
    await store.packs.ingest(slices(concat(packChunks), 64));

    const current = writeTree(store, {
      "clean.txt": { content: "ONE\ncommon\nthree\n" },
      "conflict.txt": { content: "current\n" },
    });
    const base = writeIdentityTree(store, {
      "clean.txt": { mode: MODE_FILE, oid: packedIdentities.cleanBase },
      "conflict.txt": { mode: MODE_FILE, oid: packedIdentities.conflictBase },
    });
    const incoming = writeIdentityTree(store, {
      "clean.txt": { mode: MODE_FILE, oid: packedIdentities.cleanIncoming },
      "conflict.txt": { mode: MODE_FILE, oid: packedIdentities.conflictIncoming },
    });
    store.setRef("refs/heads/main", current.tree);

    expect(
      store.db.scalar<number>(
        `SELECT COUNT(*) FROM git_objects
         WHERE repo_id = 1 AND oid IN (?, ?, ?, ?)`,
        packedIdentities.cleanBase,
        packedIdentities.cleanIncoming,
        packedIdentities.conflictBase,
        packedIdentities.conflictIncoming,
      ),
    ).toBe(0);
    expect(
      store.db.scalar<number>(
        `SELECT COUNT(*) FROM git_pack_objects
         WHERE repo_id = 1 AND oid IN (?, ?, ?, ?)`,
        packedIdentities.cleanBase,
        packedIdentities.cleanIncoming,
        packedIdentities.conflictBase,
        packedIdentities.conflictIncoming,
      ),
    ).toBe(4);

    const coldDatabase = new SqliteGitDatabase(db);
    const repository = coldDatabase.findCheckout("/repo");
    if (repository === null) throw new Error("missing packed integration repository");
    const coldStore = coldDatabase.openCheckout(repository);
    const before = {
      objects: coldStore.objectCount(),
      refs: coldStore.listRefs(),
      index: coldStore.indexEntries(),
    };
    const plan = planIntegration(new Repository(coldStore), {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
      text: { labels: { current: "HEAD", incoming: "topic" } },
    });

    expect(plan.memoryHighWaterBytes).toBeLessThan(MAX_OPERATION_MEMORY_BYTES);
    expect(plan.memoryHighWaterBytes).toBeGreaterThanOrEqual(plan.retainedBytes);

    const clean = find(plan.entries, "clean.txt");
    expect(clean).toMatchObject({
      kind: "clean",
      before: current.files.get("clean.txt"),
      result: { mode: MODE_FILE },
    });
    if (clean.kind !== "clean" || clean.content === null) {
      throw new Error("expected packed/loose clean merge content");
    }
    expect(new TextDecoder().decode(clean.content)).toBe("ONE\ncommon\nTHREE\n");
    expect(clean.result?.oid).toBe(hashObject("blob", clean.content));

    const conflict = find(plan.entries, "conflict.txt");
    expect(conflict).toMatchObject({
      kind: "conflict",
      conflict: "content",
      conflicts: 1,
      stages: {
        base: base.files.get("conflict.txt"),
        current: current.files.get("conflict.txt"),
        incoming: incoming.files.get("conflict.txt"),
      },
    });
    if (conflict.kind !== "conflict" || conflict.content === null) {
      throw new Error("expected packed/loose conflict content");
    }
    expect(new TextDecoder().decode(conflict.content)).toBe(
      "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n",
    );

    expect({
      objects: coldStore.objectCount(),
      refs: coldStore.listRefs(),
      index: coldStore.indexEntries(),
    }).toEqual(before);
    plan.release();
    assertCoordinatorIdle(coldStore);
  });

  it("batches content reads and returns clean, text, binary, and structural results", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, {
      "a.txt": { content: "one\ncommon\nthree\n" },
      "binary.bin": { content: new Uint8Array([0, 1]) },
      "conflict.txt": { content: "base\n" },
      "delete.txt": { content: "delete me\n" },
    });
    const current = writeTree(store, {
      "a.txt": { content: "ONE\ncommon\nthree\n" },
      "binary.bin": { content: new Uint8Array([0, 2]) },
      "conflict.txt": { content: "current\n" },
      "delete.txt": { content: "delete me\n" },
    });
    const incoming = writeTree(store, {
      "a.txt": { content: "one\ncommon\nTHREE\n" },
      "binary.bin": { content: new Uint8Array([0, 3]) },
      "conflict.txt": { content: "incoming\n" },
    });
    store.setRef("refs/heads/main", current.tree);
    const repo = new Repository(store);
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };
    const plan = planIntegration(repo, {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
      text: { labels: { current: "HEAD", incoming: "topic" } },
    });

    expect(plan.entries.map((entry) => entry.path)).toEqual([
      "a.txt",
      "binary.bin",
      "conflict.txt",
      "delete.txt",
    ]);
    expect(plan.memoryHighWaterBytes).toBeLessThan(MAX_OPERATION_MEMORY_BYTES);
    expect(plan.memoryHighWaterBytes).toBeGreaterThanOrEqual(plan.retainedBytes);

    const clean = find(plan.entries, "a.txt");
    expect(clean).toMatchObject({
      kind: "clean",
      before: current.files.get("a.txt"),
      result: { mode: MODE_FILE },
    });
    if (clean.kind !== "clean" || clean.content === null) {
      throw new Error("expected merged content");
    }
    expect(new TextDecoder().decode(clean.content)).toBe("ONE\ncommon\nTHREE\n");
    expect(clean.result?.oid).toBe(hashObject("blob", clean.content));

    const binary = find(plan.entries, "binary.bin");
    expect(binary).toMatchObject({
      kind: "conflict",
      conflict: "binary",
      stages: {
        base: base.files.get("binary.bin"),
        current: current.files.get("binary.bin"),
        incoming: incoming.files.get("binary.bin"),
      },
    });
    if (binary.kind !== "conflict") throw new Error("expected binary conflict");
    expect(binary.content).toEqual(new Uint8Array([0, 2]));

    const conflict = find(plan.entries, "conflict.txt");
    expect(conflict).toMatchObject({
      kind: "conflict",
      conflict: "content",
      conflicts: 1,
      stages: {
        base: base.files.get("conflict.txt"),
        current: current.files.get("conflict.txt"),
        incoming: incoming.files.get("conflict.txt"),
      },
    });
    if (conflict.kind !== "conflict" || conflict.content === null) {
      throw new Error("expected text conflict content");
    }
    expect(new TextDecoder().decode(conflict.content)).toContain("<<<<<<< HEAD\n");

    expect(find(plan.entries, "delete.txt")).toEqual({
      kind: "clean",
      path: "delete.txt",
      before: current.files.get("delete.txt"),
      result: null,
      content: null,
    });
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
    plan.release();
    assertCoordinatorIdle(store);
  });

  it("plans one valid binary blob above the batching target as a singleton", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const large = new Uint8Array(PACK_BLOB_BATCH_TARGET_BYTES + 1).fill(0x61);
    large[0] = 0;
    const base = writeTree(store, { "large.bin": { content: "base\n" } });
    const current = writeTree(store, { "large.bin": { content: large } });
    const incoming = writeTree(store, { "large.bin": { content: "incoming\n" } });

    const plan = planIntegration(new Repository(store), {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
    });

    const entry = find(plan.entries, "large.bin");
    expect(entry).toMatchObject({ kind: "conflict", conflict: "binary" });
    expect(entry.content).toEqual(large);
    plan.release();
    assertCoordinatorIdle(store);
  });

  it("finishes after more than sixteen progressing blob reads without mutating state", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const baseFiles: Record<string, FileValue> = {};
    const currentFiles: Record<string, FileValue> = {};
    const incomingFiles: Record<string, FileValue> = {};
    for (let ordinal = 0; ordinal < 17; ordinal++) {
      const path = `file-${ordinal.toString().padStart(2, "0")}`;
      baseFiles[path] = { content: `base-${ordinal}\n` };
      currentFiles[path] = { content: `current-${ordinal}\n` };
      incomingFiles[path] = { content: `incoming-${ordinal}\n` };
    }
    const base = writeTree(store, baseFiles);
    const current = writeTree(store, currentFiles);
    const incoming = writeTree(store, incomingFiles);
    const repo = new Repository(store);
    const readBlobs = repo.readBlobs.bind(repo);
    let readCalls = 0;
    repo.readBlobs = (oids, options) => {
      const first = oids[0];
      if (first === undefined) throw new Error("test blob batch is empty");
      readCalls++;
      const batch = readBlobs([first], options);
      return {
        blobs: batch.blobs,
        remaining: [...batch.remaining, ...oids.slice(1)],
        bytes: batch.bytes,
      };
    };
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };

    const plan = planIntegration(repo, {
      baseTreeOid: base.tree,
      currentTreeOid: current.tree,
      incomingTreeOid: incoming.tree,
    });
    expect(readCalls).toBeGreaterThan(16);
    expect(plan.entries).toHaveLength(17);
    for (let ordinal = 0; ordinal < 17; ordinal++) {
      const path = `file-${ordinal.toString().padStart(2, "0")}`;
      const entry = plan.entries[ordinal];
      if (entry === undefined || entry.kind !== "conflict" || entry.content === null) {
        throw new Error(`missing exact conflict plan entry for ${path}`);
      }
      expect(entry).toMatchObject({
        kind: "conflict",
        path,
        conflict: "content",
        conflicts: 1,
        resultMode: MODE_FILE,
        stages: {
          base: base.files.get(path),
          current: current.files.get(path),
          incoming: incoming.files.get(path),
        },
      });
      expect(new TextDecoder().decode(entry.content)).toBe(
        `<<<<<<<\ncurrent-${ordinal}\n=======\nincoming-${ordinal}\n>>>>>>>\n`,
      );
    }
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
    plan.release();
    assertCoordinatorIdle(store);
  });

  it("fails closed on missing and wrong-type candidate objects", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const missing = writeIdentityTree(store, {
      file: { mode: MODE_FILE, oid: "ffffffffffffffffffffffffffffffffffffffff" },
    });
    const wrongTypeOid = store.write("tree", serializeTree([]));
    const wrongType = writeIdentityTree(store, {
      file: { mode: MODE_FILE, oid: wrongTypeOid },
    });
    const repo = new Repository(store);
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };

    expect(() =>
      planIntegration(repo, {
        baseTreeOid: missing.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
      }),
    ).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));
    assertCoordinatorIdle(store);
    expect(() =>
      planIntegration(repo, {
        baseTreeOid: wrongType.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
    assertCoordinatorIdle(store);
  });

  it("rejects candidate bytes that do not match their object id", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const currentIdentity = current.files.get("file");
    if (currentIdentity === undefined) throw new Error("missing current identity");
    const corrupt = bytes("corrupt\n");
    store.db.run(
      "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ?",
      corrupt,
      1,
      currentIdentity.oid,
    );
    const coldDatabase = new SqliteGitDatabase(db);
    const repository = coldDatabase.findCheckout("/repo");
    if (repository === null) throw new Error("missing corrupt integration repository");
    const coldStore = coldDatabase.openCheckout(repository);

    expect(() =>
      planIntegration(new Repository(coldStore), {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(
      coldStore.db.scalar<Uint8Array>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = 0",
        1,
        currentIdentity.oid,
      ),
    ).toEqual(corrupt);
    assertCoordinatorIdle(coldStore);
  });

  it("rejects limits that try to raise a hard ceiling", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const repo = new Repository(store);
    expect(() =>
      planIntegration(repo, {
        baseTreeOid: null,
        currentTreeOid: null,
        incomingTreeOid: null,
        limits: { maxEntries: 1_001 },
      }),
    ).toThrow(RangeError);
  });

  it("uses a stable error code when the retained plan limit is crossed", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });
    const repo = new Repository(store);

    try {
      planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        limits: { maxPlanBytes: 0 },
      });
      throw new Error("expected the integration plan limit to reject content");
    } catch (error) {
      expect(hasErrorCode(error, "E2BIG")).toBe(true);
    }
    assertCoordinatorIdle(store);
  });

  it("caps text output before merge allocation and binary content before retention", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, {
      binary: { content: new Uint8Array([0, 1]) },
      text: { content: "base\n" },
    });
    const current = writeTree(store, {
      binary: { content: new Uint8Array([0, ...Array.from({ length: 31 }, () => 2)]) },
      text: { content: "current contents\n" },
    });
    const incoming = writeTree(store, {
      binary: { content: new Uint8Array([0, 3]) },
      text: { content: "incoming contents\n" },
    });
    const repo = new Repository(store);

    expect(() =>
      planIntegration(repo, {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        limits: { maxPlanBytes: 600 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertCoordinatorIdle(store);

    const textBase = writeTree(store, { text: { content: "base\n" } });
    const textCurrent = writeTree(store, { text: { content: "current contents\n" } });
    const textIncoming = writeTree(store, { text: { content: "incoming contents\n" } });
    expect(() =>
      planIntegration(repo, {
        baseTreeOid: textBase.tree,
        currentTreeOid: textCurrent.tree,
        incomingTreeOid: textIncoming.tree,
        limits: { maxPlanBytes: 600 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertCoordinatorIdle(store);
  });

  it("does not hide a text output limit above the xmerge hard ceiling", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = writeTree(store, { file: { content: "base\n" } });
    const current = writeTree(store, { file: { content: "current\n" } });
    const incoming = writeTree(store, { file: { content: "incoming\n" } });

    expect(() =>
      planIntegration(new Repository(store), {
        baseTreeOid: base.tree,
        currentTreeOid: current.tree,
        incomingTreeOid: incoming.tree,
        text: {
          limits: { maxOutputBytes: DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes + 1 },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    assertCoordinatorIdle(store);
  });
});
