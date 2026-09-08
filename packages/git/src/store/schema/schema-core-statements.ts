import { MAX_PROMISOR_REMOTE_NAME_BYTES, MAX_PROMISOR_URL_BYTES } from "../fetch/promisor.js";
import { REFLOG_SCHEMA_STATEMENTS } from "./reflog-schema.js";
import { MAX_INDEX_PATH_BYTES } from "./schema-constants.js";

export const CORE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS git_identity_control (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     last_repo_id INTEGER NOT NULL CHECK (
       typeof(last_repo_id) = 'integer'
       AND last_repo_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     last_checkout_id INTEGER NOT NULL CHECK (
       typeof(last_checkout_id) = 'integer'
       AND last_checkout_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     last_clone_generation INTEGER NOT NULL CHECK (
       typeof(last_clone_generation) = 'integer'
       AND last_clone_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     )
   )`,

  // Shared store identity. Working-tree routing belongs to git_checkouts.
  `CREATE TABLE IF NOT EXISTS git_repositories (
     id INTEGER PRIMARY KEY CHECK (
       typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     lifecycle TEXT NOT NULL DEFAULT 'ready' CHECK (
       typeof(lifecycle) = 'text' AND lifecycle IN ('ready', 'provisional')
     ),
     clone_generation INTEGER UNIQUE CHECK (
       clone_generation IS NULL
       OR (typeof(clone_generation) = 'integer'
           AND clone_generation BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER})
     ),
     clone_expires_ms INTEGER CHECK (
       clone_expires_ms IS NULL
       OR (typeof(clone_expires_ms) = 'integer'
           AND clone_expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})
     ),
     fetch_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(fetch_generation) = 'integer'
       AND fetch_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     shallow_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(shallow_revision) = 'integer'
       AND shallow_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     checkout_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(checkout_revision) = 'integer'
       AND checkout_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     CHECK (
       (lifecycle = 'ready' AND clone_generation IS NULL AND clone_expires_ms IS NULL)
       OR
       (lifecycle = 'provisional'
        AND clone_generation IS NOT NULL AND clone_expires_ms IS NOT NULL)
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
       AND length(CAST(head AS BLOB)) >= 1
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
     name TEXT NOT NULL CHECK (
       typeof(name) = 'text' AND length(CAST(name AS BLOB)) >= 1
     ),
     target TEXT NOT NULL CHECK (
       typeof(target) = 'text'
       AND length(CAST(target AS BLOB)) >= 1
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
   )`,

  `CREATE TABLE IF NOT EXISTS git_tracking_ref_revisions (
     repo_id INTEGER NOT NULL CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     ref_name TEXT NOT NULL CHECK (
       typeof(ref_name) = 'text'
       AND length(CAST(ref_name AS BLOB)) >= 1
       AND substr(ref_name, 1, 13) = 'refs/remotes/'
     ),
     revision INTEGER NOT NULL CHECK (
       typeof(revision) = 'integer'
       AND revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, ref_name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_fetch_namespaces (
     repo_id INTEGER NOT NULL CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     tracking_prefix TEXT NOT NULL CHECK (
       typeof(tracking_prefix) = 'text'
       AND length(CAST(tracking_prefix AS BLOB)) >= 1
       AND substr(tracking_prefix, 1, 13) = 'refs/remotes/'
       AND substr(tracking_prefix, -1) = '/'
     ),
     latest_generation INTEGER NOT NULL CHECK (
       typeof(latest_generation) = 'integer'
       AND latest_generation BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     revision INTEGER NOT NULL CHECK (
       typeof(revision) = 'integer'
       AND revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, tracking_prefix),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  ...REFLOG_SCHEMA_STATEMENTS,

  // Dotted config path ("user.email", "remote.origin.url"). `seq` keeps
  // multi-valued keys ordered the way a config file would.
  `CREATE TABLE IF NOT EXISTS git_config (
     repo_id INTEGER NOT NULL,
     path TEXT NOT NULL CHECK (
       typeof(path) = 'text'
       AND length(CAST(path AS BLOB)) BETWEEN 1 AND ${MAX_INDEX_PATH_BYTES}
       AND instr(path, char(0)) = 0
       AND instr(path, char(10)) = 0
       AND instr(path, char(13)) = 0
     ),
     seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0),
     value TEXT NOT NULL CHECK (typeof(value) = 'text'),
     PRIMARY KEY (repo_id, path, seq),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_promisor_remotes (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     remote_name TEXT NOT NULL CHECK (
       typeof(remote_name) = 'text'
       AND length(CAST(remote_name AS BLOB)) BETWEEN 1 AND ${MAX_PROMISOR_REMOTE_NAME_BYTES}
       AND instr(remote_name, char(0)) = 0
     ),
     url TEXT NOT NULL CHECK (
       typeof(url) = 'text'
       AND length(CAST(url AS BLOB)) BETWEEN 1 AND ${MAX_PROMISOR_URL_BYTES}
       AND instr(url, char(0)) = 0
     ),
     filter TEXT NOT NULL CHECK (typeof(filter) = 'text' AND filter = 'blob:none'),
     PRIMARY KEY (repo_id, remote_name),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_promised_blobs (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (
       typeof(oid) = 'text'
       AND length(CAST(oid AS BLOB)) = 40
       AND oid NOT GLOB '*[^0-9a-f]*'
     ),
     remote_name TEXT NOT NULL,
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type = 'blob'),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, remote_name)
       REFERENCES git_promisor_remotes (repo_id, remote_name) ON DELETE CASCADE
   ) WITHOUT ROWID`,
] as const;
