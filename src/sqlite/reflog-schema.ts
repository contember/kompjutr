import { MAX_REF_NAME_BYTES } from "../core/ref-name.js";

export const MAX_REFLOG_REF_BYTES = MAX_REF_NAME_BYTES;
export const MAX_REFLOG_RAW_TARGET_BYTES = 1_024;
export const MAX_REFLOG_IDENTITY_BYTES = 1_024;
export const MAX_REFLOG_REASON_BYTES = 256;
export const MAX_REFLOG_TIMEZONE_MINUTES = 24 * 60;
export const MAX_REFLOG_ORDINAL = Number.MAX_SAFE_INTEGER;
export const MAX_REFLOG_STATE_ROWS = 100_000;
export const MAX_REFLOG_STATE_BYTES = 48 * 1024 * 1024;

const VALID_OID_SQL = "length(CAST(%s AS BLOB)) = 40 AND %s NOT GLOB '*[^0-9a-f]*'";

function oidSql(column: string): string {
  return VALID_OID_SQL.replace("%s", column).replace("%s", column);
}

function symbolicRawSql(column: string): string {
  return `typeof(${column}) = 'text'
         AND substr(${column}, 1, 5) = 'ref: '
         AND length(CAST(${column} AS BLOB)) > 5
         AND substr(${column}, 6) != 'HEAD'
         AND substr(${column}, 6, 5) != 'ref: '
         AND instr(${column}, char(0)) = 0
         AND instr(${column}, char(10)) = 0
         AND instr(${column}, char(13)) = 0`;
}

