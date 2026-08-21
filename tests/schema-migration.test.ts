// Git schema migrations, and the filesystem schema's own DDL.
//
// The migration matters because a workspace already running kompjutr as a
// Computer plugin keeps its whole git repository through the switch. Only
// the working tree is imported.

import { describe, expect, it } from "vitest";
import { MODE_FILE, serializeTree } from "../src/core/objects.js";
import { initializeFsSchema, ROOT_INODE } from "../src/fs/schema.js";
import { initializeGitSchema, SCHEMA_VERSION } from "../src/sqlite/schema.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

/** The v1 schema, as it shipped: no git_blob_ids, no git_commits, no `stored`. */
function createV1(db: TestDatabase): void {
  db.run("CREATE TABLE git_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run(`CREATE TABLE git_objects (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     PRIMARY KEY (repo_id, oid)
   )`);
  db.run("INSERT INTO git_meta (key, value) VALUES ('schema_version', '1')");
}

function columnsOf(db: TestDatabase, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
}

describe("git schema", () => {
  it("creates v3 on a fresh database", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);

    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
    expect(columnsOf(db, "git_objects")).toContain("stored");
    expect(columnsOf(db, "git_blob_ids")).toEqual(["repo_id", "content_id", "oid"]);
    expect(columnsOf(db, "git_commits")).toEqual(["repo_id", "oid", "parents", "tree", "time"]);
    expect(columnsOf(db, "git_tree_sources")).toEqual([
      "repo_id",
      "tree_oid",
      "storage",
      "source_id",
      "object_size",
      "entry_count",
      "base_cost",
    ]);
    expect(columnsOf(db, "git_tree_entries")).toEqual([
      "repo_id",
      "tree_oid",
      "storage",
      "source_id",
      "ordinal",
      "mode",
      "name",
      "name_bytes",
      "oid",
      "raw_entry",
      "cumulative_base",
    ]);
    expect(columnsOf(db, "git_tree_effective")).toEqual([
      "repo_id",
      "tree_oid",
      "storage",
      "source_id",
    ]);
  });

  it("migrates a v1 database without touching its rows", () => {
    const db = new TestDatabase();
    createV1(db);
    db.run("INSERT INTO git_objects (repo_id, oid, type, size) VALUES (1, 'abc', 'blob', 7)");

    initializeGitSchema(db);

    expect(columnsOf(db, "git_objects")).toContain("stored");
    expect(db.one("SELECT oid, type, size, stored FROM git_objects")).toEqual({
      oid: "abc",
      type: "blob",
      size: 7,
      // Existing rows inherit the default, which is what they were.
      stored: "zlib",
    });
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe("3");
  });

  it("creates empty parsed-tree tables when migrating v2", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("DROP TABLE git_tree_entries");
    db.run("DROP TABLE git_tree_sources");
    db.run("DROP TABLE git_tree_effective");
    db.run("UPDATE git_meta SET value = '2' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe("3");
  });

  it("fails an unmarked pre-v3 tree before yielding a path", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const oid = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: "1".repeat(40) }]),
    );
    db.run("DELETE FROM git_tree_entries WHERE repo_id = 1 AND tree_oid = ?", oid);
    db.run("DELETE FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?", oid);

    const iterator = store.walkTree(oid);
    expect(() => iterator.next()).toThrow(/reimport or reclone/);
  });

  it("is idempotent", () => {
    const db = new TestDatabase();
    createV1(db);
    initializeGitSchema(db);
    // A second run must not try to add `stored` again.
    expect(() => initializeGitSchema(db)).not.toThrow();
    expect(columnsOf(db, "git_objects").filter((c) => c === "stored")).toHaveLength(1);
  });
});

describe("fs schema", () => {
  it("seeds the root directory", () => {
    const db = new TestDatabase();
    initializeFsSchema(db, () => 1234);

    expect(db.one("SELECT path, parent, inode FROM fs_paths")).toEqual({
      path: "/",
      parent: "",
      inode: ROOT_INODE,
    });
    expect(db.one("SELECT type, mode, mtime FROM fs_nodes WHERE inode = ?", ROOT_INODE)).toEqual({
      type: "dir",
      mode: 0o755,
      mtime: 1234,
    });
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(ROOT_INODE + 1);
  });

  it("does not re-seed or reset the revision on a second run", () => {
    const db = new TestDatabase();
    initializeFsSchema(db, () => 1);
    db.run("UPDATE fs_meta SET v = 42 WHERE k = 'rev'");
    db.run("UPDATE fs_meta SET v = 99 WHERE k = 'next_inode'");

    initializeFsSchema(db, () => 2);

    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(42);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(99);
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
  });

  it("keeps fs_paths in BINARY path order, which is git's tree order", () => {
    const db = new TestDatabase();
    initializeFsSchema(db);
    for (const path of ["/a/x", "/a.txt", "/a", "/b", "/a/y"]) {
      db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, '', 0)", path);
    }

    // '.' is 0x2E and '/' is 0x2F, so `a.txt` sorts before `a/x`.
    expect(
      db
        .all<{ path: string }>("SELECT path FROM fs_paths WHERE path != '/' ORDER BY path")
        .map((r) => r.path),
    ).toEqual(["/a", "/a.txt", "/a/x", "/a/y", "/b"]);
  });
});
