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
  retained_bytes INTEGER NOT NULL,
  integrity_oid TEXT NOT NULL,
  CHECK (
    (kind = 'merge' AND phase IN ('conflicted', 'ready') AND empty_reason IS NULL
       AND current_parent_oid IS NOT NULL AND incoming_parent_oid IS NOT NULL
       AND upstream_oid IS NULL AND base_oid IS NULL AND mode IS NOT NULL
       AND merge_origin IS NOT NULL AND current_step = 0 AND step_count = 0
       AND (phase != 'ready' OR mode = 'no-commit'))
    OR
    (kind IN ('cherry-pick', 'revert') AND phase IN ('conflicted', 'empty')
       AND current_parent_oid IS NULL AND incoming_parent_oid IS NULL
       AND upstream_oid IS NULL AND base_oid IS NULL AND mode IS NULL
       AND merge_origin IS NULL AND current_step = 0 AND step_count = 1
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
       AND (phase != 'conflicted' OR current_step < step_count))
  ),
  CHECK ((author_name IS NULL) = (author_email IS NULL)),
  CHECK ((committer_name IS NULL) = (committer_email IS NULL)),
  FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
)`;
