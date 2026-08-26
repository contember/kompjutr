import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import type { SqlDatabase } from "./db.js";

export const MAX_REFLOG_REF_BYTES = 1_024;
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
     CHECK (ref_name = 'HEAD' OR old_raw IS NOT new_raw OR old_oid IS NOT new_oid),
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
];

export const REFLOG_SCHEMA_OBJECTS = [
  "git_reflog_state",
  "git_reflog_entries",
  "git_reflog_entries_by_ref",
  "git_reflog_entries_by_timestamp",
];

function utf8Bytes(value: string, label: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new CorruptError(`schema v13 migration found an invalid ${label}`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new CorruptError(`schema v13 migration found non-canonical ${label}`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`schema v13 migration found non-canonical ${label}`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) {
      throw new GitError("E2BIG", `schema v13 migration ${label} exceeds ${limit} UTF-8 bytes`);
    }
  }
  return bytes;
}

function symbolicTarget(value: string): string | null {
  if (!value.startsWith("ref: ")) return null;
  const target = value.slice(5);
  return target.length === 0 || target === "HEAD" || target.startsWith("ref: ") ? null : target;
}

function validateRefName(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value === "HEAD") {
    throw new CorruptError(`schema v13 migration found an invalid ${label}`);
  }
  utf8Bytes(value, label, MAX_REFLOG_REF_BYTES);
  return value;
}

function validateRawTarget(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CorruptError(`schema v13 migration found an invalid ${label}`);
  }
  utf8Bytes(value, label, MAX_REFLOG_RAW_TARGET_BYTES);
  if (isOid(value)) return value;
  const symbolic = symbolicTarget(value);
  if (symbolic === null) {
    throw new CorruptError(`schema v13 migration found an invalid ${label}`);
  }
  validateRefName(symbolic, `${label} symbolic ref`);
  return value;
}

function validateV12Refs(db: SqlDatabase): void {
  let rows = 0;
  let retainedBytes = 0;
  const repositories = new Set<number>();
  for (const row of db.iterate("SELECT id, head FROM git_repositories ORDER BY id")) {
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 1) {
      throw new CorruptError("schema v13 migration found an invalid repository id");
    }
    validateRawTarget(row.head, "HEAD target");
    rows++;
    retainedBytes += 256 + (typeof row.head === "string" ? row.head.length * 2 : 0);
    if (rows > MAX_REFLOG_STATE_ROWS || retainedBytes > MAX_REFLOG_STATE_BYTES) {
      throw new GitError("E2BIG", "schema v13 migration ref state exceeds its retained bound");
    }
    repositories.add(row.id);
  }
  for (const row of db.iterate(
    "SELECT repo_id, name, target FROM git_refs ORDER BY repo_id, name",
  )) {
    if (
      typeof row.repo_id !== "number" ||
      !Number.isSafeInteger(row.repo_id) ||
      !repositories.has(row.repo_id)
    ) {
      throw new CorruptError("schema v13 migration found a ref for an invalid repository");
    }
    const name = validateRefName(row.name, "ref name");
    const target = validateRawTarget(row.target, `target of ${name}`);
    rows++;
    retainedBytes += 256 + name.length * 2 + target.length * 2;
    if (rows > MAX_REFLOG_STATE_ROWS || retainedBytes > MAX_REFLOG_STATE_BYTES) {
      throw new GitError("E2BIG", "schema v13 migration ref state exceeds its retained bound");
    }
  }
}

export function migrateV13(db: SqlDatabase): void {
  const names = REFLOG_SCHEMA_OBJECTS.map(() => "?").join(", ");
  const existing = db.scalar<unknown>(
    `SELECT count(*) FROM sqlite_schema WHERE name IN (${names})`,
    ...REFLOG_SCHEMA_OBJECTS,
  );
  if (typeof existing !== "number" || !Number.isSafeInteger(existing) || existing < 0) {
    throw new CorruptError("schema v13 object probe returned an invalid value");
  }
  if (existing !== 0) {
    throw new CorruptError("schema v12 database contains pre-existing schema v13 objects");
  }

  validateV12Refs(db);
  for (const statement of REFLOG_SCHEMA_STATEMENTS) db.run(statement);
  db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) SELECT id, 0 FROM git_repositories");
}
