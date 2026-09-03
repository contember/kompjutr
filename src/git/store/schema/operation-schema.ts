export const OPERATION_STATE_TABLE = `CREATE TABLE IF NOT EXISTS git_operation_state (
  checkout_id INTEGER PRIMARY KEY CHECK (
    typeof(checkout_id) = 'integer' AND checkout_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  ),
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
  merge_origin TEXT CHECK (merge_origin IN ('merge', 'pull')),
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
  replayed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (kind = 'merge' AND phase IN ('conflicted', 'ready') AND empty_reason IS NULL
       AND current_parent_oid IS NOT NULL AND incoming_parent_oid IS NOT NULL
       AND upstream_oid IS NULL AND base_oid IS NULL AND mode IS NOT NULL
       AND merge_origin IS NOT NULL AND current_step = 0 AND step_count = 0
       AND replayed_count = 0 AND skipped_count = 0
       AND (phase != 'ready' OR mode = 'no-commit'))
    OR
    (kind IN ('cherry-pick', 'revert') AND phase IN ('conflicted', 'empty')
       AND current_parent_oid IS NULL AND incoming_parent_oid IS NULL
       AND upstream_oid IS NULL AND base_oid IS NULL AND mode IS NULL
       AND merge_origin IS NULL AND current_step = 0 AND step_count = 1
       AND replayed_count = 0 AND skipped_count = 0
       AND ((phase = 'conflicted' AND empty_reason IS NULL)
         OR (phase = 'empty' AND empty_reason IS NOT NULL)))
    OR
    (kind = 'rebase' AND phase IN ('running', 'conflicted') AND empty_reason IS NULL
       AND current_parent_oid IS NOT NULL AND incoming_parent_oid IS NULL
       AND upstream_oid IS NOT NULL AND base_oid IS NOT NULL AND mode IS NULL
       AND merge_origin IS NULL
       AND typeof(current_step) = 'integer' AND current_step >= 0
       AND typeof(step_count) = 'integer' AND step_count >= 1
       AND current_step <= step_count
       AND typeof(replayed_count) = 'integer' AND replayed_count >= 0
       AND typeof(skipped_count) = 'integer' AND skipped_count >= 0
       AND replayed_count + skipped_count = current_step
       AND (phase != 'conflicted' OR current_step < step_count))
  ),
  CHECK ((author_name IS NULL) = (author_email IS NULL)),
  CHECK ((committer_name IS NULL) = (committer_email IS NULL)),
  FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
)`;

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

const OPERATION_TOUCHED_TABLE = `CREATE TABLE IF NOT EXISTS git_operation_touched (
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
) WITHOUT ROWID`;

export const OPERATION_SCHEMA_STATEMENTS = [
  OPERATION_STATE_TABLE,
  OPERATION_STEPS_TABLE,
  OPERATION_TOUCHED_TABLE,
] as const;
