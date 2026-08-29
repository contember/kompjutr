import { describe, expect, it } from "vitest";

import { fromHex } from "../src/core/bytes.js";
import { MODE_FILE, serializeTree } from "../src/core/objects.js";
import { commit } from "../src/core/ops/commit.js";
import { add } from "../src/core/ops/staging.js";
import { comparePaths } from "../src/core/streams.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import {
  INDEX_DIRTY,
  invalidateIndexTracker,
  resealIndexTracker,
} from "../src/sqlite/index-tracker.js";
import {
  PACK_BLOB_CALLER_HEADROOM_BYTES,
  PACK_BLOB_MEMORY_MODEL_BYTES,
} from "../src/sqlite/packs.js";
import {
  createSqliteCommitTreeSnapshotSource,
  createSqliteSelectedPathSource,
  createSqliteSparseWorkspaceSource,
  MAX_SPARSE_WORKSPACE_RETAINED_BYTES,
  SPARSE_TREE_DEPTH_SQL,
} from "../src/sqlite/sparse-workspace.js";
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
    if (query.includes("selected_source_key")) {
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

class RecordingSnapshotDirtyDatabase implements SqlDatabase {
  readonly limits: number[] = [];
  rows = 0;

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
    const recordsDirty = query.includes("FROM git_index_dirty") && query.includes("LIMIT ?");
    if (recordsDirty) {
      const limit = bindings[2];
      if (typeof limit !== "number") throw new Error("snapshot dirty limit was not numeric");
      this.limits.push(limit);
    }
    for (const row of this.delegate.iterate(query, ...bindings)) {
      if (recordsDirty && row.kind === 1) this.rows++;
      yield row;
    }
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
    if (query.includes("exact_index_ancestor_rows")) {
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
    if (query.includes("index_ancestor_rows")) this.query = query;
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
  it("keeps packed blob reads and caller-held state below 100 MiB", () => {
    expect(PACK_BLOB_CALLER_HEADROOM_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_SPARSE_WORKSPACE_RETAINED_BYTES).toBe(PACK_BLOB_CALLER_HEADROOM_BYTES);
    expect(PACK_BLOB_MEMORY_MODEL_BYTES).toBeLessThan(100 * 1024 * 1024);
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
    expect(workspace.storage.statementCount).toBe(2);
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
    expect(workspace.storage.statementCount).toBe(2);
    workspace.storage.resetCounters();
    const general = source.select({
      repoId: workspace.repo.store.repoId,
      checkoutId: workspace.repo.checkout.checkoutId,
      root: "/",
      specs: exactSpecs.map((spec) => ({ ...spec, recursive: true })),
    });
    expect(workspace.storage.statementCount).toBe(2);
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
    expect(nested.storage.statementCount).toBe(2);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.index.map((entry) => entry.path)).toEqual(["dir/a.txt"]);
      expect(result.worktree.map((entry) => entry.path)).toEqual(["dir/a.txt"]);
    }

    nested.database.db.run(
      "DELETE FROM fs_nodes WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/outer')",
    );
    expect(() => source.select(request)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    nested.database.db.run("DELETE FROM fs_paths WHERE path = '/outer'");
    expect(source.select(request)).toMatchObject({ available: true });

    const fallback = committedWorkspace();
    const fallbackSource = createSqliteSelectedPathSource(fallback.database.db);
    const histogram = new Map<string, number>();
    fallback.storage.histogram = histogram;
    const expectGeneral = (
      specs: Array<{ path: string; recursive: boolean }>,
      maxRetainedBytes?: number,
    ): void => {
      fallback.storage.resetCounters();
      expect(
        fallbackSource.select({
          repoId: fallback.repo.store.repoId,
          checkoutId: fallback.repo.checkout.checkoutId,
          root: "/",
          specs,
          ...(maxRetainedBytes === undefined ? {} : { maxRetainedBytes }),
        }),
      ).toMatchObject({ available: true, index: [], worktree: [] });
      expect(fallback.storage.statementCount).toBe(2);
      expect(
        [...histogram.keys()].some((query) => query.includes("WITH wanted(relative, recursive)")),
      ).toBe(true);
    };

    const deepPrefix = Array.from({ length: 40 }, (_, index) => `d${index}`).join("/");
    expectGeneral(
      Array.from({ length: 1_000 }, (_, index) => ({
        path: `${deepPrefix}/f${index.toString().padStart(4, "0")}`,
        recursive: false,
      })).sort((left, right) => comparePaths(left.path, right.path)),
    );

    const longSegments = ["a", "b", "c", "d"].map((letter) => letter.repeat(200));
    expectGeneral(
      Array.from({ length: 1_000 }, (_, index) => ({
        path: `j${index.toString().padStart(4, "0")}/${longSegments.join("/")}`,
        recursive: false,
      })).sort((left, right) => comparePaths(left.path, right.path)),
    );

    const retainedPrefix = Array.from(
      { length: 5 },
      (_, index) => `retained-segment-${index.toString().padStart(2, "0")}`,
    ).join("/");
    expectGeneral(
      Array.from({ length: 1_000 }, (_, index) => ({
        path: `${retainedPrefix}/f${index.toString().padStart(4, "0")}`,
        recursive: false,
      })),
      2 * 1024 * 1024,
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
        (detail) =>
          detail.includes("SEARCH candidate") &&
          detail.includes("checkout_id=") &&
          detail.includes("path="),
      ),
      explained.details.join("\n"),
    ).toBe(true);
    expect(
      explained.details.some(
        (detail) => detail.includes("SEARCH paths") && detail.includes("path="),
      ),
      explained.details.join("\n"),
    ).toBe(true);
    expect(
      explained.details.some(
        (detail) => detail.includes("SEARCH ancestor") && detail.includes("path="),
      ),
      explained.details.join("\n"),
    ).toBe(true);
    expect(
      explained.details.some((detail) => /SCAN (candidate|paths|ancestor)(?:\s|$)/.test(detail)),
    ).toBe(false);
  });

  it("keeps a thousand shared-prefix paths on the exact two-statement branch", () => {
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
    expect(result.retainedBytes).toBeLessThanOrEqual(MAX_SPARSE_WORKSPACE_RETAINED_BYTES);
    expect(workspace.storage.statementCount).toBe(2);
    expect(workspace.storage.rowCount).toBe(2_002);
    expect([...histogram.keys()].some((query) => query.startsWith("WITH wanted(path)"))).toBe(true);
    expect([...histogram.keys()].some((query) => query.startsWith("WITH wanted(relative)"))).toBe(
      true,
    );
    expect(
      [...histogram.keys()].some((query) => query.includes("wanted(relative, recursive)")),
    ).toBe(false);
  });

  it("surfaces BLOB-backed exact index, worktree, and ancestor paths", () => {
    const index = committedWorkspace();
    index.database.db.run("PRAGMA ignore_check_constraints = ON");
    index.database.db.run(
      "UPDATE git_index SET path = CAST(path AS BLOB) WHERE checkout_id = ? AND path = 'a.txt'",
      index.repo.checkout.checkoutId,
    );
    index.database.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      createSqliteSelectedPathSource(index.database.db).select({
        repoId: index.repo.store.repoId,
        checkoutId: index.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "a.txt", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    const worktree = committedWorkspace();
    worktree.database.db.run("PRAGMA ignore_check_constraints = ON");
    worktree.database.db.run("UPDATE fs_paths SET path = CAST(path AS BLOB) WHERE path = '/a.txt'");
    worktree.database.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      createSqliteSelectedPathSource(worktree.database.db).select({
        repoId: worktree.repo.store.repoId,
        checkoutId: worktree.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "a.txt", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    const ancestor = committedWorkspace();
    ancestor.database.db.run("PRAGMA ignore_check_constraints = ON");
    ancestor.database.db.run("UPDATE fs_paths SET path = CAST(path AS BLOB) WHERE path = '/dir'");
    ancestor.database.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      createSqliteSelectedPathSource(ancestor.database.db).select({
        repoId: ancestor.repo.store.repoId,
        checkoutId: ancestor.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "dir/b.txt", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
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
    expect(explained.query).toContain("exact_index_ancestor_rows");
    expect(
      explained.details.some(
        (detail) =>
          detail.includes(
            "SEARCH exact_candidate USING COVERING INDEX sqlite_autoindex_git_index_1",
          ) &&
          detail.includes("checkout_id=") &&
          detail.includes("path="),
      ),
      explained.details.join("\n"),
    ).toBe(true);
    expect(
      explained.details.some(
        (detail) =>
          detail.includes(
            "SEARCH descendant_candidate USING COVERING INDEX sqlite_autoindex_git_index_1",
          ) &&
          detail.includes("checkout_id=") &&
          detail.includes("path>"),
      ),
      explained.details.join("\n"),
    ).toBe(true);
    expect(
      explained.details.some((detail) =>
        /SCAN (candidate|exact_candidate|descendant_candidate)(?:\s|$)/.test(detail),
      ),
      explained.details.join("\n"),
    ).toBe(false);
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
    expect(recorded.query).toContain("exact_index_ancestor_rows");
  });

  it.each([
    ["exact", "a"],
    ["descendant", "a/b"],
  ])("rejects a BLOB-backed %s index witness", (_label, storedPath) => {
    const workspace = makeRepo("/");
    workspace.repo.checkout.indexPut({
      path: storedPath,
      stage: 0,
      mode: 0o100644,
      oid: "1".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.database.db.run(
      "UPDATE git_index SET path = CAST(path AS BLOB) WHERE checkout_id = ? AND path = ?",
      workspace.repo.checkout.checkoutId,
      storedPath,
    );
    workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
    const recorded = new RecordingIndexAncestorDatabase(workspace.database.db);
    const lookup = createSqliteSparseWorkspaceSource(recorded).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");

    expect(() =>
      lookup({ checkoutId: workspace.repo.checkout.checkoutId, ancestors: ["a"] }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("fully validates exact and descendant index witnesses", () => {
    for (const storedPath of ["a", "a/b"]) {
      const workspace = makeRepo("/");
      workspace.repo.checkout.indexPut({
        path: storedPath,
        stage: 0,
        mode: 0o100644,
        oid: "1".repeat(40),
        size: null,
        mtime: null,
        ino: null,
      });
      workspace.database.db.run(
        "UPDATE git_index SET oid = 'bad' WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        storedPath,
      );
      const lookup = createSqliteSparseWorkspaceSource(workspace.database.db).indexAncestorFacts;
      if (lookup === undefined) throw new Error("missing index ancestor source");

      expect(() =>
        lookup({ checkoutId: workspace.repo.checkout.checkoutId, ancestors: ["a"] }),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    }
  });

  it.each([
    ["exact", "a", -1],
    ["exact", "a", 4],
    ["exact", "a", "bad"],
    ["descendant", "a/z-invalid", -1],
    ["descendant", "a/z-invalid", 4],
    ["descendant", "a/z-invalid", "bad"],
  ])("rejects a hidden %s index row at %s with stage %s", (_kind, corruptPath, stage) => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
    const oid = "1".repeat(40);
    for (const path of ["a", "a/a-valid"]) {
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
    workspace.database.db.run(
      `INSERT INTO git_index (checkout_id, path, stage, mode, oid)
       VALUES (?, ?, ?, ?, ?)`,
      checkoutId,
      corruptPath,
      stage,
      0o100644,
      oid,
    );
    const lookup = createSqliteSparseWorkspaceSource(workspace.database.db).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");

    expect(() => lookup({ checkoutId, ancestors: ["a"] })).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it.each([
    [
      "path",
      "UPDATE git_index SET path = 'a/z/../bad' WHERE checkout_id = ? AND path = 'a/z-invalid'",
    ],
    ["mode", "UPDATE git_index SET mode = 'bad' WHERE checkout_id = ? AND path = 'a/z-invalid'"],
    ["oid", "UPDATE git_index SET oid = 'bad' WHERE checkout_id = ? AND path = 'a/z-invalid'"],
    ["stat", "UPDATE git_index SET size = -1 WHERE checkout_id = ? AND path = 'a/z-invalid'"],
  ])("rejects malformed later descendant %s after a valid witness", (_field, corruption) => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
    for (const path of ["a/a-valid", "a/z-invalid"]) {
      workspace.repo.checkout.indexPut({
        path,
        stage: 0,
        mode: 0o100644,
        oid: "1".repeat(40),
        size: null,
        mtime: null,
        ino: null,
      });
    }
    workspace.database.db.run(corruption, checkoutId);
    const lookup = createSqliteSparseWorkspaceSource(workspace.database.db).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");

    expect(() => lookup({ checkoutId, ancestors: ["a"] })).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("rejects invalid UTF-8 in a later descendant before returning facts", () => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
    workspace.repo.checkout.indexPut({
      path: "a/a-valid",
      stage: 0,
      mode: 0o100644,
      oid: "1".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    workspace.database.db.run("PRAGMA foreign_keys = OFF");
    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    try {
      workspace.database.db.run(
        `INSERT INTO git_index (checkout_id, path, stage, mode, oid)
         VALUES (?, CAST(X'612F7A2F80' AS TEXT), 0, 33188, ?)`,
        checkoutId,
        "1".repeat(40),
      );
    } finally {
      workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
      workspace.database.db.run("PRAGMA foreign_keys = ON");
    }
    const lookup = createSqliteSparseWorkspaceSource(workspace.database.db).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");

    expect(() => lookup({ checkoutId, ancestors: ["a"] })).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("bounds descendant integrity at the exact row limit and first excess", () => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
    workspace.database.db.run(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (0)
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 5999
       )
       INSERT INTO git_index (checkout_id, path, stage, mode, oid)
       SELECT ?, printf('a/f%04d', value), 0, 33188, ? FROM sequence`,
      checkoutId,
      "1".repeat(40),
    );
    const lookup = createSqliteSparseWorkspaceSource(workspace.database.db).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");

    expect(lookup({ checkoutId, ancestors: ["a"] }).facts).toEqual([
      { path: "a", exact: false, descendant: true },
    ]);
    workspace.database.db.run(
      `INSERT INTO git_index (checkout_id, path, stage, mode, oid)
       VALUES (?, 'a/f6000', 0, 33188, ?)`,
      checkoutId,
      "1".repeat(40),
    );
    expect(() => lookup({ checkoutId, ancestors: ["a"] })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("uses the exact branch through 1000 paths and the general branch at first excess", () => {
    const workspace = makeRepo("/");
    const recorded = new RecordingIndexAncestorDatabase(workspace.database.db);
    const lookup = createSqliteSparseWorkspaceSource(recorded).indexAncestorFacts;
    if (lookup === undefined) throw new Error("missing index ancestor source");
    workspace.storage.histogram = new Map();
    const paths = Array.from(
      { length: 1_001 },
      (_, index) => `p${index.toString().padStart(4, "0")}`,
    );

    workspace.storage.resetCounters();
    const exact = lookup({
      checkoutId: workspace.repo.checkout.checkoutId,
      ancestors: paths.slice(0, 1_000),
    });
    expect(exact.facts).toHaveLength(1_000);
    expect(workspace.storage.statementCount).toBe(1);
    expect(workspace.storage.rowCount).toBe(1_000);
    expect(recorded.query).toContain("exact_index_ancestor_rows");

    workspace.storage.resetCounters();
    recorded.query = "";
    expect(
      lookup({ checkoutId: workspace.repo.checkout.checkoutId, ancestors: paths }).facts,
    ).toHaveLength(1_001);
    expect(workspace.storage.statementCount).toBe(1);
    expect(recorded.query).toContain("index_ancestor_rows");
    expect(recorded.query).not.toContain("exact_index_ancestor_rows");

    expect(
      lookup({
        checkoutId: workspace.repo.checkout.checkoutId,
        ancestors: paths.slice(0, 1_000),
        maxRetainedBytes: exact.retainedBytes,
      }).facts,
    ).toHaveLength(1_000);
    workspace.storage.resetCounters();
    expect(() =>
      lookup({
        checkoutId: workspace.repo.checkout.checkoutId,
        ancestors: paths.slice(0, 1_000),
        maxRetainedBytes: exact.retainedBytes - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.storage.statementCount).toBe(0);

    const escaped = Array.from(
      { length: 1_000 },
      (_, index) => `q${index.toString().padStart(4, "0")}${"\u0001".repeat(175)}`,
    );
    workspace.storage.resetCounters();
    expect(() =>
      lookup({ checkoutId: workspace.repo.checkout.checkoutId, ancestors: escaped }),
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

  it("fails closed on selected node, ancestor, and symlink payload corruption", () => {
    const missingNode = committedWorkspace();
    const missingNodeSource = createSqliteSelectedPathSource(missingNode.database.db);
    missingNode.database.db.run(
      "DELETE FROM fs_nodes WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/a.txt')",
    );
    expect(() =>
      missingNodeSource.select({
        repoId: missingNode.repo.store.repoId,
        checkoutId: missingNode.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "a.txt", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    const missingAncestor = committedWorkspace();
    const missingAncestorSource = createSqliteSelectedPathSource(missingAncestor.database.db);
    missingAncestor.database.db.run(
      "DELETE FROM fs_nodes WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/dir')",
    );
    expect(() =>
      missingAncestorSource.select({
        repoId: missingAncestor.repo.store.repoId,
        checkoutId: missingAncestor.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "dir/b.txt", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    const symlink = committedWorkspace();
    const symlinkSource = createSqliteSelectedPathSource(symlink.database.db);
    symlink.database.db.run(
      "UPDATE fs_nodes SET content_id = x'01' WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/link')",
    );
    expect(() =>
      symlinkSource.select({
        repoId: symlink.repo.store.repoId,
        checkoutId: symlink.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "link", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("distinguishes selected-path capacity refusal from relevant corruption", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSelectedPathSource(workspace.database.db);
    workspace.storage.resetCounters();
    expect(
      source.select({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "a.txt", recursive: false }],
        maxRetainedBytes: 1,
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBe(0);

    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.database.db.run(
      "UPDATE git_index SET mode = zeroblob(8) WHERE checkout_id = ? AND path = 'a.txt'",
      workspace.repo.checkout.checkoutId,
    );
    workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      source.select({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        specs: [{ path: "a.txt", recursive: false }],
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("authenticates dirty index and baseline directories for commit reuse", () => {
    const workspace = committedWorkspace();
    const baseline = workspace.repo.headTree();
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseline, []),
    ).toBe(true);
    writeWorkFile(workspace, "/a.txt", "changed\n");
    writeWorkFile(workspace, "/dir/b.txt", "changed\n");
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);

    expect(
      source.snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: baseline,
        maxRetainedBytes: 1,
      }),
    ).toEqual({ available: false });

    const result = source.snapshot({
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

    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.database.db.run(
      "UPDATE git_index_dirty SET flags = zeroblob(8) WHERE checkout_id = ? AND path = 'a.txt'",
      workspace.repo.checkout.checkoutId,
    );
    workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      source.snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: baseline,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.database.db.run(
      "UPDATE git_index_dirty SET flags = 2 WHERE checkout_id = ? AND path = 'a.txt'",
      workspace.repo.checkout.checkoutId,
    );
    workspace.database.db.run(
      `UPDATE git_tree_entries SET mode = 'bad'
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose'
        ) AND ordinal = 0`,
      workspace.repo.store.repoId,
      baseline,
    );
    workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      source.snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: baseline,
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("stops the dirty snapshot at the exact retained-capacity sentinel", () => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
    expect(resealIndexTracker(workspace.database.db, checkoutId, null, [])).toBe(true);
    workspace.database.db.run(
      "INSERT INTO git_index_dirty (checkout_id, path, flags) VALUES (?, 'a', 1), (?, 'b', 2)",
      checkoutId,
      checkoutId,
    );
    workspace.database.db.run(
      `WITH RECURSIVE sequence(i) AS (
         VALUES (0) UNION ALL SELECT i + 1 FROM sequence WHERE i + 1 < 9998
       )
       INSERT INTO git_index_dirty (checkout_id, path, flags)
       SELECT ?, printf('p%05d', i), i % 3 + 1 FROM sequence`,
      checkoutId,
    );
    const requestBytes = 512 + 4;
    const dirtyArrayBytes = 64;
    const minimumDirtyRowBytes = 1_024 + 8 + 4 + 1;
    const exactOneRowBytes = requestBytes + dirtyArrayBytes + minimumDirtyRowBytes;

    const exactDb = new RecordingSnapshotDirtyDatabase(workspace.database.db);
    expect(
      createSqliteCommitTreeSnapshotSource(exactDb).snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId,
        root: "/",
        baselineTreeOid: null,
        maxRetainedBytes: exactOneRowBytes,
      }),
    ).toEqual({ available: false });
    expect(exactDb.limits).toEqual([2]);
    expect(exactDb.rows).toBe(2);

    const firstExcessDb = new RecordingSnapshotDirtyDatabase(workspace.database.db);
    expect(
      createSqliteCommitTreeSnapshotSource(firstExcessDb).snapshot({
        repoId: workspace.repo.store.repoId,
        checkoutId,
        root: "/",
        baselineTreeOid: null,
        maxRetainedBytes: exactOneRowBytes - 1,
      }),
    ).toEqual({ available: false });
    expect(firstExcessDb.limits).toEqual([1]);
    expect(firstExcessDb.rows).toBe(1);
  });

  it("reads authenticated snapshot entries by active source key", () => {
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
    expect(
      explained.details.some((detail) =>
        detail.includes("SEARCH source USING INTEGER PRIMARY KEY"),
      ),
    ).toBe(true);
    expect(
      explained.details.some(
        (detail) =>
          detail.includes("SEARCH effective USING PRIMARY KEY") && detail.includes("repo_id="),
      ),
    ).toBe(true);
    expect(
      explained.details.some((detail) =>
        detail.includes("SEARCH git_tree_entries USING PRIMARY KEY (source_key=?)"),
      ),
    ).toBe(true);
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
    expect(source.snapshot({ ...request, maxRetainedBytes: clean.retainedBytes }).available).toBe(
      true,
    );
    expect(source.snapshot({ ...request, maxRetainedBytes: clean.retainedBytes - 1 })).toEqual({
      available: false,
    });
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

  it("bounds authenticated wide-tree resolution at its simultaneous peak", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const directories = Array.from(
      { length: 999 },
      (_, index) => `d${index.toString().padStart(3, "0")}`,
    );
    workspace.worktree.makeDirectories(directories.map((directory) => `/${directory}`));
    workspace.worktree.writeFiles(
      directories.map((directory) => ({
        path: `/${directory}/file.txt`,
        bytes: new Uint8Array([1]),
      })),
    );
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    commit(workspace.context, workspace.repo, { message: "wide tree" });
    const baseline = workspace.repo.headTree();
    if (baseline === null) throw new Error("missing wide-tree baseline");
    const checkoutId = workspace.repo.checkout.checkoutId;
    expect(
      resealIndexTracker(
        workspace.database.db,
        checkoutId,
        baseline,
        directories.map((directory) => ({
          path: `${directory}/file.txt`,
          flags: INDEX_DIRTY,
        })),
      ),
    ).toBe(true);
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const request = {
      repoId: workspace.repo.store.repoId,
      checkoutId,
      root: "/",
      baselineTreeOid: baseline,
    };

    const result = source.snapshot(request);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.directories).toHaveLength(1_000);
    expect(source.snapshot({ ...request, maxRetainedBytes: result.retainedBytes }).available).toBe(
      true,
    );
    expect(source.snapshot({ ...request, maxRetainedBytes: result.retainedBytes - 1 })).toEqual({
      available: false,
    });
  });

  it("bounds request-heavy snapshots at the selected-path cap before mapping", () => {
    const workspace = committedWorkspace();
    const checkoutId = workspace.repo.checkout.checkoutId;
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const exact = Array.from({ length: 1_000 }, (_, index) => ({
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
    expect(result.dirty).toHaveLength(1_000);
    expect(source.snapshot({ ...request, maxRetainedBytes: result.retainedBytes }).available).toBe(
      true,
    );
    expect(source.snapshot({ ...request, maxRetainedBytes: result.retainedBytes - 1 })).toEqual({
      available: false,
    });

    expect(
      resealIndexTracker(workspace.database.db, checkoutId, null, [
        ...exact,
        { path: "request-last", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    expect(source.snapshot(request)).toEqual({ available: false });
  });

  it("bounds directory-heavy snapshots at the first excess ancestor", () => {
    const workspace = committedWorkspace();
    const checkoutId = workspace.repo.checkout.checkoutId;
    const source = createSqliteCommitTreeSnapshotSource(workspace.database.db);
    const exactPath = Array.from({ length: 1_000 }, () => "d").join("/");
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
    expect(result.directories).toHaveLength(1_000);
    expect(source.snapshot({ ...request, maxRetainedBytes: result.retainedBytes }).available).toBe(
      true,
    );
    expect(source.snapshot({ ...request, maxRetainedBytes: result.retainedBytes - 1 })).toEqual({
      available: false,
    });

    const excessPath = `${exactPath}/d`;
    expect(
      resealIndexTracker(workspace.database.db, checkoutId, null, [
        { path: excessPath, flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    expect(source.snapshot(request)).toEqual({ available: false });
  });

  it("validates caller retained limits before issuing SQL", () => {
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
        paths: ["a.txt"],
        maxRetainedBytes: 0,
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBe(0);

    let failure: unknown;
    try {
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: [],
        maxRetainedBytes: MAX_SPARSE_WORKSPACE_RETAINED_BYTES + 1,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "E2BIG" });
    expect(workspace.storage.statementCount).toBe(0);

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: [],
        maxRetainedBytes: MAX_SPARSE_WORKSPACE_RETAINED_BYTES,
      }),
    ).toEqual({ available: true, rows: [], retainedBytes: 0 });
    expect(workspace.storage.statementCount).toBe(1);
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
    expect(() => source.hydrate(request)).toThrowError(/source is missing or invalid/);
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

    expect(() =>
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/source is missing or invalid/);
  });

  it("does not borrow a packed tree through a wrong-type loose shadow", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("missing HEAD tree");
    installPackCopy(workspace, tree, 7);
    workspace.database.db.run(
      `INSERT INTO git_objects (repo_id, oid, type, size, stored)
       VALUES (?, ?, 'blob', 0, 'raw')`,
      workspace.repo.store.repoId,
      tree,
    );

    expect(() =>
      createSqliteSparseWorkspaceSource(workspace.database.db).hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/source metadata is inconsistent/);
  });

  it("validates an entire touched source before returning a selected edge", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    workspace.database.db.run(
      `UPDATE git_tree_entries SET raw_entry = X'00'
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose' AND source_id = 0
        ) AND name_bytes = CAST('link' AS BLOB)`,
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
        paths: ["a.txt"],
      }),
    ).toThrowError(/source entries/);
  });

  it("rejects a corrupt source marker before edge hydration", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    workspace.database.db.run(
      `UPDATE git_tree_sources SET base_cost = base_cost + 1
        WHERE repo_id = ? AND tree_oid = ?`,
      workspace.repo.store.repoId,
      tree,
    );

    expect(() =>
      createSqliteSparseWorkspaceSource(workspace.database.db).hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/source metadata is inconsistent/);
  });

  it("does not lose corrupt active source-key and parsed-edge associations", () => {
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
    expect(() =>
      createSqliteSparseWorkspaceSource(active.database.db).hydrate({
        repoId: active.repo.store.repoId,
        checkoutId: active.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: activeTree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/source is missing or invalid/);

    const edge = committedWorkspace();
    const edgeTree = edge.repo.headTree();
    edge.database.db.run("PRAGMA foreign_keys = OFF");
    edge.database.db.run(
      `UPDATE git_tree_entries SET source_key = source_key + 1000000
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose' AND source_id = 0
        ) AND name_bytes = CAST('link' AS BLOB)`,
      edge.repo.store.repoId,
      edgeTree,
    );
    edge.database.db.run("PRAGMA foreign_keys = ON");
    expect(() =>
      createSqliteSparseWorkspaceSource(edge.database.db).hydrate({
        repoId: edge.repo.store.repoId,
        checkoutId: edge.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: edgeTree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/entries disagree with its marker/);
  });

  it("detects a projected tree cycle before depth fallback", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("missing HEAD tree");
    const row = workspace.database.db.one<{ raw_entry: Uint8Array }>(
      `SELECT raw_entry FROM git_tree_entries_wide
        WHERE repo_id = ? AND tree_oid = ? AND name = 'dir'`,
      workspace.repo.store.repoId,
      tree,
    );
    if (row === undefined) throw new Error("missing directory edge");
    const raw = row.raw_entry.slice();
    raw.set(fromHex(tree), raw.length - 20);
    workspace.database.db.run(
      `UPDATE git_tree_entries SET oid = ?, raw_entry = ?
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose' AND source_id = 0
        ) AND name_bytes = CAST('dir' AS BLOB)`,
      tree,
      raw,
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
    const raw = serializeTree([{ mode: "40000", name: "b.txt", oid: root }]);
    const cumulativeBase = 192 + 5 + 5 + 40;
    workspace.database.db.transactionSync(() => {
      workspace.database.db.run(
        `UPDATE git_tree_entries
            SET mode = '40000', oid = ?, raw_entry = ?, cumulative_base = ?
          WHERE source_key = (
            SELECT source_key FROM git_tree_sources
             WHERE repo_id = ? AND tree_oid = ? AND storage = 'loose' AND source_id = 0
          ) AND name_bytes = CAST('b.txt' AS BLOB)`,
        root,
        raw,
        cumulativeBase,
        workspace.repo.store.repoId,
        child,
      );
      workspace.database.db.run(
        `UPDATE git_tree_sources SET object_size = ?, base_cost = ?
          WHERE repo_id = ? AND tree_oid = ?`,
        raw.length,
        cumulativeBase,
        workspace.repo.store.repoId,
        child,
      );
      workspace.database.db.run(
        "UPDATE git_objects SET size = ? WHERE repo_id = ? AND oid = ?",
        raw.length,
        workspace.repo.store.repoId,
        child,
      );
    });

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

  it("returns all index stages and guards malformed index payloads", () => {
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

    workspace.database.db.run(
      "UPDATE git_index SET stage = 4 WHERE checkout_id = ? AND path = 'a.txt' AND stage = 3",
      checkoutId,
    );
    expect(() => source.hydrate(request)).toThrowError(/malformed/);
    workspace.database.db.run(
      "UPDATE git_index SET stage = 3 WHERE checkout_id = ? AND path = 'a.txt' AND stage = 4",
      checkoutId,
    );
    workspace.database.db.run(
      "UPDATE git_index SET oid = zeroblob(4194305) WHERE checkout_id = ? AND path = 'a.txt' AND stage = 2",
      checkoutId,
    );
    expect(() => source.hydrate(request)).toThrowError(/malformed row/);
  });

  it("rejects dangling filesystem metadata and falls back before large payload egress", () => {
    const dangling = committedWorkspace();
    const danglingInode = dangling.database.db.scalar<number>(
      "SELECT inode FROM fs_paths WHERE path = '/a.txt'",
    );
    dangling.database.db.run("DELETE FROM fs_nodes WHERE inode = ?", danglingInode);
    expect(() =>
      createSqliteSparseWorkspaceSource(dangling.database.db).hydrate({
        repoId: dangling.repo.store.repoId,
        checkoutId: dangling.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/malformed metadata/);

    const large = committedWorkspace();
    large.database.db.run(
      "UPDATE fs_nodes SET content_id = zeroblob(4194305) WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/a.txt')",
    );
    expect(
      createSqliteSparseWorkspaceSource(large.database.db).hydrate({
        repoId: large.repo.store.repoId,
        checkoutId: large.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toEqual({ available: false });

    const symlink = committedWorkspace();
    symlink.database.db.run(
      "UPDATE fs_nodes SET link_target = zeroblob(16) WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/link')",
    );
    expect(() =>
      createSqliteSparseWorkspaceSource(symlink.database.db).hydrate({
        repoId: symlink.repo.store.repoId,
        checkoutId: symlink.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: ["link"],
      }),
    ).toThrowError(/payload metadata/);
  });

  it("uses the bounded name-bytes index for exact edge lookup", () => {
    const workspace = committedWorkspace();
    const tree = workspace.repo.headTree();
    const payload = JSON.stringify([{ i: 0, s: "b", t: tree, n: "a.txt", f: 1, v: 0 }]);
    const plan = workspace.database.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${SPARSE_TREE_DEPTH_SQL}`,
      payload,
      workspace.repo.store.repoId,
      8_192,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
    );

    expect(plan.some((row) => row.detail.includes("SEARCH x USING PRIMARY KEY"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("SEARCH s USING INTEGER PRIMARY KEY"))).toBe(
      true,
    );
    expect(
      plan.some((row) => row.detail.includes("SEARCH entry USING PRIMARY KEY (source_key=?)")),
    ).toBe(true);
    expect(plan.some((row) => row.detail.includes("git_tree_entries_by_name_bytes"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("git_tree_entries_wide"))).toBe(false);
    expect(
      plan.some((row) => /SCAN (x|s|entry|candidate|duplicate|previous)(?:\s|$)/.test(row.detail)),
    ).toBe(false);
  });

  it("rejects invalid caller bounds before issuing SQL", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    workspace.storage.resetCounters();

    let failure: unknown;
    try {
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: Array.from({ length: 1_001 }, (_, index) => `p${index.toString().padStart(4, "0")}`),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "E2BIG" });
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("bounds escaped JSON and absolute roots before whole-request allocation", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    const escaped = Array.from(
      { length: 1_000 },
      (_, index) => `p${index.toString().padStart(4, "0")}${"\u0001".repeat(175)}`,
    );
    workspace.storage.resetCounters();
    let jsonFailure: unknown;
    try {
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: escaped,
      });
    } catch (error) {
      jsonFailure = error;
    }
    expect(jsonFailure).toMatchObject({ code: "E2BIG" });
    expect(workspace.storage.statementCount).toBe(0);

    let rootFailure: unknown;
    try {
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: `/${"a".repeat(4_096)}`,
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["a.txt"],
      });
    } catch (error) {
      rootFailure = error;
    }
    expect(rootFailure).toMatchObject({ code: "E2BIG" });
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("accepts a 2200-byte path and rejects the next byte before SQL", () => {
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
    workspace.storage.resetCounters();

    let failure: unknown;
    try {
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: null,
        currentTreeOid: null,
        paths: ["a".repeat(2_201)],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "E2BIG" });
    expect(workspace.storage.statementCount).toBe(0);
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
      expect(result.retainedBytes).toBeLessThanOrEqual(MAX_SPARSE_WORKSPACE_RETAINED_BYTES);
    }
    expect(workspace.storage.statementCount).toBe(4);
    expect(workspace.storage.rowCount).toBe(2_001);
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
    ).toEqual({ available: true, rows: [], retainedBytes: 0 });
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

    expect(source.hydrate(request)).toEqual({ available: true, rows: [], retainedBytes: 0 });
    expect(() => source.hydrate({ ...request, repoId: repoId + 1 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() =>
      source.hydrate({ ...request, checkoutId: workspace.repo.checkout.checkoutId }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("falls back when distinct touched sources exceed the cumulative row cap by one", () => {
    const workspace = makeRepo("/");
    const entries = Array.from({ length: 8_192 }, (_, index) => ({
      mode: MODE_FILE,
      name: `p${index.toString().padStart(4, "0")}`,
      oid: "1".repeat(40),
    }));
    const wide = workspace.repo.store.write("tree", serializeTree(entries));
    const narrow = workspace.repo.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "p0000", oid: "2".repeat(40) }]),
    );
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    workspace.storage.resetCounters();

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.checkout.checkoutId,
        root: "/",
        baselineTreeOid: wide,
        currentTreeOid: narrow,
        paths: ["p0000"],
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBe(2);
    expect(workspace.storage.rowCount).toBeLessThanOrEqual(3);
  });

  it("falls back before deep and wide cursor ancestry exceeds retained memory", () => {
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
