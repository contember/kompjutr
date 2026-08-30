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

const TABLE_OWNERSHIP = new Map<string, "global" | "shared" | "checkout">([
  ["git_meta", "global"],
  ["git_identity_control", "global"],
  ["git_repositories", "shared"],
  ["git_refs", "shared"],
  ["git_tracking_ref_revisions", "shared"],
  ["git_fetch_namespaces", "shared"],
  ["git_reflog_state", "shared"],
  ["git_reflog_entries", "shared"],
  ["git_config", "shared"],
  ["git_scratch_indexes", "shared"],
  ["git_scratch_index_entries", "shared"],
  ["git_blob_id_state", "shared"],
  ["git_blob_ids", "shared"],
  ["git_shallow", "shared"],
  ["git_objects", "shared"],
  ["git_loose_object_lifecycle", "shared"],
  ["git_maintenance_control", "shared"],
  ["git_maintenance_runs", "shared"],
  ["git_maintenance_objects", "shared"],
  ["git_maintenance_shallow", "shared"],
  ["git_maintenance_repack_batches", "shared"],
  ["git_maintenance_repack_objects", "shared"],
  ["git_loose_gc_candidates", "shared"],
  ["git_pack_gc_candidates", "shared"],
  ["git_pack_ingest_control", "shared"],
  ["git_commits", "shared"],
  ["git_object_chunks", "shared"],
  ["git_pack_meta", "shared"],
  ["git_pack_data", "shared"],
  ["git_pack_entries", "shared"],
  ["git_pack_objects", "shared"],
  ["git_pack_pending", "shared"],
  ["git_tree_sources", "shared"],
  ["git_tree_entries", "shared"],
  ["git_tree_effective", "shared"],
  ["git_checkouts", "checkout"],
  ["git_checkout_reflog_entries", "checkout"],
  ["git_index", "checkout"],
  ["git_index_state", "checkout"],
  ["git_index_dirty", "checkout"],
  ["git_operation_state", "checkout"],
  ["git_operation_steps", "checkout"],
  ["git_operation_touched", "checkout"],
]);

