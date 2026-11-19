// The shell's tables. Everything under `shell_`. `shell_meta` records the
// version, so a later change to a table migrates forward instead of being
// skipped on an existing database the way `CREATE TABLE IF NOT EXISTS` was.

import type { SqlDatabase } from "../db/db.js";
import { filesystemError } from "../fs/errors.js";

export const SHELL_SCHEMA_VERSION = 2;

// Byte-for-byte the version 1 definition: SQLite keeps the statement text,
// and a version 1 database is recognised by it.
const SESSIONS_TABLE = `CREATE TABLE shell_sessions (
     session_id TEXT NOT NULL PRIMARY KEY,
     cwd TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 0
   ) WITHOUT ROWID`;

// Seeded row: 'schema_version'.
const META_TABLE = `CREATE TABLE shell_meta (
     k TEXT NOT NULL PRIMARY KEY,
     v INTEGER NOT NULL
   ) WITHOUT ROWID`;

const EXPECTED_SCHEMA_OBJECTS = new Map([
  ["shell_sessions", SESSIONS_TABLE],
  ["shell_meta", META_TABLE],
]);

function schemaError(message: string): Error {
  return filesystemError("EIO", message);
}

// Only the shell's own tables: a host may keep other `shell_*` tables in the
// same database, and a newer schema is recognised by its version row.
function readSchemaObjects(db: SqlDatabase): Map<string, string> {
  const objects = new Map<string, string>();
  for (const row of db.iterate(
    "SELECT name, sql FROM sqlite_schema WHERE name IN ('shell_sessions', 'shell_meta')",
  )) {
    if (typeof row.name !== "string" || typeof row.sql !== "string") {
      throw schemaError("shell schema object probe is invalid");
    }
    objects.set(row.name, row.sql);
  }
  return objects;
}

function requireCurrentTable(objects: ReadonlyMap<string, string>, name: string): void {
  const actual = objects.get(name);
  if (actual === undefined) throw schemaError(`shell schema is missing required table ${name}`);
  if (actual !== EXPECTED_SCHEMA_OBJECTS.get(name)) {
    throw schemaError(`shell schema object ${name} does not match its current definition`);
  }
}

function readVersion(db: SqlDatabase): number {
  const row = db.one<{ version: unknown }>(
    `SELECT CASE WHEN typeof(v) = 'integer' THEN v END AS version
       FROM shell_meta WHERE k = 'schema_version'`,
  );
  if (row === undefined) throw schemaError("shell schema version is missing");
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version)) {
    throw schemaError("shell schema has an invalid version");
  }
  return row.version;
}

function recordVersion(db: SqlDatabase): void {
  db.run(META_TABLE);
  db.run("INSERT INTO shell_meta (k, v) VALUES ('schema_version', ?)", SHELL_SCHEMA_VERSION);
}

/**
 * Create or verify the shell tables. Version 1 is version 2 without
 * `shell_meta`; its `shell_sessions` rows carry over unchanged.
 */
export function initializeShellSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    const objects = readSchemaObjects(db);
    if (objects.size === 0) {
      db.run(SESSIONS_TABLE);
      recordVersion(db);
      return;
    }
    if (!objects.has("shell_meta")) {
      requireCurrentTable(objects, "shell_sessions");
      recordVersion(db);
      return;
    }
    // The version first, so a newer schema is refused as a version.
    requireCurrentTable(objects, "shell_meta");
    const version = readVersion(db);
    if (version !== SHELL_SCHEMA_VERSION) {
      throw schemaError(
        `shell schema version ${version} is unsupported; expected ${SHELL_SCHEMA_VERSION}`,
      );
    }
    requireCurrentTable(objects, "shell_sessions");
  });
}
