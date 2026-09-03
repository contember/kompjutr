// The whole Git store and its checkouts live in these tables. Shared rows use
// `repo_id`; worktree-private rows use `checkout_id`.

import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError } from "../../common/errors.js";
import { SCHEMA_VERSION } from "./schema-constants.js";
import { CORE_SCHEMA_STATEMENTS } from "./schema-core-statements.js";
import { MAINTENANCE_SCHEMA_STATEMENTS } from "./schema-maintenance-statements.js";
import { OBJECT_SCHEMA_STATEMENTS } from "./schema-object-statements.js";
import { TREE_SCHEMA_STATEMENTS } from "./schema-tree-statements.js";
import { WORKTREE_SCHEMA_STATEMENTS } from "./schema-worktree-statements.js";

export { MAX_BLOB_ID_CACHE_ROWS } from "../objects/blob-id-cache.js";
export {
  createTreeIndexSink,
  indexTreeSource,
  indexTreeSources,
  TREE_QUEUE_ROW_FIXED_BYTES,
  TreeIndexSink,
  type TreeSource,
  type TreeSourceInput,
  type TreeStorage,
} from "../trees/tree-index.js";
export {
  MAX_CHECKOUTS_PER_REPOSITORY,
  MAX_INDEX_PATH_BYTES,
  MAX_SCRATCH_INDEX_NAME_BYTES,
  MAX_SCRATCH_INDEXES_PER_REPOSITORY,
  MAX_TRACKING_REF_REVISIONS,
  SCHEMA_VERSION,
} from "./schema-constants.js";

const STATEMENTS = [
  ...CORE_SCHEMA_STATEMENTS,
  ...WORKTREE_SCHEMA_STATEMENTS,
  ...OBJECT_SCHEMA_STATEMENTS,
  ...TREE_SCHEMA_STATEMENTS,
  ...MAINTENANCE_SCHEMA_STATEMENTS,
] as const;

interface ExpectedSchemaObject {
  type: string;
  sql: string;
}

function expectedSchemaObject(statement: string): [string, ExpectedSchemaObject] {
  const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX|VIEW|TRIGGER) IF NOT EXISTS ([a-z_]+)/.exec(
    statement,
  );
  const type = match?.[1]?.toLowerCase();
  const name = match?.[2];
  if (type === undefined || name === undefined) {
    throw new Error("git schema contains an unrecognized definition");
  }
  return [name, { type, sql: statement.replace(" IF NOT EXISTS", "") }];
}

