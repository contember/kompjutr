// The Git schema has one deployable baseline. Existing databases must either
// match it exactly or fail before initialization creates anything.

import { describe, expect, it } from "vitest";
import { initializeFsSchema, ROOT_INODE } from "../src/fs/schema.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { initializeGitSchema, SCHEMA_VERSION } from "../src/sqlite/schema.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

interface SchemaObject {
  type: string;
  name: string;
}

interface SchemaDefinition extends SchemaObject {
  sql: string;
}

const EXPECTED_SCHEMA_OBJECTS: readonly SchemaObject[] = [
  { type: "table", name: "git_blob_id_state" },
  { type: "view", name: "git_blob_id_updates" },
  { type: "trigger", name: "git_blob_id_updates_begin" },
  { type: "trigger", name: "git_blob_id_updates_finish" },
  { type: "trigger", name: "git_blob_id_updates_invalid" },
  { type: "trigger", name: "git_blob_id_updates_mapping" },
  { type: "table", name: "git_blob_ids" },
  { type: "index", name: "git_blob_ids_by_generation" },
  { type: "table", name: "git_commits" },
  { type: "table", name: "git_config" },
  { type: "table", name: "git_index" },
  { type: "table", name: "git_index_dirty" },
  { type: "table", name: "git_index_state" },
  { type: "table", name: "git_meta" },
  { type: "table", name: "git_object_chunks" },
  { type: "table", name: "git_objects" },
  { type: "table", name: "git_operation_state" },
  { type: "table", name: "git_operation_steps" },
  { type: "table", name: "git_operation_touched" },
  { type: "table", name: "git_pack_data" },
  { type: "table", name: "git_pack_meta" },
  { type: "table", name: "git_pack_objects" },
  { type: "index", name: "git_pack_objects_loc" },
  { type: "table", name: "git_pack_pending" },
  { type: "table", name: "git_reflog_entries" },
  { type: "index", name: "git_reflog_entries_by_ref" },
  { type: "index", name: "git_reflog_entries_by_timestamp" },
  { type: "table", name: "git_reflog_state" },
  { type: "table", name: "git_refs" },
  { type: "table", name: "git_repositories" },
  { type: "table", name: "git_shallow" },
  { type: "table", name: "git_tree_effective" },
  { type: "trigger", name: "git_tree_effective_loose_delete" },
  { type: "trigger", name: "git_tree_effective_loose_insert" },
  { type: "trigger", name: "git_tree_effective_pack_complete" },
  { type: "trigger", name: "git_tree_effective_pack_delete" },
  { type: "trigger", name: "git_tree_effective_pack_hide" },
  { type: "table", name: "git_tree_entries" },
  { type: "index", name: "git_tree_entries_by_name_bytes" },
  { type: "view", name: "git_tree_entries_wide" },
  { type: "table", name: "git_tree_sources" },
];

