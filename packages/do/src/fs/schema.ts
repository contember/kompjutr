// The filesystem's tables. Everything under `fs_`; nothing here is shared
// with the git schema, which lives in `src/git/store/schema/schema.ts`.
//
// The shape that matters: `fs_paths` is keyed on the whole path under
// BINARY collation, so the physical storage order IS git's tree order and
// a working-tree walk is an indexed range scan rather than a traversal.

import type { SqlDatabase } from "../db/db.js";
import { filesystemError } from "./errors.js";

export const FS_SCHEMA_VERSION = 1;

/** DOFS uses 512 KiB; the Durable Object BLOB ceiling is 2 MB. */
export const CHUNK_SIZE = 512 * 1024;

export const ROOT_INODE = 1;

const STATEMENTS = [
  // Seeded rows: 'schema_version', 'rev', 'next_inode'.
  //   rev        — monotonic, bumped once per mutating call, not per row.
  //   next_inode — an explicit allocator, because a bulk write has to know
  //                its inodes before it can build the payload, and
  //                AUTOINCREMENT also writes sqlite_sequence per insert.
  `CREATE TABLE IF NOT EXISTS fs_meta (
     k TEXT PRIMARY KEY,
     v INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS fs_nodes (
     inode INTEGER PRIMARY KEY CHECK (
       typeof(inode) = 'integer' AND inode BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     type TEXT NOT NULL CHECK (
       typeof(type) = 'text' AND type IN ('file','dir','symlink')
     ),
     mode INTEGER NOT NULL DEFAULT 420 CHECK (
       typeof(mode) = 'integer' AND mode BETWEEN 0 AND 4095
     ),
     mtime INTEGER NOT NULL CHECK (
       typeof(mtime) = 'integer'
       AND mtime BETWEEN -${Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}
     ),
     size INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     rev INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(rev) = 'integer' AND rev BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     nlink INTEGER NOT NULL DEFAULT 1 CHECK (
       typeof(nlink) = 'integer' AND nlink BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
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
   )`,

  // WITHOUT ROWID so the row lives in the (path) PK b-tree leaf: a range
  // scan on `path` is the physical scan order and `inode` is read straight
  // from the leaf with no rowid hop.
  //
  // `path` is always a REAL path — every symlink on the way already
  // resolved. Writing a lexical path here would shadow its own target.
  `CREATE TABLE IF NOT EXISTS fs_paths (
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
       typeof(inode) = 'integer' AND inode BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     CHECK (
       (path = '/' AND parent = '' AND inode = ${ROOT_INODE})
       OR (path <> '/' AND (
         (parent = '/' AND instr(substr(path, 2), '/') = 0)
         OR (parent <> '' AND parent <> '/'
             AND substr(path, 1, length(parent) + 1) = parent || '/'
             AND instr(substr(path, length(parent) + 2), '/') = 0)
       ))
     )
   ) WITHOUT ROWID`,

  // readdir: WHERE parent = ? ORDER BY path. Covering — on a WITHOUT ROWID
  // table the PK is the row locator, so `path` is in the index leaf. The
  // basename is sliced in JS; there is no `name` column.
  `CREATE INDEX IF NOT EXISTS fs_paths_by_parent ON fs_paths(parent, path)`,

  // Reverse lookup for unlink/link/nlink.
  `CREATE INDEX IF NOT EXISTS fs_paths_by_inode ON fs_paths(inode)`,

  // A rowid table on purpose: rows carry up to CHUNK_SIZE of payload, and
  // WITHOUT ROWID wants small rows.
  `CREATE TABLE IF NOT EXISTS fs_chunks (
     inode INTEGER NOT NULL,
     idx INTEGER NOT NULL,
     bytes BLOB NOT NULL,
     PRIMARY KEY (inode, idx)
   )`,
] as const;

interface SchemaObject {
  type: string;
  sql: string;
}

function expectedSchemaObject(statement: string): readonly [string, SchemaObject] {
  const match = /^CREATE (TABLE|INDEX) IF NOT EXISTS ([a-z0-9_]+)/.exec(statement);
  const type = match?.[1]?.toLowerCase();
  const name = match?.[2];
  if (type === undefined || name === undefined) {
    throw new Error("filesystem schema contains an unrecognized definition");
  }
  return [name, { type, sql: statement.replace(" IF NOT EXISTS", "") }];
}

const EXPECTED_SCHEMA_OBJECTS = new Map(STATEMENTS.map(expectedSchemaObject));
if (EXPECTED_SCHEMA_OBJECTS.size !== STATEMENTS.length) {
  throw new Error("filesystem schema contains duplicate definitions");
}

const schemaTextEncoder = new TextEncoder();
let maxSchemaObjectNameBytes = 0;
let maxSchemaObjectDefinitionBytes = 0;
for (const [name, definition] of EXPECTED_SCHEMA_OBJECTS) {
  maxSchemaObjectNameBytes = Math.max(
    maxSchemaObjectNameBytes,
    schemaTextEncoder.encode(name).length,
  );
  maxSchemaObjectDefinitionBytes = Math.max(
    maxSchemaObjectDefinitionBytes,
    schemaTextEncoder.encode(definition.sql).length,
  );
}
const MAX_SCHEMA_OBJECT_ROWS = EXPECTED_SCHEMA_OBJECTS.size + 1;

