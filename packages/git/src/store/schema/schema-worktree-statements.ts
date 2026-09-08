import { BLOB_ID_GENERATION_EXHAUSTED, MAX_BLOB_ID_CACHE_ROWS } from "../objects/blob-id-cache.js";
import { OPERATION_SCHEMA_STATEMENTS } from "./operation-schema.js";
import { MAX_INDEX_PATH_BYTES, MAX_SCRATCH_INDEX_NAME_BYTES } from "./schema-constants.js";

export const WORKTREE_SCHEMA_STATEMENTS = [
  // Git's logical index, not the .git/index binary format. The trailing
  // columns cache what the working tree looked like when the entry was
  // written, so an unchanged file does not have to be re-hashed.
  `CREATE TABLE IF NOT EXISTS git_index (
     checkout_id INTEGER NOT NULL,
     path TEXT NOT NULL CHECK (
       typeof(path) = 'text'
       AND length(CAST(path AS BLOB)) BETWEEN 1 AND ${MAX_INDEX_PATH_BYTES}
     ),
     stage INTEGER NOT NULL CHECK (typeof(stage) = 'integer' AND stage BETWEEN 0 AND 3),
     mode INTEGER NOT NULL CHECK (
       typeof(mode) = 'integer' AND mode IN (33188, 33261, 40960, 57344)
     ),
     oid TEXT NOT NULL CHECK (
       typeof(oid) = 'text'
       AND length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     size INTEGER CHECK (size IS NULL OR (typeof(size) = 'integer' AND size >= 0)),
     mtime INTEGER CHECK (mtime IS NULL OR (typeof(mtime) = 'integer' AND mtime >= 0)),
     ino INTEGER CHECK (ino IS NULL OR (typeof(ino) = 'integer' AND ino >= 0)),
     rev INTEGER CHECK (rev IS NULL OR (typeof(rev) = 'integer' AND rev >= 0)),
     PRIMARY KEY (checkout_id, path, stage),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_scratch_indexes (
     repo_id INTEGER NOT NULL CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     name TEXT NOT NULL CHECK (
       typeof(name) = 'text'
       AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${MAX_SCRATCH_INDEX_NAME_BYTES}
       AND instr(name, char(0)) = 0
     ),
     PRIMARY KEY (repo_id, name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_scratch_index_entries (
     repo_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     path TEXT NOT NULL CHECK (
       typeof(path) = 'text'
       AND length(CAST(path AS BLOB)) BETWEEN 1 AND ${MAX_INDEX_PATH_BYTES}
     ),
     stage INTEGER NOT NULL CHECK (typeof(stage) = 'integer' AND stage BETWEEN 0 AND 3),
     mode INTEGER NOT NULL CHECK (
       typeof(mode) = 'integer' AND mode IN (33188, 33261, 40960, 57344)
     ),
     oid TEXT NOT NULL CHECK (
       typeof(oid) = 'text'
       AND length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     size INTEGER CHECK (size IS NULL OR (typeof(size) = 'integer' AND size >= 0)),
     mtime INTEGER CHECK (mtime IS NULL OR (typeof(mtime) = 'integer' AND mtime >= 0)),
     ino INTEGER CHECK (ino IS NULL OR (typeof(ino) = 'integer' AND ino >= 0)),
     rev INTEGER CHECK (rev IS NULL OR (typeof(rev) = 'integer' AND rev >= 0)),
     PRIMARY KEY (repo_id, name, path, stage),
     FOREIGN KEY (repo_id, name) REFERENCES git_scratch_indexes (repo_id, name)
       ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_index_state (
     checkout_id INTEGER PRIMARY KEY,
     baseline_tree_oid TEXT,
     format INTEGER NOT NULL CHECK (format = 1),
     complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_index_dirty (
     checkout_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     flags INTEGER NOT NULL CHECK (typeof(flags) = 'integer' AND flags IN (1, 2, 3)),
     PRIMARY KEY (checkout_id, path),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  // One durable incomplete operation header; ordered replay state lives in
  // `git_operation_steps` and touched rows belong only to a suspended step.
  ...OPERATION_SCHEMA_STATEMENTS,

  // The working tree's opaque content ids mapped to blob oids. A file whose
  // `fs_nodes.content_id` is in here is unchanged: `status` and `add` answer
  // it from the scan statement, without reading the file or hashing it.
  //
  // The id is whatever the filesystem chose to record. Nothing here computes
  // one, and a missing row means "read the file", never "the file differs".
  `CREATE TABLE IF NOT EXISTS git_blob_ids (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     content_id BLOB NOT NULL CHECK (typeof(content_id) = 'blob'),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
     PRIMARY KEY (repo_id, content_id),
     FOREIGN KEY (repo_id) REFERENCES git_blob_id_state (repo_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_blob_id_state (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE INDEX IF NOT EXISTS git_blob_ids_by_generation
     ON git_blob_ids (repo_id, generation)`,

  `CREATE VIEW IF NOT EXISTS git_blob_id_updates
     (repo_id, content_id, oid, operation, ordinal) AS
   SELECT repo_id, content_id, oid, 'mapping', 0 FROM git_blob_ids WHERE false`,

  `CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_begin
   INSTEAD OF INSERT ON git_blob_id_updates WHEN NEW.operation = 'begin'
   BEGIN
     SELECT CASE WHEN typeof(NEW.repo_id) != 'integer' OR NEW.repo_id < 1
       THEN RAISE(ABORT, 'invalid blob id cache begin repo') END;
     SELECT CASE WHEN typeof(NEW.content_id) != 'blob' OR length(NEW.content_id) != 0
       THEN RAISE(ABORT, 'invalid blob id cache begin content') END;
     SELECT CASE WHEN typeof(NEW.oid) != 'text' OR NEW.oid != ''
       THEN RAISE(ABORT, 'invalid blob id cache begin oid') END;
     SELECT CASE WHEN typeof(NEW.ordinal) != 'integer' OR NEW.ordinal != -1
       THEN RAISE(ABORT, 'invalid blob id cache begin ordinal') END;
     INSERT INTO git_blob_id_state (repo_id, generation) VALUES (NEW.repo_id, 1)
     ON CONFLICT(repo_id) DO UPDATE SET generation = generation + 1
       WHERE generation < ${Number.MAX_SAFE_INTEGER};
     SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, '${BLOB_ID_GENERATION_EXHAUSTED}') END;
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_mapping
   INSTEAD OF INSERT ON git_blob_id_updates WHEN NEW.operation = 'mapping'
   BEGIN
     SELECT CASE WHEN typeof(NEW.ordinal) != 'integer' OR NEW.ordinal < 0
       THEN RAISE(ABORT, 'invalid blob id cache mapping') END;
     SELECT CASE WHEN NOT EXISTS (
       SELECT 1 FROM git_blob_id_state WHERE repo_id = NEW.repo_id
     ) THEN RAISE(ABORT, 'blob id cache generation is missing') END;
     INSERT INTO git_blob_ids (repo_id, content_id, oid, generation)
     SELECT NEW.repo_id, NEW.content_id, NEW.oid, generation
       FROM git_blob_id_state WHERE repo_id = NEW.repo_id
     ON CONFLICT(repo_id, content_id) DO UPDATE SET
       oid = excluded.oid, generation = excluded.generation;
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_finish
   INSTEAD OF INSERT ON git_blob_id_updates WHEN NEW.operation = 'finish'
   BEGIN
     SELECT CASE WHEN typeof(NEW.repo_id) != 'integer' OR NEW.repo_id < 1
       OR typeof(NEW.content_id) != 'blob' OR length(NEW.content_id) != 0
       OR typeof(NEW.oid) != 'text' OR NEW.oid != ''
       OR typeof(NEW.ordinal) != 'integer' OR NEW.ordinal < 0
       THEN RAISE(ABORT, 'invalid blob id cache finish') END;
     DELETE FROM git_blob_ids
      WHERE repo_id = NEW.repo_id AND generation IN (
        SELECT generation FROM (
          SELECT generation,
                 sum(count(*)) OVER (ORDER BY generation DESC) AS retained_rows
            FROM git_blob_ids INDEXED BY git_blob_ids_by_generation
           WHERE repo_id = NEW.repo_id
           GROUP BY generation
        ) WHERE retained_rows > ${MAX_BLOB_ID_CACHE_ROWS}
      );
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_invalid
   INSTEAD OF INSERT ON git_blob_id_updates
   WHEN NEW.operation IS NULL OR NEW.operation NOT IN ('begin', 'mapping', 'finish')
   BEGIN
     SELECT RAISE(ABORT, 'invalid blob id cache operation');
   END`,

  // Shallow boundary commits, the equivalent of .git/shallow. A history
  // walk stops dead at one of these.
  `CREATE TABLE IF NOT EXISTS git_shallow (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL CHECK (
       typeof(oid) = 'text'
       AND length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,
] as const;
