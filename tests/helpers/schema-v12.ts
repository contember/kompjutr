import type { SqlDatabase } from "../../src/sqlite/db.js";
import { createFrozenV11Schema } from "./schema-v11.js";

// Frozen v12 DDL. Unchanged tables come from the independent v11 fixture;
// v12's rebuilt cache and tree projection tables are replaced with their
// natural v12 shapes.
export function createFrozenV12Schema(db: SqlDatabase): void {
  createFrozenV11Schema(db);
  db.transactionSync(() => {
    db.run("DROP TABLE git_blob_ids");
    db.run(`CREATE TABLE git_blob_ids (
      repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
      content_id BLOB NOT NULL CHECK (typeof(content_id) = 'blob' AND length(content_id) <= 1024),
      oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
      generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
      PRIMARY KEY (repo_id, content_id)
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE git_blob_id_state (
      repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
      generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0)
    )`);
    for (const trigger of [
      "git_tree_effective_loose_insert",
      "git_tree_effective_loose_delete",
      "git_tree_effective_pack_complete",
      "git_tree_effective_pack_delete",
      "git_tree_effective_pack_hide",
    ]) {
      db.run(`DROP TRIGGER ${trigger}`);
    }
    db.run("DROP INDEX git_tree_entries_by_name_bytes");
    db.run("DROP TABLE git_tree_effective");
    db.run("DROP TABLE git_tree_entries");
    db.run("DROP TABLE git_tree_sources");
    db.run(`CREATE TABLE git_tree_sources (
      source_key INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
      tree_oid TEXT NOT NULL CHECK (typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40),
      storage TEXT NOT NULL CHECK (typeof(storage) = 'text' AND storage IN ('loose', 'pack')),
      source_id INTEGER NOT NULL CHECK (typeof(source_id) = 'integer' AND source_id >= 0),
      complete INTEGER NOT NULL CHECK (typeof(complete) = 'integer' AND complete IN (0, 1)),
      object_size INTEGER NOT NULL CHECK (typeof(object_size) = 'integer' AND object_size >= 0),
      entry_count INTEGER CHECK (
        (complete = 0 AND entry_count IS NULL) OR
        (complete = 1 AND typeof(entry_count) = 'integer' AND entry_count >= 0)
      ),
      base_cost INTEGER CHECK (
        (complete = 0 AND base_cost IS NULL) OR
        (complete = 1 AND typeof(base_cost) = 'integer' AND base_cost >= 0)
      ),
      UNIQUE (repo_id, tree_oid, storage, source_id),
      UNIQUE (source_key, repo_id, tree_oid)
    )`);
    db.run(`CREATE TABLE git_tree_entries (
      source_key INTEGER NOT NULL CHECK (typeof(source_key) = 'integer' AND source_key >= 1),
      ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
      mode TEXT NOT NULL CHECK (
        typeof(mode) = 'text' AND mode IN ('40000','040000','100644','100755','120000','160000')
      ),
      name_bytes BLOB NOT NULL CHECK (typeof(name_bytes) = 'blob' AND length(name_bytes) BETWEEN 1 AND 2200),
      oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
      raw_entry BLOB NOT NULL CHECK (typeof(raw_entry) = 'blob'),
      cumulative_base INTEGER NOT NULL CHECK (typeof(cumulative_base) = 'integer' AND cumulative_base >= 0),
      PRIMARY KEY (source_key, ordinal),
      FOREIGN KEY (source_key) REFERENCES git_tree_sources (source_key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE git_tree_effective (
      repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
      tree_oid TEXT NOT NULL CHECK (typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40),
      source_key INTEGER NOT NULL CHECK (typeof(source_key) = 'integer' AND source_key >= 1),
      PRIMARY KEY (repo_id, tree_oid),
      FOREIGN KEY (source_key, repo_id, tree_oid)
        REFERENCES git_tree_sources (source_key, repo_id, tree_oid)
    ) WITHOUT ROWID`);
    db.run("UPDATE git_meta SET value = '12' WHERE key = 'schema_version'");
  });
}
