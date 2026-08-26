import type { SqlDatabase } from "../../src/sqlite/db.js";

// Frozen v11 DDL. Keep this independent from the current schema initializer.
const V11_STATEMENTS = [
  `CREATE TABLE git_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE git_repositories (
     id INTEGER PRIMARY KEY, root TEXT NOT NULL UNIQUE, head TEXT NOT NULL
   )`,
  `CREATE TABLE git_refs (
     repo_id INTEGER NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL,
     PRIMARY KEY (repo_id, name)
   )`,
  `CREATE TABLE git_config (
     repo_id INTEGER NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL,
     PRIMARY KEY (repo_id, path, seq)
   )`,
  `CREATE TABLE git_index (
     repo_id INTEGER NOT NULL, path TEXT NOT NULL, stage INTEGER NOT NULL,
     mode INTEGER NOT NULL, oid TEXT NOT NULL, size INTEGER, mtime INTEGER, ino INTEGER,
     rev INTEGER, PRIMARY KEY (repo_id, path, stage)
   )`,
  `CREATE TABLE git_index_state (
     repo_id INTEGER PRIMARY KEY, baseline_tree_oid TEXT,
     format INTEGER NOT NULL CHECK (format = 1),
     complete INTEGER NOT NULL CHECK (complete IN (0, 1))
   )`,
  `CREATE TABLE git_index_dirty (
     repo_id INTEGER NOT NULL, path TEXT NOT NULL,
     flags INTEGER NOT NULL CHECK (typeof(flags) = 'integer' AND flags IN (1, 2, 3)),
     PRIMARY KEY (repo_id, path)
   ) WITHOUT ROWID`,
  `CREATE TABLE git_operation_state (
     repo_id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('merge', 'cherry-pick', 'revert', 'rebase')),
     original_head_ref TEXT NOT NULL, original_head_oid TEXT NOT NULL,
     phase TEXT NOT NULL CHECK (phase IN ('conflicted', 'ready', 'empty', 'running')),
     empty_reason TEXT CHECK (empty_reason IN ('source', 'result')),
     current_parent_oid TEXT, incoming_parent_oid TEXT, upstream_oid TEXT, base_oid TEXT,
     mode TEXT CHECK (mode IN ('commit', 'no-commit')),
     current_step INTEGER NOT NULL, step_count INTEGER NOT NULL,
     current_label TEXT NOT NULL, incoming_label TEXT NOT NULL, message TEXT NOT NULL,
     author_name TEXT, author_email TEXT, committer_name TEXT, committer_email TEXT,
     touched_count INTEGER NOT NULL, retained_bytes INTEGER NOT NULL, integrity_oid TEXT NOT NULL
   )`,
  `CREATE TABLE git_operation_steps (
     repo_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, source_oid TEXT NOT NULL,
     selected_parent_oid TEXT, mainline INTEGER, outcome TEXT NOT NULL, result_oid TEXT,
     PRIMARY KEY (repo_id, ordinal)
   ) WITHOUT ROWID`,
  `CREATE TABLE git_operation_touched (
     repo_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL,
     logical_path TEXT NOT NULL, purpose TEXT NOT NULL, index_stage INTEGER,
     index_mode INTEGER, index_oid TEXT, index_size INTEGER, index_mtime INTEGER,
     index_ino INTEGER, index_rev INTEGER, worktree_kind TEXT NOT NULL,
     worktree_mode INTEGER, worktree_oid TEXT, worktree_revision INTEGER,
     PRIMARY KEY (repo_id, ordinal), UNIQUE (repo_id, path)
   ) WITHOUT ROWID`,
  `CREATE TABLE git_blob_ids (
     repo_id INTEGER NOT NULL, content_id BLOB NOT NULL, oid TEXT NOT NULL,
     PRIMARY KEY (repo_id, content_id)
   ) WITHOUT ROWID`,
  `CREATE TABLE git_shallow (
     repo_id INTEGER NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (repo_id, oid)
   )`,
  `CREATE TABLE git_objects (
     repo_id INTEGER NOT NULL, oid TEXT NOT NULL, type TEXT NOT NULL,
     size INTEGER NOT NULL, stored TEXT NOT NULL DEFAULT 'zlib',
     PRIMARY KEY (repo_id, oid)
   )`,
  `CREATE TABLE git_commits (
     repo_id INTEGER NOT NULL, oid TEXT NOT NULL, parents TEXT NOT NULL, tree TEXT NOT NULL,
     author_name BLOB NOT NULL, author_email BLOB NOT NULL, author_time INTEGER NOT NULL,
     author_timezone INTEGER NOT NULL, committer_name BLOB NOT NULL,
     committer_email BLOB NOT NULL, committer_time INTEGER NOT NULL,
     committer_timezone INTEGER NOT NULL, message BLOB NOT NULL, gpgsig BLOB,
     object_size INTEGER NOT NULL, cache_bytes INTEGER NOT NULL,
     PRIMARY KEY (repo_id, oid)
   ) WITHOUT ROWID`,
  `CREATE TABLE git_object_chunks (
     repo_id INTEGER NOT NULL, oid TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq)
   )`,
  `CREATE TABLE git_pack_meta (
     repo_id INTEGER NOT NULL, pack_id INTEGER NOT NULL, size INTEGER NOT NULL,
     count INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
     PRIMARY KEY (repo_id, pack_id)
   )`,
  `CREATE TABLE git_pack_data (
     repo_id INTEGER NOT NULL, pack_id INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq)
   )`,
  `CREATE TABLE git_pack_objects (
     repo_id INTEGER NOT NULL, oid TEXT NOT NULL, pack_id INTEGER NOT NULL,
     offset INTEGER NOT NULL, data_off INTEGER NOT NULL, data_len INTEGER NOT NULL,
     type TEXT NOT NULL, size INTEGER NOT NULL, entry_size INTEGER NOT NULL, base_oid TEXT,
     PRIMARY KEY (repo_id, oid)
   )`,
  `CREATE INDEX git_pack_objects_loc ON git_pack_objects (repo_id, pack_id, offset)`,
  `CREATE TABLE git_pack_pending (
     repo_id INTEGER NOT NULL, pack_id INTEGER NOT NULL, offset INTEGER NOT NULL,
     data_off INTEGER NOT NULL, data_len INTEGER NOT NULL, entry_size INTEGER NOT NULL,
     base_oid TEXT, base_offset INTEGER, PRIMARY KEY (repo_id, pack_id, offset)
   )`,
  `CREATE TABLE git_tree_sources (
     repo_id INTEGER NOT NULL, tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
     source_id INTEGER NOT NULL, object_size INTEGER NOT NULL,
     entry_count INTEGER NOT NULL, base_cost INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid, storage, source_id)
   ) WITHOUT ROWID`,
  `CREATE TABLE git_tree_entries (
     repo_id INTEGER NOT NULL, tree_oid TEXT NOT NULL, storage TEXT NOT NULL,
     source_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, mode TEXT NOT NULL,
     name TEXT COLLATE BINARY NOT NULL, name_bytes BLOB NOT NULL, oid TEXT NOT NULL,
     raw_entry BLOB NOT NULL, cumulative_base INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid, storage, source_id, ordinal),
     FOREIGN KEY (repo_id, tree_oid, storage, source_id)
       REFERENCES git_tree_sources (repo_id, tree_oid, storage, source_id)
       ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
   ) WITHOUT ROWID`,
  `CREATE INDEX git_tree_entries_by_name_bytes
     ON git_tree_entries (repo_id, tree_oid, storage, source_id, name_bytes)
     WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200`,
  `CREATE TABLE git_tree_effective (
     repo_id INTEGER NOT NULL, tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
     source_id INTEGER NOT NULL, PRIMARY KEY (repo_id, tree_oid)
   ) WITHOUT ROWID`,
  `CREATE TRIGGER git_tree_effective_loose_insert
   AFTER INSERT ON git_objects WHEN NEW.type = 'tree'
   BEGIN
     INSERT OR REPLACE INTO git_tree_effective (repo_id, tree_oid, storage, source_id)
     VALUES (NEW.repo_id, NEW.oid, 'loose', 0);
   END`,
  `CREATE TRIGGER git_tree_effective_loose_delete
   AFTER DELETE ON git_objects WHEN OLD.type = 'tree'
   BEGIN
     DELETE FROM git_tree_entries
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND storage = 'loose' AND source_id = 0;
     DELETE FROM git_tree_sources
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND storage = 'loose' AND source_id = 0;
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid AND storage = 'loose';
     INSERT OR REPLACE INTO git_tree_effective (repo_id, tree_oid, storage, source_id)
     SELECT object.repo_id, object.oid, 'pack', object.pack_id
       FROM git_pack_objects object
       JOIN git_pack_meta pack ON pack.repo_id = object.repo_id
        AND pack.pack_id = object.pack_id AND pack.state = 'complete'
      WHERE object.repo_id = OLD.repo_id AND object.oid = OLD.oid AND object.type = 'tree';
   END`,
  `CREATE TRIGGER git_tree_effective_pack_complete
   AFTER UPDATE OF state ON git_pack_meta
   WHEN NEW.state = 'complete' AND OLD.state != 'complete'
   BEGIN
     INSERT OR REPLACE INTO git_tree_effective (repo_id, tree_oid, storage, source_id)
     SELECT object.repo_id, object.oid, 'pack', object.pack_id
       FROM git_pack_objects object
      WHERE object.repo_id = NEW.repo_id AND object.pack_id = NEW.pack_id
        AND object.type = 'tree'
        AND NOT EXISTS (
          SELECT 1 FROM git_objects loose
           WHERE loose.repo_id = object.repo_id AND loose.oid = object.oid
             AND loose.type = 'tree'
        );
   END`,
  `CREATE TRIGGER git_tree_effective_pack_delete
   AFTER DELETE ON git_pack_meta WHEN OLD.state = 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id;
   END`,
  `CREATE TRIGGER git_tree_effective_pack_hide
   AFTER UPDATE OF state ON git_pack_meta
   WHEN OLD.state = 'complete' AND NEW.state != 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id;
   END`,
];

export function createFrozenV11Schema(db: SqlDatabase): void {
  db.transactionSync(() => {
    for (const statement of V11_STATEMENTS) db.run(statement);
    db.run("INSERT INTO git_meta (key, value) VALUES ('schema_version', '11')");
  });
}