const EXPECTED_SCHEMA_OBJECTS: readonly SchemaObject[] = [
  { type: "table", name: "git_blob_id_state" },
  { type: "view", name: "git_blob_id_updates" },
  { type: "trigger", name: "git_blob_id_updates_begin" },
  { type: "trigger", name: "git_blob_id_updates_finish" },
  { type: "trigger", name: "git_blob_id_updates_invalid" },
  { type: "trigger", name: "git_blob_id_updates_mapping" },
  { type: "table", name: "git_blob_ids" },
  { type: "index", name: "git_blob_ids_by_generation" },
  { type: "table", name: "git_checkout_reflog_entries" },
  { type: "index", name: "git_checkout_reflog_entries_by_ordinal" },
  { type: "index", name: "git_checkout_reflog_entries_by_timestamp" },
  { type: "table", name: "git_checkouts" },
  { type: "index", name: "git_checkouts_attached_branch" },
  { type: "trigger", name: "git_checkouts_identity_immutable" },
  { type: "index", name: "git_checkouts_primary" },
  { type: "table", name: "git_commits" },
  { type: "table", name: "git_config" },
  { type: "table", name: "git_fetch_namespaces" },
  { type: "table", name: "git_identity_control" },
  { type: "table", name: "git_index" },
  { type: "table", name: "git_index_dirty" },
  { type: "table", name: "git_index_state" },
  { type: "table", name: "git_loose_gc_candidates" },
  { type: "table", name: "git_loose_object_lifecycle" },
  { type: "table", name: "git_maintenance_control" },
  { type: "table", name: "git_maintenance_objects" },
  { type: "index", name: "git_maintenance_objects_queue" },
  { type: "table", name: "git_maintenance_repack_batches" },
  { type: "table", name: "git_maintenance_repack_objects" },
  { type: "table", name: "git_maintenance_runs" },
  { type: "table", name: "git_maintenance_shallow" },
  { type: "table", name: "git_meta" },
  { type: "table", name: "git_object_chunks" },
  { type: "table", name: "git_objects" },
  { type: "table", name: "git_operation_state" },
  { type: "table", name: "git_operation_steps" },
  { type: "table", name: "git_operation_touched" },
  { type: "table", name: "git_pack_data" },
  { type: "table", name: "git_pack_entries" },
  { type: "index", name: "git_pack_entries_by_oid" },
  { type: "table", name: "git_pack_gc_candidates" },
  { type: "table", name: "git_pack_ingest_control" },
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
  { type: "table", name: "git_scratch_index_entries" },
  { type: "table", name: "git_scratch_indexes" },
  { type: "table", name: "git_shallow" },
  { type: "table", name: "git_tracking_ref_revisions" },
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
  [
    "git_identity_control",
    ["singleton", "last_repo_id", "last_checkout_id", "last_clone_generation"],
  ],
  [
    "git_repositories",
    [
      "id",
      "lifecycle",
      "clone_generation",
      "clone_expires_ms",
      "fetch_generation",
      "shallow_revision",
      "checkout_revision",
    ],
  ],
  ["git_checkouts", ["id", "repo_id", "root", "head", "is_primary"]],
  ["git_refs", ["repo_id", "name", "target"]],
  ["git_tracking_ref_revisions", ["repo_id", "ref_name", "revision"]],
  ["git_fetch_namespaces", ["repo_id", "tracking_prefix", "latest_generation", "revision"]],
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
  [
    "git_checkout_reflog_entries",
    [
      "checkout_id",
      "repo_id",
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
  ["git_index", ["checkout_id", "path", "stage", "mode", "oid", "size", "mtime", "ino", "rev"]],
  ["git_scratch_indexes", ["repo_id", "name"]],
  [
    "git_scratch_index_entries",
    ["repo_id", "name", "path", "stage", "mode", "oid", "size", "mtime", "ino", "rev"],
  ],
  ["git_index_state", ["checkout_id", "baseline_tree_oid", "format", "complete"]],
  ["git_index_dirty", ["checkout_id", "path", "flags"]],
  [
    "git_operation_state",
    [
      "checkout_id",
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
      "checkout_id",
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
      "checkout_id",
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
    "git_pack_ingest_control",
    ["repo_id", "owner_generation", "last_pack_id", "active_pack_id", "expires_ms"],
  ],
  [
    "git_pack_entries",
    [
      "repo_id",
      "pack_id",
      "oid",
      "offset",
      "data_off",
      "data_len",
      "type",
      "size",
      "entry_size",
      "base_oid",
    ],
  ],
  ["git_loose_object_lifecycle", ["repo_id", "oid", "created_ms"]],
  ["git_maintenance_control", ["repo_id", "root_epoch", "next_run_id"]],
  [
    "git_maintenance_runs",
    [
      "repo_id",
      "run_id",
      "observed_root_epoch",
      "phase",
      "started_ms",
      "root_source",
      "cursor_checkout_id",
      "cursor_text",
      "cursor_ordinal",
      "reachable_objects",
      "queued_objects",
      "repacked_objects",
      "reclaimed_objects",
      "reclaimed_packs",
      "reclaimed_bytes",
      "next_eligible_ms",
      "restarted",
    ],
  ],
  [
    "git_maintenance_objects",
    [
      "repo_id",
      "run_id",
      "oid",
      "source_mask",
      "expanded",
      "shallow_boundary",
      "physical_only",
      "edge_cursor",
    ],
  ],
  ["git_maintenance_shallow", ["repo_id", "run_id", "oid"]],
  [
    "git_maintenance_repack_batches",
    [
      "repo_id",
      "run_id",
      "batch_id",
      "state",
      "pack_id",
      "object_count",
      "inflated_bytes",
      "stored_bytes",
    ],
  ],
  [
    "git_maintenance_repack_objects",
    ["repo_id", "run_id", "batch_id", "oid", "ordinal", "type", "size"],
  ],
  ["git_loose_gc_candidates", ["repo_id", "oid", "unreachable_since_ms"]],
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
  ["git_pack_gc_candidates", ["repo_id", "pack_id", "unreachable_since_ms"]],
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

function primaryKeyOf(db: TestDatabase, table: string): string[] {
  return db
    .all<{ name: string }>(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`, table)
    .map((row) => row.name);
}

function cascadeForeignKeysOf(
  db: TestDatabase,
  table: string,
): Array<{ table: string; from: string; to: string }> {
  return db.all<{ table: string; from: string; to: string }>(
    `SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)
      WHERE on_delete = 'CASCADE' ORDER BY id, seq`,
    table,
  );
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

  it("executes the shared and checkout ownership matrix with exact keys and cascades", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    const tables = db.all<{ name: string }>(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND substr(name, 1, 4) = 'git_'
        ORDER BY name COLLATE BINARY`,
    );
    expect(tables).toHaveLength(TABLE_OWNERSHIP.size);
    for (const { name } of tables) expect(TABLE_OWNERSHIP.has(name), name).toBe(true);

    for (const [table, owner] of TABLE_OWNERSHIP) {
      const columns = columnsOf(db, table);
      if (owner === "checkout" && table !== "git_checkouts") {
        expect(columns, table).toContain("checkout_id");
      }
      if (owner === "shared" && table !== "git_tree_entries") {
        expect(columns, table).not.toContain("checkout_id");
      }
    }
    expect(primaryKeyOf(db, "git_repositories")).toEqual(["id"]);
    expect(primaryKeyOf(db, "git_identity_control")).toEqual(["singleton"]);
    expect(primaryKeyOf(db, "git_checkouts")).toEqual(["id"]);
    expect(primaryKeyOf(db, "git_fetch_namespaces")).toEqual(["repo_id", "tracking_prefix"]);
    expect(primaryKeyOf(db, "git_tracking_ref_revisions")).toEqual(["repo_id", "ref_name"]);
    expect(primaryKeyOf(db, "git_index")).toEqual(["checkout_id", "path", "stage"]);
    expect(primaryKeyOf(db, "git_scratch_indexes")).toEqual(["repo_id", "name"]);
    expect(primaryKeyOf(db, "git_scratch_index_entries")).toEqual([
      "repo_id",
      "name",
      "path",
      "stage",
    ]);
    expect(primaryKeyOf(db, "git_index_state")).toEqual(["checkout_id"]);
    expect(primaryKeyOf(db, "git_index_dirty")).toEqual(["checkout_id", "path"]);
    expect(primaryKeyOf(db, "git_operation_state")).toEqual(["checkout_id"]);
    expect(primaryKeyOf(db, "git_operation_steps")).toEqual(["checkout_id", "ordinal"]);
    expect(primaryKeyOf(db, "git_operation_touched")).toEqual(["checkout_id", "ordinal"]);
    expect(primaryKeyOf(db, "git_checkout_reflog_entries")).toEqual(["checkout_id", "ordinal"]);
    expect(primaryKeyOf(db, "git_pack_ingest_control")).toEqual(["repo_id"]);
    expect(primaryKeyOf(db, "git_pack_entries")).toEqual(["repo_id", "pack_id", "offset"]);

    expect(cascadeForeignKeysOf(db, "git_checkouts")).toEqual([
      { table: "git_repositories", from: "repo_id", to: "id" },
    ]);
    expect(cascadeForeignKeysOf(db, "git_fetch_namespaces")).toEqual([
      { table: "git_repositories", from: "repo_id", to: "id" },
    ]);
    expect(cascadeForeignKeysOf(db, "git_tracking_ref_revisions")).toEqual([
      { table: "git_repositories", from: "repo_id", to: "id" },
    ]);
    expect(cascadeForeignKeysOf(db, "git_scratch_indexes")).toEqual([
      { table: "git_repositories", from: "repo_id", to: "id" },
    ]);
    expect(cascadeForeignKeysOf(db, "git_scratch_index_entries")).toEqual([
      { table: "git_scratch_indexes", from: "repo_id", to: "repo_id" },
      { table: "git_scratch_indexes", from: "name", to: "name" },
    ]);
    for (const table of ["git_index", "git_index_state", "git_index_dirty"]) {
      expect(cascadeForeignKeysOf(db, table), table).toEqual([
        { table: "git_checkouts", from: "checkout_id", to: "id" },
      ]);
    }
    expect(cascadeForeignKeysOf(db, "git_operation_state")).toEqual([
      { table: "git_checkouts", from: "checkout_id", to: "id" },
    ]);
    for (const table of ["git_operation_steps", "git_operation_touched"]) {
      expect(cascadeForeignKeysOf(db, table), table).toEqual([
        { table: "git_operation_state", from: "checkout_id", to: "checkout_id" },
      ]);
    }
    expect(cascadeForeignKeysOf(db, "git_checkout_reflog_entries")).toEqual([
      { table: "git_reflog_state", from: "repo_id", to: "repo_id" },
      { table: "git_checkouts", from: "checkout_id", to: "id" },
      { table: "git_checkouts", from: "repo_id", to: "repo_id" },
    ]);
    expect(cascadeForeignKeysOf(db, "git_pack_ingest_control")).toEqual([
      { table: "git_repositories", from: "repo_id", to: "id" },
    ]);
    expect(cascadeForeignKeysOf(db, "git_pack_entries")).toEqual([
      { table: "git_pack_meta", from: "repo_id", to: "repo_id" },
      { table: "git_pack_meta", from: "pack_id", to: "pack_id" },
    ]);
  });

  it("keeps current schema data unchanged when reopened", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    const head = `ref: refs/heads/${"h".repeat(1_009)}`;
    const tracking = `refs/remotes/${"t".repeat(1_012)}`;
    const prefixBase = "refs/remotes/";
    const trackingPrefix = `${prefixBase}${"p".repeat(1_025 - prefixBase.length - 1)}/`;
    expect(head).toHaveLength(1_025);
    expect(tracking).toHaveLength(1_025);
    expect(trackingPrefix).toHaveLength(1_025);
    db.run("INSERT INTO git_repositories (id, fetch_generation) VALUES (1, 1)");
    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (17, 1, '/repo', ?, 1)`,
      head,
    );
    db.run(
      "INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision) VALUES (1, ?, 0)",
      tracking,
    );
    db.run(
      `INSERT INTO git_fetch_namespaces
         (repo_id, tracking_prefix, latest_generation, revision) VALUES (1, ?, 1, 0)`,
      trackingPrefix,
    );
    db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (1, 0)");
    const before = schemaObjects(db);

    initializeGitSchema(db);

    expect(schemaObjects(db)).toEqual(before);
    expect(db.one("SELECT id, repo_id, root, head, is_primary FROM git_checkouts")).toEqual({
      id: 17,
      repo_id: 1,
      root: "/repo",
      head,
      is_primary: 1,
    });
    expect(db.scalar<string>("SELECT ref_name FROM git_tracking_ref_revisions")).toBe(tracking);
    expect(db.scalar<string>("SELECT tracking_prefix FROM git_fetch_namespaces")).toBe(
      trackingPrefix,
    );
  });

  it("enforces immutable canonical checkout identity and validates one primary", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    db.run("INSERT INTO git_repositories (id) VALUES (41), (42), (43)");
    const exactRoot = `/${"a".repeat(4_095)}`;
    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (101, 41, ?, 'ref: refs/heads/unborn', 1)`,
      exactRoot,
    );
    expect(db.scalar<number>("SELECT length(CAST(root AS BLOB)) FROM git_checkouts")).toBe(4_096);
    const formerFirstExcess = `/${"b".repeat(4_096)}`;
    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (102, 42, ?, ?, 1)`,
      formerFirstExcess,
      "1".repeat(40),
    );
    expect(
      db.scalar<number>("SELECT length(CAST(root AS BLOB)) FROM git_checkouts WHERE id = 102"),
    ).toBe(4_097);
    expect(() =>
      db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (103, 42, ?, ?, 1)`,
        exactRoot,
        "1".repeat(40),
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (104, 41, '/other', 'ref: refs/heads/other', 1)`,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (105, 41, '/attached', 'ref: refs/heads/unborn', 0)`,
      ),
    ).toThrow(/UNIQUE/);
    expect(() => db.run("UPDATE git_checkouts SET root = '/moved' WHERE id = 101")).toThrow(
      /immutable/,
    );

    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (143, 43, '/no-primary', ?, 0)`,
      "1".repeat(40),
    );
    expect(() => database.openShared(43)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("bounds the repository checkout-state revision", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run(
      "INSERT INTO git_repositories (id, checkout_revision) VALUES (1, ?)",
      Number.MAX_SAFE_INTEGER,
    );
    expect(db.scalar<number>("SELECT checkout_revision FROM git_repositories WHERE id = 1")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() =>
      db.run("INSERT INTO git_repositories (id, checkout_revision) VALUES (2, -1)"),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run("INSERT INTO git_repositories (id, checkout_revision) VALUES (3, zeroblob(1))"),
    ).toThrow(/CHECK/);
  });

  it("enforces current reflog lifecycle foreign keys", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    db.run(
      `INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, 'refs/tags/x', 1, NULL, ?, NULL, ?,
               NULL, NULL, 0, 0, 'init')`,
      repository.repoId,
      "1".repeat(40),
      "1".repeat(40),
    );
    db.run(
      `INSERT INTO git_checkout_reflog_entries
         (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, ?, 2, NULL, 'ref: refs/heads/main', NULL, NULL,
               NULL, NULL, 0, 0, 'init')`,
      repository.id,
      repository.repoId,
    );

    db.run("DELETE FROM git_repositories WHERE id = ?", repository.repoId);

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_reflog_state")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_reflog_entries")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_checkout_reflog_entries")).toBe(0);
    expect(() =>
      db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (99, 0)"),
    ).toThrow(/FOREIGN KEY/);
  });

  it("enforces authenticated merge-origin operation constraints", () => {
    const db = new TestDatabase();
    initializeGitSchema(db);
    db.run("INSERT INTO git_repositories (id) VALUES (1)");
    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (17, 1, '/repo', 'ref: refs/heads/main', 1)`,
    );
    const insert = `INSERT INTO git_operation_state
       (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
        current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
        current_step, step_count, current_label, incoming_label, message,
        author_name, author_email, committer_name, committer_email,
        touched_count, retained_bytes, integrity_oid)
     VALUES (?, 'merge', 'refs/heads/main', ?, 'ready', NULL, ?, ?, NULL, NULL,
             'no-commit', ?, 0, 0, 'HEAD', 'topic', '', NULL, NULL, NULL, NULL, 0, 0, ?)`;
    const oid = "1".repeat(40);

    expect(() => db.run(insert, 17, oid, oid, "2".repeat(40), null, "3".repeat(40))).toThrow();
    db.run(insert, 17, oid, oid, "2".repeat(40), "merge", "3".repeat(40));
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
    db.run("INSERT INTO git_repositories (id) VALUES (1)");
    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (17, 1, '/repo', 'ref: refs/heads/main', 1)`,
    );
    db.run("UPDATE git_meta SET value = '2' WHERE key = 'schema_version'");
    const before = schemaObjects(db);

    expect(() => initializeGitSchema(db)).toThrow(/version 2 is unsupported/);

    expect(schemaObjects(db)).toEqual(before);
    expect(db.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe("2");
    expect(db.scalar<string>("SELECT root FROM git_checkouts WHERE id = 17")).toBe("/repo");
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

  it("keeps schema initialization within the statement target", () => {
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
