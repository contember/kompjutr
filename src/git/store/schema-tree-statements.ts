export const TREE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_tree_sources (
     source_key INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     tree_oid TEXT NOT NULL CHECK (
       typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40
     ),
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
     UNIQUE (source_key, repo_id, tree_oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_tree_entries (
     source_key INTEGER NOT NULL CHECK (typeof(source_key) = 'integer' AND source_key >= 1),
     ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
     mode TEXT NOT NULL CHECK (
       typeof(mode) = 'text' AND mode IN ('40000','040000','100644','100755','120000','160000')
     ),
     name_bytes BLOB NOT NULL CHECK (
       typeof(name_bytes) = 'blob' AND length(name_bytes) >= 1
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     raw_entry BLOB NOT NULL CHECK (typeof(raw_entry) = 'blob'),
     cumulative_base INTEGER NOT NULL CHECK (
       typeof(cumulative_base) = 'integer' AND cumulative_base >= 0
     ),
     PRIMARY KEY (source_key, ordinal),
     FOREIGN KEY (source_key)
       REFERENCES git_tree_sources (source_key)
       ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_tree_entries_by_name_bytes
     ON git_tree_entries (source_key, name_bytes)`,

  `CREATE VIEW IF NOT EXISTS git_tree_entries_wide AS
     SELECT s.repo_id, s.tree_oid, s.storage, s.source_id,
            e.source_key, e.ordinal, e.mode,
            CAST(e.name_bytes AS TEXT) AS name, e.name_bytes, e.oid,
            e.raw_entry, e.cumulative_base
       FROM git_tree_entries e
       JOIN git_tree_sources s ON s.source_key = e.source_key`,

  // The source selected for traversal. A loose object always shadows its
  // packed copy, including while its parsed marker is missing or corrupt.
  `CREATE TABLE IF NOT EXISTS git_tree_effective (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     tree_oid TEXT NOT NULL CHECK (
       typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40
     ),
     source_key INTEGER NOT NULL CHECK (typeof(source_key) = 'integer' AND source_key >= 1),
     PRIMARY KEY (repo_id, tree_oid),
     FOREIGN KEY (source_key, repo_id, tree_oid)
       REFERENCES git_tree_sources (source_key, repo_id, tree_oid)
       ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_insert
   AFTER INSERT ON git_objects WHEN NEW.type = 'tree'
   BEGIN
     INSERT INTO git_tree_sources
       (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
     VALUES (NEW.repo_id, NEW.oid, 'loose', 0, 0, NEW.size, NULL, NULL)
     ON CONFLICT(repo_id, tree_oid, storage, source_id) DO UPDATE SET
       complete = 0, object_size = excluded.object_size,
       entry_count = NULL, base_cost = NULL;
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, source_key)
     SELECT NEW.repo_id, NEW.oid, source_key FROM git_tree_sources
      WHERE repo_id = NEW.repo_id AND tree_oid = NEW.oid
        AND storage = 'loose' AND source_id = 0;
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_delete
   AFTER DELETE ON git_objects WHEN OLD.type = 'tree'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid;
     DELETE FROM git_tree_sources
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND storage = 'loose' AND source_id = 0;
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, source_key)
     SELECT o.repo_id, o.oid, s.source_key
       FROM git_pack_objects o
       JOIN git_pack_meta m
         ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id AND m.state = 'complete'
       JOIN git_tree_sources s
         ON s.repo_id = o.repo_id AND s.tree_oid = o.oid
        AND s.storage = 'pack' AND s.source_id = o.pack_id
      WHERE o.repo_id = OLD.repo_id AND o.oid = OLD.oid AND o.type = 'tree';
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_complete
   AFTER UPDATE OF state ON git_pack_meta
   WHEN NEW.state = 'complete' AND OLD.state != 'complete'
   BEGIN
     INSERT INTO git_tree_sources
       (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
     SELECT o.repo_id, o.oid, 'pack', o.pack_id, 0, o.size, NULL, NULL
       FROM git_pack_objects o
      WHERE o.repo_id = NEW.repo_id AND o.pack_id = NEW.pack_id AND o.type = 'tree'
     ON CONFLICT(repo_id, tree_oid, storage, source_id) DO UPDATE SET
       object_size = excluded.object_size;
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, source_key)
     SELECT o.repo_id, o.oid, s.source_key
       FROM git_pack_objects o
       JOIN git_tree_sources s
         ON s.repo_id = o.repo_id AND s.tree_oid = o.oid
        AND s.storage = 'pack' AND s.source_id = o.pack_id
      WHERE o.repo_id = NEW.repo_id AND o.pack_id = NEW.pack_id AND o.type = 'tree'
        AND NOT EXISTS (
          SELECT 1 FROM git_objects lo
           WHERE lo.repo_id = o.repo_id AND lo.oid = o.oid AND lo.type = 'tree'
        );
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_delete
   AFTER DELETE ON git_pack_meta WHEN OLD.state = 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE source_key IN (
        SELECT source_key FROM git_tree_sources
         WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id
      );
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_hide
   AFTER UPDATE OF state ON git_pack_meta
   WHEN OLD.state = 'complete' AND NEW.state != 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE source_key IN (
        SELECT source_key FROM git_tree_sources
         WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id
      );
   END`,
] as const;
