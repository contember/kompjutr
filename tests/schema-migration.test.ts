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

interface IndexColumn {
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface IndexListEntry {
  name: string;
  unique: number;
  partial: number;
}

function treeNameBytesIndexColumns(db: TestDatabase): IndexColumn[] {
  return db.all<IndexColumn>("PRAGMA index_xinfo(git_tree_entries_by_name_bytes)");
}

function treeNameBytesIndex(db: TestDatabase): IndexListEntry | undefined {
  const index = db
    .all<IndexListEntry>("PRAGMA index_list(git_tree_entries)")
    .find((index) => index.name === "git_tree_entries_by_name_bytes");
  return index === undefined
    ? undefined
    : { name: index.name, unique: index.unique, partial: index.partial };
}

describe("git schema", () => {
  it("creates the current schema on a fresh database", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);

    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
    expect(columnsOf(db, "git_objects")).toContain("stored");
    expect(columnsOf(db, "git_blob_ids")).toEqual(["repo_id", "content_id", "oid"]);
    expect(columnsOf(db, "git_index")).toEqual([
      "repo_id",
      "path",
      "stage",
      "mode",
      "oid",
      "size",
      "mtime",
      "ino",
      "rev",
    ]);
    expect(columnsOf(db, "git_index_state")).toEqual([
      "repo_id",
      "baseline_tree_oid",
      "format",
      "complete",
    ]);
    expect(columnsOf(db, "git_index_dirty")).toEqual(["repo_id", "path", "flags"]);
    expect(columnsOf(db, "git_merge_state")).toEqual([
      "repo_id",
      "original_head_ref",
      "original_head_oid",
      "current_parent_oid",
      "incoming_parent_oid",
      "phase",
      "mode",
      "current_label",
      "incoming_label",
      "message",
      "author_name",
      "author_email",
      "committer_name",
      "committer_email",
      "touched_count",
      "retained_bytes",
      "integrity_oid",
    ]);
    expect(columnsOf(db, "git_merge_touched")).toEqual([
      "repo_id",
      "ordinal",
      "path",
      "logical_path",
      "purpose",
      "index_stage",
      "index_mode",
      "index_oid",
      "index_size",
      "index_mtime",
      "index_ino",
      "index_rev",
      "worktree_kind",
      "worktree_mode",
      "worktree_oid",
      "worktree_revision",
    ]);
    expect(() =>
      db.run(
        "INSERT INTO git_index_state (repo_id, baseline_tree_oid, format, complete) VALUES (1, NULL, 2, 1)",
      ),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO git_index_state (repo_id, baseline_tree_oid, format, complete) VALUES (1, NULL, 1, 2)",
      ),
    ).toThrow();
    for (const flags of [0, 1.5, 3.5, 4, -1]) {
      expect(() =>
        db.run("INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, 'a', ?)", flags),
      ).toThrow();
    }
    db.run(
      "INSERT INTO git_index_state (repo_id, baseline_tree_oid, format, complete) VALUES (1, 'abc', 1, 1)",
    );
    db.run("INSERT INTO git_index_dirty (repo_id, path, flags) VALUES (1, 'a', 3)");
    initializeGitSchema(db);
    expect(db.one("SELECT baseline_tree_oid,format,complete FROM git_index_state")).toEqual({
      baseline_tree_oid: "abc",
      format: 1,
      complete: 1,
    });
    expect(db.one("SELECT path,flags FROM git_index_dirty")).toEqual({ path: "a", flags: 3 });
    expect(columnsOf(db, "git_commits")).toEqual([
      "repo_id",
      "oid",
      "parents",
      "tree",
      "author_name",
      "author_email",
      "author_time",
      "author_timezone",
      "committer_name",
      "committer_email",
      "committer_time",
      "committer_timezone",
      "message",
      "gpgsig",
      "object_size",
      "cache_bytes",
    ]);
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
    expect(
      treeNameBytesIndexColumns(db)
        .filter((column) => column.key === 1)
        .map((column) => ({ name: column.name, coll: column.coll, desc: column.desc })),
    ).toEqual([
      { name: "repo_id", coll: "BINARY", desc: 0 },
      { name: "tree_oid", coll: "BINARY", desc: 0 },
      { name: "storage", coll: "BINARY", desc: 0 },
      { name: "source_id", coll: "BINARY", desc: 0 },
      { name: "name_bytes", coll: "BINARY", desc: 0 },
    ]);
    expect(treeNameBytesIndex(db)).toEqual({
      name: "git_tree_entries_by_name_bytes",
      unique: 0,
      partial: 1,
    });
    expect(
      db
        .scalar<string>(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'git_tree_entries_by_name_bytes'",
        )
        ?.replace(/\s+/g, " "),
    ).toContain("WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200");
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
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
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
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("replaces the incomplete v3 commit cache without touching raw objects", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("DROP TABLE git_commits");
    db.run(`CREATE TABLE git_commits (
      repo_id INTEGER NOT NULL, oid TEXT NOT NULL, parents TEXT NOT NULL,
      tree TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (repo_id, oid)
    ) WITHOUT ROWID`);
    db.run("INSERT INTO git_commits VALUES (1, 'cached', '', 'tree', 123)");
    db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (1, 'raw', 'commit', 7, 'raw')",
    );
    db.run("UPDATE git_meta SET value = '3' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    expect(db.one("SELECT oid, type, size, stored FROM git_objects")).toEqual({
      oid: "raw",
      type: "commit",
      size: 7,
      stored: "raw",
    });
    expect(columnsOf(db, "git_commits")).toContain("committer_timezone");
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("adds the filesystem revision to a v4 index without changing rows", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("ALTER TABLE git_index RENAME TO git_index_v5");
    db.run(`CREATE TABLE git_index (
      repo_id INTEGER NOT NULL, path TEXT NOT NULL, stage INTEGER NOT NULL,
      mode INTEGER NOT NULL, oid TEXT NOT NULL, size INTEGER, mtime INTEGER, ino INTEGER,
      PRIMARY KEY (repo_id, path, stage)
    )`);
    db.run(
      "INSERT INTO git_index SELECT repo_id,path,stage,mode,oid,size,mtime,ino FROM git_index_v5",
    );
    db.run("DROP TABLE git_index_v5");
    db.run("INSERT INTO git_index VALUES (1, 'a.txt', 0, 33188, 'abc', 1, 2, 3)");
    db.run("UPDATE git_meta SET value = '4' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(db.one("SELECT path,size,mtime,ino,rev FROM git_index")).toEqual({
      path: "a.txt",
      size: 1,
      mtime: 2,
      ino: 3,
      rev: null,
    });
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("adds empty sparse-index tables to v5 without changing rows", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("DROP TABLE git_index_dirty");
    db.run("DROP TABLE git_index_state");
    db.run(
      "INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino, rev) VALUES (1, 'a.txt', 0, 33188, 'abc', 1, 2, 3, 4)",
    );
    db.run("UPDATE git_meta SET value = '5' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(db.one("SELECT path,size,mtime,ino,rev FROM git_index")).toEqual({
      path: "a.txt",
      size: 1,
      mtime: 2,
      ino: 3,
      rev: 4,
    });
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_index_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_index_dirty")).toBe(0);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("adds the tree name-bytes index to v6 without changing rows", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("DROP INDEX git_tree_entries_by_name_bytes");
    db.run("INSERT INTO git_tree_sources VALUES (1, 'tree', 'loose', 0, 3, 3, 3)");
    db.run(
      `INSERT INTO git_tree_entries VALUES
         (1, 'tree', 'loose', 0, 0, '100644', 'file', X'66696C65', 'blob-0', X'00', 1),
         (1, 'tree', 'loose', 0, 1, '100644', 'file', X'66696C65', 'blob-1', X'01', 2)`,
    );
    // Migration leaves corrupt v6 rows for read-time source validation.
    db.run(
      `INSERT INTO git_tree_entries VALUES
         (1, 'tree', 'loose', 0, 2, '100644', 'oversized', ?, 'blob-2', X'02', 3)`,
      new Uint8Array(2201),
    );
    db.run("UPDATE git_meta SET value = '6' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(
      db.one(`SELECT repo_id, tree_oid, storage, source_id, ordinal, mode, name,
                     hex(name_bytes) AS name_bytes, oid, hex(raw_entry) AS raw_entry,
                     cumulative_base
                FROM git_tree_entries
               WHERE ordinal = 0`),
    ).toEqual({
      repo_id: 1,
      tree_oid: "tree",
      storage: "loose",
      source_id: 0,
      ordinal: 0,
      mode: "100644",
      name: "file",
      name_bytes: "66696C65",
      oid: "blob-0",
      raw_entry: "00",
      cumulative_base: 1,
    });
    expect(
      db.all<{ ordinal: number; nameBytes: number }>(
        `SELECT ordinal, length(name_bytes) AS nameBytes
           FROM git_tree_entries
          ORDER BY ordinal`,
      ),
    ).toEqual([
      { ordinal: 0, nameBytes: 4 },
      { ordinal: 1, nameBytes: 4 },
      { ordinal: 2, nameBytes: 2201 },
    ]);
    expect(
      db.scalar<number>(`SELECT COUNT(*)
          FROM git_tree_entries INDEXED BY git_tree_entries_by_name_bytes
         WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200`),
    ).toBe(2);
    expect(treeNameBytesIndex(db)).toEqual({
      name: "git_tree_entries_by_name_bytes",
      unique: 0,
      partial: 1,
    });
    expect(
      treeNameBytesIndexColumns(db)
        .filter((column) => column.key === 1)
        .map((column) => column.name),
    ).toEqual(["repo_id", "tree_oid", "storage", "source_id", "name_bytes"]);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("adds empty merge journal tables to v7", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("DROP TABLE git_merge_touched");
    db.run("DROP TABLE git_merge_state");
    db.run("UPDATE git_meta SET value = '7' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_touched")).toBe(0);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("invalidates unauthenticated merge state when migrating v8", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("ALTER TABLE git_merge_state DROP COLUMN integrity_oid");
    db.run(
      `INSERT INTO git_merge_state
         (repo_id, original_head_ref, original_head_oid, current_parent_oid,
          incoming_parent_oid, phase, mode, current_label, incoming_label,
          message, author_name, author_email, committer_name, committer_email,
          touched_count, retained_bytes)
       VALUES (1, 'refs/heads/main', ?, ?, ?, 'ready', 'no-commit', 'HEAD',
               'topic', 'merge', NULL, NULL, NULL, NULL, 0, 0)`,
      "1".repeat(40),
      "1".repeat(40),
      "2".repeat(40),
    );
    db.run("UPDATE git_meta SET value = '8' WHERE key = 'schema_version'");

    initializeGitSchema(db);

    expect(columnsOf(db, "git_merge_state")).toContain("integrity_oid");
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_merge_state")).toBe(0);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it("uses the tree name-bytes index for source-qualified point lookups", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);

    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN
      SELECT ordinal
        FROM git_tree_entries
       WHERE repo_id = 1 AND tree_oid = 'tree' AND storage = 'loose'
         AND source_id = 0 AND typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200
         AND name_bytes = X'66696C65'
       ORDER BY name_bytes`);

    expect(plan.some((row) => row.detail.includes("git_tree_entries_by_name_bytes"))).toBe(true);
  });

  it("fails closed on a schema newer than this runtime", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    const newer = String(SCHEMA_VERSION + 1);
    db.run("UPDATE git_meta SET value = ? WHERE key = 'schema_version'", newer);

    expect(() => initializeGitSchema(db)).toThrow(/newer than supported/);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      newer,
    );
  });

  it("accepts only canonical positive decimal schema versions", () => {
    for (const version of ["", " ", "5.0", "05", "0", "-1", "9007199254740993"]) {
      const db = new TestDatabase();
      initializeGitSchema(db);
      db.run("UPDATE git_meta SET value = ? WHERE key = 'schema_version'", version);

      expect(() => initializeGitSchema(db)).toThrow(/invalid version/);
      expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
        version,
      );
    }
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
    expect(columnsOf(db, "git_index_state")).toEqual([
      "repo_id",
      "baseline_tree_oid",
      "format",
      "complete",
    ]);
    expect(columnsOf(db, "git_index_dirty")).toEqual(["repo_id", "path", "flags"]);
    expect(columnsOf(db, "git_merge_state")).not.toHaveLength(0);
    expect(columnsOf(db, "git_merge_touched")).not.toHaveLength(0);
    expect(treeNameBytesIndexColumns(db)).not.toHaveLength(0);
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
