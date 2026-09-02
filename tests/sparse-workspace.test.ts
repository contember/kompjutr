import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../src/db/db.js";
import { MODE_FILE, MODE_TREE, serializeTree } from "../src/git/common/objects.js";
import { comparePaths } from "../src/git/common/streams.js";
import { commit } from "../src/git/ops/commit.js";
import { add } from "../src/git/ops/staging.js";
import {
  INDEX_DIRTY,
  invalidateIndexTracker,
  resealIndexTracker,
} from "../src/git/store/index-tracker.js";
import {
  createSqliteCommitTreeSnapshotSource,
  createSqliteSelectedPathSource,
  createSqliteSparseWorkspaceSource,
  hasSparseSourceReceipt,
  hydrateSparseWorkspaceOwned,
  SPARSE_TREE_DEPTH_SQL,
  selectSparsePathsOwned,
  snapshotCommitTreeOwned,
  sparseIndexAncestorFactsOwned,
} from "../src/git/store/sparse-workspace.js";
import { makeRepo, writeWorkFile } from "./helpers/workspace.js";

class ExplainSelectedDatabase implements SqlDatabase {
  readonly details: string[] = [];
  readonly queries: string[] = [];

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
    if (query.startsWith("WITH wanted(path)") || query.startsWith("WITH wanted(relative)")) {
      this.queries.push(query);
      for (const row of this.delegate.all<{ detail: unknown }>(
        `EXPLAIN QUERY PLAN ${query}`,
        ...bindings,
      )) {
        if (typeof row.detail === "string") this.details.push(row.detail);
      }
    }
    yield* this.delegate.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

class ExplainSnapshotDatabase implements SqlDatabase {
  readonly details: string[] = [];
  queries = 0;

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
    if (query.includes("wanted_source_key")) {
      this.queries++;
      for (const row of this.delegate.all<{ detail: unknown }>(
        `EXPLAIN QUERY PLAN ${query}`,
        ...bindings,
      )) {
        if (typeof row.detail === "string") this.details.push(row.detail);
      }
    }
    yield* this.delegate.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

class ExplainIndexAncestorDatabase implements SqlDatabase {
  readonly details: string[] = [];
  query = "";

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
    if (query.startsWith("WITH wanted(ordinal, path)")) {
      this.query = query;
      for (const row of this.delegate.all<{ detail: unknown }>(
        `EXPLAIN QUERY PLAN ${query}`,
        ...bindings,
      )) {
        if (typeof row.detail === "string") this.details.push(row.detail);
      }
    }
    yield* this.delegate.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

class RecordingIndexAncestorDatabase implements SqlDatabase {
  query = "";

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
    if (query.startsWith("WITH wanted(ordinal, path)")) this.query = query;
    yield* this.delegate.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

class RecordingTreeDepthDatabase implements SqlDatabase {
  readonly payloads: string[] = [];

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

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    const payload = bindings[0];
    if (query === SPARSE_TREE_DEPTH_SQL && typeof payload === "string") {
      this.payloads.push(payload);
    }
    return this.delegate.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

function committedWorkspace() {
  const workspace = makeRepo("/");
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  writeWorkFile(workspace, "/a.txt", "a\n");
  writeWorkFile(workspace, "/dir/b.txt", "b\n");
  workspace.worktree.symlink("a.txt", "/link");
  add(workspace.repo, workspace.worktree, { paths: [], all: true });
  commit(workspace.context, workspace.repo, { message: "initial" });
  return workspace;
}

function installPackCopy(
  workspace: ReturnType<typeof committedWorkspace>,
  tree: string,
  packId: number,
): void {
  const repoId = workspace.repo.store.repoId;
  workspace.database.db.transactionSync(() => {
    workspace.database.db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, ?, 0, 1, 'pending', 0)`,
      repoId,
      packId,
    );
    workspace.database.db.run(
      `INSERT INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       SELECT repo_id, oid, ?, 0, 0, 0, type, size, 0, NULL
         FROM git_objects WHERE repo_id = ? AND oid = ?`,
      packId,
      repoId,
      tree,
    );
    workspace.database.db.run(
      `INSERT INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
       SELECT repo_id, tree_oid, 'pack', ?, 1, object_size, entry_count, base_cost
         FROM git_tree_sources
        WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose'`,
      packId,
      repoId,
      tree,
    );
    workspace.database.db.run(
      `INSERT INTO git_tree_entries
         (source_key, ordinal, mode, name_bytes, oid, raw_entry, cumulative_base)
       SELECT packed.source_key, entry.ordinal, entry.mode, entry.name_bytes, entry.oid,
              entry.raw_entry, entry.cumulative_base
         FROM git_tree_entries entry
         JOIN git_tree_sources loose ON loose.source_key = entry.source_key
         JOIN git_tree_sources packed
           ON packed.repo_id = loose.repo_id AND packed.tree_oid = loose.tree_oid
          AND packed.storage = 'pack' AND packed.source_id = ?
        WHERE loose.repo_id = ? AND loose.tree_oid = ? AND loose.storage = 'loose'`,
      packId,
      repoId,
      tree,
    );
    workspace.database.db.run(
      "UPDATE git_pack_meta SET state = 'complete' WHERE repo_id = ? AND pack_id = ?",
      repoId,
      packId,
    );
    workspace.database.db.run(
      "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
      repoId,
      tree,
    );
  });
}

describe("SQLite sparse workspace source", () => {
  it("trusts only frozen native source identities from the exact database", () => {
    const first = committedWorkspace();
    const second = committedWorkspace();
    const selected = createSqliteSelectedPathSource(first.database.db);
    const workspace = createSqliteSparseWorkspaceSource(first.database.db);
    const trees = createSqliteCommitTreeSnapshotSource(first.database.db);

    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.isFrozen(trees)).toBe(true);
    expect(hasSparseSourceReceipt(first.database.db, "selected-paths", selected)).toBe(true);
    expect(hasSparseSourceReceipt(first.database.db, "workspace", workspace)).toBe(true);
    expect(hasSparseSourceReceipt(first.database.db, "commit-tree", trees)).toBe(true);

    const spread = { ...selected };
    const wrapped = {
      select: (request: Parameters<typeof selected.select>[0]) => selected.select(request),
    };
    const custom = { select: selected.select };
    expect(hasSparseSourceReceipt(first.database.db, "selected-paths", spread)).toBe(false);
    expect(hasSparseSourceReceipt(first.database.db, "selected-paths", wrapped)).toBe(false);
    expect(hasSparseSourceReceipt(first.database.db, "selected-paths", custom)).toBe(false);
    expect(hasSparseSourceReceipt(second.database.db, "selected-paths", selected)).toBe(false);
    expect(hasSparseSourceReceipt(first.database.db, "workspace", selected)).toBe(false);
  });
  it("returns unavailable before retaining a selected projection's 1001st row", () => {
    const workspace = makeRepo("/");
    workspace.worktree.writeFiles(
      Array.from({ length: 1_000 }, (_, index) => ({
        path: `/overflow/f${index.toString().padStart(4, "0")}.txt`,
        bytes: new Uint8Array([index & 0xff]),
      })),
    );
    const result = createSqliteSelectedPathSource(workspace.database.db).select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: [{ path: "overflow", recursive: true }],
    });
    expect(result).toEqual({ available: false });
  });

