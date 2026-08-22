import { describe, expect, it } from "vitest";

import { fromHex, utf8, utf8Decoder } from "../src/core/bytes.js";
import type { GitContext, IndexTrackerSeedEntry } from "../src/core/context.js";
import { CorruptError } from "../src/core/errors.js";
import { checkoutSparseChanges, type SparseCheckoutChange } from "../src/core/ops/checkout.js";
import { commit } from "../src/core/ops/commit.js";
import { checkout } from "../src/core/ops/refs.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import type { SparseWorkspaceSource } from "../src/core/sparse-workspace.js";
import type { Worktree } from "../src/core/worktree.js";
import type {
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "../src/fs/types.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { resealIndexTracker } from "../src/sqlite/index-tracker.js";
import { createSqliteSparseWorkspaceSource } from "../src/sqlite/sparse-workspace.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

class NoScanWorktree extends CountingWorktree {
  writes: string[] = [];
  removals: string[] = [];
  scanProbes: Array<{ root: string; limit: number; rows: number; statements: number | null }> = [];
  statProbes: Array<{ path: string; statements: number }> = [];

  constructor(
    inner: Worktree,
    private readonly statementCount?: () => number,
  ) {
    super(inner);
  }

  override stat(path: string) {
    const before = this.statementCount?.();
    const result = super.stat(path);
    const after = this.statementCount?.();
    if (before !== undefined && after !== undefined) {
      this.statProbes.push({ path, statements: after - before });
    }
    return result;
  }

  override scan(root: string, options: ScanOptions): ScanEntry[] {
    if (
      options.limit !== 1 ||
      options.after !== undefined ||
      options.afterSubtree !== undefined ||
      options.filesOnly !== undefined
    ) {
      throw new Error("sparse checkout must not scan the worktree");
    }
    const before = this.statementCount?.();
    const rows = super.scan(root, options);
    const after = this.statementCount?.();
    this.scanProbes.push({
      root,
      limit: options.limit,
      rows: rows.length,
      statements: before === undefined || after === undefined ? null : after - before,
    });
    return rows;
  }

  override readdir(): never {
    throw new Error("sparse checkout must not scan the worktree");
  }

  override writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
    this.writes.push(...entries.map((entry) => entry.path));
    super.writeFiles(entries, options);
  }

  override removeFiles(paths: readonly string[], options?: RemoveOptions): void {
    this.removals.push(...paths);
    super.removeFiles(paths, options);
  }
}

class FailingWriteWorktree extends NoScanWorktree {
  override writeFiles(): never {
    throw new Error("injected sparse checkout write failure");
  }
}

class FailingHashWorktree extends NoScanWorktree {
  override readFiles(): never {
    throw new Error("injected sparse checkout hash failure");
  }
}

class LegacyScanWorktree extends CountingWorktree {
  scans: Array<{ root: string; limit: number }> = [];

  override scan(root: string, options: ScanOptions): ScanEntry[] {
    this.scans.push({ root, limit: options.limit });
    return super.scan(root, options);
  }
}

class WorktreePayloadProbe implements SqlDatabase {
  rawSymlinkTargets = 0;

  constructor(private readonly delegate: SqlDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.delegate.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.delegate.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.delegate.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.delegate.scalar<T>(query, ...bindings);
  }

