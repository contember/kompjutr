// The whole Git store and its checkouts live in these tables. Shared rows use
// `repo_id`; worktree-private rows use `checkout_id`.

import { CorruptError, GitError } from "../core/errors.js";
import {
  BLOB_ID_GENERATION_EXHAUSTED,
  MAX_BLOB_ID_CACHE_ROWS,
  MAX_CACHED_CONTENT_ID_BYTES,
} from "./blob-id-cache.js";
import type { SqlDatabase } from "./db.js";
import { OPERATION_STATE_TABLE } from "./operation-schema.js";
import { REFLOG_SCHEMA_STATEMENTS } from "./reflog-schema.js";

export {
  createTreeIndexSink,
  indexTreeSource,
  indexTreeSources,
  TREE_QUEUE_ROW_FIXED_BYTES,
  TreeIndexSink,
  type TreeSource,
  type TreeSourceInput,
  type TreeStorage,
} from "./tree-index.js";

export const SCHEMA_VERSION = 1;
export const MAX_CHECKOUTS_PER_REPOSITORY = 1_024;
export const MAX_CHECKOUT_ROOT_BYTES = 4_096;
export { MAX_BLOB_ID_CACHE_ROWS } from "./blob-id-cache.js";

const COMMIT_TABLE = `CREATE TABLE IF NOT EXISTS git_commits (
  repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
  oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
  parents TEXT NOT NULL CHECK (
    typeof(parents) = 'text' AND json_valid(parents) AND json_type(parents) = 'array'
  ),
  tree TEXT NOT NULL CHECK (typeof(tree) = 'text' AND length(CAST(tree AS BLOB)) = 40),
  author_name BLOB NOT NULL CHECK (typeof(author_name) = 'blob'),
  author_email BLOB NOT NULL CHECK (typeof(author_email) = 'blob'),
  author_time INTEGER NOT NULL CHECK (typeof(author_time) = 'integer'),
  author_timezone INTEGER NOT NULL CHECK (typeof(author_timezone) = 'integer'),
  committer_name BLOB NOT NULL CHECK (typeof(committer_name) = 'blob'),
  committer_email BLOB NOT NULL CHECK (typeof(committer_email) = 'blob'),
  committer_time INTEGER NOT NULL CHECK (typeof(committer_time) = 'integer'),
  committer_timezone INTEGER NOT NULL CHECK (typeof(committer_timezone) = 'integer'),
  message BLOB NOT NULL CHECK (typeof(message) = 'blob'),
  gpgsig BLOB CHECK (gpgsig IS NULL OR typeof(gpgsig) = 'blob'),
  object_size INTEGER NOT NULL CHECK (typeof(object_size) = 'integer' AND object_size >= 0),
  cache_bytes INTEGER NOT NULL CHECK (typeof(cache_bytes) = 'integer' AND cache_bytes >= 0),
  PRIMARY KEY (repo_id, oid),
  FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
) WITHOUT ROWID`;