  it("selects exact and recursive facts in two bounded ordered statements", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSelectedPathSource(workspace.database.db);
    workspace.storage.resetCounters();

    const result = source.select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: [
        { path: "a.txt", recursive: false },
        { path: "dir", recursive: true },
      ],
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(workspace.storage.statementCount).toBe(4);
    expect(result.index.map((entry) => entry.path)).toEqual(["a.txt", "dir/b.txt"]);
    expect(result.worktree.map((entry) => entry.path)).toEqual(["a.txt", "dir", "dir/b.txt"]);
  });

  it("deduplicates overlaps, preserves conflict stages, and keeps Git byte order", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSelectedPathSource(workspace.database.db);
    const index = workspace.database.db.one<{ mode: number; oid: string }>(
      "SELECT mode, oid FROM git_index WHERE checkout_id = ? AND path = 'a.txt' AND stage = 0",
      workspace.repo.checkout.checkoutId,
    );
    if (index === undefined) throw new Error("missing fixture index row");
    workspace.database.db.run(
      "DELETE FROM git_index WHERE checkout_id = ? AND path = 'a.txt'",
      workspace.repo.checkout.checkoutId,
    );
    for (const stage of [1, 2, 3]) {
      workspace.database.db.run(
        `INSERT INTO git_index (checkout_id, path, stage, mode, oid)
         VALUES (?, 'a.txt', ?, ?, ?)`,
        workspace.repo.checkout.checkoutId,
        stage,
        index.mode,
        index.oid,
      );
    }
    const ordered = ["\u{10000}.txt", "\ue000.txt"].sort(comparePaths);
    for (const path of ordered) writeWorkFile(workspace, `/${path}`, path);
    add(workspace.repo, workspace.worktree, { paths: ordered });

    const result = source.select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: [
        { path: "a.txt", recursive: false },
        { path: "dir", recursive: true },
        { path: "dir/b.txt", recursive: false },
        ...ordered.map((path) => ({ path, recursive: false })),
      ].sort((left, right) => comparePaths(left.path, right.path)),
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(
      result.index.filter((entry) => entry.path === "a.txt").map((entry) => entry.stage),
    ).toEqual([1, 2, 3]);
    expect(result.index.filter((entry) => entry.path === "dir/b.txt")).toHaveLength(1);
    expect(result.worktree.map((entry) => entry.path)).toEqual(
      [...result.worktree.map((entry) => entry.path)].sort(comparePaths),
    );

    const exactSpecs = ["a.txt", "dir/b.txt", ...ordered]
      .sort(comparePaths)
      .map((path) => ({ path, recursive: false }));
    workspace.storage.resetCounters();
    const exact = source.select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: exactSpecs,
    });
    expect(workspace.storage.statementCount).toBe(4);
    workspace.storage.resetCounters();
    const general = source.select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: exactSpecs.map((spec) => ({ ...spec, recursive: true })),
    });
    expect(workspace.storage.statementCount).toBe(4);
    expect(exact).toEqual(general);
  });

  it("deduplicates exact ancestors, includes parents above a nested checkout, and retries general selection", () => {
    const nested = makeRepo("/outer/repo");
    nested.repo.store.configSet("user.name", "Fixture");
    nested.repo.store.configSet("user.email", "fixture@example.com");
    writeWorkFile(nested, "/outer/repo/dir/a.txt", "a\n");
    add(nested.repo, nested.worktree, { paths: [], all: true });
    commit(nested.context, nested.repo, { message: "nested" });
    const source = createSqliteSelectedPathSource(nested.database.db);
    const request = {
      repoId: nested.repo.store.repoId,
      checkoutId: nested.repo.checkout.checkoutId,
      root: "/outer/repo",
      specs: [
        { path: "dir/a.txt", recursive: false },
        { path: "dir/missing.txt", recursive: false },
      ],
    };

    nested.storage.resetCounters();
    const result = source.select(request);
    expect(nested.storage.statementCount).toBe(4);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.index.map((entry) => entry.path)).toEqual(["dir/a.txt"]);
      expect(result.worktree.map((entry) => entry.path)).toEqual(["dir/a.txt"]);
    }

    const fallback = committedWorkspace();
    const fallbackSource = createSqliteSelectedPathSource(fallback.database.db);
    const histogram = new Map<string, number>();
    fallback.storage.histogram = histogram;
    const expectBranch = (
      specs: Array<{ path: string; recursive: boolean }>,
      branch: "exact" | "general",
    ): void => {
      fallback.storage.resetCounters();
      expect(
        fallbackSource.select({
          repoId: fallback.repo.store.repoId,
          checkoutId: fallback.repo.checkout.checkoutId,
          root: "/",
          specs,
        }),
      ).toMatchObject({ available: true, index: [], worktree: [] });
      expect(fallback.storage.statementCount).toBe(4);
      expect(
        [...histogram.keys()].some((query) => query.startsWith("WITH wanted(path, recursive)")),
      ).toBe(branch === "general");
      expect([...histogram.keys()].some((query) => query.startsWith("WITH wanted(path) AS"))).toBe(
        branch === "exact",
      );
    };

    const deepPrefix = Array.from({ length: 40 }, (_, index) => `d${index}`).join("/");
    expectBranch(
      Array.from({ length: 1_000 }, (_, index) => ({
        path: `f${index.toString().padStart(4, "0")}/${deepPrefix}/leaf`,
        recursive: false,
      })).sort((left, right) => comparePaths(left.path, right.path)),
      "general",
    );

    const longSegments = ["a", "b", "c", "d"].map((letter) => letter.repeat(200));
    expectBranch(
      Array.from({ length: 1_000 }, (_, index) => ({
        path: `j${index.toString().padStart(4, "0")}/${longSegments.join("/")}`,
        recursive: false,
      })).sort((left, right) => comparePaths(left.path, right.path)),
      "exact",
    );
  });

  it("plans exact index, worktree, and ancestor facts as primary-key searches", () => {
    const workspace = committedWorkspace();
    const explained = new ExplainSelectedDatabase(workspace.database.db);
    const result = createSqliteSelectedPathSource(explained).select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: [{ path: "dir/b.txt", recursive: false }],
    });

    expect(result.available).toBe(true);
    expect(explained.queries).toHaveLength(2);
    expect(explained.queries[0]).not.toContain("CAST(candidate.path");
    expect(explained.queries[1]).not.toMatch(/CAST\((paths|ancestor)\.path/);
    expect(
      explained.details.some(
        (detail) => detail.includes("SEARCH candidate") && detail.includes("checkout_id="),
      ),
      explained.details.join("\n"),
    ).toBe(true);
    expect(
      explained.details.some((detail) => /SCAN (candidate|paths|ancestor)(?:\s|$)/.test(detail)),
    ).toBe(false);
  });

  it("returns exact index and worktree facts for 1000 shared paths", () => {
    const workspace = makeRepo("/");
    const directory = Array.from(
      { length: 5 },
      (_, index) => `shared-segment-${index.toString().padStart(2, "0")}`,
    ).join("/");
    const paths = Array.from(
      { length: 1_000 },
      (_, index) => `${directory}/f${index.toString().padStart(4, "0")}.txt`,
    );
    workspace.worktree.mkdir(`/${directory}`, { recursive: true });
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes: new Uint8Array([0x61]) })),
    );
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    const histogram = new Map<string, number>();
    workspace.storage.histogram = histogram;
    workspace.storage.resetCounters();

    const result = createSqliteSelectedPathSource(workspace.database.db).select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: paths.map((path) => ({ path, recursive: false })),
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.index).toHaveLength(1_000);
    expect(result.worktree).toHaveLength(1_000);
    expect(workspace.storage.statementCount).toBe(4);
    expect(workspace.storage.rowCount).toBeGreaterThanOrEqual(2_000);
    expect([...histogram.keys()].some((query) => query.startsWith("WITH wanted(path)"))).toBe(true);
    expect([...histogram.keys()].some((query) => query.startsWith("WITH wanted(relative)"))).toBe(
      true,
    );
    expect(
      [...histogram.keys()].some((query) => query.includes("wanted(relative, recursive)")),
    ).toBe(false);
  });

  it("resolves exact stages and descendant witnesses through primary-key searches", () => {
    const workspace = makeRepo("/");
    const oid = "1".repeat(40);
    for (const path of ["a", "a/b"]) {
      workspace.repo.checkout.indexPut({
        path,
        stage: 0,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      });
    }
    for (const stage of [1, 2, 3]) {
      workspace.repo.checkout.indexPut({
        path: "conflict",
        stage,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      });
    }
    const explained = new ExplainIndexAncestorDatabase(workspace.database.db);
    const lookup = createSqliteSparseWorkspaceSource(explained).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");

    expect(
      lookup({
        checkoutId: workspace.repo.checkout.checkoutId,
        ancestors: ["a", "conflict", "missing"],
      }).facts,
    ).toEqual([
      { path: "a", exact: true, descendant: true },
      { path: "conflict", exact: true, descendant: false },
      { path: "missing", exact: false, descendant: false },
    ]);
    expect(explained.query).toContain("EXISTS");
    expect(explained.details.some((detail) => detail.includes("SEARCH entry USING"))).toBe(true);
    expect(explained.details.some((detail) => /SCAN entry(?:\s|$)/.test(detail))).toBe(false);
  });

  it("keeps one hundred exact probes independent of a 24,252-row index", () => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
    workspace.database.db.run(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (0)
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 24251
       )
       INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, printf('p%03d/f%03d.ts', value / 243, value % 243), 0, 33188, ?,
              NULL, NULL, NULL, NULL
         FROM sequence`,
      checkoutId,
      "1".repeat(40),
    );
    const paths = Array.from({ length: 100 }, (_, index) => {
      const value = index * 243;
      return `p${Math.floor(value / 243)
        .toString()
        .padStart(3, "0")}/f${(value % 243).toString().padStart(3, "0")}.ts`;
    });
    const recorded = new RecordingIndexAncestorDatabase(workspace.database.db);
    const lookup = createSqliteSparseWorkspaceSource(recorded).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();

    const result = lookup({ checkoutId, ancestors: paths });

    expect(result.facts).toEqual(paths.map((path) => ({ path, exact: true, descendant: false })));
    expect(workspace.storage.statementCount).toBe(1);
    expect(workspace.storage.rowCount).toBe(100);
    expect(recorded.query).toContain("EXISTS");
  });

  it("returns one page of ancestor facts and rejects the first excess before SQL", () => {
    const workspace = makeRepo("/");
    const recorded = new RecordingIndexAncestorDatabase(workspace.database.db);
    const lookup = createSqliteSparseWorkspaceSource(recorded).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");
    const paths = Array.from(
      { length: 1_001 },
      (_, index) => `p${index.toString().padStart(4, "0")}`,
    );

    workspace.storage.resetCounters();
    expect(
      lookup({
        checkoutId: workspace.repo.checkout.checkoutId,
        ancestors: paths.slice(0, 1_000),
      }).facts,
    ).toHaveLength(1_000);
    expect(workspace.storage.statementCount).toBe(1);
    expect(workspace.storage.rowCount).toBe(1_000);

    workspace.storage.resetCounters();
    expect(() =>
      lookup({ checkoutId: workspace.repo.checkout.checkoutId, ancestors: paths }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("falls back for symlink ancestors and bounds selected request count", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSelectedPathSource(workspace.database.db);
    expect(
      source.select({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "link/child", recursive: false }],
      }),
    ).toEqual({ available: false });

    const exact = Array.from({ length: 1_000 }, (_, index) => ({
      path: `missing-${index.toString().padStart(4, "0")}`,
      recursive: false,
    }));
    expect(
      source.select({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        specs: exact,
      }).available,
    ).toBe(true);
    workspace.storage.resetCounters();
    expect(() =>
      source.select({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        specs: [...exact, { path: "missing-last", recursive: false }].sort((left, right) =>
          comparePaths(left.path, right.path),
        ),
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("projects dirty index rows and baseline directories for commit reuse", () => {
    const workspace = committedWorkspace();
    const baseline = workspace.repo.headTree();
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseline, []),
    ).toBe(true);
    writeWorkFile(workspace, "/a.txt", "changed\n");
    writeWorkFile(workspace, "/dir/b.txt", "changed\n");

    const result = createSqliteCommitTreeSnapshotSource(workspace.database.db).snapshot({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: baseline,
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.dirty.map((entry) => entry.path)).toEqual(["a.txt", "dir/b.txt"]);
    expect(result.index.map((entry) => entry.path)).toEqual(["a.txt", "dir/b.txt"]);
    expect(result.directories.map((directory) => directory.path)).toEqual(["", "dir"]);
    expect(result.directories[0]?.oid).toBe(baseline);
    expect(result.directories[0]?.entries.map((entry) => entry.name)).toEqual([
      "a.txt",
      "dir",
      "link",
    ]);
    expect(result.directories[1]?.entries.map((entry) => entry.name)).toEqual(["b.txt"]);
  });

  it("reads snapshot entries by active source key", () => {
    const workspace = committedWorkspace();
    const baseline = workspace.repo.headTree();
    if (baseline === null) throw new Error("missing snapshot baseline");
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseline, [
        { path: "dir/b.txt", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    const explained = new ExplainSnapshotDatabase(workspace.database.db);

    expect(
      createSqliteCommitTreeSnapshotSource(explained).snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: baseline,
      }).available,
    ).toBe(true);

    expect(explained.queries).toBe(1);
    expect(explained.details.some((detail) => detail.includes("SEARCH entry USING"))).toBe(true);
    expect(explained.details.some((detail) => detail.includes("git_tree_entries_wide"))).toBe(
      false,
    );
  });

  it("authenticates clean, packed, missing, mismatched, incomplete, and unborn baselines", () => {
    const workspace = committedWorkspace();
    const baseline = workspace.repo.headTree();
    if (baseline === null) throw new Error("missing fixture baseline");
    const checkoutId = workspace.repo.checkout.checkoutId;
    expect(resealIndexTracker(workspace.database.db, checkoutId, baseline, [])).toBe(true);
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const request = {
      repoId: workspace.repo.store.repoId,
      checkoutId,
      root: "/",
      baselineTreeOid: baseline,
    };
    const clean = source.snapshot(request);
    expect(clean.available).toBe(true);
    if (!clean.available) return;
    expect(source.snapshot({ ...request, baselineTreeOid: "9".repeat(40) })).toEqual({
      available: false,
    });

    invalidateIndexTracker(workspace.database.db, checkoutId);
    expect(source.snapshot(request)).toEqual({ available: false });
    expect(resealIndexTracker(workspace.database.db, checkoutId, "8".repeat(40), [])).toBe(true);
    expect(source.snapshot({ ...request, baselineTreeOid: "8".repeat(40) })).toEqual({
      available: false,
    });

    const packed = committedWorkspace();
    const packedBaseline = packed.repo.headTree();
    if (packedBaseline === null) throw new Error("missing packed fixture baseline");
    installPackCopy(packed, packedBaseline, 19);
    expect(
      resealIndexTracker(packed.database.db, packed.repo.checkout.checkoutId, packedBaseline, []),
    ).toBe(true);
    expect(
      createSqliteCommitTreeSnapshotSource(packed.database.db).snapshot({
        repoId: packed.repo.store.repoId,
        checkoutId: packed.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: packedBaseline,
      }).available,
    ).toBe(true);

    const unborn = makeRepo("/");
    expect(resealIndexTracker(unborn.database.db, unborn.repo.checkout.checkoutId, null, [])).toBe(
      true,
    );
    expect(
      createSqliteCommitTreeSnapshotSource(unborn.database.db).snapshot({
        repoId: unborn.repo.store.repoId,
        checkoutId: unborn.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
      }).available,
    ).toBe(true);
  });

  it("returns unavailable before retaining the global snapshot result's 1001st row", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const paths = Array.from(
      { length: 1_000 },
      (_, index) => `f${index.toString().padStart(4, "0")}.txt`,
    );
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes: new Uint8Array([1]) })),
    );
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    commit(workspace.context, workspace.repo, { message: "wide tree" });
    const baseline = workspace.repo.headTree();
    if (baseline === null) throw new Error("missing wide-tree baseline");
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseline, [
        { path: paths[0] ?? "", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);

    expect(
      createSqliteCommitTreeSnapshotSource(workspace.database.db).snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: baseline,
      }),
    ).toEqual({ available: false });
  });

  it("admits exactly 1000 aggregate dirty and directory rows, then rejects the first excess", () => {
    const workspace = committedWorkspace();
    const checkoutId = workspace.repo.checkout.checkoutId;
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const exact = Array.from({ length: 999 }, (_, index) => ({
      path: `request-${index.toString().padStart(4, "0")}`,
      flags: INDEX_DIRTY,
    }));
    expect(resealIndexTracker(workspace.database.db, checkoutId, null, exact)).toBe(true);
    const request = {
      repoId: workspace.repo.store.repoId,
      checkoutId,
      root: "/",
      baselineTreeOid: null,
    };
    const result = source.snapshot(request);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.dirty).toHaveLength(999);
    expect(result.directories).toHaveLength(1);

    expect(
      resealIndexTracker(workspace.database.db, checkoutId, null, [
        ...exact,
        { path: "request-last", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    expect(source.snapshot(request)).toEqual({ available: false });
  });

  it("counts derived directories before retaining them", () => {
    const workspace = committedWorkspace();
    const checkoutId = workspace.repo.checkout.checkoutId;
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const exactPath = Array.from({ length: 999 }, () => "d").join("/");
    expect(
      resealIndexTracker(workspace.database.db, checkoutId, null, [
        { path: exactPath, flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    const request = {
      repoId: workspace.repo.store.repoId,
      checkoutId,
      root: "/",
      baselineTreeOid: null,
    };
    const result = source.snapshot(request);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.dirty).toHaveLength(1);
    expect(result.directories).toHaveLength(999);

    expect(
      resealIndexTracker(workspace.database.db, checkoutId, null, [
        { path: `${exactPath}/d`, flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    expect(source.snapshot(request)).toEqual({ available: false });
  });

  it("routes every native sparse facade and preserves custom fallback", () => {
    const workspace = committedWorkspace();
    const selected = createSqliteSelectedPathSource(workspace.database.db);
    const selectedRequest = {
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: [{ path: "a.txt", recursive: false }],
    };
    const selectedResult = selectSparsePathsOwned(selected, selectedRequest);
    expect(selectedResult.available).toBe(true);
    if (!selectedResult.available) throw new Error("owned selected paths were unavailable");
    const fallback = selectSparsePathsOwned(
      { select: (request) => selected.select(request) },
      selectedRequest,
    );
    expect(fallback).toEqual(selectedResult);

    const sparse = createSqliteSparseWorkspaceSource(workspace.database.db);
    const ancestors = sparseIndexAncestorFactsOwned(sparse, {
      checkoutId: workspace.repo.checkout.checkoutId,
      ancestors: ["a.txt"],
    });
    expect(ancestors.facts).toEqual([{ path: "a.txt", exact: true, descendant: false }]);

    const baseline = workspace.repo.headTree();
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseline, []),
    ).toBe(true);
    const snapshot = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const snapshotResult = snapshotCommitTreeOwned(snapshot, {
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: baseline,
    });
    expect(snapshotResult.available).toBe(true);
  });

  it("hydrates exact tree, index, and worktree leaves in path order", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    writeWorkFile(workspace, "/a.txt", "changed\n");

    const result = source.hydrate({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: tree,
      currentTreeOid: tree,
      paths: ["a.txt", "dir/b.txt", "link", "missing.txt"],
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.rows.map((row) => row.path)).toEqual([
      "a.txt",
      "dir/b.txt",
      "link",
      "missing.txt",
    ]);
    expect(result.rows[0]?.baseline).toEqual(result.rows[0]?.current);
    expect(result.rows[0]?.baseline?.mode).toBe("100644");
    expect(result.rows[0]?.index).toHaveLength(1);
    expect(result.rows[0]?.worktree).toMatchObject({ type: "file", size: 8 });
    expect(result.rows[1]?.baseline?.mode).toBe("100644");
    expect(result.rows[2]?.baseline?.mode).toBe("120000");
    expect(result.rows[2]?.worktree).toMatchObject({ type: "symlink", target: "a.txt" });
    expect(result.rows[3]).toMatchObject({
      baseline: null,
      current: null,
      index: [],
      worktree: null,
    });
  });

  it("resolves an equal baseline and current tree only once", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("missing shared tree");
    const recorded = new RecordingTreeDepthDatabase(workspace.database.db);

    const result = createSqliteSparseWorkspaceSource(recorded).hydrate({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: tree,
      currentTreeOid: tree,
      paths: ["dir/b.txt"],
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.rows[0]?.baseline).toEqual(result.rows[0]?.current);
    expect(recorded.payloads).toHaveLength(2);
    expect(recorded.payloads.every((payload) => !payload.includes('"s":"c"'))).toBe(true);
  });

  it("delegates bounded tracker state and dirty paths", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, tree, [
        { path: "a.txt", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);

    expect(source.readState(workspace.repo.checkout.checkoutId)).toEqual({
      available: true,
      baselineTreeOid: tree,
    });
    expect([...source.dirtyPaths(workspace.repo.checkout.checkoutId)]).toEqual([
      { path: "a.txt", flags: INDEX_DIRTY },
    ]);
  });

  it("reads a complete pack source and rejects it once the pack is incomplete", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("missing HEAD tree");
    installPackCopy(workspace, tree, 7);
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const request = {
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: tree,
      currentTreeOid: null,
      paths: ["a.txt"],
    };

    expect(source.hydrate(request).available).toBe(true);
    workspace.database.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = ? AND pack_id = 7",
      workspace.repo.store.repoId,
    );
    expect(source.hydrate(request)).toEqual({ available: false });
  });

  it("does not borrow a packed projection through a corrupt loose shadow", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("missing HEAD tree");
    installPackCopy(workspace, tree, 7);
    const object = workspace.database.db.one<{ size: number }>(
      "SELECT size FROM git_pack_objects WHERE repo_id = ? AND oid = ?",
      workspace.repo.store.repoId,
      tree,
    );
    if (object === undefined) throw new Error("missing packed tree metadata");
    workspace.database.db.run(
      `INSERT INTO git_objects (repo_id, oid, type, size, stored)
       VALUES (?, ?, 'tree', ?, 'raw')`,
      workspace.repo.store.repoId,
      tree,
      object.size,
    );
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toEqual({ available: false });
  });

  it("does not lose an invalid active source-key association", () => {
    const active = committedWorkspace();
    const activeTree = active.repo.headTree();
    active.database.db.run("PRAGMA foreign_keys = OFF");
    active.database.db.run(
      `UPDATE git_tree_effective SET source_key = source_key + 1000000
        WHERE repo_id = ? AND tree_oid = ?`,
      active.repo.store.repoId,
      activeTree,
    );
    active.database.db.run("PRAGMA foreign_keys = ON");
    expect(
      createSqliteSparseWorkspaceSource(active.database.db).hydrate({
        repoId: active.repo.store.repoId,
        checkoutId: active.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: activeTree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toEqual({ available: false });
  });

  it("detects a projected tree cycle before depth fallback", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("missing HEAD tree");
    workspace.database.db.run(
      `UPDATE git_tree_entries SET oid = ?
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose' AND source_id = 0
        ) AND name_bytes = CAST('dir' AS BLOB)`,
      tree,
      workspace.repo.store.repoId,
      tree,
    );
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);

    expect(() =>
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["dir/x"],
      }),
    ).toThrowError(/tree cycle/);
  });

  it("detects a two-source projected tree cycle", () => {
    const workspace = committedWorkspace();
    const root = workspace.repo.headTree();
    if (root === null) throw new Error("missing HEAD tree");
    const child = workspace.database.db.scalar<string>(
      `SELECT oid FROM git_tree_entries_wide
        WHERE repo_id = ? AND tree_oid = ? AND name = 'dir'`,
      workspace.repo.store.repoId,
      root,
    );
    if (child === undefined) throw new Error("missing child tree");
    workspace.database.db.run(
      `UPDATE git_tree_entries SET mode = '40000', oid = ?
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose' AND source_id = 0
        ) AND name_bytes = CAST('b.txt' AS BLOB)`,
      root,
      workspace.repo.store.repoId,
      child,
    );

    expect(() =>
      createSqliteSparseWorkspaceSource(workspace.database.db).hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: root,
        currentTreeOid: null,
        paths: ["dir/b.txt/x"],
      }),
    ).toThrowError(/tree cycle/);
  });

  it("returns all index stages", () => {
    const workspace = committedWorkspace();
    const repoId = workspace.repo.store.repoId;
    const checkoutId = workspace.repo.checkout.checkoutId;
    const oid = "1".repeat(40);
    workspace.database.db.run(
      "DELETE FROM git_index WHERE checkout_id = ? AND path = 'a.txt'",
      checkoutId,
    );
    for (const stage of [1, 2, 3]) {
      workspace.database.db.run(
        `INSERT INTO git_index (checkout_id, path, stage, mode, oid)
         VALUES (?, 'a.txt', ?, ?, ?)`,
        checkoutId,
        stage,
        0o100644,
        oid,
      );
    }
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const request = {
      repoId,
      checkoutId,
      root: "/",
      baselineTreeOid: null,
      currentTreeOid: null,
      paths: ["a.txt"],
    };
    const result = source.hydrate(request);
    expect(result.available).toBe(true);
    if (result.available)
      expect(result.rows[0]?.index.map((entry) => entry.stage)).toEqual([1, 2, 3]);
  });

  it("accepts a former large worktree payload excess", () => {
    const workspace = committedWorkspace();
    workspace.database.db.run(
      "UPDATE fs_nodes SET content_id = zeroblob(4194305) WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/a.txt')",
    );
    const result = hydrateSparseWorkspaceOwned(
      createSqliteSparseWorkspaceSource(workspace.database.db),
      {
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: ["a.txt"],
      },
    );
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("large worktree payload was unavailable");
    expect(result.rows[0]?.worktree?.contentId).toHaveLength(4_194_305);
  });

  it("uses the bounded name-bytes index for exact edge lookup", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    const payload = JSON.stringify([{ i: 0, s: "b", t: tree, n: "a.txt", f: 1 }]);
    const plan = workspace.database.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${SPARSE_TREE_DEPTH_SQL}`,
      payload,
      workspace.repo.store.repoId,
    );

    expect(
      plan.some(
        (row) =>
          row.detail.includes("SEARCH effective USING PRIMARY KEY") &&
          row.detail.includes("repo_id="),
      ),
    ).toBe(true);
    expect(plan.some((row) => row.detail.includes("SEARCH edge USING"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("git_tree_entries_wide"))).toBe(false);
    expect(plan.some((row) => /SCAN (effective|edge)(?:\s|$)/.test(row.detail))).toBe(false);
  });

  it("returns unavailable for invalid native hydration bounds before issuing SQL", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    workspace.storage.resetCounters();

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: Array.from({ length: 1_001 }, (_, index) => `p${index.toString().padStart(4, "0")}`),
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("sends former 1 MiB JSON and accepts a former root first excess", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    const escaped = Array.from(
      { length: 1_000 },
      (_, index) => `p${index.toString().padStart(4, "0")}${"\u0001".repeat(175)}`,
    );
    workspace.storage.resetCounters();
    const jsonResult = source.hydrate({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: tree,
      currentTreeOid: null,
      paths: escaped,
    });
    expect(JSON.stringify(escaped).length).toBeGreaterThan(1024 * 1024);
    expect(jsonResult.available).toBe(true);
    expect(workspace.storage.statementCount).toBeGreaterThan(0);

    const longRoot = `/${"a".repeat(4_096)}`;
    const rooted = makeRepo(longRoot);
    rooted.worktree.mkdir(longRoot, { recursive: true });
    expect(
      createSqliteSparseWorkspaceSource(rooted.database.db).hydrate({
        repoId: rooted.repo.store.repoId,
        checkoutId: rooted.repo.checkout.checkoutId,
        root: longRoot,
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: [],
      }),
    ).toEqual({ available: true, rows: [] });
  });

  it("accepts the former 2,201-byte path excess", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: ["a".repeat(2_200)],
      }).available,
    ).toBe(true);
    const formerExcess = source.hydrate({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: null,
      currentTreeOid: null,
      paths: ["a".repeat(2_201)],
    });
    expect(formerExcess.available).toBe(true);
  });

  it("hydrates exactly 1000 paths with constant statement count", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    const paths = Array.from(
      { length: 1_000 },
      (_, index) => `p${index.toString().padStart(4, "0")}`,
    );
    workspace.storage.resetCounters();

    const result = source.hydrate({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: tree,
      currentTreeOid: null,
      paths,
    });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.rows).toHaveLength(1_000);
    }
    expect(workspace.storage.statementCount).toBe(4);
    expect(workspace.storage.rowCount).toBe(3_001);
  });

  it("validates checkout ownership for an empty hydration in one statement", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    workspace.storage.resetCounters();

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: [],
      }),
    ).toEqual({ available: true, rows: [] });
    expect(workspace.storage.statementCount).toBe(1);
  });

  it("requires the exact unequal shared and checkout identities", () => {
    const workspace = committedWorkspace();
    const repoId = workspace.repo.store.repoId;
    const checkoutId = 101;
    workspace.worktree.mkdir("/secondary");
    workspace.database.db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (?, ?, '/secondary', ?, 0)`,
      checkoutId,
      repoId,
      "1".repeat(40),
    );
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const request = {
      repoId,
      checkoutId,
      root: "/secondary",
      baselineTreeOid: null,
      currentTreeOid: null,
      paths: [],
    };

    expect(source.hydrate(request)).toEqual({ available: true, rows: [] });
    expect(() => source.hydrate({ ...request, repoId: repoId + 1 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() =>
      source.hydrate({ ...request, checkoutId: workspace.repo.checkout.checkoutId }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("hydrates a native tree beyond the former 8 MiB source ceiling", () => {
    const workspace = makeRepo("/");
    const entries = Array.from({ length: 4_096 }, (_, index) => ({
      mode: MODE_FILE,
      name: `p${index.toString().padStart(4, "0")}${"x".repeat(2_044)}`,
      oid: "1".repeat(40),
    }));
    const serialized = serializeTree(entries);
    expect(serialized.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    const tree = workspace.repo.store.write("tree", serialized);
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const result = hydrateSparseWorkspaceOwned(source, {
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      baselineTreeOid: tree,
      currentTreeOid: null,
      paths: [entries[0]?.name ?? ""],
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("large sparse tree was unavailable");
    expect(result.rows).toHaveLength(1);
  });

  it("falls back when tree hydration touches source 1001", () => {
    const workspace = makeRepo("/");
    const directories = Array.from(
      { length: 1_000 },
      (_, index) => `d${index.toString().padStart(4, "0")}`,
    );
    const children = directories.map((name, index) => ({
      mode: MODE_TREE,
      name,
      oid: workspace.repo.store.write(
        "tree",
        serializeTree([
          {
            mode: MODE_FILE,
            name: "file.txt",
            oid: index.toString(16).padStart(40, "0"),
          },
        ]),
      ),
    }));
    const root = workspace.repo.store.write("tree", serializeTree(children));

    expect(
      createSqliteSparseWorkspaceSource(workspace.database.db).hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: root,
        currentTreeOid: null,
        paths: directories.map((directory) => `${directory}/file.txt`),
      }),
    ).toEqual({ available: false });
  });

  it("falls back before deep and wide cursor ancestry exceeds the fixed state cap", () => {
    const workspace = makeRepo("/");
    const leafEntries = Array.from({ length: 1_000 }, (_, index) => ({
      mode: MODE_FILE,
      name: `p${index.toString().padStart(4, "0")}`,
      oid: "1".repeat(40),
    }));
    let tree = workspace.repo.store.write("tree", serializeTree(leafEntries));
    const directories = Array.from(
      { length: 63 },
      (_, index) => `d${index.toString().padStart(2, "0")}`,
    );
    for (let index = directories.length - 1; index >= 0; index--) {
      const name = directories[index];
      if (name === undefined) throw new Error("missing directory name");
      tree = workspace.repo.store.write(
        "tree",
        serializeTree([{ mode: "40000", name, oid: tree }]),
      );
    }
    const prefix = directories.join("/");
    const paths = leafEntries.map((entry) => `${prefix}/${entry.name}`);
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    workspace.storage.resetCounters();

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: tree,
        paths,
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("falls back for valid paths deeper than the sparse traversal budget", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const path = Array.from({ length: 65 }, () => "x").join("/");
    const tree = workspace.repo.headTree();
    workspace.storage.resetCounters();

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: [path],
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBe(0);
  });
});