const EXPECTED_TABLE_COLUMNS: readonly (readonly [string, readonly string[]])[] = [
  ["git_meta", ["key", "value"]],
  ["git_repositories", ["id", "root", "head"]],
  ["git_refs", ["repo_id", "name", "target"]],
  ["git_reflog_state", ["repo_id", "next_ordinal"]],
  [
    "git_reflog_entries",
    [
      "repo_id",
      "ref_name",
      "ordinal",
      "old_raw",
      "new_raw",
      "old_oid",
      "new_oid",
      "actor_name",
      "actor_email",
      "timestamp",
      "timezone",
      "reason",
    ],
  ],
  ["git_config", ["repo_id", "path", "seq", "value"]],
  ["git_index", ["repo_id", "path", "stage", "mode", "oid", "size", "mtime", "ino", "rev"]],
  ["git_index_state", ["repo_id", "baseline_tree_oid", "format", "complete"]],
  ["git_index_dirty", ["repo_id", "path", "flags"]],
  [
    "git_operation_state",
    [
      "repo_id",
      "kind",
      "original_head_ref",
      "original_head_oid",
      "phase",
      "empty_reason",
      "current_parent_oid",
      "incoming_parent_oid",
      "upstream_oid",
      "base_oid",
      "mode",
      "merge_origin",
      "current_step",
      "step_count",
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
    ],
  ],
  [
    "git_operation_steps",
    [
      "repo_id",
      "ordinal",
      "source_oid",
      "selected_parent_oid",
      "mainline",
      "outcome",
      "result_oid",
    ],
  ],
  [
    "git_operation_touched",
    [
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
    ],
  ],
  ["git_blob_ids", ["repo_id", "content_id", "oid", "generation"]],
  ["git_blob_id_state", ["repo_id", "generation"]],
  ["git_shallow", ["repo_id", "oid"]],
  ["git_objects", ["repo_id", "oid", "type", "size", "stored"]],
  [
    "git_commits",
    [
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
    ],
  ],
  ["git_object_chunks", ["repo_id", "oid", "seq", "data"]],
  ["git_pack_meta", ["repo_id", "pack_id", "size", "count", "state", "created"]],
  ["git_pack_data", ["repo_id", "pack_id", "seq", "data"]],
  [
    "git_pack_objects",
    [
      "repo_id",
      "oid",
      "pack_id",
      "offset",
      "data_off",
      "data_len",
      "type",
      "size",
      "entry_size",
      "base_oid",
    ],
  ],
  [
    "git_pack_pending",
    [
      "repo_id",
      "pack_id",
      "offset",
      "data_off",
      "data_len",
      "entry_size",
      "base_oid",
      "base_offset",
    ],
  ],
  [
    "git_tree_sources",
    [
      "source_key",
      "repo_id",
      "tree_oid",
      "storage",
      "source_id",
      "complete",
      "object_size",
      "entry_count",
      "base_cost",
    ],
  ],
  [
    "git_tree_entries",
    ["source_key", "ordinal", "mode", "name_bytes", "oid", "raw_entry", "cumulative_base"],
  ],
  ["git_tree_effective", ["repo_id", "tree_oid", "source_key"]],
];

function schemaObjects(db: TestDatabase): SchemaObject[] {
  return db.all<SchemaObject>(
    `SELECT type, name FROM sqlite_schema
      WHERE substr(name, 1, 4) COLLATE NOCASE = 'git_'
      ORDER BY name COLLATE BINARY`,
  );
}

function schemaDefinitions(db: TestDatabase): SchemaDefinition[] {
  return db.all<SchemaDefinition>(
    `SELECT type, name, sql FROM sqlite_schema
      WHERE substr(name, 1, 4) COLLATE NOCASE = 'git_'
      ORDER BY name COLLATE BINARY`,
  );
}

function columnsOf(db: TestDatabase, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
}