const OPERATION_STEPS_TABLE = `CREATE TABLE IF NOT EXISTS git_operation_steps (
  checkout_id INTEGER NOT NULL CHECK (
    typeof(checkout_id) = 'integer' AND checkout_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  ),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  source_oid TEXT NOT NULL,
  selected_parent_oid TEXT,
  mainline INTEGER CHECK (mainline IS NULL OR (typeof(mainline) = 'integer' AND mainline >= 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'skipped')),
  result_oid TEXT,
  PRIMARY KEY (checkout_id, ordinal),
  CHECK ((outcome = 'applied' AND result_oid IS NOT NULL)
      OR (outcome IN ('pending', 'skipped') AND result_oid IS NULL)),
  CHECK (mainline IS NULL OR selected_parent_oid IS NOT NULL),
  FOREIGN KEY (checkout_id) REFERENCES git_operation_state (checkout_id) ON DELETE CASCADE
) WITHOUT ROWID`;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // Shared store identity. Working-tree routing belongs to git_checkouts.
  `CREATE TABLE IF NOT EXISTS git_repositories (
     id INTEGER PRIMARY KEY CHECK (
       typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     )
   )`,

  `CREATE TABLE IF NOT EXISTS git_checkouts (
     id INTEGER PRIMARY KEY CHECK (
       typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     repo_id INTEGER NOT NULL CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     root TEXT NOT NULL UNIQUE CHECK (
       typeof(root) = 'text'
       AND length(CAST(root AS BLOB)) BETWEEN 1 AND ${MAX_CHECKOUT_ROOT_BYTES}
       AND substr(root, 1, 1) = '/'
       AND (root = '/' OR substr(root, -1) != '/')
       AND instr(root, char(0)) = 0
       AND instr(root, '//') = 0
       AND root NOT IN ('/.', '/..')
       AND instr(root, '/./') = 0
       AND instr(root, '/../') = 0
       AND substr(root, -2) != '/.'
       AND substr(root, -3) != '/..'
     ),
     head TEXT NOT NULL CHECK (
       typeof(head) = 'text'
       AND length(CAST(head AS BLOB)) BETWEEN 1 AND 1024
       AND instr(head, char(0)) = 0
       AND instr(head, char(10)) = 0
       AND instr(head, char(13)) = 0
       AND (
         (length(CAST(head AS BLOB)) = 40 AND head NOT GLOB '*[^0-9a-f]*')
         OR (
           substr(head, 1, 5) = 'ref: '
           AND length(CAST(head AS BLOB)) > 5
           AND substr(head, 6) != 'HEAD'
           AND substr(head, 6, 5) != 'ref: '
         )
       )
     ),
     is_primary INTEGER NOT NULL CHECK (
       typeof(is_primary) = 'integer' AND is_primary IN (0, 1)
     ),
     UNIQUE (id, repo_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS git_checkouts_primary
     ON git_checkouts (repo_id) WHERE is_primary = 1`,

  `CREATE UNIQUE INDEX IF NOT EXISTS git_checkouts_attached_branch
     ON git_checkouts (repo_id, head)
     WHERE substr(head, 1, 16) = 'ref: refs/heads/'
       AND length(CAST(head AS BLOB)) > 16`,

  `CREATE TRIGGER IF NOT EXISTS git_checkouts_identity_immutable
     BEFORE UPDATE OF id, repo_id, root, is_primary ON git_checkouts
     BEGIN
       SELECT RAISE(ABORT, 'checkout identity is immutable');
     END`,

  `CREATE TABLE IF NOT EXISTS git_refs (
     repo_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     target TEXT NOT NULL,
     PRIMARY KEY (repo_id, name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  ...REFLOG_SCHEMA_STATEMENTS,

  // Dotted config path ("user.email", "remote.origin.url"). `seq` keeps
  // multi-valued keys ordered the way a config file would.
  `CREATE TABLE IF NOT EXISTS git_config (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     seq INTEGER NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (repo_id, path, seq),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  // Git's logical index, not the .git/index binary format. The trailing
  // columns cache what the working tree looked like when the entry was
  // written, so an unchanged file does not have to be re-hashed.
  `CREATE TABLE IF NOT EXISTS git_index (
     checkout_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     stage INTEGER NOT NULL,
     mode INTEGER NOT NULL,
     oid TEXT NOT NULL,
     size INTEGER,
     mtime INTEGER,
     ino INTEGER,
     rev INTEGER,
     PRIMARY KEY (checkout_id, path, stage),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   )`,

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
  OPERATION_STATE_TABLE,

  OPERATION_STEPS_TABLE,

  // Original identities for only paths owned by the operation. Physical paths
  // include conflict relocations; logical_path ties them back to the index path.
  `CREATE TABLE IF NOT EXISTS git_operation_touched (
     checkout_id INTEGER NOT NULL,
     ordinal INTEGER NOT NULL,
     path TEXT NOT NULL,
     logical_path TEXT NOT NULL,
     purpose TEXT NOT NULL CHECK (
       purpose IN ('primary', 'current-relocation', 'incoming-relocation')
     ),
     index_stage INTEGER,
     index_mode INTEGER,
     index_oid TEXT,
     index_size INTEGER,
     index_mtime INTEGER,
     index_ino INTEGER,
     index_rev INTEGER,
     worktree_kind TEXT NOT NULL CHECK (
       worktree_kind IN ('absent', 'file', 'symlink', 'directory')
     ),
     worktree_mode INTEGER,
     worktree_oid TEXT,
     worktree_revision INTEGER,
     PRIMARY KEY (checkout_id, ordinal),
     UNIQUE (checkout_id, path),
     CHECK (
       (index_stage IS NULL AND index_mode IS NULL AND index_oid IS NULL
          AND index_size IS NULL AND index_mtime IS NULL AND index_ino IS NULL
          AND index_rev IS NULL)
       OR (index_stage = 0 AND index_mode IS NOT NULL AND index_oid IS NOT NULL)
     ),
     CHECK (
       (worktree_kind = 'absent' AND worktree_mode IS NULL
          AND worktree_oid IS NULL AND worktree_revision IS NULL)
       OR (worktree_kind IN ('file', 'symlink') AND worktree_mode IS NOT NULL
          AND worktree_oid IS NOT NULL AND worktree_revision IS NOT NULL)
       OR (worktree_kind = 'directory' AND worktree_mode IS NOT NULL
          AND worktree_oid IS NULL AND worktree_revision IS NOT NULL)
     ),
     FOREIGN KEY (checkout_id) REFERENCES git_operation_state (checkout_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  // The working tree's opaque content ids mapped to blob oids. A file whose
  // `fs_nodes.content_id` is in here is unchanged: `status` and `add` answer
  // it from the scan statement, without reading the file or hashing it.
  //
  // The id is whatever the filesystem chose to record. Nothing here computes
  // one, and a missing row means "read the file", never "the file differs".
  `CREATE TABLE IF NOT EXISTS git_blob_ids (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     content_id BLOB NOT NULL CHECK (
       typeof(content_id) = 'blob' AND length(content_id) <= ${MAX_CACHED_CONTENT_ID_BYTES}
     ),
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
     oid TEXT NOT NULL,
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  // Loose objects: everything created locally, zlib-deflated and chunked.
  // A future repack folds them into a pack; nothing here depends on that.
  // `stored` names the encoding of the chunk bytes: 'zlib' or 'raw'.
  // Deflating an already-incompressible or tiny object costs more than it
  // saves, and the threshold is a client option.
  `CREATE TABLE IF NOT EXISTS git_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
     stored TEXT NOT NULL DEFAULT 'zlib'
       CHECK (typeof(stored) = 'text' AND stored IN ('zlib','raw')),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  // Full parsed commits for graph walks and reads. This remains a derived
  // cache: source metadata is validated before a row can be returned.
  COMMIT_TABLE,

  `CREATE TABLE IF NOT EXISTS git_object_chunks (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   )`,

  // Received packs are kept verbatim, still compressed. `state` is
  // 'pending' until the trailer has been verified and every entry
  // indexed; an interrupted fetch leaves a pending pack that the next
  // ingest reclaims.
  `CREATE TABLE IF NOT EXISTS git_pack_meta (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (typeof(pack_id) = 'integer' AND pack_id >= 0),
     size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
     count INTEGER NOT NULL CHECK (typeof(count) = 'integer' AND count >= 0),
     state TEXT NOT NULL CHECK (typeof(state) = 'text' AND state IN ('pending','complete')),
     created INTEGER NOT NULL CHECK (typeof(created) = 'integer' AND created >= 0),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  // Ordinary pack ingestion is async. This durable generation lease prevents
  // another store facade from reclaiming or reusing its pending identity.
  `CREATE TABLE IF NOT EXISTS git_pack_ingest_control (
     repo_id INTEGER PRIMARY KEY CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     owner_generation INTEGER NOT NULL CHECK (
       typeof(owner_generation) = 'integer'
       AND owner_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     last_pack_id INTEGER NOT NULL CHECK (
       typeof(last_pack_id) = 'integer' AND last_pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     active_pack_id INTEGER CHECK (
       active_pack_id IS NULL OR (
         typeof(active_pack_id) = 'integer'
         AND active_pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
         AND active_pack_id <= last_pack_id
       )
     ),
     expires_ms INTEGER CHECK (
       expires_ms IS NULL OR (
         typeof(expires_ms) = 'integer' AND expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     CHECK ((active_pack_id IS NULL) = (expires_ms IS NULL)),
     CHECK (active_pack_id IS NULL OR owner_generation >= 1),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id, active_pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_data (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_pack_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     pack_id INTEGER NOT NULL CHECK (typeof(pack_id) = 'integer' AND pack_id >= 0),
     offset INTEGER NOT NULL CHECK (typeof(offset) = 'integer' AND offset >= 0),
     data_off INTEGER NOT NULL CHECK (typeof(data_off) = 'integer' AND data_off >= 0),
     data_len INTEGER NOT NULL CHECK (typeof(data_len) = 'integer' AND data_len >= 0),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
     entry_size INTEGER NOT NULL CHECK (typeof(entry_size) = 'integer' AND entry_size >= 0),
     base_oid TEXT CHECK (
       base_oid IS NULL OR (typeof(base_oid) = 'text' AND length(CAST(base_oid AS BLOB)) = 40)
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   )`,

  `CREATE INDEX IF NOT EXISTS git_pack_objects_loc
     ON git_pack_objects (repo_id, pack_id, offset)`,

  // Every pack keeps its own authenticated index while git_pack_objects
  // remains the canonical read owner for each OID.
  `CREATE TABLE IF NOT EXISTS git_pack_entries (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (typeof(pack_id) = 'integer' AND pack_id >= 0),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     offset INTEGER NOT NULL CHECK (typeof(offset) = 'integer' AND offset >= 0),
     data_off INTEGER NOT NULL CHECK (typeof(data_off) = 'integer' AND data_off >= 0),
     data_len INTEGER NOT NULL CHECK (typeof(data_len) = 'integer' AND data_len >= 0),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
     entry_size INTEGER NOT NULL CHECK (typeof(entry_size) = 'integer' AND entry_size >= 0),
     base_oid TEXT CHECK (
       base_oid IS NULL OR (typeof(base_oid) = 'text' AND length(CAST(base_oid AS BLOB)) = 40)
     ),
     PRIMARY KEY (repo_id, pack_id, offset),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_pack_entries_by_oid
     ON git_pack_entries (repo_id, oid, pack_id, offset)`,

  // Delta entries whose base had not been seen yet when the pack was
  // scanned. Drained before the pack is marked complete.
  `CREATE TABLE IF NOT EXISTS git_pack_pending (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     offset INTEGER NOT NULL,
     data_off INTEGER NOT NULL,
     data_len INTEGER NOT NULL,
     entry_size INTEGER NOT NULL,
     base_oid TEXT,
     base_offset INTEGER,
     PRIMARY KEY (repo_id, pack_id, offset),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   )`,

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
       typeof(name_bytes) = 'blob' AND length(name_bytes) BETWEEN 1 AND 2200
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
     ON git_tree_entries (source_key, name_bytes)
     WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200`,

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
  `CREATE TABLE IF NOT EXISTS git_loose_object_lifecycle (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     created_ms INTEGER NOT NULL CHECK (
       typeof(created_ms) = 'integer' AND created_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_control (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     root_epoch INTEGER NOT NULL CHECK (
       typeof(root_epoch) = 'integer' AND root_epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     next_run_id INTEGER NOT NULL CHECK (
       typeof(next_run_id) = 'integer' AND next_run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_runs (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     observed_root_epoch INTEGER NOT NULL CHECK (
       typeof(observed_root_epoch) = 'integer'
       AND observed_root_epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     phase TEXT NOT NULL CHECK (typeof(phase) = 'text' AND phase IN (
       'roots', 'mark', 'classify-loose', 'repack',
       'classify-packs', 'sweep-loose', 'sweep-packs', 'finish'
     )),
     started_ms INTEGER NOT NULL CHECK (
       typeof(started_ms) = 'integer' AND started_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     root_source TEXT NOT NULL CHECK (typeof(root_source) = 'text' AND root_source IN (
       'refs', 'heads', 'reflogs', 'index', 'index-baseline', 'shallow', 'operations', 'done'
     )),
     cursor_checkout_id INTEGER CHECK (
       cursor_checkout_id IS NULL OR (
         typeof(cursor_checkout_id) = 'integer'
         AND cursor_checkout_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     cursor_text TEXT CHECK (
       cursor_text IS NULL OR (
         typeof(cursor_text) = 'text'
         AND length(CAST(cursor_text AS BLOB)) BETWEEN 0 AND ${MAX_CHECKOUT_ROOT_BYTES}
         AND instr(cursor_text, char(0)) = 0
       )
     ),
     cursor_ordinal INTEGER CHECK (
       cursor_ordinal IS NULL OR (
         typeof(cursor_ordinal) = 'integer'
         AND cursor_ordinal BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     reachable_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reachable_objects) = 'integer'
       AND reachable_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     queued_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(queued_objects) = 'integer'
       AND queued_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     repacked_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(repacked_objects) = 'integer'
       AND repacked_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reclaimed_objects) = 'integer'
       AND reclaimed_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_packs INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reclaimed_packs) = 'integer'
       AND reclaimed_packs BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reclaimed_bytes) = 'integer'
       AND reclaimed_bytes BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     next_eligible_ms INTEGER CHECK (
       next_eligible_ms IS NULL OR (
         typeof(next_eligible_ms) = 'integer'
         AND next_eligible_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     restarted INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(restarted) = 'integer' AND restarted IN (0, 1)
     ),
     UNIQUE (repo_id, run_id),
     FOREIGN KEY (repo_id) REFERENCES git_maintenance_control (repo_id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     source_mask INTEGER NOT NULL CHECK (
       typeof(source_mask) = 'integer' AND source_mask BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     expanded INTEGER NOT NULL CHECK (typeof(expanded) = 'integer' AND expanded IN (0, 1)),
     shallow_boundary INTEGER NOT NULL CHECK (
       typeof(shallow_boundary) = 'integer' AND shallow_boundary IN (0, 1)
     ),
     physical_only INTEGER NOT NULL CHECK (
       typeof(physical_only) = 'integer' AND physical_only IN (0, 1)
     ),
     edge_cursor INTEGER NOT NULL CHECK (
       typeof(edge_cursor) = 'integer' AND edge_cursor BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_maintenance_objects_queue
     ON git_maintenance_objects (repo_id, run_id, expanded, physical_only, oid)`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_shallow (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_repack_batches (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     batch_id INTEGER NOT NULL CHECK (
       typeof(batch_id) = 'integer' AND batch_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     state TEXT NOT NULL CHECK (
       typeof(state) = 'text' AND state IN ('selected', 'pending', 'published')
     ),
     pack_id INTEGER CHECK (
       pack_id IS NULL OR (
         typeof(pack_id) = 'integer' AND pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     object_count INTEGER NOT NULL CHECK (
       typeof(object_count) = 'integer' AND object_count BETWEEN 0 AND 2048
     ),
     inflated_bytes INTEGER NOT NULL CHECK (
       typeof(inflated_bytes) = 'integer'
       AND inflated_bytes BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       AND (inflated_bytes <= 33554432 OR object_count = 1)
     ),
     stored_bytes INTEGER NOT NULL CHECK (
       typeof(stored_bytes) = 'integer' AND stored_bytes BETWEEN 0 AND 67108864
     ),
     PRIMARY KEY (repo_id, run_id, batch_id),
     UNIQUE (repo_id, run_id),
     CHECK (
       (state = 'selected' AND pack_id IS NULL)
       OR (state IN ('pending', 'published') AND pack_id IS NOT NULL)
     ),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_repack_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     batch_id INTEGER NOT NULL CHECK (
       typeof(batch_id) = 'integer' AND batch_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 2047),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, run_id, oid),
     UNIQUE (repo_id, run_id, batch_id, ordinal),
     FOREIGN KEY (repo_id, run_id, batch_id)
       REFERENCES git_maintenance_repack_batches (repo_id, run_id, batch_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_loose_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       typeof(unreachable_since_ms) = 'integer'
       AND unreachable_since_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (
       typeof(pack_id) = 'integer' AND pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       typeof(unreachable_since_ms) = 'integer'
       AND unreachable_since_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,
] as const;

interface ExpectedSchemaObject {
  type: string;
  sql: string;
}

function expectedSchemaObject(statement: string): [string, ExpectedSchemaObject] {
  const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX|VIEW|TRIGGER) IF NOT EXISTS ([a-z_]+)/.exec(
    statement,
  );
  const type = match?.[1]?.toLowerCase();
  const name = match?.[2];
  if (type === undefined || name === undefined) {
    throw new Error("git schema contains an unrecognized definition");
  }
  return [name, { type, sql: statement.replace(" IF NOT EXISTS", "") }];
}

const EXPECTED_SCHEMA_OBJECTS = new Map(STATEMENTS.map(expectedSchemaObject));
if (EXPECTED_SCHEMA_OBJECTS.size !== STATEMENTS.length) {
  throw new Error("git schema contains duplicate definitions");
}

const schemaTextEncoder = new TextEncoder();
let maxSchemaObjectNameBytes = 0;
let maxSchemaObjectDefinitionBytes = 0;
for (const [name, definition] of EXPECTED_SCHEMA_OBJECTS) {
  maxSchemaObjectNameBytes = Math.max(
    maxSchemaObjectNameBytes,
    schemaTextEncoder.encode(name).length,
  );
  maxSchemaObjectDefinitionBytes = Math.max(
    maxSchemaObjectDefinitionBytes,
    schemaTextEncoder.encode(definition.sql).length,
  );
}
const MAX_SCHEMA_OBJECT_ROWS = EXPECTED_SCHEMA_OBJECTS.size + 1;
const MAX_SCHEMA_OBJECT_RETAINED_BYTES = 100 * 1024 * 1024;
const MAX_SCHEMA_VERSION_BYTES = String(Number.MAX_SAFE_INTEGER).length;
const SCHEMA_OBJECT_FIXED_BYTES = 1024 * 1024;
const maxSchemaObjectRetainedBytes =
  MAX_SCHEMA_OBJECT_ROWS *
  (SCHEMA_OBJECT_FIXED_BYTES + 2 * (maxSchemaObjectNameBytes + maxSchemaObjectDefinitionBytes + 7));
if (maxSchemaObjectRetainedBytes >= MAX_SCHEMA_OBJECT_RETAINED_BYTES) {
  throw new Error("git schema definitions exceed their retained-memory bound");
}

const MAX_SCHEMA_INITIALIZATION_STATEMENTS = 999;

class SchemaDatabase implements SqlDatabase {
  #statements = 0;

  constructor(private readonly inner: SqlDatabase) {}

  #count(): void {
    this.#statements++;
    if (this.#statements > MAX_SCHEMA_INITIALIZATION_STATEMENTS) {
      throw new GitError("E2BIG", "git schema initialization exceeds the 1,000-statement limit");
    }
  }

  run(query: string, ...bindings: unknown[]): void {
    this.#count();
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#count();
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#count();
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#count();
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.#count();
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function readSchemaObjects(db: SqlDatabase): Map<string, ExpectedSchemaObject> {
  const objects = new Map<string, ExpectedSchemaObject>();
  let retainedBytes = 0;
  for (const row of db.iterate(
    `SELECT
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
            THEN name END AS name,
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
            THEN length(CAST(name AS BLOB)) END AS name_bytes,
       CASE WHEN typeof(type) = 'text' AND length(CAST(type AS BLOB)) BETWEEN 4 AND 7
            THEN type END AS type,
       CASE WHEN typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN sql END AS sql,
       CASE WHEN typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN length(CAST(sql AS BLOB)) END AS sql_bytes,
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
                  AND typeof(type) = 'text' AND length(CAST(type AS BLOB)) BETWEEN 4 AND 7
                  AND typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN 0 ELSE 1 END AS invalid
     FROM sqlite_schema
     WHERE substr(name, 1, 4) COLLATE NOCASE = 'git_'
     LIMIT ${MAX_SCHEMA_OBJECT_ROWS}`,
  )) {
    if (row.invalid !== 0 && row.invalid !== 1) {
      throw new CorruptError("git schema object bound sentinel is invalid");
    }
    if (row.invalid === 1) {
      throw new CorruptError("git schema object exceeds its read bound");
    }
    if (
      typeof row.name !== "string" ||
      typeof row.name_bytes !== "number" ||
      !Number.isSafeInteger(row.name_bytes) ||
      row.name_bytes < 1 ||
      row.name_bytes > maxSchemaObjectNameBytes ||
      typeof row.type !== "string" ||
      typeof row.sql !== "string" ||
      typeof row.sql_bytes !== "number" ||
      !Number.isSafeInteger(row.sql_bytes) ||
      row.sql_bytes < 1 ||
      row.sql_bytes > maxSchemaObjectDefinitionBytes ||
      !["table", "index", "view", "trigger"].includes(row.type)
    ) {
      throw new CorruptError("git schema object probe is invalid");
    }
    const rowRetainedBytes = SCHEMA_OBJECT_FIXED_BYTES + 2 * (row.name_bytes + row.sql_bytes + 7);
    if (rowRetainedBytes >= MAX_SCHEMA_OBJECT_RETAINED_BYTES - retainedBytes) {
      throw new CorruptError("git schema objects exceed their aggregate read bound");
    }
    retainedBytes += rowRetainedBytes;
    if (objects.has(row.name)) throw new CorruptError("git schema contains a duplicate object");
    objects.set(row.name, { type: row.type, sql: row.sql });
    if (objects.size > EXPECTED_SCHEMA_OBJECTS.size) {
      throw new CorruptError(`git schema contains unexpected object ${row.name}`);
    }
  }
  return objects;
}

function requireCurrentSchemaObject(
  objects: ReadonlyMap<string, ExpectedSchemaObject>,
  name: string,
): void {
  const expected = EXPECTED_SCHEMA_OBJECTS.get(name);
  if (expected === undefined) throw new Error(`git schema has no definition for ${name}`);
  const actual = objects.get(name);
  if (actual === undefined) {
    throw new CorruptError(`git schema is missing required ${expected.type} ${name}`);
  }
  if (actual.type !== expected.type) {
    throw new CorruptError(
      `git schema object ${name} is a ${actual.type}, expected ${expected.type}`,
    );
  }
  if (actual.sql !== expected.sql) {
    throw new CorruptError(`git schema object ${name} does not match its current definition`);
  }
}

function requireCurrentSchema(objects: ReadonlyMap<string, ExpectedSchemaObject>): void {
  for (const name of EXPECTED_SCHEMA_OBJECTS.keys()) {
    requireCurrentSchemaObject(objects, name);
  }
  for (const name of objects.keys()) {
    if (!EXPECTED_SCHEMA_OBJECTS.has(name)) {
      throw new CorruptError(`git schema contains unexpected object ${name}`);
    }
  }
}

function requireCurrentVersion(db: SqlDatabase): void {
  const row = db.one<{ value: unknown; invalid: unknown }>(
    `SELECT
       CASE WHEN typeof(value) = 'text'
                  AND length(CAST(value AS BLOB)) BETWEEN 0 AND ${MAX_SCHEMA_VERSION_BYTES}
            THEN value END AS value,
       CASE WHEN typeof(value) = 'text'
                  AND length(CAST(value AS BLOB)) BETWEEN 0 AND ${MAX_SCHEMA_VERSION_BYTES}
            THEN 0 ELSE 1 END AS invalid
     FROM git_meta WHERE key = 'schema_version'`,
  );
  if (row === undefined) throw new CorruptError("git schema version is missing");
  if (row.invalid !== 0 && row.invalid !== 1) {
    throw new CorruptError("git schema version bound sentinel is invalid");
  }
  if (row.invalid === 1) throw new CorruptError("git schema version exceeds its read bound");
  const recorded = row.value;
  if (typeof recorded !== "string" || !/^[1-9]\d*$/.test(recorded)) {
    throw new CorruptError("git schema has an invalid version");
  }
  const version = Number(recorded);
  if (!Number.isSafeInteger(version)) throw new CorruptError("git schema has an invalid version");
  if (version !== SCHEMA_VERSION) {
    throw new CorruptError(
      `git schema version ${version} is unsupported; expected ${SCHEMA_VERSION}`,
    );
  }
}

export function initializeGitSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    const bounded = new SchemaDatabase(db);
    const before = readSchemaObjects(bounded);
    if (before.size !== 0) {
      if (!before.has("git_meta")) {
        throw new CorruptError("git schema metadata is missing from an existing database");
      }
      requireCurrentSchemaObject(before, "git_meta");
      requireCurrentVersion(bounded);
      requireCurrentSchema(before);
      return;
    }

    for (const statement of STATEMENTS) bounded.run(statement);
    bounded.run(
      "INSERT INTO git_meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
    requireCurrentSchema(readSchemaObjects(bounded));
    requireCurrentVersion(bounded);
  });
}
