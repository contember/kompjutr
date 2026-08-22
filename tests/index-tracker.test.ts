import { describe, expect, it } from "vitest";
import { initializeFsSchema } from "../src/fs/schema.js";
import {
  INDEX_DIRTY,
  initializeIndexTracker,
  invalidateIndexTracker,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
  WORKTREE_DIRTY,
} from "../src/sqlite/index-tracker.js";
import { initializeGitSchema } from "../src/sqlite/schema.js";
import { TestDatabase } from "./helpers/db.js";

const TREE = "1".repeat(40);
const OTHER_TREE = "2".repeat(40);

function setup(initializeTracker = true): TestDatabase {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 1);
  initializeGitSchema(db);
  if (initializeTracker) initializeIndexTracker(db);
  return db;
}

function addDirectory(db: TestDatabase, path: string, inode: number): void {
  const slash = path.lastIndexOf("/");
  const parent = slash === 0 ? "/" : path.slice(0, slash);
  db.run(
    `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
     VALUES (?, 'dir', 493, 1, 0, 0, 1)`,
    inode,
  );
  db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)", path, parent, inode);
}

function addFile(db: TestDatabase, path: string, inode: number): void {
  const slash = path.lastIndexOf("/");
  const parent = slash === 0 ? "/" : path.slice(0, slash);
  db.run(
    `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
     VALUES (?, 'file', 420, 1, 0, 0, 1)`,
    inode,
  );
  db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)", path, parent, inode);
}

function addRepository(db: TestDatabase, id: number, root: string, inode = id + 10): void {
  if (root !== "/") addDirectory(db, root, inode);
  db.run(
    "INSERT INTO git_repositories (id, root, head) VALUES (?, ?, 'ref: refs/heads/main')",
    id,
    root,
  );
}

function dirty(db: TestDatabase, repoId: number): Array<{ path: string; flags: number }> {
  return [...iterateIndexTrackerDirty(db, repoId, 2)];
}

function seal(db: TestDatabase, repoId: number): void {
  expect(resealIndexTracker(db, repoId, TREE, [])).toBe(true);
}