class FailVersionWriteDatabase implements SqlDatabase {
  constructor(private readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    if (query.startsWith("INSERT INTO git_meta")) throw new Error("injected version failure");
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

describe("git schema", () => {
  it("creates the exact current schema at deployable version one", () => {
    const db = new TestDatabase();

    initializeGitSchema(db);

    expect(SCHEMA_VERSION).toBe(1);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe("1");
    expect(schemaObjects(db)).toEqual(EXPECTED_SCHEMA_OBJECTS);
    for (const [table, columns] of EXPECTED_TABLE_COLUMNS) {
      expect(columnsOf(db, table), table).toEqual(columns);
    }
  });

  it("keeps current schema data unchanged when reopened", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run(
      "INSERT INTO git_repositories (id, root, head) VALUES (1, '/repo', 'ref: refs/heads/main')",
    );
    db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (1, 0)");
    const before = schemaObjects(db);

    initializeGitSchema(db);

    expect(schemaObjects(db)).toEqual(before);
    expect(db.one("SELECT id, root, head FROM git_repositories")).toEqual({
      id: 1,
      root: "/repo",
      head: "ref: refs/heads/main",
    });
  });

  it("enforces current reflog lifecycle foreign keys", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.create("/repo", "ref: refs/heads/main");
    db.run(
      `INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, 'HEAD', 1, NULL, 'ref: refs/heads/main', NULL, NULL,
               NULL, NULL, 0, 0, 'init')`,
      repository.id,
    );

    db.run("DELETE FROM git_repositories WHERE id = ?", repository.id);

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_reflog_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_reflog_entries")).toBe(0);
    expect(() =>
      db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (99, 0)"),
    ).toThrow(/FOREIGN KEY/);
  });

  it("enforces authenticated merge-origin operation constraints", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    const insert = `INSERT INTO git_operation_state
       (repo_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
        current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
        current_step, step_count, current_label, incoming_label, message,
        author_name, author_email, committer_name, committer_email,
        touched_count, retained_bytes, integrity_oid)
     VALUES (?, 'merge', 'refs/heads/main', ?, 'ready', NULL, ?, ?, NULL, NULL,
             'no-commit', ?, 0, 0, 'HEAD', 'topic', '', NULL, NULL, NULL, NULL, 0, 0, ?)`;
    const oid = "1".repeat(40);

    expect(() => db.run(insert, 1, oid, oid, "2".repeat(40), null, "3".repeat(40))).toThrow();
    db.run(insert, 1, oid, oid, "2".repeat(40), "merge", "3".repeat(40));
    expect(db.scalar<string>("SELECT merge_origin FROM git_operation_state")).toBe("merge");
    expect(() => db.run("UPDATE git_operation_state SET kind = 'rebase'")).toThrow();
  });

  it("rejects partial existing schemas before CREATE can mask them", () => {
    const withoutMetadata = new TestDatabase();
    withoutMetadata.run("CREATE TABLE git_objects (repo_id INTEGER)");
    expect(() => initializeGitSchema(withoutMetadata)).toThrow(/metadata is missing/);
    expect(schemaObjects(withoutMetadata)).toEqual([{ type: "table", name: "git_objects" }]);

    const partial = new TestDatabase();
    partial.run(`CREATE TABLE git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`);
    partial.run("INSERT INTO git_meta (key, value) VALUES ('schema_version', '1')");
    expect(() => initializeGitSchema(partial)).toThrow(/missing required/);
    expect(schemaObjects(partial)).toEqual([{ type: "table", name: "git_meta" }]);

    const missingCurrentObject = new TestDatabase();
    initializeGitSchema(missingCurrentObject);
    missingCurrentObject.run("DROP INDEX git_reflog_entries_by_timestamp");
    expect(() => initializeGitSchema(missingCurrentObject)).toThrow(
      /missing required index git_reflog_entries_by_timestamp/,
    );
    expect(
      missingCurrentObject.scalar<number>(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'git_reflog_entries_by_timestamp'",
      ),
    ).toBe(0);

    const changedCurrentObject = new TestDatabase();
    initializeGitSchema(changedCurrentObject);
    changedCurrentObject.run("DROP INDEX git_reflog_entries_by_timestamp");
    changedCurrentObject.run(
      `CREATE INDEX git_reflog_entries_by_timestamp
         ON git_reflog_entries (repo_id, ordinal)`,
    );
    expect(() => initializeGitSchema(changedCurrentObject)).toThrow(
      /git_reflog_entries_by_timestamp does not match its current definition/,
    );
  });

  it("rejects case-insensitive Git schema aliases before any CREATE attempt", () => {
    const db = new TestDatabase();
    db.run("CREATE TABLE Git_objects (repo_id INTEGER)");
    const before = schemaDefinitions(db);
    db.storage.resetCounters();

    expect(() => initializeGitSchema(db)).toThrow(/metadata is missing/);
    const initializationStatements = db.storage.statementCount;

    expect(initializationStatements).toBe(1);
    expect(schemaDefinitions(db)).toEqual(before);
  });

