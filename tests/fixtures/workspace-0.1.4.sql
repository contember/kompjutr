-- A Workspace store written by @kompjutr/do@0.1.4 and @kompjutr/git@0.1.4 over
-- tests/helpers/storage.ts: `git init /gone`; `git init /work` with commits
-- "base" and "second"; a failed clone that created and deleted repository 3;
-- one maintenance step. Rows dumped per table, then sqlite_sequence, then
-- indexes, triggers and views. Never regenerate: it pins the 0.1.4 schema.
CREATE TABLE fs_meta (
     k TEXT PRIMARY KEY,
     v INTEGER NOT NULL
   );
CREATE TABLE fs_nodes (
     inode INTEGER PRIMARY KEY CHECK (
       typeof(inode) = 'integer' AND inode BETWEEN 1 AND 9007199254740991
     ),
     type TEXT NOT NULL CHECK (
       typeof(type) = 'text' AND type IN ('file','dir','symlink')
     ),
     mode INTEGER NOT NULL DEFAULT 420 CHECK (
       typeof(mode) = 'integer' AND mode BETWEEN 0 AND 4095
     ),
     mtime INTEGER NOT NULL CHECK (
       typeof(mtime) = 'integer'
       AND mtime BETWEEN -9007199254740991 AND 9007199254740991
     ),
     size INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND 9007199254740991
     ),
     rev INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(rev) = 'integer' AND rev BETWEEN 0 AND 9007199254740991
     ),
     nlink INTEGER NOT NULL DEFAULT 1 CHECK (
       typeof(nlink) = 'integer' AND nlink BETWEEN 1 AND 9007199254740991
     ),
     link_target TEXT,
     content_id BLOB,
     CHECK (
       (type = 'dir' AND size = 0 AND link_target IS NULL AND content_id IS NULL)
       OR (type = 'file' AND link_target IS NULL
           AND (content_id IS NULL OR typeof(content_id) = 'blob'))
       OR (type = 'symlink' AND typeof(link_target) = 'text'
           AND size = length(CAST(link_target AS BLOB))
           AND (content_id IS NULL OR typeof(content_id) = 'blob'))
     )
   );
CREATE TABLE fs_paths (
     path TEXT NOT NULL PRIMARY KEY CHECK (
       typeof(path) = 'text'
       AND substr(path, 1, 1) = '/'
       AND (path = '/' OR substr(path, -1) <> '/')
       AND instr(path, char(0)) = 0
       AND instr(path, '//') = 0
       AND path NOT IN ('/.', '/..')
       AND instr(path, '/./') = 0
       AND instr(path, '/../') = 0
       AND substr(path, -2) <> '/.'
       AND substr(path, -3) <> '/..'
     ),
     parent TEXT NOT NULL CHECK (typeof(parent) = 'text'),
     inode INTEGER NOT NULL CHECK (
       typeof(inode) = 'integer' AND inode BETWEEN 1 AND 9007199254740991
     ),
     CHECK (
       (path = '/' AND parent = '' AND inode = 1)
       OR (path <> '/' AND (
         (parent = '/' AND instr(substr(path, 2), '/') = 0)
         OR (parent <> '' AND parent <> '/'
             AND substr(path, 1, length(parent) + 1) = parent || '/'
             AND instr(substr(path, length(parent) + 2), '/') = 0)
       ))
     )
   ) WITHOUT ROWID;
CREATE TABLE fs_subtree_revs (
   path TEXT NOT NULL PRIMARY KEY CHECK (
     typeof(path) = 'text' AND substr(path, 1, 1) = '/'
   ),
   rev INTEGER NOT NULL CHECK (
     typeof(rev) = 'integer' AND rev BETWEEN 0 AND 9007199254740991
   ),
   replaced_rev INTEGER NOT NULL CHECK (
     typeof(replaced_rev) = 'integer' AND replaced_rev BETWEEN 0 AND rev
   )
 ) WITHOUT ROWID;
CREATE TABLE fs_chunks (
     inode INTEGER NOT NULL,
     idx INTEGER NOT NULL,
     bytes BLOB NOT NULL,
     PRIMARY KEY (inode, idx)
   );
CREATE TABLE git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT;
CREATE TABLE git_repositories (
     id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
       id BETWEEN 1 AND 9007199254740991
     ),
     lifecycle TEXT NOT NULL DEFAULT 'ready' CHECK (
       lifecycle IN ('ready', 'provisional')
     ),
     clone_expires_ms INTEGER CHECK (
       clone_expires_ms IS NULL
       OR clone_expires_ms BETWEEN 0 AND 9007199254740991
     ),
     fetch_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       fetch_generation BETWEEN 0 AND 9007199254740991
     ),
     shallow_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       shallow_revision BETWEEN 0 AND 9007199254740991
     ),
     checkout_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       checkout_revision BETWEEN 0 AND 9007199254740991
     ),
     source_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       source_generation BETWEEN 0 AND 9007199254740991
     ),
     CHECK (
       (lifecycle = 'ready' AND clone_expires_ms IS NULL)
       OR (lifecycle = 'provisional' AND clone_expires_ms IS NOT NULL)
     )
   ) STRICT;