describe("index tracker", () => {
  it("initializes idempotently and backfills repositories as incomplete", () => {
    const db = setup(false);
    addRepository(db, 1, "/repo");

    initializeIndexTracker(db);
    initializeIndexTracker(db);

    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_index_state")).toBe(1);
    expect(
      db.scalar<number>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'index_tracker_%'",
      ),
    ).toBe(16);
  });

  it("replaces stale owned triggers transactionally and preserves current installs", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    seal(db, 1);
    db.run("DROP TRIGGER index_tracker_index_insert");
    db.run(`CREATE TRIGGER index_tracker_index_insert AFTER INSERT ON git_index BEGIN
      SELECT 1;
    END`);

    initializeIndexTracker(db);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    const installed = db.scalar<string>(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'index_tracker_index_insert'",
    );
    expect(installed).toContain("WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)");

    seal(db, 1);
    initializeIndexTracker(db);
    expect(readIndexTrackerState(db, 1)).toEqual({
      available: true,
      baselineTreeOid: TREE,
    });
  });

  it("reseals atomically and reads dirty rows in bounded keyset pages", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    const entries = [
      { path: "z", flags: WORKTREE_DIRTY },
      { path: "a", flags: INDEX_DIRTY },
      { path: "é", flags: INDEX_DIRTY | WORKTREE_DIRTY },
    ];

    expect(resealIndexTracker(db, 1, TREE, entries)).toBe(true);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: true, baselineTreeOid: TREE });
    expect(dirty(db, 1)).toEqual([
      { path: "a", flags: INDEX_DIRTY },
      { path: "z", flags: WORKTREE_DIRTY },
      { path: "é", flags: INDEX_DIRTY | WORKTREE_DIRTY },
    ]);

    invalidateIndexTracker(db, 1);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toHaveLength(3);
  });

  it("rolls reseal back when an entry iterator throws or yields malformed data", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    expect(resealIndexTracker(db, 1, TREE, [{ path: "kept", flags: INDEX_DIRTY }])).toBe(true);
    function* broken(): Generator<{ path: string; flags: number }> {
      yield { path: "replacement", flags: WORKTREE_DIRTY };
      throw new Error("stop");
    }

    expect(() => resealIndexTracker(db, 1, OTHER_TREE, broken())).toThrow("stop");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: true, baselineTreeOid: TREE });
    expect(dirty(db, 1)).toEqual([{ path: "kept", flags: INDEX_DIRTY }]);
    expect(() => resealIndexTracker(db, 1, TREE, [{ path: "../bad", flags: 3 }])).toThrowError(
      /invalid path/,
    );
    expect(dirty(db, 1)).toEqual([{ path: "kept", flags: INDEX_DIRTY }]);
  });

  it("leaves invalid, missing, and non-directory roots incomplete without clearing dirties", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    expect(resealIndexTracker(db, 1, TREE, [{ path: "kept", flags: INDEX_DIRTY }])).toBe(true);
    db.run("DELETE FROM fs_paths WHERE path = '/repo'");
    expect(resealIndexTracker(db, 1, TREE, [])).toBe(false);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toEqual([{ path: "kept", flags: INDEX_DIRTY }]);
    expect(resealIndexTracker(db, 999, TREE, [])).toBe(false);

    db.run("UPDATE git_repositories SET root = 'relative' WHERE id = 1");
    expect(resealIndexTracker(db, 1, TREE, [])).toBe(false);
    expect(dirty(db, 1)).toEqual([{ path: "kept", flags: INDEX_DIRTY }]);
  });

  it("fails closed on malformed state and dirty rows", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    seal(db, 1);
    db.run("UPDATE git_index_state SET baseline_tree_oid = 'bad' WHERE repo_id = 1");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    db.run("INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, '/bad', 1)");
    expect(() => dirty(db, 1)).toThrowError(/invalid path/);
    expect(() => iterateIndexTrackerDirty(db, 1, 1001)).toThrowError(/page size/);

    db.run("DELETE FROM git_index_dirty WHERE repo_id = 1");
    db.run("INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, '', 1)");
    expect(() => dirty(db, 1)).toThrowError(/invalid path/);

    db.run("DELETE FROM git_index_dirty WHERE repo_id = 1");
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(
      "INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, 'bad-flags', zeroblob(4096))",
    );
    db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() => dirty(db, 1)).toThrowError(/malformed dirty row/);

    db.run("UPDATE git_index_state SET baseline_tree_oid = zeroblob(1048576) WHERE repo_id = 1");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
  });

  it("enforces the exact UTF-8 path bound without returning oversized text", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    const exact = "é".repeat(1_100);
    const oversized = `${exact}a`;

    expect(resealIndexTracker(db, 1, TREE, [{ path: exact, flags: INDEX_DIRTY }])).toBe(true);
    expect(dirty(db, 1)).toEqual([{ path: exact, flags: INDEX_DIRTY }]);
    expect(() =>
      resealIndexTracker(db, 1, OTHER_TREE, [{ path: oversized, flags: INDEX_DIRTY }]),
    ).toThrowError(/invalid path/);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: true, baselineTreeOid: TREE });
    expect(dirty(db, 1)).toEqual([{ path: exact, flags: INDEX_DIRTY }]);

    seal(db, 1);
    db.run("INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, ?, 1)", oversized);
    expect(() => dirty(db, 1)).toThrowError(/malformed dirty row/);
  });

  it("bounds total dirty rows and pages with rollback and fail-closed reads", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    function* entries(count: number): Generator<{ path: string; flags: number }> {
      for (let index = 0; index < count; index++) {
        yield { path: `p/${index.toString().padStart(5, "0")}`, flags: INDEX_DIRTY };
      }
    }

    expect(resealIndexTracker(db, 1, TREE, entries(32_000))).toBe(true);
    let count = 0;
    for (const _entry of iterateIndexTrackerDirty(db, 1)) count++;
    expect(count).toBe(32_000);

    expect(() => resealIndexTracker(db, 1, OTHER_TREE, entries(32_001))).toThrowError(
      /too many dirty rows/,
    );
    expect(readIndexTrackerState(db, 1)).toEqual({ available: true, baselineTreeOid: TREE });
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_index_dirty WHERE repo_id = 1")).toBe(
      32_000,
    );

    db.run("INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, 'z', 1)");
    expect(() => [...iterateIndexTrackerDirty(db, 1)]).toThrowError(/too many dirty rows/);
    expect(() => [...iterateIndexTrackerDirty(db, 1, 1)]).toThrowError(/page limit/);
  });

  it("journals semantic and stat-only index mutations with distinct bits", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    seal(db, 1);
    db.run(
      `INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino, rev)
       VALUES (1, 'a', 0, 33188, ?, 1, 1, 1, 1)`,
      TREE,
    );
    expect(dirty(db, 1)).toEqual([{ path: "a", flags: 3 }]);

    seal(db, 1);
    db.run("UPDATE git_index SET mtime = 2 WHERE repo_id = 1 AND path = 'a' AND stage = 0");
    expect(dirty(db, 1)).toEqual([{ path: "a", flags: WORKTREE_DIRTY }]);

    seal(db, 1);
    db.run("UPDATE git_index SET path = 'b' WHERE repo_id = 1 AND path = 'a' AND stage = 0");
    expect(dirty(db, 1)).toEqual([
      { path: "a", flags: 3 },
      { path: "b", flags: 3 },
    ]);
    seal(db, 1);
    db.run("DELETE FROM git_index WHERE repo_id = 1 AND path = 'b'");
    expect(dirty(db, 1)).toEqual([{ path: "b", flags: 3 }]);
  });

  it("invalidates instead of journaling invalid index paths", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    seal(db, 1);
    db.run(
      "INSERT INTO git_index (repo_id, path, stage, mode, oid) VALUES (1, '', 0, 33188, ?)",
      TREE,
    );
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toEqual([]);

    seal(db, 1);
    db.run("DELETE FROM git_index WHERE repo_id = 1 AND path = ''");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });

    db.run(
      "INSERT INTO git_index (repo_id, path, stage, mode, oid) VALUES (1, 'valid', 0, 33188, ?)",
      TREE,
    );
    seal(db, 1);
    db.run("UPDATE git_index SET path = '' WHERE repo_id = 1 AND path = 'valid'");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toEqual([{ path: "valid", flags: 3 }]);

    db.run("DELETE FROM git_index WHERE repo_id = 1 AND path = ''");
    seal(db, 1);
    db.run(
      "INSERT INTO git_index (repo_id, path, stage, mode, oid) VALUES (1, ?, 0, 33188, ?)",
      "a".repeat(2_201),
      TREE,
    );
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toEqual([]);
  });

  it("journals path mutations and keeps non-ASCII owner mapping exact", () => {
    const db = setup();
    addRepository(db, 1, "/répo");
    seal(db, 1);
    addFile(db, "/répo/žluťoučký", 50);
    expect(dirty(db, 1)).toEqual([{ path: "žluťoučký", flags: WORKTREE_DIRTY }]);

    seal(db, 1);
    db.run("UPDATE fs_paths SET path = '/répo/β', parent = '/répo' WHERE inode = 50");
    expect(dirty(db, 1)).toEqual([
      { path: "žluťoučký", flags: WORKTREE_DIRTY },
      { path: "β", flags: WORKTREE_DIRTY },
    ]);
    seal(db, 1);
    db.run("DELETE FROM fs_paths WHERE inode = 50");
    expect(dirty(db, 1)).toEqual([{ path: "β", flags: WORKTREE_DIRTY }]);
  });

  it("journals node and chunk mutations for every hardlink alias", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    addFile(db, "/repo/a", 50);
    db.run("INSERT INTO fs_paths (path, parent, inode) VALUES ('/repo/b', '/repo', 50)");
    seal(db, 1);

    db.run("UPDATE fs_nodes SET mtime = 2 WHERE inode = 50");
    expect(dirty(db, 1)).toEqual([
      { path: "a", flags: WORKTREE_DIRTY },
      { path: "b", flags: WORKTREE_DIRTY },
    ]);
    seal(db, 1);
    db.run("INSERT INTO fs_chunks (inode, idx, bytes) VALUES (50, 0, x'01')");
    expect(dirty(db, 1)).toEqual([
      { path: "a", flags: WORKTREE_DIRTY },
      { path: "b", flags: WORKTREE_DIRTY },
    ]);
    seal(db, 1);
    db.run("UPDATE fs_chunks SET bytes = x'02' WHERE inode = 50 AND idx = 0");
    expect(dirty(db, 1)).toHaveLength(2);
    seal(db, 1);
    db.run("DELETE FROM fs_chunks WHERE inode = 50 AND idx = 0");
    expect(dirty(db, 1)).toHaveLength(2);
  });

  it("invalidates on root and ignore-file mutations", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    seal(db, 1);
    db.run("UPDATE fs_nodes SET mtime = 2 WHERE inode = 11");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });

    seal(db, 1);
    addFile(db, "/repo/nested/.gitignore", 50);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toEqual([]);

    seal(db, 1);
    db.run("UPDATE fs_nodes SET mtime = 3 WHERE inode = 50");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    seal(db, 1);
    db.run("INSERT INTO fs_chunks (inode, idx, bytes) VALUES (50, 0, x'01')");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
  });

  it("assigns filesystem mutations to the nearest nested repository", () => {
    const db = setup();
    addRepository(db, 1, "/outer");
    addRepository(db, 2, "/outer/inner", 20);
    seal(db, 1);
    seal(db, 2);
    addFile(db, "/outer/inner/file", 50);

    expect(dirty(db, 1)).toEqual([]);
    expect(dirty(db, 2)).toEqual([{ path: "file", flags: WORKTREE_DIRTY }]);
  });

  it("handles repository insert, delete, and root changes conservatively", () => {
    const db = setup();
    addRepository(db, 1, "/outer");
    seal(db, 1);
    addRepository(db, 2, "/outer/inner", 20);
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(readIndexTrackerState(db, 2)).toEqual({ available: false });

    seal(db, 1);
    seal(db, 2);
    db.run("DELETE FROM git_repositories WHERE id = 2");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_index_state WHERE repo_id = 2")).toBe(0);

    addRepository(db, 3, "/other", 30);
    seal(db, 1);
    seal(db, 3);
    db.run("UPDATE git_repositories SET root = '/outer/moved' WHERE id = 3");
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(readIndexTrackerState(db, 3)).toEqual({ available: false });
  });

  it("does not accumulate journal rows during clone-like writes while incomplete", () => {
    const db = setup();
    addRepository(db, 1, "/repo");
    for (let index = 0; index < 50; index++) {
      const path = `/repo/file-${index}`;
      addFile(db, path, 100 + index);
      db.run("INSERT INTO fs_chunks (inode, idx, bytes) VALUES (?, 0, x'01')", 100 + index);
      db.run(
        `INSERT INTO git_index (repo_id, path, stage, mode, oid)
         VALUES (1, ?, 0, 33188, ?)`,
        `file-${index}`,
        TREE,
      );
    }
    expect(readIndexTrackerState(db, 1)).toEqual({ available: false });
    expect(dirty(db, 1)).toEqual([]);
    const mutationTriggers = db.all<{ sql: string }>(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger'
          AND (name LIKE 'index_tracker_index_%'
            OR name LIKE 'index_tracker_paths_%'
            OR name LIKE 'index_tracker_nodes_%'
            OR name LIKE 'index_tracker_chunks_%')`,
    );
    expect(mutationTriggers).toHaveLength(13);
    for (const trigger of mutationTriggers) {
      expect(trigger.sql).toContain(
        "WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)",
      );
    }
  });
});