export const REFLOG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_reflog_state (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     next_ordinal INTEGER NOT NULL CHECK (
       typeof(next_ordinal) = 'integer'
       AND next_ordinal >= 0
       AND next_ordinal <= ${MAX_REFLOG_ORDINAL}
     ),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_reflog_entries (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     ref_name TEXT NOT NULL CHECK (
       typeof(ref_name) = 'text'
       AND length(CAST(ref_name AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_REF_BYTES}
     ),
     ordinal INTEGER NOT NULL CHECK (
       typeof(ordinal) = 'integer'
       AND ordinal >= 1
       AND ordinal <= ${MAX_REFLOG_ORDINAL}
     ),
     old_raw TEXT CHECK (
       old_raw IS NULL OR (
         typeof(old_raw) = 'text'
         AND length(CAST(old_raw AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_RAW_TARGET_BYTES}
       )
     ),
     new_raw TEXT CHECK (
       new_raw IS NULL OR (
         typeof(new_raw) = 'text'
         AND length(CAST(new_raw AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_RAW_TARGET_BYTES}
       )
     ),
     old_oid TEXT CHECK (
       old_oid IS NULL OR (
         typeof(old_oid) = 'text' AND ${oidSql("old_oid")}
       )
     ),
     new_oid TEXT CHECK (
       new_oid IS NULL OR (
         typeof(new_oid) = 'text' AND ${oidSql("new_oid")}
       )
     ),
     actor_name TEXT CHECK (
       actor_name IS NULL OR (
         typeof(actor_name) = 'text'
         AND length(CAST(actor_name AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_IDENTITY_BYTES}
       )
     ),
     actor_email TEXT CHECK (
       actor_email IS NULL OR (
         typeof(actor_email) = 'text'
         AND length(CAST(actor_email AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_IDENTITY_BYTES}
       )
     ),
     timestamp INTEGER NOT NULL CHECK (
       typeof(timestamp) = 'integer'
       AND timestamp >= 0
       AND timestamp <= ${MAX_REFLOG_ORDINAL}
     ),
     timezone INTEGER NOT NULL CHECK (
       typeof(timezone) = 'integer'
       AND timezone BETWEEN -${MAX_REFLOG_TIMEZONE_MINUTES} AND ${MAX_REFLOG_TIMEZONE_MINUTES}
     ),
     reason TEXT NOT NULL CHECK (
       typeof(reason) = 'text'
       AND length(CAST(reason AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_REASON_BYTES}
     ),
     PRIMARY KEY (repo_id, ordinal),
     CHECK ((actor_name IS NULL) = (actor_email IS NULL)),
     CHECK (ref_name != 'HEAD' AND (old_raw IS NOT new_raw OR old_oid IS NOT new_oid)),
     CHECK (
       (old_raw IS NULL AND old_oid IS NULL)
       OR (typeof(old_raw) = 'text' AND ${oidSql("old_raw")} AND old_oid = old_raw)
       OR (${symbolicRawSql("old_raw")})
     ),
     CHECK (
       (new_raw IS NULL AND new_oid IS NULL)
       OR (typeof(new_raw) = 'text' AND ${oidSql("new_raw")} AND new_oid = new_raw)
       OR (${symbolicRawSql("new_raw")})
     ),
     FOREIGN KEY (repo_id) REFERENCES git_reflog_state (repo_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_reflog_entries_by_ref
     ON git_reflog_entries (repo_id, ref_name, ordinal DESC)`,

  `CREATE INDEX IF NOT EXISTS git_reflog_entries_by_timestamp
     ON git_reflog_entries (repo_id, timestamp, ordinal)`,

  `CREATE TABLE IF NOT EXISTS git_checkout_reflog_entries (
     checkout_id INTEGER NOT NULL CHECK (
       typeof(checkout_id) = 'integer' AND checkout_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     repo_id INTEGER NOT NULL CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     ordinal INTEGER NOT NULL CHECK (
       typeof(ordinal) = 'integer'
       AND ordinal >= 1
       AND ordinal <= ${MAX_REFLOG_ORDINAL}
     ),
     old_raw TEXT CHECK (
       old_raw IS NULL OR (
         typeof(old_raw) = 'text'
         AND length(CAST(old_raw AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_RAW_TARGET_BYTES}
       )
     ),
     new_raw TEXT CHECK (
       new_raw IS NULL OR (
         typeof(new_raw) = 'text'
         AND length(CAST(new_raw AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_RAW_TARGET_BYTES}
       )
     ),
     old_oid TEXT CHECK (
       old_oid IS NULL OR (typeof(old_oid) = 'text' AND ${oidSql("old_oid")})
     ),
     new_oid TEXT CHECK (
       new_oid IS NULL OR (typeof(new_oid) = 'text' AND ${oidSql("new_oid")})
     ),
     actor_name TEXT CHECK (
       actor_name IS NULL OR (
         typeof(actor_name) = 'text'
         AND length(CAST(actor_name AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_IDENTITY_BYTES}
       )
     ),
     actor_email TEXT CHECK (
       actor_email IS NULL OR (
         typeof(actor_email) = 'text'
         AND length(CAST(actor_email AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_IDENTITY_BYTES}
       )
     ),
     timestamp INTEGER NOT NULL CHECK (
       typeof(timestamp) = 'integer'
       AND timestamp >= 0
       AND timestamp <= ${MAX_REFLOG_ORDINAL}
     ),
     timezone INTEGER NOT NULL CHECK (
       typeof(timezone) = 'integer'
       AND timezone BETWEEN -${MAX_REFLOG_TIMEZONE_MINUTES} AND ${MAX_REFLOG_TIMEZONE_MINUTES}
     ),
     reason TEXT NOT NULL CHECK (
       typeof(reason) = 'text'
       AND length(CAST(reason AS BLOB)) BETWEEN 1 AND ${MAX_REFLOG_REASON_BYTES}
     ),
     PRIMARY KEY (checkout_id, ordinal),
     CHECK ((actor_name IS NULL) = (actor_email IS NULL)),
     CHECK (
       (old_raw IS NULL AND old_oid IS NULL)
       OR (typeof(old_raw) = 'text' AND ${oidSql("old_raw")} AND old_oid = old_raw)
       OR (${symbolicRawSql("old_raw")})
     ),
     CHECK (
       (new_raw IS NULL AND new_oid IS NULL)
       OR (typeof(new_raw) = 'text' AND ${oidSql("new_raw")} AND new_oid = new_raw)
       OR (${symbolicRawSql("new_raw")})
     ),
     FOREIGN KEY (checkout_id, repo_id)
       REFERENCES git_checkouts (id, repo_id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id) REFERENCES git_reflog_state (repo_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_checkout_reflog_entries_by_ordinal
     ON git_checkout_reflog_entries (repo_id, ordinal)`,

  `CREATE INDEX IF NOT EXISTS git_checkout_reflog_entries_by_timestamp
     ON git_checkout_reflog_entries (repo_id, timestamp, ordinal)`,
] as const;