function schemaError(message: string): Error {
  return filesystemError("EIO", message);
}

function readSchemaObjects(db: SqlDatabase): Map<string, SchemaObject> {
  const objects = new Map<string, SchemaObject>();
  for (const row of db.iterate(
    `SELECT
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
            THEN name END AS name,
       CASE WHEN typeof(type) = 'text' AND type IN ('table', 'index') THEN type END AS type,
       CASE WHEN typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN sql END AS sql,
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
                  AND typeof(type) = 'text' AND type IN ('table', 'index')
                  AND typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN 0 ELSE 1 END AS invalid
     FROM sqlite_schema
     WHERE substr(name, 1, 3) COLLATE NOCASE = 'fs_'
     LIMIT ${MAX_SCHEMA_OBJECT_ROWS}`,
  )) {
    if (row.invalid !== 0 && row.invalid !== 1) {
      throw schemaError("filesystem schema object probe is invalid");
    }
    if (row.invalid === 1) throw schemaError("filesystem schema object exceeds its read bound");
    if (
      typeof row.name !== "string" ||
      typeof row.type !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw schemaError("filesystem schema object probe is invalid");
    }
    if (objects.has(row.name)) throw schemaError("filesystem schema contains a duplicate object");
    objects.set(row.name, { type: row.type, sql: row.sql });
    if (objects.size > EXPECTED_SCHEMA_OBJECTS.size) {
      throw schemaError(`filesystem schema contains unexpected object ${row.name}`);
    }
  }
  return objects;
}

function requireCurrentSchemaObject(
  objects: ReadonlyMap<string, SchemaObject>,
  name: string,
): void {
  const expected = EXPECTED_SCHEMA_OBJECTS.get(name);
  if (expected === undefined) throw new Error(`filesystem schema has no definition for ${name}`);
  const actual = objects.get(name);
  if (actual === undefined) {
    throw schemaError(`filesystem schema is missing required ${expected.type} ${name}`);
  }
  if (actual.type !== expected.type) {
    throw schemaError(
      `filesystem schema object ${name} is a ${actual.type}, expected ${expected.type}`,
    );
  }
  if (actual.sql !== expected.sql) {
    throw schemaError(`filesystem schema object ${name} does not match its current definition`);
  }
}

function requireCurrentSchema(objects: ReadonlyMap<string, SchemaObject>): void {
  for (const name of EXPECTED_SCHEMA_OBJECTS.keys()) requireCurrentSchemaObject(objects, name);
  for (const name of objects.keys()) {
    if (!EXPECTED_SCHEMA_OBJECTS.has(name)) {
      throw schemaError(`filesystem schema contains unexpected object ${name}`);
    }
  }
}

function requireCurrentVersion(db: SqlDatabase): void {
  const row = db.one<{ version: unknown }>(
    `SELECT CASE WHEN typeof(v) = 'integer' THEN v END AS version
       FROM fs_meta WHERE k = 'schema_version'`,
  );
  if (row === undefined) throw schemaError("filesystem schema version is missing");
  if (typeof row.version !== "number" || !Number.isSafeInteger(row.version)) {
    throw schemaError("filesystem schema has an invalid version");
  }
  if (row.version !== FS_SCHEMA_VERSION) {
    throw schemaError(
      `filesystem schema version ${row.version} is unsupported; expected ${FS_SCHEMA_VERSION}`,
    );
  }
}

/**
 * Create the filesystem tables and seed the root directory.
 *
 * Deliberately absent: no index on `fs_nodes.rev` (nothing reads it yet and
 * it would cost an entry per row on every bulk write), no content-addressed
 * blob table, no manifests, no GC. Two identical files store their bytes
 * twice; in exchange the write path never hashes.
 */
export function initializeFsSchema(db: SqlDatabase, now: () => number = Date.now): void {
  db.transactionSync(() => {
    const before = readSchemaObjects(db);
    if (before.size !== 0) {
      if (!before.has("fs_meta")) {
        throw schemaError("filesystem schema metadata is missing from an existing database");
      }
      requireCurrentSchemaObject(before, "fs_meta");
      requireCurrentVersion(db);
      requireCurrentSchema(before);
      return;
    }

    for (const statement of STATEMENTS) db.run(statement);

    db.run("INSERT OR IGNORE INTO fs_meta (k, v) VALUES ('rev', 0)");
    db.run("INSERT OR IGNORE INTO fs_meta (k, v) VALUES ('next_inode', ?)", ROOT_INODE + 1);

    db.run(
      `INSERT OR IGNORE INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
       VALUES (?, 'dir', ?, ?, 0, 0, 1)`,
      ROOT_INODE,
      0o755,
      now(),
    );
    db.run("INSERT OR IGNORE INTO fs_paths (path, parent, inode) VALUES ('/', '', ?)", ROOT_INODE);

    db.run("INSERT INTO fs_meta (k, v) VALUES ('schema_version', ?)", FS_SCHEMA_VERSION);
    requireCurrentSchema(readSchemaObjects(db));
    requireCurrentVersion(db);
  });
}
