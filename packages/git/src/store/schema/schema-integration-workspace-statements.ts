const OWNER = `repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0)`;
const OWNER_FOREIGN_KEY = `FOREIGN KEY (repo_id, workspace_id)
  REFERENCES git_integration_workspaces (repo_id, workspace_id) ON DELETE CASCADE`;
const PLAN_ID = `plan_id INTEGER NOT NULL CHECK (
  plan_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
)`;
const PLAN_FOREIGN_KEY = `FOREIGN KEY (repo_id, workspace_id, plan_id)
  REFERENCES git_integration_plans (repo_id, workspace_id, plan_id) ON DELETE CASCADE`;
const PATH = `path TEXT NOT NULL COLLATE BINARY CHECK (
  length(CAST(path AS BLOB)) > 0
)`;

export const INTEGRATION_WORKSPACE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_integration_workspaces (
     ${OWNER}, PRIMARY KEY (repo_id, workspace_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS git_integration_plans (
     ${OWNER}, ${PLAN_ID},
     kind TEXT NOT NULL CHECK (kind IN ('structural', 'resolved', 'projected')),
     source_rows INTEGER NOT NULL CHECK (
       source_rows BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     entry_count INTEGER NOT NULL CHECK (
       entry_count BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, workspace_id, plan_id), ${OWNER_FOREIGN_KEY}
   ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS git_integration_plan_entries (
     ${OWNER}, ${PLAN_ID}, ${PATH},
     descriptor TEXT NOT NULL CHECK (
       json_valid(descriptor) AND json_type(descriptor) = 'object'
     ),
     PRIMARY KEY (repo_id, workspace_id, plan_id, path), ${PLAN_FOREIGN_KEY}
   ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS git_integration_reservations (
     ${OWNER}, ${PLAN_ID},
     family TEXT NOT NULL CHECK (length(family) > 0),
     ${PATH},
     descriptor TEXT NOT NULL CHECK (
       json_valid(descriptor) AND json_type(descriptor) = 'object'
     ),
     PRIMARY KEY (repo_id, workspace_id, plan_id, family, path), ${PLAN_FOREIGN_KEY}
   ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS git_integration_touched (
     ${OWNER}, ${PLAN_ID},
     ordinal INTEGER NOT NULL CHECK (
       ordinal BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     ${PATH},
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
     ${PLAN_FOREIGN_KEY}
   ) STRICT, WITHOUT ROWID`,
];
