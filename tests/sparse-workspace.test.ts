import { describe, expect, it } from "vitest";

import { fromHex } from "../src/core/bytes.js";
import { MODE_FILE, serializeTree } from "../src/core/objects.js";
import { commit } from "../src/core/ops/commit.js";
import { add } from "../src/core/ops/staging.js";
import { INDEX_DIRTY, resealIndexTracker } from "../src/sqlite/index-tracker.js";
import {
  PACK_BLOB_CALLER_HEADROOM_BYTES,
  PACK_BLOB_MEMORY_MODEL_BYTES,
} from "../src/sqlite/packs.js";
import {
  createSqliteSparseWorkspaceSource,
  MAX_SPARSE_WORKSPACE_RETAINED_BYTES,
  SPARSE_TREE_DEPTH_SQL,
} from "../src/sqlite/sparse-workspace.js";
import { makeRepo, writeWorkFile } from "./helpers/workspace.js";

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

  it("validates caller retained limits before issuing SQL", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    workspace.storage.resetCounters();

    expect(
      source.hydrate({
        repoId: workspace.repo.store.repoId,
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
      checkoutId: workspace.repo.store.checkoutId,
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

  it("delegates bounded tracker state and dirty paths", () => {
    const workspace = committedWorkspace();
    const source = createSqliteSparseWorkspaceSource(workspace.database.db);
    const tree = workspace.repo.headTree();
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.store.checkoutId, tree, [
        { path: "a.txt", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);

    expect(source.readState(workspace.repo.store.checkoutId)).toEqual({
      available: true,
      baselineTreeOid: tree,
    });
    expect([...source.dirtyPaths(workspace.repo.store.checkoutId)]).toEqual([
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
      checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: ["a.txt"],
      }),
    ).toThrowError(/source metadata is inconsistent/);
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
    const checkoutId = workspace.repo.store.checkoutId;
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
        checkoutId: dangling.repo.store.checkoutId,
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
        checkoutId: large.repo.store.checkoutId,
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
        checkoutId: symlink.repo.store.checkoutId,
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
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      8_192,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
      workspace.repo.store.repoId,
    );

    expect(plan.some((row) => row.detail.includes("git_tree_entries_by_name_bytes"))).toBe(true);
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
      checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
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
      source.hydrate({ ...request, checkoutId: workspace.repo.store.checkoutId }),
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
        checkoutId: workspace.repo.store.checkoutId,
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
        checkoutId: workspace.repo.store.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: tree,
        paths,
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBeLessThan(64);
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
        checkoutId: workspace.repo.store.checkoutId,
        root: "/",
        baselineTreeOid: tree,
        currentTreeOid: null,
        paths: [path],
      }),
    ).toEqual({ available: false });
    expect(workspace.storage.statementCount).toBe(0);
  });
});