  *iterate(query: string, ...bindings: unknown[]): Generator<Record<string, unknown>> {
    for (const row of this.delegate.iterate(query, ...bindings)) {
      if (row.cumulative_retained_bytes !== undefined && typeof row.link_target === "string") {
        this.rawSymlinkTargets++;
      }
      yield row;
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

function configure(workspace: TestRepository): void {
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
}

function stagePaths(workspace: TestRepository, paths: readonly string[]): void {
  for (const path of paths) {
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path);
    if (hashed === null) throw new Error(`missing fixture path: ${path}`);
    workspace.repo.store.indexPut(indexEntryFor(path, hashed));
  }
}

function trackerContext(
  workspace: TestRepository,
  source: SparseWorkspaceSource | undefined = workspace.context.sparseWorkspace,
): GitContext {
  return {
    ...workspace.context,
    sparseWorkspace: source,
    indexTracker: {
      reseal(
        repoId: number,
        baselineTreeOid: string | null,
        entries: Iterable<IndexTrackerSeedEntry>,
      ) {
        return resealIndexTracker(workspace.database.db, repoId, baselineTreeOid, entries);
      },
    },
  };
}

function withoutSparseCheckout(context: GitContext): GitContext {
  const result = { ...context };
  delete result.sparseWorkspace;
  delete result.indexTracker;
  return result;
}

function seal(workspace: TestRepository): void {
  expect(
    resealIndexTracker(
      workspace.database.db,
      workspace.repo.store.repoId,
      workspace.repo.headTree(),
      [],
    ),
  ).toBe(true);
}

function expectFile(workspace: TestRepository, path: string, content: string): void {
  expect(utf8Decoder.decode(workspace.worktree.readFile(path))).toBe(content);
}

function makeChangedFiles(
  totalFiles: number,
  changedFiles: number,
): { workspace: TestRepository; base: string; target: string; paths: string[] } {
  const workspace = makeRepo("/");
  configure(workspace);
  const before = utf8.encode("before\n");
  const after = utf8.encode("after\n");
  const beforeOid = workspace.repo.store.write("blob", before);
  const afterOid = workspace.repo.store.write("blob", after);
  const directories = Math.min(totalFiles, 3_346);
  const paths = Array.from({ length: totalFiles }, (_, index) => {
    const directory = index % directories;
    const generation = Math.floor(index / directories);
    return `src/d${directory.toString().padStart(4, "0")}/f${generation
      .toString()
      .padStart(4, "0")}.txt`;
  });
  workspace.worktree.writeFiles(
    paths.map((path) => ({ path: `/${path}`, bytes: before, contentId: fromHex(beforeOid) })),
  );
  workspace.repo.store.upsertBlobIds([{ contentId: fromHex(beforeOid), oid: beforeOid }]);
  const stats = new Map(
    workspace.worktree
      .scan("/", { filesOnly: true, limit: totalFiles + 1 })
      .map((entry) => [entry.path.slice(1), entry]),
  );
  const original = paths.map((path): IndexEntry => {
    const stat = stats.get(path);
    if (stat === undefined) throw new Error(`missing scale fixture path: ${path}`);
    return {
      path,
      stage: 0,
      mode: 0o100644,
      oid: beforeOid,
      size: stat.size,
      mtime: stat.mtime,
      ino: stat.ino,
      rev: stat.rev,
    };
  });
  workspace.repo.store.indexReplace(original);
  const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
  workspace.repo.store.indexReplace(
    original.map((entry, index) =>
      index < changedFiles ? { ...entry, oid: afterOid, size: after.length } : entry,
    ),
  );
  const target = commit(workspace.context, workspace.repo, { message: "target" }).oid;

  workspace.worktree.writeFiles(
    paths.slice(0, changedFiles).map((path) => ({
      path: `/${path}`,
      bytes: before,
      contentId: fromHex(beforeOid),
    })),
  );
  workspace.repo.store.indexReplace(original);
  workspace.repo.store.setHead(base);
  seal(workspace);
  return { workspace, base, target, paths };
}

describe("sparse checkout", () => {
  it("rejects one byte below the exact plan budget before mutation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a", "a\n");
    stagePaths(workspace, ["a"]);
    const entry = workspace.repo.store.indexGet("a");
    if (entry === null) throw new Error("missing plan boundary index entry");
    const change: SparseCheckoutChange = {
      path: "a",
      before: { path: "a", mode: "100644", oid: entry.oid },
      after: undefined,
      worktreeType: "file",
    };
    const exactPlanBytes = 384 + 96 + 2;

    workspace.storage.resetCounters();
    expect(
      checkoutSparseChanges(workspace.repo, workspace.worktree, [change], exactPlanBytes - 1),
    ).toBe(false);
    expect(workspace.storage.statementCount).toBe(0);
    expect(workspace.worktree.stat("/a")?.type).toBe("file");
    expect(workspace.repo.store.indexGet("a")).not.toBeNull();

    expect(
      checkoutSparseChanges(workspace.repo, workspace.worktree, [change], exactPlanBytes),
    ).toBe(true);
    expect(workspace.worktree.stat("/a")).toBeNull();
    expect(workspace.repo.store.indexGet("a")).toBeNull();
  });

  it("charges a large symlink target before raw egress and checkout mutation", () => {
    const workspace = makeRepo("/");
    configure(workspace);
    const largeTarget = "t".repeat(512 * 1024);
    workspace.worktree.symlink(largeTarget, "/link");
    stagePaths(workspace, ["link"]);
    const baseEntry = workspace.repo.store.indexGet("link");
    if (baseEntry === null) throw new Error("missing large symlink index entry");
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;

    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    stagePaths(workspace, ["link"]);
    const target = commit(workspace.context, workspace.repo, { message: "target" }).oid;
    workspace.worktree.writeFiles([
      { path: "/link", target: largeTarget, contentId: fromHex(baseEntry.oid) },
    ]);
    workspace.repo.store.indexReplace([baseEntry]);
    workspace.repo.store.setHead(base);
    seal(workspace);

    const probe = new WorktreePayloadProbe(workspace.database.db);
    const source = createSqliteSparseWorkspaceSource(probe);
    // Request and index state use 1,420 bytes; JS retains two bytes per ASCII unit plus the ID.
    const exactRetainedBytes = 1_420 + largeTarget.length * 2 + 20;
    const exact = source.hydrate({
      repoId: workspace.repo.store.repoId,
      root: "/",
      baselineTreeOid: null,
      currentTreeOid: null,
      paths: ["link"],
      maxRetainedBytes: exactRetainedBytes,
    });
    expect(exact.available).toBe(true);
    if (!exact.available) return;
    expect(exact.retainedBytes).toBe(exactRetainedBytes);
    expect(exact.rows[0]?.worktree?.target).toBe(largeTarget);
    expect(probe.rawSymlinkTargets).toBe(1);

    probe.rawSymlinkTargets = 0;
    const constrainedSource: SparseWorkspaceSource = {
      readState: (repoId) => source.readState(repoId),
      dirtyPaths: (repoId) => source.dirtyPaths(repoId),
      hydrate: (request) =>
        source.hydrate({ ...request, maxRetainedBytes: exactRetainedBytes - 1 }),
    };
    const worktree = new NoScanWorktree(workspace.worktree);
    expect(() =>
      checkout(trackerContext(workspace, constrainedSource), workspace.repo, worktree, {
        ref: target,
      }),
    ).toThrow(/must not scan/);
    expect(probe.rawSymlinkTargets).toBe(0);
    expect(worktree.writes).toEqual([]);
    expect(worktree.removals).toEqual([]);
    expect(workspace.repo.head().oid).toBe(base);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT length(CAST(link_target AS BLOB)) FROM fs_nodes WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/link')",
      ),
    ).toBe(largeTarget.length);
  });

  it("matches legacy checkout for a clean forced target change", () => {
    const sparse = makeChangedFiles(3, 2);
    const legacy = makeChangedFiles(3, 2);
    const worktree = new NoScanWorktree(sparse.workspace.worktree);

    checkout(trackerContext(sparse.workspace), sparse.workspace.repo, worktree, {
      ref: sparse.target,
      force: true,
    });
    checkout(
      withoutSparseCheckout(legacy.workspace.context),
      legacy.workspace.repo,
      legacy.workspace.worktree,
      { ref: legacy.target, force: true },
    );

    expect(worktree.writes).toEqual(sparse.paths.slice(0, 2).map((path) => `/${path}`));
    expect(sparse.workspace.repo.headTree()).toBe(legacy.workspace.repo.headTree());
    expect(
      [...sparse.workspace.repo.store.indexScan()].map(({ path, mode, oid }) => ({
        path,
        mode,
        oid,
      })),
    ).toEqual(
      [...legacy.workspace.repo.store.indexScan()].map(({ path, mode, oid }) => ({
        path,
        mode,
        oid,
      })),
    );
    for (let index = 0; index < sparse.paths.length; index++) {
      const sparsePath = sparse.paths[index];
      const legacyPath = legacy.paths[index];
      if (sparsePath === undefined || legacyPath === undefined) throw new Error("missing path");
      expectFile(sparse.workspace, `/${sparsePath}`, index < 2 ? "after\n" : "before\n");
      expectFile(legacy.workspace, `/${legacyPath}`, index < 2 ? "after\n" : "before\n");
    }
  });

  it("keeps a clean forced same target free of filesystem and index writes", () => {
    const { workspace, base } = makeChangedFiles(2, 0);
    const worktree = new NoScanWorktree(workspace.worktree);
    const before = [...workspace.repo.store.indexScan()];
    workspace.storage.histogram = new Map();

    workspace.storage.resetCounters();
    checkout(trackerContext(workspace), workspace.repo, worktree, { ref: base, force: true });

    expect(worktree.writes).toEqual([]);
    expect(worktree.removals).toEqual([]);
    expect([...workspace.repo.store.indexScan()]).toEqual(before);
    expect(
      [...workspace.storage.histogram.keys()].filter(
        (query) =>
          query.includes("INTO git_index (") ||
          query.includes("DELETE FROM git_index ") ||
          query.includes("UPDATE git_index "),
      ),
    ).toEqual([]);
    expect(workspace.repo.head().oid).toBe(base);
    expect(workspace.storage.statementCount).toBeLessThan(40);
  });

  it("uses legacy force to restore a dirty tracked path outside the tree diff", () => {
    const { workspace, target, paths } = makeChangedFiles(2, 1);
    const unchanged = paths[1];
    if (unchanged === undefined) throw new Error("missing unchanged force fixture path");
    writeWorkFile(workspace, `/${unchanged}`, "local\n");
    const worktree = new LegacyScanWorktree(workspace.worktree);

    checkout(trackerContext(workspace), workspace.repo, worktree, { ref: target, force: true });

    expect(worktree.scans.some((scan) => scan.limit > 1)).toBe(true);
    expectFile(workspace, `/${paths[0]}`, "after\n");
    expectFile(workspace, `/${unchanged}`, "before\n");
    expect(workspace.repo.head().oid).toBe(target);
    for (const path of paths) {
      const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path, { write: false });
      expect(workspace.repo.store.indexGet(path)?.oid).toBe(hashed?.oid);
      expect(workspace.repo.store.indexGet(path)?.mode.toString(8)).toBe(hashed?.mode);
    }
  });

  it("rewrites one hundred paths in a 24,252-file workspace without a full scan", () => {
    const { workspace, target, paths } = makeChangedFiles(24_252, 100);
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    checkout(trackerContext(workspace), workspace.repo, worktree, { ref: target });

    expect(worktree.writes).toEqual(paths.slice(0, 100).map((path) => `/${path}`));
    expect(worktree.removals).toEqual([]);
    expect(worktree.reads).toBe(0);
    expect(worktree.rangeReads).toBe(0);
    expect(worktree.bulkReadPaths).toEqual([]);
    expect(workspace.storage.statementCount).toBeLessThan(50);
    expect(workspace.storage.rowCount).toBeLessThan(10_000);
    expect(workspace.repo.head().oid).toBe(target);
    expect(workspace.context.sparseWorkspace?.readState(workspace.repo.store.repoId)).toEqual({
      available: true,
      baselineTreeOid: workspace.repo.headTree(),
    });
    expect([...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId)]).toEqual(
      [],
    );
  });

  it("matches structural checkout semantics for clean force", () => {
    const workspace = makeRepo("/");
    configure(workspace);
    writeWorkFile(workspace, "/node", "flat\n");
    writeWorkFile(workspace, "/deleted/old.txt", "old\n");
    writeWorkFile(workspace, "/mode.txt", "mode\n");
    workspace.worktree.symlink("before", "/link");
    stagePaths(workspace, ["deleted/old.txt", "link", "mode.txt", "node"]);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    workspace.repo.store.setRef("refs/heads/base", base);

    workspace.worktree.unlink("/node");
    workspace.repo.store.indexRemove("node");
    writeWorkFile(workspace, "/node/child.txt", "nested\n");
    workspace.worktree.unlink("/deleted/old.txt");
    workspace.worktree.rmdir("/deleted");
    workspace.repo.store.indexRemove("deleted/old.txt");
    writeWorkFile(workspace, "/added/new.txt", "new\n");
    workspace.worktree.chmod("/mode.txt", 0o755);
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    stagePaths(workspace, ["added/new.txt", "link", "mode.txt", "node/child.txt"]);
    const target = commit(workspace.context, workspace.repo, { message: "target" }).oid;

    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: base, force: true });
    seal(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);
    checkout(trackerContext(workspace), workspace.repo, worktree, { ref: target, force: true });

    expect(workspace.worktree.stat("/node")?.type).toBe("dir");
    expectFile(workspace, "/node/child.txt", "nested\n");
    expect(workspace.worktree.stat("/deleted")).toBeNull();
    expectFile(workspace, "/added/new.txt", "new\n");
    expect((workspace.worktree.stat("/mode.txt")?.mode ?? 0) & 0o777).toBe(0o755);
    expect(workspace.worktree.readlink("/link")).toBe("after");

    worktree.writes.length = 0;
    worktree.removals.length = 0;
    checkout(trackerContext(workspace), workspace.repo, worktree, { ref: base, force: true });
    expect(workspace.worktree.stat("/node")?.type).toBe("file");
    expectFile(workspace, "/node", "flat\n");
    expectFile(workspace, "/deleted/old.txt", "old\n");
    expect(workspace.worktree.stat("/added")).toBeNull();
    expect((workspace.worktree.stat("/mode.txt")?.mode ?? 0) & 0o777).toBe(0o644);
    expect(workspace.worktree.readlink("/link")).toBe("before");
  });

  it("falls back before mutation for dirty, unavailable, oversized, conflict, and gitlink state", () => {
    const dirty = makeChangedFiles(2, 1);
    writeWorkFile(dirty.workspace, `/${dirty.paths[0]}`, "local\n");
    const dirtyWorktree = new NoScanWorktree(dirty.workspace.worktree);
    expect(() =>
      checkout(trackerContext(dirty.workspace), dirty.workspace.repo, dirtyWorktree, {
        ref: dirty.target,
      }),
    ).toThrow(/must not scan/);
    expect(dirtyWorktree.writes).toEqual([]);
    expect(dirtyWorktree.removals).toEqual([]);
    expect(dirty.workspace.repo.head().oid).toBe(dirty.base);

    const unavailable = makeChangedFiles(2, 1);
    const source = unavailable.workspace.context.sparseWorkspace;
    if (source === undefined) throw new Error("missing sparse workspace source");
    const unavailableSource: SparseWorkspaceSource = {
      readState: (repoId) => source.readState(repoId),
      dirtyPaths: (repoId) => source.dirtyPaths(repoId),
      hydrate: () => ({ available: false }),
    };
    const unavailableWorktree = new NoScanWorktree(unavailable.workspace.worktree);
    expect(() =>
      checkout(
        trackerContext(unavailable.workspace, unavailableSource),
        unavailable.workspace.repo,
        unavailableWorktree,
        { ref: unavailable.target },
      ),
    ).toThrow(/must not scan/);
    expect(unavailableWorktree.writes).toEqual([]);

    const oversized = makeChangedFiles(1_001, 1_001);
    const oversizedWorktree = new NoScanWorktree(oversized.workspace.worktree);
    expect(() =>
      checkout(trackerContext(oversized.workspace), oversized.workspace.repo, oversizedWorktree, {
        ref: oversized.target,
      }),
    ).toThrow(/must not scan/);
    expect(oversizedWorktree.writes).toEqual([]);

    const conflicted = makeChangedFiles(2, 1);
    const oid = conflicted.workspace.repo.store.write("blob", utf8.encode("stage\n"));
    conflicted.workspace.repo.store.indexPut({
      path: "conflict.txt",
      stage: 2,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });
    seal(conflicted.workspace);
    const conflictWorktree = new NoScanWorktree(conflicted.workspace.worktree);
    expect(() =>
      checkout(trackerContext(conflicted.workspace), conflicted.workspace.repo, conflictWorktree, {
        ref: conflicted.target,
      }),
    ).toThrow(/must not scan/);
    expect(conflictWorktree.writes).toEqual([]);

    const gitlinked = makeChangedFiles(2, 1);
    gitlinked.workspace.repo.store.indexPut({
      path: "module",
      stage: 0,
      mode: 0o160000,
      oid: gitlinked.base,
      size: null,
      mtime: null,
      ino: null,
    });
    seal(gitlinked.workspace);
    const gitlinkWorktree = new NoScanWorktree(gitlinked.workspace.worktree);
    expect(() =>
      checkout(trackerContext(gitlinked.workspace), gitlinked.workspace.repo, gitlinkWorktree, {
        ref: gitlinked.target,
      }),
    ).toThrow(/must not scan/);
    expect(gitlinkWorktree.writes).toEqual([]);
  });

  it("propagates corrupt hydration and hash failures before mutation", () => {
    const corrupt = makeChangedFiles(2, 1);
    const source = corrupt.workspace.context.sparseWorkspace;
    if (source === undefined) throw new Error("missing sparse workspace source");
    const corruptSource: SparseWorkspaceSource = {
      readState: (repoId) => source.readState(repoId),
      dirtyPaths: (repoId) => source.dirtyPaths(repoId),
      hydrate(request) {
        const result = source.hydrate(request);
        if (!result.available) return result;
        return {
          available: true,
          retainedBytes: result.retainedBytes,
          rows: result.rows.map((row, index) =>
            index === 0 ? { ...row, path: `${row.path}.wrong` } : row,
          ),
        };
      },
    };
    const corruptWorktree = new NoScanWorktree(corrupt.workspace.worktree);
    expect(() =>
      checkout(
        trackerContext(corrupt.workspace, corruptSource),
        corrupt.workspace.repo,
        corruptWorktree,
        { ref: corrupt.target },
      ),
    ).toThrow(CorruptError);
    expect(corruptWorktree.writes).toEqual([]);
    expect(corruptWorktree.removals).toEqual([]);

    const hashing = makeChangedFiles(2, 1);
    writeWorkFile(hashing.workspace, `/${hashing.paths[0]}`, "before\n");
    seal(hashing.workspace);
    const hashingWorktree = new FailingHashWorktree(hashing.workspace.worktree);
    expect(() =>
      checkout(trackerContext(hashing.workspace), hashing.workspace.repo, hashingWorktree, {
        ref: hashing.target,
      }),
    ).toThrow(/hash failure/);
    expect(hashingWorktree.writes).toEqual([]);
    expect(hashingWorktree.removals).toEqual([]);
  });

  it("bounds an emptiness probe in a wide directory and preserves its siblings", () => {
    const workspace = makeRepo("/");
    configure(workspace);
    const bytes = utf8.encode("tracked\n");
    const oid = workspace.repo.store.write("blob", bytes);
    const siblingPaths = Array.from(
      { length: 4_000 },
      (_, index) => `wide/keep-${index.toString().padStart(4, "0")}.txt`,
    );
    const paths = ["wide/delete.txt", ...siblingPaths];
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes, contentId: fromHex(oid) })),
    );
    workspace.repo.store.upsertBlobIds([{ contentId: fromHex(oid), oid }]);
    const stats = new Map(
      workspace.worktree
        .scan("/", { filesOnly: true, limit: paths.length + 1 })
        .map((entry) => [entry.path.slice(1), entry]),
    );
    const original = paths.map((path): IndexEntry => {
      const stat = stats.get(path);
      if (stat === undefined) throw new Error(`missing wide fixture path: ${path}`);
      return {
        path,
        stage: 0,
        mode: 0o100644,
        oid,
        size: stat.size,
        mtime: stat.mtime,
        ino: stat.ino,
        rev: stat.rev,
      };
    });
    workspace.repo.store.indexReplace(original);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    workspace.repo.store.indexReplace(original.slice(1));
    const target = commit(workspace.context, workspace.repo, { message: "delete one" }).oid;
    workspace.repo.store.indexReplace(original);
    workspace.repo.store.setHead(base);
    seal(workspace);
    const worktree = new NoScanWorktree(workspace.worktree, () => workspace.storage.statementCount);

    workspace.storage.resetCounters();
    checkout(trackerContext(workspace), workspace.repo, worktree, { ref: target });

    expect(worktree.scanProbes).toEqual([{ root: "/wide", limit: 1, rows: 1, statements: 2 }]);
    expect(worktree.statProbes).toEqual([{ path: "/wide", statements: 2 }]);
    expect(
      (worktree.statProbes[0]?.statements ?? 0) + (worktree.scanProbes[0]?.statements ?? 0),
    ).toBeLessThanOrEqual(5);
    expect(workspace.storage.rowCount).toBeLessThan(10_000);
    expect(workspace.worktree.stat("/wide")?.type).toBe("dir");
    expect(workspace.worktree.stat("/wide/delete.txt")).toBeNull();
    expect(workspace.worktree.stat(`/${siblingPaths[0]}`)?.type).toBe("file");
    expect(workspace.repo.head().oid).toBe(target);
  });

  it("falls back before mutating 296 distinct directories that exceed the prune SQL budget", () => {
    const workspace = makeRepo("/");
    configure(workspace);
    // The old two-SQL charge admitted this 1,531-statement prune.
    const paths = Array.from(
      { length: 296 },
      (_, index) => `d${index.toString().padStart(3, "0")}/file.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "tracked\n");
    stagePaths(workspace, paths);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    workspace.repo.store.setRef("refs/heads/base", base);
    workspace.worktree.removeFiles(paths.map((path) => `/${path}`));
    workspace.repo.store.indexClear();
    const target = commit(workspace.context, workspace.repo, { message: "delete" }).oid;
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: base, force: true });
    seal(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);

    expect(() =>
      checkout(trackerContext(workspace), workspace.repo, worktree, { ref: target }),
    ).toThrow(/must not scan/);
    expect(worktree.writes).toEqual([]);
    expect(worktree.removals).toEqual([]);
    expect(workspace.repo.head().oid).toBe(base);
  });

  it("does not fall back or reseal when sparse apply fails", () => {
    const { workspace, target } = makeChangedFiles(2, 1);
    const source = workspace.context.sparseWorkspace;
    if (source === undefined) throw new Error("missing sparse workspace source");
    const reseals: Array<{ baseline: string | null; entries: IndexTrackerSeedEntry[] }> = [];
    const context: GitContext = {
      ...workspace.context,
      sparseWorkspace: source,
      indexTracker: {
        reseal(_repoId, baseline, entries) {
          reseals.push({ baseline, entries: [...entries] });
          return true;
        },
      },
    };
    const worktree: Worktree = new FailingWriteWorktree(workspace.worktree);

    expect(() => checkout(context, workspace.repo, worktree, { ref: target })).toThrow(
      /write failure/,
    );
    expect(reseals).toEqual([]);
    expect(workspace.repo.head().oid).not.toBe(target);
  });
});