  it("rejects an over-bound schema definition without retaining its SQL", () => {
    const db = new TestDatabase();
    const columns = Array.from({ length: 400 }, (_, index) => `column_${index} TEXT`).join(", ");
    db.run(`CREATE TABLE git_meta (${columns})`);
    const before = db.scalar<string>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'git_meta'",
    );
    db.storage.resetCounters();

    expect(() => initializeGitSchema(db)).toThrow(/schema object exceeds its read bound/);
    const initializationStatements = db.storage.statementCount;

    expect(initializationStatements).toBe(1);
    expect(
      db.scalar<string>("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'git_meta'"),
    ).toBe(before);
  });

  it("rejects unsupported recorded versions without changing current data", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run(
      "INSERT INTO git_repositories (id, root, head) VALUES (1, '/repo', 'ref: refs/heads/main')",
    );
    db.run("UPDATE git_meta SET value = '2' WHERE key = 'schema_version'");
    const before = schemaObjects(db);

    expect(() => initializeGitSchema(db)).toThrow(/version 2 is unsupported/);

    expect(schemaObjects(db)).toEqual(before);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe("2");
    expect(db.scalar<string>("SELECT root FROM git_repositories WHERE id = 1")).toBe("/repo");
  });

  it("rejects invalid or missing schema metadata", () => {
    const invalidMetadata = new TestDatabase();
    invalidMetadata.run("CREATE TABLE git_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    expect(() => initializeGitSchema(invalidMetadata)).toThrow(
      /git_meta does not match its current definition/,
    );
    expect(schemaObjects(invalidMetadata)).toEqual([{ type: "table", name: "git_meta" }]);

    const missingVersion = new TestDatabase();
    missingVersion.run(`CREATE TABLE git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`);
    expect(() => initializeGitSchema(missingVersion)).toThrow(/version is missing/);

    for (const version of ["", " ", "1.0", "01", "0", "-1", "9007199254740993"]) {
      const db = new TestDatabase();
      initializeGitSchema(db);
      db.run("UPDATE git_meta SET value = ? WHERE key = 'schema_version'", version);

      expect(() => initializeGitSchema(db), version).toThrow(/invalid version/);
      expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
        version,
      );
    }
  });

  it("rejects an over-bound schema version without returning its text", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    const oversizedVersion = "1".repeat(1_024);
    db.run("UPDATE git_meta SET value = ? WHERE key = 'schema_version'", oversizedVersion);
    db.storage.resetCounters();

    expect(() => initializeGitSchema(db)).toThrow(/schema version exceeds its read bound/);
    const initializationStatements = db.storage.statementCount;

    expect(initializationStatements).toBe(2);
    expect(
      db.scalar<number>(
        "SELECT length(CAST(value AS BLOB)) FROM git_meta WHERE key = 'schema_version'",
      ),
    ).toBe(oversizedVersion.length);
  });

  it("rolls a late version-write failure back to an empty database", () => {
    const inner = new TestDatabase();
    const db = new FailVersionWriteDatabase(inner);

    expect(() => initializeGitSchema(db)).toThrow(/injected version failure/);

    expect(schemaObjects(inner)).toEqual([]);
  });

  it("stays below the guarded 1,000-statement initialization ceiling", () => {
    const db = new TestDatabase();
    db.storage.resetCounters();

    initializeGitSchema(db);

    expect(db.storage.statementCount).toBeGreaterThan(0);
    expect(db.storage.statementCount).toBeLessThan(1_000);
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

  it("keeps fs_paths in BINARY path order", () => {
    const db = new TestDatabase();
    initializeFsSchema(db);
    for (const path of ["/a/x", "/a.txt", "/a", "/b", "/a/y"]) {
      db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, '', 0)", path);
    }

    expect(
      db
        .all<{ path: string }>("SELECT path FROM fs_paths WHERE path != '/' ORDER BY path")
        .map((row) => row.path),
    ).toEqual(["/a", "/a.txt", "/a/x", "/a/y", "/b"]);
  });
});
