import { describe, expect, it } from "vitest";

import { fromHex, toHex, utf8, utf8Decoder } from "../src/core/bytes.js";
import type { GitContext, IndexTrackerSeedEntry } from "../src/core/context.js";
import { CorruptError } from "../src/core/errors.js";
import { commit } from "../src/core/ops/commit.js";
import { checkout } from "../src/core/ops/refs.js";
import { hashWorktreePath } from "../src/core/ops/worktree-io.js";
import type {
  SelectedPathRequest,
  SelectedPathResult,
  SparseWorkspaceSource,
} from "../src/core/sparse-workspace.js";
import { comparePaths } from "../src/core/streams.js";
import type { Worktree } from "../src/core/worktree.js";
import type {
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "../src/fs/types.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import {
  createSqliteSelectedPathSource,
  createSqliteSparseWorkspaceSource,
} from "../src/sqlite/sparse-workspace.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import {
  configureFixtureIdentity,
  requireSparseWorkspace,
  sealIndexTracker,
  sparseTrackerContext,
  stageWorktreePaths,
} from "./helpers/sparse.js";
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

function withoutSparseCheckout(context: GitContext): GitContext {
  const result = { ...context };
  delete result.sparseWorkspace;
  delete result.indexTracker;
  return result;
}

function expectFile(workspace: TestRepository, path: string, content: string): void {
  expect(utf8Decoder.decode(workspace.worktree.readFile(path))).toBe(content);
}

interface SelectedCheckoutCalls {
  requests: SelectedPathRequest[];
  statements: number[];
  hydrates: number;
}

function selectedCheckoutContext(
  workspace: TestRepository,
  calls: SelectedCheckoutCalls,
): GitContext {
  const sparse = requireSparseWorkspace(workspace);
  const selected = createSqliteSelectedPathSource(workspace.database.db);
  return {
    ...sparseTrackerContext(workspace),
    sparseWorkspace: {
      readState: (checkoutId) => sparse.readState(checkoutId),
      dirtyPaths: (checkoutId) => sparse.dirtyPaths(checkoutId),
      hydrate(request) {
        calls.hydrates++;
        return sparse.hydrate(request);
      },
    },
    selectedPaths: {
      select(request) {
        calls.requests.push(request);
        const before = workspace.storage.statementCount;
        const result = selected.select(request);
        calls.statements.push(workspace.storage.statementCount - before);
        return result;
      },
    },
  };
}

function selectedResultContext(
  workspace: TestRepository,
  transform: (
    result: Extract<SelectedPathResult, { available: true }>,
  ) => Extract<SelectedPathResult, { available: true }> | { available: false },
): GitContext {
  const native = createSqliteSelectedPathSource(workspace.database.db);
  return {
    ...sparseTrackerContext(workspace),
    selectedPaths: {
      select(request) {
        const result = native.select(request);
        return result.available ? transform(result) : result;
      },
    },
  };
}

