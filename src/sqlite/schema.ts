// The whole git repository lives in these tables. There is no `.git`
// directory anywhere: HEAD, refs, config, the index, the object database
// and every received packfile are rows.
//
// Every table except the registry carries `repo_id`, so one workspace can
// hold several repositories side by side.

import { isOid, utf8, utf8Decoder } from "../core/bytes.js";
import { CorruptError } from "../core/errors.js";
import { type ParsedTreeEntry, type TreeParseResult, TreeParser } from "../core/objects.js";
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
import { blob, type SqlDatabase } from "./db.js";

export const SCHEMA_VERSION = 11;
/** SQLite queue record, four integer fields, and bounded error fields. */
export const TREE_QUEUE_ROW_FIXED_BYTES = 64 + 4 * 8 + 96;

const COMMIT_TABLE = `CREATE TABLE IF NOT EXISTS git_commits (
  repo_id INTEGER NOT NULL,
  oid TEXT NOT NULL,
  parents TEXT NOT NULL,
  tree TEXT NOT NULL,
  author_name BLOB NOT NULL,
  author_email BLOB NOT NULL,
  author_time INTEGER NOT NULL,
  author_timezone INTEGER NOT NULL,
  committer_name BLOB NOT NULL,
  committer_email BLOB NOT NULL,
  committer_time INTEGER NOT NULL,
  committer_timezone INTEGER NOT NULL,
  message BLOB NOT NULL,
  gpgsig BLOB,
  object_size INTEGER NOT NULL,
  cache_bytes INTEGER NOT NULL,
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
     repo_id INTEGER NOT NULL,
     content_id BLOB NOT NULL,
     oid TEXT NOT NULL,
     PRIMARY KEY (repo_id, content_id)
   ) WITHOUT ROWID`,

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
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     stored TEXT NOT NULL DEFAULT 'zlib',
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
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     size INTEGER NOT NULL,
     count INTEGER NOT NULL,
     state TEXT NOT NULL,
     created INTEGER NOT NULL,
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
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     pack_id INTEGER NOT NULL,
     offset INTEGER NOT NULL,
     data_off INTEGER NOT NULL,
     data_len INTEGER NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     entry_size INTEGER NOT NULL,
     base_oid TEXT,
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
     repo_id INTEGER NOT NULL,
     tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
     source_id INTEGER NOT NULL,
     object_size INTEGER NOT NULL,
     entry_count INTEGER NOT NULL,
     base_cost INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid, storage, source_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_tree_entries (
     repo_id INTEGER NOT NULL,
     tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL,
     source_id INTEGER NOT NULL,
     ordinal INTEGER NOT NULL,
     mode TEXT NOT NULL,
     name TEXT COLLATE BINARY NOT NULL,
     name_bytes BLOB NOT NULL,
     oid TEXT NOT NULL,
     raw_entry BLOB NOT NULL,
     cumulative_base INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid, storage, source_id, ordinal),
     FOREIGN KEY (repo_id, tree_oid, storage, source_id)
       REFERENCES git_tree_sources (repo_id, tree_oid, storage, source_id)
       ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_tree_entries_by_name_bytes
     ON git_tree_entries (repo_id, tree_oid, storage, source_id, name_bytes)
     WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200`,

  // The source selected for traversal. A loose object always shadows its
  // packed copy, including while its parsed marker is missing or corrupt.
  `CREATE TABLE IF NOT EXISTS git_tree_effective (
     repo_id INTEGER NOT NULL,
     tree_oid TEXT NOT NULL,
     storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
     source_id INTEGER NOT NULL,
     PRIMARY KEY (repo_id, tree_oid)
   ) WITHOUT ROWID`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_insert
   AFTER INSERT ON git_objects WHEN NEW.type = 'tree'
   BEGIN
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, storage, source_id)
     VALUES (NEW.repo_id, NEW.oid, 'loose', 0);
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_delete
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
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, storage, source_id)
     SELECT o.repo_id, o.oid, 'pack', o.pack_id
       FROM git_pack_objects o
       JOIN git_pack_meta m
         ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id AND m.state = 'complete'
      WHERE o.repo_id = OLD.repo_id AND o.oid = OLD.oid AND o.type = 'tree';
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_complete
   AFTER UPDATE OF state ON git_pack_meta
   WHEN NEW.state = 'complete' AND OLD.state != 'complete'
   BEGIN
     INSERT OR REPLACE INTO git_tree_effective
       (repo_id, tree_oid, storage, source_id)
     SELECT o.repo_id, o.oid, 'pack', o.pack_id
       FROM git_pack_objects o
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
      WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_hide
   AFTER UPDATE OF state ON git_pack_meta
   WHEN OLD.state = 'complete' AND NEW.state != 'complete'
   BEGIN
     DELETE FROM git_tree_effective
      WHERE repo_id = OLD.repo_id AND storage = 'pack' AND source_id = OLD.pack_id;
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
}

export function initializeGitSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    // git_meta first, so the recorded version is readable before the rest
    // of the CREATEs run and before it gets rewritten below.
    const [meta] = STATEMENTS;
    db.run(meta);
    const recorded = db.scalar<unknown>("SELECT value FROM git_meta WHERE key = 'schema_version'");
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

    for (const statement of STATEMENTS) db.run(statement);

    // 0 means a fresh database: the CREATEs above already carry the current shape.
    if (previous !== undefined && previous < SCHEMA_VERSION) migrate(db, previous);

    db.run(
      "INSERT OR REPLACE INTO git_meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
  });
}

export type TreeStorage = "loose" | "pack";

export interface TreeSource {
  repoId: number;
  treeOid: string;
  storage: TreeStorage;
  sourceId: number;
  objectSize: number;
}

export interface TreeSourceInput extends TreeSource {
  chunks: Iterable<Uint8Array>;
}

const TREE_INDEX_ROWS = 2048;
const TREE_INDEX_ENTRY_ARENA_BYTES = 704 * 1024;
const TREE_INDEX_MARKER_JSON_BYTES = 192 * 1024;
// The two arenas own 896 KiB; this reserve covers their wrappers and scalar state.
const TREE_INDEX_FIXED_BYTES = 64 * 1024;
const TREE_INDEX_MEMORY_BYTES = 1024 * 1024;
const TREE_INDEX_ROW_FIXED_BYTES = 192;
const TREE_INDEX_MARKER_FIXED_BYTES = 192;
const TREE_MODE = /^(?:0?40000|100644|100755|120000|160000)$/;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let at = 0; at < left.length; at++) {
    if (left[at] !== right[at]) return false;
  }
  return true;
}

function validateParsedTreeEntry(parsed: ParsedTreeEntry): void {
  const { entry, nameBytes, rawEntry } = parsed;
  if (!TREE_MODE.test(entry.mode)) throw new CorruptError(`invalid tree mode ${entry.mode}`);
  if (
    entry.name === "" ||
    entry.name.includes("/") ||
    nameBytes.length > 2_200 ||
    nameBytes.includes(0) ||
    utf8Decoder.decode(nameBytes) !== entry.name
  ) {
    throw new CorruptError("invalid tree entry name");
  }
  if (!isOid(entry.oid)) throw new CorruptError("invalid tree entry oid");
  const modeBytes = utf8.encode(entry.mode);
  const expectedLength = modeBytes.length + nameBytes.length + 22;
  const modeEnd = modeBytes.length;
  const nameAt = modeEnd + 1;
  const oidAt = nameAt + nameBytes.length + 1;
  if (
    rawEntry.length !== expectedLength ||
    !equalBytes(rawEntry.subarray(0, modeEnd), modeBytes) ||
    rawEntry[modeEnd] !== 0x20 ||
    !equalBytes(rawEntry.subarray(nameAt, oidAt - 1), nameBytes) ||
    rawEntry[oidAt - 1] !== 0
  ) {
    throw new CorruptError("tree entry raw bytes disagree with parsed fields");
  }
  for (let at = 0; at < 20; at++) {
    if (rawEntry[oidAt + at] !== Number.parseInt(entry.oid.slice(at * 2, at * 2 + 2), 16)) {
      throw new CorruptError("tree entry raw bytes disagree with parsed fields");
    }
  }
}

class AsciiJsonArray {
  readonly bytes: Uint8Array;
  #length = 1;
  #rows = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
    this.bytes[0] = 0x5b;
  }

  get rows(): number {
    return this.#rows;
  }

  get encodedLength(): number {
    return this.#length + 1;
  }

  canAppend(value: string): boolean {
    return this.#length + (this.#rows === 0 ? 0 : 1) + value.length + 1 <= this.bytes.length;
  }

  append(value: string): void {
    if (!this.canAppend(value)) throw new CorruptError("tree index JSON row exceeds its buffer");
    if (this.#rows !== 0) this.bytes[this.#length++] = 0x2c;
    for (let at = 0; at < value.length; at++) {
      const byte = value.charCodeAt(at);
      if (byte > 0x7f) throw new CorruptError("tree index JSON row is not ASCII");
      this.bytes[this.#length++] = byte;
    }
    this.#rows++;
  }

  seal(): number {
    this.bytes[this.#length] = 0x5d;
    return this.#length + 1;
  }

  reset(): void {
    this.#length = 1;
    this.#rows = 0;
    this.bytes[0] = 0x5b;
  }
}

class TreeEntryArena {
  readonly bytes = new Uint8Array(TREE_INDEX_ENTRY_ARENA_BYTES);
  #payloadLength = 0;
  #jsonStart = this.bytes.length - 1;
  #rows = 0;

  constructor() {
    this.bytes[this.#jsonStart] = 0x5d;
  }

  get payloadLength(): number {
    return this.#payloadLength;
  }

  get rows(): number {
    return this.#rows;
  }

  canAppend(payloadLength: number, json: string): boolean {
    const jsonBytes = json.length + (this.#rows === 0 ? 0 : 1);
    return this.#payloadLength + payloadLength < this.#jsonStart - jsonBytes;
  }

  append(payload: Uint8Array, json: string): void {
    if (!this.canAppend(payload.length, json)) {
      throw new CorruptError("tree entry exceeds the index buffer limit");
    }
    this.bytes.set(payload, this.#payloadLength);
    this.#payloadLength += payload.length;
    if (this.#rows !== 0) this.bytes[--this.#jsonStart] = 0x2c;
    this.#jsonStart -= json.length;
    for (let at = 0; at < json.length; at++) {
      const byte = json.charCodeAt(at);
      if (byte > 0x7f) throw new CorruptError("tree index JSON row is not ASCII");
      this.bytes[this.#jsonStart + at] = byte;
    }
    this.#rows++;
  }

  seal(): { offset: number; length: number } {
    this.bytes[--this.#jsonStart] = 0x5b;
    return { offset: this.#jsonStart + 1, length: this.bytes.length - this.#jsonStart };
  }

  reset(): void {
    this.#payloadLength = 0;
    this.#jsonStart = this.bytes.length - 1;
    this.#rows = 0;
    this.bytes[this.#jsonStart] = 0x5d;
  }
}

class TreeIndexBatch {
  readonly #entries = new TreeEntryArena();
  readonly #markers = new AsciiJsonArray(TREE_INDEX_MARKER_JSON_BYTES);
  #peakBytes = TREE_INDEX_ENTRY_ARENA_BYTES + TREE_INDEX_MARKER_JSON_BYTES + TREE_INDEX_FIXED_BYTES;

  constructor(private readonly db: SqlDatabase) {}

  get retainedBytes(): number {
    return TREE_INDEX_ENTRY_ARENA_BYTES + TREE_INDEX_MARKER_JSON_BYTES + TREE_INDEX_FIXED_BYTES;
  }

  get peakBytes(): number {
    return this.#peakBytes;
  }

  get retainedRows(): number {
    return this.#entries.rows + this.#markers.rows;
  }

  addEntry(source: TreeSource, parsed: ParsedTreeEntry, cumulativeBase: number): void {
    const payloadBytes = parsed.rawEntry.length;
    const rawAt = this.#entries.payloadLength + 1;
    const nameAt = rawAt + parsed.entry.mode.length + 1;
    let json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"q":${parsed.ordinal},"m":"${parsed.entry.mode}","o":"${parsed.entry.oid}","a":${nameAt},"l":${parsed.nameBytes.length},"r":${rawAt},"z":${parsed.rawEntry.length},"c":${cumulativeBase}}`;
    if (this.retainedRows >= TREE_INDEX_ROWS || !this.#entries.canAppend(payloadBytes, json)) {
      this.flush();
      json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"q":${parsed.ordinal},"m":"${parsed.entry.mode}","o":"${parsed.entry.oid}","a":${parsed.entry.mode.length + 2},"l":${parsed.nameBytes.length},"r":1,"z":${parsed.rawEntry.length},"c":${cumulativeBase}}`;
    }
    this.#entries.append(parsed.rawEntry, json);
    this.#observeTransient(
      parsed.nameBytes.length * 2 +
        parsed.rawEntry.length +
        json.length * 2 +
        TREE_INDEX_ROW_FIXED_BYTES,
    );
  }

  addMarker(source: TreeSource, count: number, baseCost: number): void {
    const json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"z":${source.objectSize},"n":${count},"b":${baseCost}}`;
    if (json.length + 2 > this.#markers.bytes.length) {
      throw new CorruptError("tree source marker exceeds the index buffer limit");
    }
    if (this.retainedRows >= TREE_INDEX_ROWS || !this.#markers.canAppend(json)) {
      this.flush();
    }
    this.#markers.append(json);
    this.#observeTransient(
      json.length * 2 + source.treeOid.length * 2 + TREE_INDEX_MARKER_FIXED_BYTES,
    );
  }

  flush(): void {
    this.#flushEntries();
    this.#flushMarkers();
  }

  #flushEntries(): void {
    if (this.#entries.rows === 0) return;
    const json = this.#entries.seal();
    this.db.run(
      `INSERT INTO git_tree_entries
         (repo_id, tree_oid, storage, source_id, ordinal, mode, name, name_bytes, oid,
          raw_entry, cumulative_base)
       SELECT json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
              json_extract(j.value, '$.s'), json_extract(j.value, '$.x'),
              json_extract(j.value, '$.q'), json_extract(j.value, '$.m'),
              CAST(substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.l')) AS TEXT),
              substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.l')),
              json_extract(j.value, '$.o'),
              substr(?, json_extract(j.value, '$.r'), json_extract(j.value, '$.z')),
              json_extract(j.value, '$.c')
         FROM json_each(CAST(substr(?, ?, ?) AS TEXT)) j`,
      blob(this.#entries.bytes),
      blob(this.#entries.bytes),
      blob(this.#entries.bytes),
      blob(this.#entries.bytes),
      json.offset,
      json.length,
    );
    this.#entries.reset();
  }

  #flushMarkers(): void {
    if (this.#markers.rows === 0) return;
    const jsonLength = this.#markers.seal();
    this.db.run(
      `INSERT INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, object_size, entry_count, base_cost)
       SELECT json_extract(value, '$.p'), json_extract(value, '$.t'),
              json_extract(value, '$.s'), json_extract(value, '$.x'),
              json_extract(value, '$.z'), json_extract(value, '$.n'),
              json_extract(value, '$.b')
         FROM json_each(CAST(substr(?, 1, ?) AS TEXT))`,
      blob(this.#markers.bytes),
      jsonLength,
    );
    this.#markers.reset();
  }

  #observeTransient(bytes: number): void {
    this.#peakBytes = Math.max(this.#peakBytes, this.retainedBytes + bytes);
    if (this.#peakBytes > TREE_INDEX_MEMORY_BYTES) {
      throw new CorruptError("tree index exceeds its memory limit");
    }
  }
}

class TreeSourceIndexer {
  #count = 0;
  #receivedBytes = 0;
  #observedSize = 0;
  #baseCost = 0;
  #finished = false;

  constructor(
    private readonly source: TreeSource,
    private readonly batch: TreeIndexBatch,
    private readonly writeEntries = true,
    private readonly writeMarker = true,
  ) {
    if (
      !Number.isSafeInteger(source.repoId) ||
      source.repoId < 0 ||
      !isOid(source.treeOid) ||
      (source.storage !== "loose" && source.storage !== "pack") ||
      !Number.isSafeInteger(source.sourceId) ||
      source.sourceId < 0 ||
      !Number.isSafeInteger(source.objectSize) ||
      source.objectSize < 0
    ) {
      throw new CorruptError("tree source has invalid metadata");
    }
  }

  acceptChunk(length: number): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    if (length > this.source.objectSize - this.#receivedBytes) {
      throw new CorruptError(`tree ${this.source.treeOid} exceeds its declared size`);
    }
    this.#receivedBytes += length;
  }

  push(parsed: ParsedTreeEntry): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    validateParsedTreeEntry(parsed);
    if (
      parsed.ordinal !== this.#count ||
      parsed.observedSize !== this.#observedSize + parsed.rawEntry.length
    ) {
      throw new CorruptError("tree parser progress is inconsistent");
    }
    this.#observedSize = parsed.observedSize;
    this.#baseCost +=
      TREE_QUEUE_ROW_FIXED_BYTES +
      parsed.nameBytes.length +
      parsed.entry.mode.length +
      parsed.entry.oid.length;
    if (!Number.isSafeInteger(this.#baseCost)) {
      throw new CorruptError("tree index cost exceeds the safe integer range");
    }
    if (this.writeEntries) this.batch.addEntry(this.source, parsed, this.#baseCost);
    this.#count++;
  }

  finish(parsed: TreeParseResult): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    this.#finished = true;
    if (
      parsed.entryCount !== this.#count ||
      parsed.observedSize !== this.#observedSize ||
      this.#receivedBytes !== parsed.observedSize ||
      this.#observedSize !== this.source.objectSize
    ) {
      throw new CorruptError(
        `tree ${this.source.treeOid} parsed ${parsed.observedSize} bytes, expected ${this.source.objectSize}`,
      );
    }
    if (this.writeMarker) this.batch.addMarker(this.source, this.#count, this.#baseCost);
  }
}

/** Incrementally parse and index one tree. The caller owns the transaction. */
export class TreeIndexSink {
  readonly #parser = new TreeParser();
  readonly #batch: TreeIndexBatch;
  readonly #source: TreeSourceIndexer;
  #finished = false;
  #peakBytes = 0;

  constructor(db: SqlDatabase, source: TreeSource) {
    this.#batch = new TreeIndexBatch(db);
    this.#source = new TreeSourceIndexer(source, this.#batch);
    this.#observePeak();
  }

  get retainedBytes(): number {
    return this.#parser.retainedBytes + this.#batch.retainedBytes;
  }

  get retainedRows(): number {
    return this.#batch.retainedRows;
  }

  get peakBytes(): number {
    return this.#peakBytes;
  }

  push(chunk: Uint8Array): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    this.#source.acceptChunk(chunk.length);
    try {
      for (const parsed of this.#parser.push(chunk)) this.#source.push(parsed);
    } finally {
      this.#observePeak();
    }
  }

  finish(): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    this.#finished = true;
    this.#source.finish(this.#parser.finish());
    this.#batch.flush();
    this.#observePeak();
  }

  #observePeak(): void {
    this.#peakBytes = Math.max(this.#peakBytes, this.#parser.retainedBytes + this.#batch.peakBytes);
    if (this.#peakBytes > TREE_INDEX_MEMORY_BYTES) {
      throw new CorruptError("tree index exceeds its memory limit");
    }
  }
}

export function createTreeIndexSink(db: SqlDatabase, source: TreeSource): TreeIndexSink {
  return new TreeIndexSink(db, source);
}

function indexTreePass(
  batch: TreeIndexBatch,
  sources: Iterable<TreeSourceInput>,
  writeEntries: boolean,
  writeMarkers: boolean,
): void {
  for (const source of sources) {
    const parser = new TreeParser();
    const indexer = new TreeSourceIndexer(source, batch, writeEntries, writeMarkers);
    for (const chunk of source.chunks) {
      indexer.acceptChunk(chunk.length);
      for (const parsed of parser.push(chunk)) indexer.push(parsed);
    }
    indexer.finish(parser.finish());
  }
  batch.flush();
}

/** Write exact parsed-tree sources. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const batch = new TreeIndexBatch(db);
  if (
    Array.isArray(sources) &&
    sources.every((source: TreeSourceInput) => Array.isArray(source.chunks))
  ) {
    indexTreePass(batch, sources, true, false);
    indexTreePass(batch, sources, false, true);
    return;
  }
  indexTreePass(batch, sources, true, true);
}

/** Write one exact parsed-tree source. The caller owns the transaction. */
export function indexTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  const sink = createTreeIndexSink(db, source);
  for (const chunk of chunks) sink.push(chunk);
  sink.finish();
}
