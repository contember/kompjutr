import { MAX_PROMISOR_REMOTE_NAME_BYTES, MAX_PROMISOR_URL_BYTES } from "../fetch/promisor.js";
import { REFLOG_SCHEMA_STATEMENTS } from "./reflog-schema.js";
import { MAX_INDEX_PATH_BYTES } from "./schema-constants.js";

export const CORE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,

  // Shared store identity. Working-tree routing belongs to git_checkouts.
  // AUTOINCREMENT never reuses a committed id: live facades and provisional clone
  // owners are keyed by repository and checkout id.
  `CREATE TABLE IF NOT EXISTS git_repositories (
     id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
       id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     lifecycle TEXT NOT NULL DEFAULT 'ready' CHECK (
       lifecycle IN ('ready', 'provisional')
     ),
     clone_expires_ms INTEGER CHECK (
       clone_expires_ms IS NULL
       OR clone_expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     fetch_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       fetch_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     shallow_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       shallow_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     checkout_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       checkout_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     source_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       source_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     CHECK (
       (lifecycle = 'ready' AND clone_expires_ms IS NULL)
       OR (lifecycle = 'provisional' AND clone_expires_ms IS NOT NULL)
     )
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS git_checkouts (
     id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
       id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
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
   ) STRICT`,

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
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS git_tracking_ref_revisions (
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     ref_name TEXT NOT NULL CHECK (
       length(CAST(ref_name AS BLOB)) >= 1
       AND substr(ref_name, 1, 13) = 'refs/remotes/'
     ),
     revision INTEGER NOT NULL CHECK (
       revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, ref_name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_fetch_namespaces (
     repo_id INTEGER NOT NULL CHECK (
       repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     tracking_prefix TEXT NOT NULL CHECK (
       length(CAST(tracking_prefix AS BLOB)) >= 1
       AND substr(tracking_prefix, 1, 13) = 'refs/remotes/'
       AND substr(tracking_prefix, -1) = '/'
     ),
     latest_generation INTEGER NOT NULL CHECK (
       latest_generation BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     revision INTEGER NOT NULL CHECK (
       revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, tracking_prefix),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  ...REFLOG_SCHEMA_STATEMENTS,

  // Dotted config path ("user.email", "remote.origin.url"). `seq` keeps
  // multi-valued keys ordered the way a config file would.
  `CREATE TABLE IF NOT EXISTS git_config (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL CHECK (
       length(CAST(path AS BLOB)) BETWEEN 1 AND ${MAX_INDEX_PATH_BYTES}
       AND instr(path, char(0)) = 0
       AND instr(path, char(10)) = 0
       AND instr(path, char(13)) = 0
     ),
     seq INTEGER NOT NULL CHECK (seq >= 0),
     value TEXT NOT NULL,
     PRIMARY KEY (repo_id, path, seq),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS git_promisor_remotes (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     remote_name TEXT NOT NULL CHECK (
       length(CAST(remote_name AS BLOB)) BETWEEN 1 AND ${MAX_PROMISOR_REMOTE_NAME_BYTES}
       AND instr(remote_name, char(0)) = 0
     ),
     url TEXT NOT NULL CHECK (
       length(CAST(url AS BLOB)) BETWEEN 1 AND ${MAX_PROMISOR_URL_BYTES}
       AND instr(url, char(0)) = 0
     ),
     filter TEXT NOT NULL CHECK (filter = 'blob:none'),
     PRIMARY KEY (repo_id, remote_name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_promised_blobs (
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
   ) STRICT, WITHOUT ROWID`,
] as const;