function makeChangedPathSet(
  paths: string[],
  changedPaths: readonly string[],
): {
  workspace: TestRepository;
  base: string;
  target: string;
  paths: string[];
  changedPaths: string[];
} {
  const changed = new Set(changedPaths);
  const workspace = makeRepo("/");
  configureFixtureIdentity(workspace);
  const before = utf8.encode("before\n");
  const after = utf8.encode("after\n");
  const beforeOid = workspace.repo.store.write("blob", before);
  const afterOid = workspace.repo.store.write("blob", after);
  workspace.worktree.writeFiles(
    paths.map((path) => ({ path: `/${path}`, bytes: before, contentId: fromHex(beforeOid) })),
  );
  workspace.repo.store.upsertBlobIds([{ contentId: fromHex(beforeOid), oid: beforeOid }]);
  const stats = new Map(
    workspace.worktree
      .scan("/", { filesOnly: true, limit: paths.length + 1 })
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
  workspace.repo.checkout.indexReplace(original);
  const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
  workspace.repo.checkout.indexReplace(
    original.map((entry) =>
      changed.has(entry.path) ? { ...entry, oid: afterOid, size: after.length } : entry,
    ),
  );
  const target = commit(workspace.context, workspace.repo, {
    message: "target",
    ...(changed.size === 0 ? { allowEmpty: true } : {}),
  }).oid;

  workspace.worktree.writeFiles(
    changedPaths.map((path) => ({
      path: `/${path}`,
      bytes: before,
      contentId: fromHex(beforeOid),
    })),
  );
  workspace.repo.checkout.indexReplace(original);
  workspace.repo.checkout.setHead(base);
  sealIndexTracker(workspace);
  return { workspace, base, target, paths, changedPaths: [...changedPaths] };
}

function makeChangedFiles(
  totalFiles: number,
  changedFiles: number,
): { workspace: TestRepository; base: string; target: string; paths: string[] } {
  const directories = Math.min(totalFiles, 3_346);
  const paths = Array.from({ length: totalFiles }, (_, index) => {
    const directory = index % directories;
    const generation = Math.floor(index / directories);
    return `src/d${directory.toString().padStart(4, "0")}/f${generation
      .toString()
      .padStart(4, "0")}.txt`;
  });
  return makeChangedPathSet(paths, paths.slice(0, changedFiles));
}

type ScaleShape = "concentrated" | "spread";
const scaleCases: ReadonlyArray<readonly [number, ScaleShape]> = [
  [100, "concentrated"],
  [100, "spread"],
  [1_000, "concentrated"],
  [1_000, "spread"],
];

function makeScaleChangedFiles(changedFiles: number, shape: ScaleShape) {
  const concentrated = Array.from(
    { length: 1_000 },
    (_, index) => `src/hot/f${index.toString().padStart(4, "0")}.txt`,
  );
  const spread = Array.from(
    { length: 1_000 },
    (_, index) => `src/spread/d${index.toString().padStart(4, "0")}/file.txt`,
  );
  const cold = Array.from(
    { length: 24_252 - concentrated.length - spread.length },
    (_, index) =>
      `src/cold/d${(index % 3_346).toString().padStart(4, "0")}/f${Math.floor(index / 3_346)
        .toString()
        .padStart(4, "0")}.txt`,
  );
  const paths = [...concentrated, ...spread, ...cold].sort(comparePaths);
  const selected = shape === "concentrated" ? concentrated : spread;
  return makeChangedPathSet(paths, selected.slice(0, changedFiles).sort(comparePaths));
}

function checkoutState(workspace: TestRepository) {
  return {
    head: workspace.repo.head(),
    tree: workspace.repo.headTree(),
    index: [...workspace.repo.checkout.indexScan()].map(({ path, stage, mode, oid, size }) => ({
      path,
      stage,
      mode,
      oid,
      size,
    })),
    worktree: workspace.worktree
      .scan("/", { filesOnly: true, limit: 24_253 })
      .map(({ path, type, mode, size, contentId }) => ({
        path,
        type,
        mode: mode & 0o777,
        size,
        contentId: contentId === null ? null : toHex(contentId),
      })),
  };
}

describe("sparse checkout", () => {
  it("hydrates a large symlink target", () => {
    const workspace = makeRepo("/");
    configureFixtureIdentity(workspace);
    const largeTarget = "t".repeat(512 * 1024);
    workspace.worktree.symlink(largeTarget, "/link");
    stageWorktreePaths(workspace, ["link"]);
    const baseEntry = workspace.repo.checkout.indexGet("link");
    if (baseEntry === null) throw new Error("missing large symlink index entry");
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;

    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    stageWorktreePaths(workspace, ["link"]);
    commit(workspace.context, workspace.repo, { message: "target" });
    workspace.worktree.writeFiles([
      { path: "/link", target: largeTarget, contentId: fromHex(baseEntry.oid) },
    ]);
    workspace.repo.checkout.indexReplace([baseEntry]);
    workspace.repo.checkout.setHead(base);
    sealIndexTracker(workspace);

    const probe = new WorktreePayloadProbe(workspace.database.db);
    const source = createSqliteSparseWorkspaceSource(probe);
    const exact = source.hydrate({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: null,
      currentTreeOid: null,
      paths: ["link"],
    });
    expect(exact.available).toBe(true);
    if (!exact.available) return;
    expect(exact.rows[0]?.worktree?.target).toBe(largeTarget);
    expect(probe.rawSymlinkTargets).toBe(1);
  });

  it("matches legacy checkout for a clean forced target change", () => {
    const sparse = makeChangedFiles(3, 2);
    const legacy = makeChangedFiles(3, 2);
    const worktree = new NoScanWorktree(sparse.workspace.worktree);

    checkout(sparseTrackerContext(sparse.workspace), sparse.workspace.repo, worktree, {
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
      [...sparse.workspace.repo.checkout.indexScan()].map(({ path, mode, oid }) => ({
        path,
        mode,
        oid,
      })),
    ).toEqual(
      [...legacy.workspace.repo.checkout.indexScan()].map(({ path, mode, oid }) => ({
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
    const before = [...workspace.repo.checkout.indexScan()];
    const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };
    workspace.storage.histogram = new Map();

    workspace.storage.resetCounters();
    checkout(selectedCheckoutContext(workspace, calls), workspace.repo, worktree, {
      ref: base,
      force: true,
    });

    expect(worktree.writes).toEqual([]);
    expect(worktree.removals).toEqual([]);
    expect([...workspace.repo.checkout.indexScan()]).toEqual(before);
    expect(
      [...workspace.storage.histogram.keys()].filter(
        (query) =>
          query.includes("INTO git_index (") ||
          query.includes("DELETE FROM git_index ") ||
          query.includes("UPDATE git_index "),
      ),
    ).toEqual([]);
    expect(workspace.repo.head().oid).toBe(base);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(calls).toEqual({ requests: [], statements: [], hydrates: 0 });
  });

  it("uses current hydration when exact selected facts are unavailable", () => {
    const { workspace, target } = makeChangedFiles(2, 1);
    const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };
    const context = selectedCheckoutContext(workspace, calls);
    context.selectedPaths = { select: () => ({ available: false }) };
    const worktree = new NoScanWorktree(workspace.worktree);

    checkout(context, workspace.repo, worktree, { ref: target });

    expect(calls.hydrates).toBe(1);
    expect(worktree.writes).toHaveLength(1);
    expect(workspace.repo.head().oid).toBe(target);
  });

  it("uses a selected path past the former component ceiling", () => {
    const workspace = makeRepo("/");
    configureFixtureIdentity(workspace);
    const path = "x".repeat(2_201);
    writeWorkFile(workspace, `/${path}`, "before\n");
    stageWorktreePaths(workspace, [path]);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    writeWorkFile(workspace, `/${path}`, "after\n");
    stageWorktreePaths(workspace, [path]);
    const target = commit(workspace.context, workspace.repo, { message: "target" }).oid;
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: base, force: true });
    sealIndexTracker(workspace);
    const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };

    checkout(selectedCheckoutContext(workspace, calls), workspace.repo, workspace.worktree, {
      ref: target,
      force: true,
    });

    expectFile(workspace, `/${path}`, "after\n");
    expect(calls.requests).toHaveLength(1);
    expect(calls.hydrates).toBe(0);
  });

  it("rejects malformed, duplicate, unordered, and extraneous selected facts before mutation", () => {
    const assertRejected = (
      transform: (
        result: Extract<SelectedPathResult, { available: true }>,
      ) => Extract<SelectedPathResult, { available: true }>,
    ): void => {
      const { workspace, base, target, paths } = makeChangedFiles(3, 2);
      const worktree = new NoScanWorktree(workspace.worktree);
      const before = paths.map((path) =>
        utf8Decoder.decode(workspace.worktree.readFile(`/${path}`)),
      );

      expect(() =>
        checkout(selectedResultContext(workspace, transform), workspace.repo, worktree, {
          ref: target,
        }),
      ).toThrow(CorruptError);
      expect(workspace.repo.head().oid).toBe(base);
      expect(worktree.writes).toEqual([]);
      expect(worktree.removals).toEqual([]);
      expect(
        paths.map((path) => utf8Decoder.decode(workspace.worktree.readFile(`/${path}`))),
      ).toEqual(before);
    };

    assertRejected((result) => ({
      ...result,
      index: result.index.map((entry, index) => (index === 0 ? { ...entry, stage: 5 } : entry)),
    }));
    assertRejected((result) => ({
      ...result,
      index: result.index.map((entry, index) =>
        index === 0 ? { ...entry, path: "invalid\ud800path" } : entry,
      ),
    }));
    assertRejected((result) => ({ ...result, index: [...result.index, ...result.index] }));
    assertRejected((result) => ({ ...result, worktree: [...result.worktree].reverse() }));
    assertRejected((result) => ({
      ...result,
      worktree: [
        ...result.worktree,
        {
          path: "unrelated.txt",
          stat: {
            type: "file",
            mode: 0o100644,
            size: 0,
            mtime: 0,
            ino: 1,
            nlink: 1,
            rev: 0,
            target: null,
            contentId: null,
          },
        },
      ],
    }));
  });

  it("uses exact selected facts for non-structural additions and deletions", () => {
    const workspace = makeRepo("/");
    configureFixtureIdentity(workspace);
    writeWorkFile(workspace, "/deleted.txt", "deleted\n");
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    stageWorktreePaths(workspace, ["deleted.txt", "kept.txt"]);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;

    workspace.worktree.unlink("/deleted.txt");
    workspace.repo.checkout.indexRemove("deleted.txt");
    writeWorkFile(workspace, "/added.txt", "added\n");
    stageWorktreePaths(workspace, ["added.txt"]);
    const target = commit(workspace.context, workspace.repo, { message: "target" }).oid;
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: base, force: true });
    sealIndexTracker(workspace);

    const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };
    const worktree = new NoScanWorktree(workspace.worktree);
    checkout(selectedCheckoutContext(workspace, calls), workspace.repo, worktree, { ref: target });
    expectFile(workspace, "/added.txt", "added\n");
    expect(workspace.worktree.stat("/deleted.txt")).toBeNull();
    expectFile(workspace, "/kept.txt", "kept\n");

    checkout(selectedCheckoutContext(workspace, calls), workspace.repo, worktree, {
      ref: base,
      force: true,
    });
    expect(workspace.worktree.stat("/added.txt")).toBeNull();
    expectFile(workspace, "/deleted.txt", "deleted\n");
    expect(calls).toMatchObject({ statements: [2, 2], hydrates: 0 });
  });

  it("uses the exact selected path across a shallow commit boundary", () => {
    const fixture = makeChangedFiles(2, 1);
    fixture.workspace.repo.store.setShallow([fixture.base]);
    const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };

    checkout(
      selectedCheckoutContext(fixture.workspace, calls),
      fixture.workspace.repo,
      fixture.workspace.worktree,
      { ref: fixture.target },
    );

    expect(fixture.workspace.repo.head().oid).toBe(fixture.target);
    expect(fixture.workspace.repo.shallow()).toEqual(new Set([fixture.base]));
    expect(calls).toMatchObject({ statements: [2], hydrates: 0 });
  });

  it("uses legacy force to restore a dirty tracked path outside the tree diff", () => {
    const { workspace, target, paths } = makeChangedFiles(2, 1);
    const unchanged = paths[1];
    if (unchanged === undefined) throw new Error("missing unchanged force fixture path");
    writeWorkFile(workspace, `/${unchanged}`, "local\n");
    const worktree = new LegacyScanWorktree(workspace.worktree);

    checkout(sparseTrackerContext(workspace), workspace.repo, worktree, {
      ref: target,
      force: true,
    });

    expect(worktree.scans.some((scan) => scan.limit > 1)).toBe(true);
    expectFile(workspace, `/${paths[0]}`, "after\n");
    expectFile(workspace, `/${unchanged}`, "before\n");
    expect(workspace.repo.head().oid).toBe(target);
    for (const path of paths) {
      const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path, { write: false });
      expect(workspace.repo.checkout.indexGet(path)?.oid).toBe(hashed?.oid);
      expect(workspace.repo.checkout.indexGet(path)?.mode.toString(8)).toBe(hashed?.mode);
    }
  });

  it.each(scaleCases)(
    "matches legacy for %i %s changes in both directions through exact selected facts",
    (changedFiles, shape) => {
      const sparse = makeScaleChangedFiles(changedFiles, shape);
      const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };
      const worktree = new NoScanWorktree(sparse.workspace.worktree);
      const baseTree = sparse.workspace.repo.readCommit(sparse.base).tree;
      const targetTree = sparse.workspace.repo.readCommit(sparse.target).tree;

      sparse.workspace.storage.resetCounters();
      const forwardDiff = [...sparse.workspace.repo.walkTreeDiff(baseTree, targetTree)];
      expect(forwardDiff.map((entry) => entry.path)).toEqual(sparse.changedPaths);
      expect(sparse.workspace.storage.statementCount).toBe(1);

      sparse.workspace.storage.resetCounters();
      const reverseDiff = [...sparse.workspace.repo.walkTreeDiff(targetTree, baseTree)];
      expect(reverseDiff.map((entry) => entry.path)).toEqual(sparse.changedPaths);
      expect(sparse.workspace.storage.statementCount).toBe(1);

      sparse.workspace.storage.resetCounters();
      checkout(selectedCheckoutContext(sparse.workspace, calls), sparse.workspace.repo, worktree, {
        ref: sparse.target,
      });
      const forwardStatements = sparse.workspace.storage.statementCount;

      expect(worktree.writes).toEqual(sparse.changedPaths.map((path) => `/${path}`));
      expect(worktree.removals).toEqual([]);
      expect(worktree.reads).toBe(0);
      expect(worktree.rangeReads).toBe(0);
      expect(worktree.bulkReadPaths).toEqual([]);
      expect(forwardStatements).toBeLessThan(1_000);
      const selectedForward = checkoutState(sparse.workspace);

      worktree.writes.length = 0;
      sparse.workspace.storage.resetCounters();
      checkout(selectedCheckoutContext(sparse.workspace, calls), sparse.workspace.repo, worktree, {
        ref: sparse.base,
        force: true,
      });
      const reverseStatements = sparse.workspace.storage.statementCount;

      expect(worktree.writes).toEqual(sparse.changedPaths.map((path) => `/${path}`));
      expect(reverseStatements).toBeLessThan(1_000);
      const selectedReverse = checkoutState(sparse.workspace);
      expect(calls.hydrates).toBe(0);
      expect(calls.statements).toEqual([2, 2]);
      expect(calls.requests).toHaveLength(2);
      for (const request of calls.requests) {
        expect(request.specs).toHaveLength(changedFiles);
        expect(request.specs.every((spec) => !spec.recursive)).toBe(true);
        expect(request.specs.map((spec) => spec.path)).toEqual(
          [...request.specs.map((spec) => spec.path)].sort(comparePaths),
        );
      }
      expect(
        sparse.workspace.context.sparseWorkspace?.readState(
          sparse.workspace.repo.checkout.checkoutId,
        ),
      ).toEqual({ available: true, baselineTreeOid: sparse.workspace.repo.headTree() });
      expect([
        ...sparse.workspace.context.sparseWorkspace!.dirtyPaths(
          sparse.workspace.repo.checkout.checkoutId,
        ),
      ]).toEqual([]);

      checkout(
        withoutSparseCheckout(sparse.workspace.context),
        sparse.workspace.repo,
        sparse.workspace.worktree,
        { ref: sparse.target, force: true },
      );
      expect(checkoutState(sparse.workspace)).toEqual(selectedForward);
      checkout(
        withoutSparseCheckout(sparse.workspace.context),
        sparse.workspace.repo,
        sparse.workspace.worktree,
        { ref: sparse.base, force: true },
      );
      expect(checkoutState(sparse.workspace)).toEqual(selectedReverse);
    },
  );

  it("matches structural checkout semantics for clean force", () => {
    const workspace = makeRepo("/");
    configureFixtureIdentity(workspace);
    writeWorkFile(workspace, "/node", "flat\n");
    writeWorkFile(workspace, "/deleted/old.txt", "old\n");
    writeWorkFile(workspace, "/mode.txt", "mode\n");
    workspace.worktree.symlink("before", "/link");
    stageWorktreePaths(workspace, ["deleted/old.txt", "link", "mode.txt", "node"]);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    workspace.repo.store.setRef("refs/heads/base", base);

    workspace.worktree.unlink("/node");
    workspace.repo.checkout.indexRemove("node");
    writeWorkFile(workspace, "/node/child.txt", "nested\n");
    workspace.worktree.unlink("/deleted/old.txt");
    workspace.worktree.rmdir("/deleted");
    workspace.repo.checkout.indexRemove("deleted/old.txt");
    writeWorkFile(workspace, "/added/new.txt", "new\n");
    workspace.worktree.chmod("/mode.txt", 0o755);
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    stageWorktreePaths(workspace, ["added/new.txt", "link", "mode.txt", "node/child.txt"]);
    const target = commit(workspace.context, workspace.repo, { message: "target" }).oid;

    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: base, force: true });
    sealIndexTracker(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);
    const calls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };
    checkout(selectedCheckoutContext(workspace, calls), workspace.repo, worktree, {
      ref: target,
      force: true,
    });

    expect(workspace.worktree.stat("/node")?.type).toBe("dir");
    expectFile(workspace, "/node/child.txt", "nested\n");
    expect(workspace.worktree.stat("/deleted")).toBeNull();
    expectFile(workspace, "/added/new.txt", "new\n");
    expect((workspace.worktree.stat("/mode.txt")?.mode ?? 0) & 0o777).toBe(0o755);
    expect(workspace.worktree.readlink("/link")).toBe("after");

    worktree.writes.length = 0;
    worktree.removals.length = 0;
    checkout(selectedCheckoutContext(workspace, calls), workspace.repo, worktree, {
      ref: base,
      force: true,
    });
    expect(workspace.worktree.stat("/node")?.type).toBe("file");
    expectFile(workspace, "/node", "flat\n");
    expectFile(workspace, "/deleted/old.txt", "old\n");
    expect(workspace.worktree.stat("/added")).toBeNull();
    expect((workspace.worktree.stat("/mode.txt")?.mode ?? 0) & 0o777).toBe(0o644);
    expect(workspace.worktree.readlink("/link")).toBe("before");
    expect(calls.requests).toEqual([]);
    expect(calls.hydrates).toBe(2);
  });

  it("falls back before mutation for dirty, unavailable, oversized, conflict, and gitlink state", () => {
    const dirty = makeChangedFiles(2, 1);
    writeWorkFile(dirty.workspace, `/${dirty.paths[0]}`, "local\n");
    const dirtyWorktree = new NoScanWorktree(dirty.workspace.worktree);
    expect(() =>
      checkout(sparseTrackerContext(dirty.workspace), dirty.workspace.repo, dirtyWorktree, {
        ref: dirty.target,
      }),
    ).toThrow(/must not scan/);
    expect(dirtyWorktree.writes).toEqual([]);
    expect(dirtyWorktree.removals).toEqual([]);
    expect(dirty.workspace.repo.head().oid).toBe(dirty.base);

    const unavailable = makeChangedFiles(2, 1);
    const source = requireSparseWorkspace(unavailable.workspace);
    const unavailableSource: SparseWorkspaceSource = {
      readState: (checkoutId) => source.readState(checkoutId),
      dirtyPaths: (checkoutId) => source.dirtyPaths(checkoutId),
      hydrate: () => ({ available: false }),
    };
    const unavailableWorktree = new NoScanWorktree(unavailable.workspace.worktree);
    expect(() =>
      checkout(
        sparseTrackerContext(unavailable.workspace, unavailableSource),
        unavailable.workspace.repo,
        unavailableWorktree,
        { ref: unavailable.target },
      ),
    ).toThrow(/must not scan/);
    expect(unavailableWorktree.writes).toEqual([]);

    const oversized = makeChangedFiles(1_001, 1_001);
    const oversizedWorktree = new NoScanWorktree(oversized.workspace.worktree);
    const oversizedCalls: SelectedCheckoutCalls = { requests: [], statements: [], hydrates: 0 };
    expect(() =>
      checkout(
        selectedCheckoutContext(oversized.workspace, oversizedCalls),
        oversized.workspace.repo,
        oversizedWorktree,
        { ref: oversized.target },
      ),
    ).toThrow(/must not scan/);
    expect(oversizedWorktree.writes).toEqual([]);
    expect(oversizedCalls).toEqual({ requests: [], statements: [], hydrates: 0 });

    const conflicted = makeChangedFiles(2, 1);
    const oid = conflicted.workspace.repo.store.write("blob", utf8.encode("stage\n"));
    conflicted.workspace.repo.checkout.indexPut({
      path: "conflict.txt",
      stage: 2,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });
    sealIndexTracker(conflicted.workspace);
    const conflictWorktree = new NoScanWorktree(conflicted.workspace.worktree);
    expect(() =>
      checkout(
        sparseTrackerContext(conflicted.workspace),
        conflicted.workspace.repo,
        conflictWorktree,
        { ref: conflicted.target },
      ),
    ).toThrow(/must not scan/);
    expect(conflictWorktree.writes).toEqual([]);

    const gitlinked = makeChangedFiles(2, 1);
    gitlinked.workspace.repo.checkout.indexPut({
      path: "module",
      stage: 0,
      mode: 0o160000,
      oid: gitlinked.base,
      size: null,
      mtime: null,
      ino: null,
    });
    sealIndexTracker(gitlinked.workspace);
    const gitlinkWorktree = new NoScanWorktree(gitlinked.workspace.worktree);
    expect(() =>
      checkout(
        sparseTrackerContext(gitlinked.workspace),
        gitlinked.workspace.repo,
        gitlinkWorktree,
        { ref: gitlinked.target },
      ),
    ).toThrow(/must not scan/);
    expect(gitlinkWorktree.writes).toEqual([]);
  });

  it("propagates corrupt hydration and hash failures before mutation", () => {
    const corrupt = makeChangedFiles(2, 1);
    const source = requireSparseWorkspace(corrupt.workspace);
    const corruptSource: SparseWorkspaceSource = {
      readState: (checkoutId) => source.readState(checkoutId),
      dirtyPaths: (checkoutId) => source.dirtyPaths(checkoutId),
      hydrate(request) {
        const result = source.hydrate(request);
        if (!result.available) return result;
        return {
          available: true,
          rows: result.rows.map((row, index) =>
            index === 0 ? { ...row, path: `${row.path}.wrong` } : row,
          ),
        };
      },
    };
    const corruptWorktree = new NoScanWorktree(corrupt.workspace.worktree);
    expect(() =>
      checkout(
        sparseTrackerContext(corrupt.workspace, corruptSource),
        corrupt.workspace.repo,
        corruptWorktree,
        { ref: corrupt.target },
      ),
    ).toThrow(CorruptError);
    expect(corruptWorktree.writes).toEqual([]);
    expect(corruptWorktree.removals).toEqual([]);

    const hashing = makeChangedFiles(2, 1);
    writeWorkFile(hashing.workspace, `/${hashing.paths[0]}`, "before\n");
    sealIndexTracker(hashing.workspace);
    const hashingWorktree = new FailingHashWorktree(hashing.workspace.worktree);
    expect(() =>
      checkout(sparseTrackerContext(hashing.workspace), hashing.workspace.repo, hashingWorktree, {
        ref: hashing.target,
      }),
    ).toThrow(/hash failure/);
    expect(hashingWorktree.writes).toEqual([]);
    expect(hashingWorktree.removals).toEqual([]);
  });

  it("bounds an emptiness probe in a wide directory and preserves its siblings", () => {
    const workspace = makeRepo("/");
    configureFixtureIdentity(workspace);
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
    workspace.repo.checkout.indexReplace(original);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    workspace.repo.checkout.indexReplace(original.slice(1));
    const target = commit(workspace.context, workspace.repo, { message: "delete one" }).oid;
    workspace.repo.checkout.indexReplace(original);
    workspace.repo.checkout.setHead(base);
    sealIndexTracker(workspace);
    const worktree = new NoScanWorktree(workspace.worktree, () => workspace.storage.statementCount);

    workspace.storage.resetCounters();
    checkout(sparseTrackerContext(workspace), workspace.repo, worktree, { ref: target });

    expect(worktree.scanProbes).toEqual([{ root: "/wide", limit: 1, rows: 1, statements: 2 }]);
    expect(worktree.statProbes).toEqual([{ path: "/wide", statements: 2 }]);
    expect(
      (worktree.statProbes[0]?.statements ?? 0) + (worktree.scanProbes[0]?.statements ?? 0),
    ).toBeLessThan(1_000);
    expect(workspace.storage.rowCount).toBeLessThan(10_000);
    expect(workspace.worktree.stat("/wide")?.type).toBe("dir");
    expect(workspace.worktree.stat("/wide/delete.txt")).toBeNull();
    expect(workspace.worktree.stat(`/${siblingPaths[0]}`)?.type).toBe("file");
    expect(workspace.repo.head().oid).toBe(target);
  });

  it("keeps the selected plan past the former prune SQL budget", () => {
    const workspace = makeRepo("/");
    configureFixtureIdentity(workspace);
    // The old two-SQL charge admitted this 1,531-statement prune.
    const paths = Array.from(
      { length: 296 },
      (_, index) => `d${index.toString().padStart(3, "0")}/file.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "tracked\n");
    stageWorktreePaths(workspace, paths);
    const base = commit(workspace.context, workspace.repo, { message: "base" }).oid;
    workspace.repo.store.setRef("refs/heads/base", base);
    workspace.worktree.removeFiles(paths.map((path) => `/${path}`));
    workspace.repo.checkout.indexClear();
    const target = commit(workspace.context, workspace.repo, { message: "delete" }).oid;
    checkout(workspace.context, workspace.repo, workspace.worktree, { ref: base, force: true });
    sealIndexTracker(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);

    checkout(sparseTrackerContext(workspace), workspace.repo, worktree, { ref: target });

    expect(worktree.writes).toEqual([]);
    expect(worktree.removals).toEqual([
      ...paths.map((path) => `/${path}`),
      ...paths.map((path) => `/${path.slice(0, path.indexOf("/"))}`),
    ]);
    expect(workspace.repo.checkout.indexEntries()).toEqual([]);
    expect(paths.every((path) => workspace.worktree.stat(`/${path}`) === null)).toBe(true);
    expect(workspace.repo.head().oid).toBe(target);
  });

  it("does not fall back or reseal when sparse apply fails", () => {
    const { workspace, target } = makeChangedFiles(2, 1);
    const source = requireSparseWorkspace(workspace);
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

  it("rolls sparse apply, HEAD, history, and tracker publication back together", () => {
    const { workspace, base, target, paths } = makeChangedFiles(2, 1);
    const source = requireSparseWorkspace(workspace);
    const path = paths[0];
    if (path === undefined) throw new Error("sparse rollback path missing");
    const before = {
      head: workspace.repo.checkout.head(),
      index: workspace.repo.checkout.indexGet(path),
      content: utf8Decoder.decode(workspace.worktree.readFile(`/${path}`)),
      entries: workspace.database.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
      ordinal: workspace.database.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    };
    const context: GitContext = {
      ...workspace.context,
      sparseWorkspace: source,
      indexTracker: {
        reseal() {
          throw new Error("injected tracker reseal failure");
        },
      },
    };
    const worktree = new NoScanWorktree(workspace.worktree);

    expect(() => checkout(context, workspace.repo, worktree, { ref: target })).toThrow(
      /tracker reseal failure/,
    );

    expect(base).not.toBe(target);
    expect(workspace.repo.checkout.head()).toBe(before.head);
    expect(workspace.repo.checkout.indexGet(path)).toEqual(before.index);
    expect(utf8Decoder.decode(workspace.worktree.readFile(`/${path}`))).toBe(before.content);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(before.entries);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(before.ordinal);
  });
});