const EXPECTED_SCHEMA_OBJECTS = new Map(STATEMENTS.map(expectedSchemaObject));
if (EXPECTED_SCHEMA_OBJECTS.size !== STATEMENTS.length) {
  throw new Error("git schema contains duplicate definitions");
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
const MAX_SCHEMA_OBJECT_RETAINED_BYTES = 100 * 1024 * 1024;
const MAX_SCHEMA_VERSION_BYTES = String(Number.MAX_SAFE_INTEGER).length;
const SCHEMA_OBJECT_FIXED_BYTES = 1024 * 1024;
const maxSchemaObjectRetainedBytes =
  MAX_SCHEMA_OBJECT_ROWS *
  (SCHEMA_OBJECT_FIXED_BYTES + 2 * (maxSchemaObjectNameBytes + maxSchemaObjectDefinitionBytes + 7));
if (maxSchemaObjectRetainedBytes >= MAX_SCHEMA_OBJECT_RETAINED_BYTES) {
  throw new Error("git schema definitions exceed their retained-memory bound");
}

function readSchemaObjects(db: SqlDatabase): Map<string, ExpectedSchemaObject> {
  const objects = new Map<string, ExpectedSchemaObject>();
  let retainedBytes = 0;
  for (const row of db.iterate(
    `SELECT
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
            THEN name END AS name,
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
            THEN length(CAST(name AS BLOB)) END AS name_bytes,
       CASE WHEN typeof(type) = 'text' AND length(CAST(type AS BLOB)) BETWEEN 4 AND 7
            THEN type END AS type,
       CASE WHEN typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN sql END AS sql,
       CASE WHEN typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN length(CAST(sql AS BLOB)) END AS sql_bytes,
       CASE WHEN typeof(name) = 'text'
                  AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectNameBytes}
                  AND typeof(type) = 'text' AND length(CAST(type AS BLOB)) BETWEEN 4 AND 7
                  AND typeof(sql) = 'text'
                  AND length(CAST(sql AS BLOB)) BETWEEN 1 AND ${maxSchemaObjectDefinitionBytes}
            THEN 0 ELSE 1 END AS invalid
     FROM sqlite_schema
     WHERE substr(name, 1, 4) COLLATE NOCASE = 'git_'
     LIMIT ${MAX_SCHEMA_OBJECT_ROWS}`,
  )) {
    if (row.invalid !== 0 && row.invalid !== 1) {
      throw new CorruptError("git schema object bound sentinel is invalid");
    }
    if (row.invalid === 1) {
      throw new CorruptError("git schema object exceeds its read bound");
    }
    if (
      typeof row.name !== "string" ||
      typeof row.name_bytes !== "number" ||
      !Number.isSafeInteger(row.name_bytes) ||
      row.name_bytes < 1 ||
      row.name_bytes > maxSchemaObjectNameBytes ||
      typeof row.type !== "string" ||
      typeof row.sql !== "string" ||
      typeof row.sql_bytes !== "number" ||
      !Number.isSafeInteger(row.sql_bytes) ||
      row.sql_bytes < 1 ||
      row.sql_bytes > maxSchemaObjectDefinitionBytes ||
      !["table", "index", "view", "trigger"].includes(row.type)
    ) {
      throw new CorruptError("git schema object probe is invalid");
    }
    const rowRetainedBytes = SCHEMA_OBJECT_FIXED_BYTES + 2 * (row.name_bytes + row.sql_bytes + 7);
    if (rowRetainedBytes >= MAX_SCHEMA_OBJECT_RETAINED_BYTES - retainedBytes) {
      throw new CorruptError("git schema objects exceed their aggregate read bound");
    }
    retainedBytes += rowRetainedBytes;
    if (objects.has(row.name)) throw new CorruptError("git schema contains a duplicate object");
    objects.set(row.name, { type: row.type, sql: row.sql });
    if (objects.size > EXPECTED_SCHEMA_OBJECTS.size) {
      throw new CorruptError(`git schema contains unexpected object ${row.name}`);
    }
  }
  return objects;
}

function requireCurrentSchemaObject(
  objects: ReadonlyMap<string, ExpectedSchemaObject>,
  name: string,
): void {
  const expected = EXPECTED_SCHEMA_OBJECTS.get(name);
  if (expected === undefined) throw new Error(`git schema has no definition for ${name}`);
  const actual = objects.get(name);
  if (actual === undefined) {
    throw new CorruptError(`git schema is missing required ${expected.type} ${name}`);
  }
  if (actual.type !== expected.type) {
    throw new CorruptError(
      `git schema object ${name} is a ${actual.type}, expected ${expected.type}`,
    );
  }
  if (actual.sql !== expected.sql) {
    throw new CorruptError(`git schema object ${name} does not match its current definition`);
  }
}

function requireCurrentSchema(objects: ReadonlyMap<string, ExpectedSchemaObject>): void {
  for (const name of EXPECTED_SCHEMA_OBJECTS.keys()) {
    requireCurrentSchemaObject(objects, name);
  }
  for (const name of objects.keys()) {
    if (!EXPECTED_SCHEMA_OBJECTS.has(name)) {
      throw new CorruptError(`git schema contains unexpected object ${name}`);
    }
  }
}

function requireCurrentVersion(db: SqlDatabase): void {
  const row = db.one<{ value: unknown; invalid: unknown }>(
    `SELECT
       CASE WHEN typeof(value) = 'text'
                  AND length(CAST(value AS BLOB)) BETWEEN 0 AND ${MAX_SCHEMA_VERSION_BYTES}
            THEN value END AS value,
       CASE WHEN typeof(value) = 'text'
                  AND length(CAST(value AS BLOB)) BETWEEN 0 AND ${MAX_SCHEMA_VERSION_BYTES}
            THEN 0 ELSE 1 END AS invalid
     FROM git_meta WHERE key = 'schema_version'`,
  );
  if (row === undefined) throw new CorruptError("git schema version is missing");
  if (row.invalid !== 0 && row.invalid !== 1) {
    throw new CorruptError("git schema version bound sentinel is invalid");
  }
  if (row.invalid === 1) throw new CorruptError("git schema version exceeds its read bound");
  const recorded = row.value;
  if (typeof recorded !== "string" || !/^[1-9]\d*$/.test(recorded)) {
    throw new CorruptError("git schema has an invalid version");
  }
  const version = Number(recorded);
  if (!Number.isSafeInteger(version)) throw new CorruptError("git schema has an invalid version");
  if (version !== SCHEMA_VERSION) {
    throw new CorruptError(
      `git schema version ${version} is unsupported; expected ${SCHEMA_VERSION}`,
    );
  }
}

export function initializeGitSchema(db: SqlDatabase): void {
  db.transactionSync(() => {
    const before = readSchemaObjects(db);
    if (before.size !== 0) {
      if (!before.has("git_meta")) {
        throw new CorruptError("git schema metadata is missing from an existing database");
      }
      requireCurrentSchemaObject(before, "git_meta");
      requireCurrentVersion(db);
      requireCurrentSchema(before);
      return;
    }

    for (const statement of STATEMENTS) db.run(statement);
    db.run(
      `INSERT OR IGNORE INTO git_identity_control
         (singleton, last_repo_id, last_checkout_id, last_clone_generation)
       VALUES (1, 0, 0, 0)`,
    );
    db.run(
      "INSERT INTO git_meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
    requireCurrentSchema(readSchemaObjects(db));
    requireCurrentVersion(db);
  });
}
