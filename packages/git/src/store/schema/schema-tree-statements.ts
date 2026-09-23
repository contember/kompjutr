export const TREE_SCHEMA_STATEMENTS = [
  // One parsed projection per tree OID: the entries depend only on the tree
  // bytes, so every loose or packed copy of the OID shares it.
  `CREATE TABLE IF NOT EXISTS git_tree_sources (
     source_key INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     tree_oid TEXT NOT NULL CHECK (
       typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40
     ),
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
     UNIQUE (repo_id, tree_oid),
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

  // An upsert, not OR IGNORE: an outer INSERT OR REPLACE on git_objects would
  // turn OR IGNORE into REPLACE and rebuild an existing projection.
  `CREATE TRIGGER IF NOT EXISTS git_tree_sources_loose_insert
   AFTER INSERT ON git_objects WHEN NEW.type = 'tree'
   BEGIN
     INSERT INTO git_tree_sources
       (repo_id, tree_oid, complete, object_size, entry_count, base_cost)
     VALUES (NEW.repo_id, NEW.oid, 0, NEW.size, NULL, NULL)
     ON CONFLICT(repo_id, tree_oid) DO NOTHING;
   END`,

  // Maintenance deletes loose rows directly; PackDeletion drops the
  // projections of a deleted pack. Any physical pack entry keeps the tree.
  `CREATE TRIGGER IF NOT EXISTS git_tree_sources_loose_delete
   AFTER DELETE ON git_objects WHEN OLD.type = 'tree'
   BEGIN
     DELETE FROM git_tree_sources
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_entries packed
           WHERE packed.repo_id = OLD.repo_id AND packed.oid = OLD.oid
        );
   END`,
] as const;
