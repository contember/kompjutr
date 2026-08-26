// The whole git repository lives in these tables. There is no `.git`
// directory anywhere: HEAD, refs, config, the index, the object database
// and every received packfile are rows.
//
// Every table except the registry carries `repo_id`, so one workspace can
// hold several repositories side by side.

import { CorruptError, GitError } from "../core/errors.js";
import {
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_PATH_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_STATE_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeIndexSnapshot,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  type MergeWorktreeSnapshot,
  requireMergeInteger,
  requireMergeMode,
  requireMergeNullableInteger,
  requireMergeOid,
  requireMergePhase,
  requireMergePurpose,
  requireMergeText,
} from "../core/ops/merge-state.js";
import {
  type MergeOperationStateMetadata,
  mergeOperationState,
  type OperationStepMetadata,
  operationJournalIntegrityOid,
  operationJournalRetainedBytes,
  operationJournalV10IntegrityOid,
  operationJournalV10RetainedBytes,
  operationStepsForState,
  type ReplayStateMetadata,
} from "../core/ops/operation-state.js";
import { comparePaths } from "../core/streams.js";
import {
  BLOB_ID_GENERATION_EXHAUSTED,
  MAX_BLOB_ID_CACHE_ROWS,
  MAX_CACHED_CONTENT_ID_BYTES,
} from "./blob-id-cache.js";
import type { SqlDatabase } from "./db.js";
import { migrateV12 } from "./schema-migration-v12.js";

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