CREATE TABLE git_checkouts (
     id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
       id BETWEEN 1 AND 9007199254740991
     ),
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND 9007199254740991
     ),
     root TEXT NOT NULL UNIQUE CHECK (
       substr(root, 1, 1) = '/'
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
       length(CAST(head AS BLOB)) >= 1
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
       is_primary IN (0, 1)
     ),
     UNIQUE (id, repo_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_refs (
     repo_id INTEGER NOT NULL,
     name TEXT NOT NULL CHECK (
       length(CAST(name AS BLOB)) >= 1
     ),
     target TEXT NOT NULL CHECK (
       length(CAST(target AS BLOB)) >= 1
       AND instr(target, char(0)) = 0
       AND instr(target, char(10)) = 0
       AND instr(target, char(13)) = 0
       AND (
         (length(CAST(target AS BLOB)) = 40 AND target NOT GLOB '*[^0-9a-f]*')
         OR (
           substr(target, 1, 5) = 'ref: '
           AND length(CAST(target AS BLOB)) > 5
           AND substr(target, 6) != 'HEAD'
           AND substr(target, 6, 5) != 'ref: '
         )
       )
     ),
     PRIMARY KEY (repo_id, name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_tracking_ref_revisions (
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND 9007199254740991
     ),
     ref_name TEXT NOT NULL CHECK (
       length(CAST(ref_name AS BLOB)) >= 1
       AND substr(ref_name, 1, 13) = 'refs/remotes/'
     ),
     revision INTEGER NOT NULL CHECK (
       revision BETWEEN 0 AND 9007199254740991
     ),
     PRIMARY KEY (repo_id, ref_name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_fetch_namespaces (
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND 9007199254740991
     ),
     tracking_prefix TEXT NOT NULL CHECK (
       length(CAST(tracking_prefix AS BLOB)) >= 1
       AND substr(tracking_prefix, 1, 13) = 'refs/remotes/'
       AND substr(tracking_prefix, -1) = '/'
     ),
     latest_generation INTEGER NOT NULL CHECK (
       latest_generation BETWEEN 1 AND 9007199254740991
     ),
     revision INTEGER NOT NULL CHECK (
       revision BETWEEN 0 AND 9007199254740991
     ),
     PRIMARY KEY (repo_id, tracking_prefix),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_reflog_state (
     repo_id INTEGER PRIMARY KEY CHECK (repo_id >= 1),
     next_ordinal INTEGER NOT NULL CHECK (
       next_ordinal >= 0
       AND next_ordinal <= 9007199254740991
     ),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_reflog_entries (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     ref_name TEXT NOT NULL CHECK (
       length(CAST(ref_name AS BLOB)) >= 1
     ),
     ordinal INTEGER NOT NULL CHECK (
       ordinal >= 1
       AND ordinal <= 9007199254740991
     ),
     old_raw TEXT CHECK (
       old_raw IS NULL OR (
         length(CAST(old_raw AS BLOB)) >= 1
       )
     ),
     new_raw TEXT CHECK (
       new_raw IS NULL OR (
         length(CAST(new_raw AS BLOB)) >= 1
       )
     ),
     old_oid TEXT CHECK (
       old_oid IS NULL OR (
         length(CAST(old_oid AS BLOB)) = 40 AND old_oid NOT GLOB '*[^0-9a-f]*'
       )
     ),
     new_oid TEXT CHECK (
       new_oid IS NULL OR (
         length(CAST(new_oid AS BLOB)) = 40 AND new_oid NOT GLOB '*[^0-9a-f]*'
       )
     ),
     actor_name TEXT CHECK (
       actor_name IS NULL OR (
         length(CAST(actor_name AS BLOB)) >= 1
       )
     ),
     actor_email TEXT CHECK (
       actor_email IS NULL OR (
         length(CAST(actor_email AS BLOB)) >= 1
       )
     ),
     timestamp INTEGER NOT NULL CHECK (
       timestamp >= 0
       AND timestamp <= 9007199254740991
     ),
     timezone INTEGER NOT NULL CHECK (
       timezone BETWEEN -1440 AND 1440
     ),
     reason TEXT NOT NULL CHECK (
       length(CAST(reason AS BLOB)) >= 1
     ),
     PRIMARY KEY (repo_id, ordinal),
     CHECK ((actor_name IS NULL) = (actor_email IS NULL)),
     CHECK (ref_name != 'HEAD' AND (old_raw IS NOT new_raw OR old_oid IS NOT new_oid)),
     CHECK (
       (old_raw IS NULL AND old_oid IS NULL)
       OR (old_raw IS NOT NULL AND length(CAST(old_raw AS BLOB)) = 40 AND old_raw NOT GLOB '*[^0-9a-f]*' AND old_oid IS old_raw)
       OR (old_raw IS NOT NULL
         AND substr(old_raw, 1, 5) = 'ref: '
         AND length(CAST(old_raw AS BLOB)) > 5
         AND substr(old_raw, 6) != 'HEAD'
         AND substr(old_raw, 6, 5) != 'ref: '
         AND instr(old_raw, char(0)) = 0
         AND instr(old_raw, char(10)) = 0
         AND instr(old_raw, char(13)) = 0)
     ),
     CHECK (
       (new_raw IS NULL AND new_oid IS NULL)
       OR (new_raw IS NOT NULL AND length(CAST(new_raw AS BLOB)) = 40 AND new_raw NOT GLOB '*[^0-9a-f]*' AND new_oid IS new_raw)
       OR (new_raw IS NOT NULL
         AND substr(new_raw, 1, 5) = 'ref: '
         AND length(CAST(new_raw AS BLOB)) > 5
         AND substr(new_raw, 6) != 'HEAD'
         AND substr(new_raw, 6, 5) != 'ref: '
         AND instr(new_raw, char(0)) = 0
         AND instr(new_raw, char(10)) = 0
         AND instr(new_raw, char(13)) = 0)
     ),
     FOREIGN KEY (repo_id) REFERENCES git_reflog_state (repo_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_checkout_reflog_entries (
     checkout_id INTEGER NOT NULL CHECK (
       checkout_id BETWEEN 1 AND 9007199254740991
     ),
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND 9007199254740991
     ),
     ordinal INTEGER NOT NULL CHECK (
       ordinal >= 1
       AND ordinal <= 9007199254740991
     ),
     old_raw TEXT CHECK (
       old_raw IS NULL OR (
         length(CAST(old_raw AS BLOB)) >= 1
       )
     ),
     new_raw TEXT CHECK (
       new_raw IS NULL OR (
         length(CAST(new_raw AS BLOB)) >= 1
       )
     ),
     old_oid TEXT CHECK (
       old_oid IS NULL OR (length(CAST(old_oid AS BLOB)) = 40 AND old_oid NOT GLOB '*[^0-9a-f]*')
     ),
     new_oid TEXT CHECK (
       new_oid IS NULL OR (length(CAST(new_oid AS BLOB)) = 40 AND new_oid NOT GLOB '*[^0-9a-f]*')
     ),
     actor_name TEXT CHECK (
       actor_name IS NULL OR (
         length(CAST(actor_name AS BLOB)) >= 1
       )
     ),
     actor_email TEXT CHECK (
       actor_email IS NULL OR (
         length(CAST(actor_email AS BLOB)) >= 1
       )
     ),
     timestamp INTEGER NOT NULL CHECK (
       timestamp >= 0
       AND timestamp <= 9007199254740991
     ),
     timezone INTEGER NOT NULL CHECK (
       timezone BETWEEN -1440 AND 1440
     ),
     reason TEXT NOT NULL CHECK (
       length(CAST(reason AS BLOB)) >= 1
     ),
     PRIMARY KEY (checkout_id, ordinal),
     CHECK ((actor_name IS NULL) = (actor_email IS NULL)),
     CHECK (
       (old_raw IS NULL AND old_oid IS NULL)
       OR (old_raw IS NOT NULL AND length(CAST(old_raw AS BLOB)) = 40 AND old_raw NOT GLOB '*[^0-9a-f]*' AND old_oid IS old_raw)
       OR (old_raw IS NOT NULL
         AND substr(old_raw, 1, 5) = 'ref: '
         AND length(CAST(old_raw AS BLOB)) > 5
         AND substr(old_raw, 6) != 'HEAD'
         AND substr(old_raw, 6, 5) != 'ref: '
         AND instr(old_raw, char(0)) = 0
         AND instr(old_raw, char(10)) = 0
         AND instr(old_raw, char(13)) = 0)
     ),
     CHECK (
       (new_raw IS NULL AND new_oid IS NULL)
       OR (new_raw IS NOT NULL AND length(CAST(new_raw AS BLOB)) = 40 AND new_raw NOT GLOB '*[^0-9a-f]*' AND new_oid IS new_raw)
       OR (new_raw IS NOT NULL
         AND substr(new_raw, 1, 5) = 'ref: '
         AND length(CAST(new_raw AS BLOB)) > 5
         AND substr(new_raw, 6) != 'HEAD'
         AND substr(new_raw, 6, 5) != 'ref: '
         AND instr(new_raw, char(0)) = 0
         AND instr(new_raw, char(10)) = 0
         AND instr(new_raw, char(13)) = 0)
     ),
     FOREIGN KEY (checkout_id, repo_id)
       REFERENCES git_checkouts (id, repo_id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id) REFERENCES git_reflog_state (repo_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_config (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL CHECK (
       length(CAST(path AS BLOB)) BETWEEN 1 AND 8192
       AND instr(path, char(0)) = 0
       AND instr(path, char(10)) = 0
       AND instr(path, char(13)) = 0
     ),
     seq INTEGER NOT NULL CHECK (seq >= 0),
     value TEXT NOT NULL,
     PRIMARY KEY (repo_id, path, seq),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_promisor_remotes (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     remote_name TEXT NOT NULL CHECK (
       length(CAST(remote_name AS BLOB)) BETWEEN 1 AND 8192
       AND instr(remote_name, char(0)) = 0
     ),
     url TEXT NOT NULL CHECK (
       length(CAST(url AS BLOB)) BETWEEN 1 AND 1500000
       AND instr(url, char(0)) = 0
     ),
     filter TEXT NOT NULL CHECK (filter = 'blob:none'),
     PRIMARY KEY (repo_id, remote_name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_promised_blobs (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     oid TEXT NOT NULL CHECK (
       length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     remote_name TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type = 'blob'),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, remote_name)
       REFERENCES git_promisor_remotes (repo_id, remote_name) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_integration_workspaces (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0), PRIMARY KEY (repo_id, workspace_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_integration_plans (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0), plan_id INTEGER NOT NULL CHECK (
  plan_id BETWEEN 0 AND 9007199254740991
),
     kind TEXT NOT NULL CHECK (kind IN ('structural', 'resolved', 'projected')),
     source_rows INTEGER NOT NULL CHECK (
       source_rows BETWEEN 0 AND 9007199254740991
     ),
     entry_count INTEGER NOT NULL CHECK (
       entry_count BETWEEN 0 AND 9007199254740991
     ),
     PRIMARY KEY (repo_id, workspace_id, plan_id), FOREIGN KEY (repo_id, workspace_id)
  REFERENCES git_integration_workspaces (repo_id, workspace_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_integration_plan_entries (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0), plan_id INTEGER NOT NULL CHECK (
  plan_id BETWEEN 0 AND 9007199254740991
), path TEXT NOT NULL COLLATE BINARY CHECK (
  length(CAST(path AS BLOB)) > 0
),
     descriptor TEXT NOT NULL CHECK (
       json_valid(descriptor) AND json_type(descriptor) = 'object'
     ),
     PRIMARY KEY (repo_id, workspace_id, plan_id, path), FOREIGN KEY (repo_id, workspace_id, plan_id)
  REFERENCES git_integration_plans (repo_id, workspace_id, plan_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_integration_reservations (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0), plan_id INTEGER NOT NULL CHECK (
  plan_id BETWEEN 0 AND 9007199254740991
),
     family TEXT NOT NULL CHECK (length(family) > 0),
     path TEXT NOT NULL COLLATE BINARY CHECK (
  length(CAST(path AS BLOB)) > 0
),
     descriptor TEXT NOT NULL CHECK (
       json_valid(descriptor) AND json_type(descriptor) = 'object'
     ),
     PRIMARY KEY (repo_id, workspace_id, plan_id, family, path), FOREIGN KEY (repo_id, workspace_id, plan_id)
  REFERENCES git_integration_plans (repo_id, workspace_id, plan_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_integration_touched (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0), plan_id INTEGER NOT NULL CHECK (
  plan_id BETWEEN 0 AND 9007199254740991
),
     ordinal INTEGER NOT NULL CHECK (
       ordinal BETWEEN 0 AND 9007199254740991
     ),
     path TEXT NOT NULL COLLATE BINARY CHECK (
  length(CAST(path AS BLOB)) > 0
),
     logical_path TEXT NOT NULL COLLATE BINARY CHECK (
       length(CAST(logical_path AS BLOB)) > 0
     ),
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
     worktree_kind TEXT CHECK (worktree_kind IN ('absent', 'file', 'symlink', 'directory')),
     worktree_mode INTEGER,
     worktree_oid TEXT,
     worktree_revision INTEGER,
     PRIMARY KEY (repo_id, workspace_id, plan_id, ordinal),
     UNIQUE (repo_id, workspace_id, plan_id, path),
     CHECK (
       (index_stage IS NULL AND index_mode IS NULL AND index_oid IS NULL
          AND index_size IS NULL AND index_mtime IS NULL AND index_ino IS NULL AND index_rev IS NULL)
       OR (index_stage = 0 AND index_mode IS NOT NULL AND index_oid IS NOT NULL)
     ),
     CHECK (
       (worktree_kind IS NULL AND worktree_mode IS NULL AND worktree_oid IS NULL
          AND worktree_revision IS NULL)
       OR (worktree_kind = 'absent' AND worktree_mode IS NULL AND worktree_oid IS NULL
          AND worktree_revision IS NULL)
       OR (worktree_kind IN ('file', 'symlink') AND worktree_mode IS NOT NULL
          AND worktree_oid IS NOT NULL AND worktree_revision IS NOT NULL)
       OR (worktree_kind = 'directory' AND worktree_mode IS NOT NULL
          AND worktree_oid IS NULL AND worktree_revision IS NOT NULL)
     ),
     FOREIGN KEY (repo_id, workspace_id, plan_id)
  REFERENCES git_integration_plans (repo_id, workspace_id, plan_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_index (
     checkout_id INTEGER NOT NULL,
     path TEXT NOT NULL CHECK (
       length(CAST(path AS BLOB)) BETWEEN 1 AND 8192
     ),
     stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 3),
     mode INTEGER NOT NULL CHECK (
       mode IN (33188, 33261, 40960, 57344)
     ),
     oid TEXT NOT NULL CHECK (
       length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     size INTEGER CHECK (size IS NULL OR size >= 0),
     mtime INTEGER CHECK (mtime IS NULL OR mtime >= 0),
     ino INTEGER CHECK (ino IS NULL OR ino >= 0),
     rev INTEGER CHECK (rev IS NULL OR rev >= 0),
     PRIMARY KEY (checkout_id, path, stage),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_scratch_indexes (
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND 9007199254740991
     ),
     name TEXT NOT NULL CHECK (
       length(CAST(name AS BLOB)) BETWEEN 1 AND 255
       AND instr(name, char(0)) = 0
     ),
     PRIMARY KEY (repo_id, name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_scratch_index_entries (
     repo_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     path TEXT NOT NULL CHECK (
       length(CAST(path AS BLOB)) BETWEEN 1 AND 8192
     ),
     stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 3),
     mode INTEGER NOT NULL CHECK (
       mode IN (33188, 33261, 40960, 57344)
     ),
     oid TEXT NOT NULL CHECK (
       length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     size INTEGER CHECK (size IS NULL OR size >= 0),
     mtime INTEGER CHECK (mtime IS NULL OR mtime >= 0),
     ino INTEGER CHECK (ino IS NULL OR ino >= 0),
     rev INTEGER CHECK (rev IS NULL OR rev >= 0),
     PRIMARY KEY (repo_id, name, path, stage),
     FOREIGN KEY (repo_id, name) REFERENCES git_scratch_indexes (repo_id, name)
       ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_index_state (
     checkout_id INTEGER PRIMARY KEY,
     baseline_tree_oid TEXT,
     format INTEGER NOT NULL CHECK (format = 1),
     complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_index_dirty (
     checkout_id INTEGER NOT NULL,
     path TEXT NOT NULL,
     flags INTEGER NOT NULL CHECK (flags IN (1, 2, 3)),
     PRIMARY KEY (checkout_id, path),
     FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_operation_state (
  checkout_id INTEGER PRIMARY KEY CHECK (
    checkout_id BETWEEN 1 AND 9007199254740991
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
       AND current_step >= 0
       AND step_count >= 1
       AND current_step <= step_count
       AND replayed_count >= 0
       AND skipped_count >= 0
       AND replayed_count + skipped_count = current_step
       AND (phase != 'conflicted' OR current_step < step_count))
  ),
  CHECK ((author_name IS NULL) = (author_email IS NULL)),
  CHECK ((committer_name IS NULL) = (committer_email IS NULL)),
  FOREIGN KEY (checkout_id) REFERENCES git_checkouts (id) ON DELETE CASCADE
) STRICT;
CREATE TABLE git_operation_steps (
  checkout_id INTEGER NOT NULL CHECK (
    checkout_id BETWEEN 1 AND 9007199254740991
  ),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_oid TEXT NOT NULL,
  selected_parent_oid TEXT,
  mainline INTEGER CHECK (mainline IS NULL OR mainline >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'skipped')),
  result_oid TEXT,
  PRIMARY KEY (checkout_id, ordinal),
  CHECK ((outcome = 'applied' AND result_oid IS NOT NULL)
      OR (outcome IN ('pending', 'skipped') AND result_oid IS NULL)),
  CHECK (mainline IS NULL OR selected_parent_oid IS NOT NULL),
  FOREIGN KEY (checkout_id) REFERENCES git_operation_state (checkout_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE git_operation_touched (
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
) STRICT, WITHOUT ROWID;
CREATE TABLE git_blob_ids (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     content_id BLOB NOT NULL,
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     generation INTEGER NOT NULL CHECK (generation >= 1),
     PRIMARY KEY (repo_id, content_id),
     FOREIGN KEY (repo_id) REFERENCES git_blob_id_state (repo_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_blob_id_state (
     repo_id INTEGER PRIMARY KEY CHECK (repo_id >= 1),
     generation INTEGER NOT NULL CHECK (generation >= 0),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_shallow (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL CHECK (
       length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_objects (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     type TEXT NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       size BETWEEN 0 AND 50331648
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_commits (
  
  repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
  parents TEXT NOT NULL CHECK (
    json_valid(parents) AND json_type(parents) = 'array'
  ),
  tree TEXT NOT NULL CHECK (length(CAST(tree AS BLOB)) = 40),
  author_name BLOB NOT NULL,
  author_email BLOB NOT NULL,
  author_time INTEGER NOT NULL,
  author_timezone INTEGER NOT NULL,
  committer_name BLOB NOT NULL,
  committer_email BLOB NOT NULL,
  committer_time INTEGER NOT NULL,
  committer_timezone INTEGER NOT NULL,
  message BLOB,
  gpgsig BLOB CHECK (gpgsig IS NULL OR message IS NOT NULL),
  object_size INTEGER NOT NULL CHECK (object_size >= 0),
  PRIMARY KEY (repo_id, oid),
  FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE git_pack_commit_staging (
     
  repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
  parents TEXT NOT NULL CHECK (
    json_valid(parents) AND json_type(parents) = 'array'
  ),
  tree TEXT NOT NULL CHECK (length(CAST(tree AS BLOB)) = 40),
  author_name BLOB NOT NULL,
  author_email BLOB NOT NULL,
  author_time INTEGER NOT NULL,
  author_timezone INTEGER NOT NULL,
  committer_name BLOB NOT NULL,
  committer_email BLOB NOT NULL,
  committer_time INTEGER NOT NULL,
  committer_timezone INTEGER NOT NULL,
  message BLOB,
  gpgsig BLOB CHECK (gpgsig IS NULL OR message IS NOT NULL),
  object_size INTEGER NOT NULL CHECK (object_size >= 0),
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     PRIMARY KEY (repo_id, pack_id, oid),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_object_chunks (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_pack_meta (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     size INTEGER NOT NULL CHECK (size >= 0),
     count INTEGER NOT NULL CHECK (count >= 0),
     state TEXT NOT NULL CHECK (state IN ('pending','complete')),
     created INTEGER NOT NULL CHECK (created >= 0),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_pack_ingest_control (
     repo_id INTEGER PRIMARY KEY CHECK (
       repo_id BETWEEN 1 AND 9007199254740991
     ),
     owner_generation INTEGER NOT NULL CHECK (
       owner_generation BETWEEN 0 AND 9007199254740991
     ),
     last_pack_id INTEGER NOT NULL CHECK (
       last_pack_id BETWEEN 0 AND 9007199254740991
     ),
     active_pack_id INTEGER CHECK (
       active_pack_id IS NULL OR (
         active_pack_id BETWEEN 0 AND 9007199254740991
         AND active_pack_id <= last_pack_id
       )
     ),
     expires_ms INTEGER CHECK (
       expires_ms IS NULL OR (
         expires_ms BETWEEN 0 AND 9007199254740991
       )
     ),
     CHECK ((active_pack_id IS NULL) = (expires_ms IS NULL)),
     CHECK (active_pack_id IS NULL OR owner_generation >= 1),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id, active_pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id)
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_pack_data (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_pack_entries (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     offset INTEGER NOT NULL CHECK (offset >= 0),
     data_off INTEGER NOT NULL CHECK (data_off >= 0),
     data_len INTEGER NOT NULL CHECK (data_len >= 0),
     type TEXT NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       size BETWEEN 0 AND 50331648
     ),
     entry_size INTEGER NOT NULL CHECK (entry_size >= 0),
     base_offset INTEGER CHECK (
       base_offset IS NULL OR (
         base_offset >= 0 AND base_offset != offset
       )
     ),
     PRIMARY KEY (repo_id, pack_id, offset),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_pack_pending (
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
   ) STRICT;
CREATE TABLE git_tree_sources (
     source_key INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     tree_oid TEXT NOT NULL CHECK (
       length(CAST(tree_oid AS BLOB)) = 40
     ),
     complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
     object_size INTEGER NOT NULL CHECK (object_size >= 0),
     entry_count INTEGER CHECK (
       (complete = 0 AND entry_count IS NULL) OR
       (complete = 1 AND entry_count IS NOT NULL AND entry_count >= 0)
     ),
     base_cost INTEGER CHECK (
       (complete = 0 AND base_cost IS NULL) OR
       (complete = 1 AND base_cost IS NOT NULL AND base_cost >= 0)
     ),
     UNIQUE (repo_id, tree_oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_tree_entries (
     source_key INTEGER NOT NULL CHECK (source_key >= 1),
     ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
     mode TEXT NOT NULL CHECK (
       mode IN ('40000','040000','100644','100755','120000','160000')
     ),
     name_bytes BLOB NOT NULL CHECK (
       length(name_bytes) >= 1
     ),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     cumulative_base INTEGER NOT NULL CHECK (
       cumulative_base >= 0
     ),
     PRIMARY KEY (source_key, ordinal),
     FOREIGN KEY (source_key)
       REFERENCES git_tree_sources (source_key)
       ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_maintenance_control (
     repo_id INTEGER PRIMARY KEY CHECK (repo_id >= 1),
     root_epoch INTEGER NOT NULL CHECK (
       root_epoch BETWEEN 0 AND 9007199254740991
     ),
     next_run_id INTEGER NOT NULL CHECK (
       next_run_id BETWEEN 1 AND 9007199254740991
     ),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_maintenance_runs (
     repo_id INTEGER PRIMARY KEY CHECK (repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       run_id BETWEEN 1 AND 9007199254740991
     ),
     observed_root_epoch INTEGER NOT NULL CHECK (
       observed_root_epoch BETWEEN 0 AND 9007199254740991
     ),
     observed_source_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       observed_source_generation BETWEEN 0 AND 9007199254740991
     ),
     phase TEXT NOT NULL CHECK (phase IN (
       'roots', 'mark', 'loose', 'packs', 'finish'
     )),
     started_ms INTEGER NOT NULL CHECK (
       started_ms BETWEEN 0 AND 9007199254740991
     ),
     root_source TEXT NOT NULL CHECK (root_source IN (
       'refs', 'heads', 'reflogs', 'index', 'index-baseline', 'shallow', 'operations', 'done'
     )),
     cursor_checkout_id INTEGER CHECK (
       cursor_checkout_id IS NULL OR (
         cursor_checkout_id BETWEEN 1 AND 9007199254740991
       )
     ),
     cursor_text TEXT CHECK (
       cursor_text IS NULL OR (
         instr(cursor_text, char(0)) = 0
       )
     ),
     cursor_ordinal INTEGER CHECK (
       cursor_ordinal IS NULL OR (
         cursor_ordinal BETWEEN 0 AND 9007199254740991
       )
     ),
     reachable_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       reachable_objects BETWEEN 0 AND 9007199254740991
     ),
     queued_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       queued_objects BETWEEN 0 AND 9007199254740991
     ),
     reclaimed_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       reclaimed_objects BETWEEN 0 AND 9007199254740991
     ),
     reclaimed_packs INTEGER NOT NULL DEFAULT 0 CHECK (
       reclaimed_packs BETWEEN 0 AND 9007199254740991
     ),
     reclaimed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
       reclaimed_bytes BETWEEN 0 AND 9007199254740991
     ),
     next_eligible_ms INTEGER CHECK (
       next_eligible_ms IS NULL OR (
         next_eligible_ms BETWEEN 0 AND 9007199254740991
       )
     ),
     restarted INTEGER NOT NULL DEFAULT 0 CHECK (
       restarted IN (0, 1)
     ),
     UNIQUE (repo_id, run_id),
     FOREIGN KEY (repo_id) REFERENCES git_maintenance_control (repo_id) ON DELETE CASCADE
   ) STRICT;
CREATE TABLE git_maintenance_objects (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       run_id BETWEEN 1 AND 9007199254740991
     ),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     source_mask INTEGER NOT NULL CHECK (
       source_mask BETWEEN 0 AND 9007199254740991
     ),
     expanded INTEGER NOT NULL CHECK (expanded IN (0, 1)),
     shallow_boundary INTEGER NOT NULL CHECK (
       shallow_boundary IN (0, 1)
     ),
     edge_cursor INTEGER NOT NULL CHECK (
       edge_cursor BETWEEN 0 AND 9007199254740991
     ),
     -- Byte offset of entry edge_cursor in a tree expanded from its object bytes.
     edge_offset INTEGER CHECK (
       edge_offset IS NULL OR edge_offset BETWEEN 0 AND 9007199254740991
     ),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_loose_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       unreachable_since_ms BETWEEN 0 AND 9007199254740991
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
CREATE TABLE git_pack_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (
       pack_id BETWEEN 0 AND 9007199254740991
     ),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       unreachable_since_ms BETWEEN 0 AND 9007199254740991
     ),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID;
INSERT INTO fs_meta (k, v) VALUES ('rev', 5);
INSERT INTO fs_meta (k, v) VALUES ('next_inode', 5);
INSERT INTO fs_meta (k, v) VALUES ('schema_version', 2);
INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target, content_id) VALUES (1, 'dir', 493, 1577836800000, 0, 0, 1, NULL, NULL);
INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target, content_id) VALUES (3, 'dir', 493, 1577836800000, 0, 3, 1, NULL, NULL);
INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target, content_id) VALUES (4, 'file', 420, 1577836800000, 4, 5, 1, NULL, NULL);
INSERT INTO fs_paths (path, parent, inode) VALUES ('/', '', 1);
INSERT INTO fs_paths (path, parent, inode) VALUES ('/work', '/', 3);
INSERT INTO fs_paths (path, parent, inode) VALUES ('/work/a.txt', '/work', 4);
INSERT INTO fs_subtree_revs (path, rev, replaced_rev) VALUES ('/', 5, 0);
INSERT INTO fs_subtree_revs (path, rev, replaced_rev) VALUES ('/gone', 2, 2);
INSERT INTO fs_subtree_revs (path, rev, replaced_rev) VALUES ('/work', 5, 0);
INSERT INTO fs_chunks (inode, idx, bytes) VALUES (4, 0, X'74776f0a');
INSERT INTO git_meta (key, value) VALUES ('schema_version', '1');
INSERT INTO git_repositories (id, lifecycle, clone_expires_ms, fetch_generation, shallow_revision, checkout_revision, source_generation) VALUES (1, 'ready', NULL, 0, 0, 1, 0);
INSERT INTO git_repositories (id, lifecycle, clone_expires_ms, fetch_generation, shallow_revision, checkout_revision, source_generation) VALUES (2, 'ready', NULL, 0, 0, 1, 4);
INSERT INTO git_checkouts (id, repo_id, root, head, is_primary) VALUES (1, 1, '/gone', 'ref: refs/heads/main', 1);
INSERT INTO git_checkouts (id, repo_id, root, head, is_primary) VALUES (2, 2, '/work', 'ref: refs/heads/main', 1);
INSERT INTO git_refs (repo_id, name, target) VALUES (2, 'refs/heads/main', '44ea2954f2a0f29a4ce6dd366fa050f666b9f508');
INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (1, 0);
INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (2, 4);
INSERT INTO git_reflog_entries (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid, actor_name, actor_email, timestamp, timezone, reason) VALUES (2, 'refs/heads/main', 1, NULL, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', NULL, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', 'Fixture', 'fixture@example.com', 1577836800, 0, 'commit (initial)');
INSERT INTO git_reflog_entries (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid, actor_name, actor_email, timestamp, timezone, reason) VALUES (2, 'refs/heads/main', 3, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', 'Fixture', 'fixture@example.com', 1577836800, 0, 'commit');
INSERT INTO git_checkout_reflog_entries (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid, actor_name, actor_email, timestamp, timezone, reason) VALUES (2, 2, 2, 'ref: refs/heads/main', 'ref: refs/heads/main', NULL, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', 'Fixture', 'fixture@example.com', 1577836800, 0, 'commit (initial)');
INSERT INTO git_checkout_reflog_entries (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid, actor_name, actor_email, timestamp, timezone, reason) VALUES (2, 2, 4, 'ref: refs/heads/main', 'ref: refs/heads/main', '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', 'Fixture', 'fixture@example.com', 1577836800, 0, 'commit');
INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev) VALUES (2, 'a.txt', 0, 33188, 'f719efd430d52bcfc8566a43b2eb655688d38871', 4, 1577836800000, 4, 5);
INSERT INTO git_index_state (checkout_id, baseline_tree_oid, format, complete) VALUES (1, NULL, 1, 0);
INSERT INTO git_index_state (checkout_id, baseline_tree_oid, format, complete) VALUES (2, NULL, 1, 0);
INSERT INTO git_objects (repo_id, oid, type, size) VALUES (2, '5626abf0f72e58d7a153368ba57db4c673c0e171', 'blob', 4);
INSERT INTO git_objects (repo_id, oid, type, size) VALUES (2, '20e50a07feffafe7699bf38ff4027a606f406eaa', 'tree', 33);
INSERT INTO git_objects (repo_id, oid, type, size) VALUES (2, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', 'commit', 163);
INSERT INTO git_objects (repo_id, oid, type, size) VALUES (2, 'f719efd430d52bcfc8566a43b2eb655688d38871', 'blob', 4);
INSERT INTO git_objects (repo_id, oid, type, size) VALUES (2, '313eba2d168cdf6ede5f9caa87c9f1b5f7c3d304', 'tree', 33);
INSERT INTO git_objects (repo_id, oid, type, size) VALUES (2, '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', 'commit', 213);
INSERT INTO git_commits (repo_id, oid, parents, tree, author_name, author_email, author_time, author_timezone, committer_name, committer_email, committer_time, committer_timezone, message, gpgsig, object_size) VALUES (2, '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', '["8e00ae6864251f6fe20cd19bc89eaf7a62d4276e"]', '313eba2d168cdf6ede5f9caa87c9f1b5f7c3d304', X'46697874757265', X'66697874757265406578616d706c652e636f6d', 1577836800, 0, X'46697874757265', X'66697874757265406578616d706c652e636f6d', 1577836800, 0, X'7365636f6e640a', NULL, 213);
INSERT INTO git_commits (repo_id, oid, parents, tree, author_name, author_email, author_time, author_timezone, committer_name, committer_email, committer_time, committer_timezone, message, gpgsig, object_size) VALUES (2, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', '[]', '20e50a07feffafe7699bf38ff4027a606f406eaa', X'46697874757265', X'66697874757265406578616d706c652e636f6d', 1577836800, 0, X'46697874757265', X'66697874757265406578616d706c652e636f6d', 1577836800, 0, X'626173650a', NULL, 163);
INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (2, '5626abf0f72e58d7a153368ba57db4c673c0e171', 0, X'789ccbcf4be5020003de014d');
INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (2, '20e50a07feffafe7699bf38ff4027a606f406eaa', 0, X'789c3334303033315148d42ba9286108535bfde1bb5ec4f585c166dd4b6bb71c2b3ef0b01000c5e30e80');
INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (2, '8e00ae6864251f6fe20cd19bc89eaf7a62d4276e', 0, X'789c95cb4d0ac2301006d07d4e91bd209ffd994941c455ef312ddf60c1108929f4f82e3c41776ff35a2563078e30a8d3dd9c2ad3b4789fdc07746a02f10142b3607b7b951ae7ed687b65bcfb1f4f1e963f6f5ed7921ff136aaa65e12102f0010d692f3d61a4fc7b0d897e1078df5327d');
INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (2, 'f719efd430d52bcfc8566a43b2eb655688d38871', 0, X'789c2b29cfe7020004210165');
INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (2, '313eba2d168cdf6ede5f9caa87c9f1b5f7c3d304', 0, X'789c3334303033315148d42ba92861f82ef9fe8ac155edf327c2b29c37bd4e0debb8dc510800cf970e88');
INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (2, '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', 0, X'789c95cb410ac3201000c0bbaff05e28abc655a1949efa8fcdba4b033509d6409edf435fd0db5c6674111b5c90997c7598b92a4a95a8858972e2a26e8e9a38d40093d9a9cb3a6c160012cc38f9e814553c707565e65c843411fa3af98462e818afaddbe7728ea38bbde90f0f39a9ed6fb9f2d6eed6c59472c00c602f000086b7d69631e4ef683ec2db5acd1797cd419c');
INSERT INTO git_pack_ingest_control (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms) VALUES (1, 0, 0, NULL, NULL);
INSERT INTO git_pack_ingest_control (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms) VALUES (2, 0, 0, NULL, NULL);
INSERT INTO git_tree_sources (source_key, repo_id, tree_oid, complete, object_size, entry_count, base_cost) VALUES (1, 2, '20e50a07feffafe7699bf38ff4027a606f406eaa', 1, 33, 1, 243);
INSERT INTO git_tree_sources (source_key, repo_id, tree_oid, complete, object_size, entry_count, base_cost) VALUES (2, 2, '313eba2d168cdf6ede5f9caa87c9f1b5f7c3d304', 1, 33, 1, 243);
INSERT INTO git_tree_entries (source_key, ordinal, mode, name_bytes, oid, cumulative_base) VALUES (1, 0, '100644', X'612e747874', '5626abf0f72e58d7a153368ba57db4c673c0e171', 243);
INSERT INTO git_tree_entries (source_key, ordinal, mode, name_bytes, oid, cumulative_base) VALUES (2, 0, '100644', X'612e747874', 'f719efd430d52bcfc8566a43b2eb655688d38871', 243);
INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id) VALUES (2, 4, 2);
INSERT INTO git_maintenance_runs (repo_id, run_id, observed_root_epoch, observed_source_generation, phase, started_ms, root_source, cursor_checkout_id, cursor_text, cursor_ordinal, reachable_objects, queued_objects, reclaimed_objects, reclaimed_packs, reclaimed_bytes, next_eligible_ms, restarted) VALUES (2, 1, 4, 4, 'roots', 1577836800000, 'heads', NULL, NULL, NULL, 0, 0, 0, 0, 0, NULL, 0);
INSERT INTO git_maintenance_objects (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, edge_cursor, edge_offset) VALUES (2, 1, '44ea2954f2a0f29a4ce6dd366fa050f666b9f508', 1, 0, 0, 0, NULL);
UPDATE sqlite_sequence SET seq = 3 WHERE name = 'git_checkouts';
UPDATE sqlite_sequence SET seq = 3 WHERE name = 'git_repositories';
CREATE INDEX fs_paths_by_parent ON fs_paths(parent, path);
CREATE INDEX fs_paths_by_inode ON fs_paths(inode);
CREATE UNIQUE INDEX git_checkouts_primary
     ON git_checkouts (repo_id) WHERE is_primary = 1;
CREATE UNIQUE INDEX git_checkouts_attached_branch
     ON git_checkouts (repo_id, head)
     WHERE substr(head, 1, 16) = 'ref: refs/heads/'
       AND length(CAST(head AS BLOB)) > 16;
CREATE TRIGGER git_checkouts_identity_immutable
     BEFORE UPDATE OF id, repo_id, root, is_primary ON git_checkouts
     BEGIN
       SELECT RAISE(ABORT, 'checkout identity is immutable');
     END;
CREATE INDEX git_reflog_entries_by_ref
     ON git_reflog_entries (repo_id, ref_name, ordinal DESC);
CREATE INDEX git_reflog_entries_by_timestamp
     ON git_reflog_entries (repo_id, timestamp, ordinal);
CREATE INDEX git_checkout_reflog_entries_by_ordinal
     ON git_checkout_reflog_entries (repo_id, ordinal);
CREATE INDEX git_checkout_reflog_entries_by_timestamp
     ON git_checkout_reflog_entries (repo_id, timestamp, ordinal);
CREATE INDEX git_blob_ids_by_generation
     ON git_blob_ids (repo_id, generation);
CREATE VIEW git_blob_id_updates
     (repo_id, content_id, oid, operation, ordinal) AS
   SELECT repo_id, content_id, oid, 'mapping', 0 FROM git_blob_ids WHERE false;
CREATE TRIGGER git_blob_id_updates_begin
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
       WHERE generation < 9007199254740991;
     SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'blob id cache generation is exhausted') END;
   END;
CREATE TRIGGER git_blob_id_updates_mapping
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
   END;
CREATE TRIGGER git_blob_id_updates_finish
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
        ) WHERE retained_rows > 65536
      );
   END;
CREATE TRIGGER git_blob_id_updates_invalid
   INSTEAD OF INSERT ON git_blob_id_updates
   WHEN NEW.operation IS NULL OR NEW.operation NOT IN ('begin', 'mapping', 'finish')
   BEGIN
     SELECT RAISE(ABORT, 'invalid blob id cache operation');
   END;
CREATE TRIGGER git_promised_blobs_loose_present
   AFTER INSERT ON git_objects
   BEGIN
     DELETE FROM git_promised_blobs
      WHERE repo_id = NEW.repo_id AND oid = NEW.oid;
   END;
CREATE INDEX git_pack_entries_by_oid
     ON git_pack_entries (repo_id, oid, pack_id, offset);
CREATE INDEX git_tree_entries_by_name_bytes
     ON git_tree_entries (source_key, name_bytes);
CREATE TRIGGER git_tree_sources_loose_insert
   AFTER INSERT ON git_objects WHEN NEW.type = 'tree'
   BEGIN
     INSERT INTO git_tree_sources
       (repo_id, tree_oid, complete, object_size, entry_count, base_cost)
     VALUES (NEW.repo_id, NEW.oid, 0, NEW.size, NULL, NULL)
     ON CONFLICT(repo_id, tree_oid) DO NOTHING;
   END;
CREATE TRIGGER git_tree_sources_loose_delete
   AFTER DELETE ON git_objects WHEN OLD.type = 'tree'
   BEGIN
     DELETE FROM git_tree_sources
      WHERE repo_id = OLD.repo_id AND tree_oid = OLD.oid
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_entries packed
           WHERE packed.repo_id = OLD.repo_id AND packed.oid = OLD.oid
        );
   END;
CREATE INDEX git_maintenance_objects_queue
     ON git_maintenance_objects (repo_id, run_id, expanded, oid);
CREATE TRIGGER index_tracker_index_insert
   AFTER INSERT ON git_index WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT NEW.checkout_id AS checkout_id WHERE typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT NEW.checkout_id AS checkout_id WHERE typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = NEW.checkout_id AND complete = 1 AND (typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..');
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT NEW.checkout_id, NEW.path, 3
           WHERE NOT (typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..')
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = NEW.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_index_delete
   AFTER DELETE ON git_index WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT OLD.checkout_id AS checkout_id WHERE typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT OLD.checkout_id AS checkout_id WHERE typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = OLD.checkout_id AND complete = 1 AND (typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..');
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT OLD.checkout_id, OLD.path, 3
           WHERE NOT (typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..')
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = OLD.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_index_update_semantic
   AFTER UPDATE ON git_index WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1) AND (OLD.checkout_id IS NOT NEW.checkout_id
  OR OLD.path IS NOT NEW.path
  OR OLD.stage IS NOT NEW.stage
  OR OLD.mode IS NOT NEW.mode
  OR OLD.oid IS NOT NEW.oid)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT OLD.checkout_id AS checkout_id WHERE typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT OLD.checkout_id AS checkout_id WHERE typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = OLD.checkout_id AND complete = 1 AND (typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..');
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT OLD.checkout_id, OLD.path, 3
           WHERE NOT (typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..')
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = OLD.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT NEW.checkout_id AS checkout_id WHERE typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT NEW.checkout_id AS checkout_id WHERE typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = NEW.checkout_id AND complete = 1 AND (typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..');
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT NEW.checkout_id, NEW.path, 3
           WHERE NOT (typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..')
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = NEW.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_index_update_stat
   AFTER UPDATE ON git_index
   WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1) AND NOT (OLD.checkout_id IS NOT NEW.checkout_id
  OR OLD.path IS NOT NEW.path
  OR OLD.stage IS NOT NEW.stage
  OR OLD.mode IS NOT NEW.mode
  OR OLD.oid IS NOT NEW.oid) AND (OLD.size IS NOT NEW.size
  OR OLD.mtime IS NOT NEW.mtime
  OR OLD.ino IS NOT NEW.ino
  OR OLD.rev IS NOT NEW.rev)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT OLD.checkout_id AS checkout_id WHERE typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT OLD.checkout_id AS checkout_id WHERE typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = OLD.checkout_id AND complete = 1 AND (typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..');
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT OLD.checkout_id, OLD.path, 2
           WHERE NOT (typeof(OLD.path) <> 'text'
    OR OLD.path = ''
    OR substr(OLD.path, 1, 1) = '/'
    OR substr(OLD.path, -1) = '/'
    OR instr(OLD.path, char(0)) > 0
    OR instr(OLD.path, '//') > 0
    OR OLD.path = '.' OR OLD.path = '..'
    OR substr(OLD.path, 1, 2) = './'
    OR substr(OLD.path, 1, 3) = '../'
    OR instr(OLD.path, '/./') > 0
    OR instr(OLD.path, '/../') > 0
    OR substr(OLD.path, -2) = '/.'
    OR substr(OLD.path, -3) = '/..')
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = OLD.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT NEW.checkout_id AS checkout_id WHERE typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT NEW.checkout_id AS checkout_id WHERE typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = NEW.checkout_id AND complete = 1 AND (typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..');
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT NEW.checkout_id, NEW.path, 2
           WHERE NOT (typeof(NEW.path) <> 'text'
    OR NEW.path = ''
    OR substr(NEW.path, 1, 1) = '/'
    OR substr(NEW.path, -1) = '/'
    OR instr(NEW.path, char(0)) > 0
    OR instr(NEW.path, '//') > 0
    OR NEW.path = '.' OR NEW.path = '..'
    OR substr(NEW.path, 1, 2) = './'
    OR substr(NEW.path, 1, 3) = '../'
    OR instr(NEW.path, '/./') > 0
    OR instr(NEW.path, '/../') > 0
    OR substr(NEW.path, -2) = '/.'
    OR substr(NEW.path, -3) = '/..')
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = NEW.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_paths_insert
   AFTER INSERT ON fs_paths WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_paths_delete
   AFTER DELETE ON fs_paths WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_paths_update
   AFTER UPDATE ON fs_paths WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path UNION ALL SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path UNION ALL SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path UNION ALL SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT OLD.path AS path UNION ALL SELECT NEW.path AS path) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_nodes_insert
   AFTER INSERT ON fs_nodes WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_nodes_delete
   AFTER DELETE ON fs_nodes WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_nodes_update
   AFTER UPDATE ON fs_nodes WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_chunks_insert
   AFTER INSERT ON fs_chunks WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_chunks_delete
   AFTER DELETE ON fs_chunks WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_chunks_update
   AFTER UPDATE ON fs_chunks WHEN EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)
   BEGIN
     SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = 9007199254740991
          ) THEN RAISE(ABORT, 'maintenance root epoch is exhausted') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore') affected ON affected.checkout_id = checkout.id) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               SELECT checkout_id FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners WHERE (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, 2
            FROM (SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )) owners
           WHERE NOT (typeof(relative) <> 'text'
    OR relative = ''
    OR substr(relative, 1, 1) = '/'
    OR substr(relative, -1) = '/'
    OR instr(relative, char(0)) > 0
    OR instr(relative, '//') > 0
    OR relative = '.' OR relative = '..'
    OR substr(relative, 1, 2) = './'
    OR substr(relative, 1, 3) = '../'
    OR instr(relative, '/./') > 0
    OR instr(relative, '/../') > 0
    OR substr(relative, -2) = '/.'
    OR substr(relative, -3) = '/..')
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;
   END;
CREATE TRIGGER index_tracker_checkout_insert
   AFTER INSERT ON git_checkouts
   BEGIN
     INSERT OR IGNORE INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
     VALUES (NEW.id, NULL, 1, 0);
     UPDATE git_index_state
        SET complete = 0
      WHERE checkout_id = (
        SELECT ancestor.id FROM git_checkouts ancestor
         WHERE ancestor.id <> NEW.id
           AND (ancestor.root = '/'
             OR NEW.root = ancestor.root
             OR substr(NEW.root, 1, length(ancestor.root) + 1) = ancestor.root || '/')
         ORDER BY length(ancestor.root) DESC, ancestor.id DESC
         LIMIT 1
      );
   END;
CREATE TRIGGER index_tracker_checkout_delete
   AFTER DELETE ON git_checkouts
   BEGIN
     UPDATE git_index_state
        SET complete = 0
      WHERE checkout_id = (
        SELECT ancestor.id FROM git_checkouts ancestor
         WHERE ancestor.root = '/'
            OR OLD.root = ancestor.root
            OR substr(OLD.root, 1, length(ancestor.root) + 1) = ancestor.root || '/'
         ORDER BY length(ancestor.root) DESC, ancestor.id DESC
         LIMIT 1
      );
   END;