export const SCHEMA_VERSION = 12;
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
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID`;

const OPERATION_STATE_TABLE = `CREATE TABLE IF NOT EXISTS git_operation_state (
  repo_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'cherry-pick', 'revert', 'rebase')),
  original_head_ref TEXT NOT NULL,
  original_head_oid TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('conflicted', 'ready', 'empty', 'running')),
  empty_reason TEXT CHECK (empty_reason IN ('source', 'result')),
  current_parent_oid TEXT,
  incoming_parent_oid TEXT,
  upstream_oid TEXT,
  base_oid TEXT,
  mode TEXT CHECK (mode IN ('commit', 'no-commit')),
  current_step INTEGER NOT NULL,
  step_count INTEGER NOT NULL,
  current_label TEXT NOT NULL,
  incoming_label TEXT NOT NULL,
  message TEXT NOT NULL,
  author_name TEXT,
  author_email TEXT,
  committer_name TEXT,
  committer_email TEXT,
  touched_count INTEGER NOT NULL,
  retained_bytes INTEGER NOT NULL,
  integrity_oid TEXT NOT NULL,
  CHECK (
    (kind = 'merge' AND phase IN ('conflicted', 'ready') AND empty_reason IS NULL
       AND current_parent_oid IS NOT NULL AND incoming_parent_oid IS NOT NULL
       AND upstream_oid IS NULL AND base_oid IS NULL AND mode IS NOT NULL
       AND current_step = 0 AND step_count = 0
       AND (phase != 'ready' OR mode = 'no-commit'))
    OR
    (kind IN ('cherry-pick', 'revert') AND phase IN ('conflicted', 'empty')
       AND current_parent_oid IS NULL AND incoming_parent_oid IS NULL
       AND upstream_oid IS NULL AND base_oid IS NULL AND mode IS NULL
       AND current_step = 0 AND step_count = 1
       AND ((phase = 'conflicted' AND empty_reason IS NULL)
         OR (phase = 'empty' AND empty_reason IS NOT NULL)))
    OR
    (kind = 'rebase' AND phase IN ('running', 'conflicted') AND empty_reason IS NULL
       AND current_parent_oid IS NOT NULL AND incoming_parent_oid IS NULL
       AND upstream_oid IS NOT NULL AND base_oid IS NOT NULL AND mode IS NULL
       AND typeof(current_step) = 'integer' AND current_step >= 0
       AND typeof(step_count) = 'integer' AND step_count >= 1
       AND current_step <= step_count
       AND (phase != 'conflicted' OR current_step < step_count))
  ),
  CHECK ((author_name IS NULL) = (author_email IS NULL)),
  CHECK ((committer_name IS NULL) = (committer_email IS NULL))
)`;

const OPERATION_STEPS_TABLE = `CREATE TABLE IF NOT EXISTS git_operation_steps (
  repo_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  source_oid TEXT NOT NULL,
  selected_parent_oid TEXT,
  mainline INTEGER CHECK (mainline IS NULL OR (typeof(mainline) = 'integer' AND mainline >= 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'skipped')),
  result_oid TEXT,
  PRIMARY KEY (repo_id, ordinal),
  CHECK ((outcome = 'applied' AND result_oid IS NOT NULL)
      OR (outcome IN ('pending', 'skipped') AND result_oid IS NULL)),
  CHECK (mainline IS NULL OR selected_parent_oid IS NOT NULL)
) WITHOUT ROWID`;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // Registry. `root` is the absolute working-tree root inside the
  // workspace; a repository is resolved for a cwd by finding the nearest
  // registered ancestor. `head` holds HEAD's raw value: either
  // "ref: refs/heads/<name>" or a 40-hex oid when detached.
  `CREATE TABLE IF NOT EXISTS git_repositories (
     id INTEGER PRIMARY KEY,
     root TEXT NOT NULL UNIQUE,
     head TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS git_refs (
     repo_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     target TEXT NOT NULL,
     PRIMARY KEY (repo_id, name)
   )`,

  // Dotted config path ("user.email", "remote.origin.url"). `seq` keeps
  // multi-valued keys ordered the way a config file would.
  `CREATE TABLE IF NOT EXISTS git_config (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     seq INTEGER NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (repo_id, path, seq)
   )`,

  // Git's logical index, not the .git/index binary format. The trailing
  // columns cache what the working tree looked like when the entry was
  // written, so an unchanged file does not have to be re-hashed.
  `CREATE TABLE IF NOT EXISTS git_index (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     stage INTEGER NOT NULL,
     mode INTEGER NOT NULL,
     oid TEXT NOT NULL,
     size INTEGER,
     mtime INTEGER,
     ino INTEGER,
     rev INTEGER,
     PRIMARY KEY (repo_id, path, stage)
   )`,

  `CREATE TABLE IF NOT EXISTS git_index_state (
     repo_id INTEGER PRIMARY KEY,
     baseline_tree_oid TEXT,
     format INTEGER NOT NULL CHECK (format = 1),
     complete INTEGER NOT NULL CHECK (complete IN (0, 1))
   )`,

  `CREATE TABLE IF NOT EXISTS git_index_dirty (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     flags INTEGER NOT NULL CHECK (typeof(flags) = 'integer' AND flags IN (1, 2, 3)),
     PRIMARY KEY (repo_id, path)
   ) WITHOUT ROWID`,

  // One durable incomplete operation header; ordered replay state lives in
  // `git_operation_steps` and touched rows belong only to a suspended step.
  OPERATION_STATE_TABLE,

  OPERATION_STEPS_TABLE,

  // Original identities for only paths owned by the operation. Physical paths
  // include conflict relocations; logical_path ties them back to the index path.
  `CREATE TABLE IF NOT EXISTS git_operation_touched (
     repo_id INTEGER NOT NULL,
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
     PRIMARY KEY (repo_id, ordinal),
     UNIQUE (repo_id, path),
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
     )
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
     PRIMARY KEY (repo_id, content_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_blob_id_state (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0)
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
     PRIMARY KEY (repo_id, oid)
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
     PRIMARY KEY (repo_id, oid)
   )`,

  // Full parsed commits for graph walks and reads. This remains a derived
  // cache: source metadata is validated before a row can be returned.
  COMMIT_TABLE,

  `CREATE TABLE IF NOT EXISTS git_object_chunks (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq)
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
     PRIMARY KEY (repo_id, pack_id)
   )`,

  `CREATE TABLE IF NOT EXISTS git_pack_data (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq)
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
     PRIMARY KEY (repo_id, oid)
   )`,

  `CREATE INDEX IF NOT EXISTS git_pack_objects_loc
     ON git_pack_objects (repo_id, pack_id, offset)`,

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
     PRIMARY KEY (repo_id, pack_id, offset)
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
     UNIQUE (source_key, repo_id, tree_oid)
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

// v1 -> v2 added `git_blob_ids`, `git_commits` and `git_objects.stored`.
// v3 added parsed tree tables. v4 replaces the incomplete, unused commit
// projection. v5 records the monotonic filesystem revision in index stat data.
// v6 adds inert index baseline and dirty-path state for sparse status queries.
// v7 adds source-qualified tree entry lookup by raw name bytes. v8 adds the
// durable merge journal; v9 binds its rows to one deterministic identity. v10
// generalizes that journal to replay. v11 moves replay sources into ordered steps.

interface V10OperationRow {
  repo_id: unknown;
  kind: unknown;
  original_head_ref: unknown;
  original_head_oid: unknown;
  phase: unknown;
  empty_reason: unknown;
  current_parent_oid: unknown;
  incoming_parent_oid: unknown;
  mode: unknown;
  source_oid: unknown;
  selected_parent_oid: unknown;
  mainline: unknown;
  current_label: unknown;
  incoming_label: unknown;
  message: unknown;
  author_name: unknown;
  author_email: unknown;
  committer_name: unknown;
  committer_email: unknown;
  touched_count: unknown;
  retained_bytes: unknown;
  integrity_oid: unknown;
}

interface V10TouchedRow {
  ordinal: unknown;
  path: unknown;
  logical_path: unknown;
  purpose: unknown;
  index_stage: unknown;
  index_mode: unknown;
  index_oid: unknown;
  index_size: unknown;
  index_mtime: unknown;
  index_ino: unknown;
  index_rev: unknown;
  worktree_kind: unknown;
  worktree_mode: unknown;
  worktree_oid: unknown;
  worktree_revision: unknown;
}

function migrationIdentity(
  name: unknown,
  email: unknown,
  label: string,
): MergeSavedIdentity | null {
  if (name === null && email === null) return null;
  if (name === null || email === null) {
    throw new CorruptError(`operation ${label} identity row is incomplete`);
  }
  return {
    name: requireMergeText(name, `${label} name`),
    email: requireMergeText(email, `${label} email`),
  };
}

function migrationIndex(row: V10TouchedRow): MergeIndexSnapshot | null {
  const fields = [
    row.index_stage,
    row.index_mode,
    row.index_oid,
    row.index_size,
    row.index_mtime,
    row.index_ino,
    row.index_rev,
  ];
  if (fields.every((field) => field === null)) return null;
  if (row.index_stage !== 0) throw new CorruptError("merge index snapshot has an invalid stage");
  return {
    stage: 0,
    mode: requireMergeInteger(row.index_mode, "index mode"),
    oid: requireMergeOid(row.index_oid, "index oid"),
    size: requireMergeNullableInteger(row.index_size, "index size"),
    mtime: requireMergeNullableInteger(row.index_mtime, "index mtime"),
    ino: requireMergeNullableInteger(row.index_ino, "index inode"),
    rev: requireMergeNullableInteger(row.index_rev, "index revision"),
  };
}

function migrationWorktree(row: V10TouchedRow): MergeWorktreeSnapshot {
  const kind = requireMergeText(row.worktree_kind, "worktree kind");
  if (kind === "absent") {
    if (row.worktree_mode !== null || row.worktree_oid !== null || row.worktree_revision !== null) {
      throw new CorruptError("absent merge worktree snapshot retained metadata");
    }
    return { kind };
  }
  const mode = requireMergeInteger(row.worktree_mode, "worktree mode");
  const revision = requireMergeInteger(row.worktree_revision, "worktree revision");
  if (kind === "directory") {
    if (row.worktree_oid !== null) {
      throw new CorruptError("merge directory snapshot retained an object id");
    }
    return { kind, mode, revision };
  }
  if (kind === "file" || kind === "symlink") {
    return { kind, mode, oid: requireMergeOid(row.worktree_oid, "worktree oid"), revision };
  }
  throw new CorruptError("merge journal has an invalid worktree kind");
}

function migrationTouched(db: SqlDatabase, repoId: number, count: number): MergeTouchedPath[] {
  if (count > MAX_MERGE_TOUCHED_PATHS) {
    throw new CorruptError("operation journal retained too many touched paths");
  }
  const touched: MergeTouchedPath[] = [];
  let previousPath: string | null = null;
  for (const raw of db.iterate(
    `SELECT CASE WHEN typeof(ordinal) = 'integer'
                          AND ordinal >= 0 AND ordinal < ${MAX_MERGE_TOUCHED_PATHS}
                 THEN ordinal END AS ordinal,
            CASE WHEN typeof(path) = 'text' AND length(CAST(path AS BLOB)) <= ${MAX_MERGE_PATH_BYTES}
                 THEN path END AS path,
            CASE WHEN typeof(logical_path) = 'text'
                       AND length(CAST(logical_path AS BLOB)) <= ${MAX_MERGE_PATH_BYTES}
                 THEN logical_path END AS logical_path,
            CASE WHEN typeof(purpose) = 'text' AND length(CAST(purpose AS BLOB)) <= 19
                 THEN purpose END AS purpose,
            index_stage, index_mode,
            CASE WHEN index_oid IS NULL THEN NULL
                 WHEN typeof(index_oid) = 'text' AND length(CAST(index_oid AS BLOB)) = 40
                 THEN index_oid ELSE 0 END AS index_oid,
            index_size, index_mtime, index_ino, index_rev,
            CASE WHEN typeof(worktree_kind) = 'text'
                       AND length(CAST(worktree_kind AS BLOB)) <= 9
                 THEN worktree_kind END AS worktree_kind,
            worktree_mode,
            CASE WHEN worktree_oid IS NULL THEN NULL
                 WHEN typeof(worktree_oid) = 'text' AND length(CAST(worktree_oid AS BLOB)) = 40
                 THEN worktree_oid ELSE 0 END AS worktree_oid,
            worktree_revision
       FROM git_operation_touched WHERE repo_id = ? ORDER BY ordinal`,
    repoId,
  )) {
    const row: V10TouchedRow = {
      ordinal: raw.ordinal,
      path: raw.path,
      logical_path: raw.logical_path,
      purpose: raw.purpose,
      index_stage: raw.index_stage,
      index_mode: raw.index_mode,
      index_oid: raw.index_oid,
      index_size: raw.index_size,
      index_mtime: raw.index_mtime,
      index_ino: raw.index_ino,
      index_rev: raw.index_rev,
      worktree_kind: raw.worktree_kind,
      worktree_mode: raw.worktree_mode,
      worktree_oid: raw.worktree_oid,
      worktree_revision: raw.worktree_revision,
    };
    const ordinal = requireMergeInteger(row.ordinal, "touched-path ordinal");
    if (ordinal !== touched.length || touched.length >= count) {
      throw new CorruptError("operation touched-path ordinals are not contiguous");
    }
    const entry: MergeTouchedPath = {
      path: requireMergeText(row.path, "touched path"),
      logicalPath: requireMergeText(row.logical_path, "logical path"),
      purpose: requireMergePurpose(row.purpose),
      index: migrationIndex(row),
      worktree: migrationWorktree(row),
    };
    if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
      throw new CorruptError("operation touched paths are not in strict Git path order");
    }
    touched.push(entry);
    previousPath = entry.path;
  }
  if (touched.length !== count) {
    throw new CorruptError("operation touched-path count does not match its rows");
  }
  return touched;
}

function insertMigratedOperation(
  db: SqlDatabase,
  repoId: number,
  state: MergeOperationStateMetadata | ReplayStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
  retainedBytes: number,
  integrityOid: string,
): void {
  db.run(
    `INSERT INTO git_operation_state
       (repo_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
        current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode,
        current_step, step_count, current_label, incoming_label, message,
        author_name, author_email, committer_name, committer_email,
        touched_count, retained_bytes, integrity_oid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    repoId,
    state.kind,
    state.originalHeadRef,
    state.originalHeadOid,
    state.phase,
    state.kind === "merge" ? null : state.emptyReason,
    state.kind === "merge" ? state.currentParentOid : null,
    state.kind === "merge" ? state.incomingParentOid : null,
    state.kind === "merge" ? state.mode : null,
    steps.length,
    state.currentLabel,
    state.incomingLabel,
    state.message,
    state.author?.name ?? null,
    state.author?.email ?? null,
    state.committer?.name ?? null,
    state.committer?.email ?? null,
    touched.length,
    retainedBytes,
    integrityOid,
  );
  for (let ordinal = 0; ordinal < steps.length; ordinal++) {
    const step = steps[ordinal];
    if (step === undefined) throw new CorruptError("v10 migration lost an operation step");
    db.run(
      `INSERT INTO git_operation_steps
         (repo_id, ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      repoId,
      ordinal,
      step.sourceOid,
      step.selectedParentOid,
      step.mainline,
      step.outcome,
      step.resultOid,
    );
  }
}

function migrateV10OperationJournal(db: SqlDatabase): void {
  db.run("ALTER TABLE git_operation_state RENAME TO git_operation_state_v10");
  db.run(OPERATION_STATE_TABLE);
  for (const raw of db.iterate(
    `SELECT CASE WHEN typeof(repo_id) = 'integer' AND repo_id >= 0
                            AND repo_id <= ${Number.MAX_SAFE_INTEGER}
                 THEN repo_id END AS repo_id,
            CASE WHEN typeof(kind) = 'text' AND length(CAST(kind AS BLOB)) <= 11
                 THEN kind END AS kind,
            CASE WHEN typeof(original_head_ref) = 'text'
                       AND length(CAST(original_head_ref AS BLOB)) <= ${MAX_MERGE_REF_BYTES}
                 THEN original_head_ref END AS original_head_ref,
            CASE WHEN typeof(original_head_oid) = 'text'
                       AND length(CAST(original_head_oid AS BLOB)) = 40
                 THEN original_head_oid END AS original_head_oid,
            CASE WHEN typeof(phase) = 'text' AND length(CAST(phase AS BLOB)) <= 10
                 THEN phase END AS phase,
            CASE WHEN empty_reason IS NULL THEN NULL
                 WHEN typeof(empty_reason) = 'text' AND length(CAST(empty_reason AS BLOB)) <= 6
                 THEN empty_reason ELSE 0 END AS empty_reason,
            CASE WHEN current_parent_oid IS NULL THEN NULL
                 WHEN typeof(current_parent_oid) = 'text'
                       AND length(CAST(current_parent_oid AS BLOB)) = 40
                 THEN current_parent_oid ELSE 0 END AS current_parent_oid,
            CASE WHEN incoming_parent_oid IS NULL THEN NULL
                 WHEN typeof(incoming_parent_oid) = 'text'
                       AND length(CAST(incoming_parent_oid AS BLOB)) = 40
                 THEN incoming_parent_oid ELSE 0 END AS incoming_parent_oid,
            CASE WHEN mode IS NULL THEN NULL
                 WHEN typeof(mode) = 'text' AND length(CAST(mode AS BLOB)) <= 9
                 THEN mode ELSE 0 END AS mode,
            CASE WHEN source_oid IS NULL THEN NULL
                 WHEN typeof(source_oid) = 'text' AND length(CAST(source_oid AS BLOB)) = 40
                 THEN source_oid ELSE 0 END AS source_oid,
            CASE WHEN selected_parent_oid IS NULL THEN NULL
                 WHEN typeof(selected_parent_oid) = 'text'
                       AND length(CAST(selected_parent_oid AS BLOB)) = 40
                 THEN selected_parent_oid ELSE 0 END AS selected_parent_oid,
            CASE WHEN mainline IS NULL THEN NULL
                 WHEN typeof(mainline) = 'integer' AND mainline >= 1
                      AND mainline <= ${Number.MAX_SAFE_INTEGER}
                 THEN mainline ELSE -1 END AS mainline,
            CASE WHEN typeof(current_label) = 'text'
                       AND length(CAST(current_label AS BLOB)) <= ${MAX_MERGE_LABEL_BYTES}
                 THEN current_label END AS current_label,
            CASE WHEN typeof(incoming_label) = 'text'
                       AND length(CAST(incoming_label AS BLOB)) <= ${MAX_MERGE_LABEL_BYTES}
                 THEN incoming_label END AS incoming_label,
            CASE WHEN typeof(message) = 'text'
                       AND length(CAST(message AS BLOB)) <= ${MAX_MERGE_MESSAGE_BYTES}
                 THEN message END AS message,
            CASE WHEN author_name IS NULL THEN NULL
                 WHEN typeof(author_name) = 'text'
                       AND length(CAST(author_name AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                 THEN author_name ELSE 0 END AS author_name,
            CASE WHEN author_email IS NULL THEN NULL
                 WHEN typeof(author_email) = 'text'
                       AND length(CAST(author_email AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                 THEN author_email ELSE 0 END AS author_email,
            CASE WHEN committer_name IS NULL THEN NULL
                 WHEN typeof(committer_name) = 'text'
                       AND length(CAST(committer_name AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                 THEN committer_name ELSE 0 END AS committer_name,
            CASE WHEN committer_email IS NULL THEN NULL
                 WHEN typeof(committer_email) = 'text'
                       AND length(CAST(committer_email AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                 THEN committer_email ELSE 0 END AS committer_email,
            CASE WHEN typeof(touched_count) = 'integer' AND touched_count >= 0
                       AND touched_count <= ${MAX_MERGE_TOUCHED_PATHS}
                 THEN touched_count END AS touched_count,
            CASE WHEN typeof(retained_bytes) = 'integer' AND retained_bytes >= 0
                       AND retained_bytes <= ${MAX_MERGE_STATE_BYTES}
                 THEN retained_bytes END AS retained_bytes,
            CASE WHEN typeof(integrity_oid) = 'text'
                       AND length(CAST(integrity_oid AS BLOB)) = 40
                 THEN integrity_oid END AS integrity_oid
       FROM git_operation_state_v10 ORDER BY repo_id`,
  )) {
    const row: V10OperationRow = {
      repo_id: raw.repo_id,
      kind: raw.kind,
      original_head_ref: raw.original_head_ref,
      original_head_oid: raw.original_head_oid,
      phase: raw.phase,
      empty_reason: raw.empty_reason,
      current_parent_oid: raw.current_parent_oid,
      incoming_parent_oid: raw.incoming_parent_oid,
      mode: raw.mode,
      source_oid: raw.source_oid,
      selected_parent_oid: raw.selected_parent_oid,
      mainline: raw.mainline,
      current_label: raw.current_label,
      incoming_label: raw.incoming_label,
      message: raw.message,
      author_name: raw.author_name,
      author_email: raw.author_email,
      committer_name: raw.committer_name,
      committer_email: raw.committer_email,
      touched_count: raw.touched_count,
      retained_bytes: raw.retained_bytes,
      integrity_oid: raw.integrity_oid,
    };
    const repoId = requireMergeInteger(row.repo_id, "repository id");
    const common = {
      originalHeadRef: requireMergeText(row.original_head_ref, "original HEAD ref"),
      originalHeadOid: requireMergeOid(row.original_head_oid, "original HEAD"),
      currentLabel: requireMergeText(row.current_label, "current label"),
      incomingLabel: requireMergeText(row.incoming_label, "incoming label"),
      message: requireMergeText(row.message, "message"),
      author: migrationIdentity(row.author_name, row.author_email, "author"),
      committer: migrationIdentity(row.committer_name, row.committer_email, "committer"),
    };
    const touchedCount = requireMergeInteger(row.touched_count, "touched-path count");
    const touched = migrationTouched(db, repoId, touchedCount);
    const storedBytes = requireMergeInteger(row.retained_bytes, "retained-byte count");
    const storedIntegrityOid = requireMergeOid(row.integrity_oid, "journal integrity oid");
    let state: MergeOperationStateMetadata | ReplayStateMetadata;
    let steps: readonly OperationStepMetadata[];
    let legacyBytes: number;
    let legacyIntegrityOid: string;
    if (row.kind === "merge") {
      if (
        row.empty_reason !== null ||
        row.source_oid !== null ||
        row.selected_parent_oid !== null ||
        row.mainline !== null
      ) {
        throw new CorruptError("v10 merge journal retained replay fields");
      }
      const mergeState: MergeStateMetadata = {
        ...common,
        currentParentOid: requireMergeOid(row.current_parent_oid, "current parent"),
        incomingParentOid: requireMergeOid(row.incoming_parent_oid, "incoming parent"),
        phase: requireMergePhase(row.phase),
        mode: requireMergeMode(row.mode),
      };
      state = mergeOperationState(mergeState);
      steps = [];
      legacyBytes = operationJournalRetainedBytes(state, touched, steps);
      legacyIntegrityOid = operationJournalIntegrityOid(state, touched, steps);
    } else if (row.kind === "cherry-pick" || row.kind === "revert") {
      if (
        row.current_parent_oid !== null ||
        row.incoming_parent_oid !== null ||
        row.mode !== null
      ) {
        throw new CorruptError("v10 replay journal retained merge fields");
      }
      if (row.phase !== "conflicted" && row.phase !== "empty") {
        throw new CorruptError("replay journal has an invalid phase");
      }
      if (
        row.empty_reason !== null &&
        row.empty_reason !== "source" &&
        row.empty_reason !== "result"
      ) {
        throw new CorruptError("replay journal has an invalid empty reason");
      }
      const mainline = row.mainline === null ? null : requireMergeInteger(row.mainline, "mainline");
      if (mainline === 0) throw new CorruptError("replay mainline is not positive");
      const replayState: ReplayStateMetadata = {
        kind: row.kind,
        ...common,
        phase: row.phase,
        emptyReason: row.empty_reason,
        sourceOid: requireMergeOid(row.source_oid, "source"),
        selectedParentOid:
          row.selected_parent_oid === null
            ? null
            : requireMergeOid(row.selected_parent_oid, "selected parent"),
        mainline,
      };
      state = replayState;
      steps = operationStepsForState(replayState);
      legacyBytes = operationJournalV10RetainedBytes(replayState, touched);
      legacyIntegrityOid = operationJournalV10IntegrityOid(replayState, touched);
    } else {
      throw new CorruptError("v10 operation journal has an invalid kind");
    }
    if (legacyBytes !== storedBytes) {
      throw new CorruptError("v10 operation retained-byte count does not match its rows");
    }
    if (legacyIntegrityOid !== storedIntegrityOid) {
      throw new CorruptError("v10 operation integrity identity does not match its rows");
    }
    const retainedBytes = operationJournalRetainedBytes(state, touched, steps);
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    insertMigratedOperation(db, repoId, state, steps, touched, retainedBytes, integrityOid);
  }
  const orphaned = db.scalar<unknown>(
    `SELECT EXISTS(
       SELECT 1 FROM git_operation_touched touched
        WHERE NOT EXISTS (
          SELECT 1 FROM git_operation_state_v10 state WHERE state.repo_id = touched.repo_id
        ) LIMIT 1
     )`,
  );
  if (orphaned !== 0 && orphaned !== 1) {
    throw new CorruptError("v10 operation orphan probe returned an invalid value");
  }
  if (orphaned === 1) throw new CorruptError("v10 touched rows exist without operation state");
  db.run("DROP TABLE git_operation_state_v10");
}

const MAX_SCHEMA_INITIALIZATION_STATEMENTS = 999;

class MigrationDatabase implements SqlDatabase {
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

function tableExists(db: SqlDatabase, name: string): boolean {
  const exists = db.scalar<unknown>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
    name,
  );
  if (exists !== 0 && exists !== 1) throw new CorruptError("schema table probe is invalid");
  return exists === 1;
}

const V11_REQUIRED_TABLES = [
  "git_repositories",
  "git_refs",
  "git_config",
  "git_index",
  "git_index_state",
  "git_index_dirty",
  "git_operation_state",
  "git_operation_steps",
  "git_operation_touched",
  "git_shallow",
  "git_objects",
  "git_object_chunks",
  "git_pack_meta",
  "git_pack_data",
  "git_pack_objects",
  "git_pack_pending",
];

const V12_REQUIRED_TABLES = [
  ...V11_REQUIRED_TABLES,
  "git_blob_ids",
  "git_blob_id_state",
  "git_commits",
  "git_tree_sources",
  "git_tree_entries",
  "git_tree_effective",
];

function requireExistingSchema(db: SqlDatabase, version: number): void {
  const required =
    version === 12 ? V12_REQUIRED_TABLES : version === 11 ? V11_REQUIRED_TABLES : ["git_objects"];
  const found = new Set<string>();
  for (const row of db.iterate(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'git_*'",
  )) {
    if (typeof row.name !== "string") throw new CorruptError("git schema table probe is invalid");
    found.add(row.name);
  }
  const missing = required.find((name) => !found.has(name));
  if (missing !== undefined) {
    throw new CorruptError(`git schema version ${version} is missing required table ${missing}`);
  }
}

function migrate(db: SqlDatabase, from: number): void {
  if (from < 2) {
    db.run("ALTER TABLE git_objects ADD COLUMN stored TEXT NOT NULL DEFAULT 'zlib'");
  }
  if (from < 4) {
    db.run("DROP TABLE git_commits");
    db.run(COMMIT_TABLE);
  }
  if (from < 5) {
    const hasRevision = db
      .all<{ name: string }>("PRAGMA table_info(git_index)")
      .some((column) => column.name === "rev");
    if (!hasRevision) db.run("ALTER TABLE git_index ADD COLUMN rev INTEGER");
  }
  if (from < 9) {
    const legacyColumns = db.all<{ name: string }>("PRAGMA table_info(git_merge_state)");
    const hasLegacyJournal = legacyColumns.some((column) => column.name === "repo_id");
    const hasIntegrity = legacyColumns.some((column) => column.name === "integrity_oid");
    if (hasLegacyJournal && !hasIntegrity) {
      db.run("ALTER TABLE git_merge_state ADD COLUMN integrity_oid TEXT NOT NULL DEFAULT ''");
      // A v8 journal cannot be authenticated after the upgrade.
      db.run("DELETE FROM git_merge_touched");
      db.run("DELETE FROM git_merge_state");
    }
  }
  if (from < 10) {
    const legacy = db
      .all<{ name: string }>("PRAGMA table_info(git_merge_state)")
      .some((column) => column.name === "repo_id");
    if (legacy) {
      db.run(
        `INSERT INTO git_operation_state
           (repo_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
            current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode,
            current_step, step_count, current_label, incoming_label, message,
            author_name, author_email, committer_name, committer_email,
            touched_count, retained_bytes, integrity_oid)
         SELECT repo_id, 'merge', original_head_ref, original_head_oid, phase, NULL,
                current_parent_oid, incoming_parent_oid, NULL, NULL, mode, 0, 0,
                current_label, incoming_label, message, author_name, author_email,
                committer_name, committer_email, touched_count, retained_bytes, integrity_oid
           FROM git_merge_state`,
      );
      db.run(
        `INSERT INTO git_operation_touched
           (repo_id, ordinal, path, logical_path, purpose, index_stage, index_mode,
            index_oid, index_size, index_mtime, index_ino, index_rev, worktree_kind,
            worktree_mode, worktree_oid, worktree_revision)
         SELECT repo_id, ordinal, path, logical_path, purpose, index_stage, index_mode,
                index_oid, index_size, index_mtime, index_ino, index_rev, worktree_kind,
                worktree_mode, worktree_oid, worktree_revision
           FROM git_merge_touched`,
      );
      db.run("DROP TABLE git_merge_touched");
      db.run("DROP TABLE git_merge_state");
    }
  }
  if (from === 10) migrateV10OperationJournal(db);
  if (from < 12) migrateV12(db, STATEMENTS);
}

export function initializeGitSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    const bounded = new MigrationDatabase(db);
    const [meta] = STATEMENTS;
    const hadMeta = tableExists(bounded, "git_meta");
    if (!hadMeta) {
      const existing = bounded.scalar<unknown>(
        "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name GLOB 'git_*'",
      );
      if (!Number.isSafeInteger(existing) || typeof existing !== "number" || existing < 0) {
        throw new CorruptError("git schema table count is invalid");
      }
      if (existing !== 0) {
        throw new CorruptError("git schema metadata is missing from an existing database");
      }
      bounded.run(meta);
    }
    const recorded = bounded.scalar<unknown>(
      "SELECT value FROM git_meta WHERE key = 'schema_version'",
    );
    if (recorded !== undefined && (typeof recorded !== "string" || !/^[1-9]\d*$/.test(recorded))) {
      throw new CorruptError("git schema has an invalid version");
    }
    const previous = recorded === undefined ? undefined : Number(recorded);
    if (previous !== undefined && !Number.isSafeInteger(previous)) {
      throw new CorruptError("git schema has an invalid version");
    }
    if (previous !== undefined && previous > SCHEMA_VERSION) {
      throw new CorruptError(
        `git schema version ${previous} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }
    if (previous === undefined && hadMeta) {
      const existing = bounded.scalar<unknown>(
        "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name != 'git_meta' AND name GLOB 'git_*'",
      );
      if (existing !== 0) {
        throw new CorruptError("git schema version is missing from an existing database");
      }
    }
    if (previous !== undefined) requireExistingSchema(bounded, previous);

    const hasLegacyV11Shape = previous !== undefined && previous < 12;
    for (const statement of STATEMENTS) {
      if (
        hasLegacyV11Shape &&
        (statement.includes("git_tree_") || statement.includes("git_blob_id"))
      ) {
        continue;
      }
      bounded.run(statement);
    }

    // 0 means a fresh database: the CREATEs above already carry the current shape.
    if (previous !== undefined && previous < SCHEMA_VERSION) migrate(bounded, previous);

    for (const statement of STATEMENTS) bounded.run(statement);

    bounded.run(
      "INSERT OR REPLACE INTO git_meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
  });
}
