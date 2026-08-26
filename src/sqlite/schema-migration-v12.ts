import { isOid } from "../core/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../core/errors.js";
import { ByteLru } from "../core/lru.js";
import { hashObject, type RawObject } from "../core/objects.js";
import {
  MAX_BLOB_ID_CACHE_CONTENT_BYTES,
  MAX_BLOB_ID_CACHE_ROWS,
  MAX_CACHED_CONTENT_ID_BYTES,
} from "./blob-id-cache.js";
import { insertCommitCaches, prepareCommitCache } from "./commits.js";
import type { SqlDatabase } from "./db.js";
import { MemoryCoordinator } from "./memory.js";
import { MAX_PACK_ROW_CACHE_BYTES, PackStore } from "./packs.js";
import { readMigrationLooseInfo, readMigrationLooseObjects } from "./schema-migration-loose.js";
import { indexTreeSources, type TreeSourceInput } from "./tree-index.js";

const V12_MAX_PROJECTION_SOURCES = 8_192;
const V12_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const V12_MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const V12_PROJECTION_BATCH_BYTES = 4 * 1024 * 1024;
const V12_PROJECTION_BATCH_SOURCES = 4_096;

function currentStatement(statements: readonly string[], prefix: string): string {
  const statement = statements.find((candidate) => candidate.trimStart().startsWith(prefix));
  if (statement === undefined) throw new Error(`missing current schema statement: ${prefix}`);
  return statement;
}

function requireV11Metadata(db: SqlDatabase): void {
  if (
    db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_objects
          WHERE typeof(repo_id) != 'integer' OR repo_id < 1
             OR typeof(oid) != 'text' OR length(CAST(oid AS BLOB)) != 40
             OR typeof(type) != 'text' OR type NOT IN ('blob','tree','commit','tag')
             OR typeof(size) != 'integer' OR size < 0
             OR typeof(stored) != 'text' OR stored NOT IN ('raw','zlib')
         LIMIT 1
       )`,
    ) === 1
  ) {
    throw new CorruptError("schema v12 migration found invalid loose-object metadata");
  }
  if (
    db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_pack_meta
          WHERE typeof(repo_id) != 'integer' OR repo_id < 1
             OR typeof(pack_id) != 'integer' OR pack_id < 0
             OR typeof(size) != 'integer' OR size < 0
             OR typeof(count) != 'integer' OR count < 0
             OR typeof(state) != 'text' OR state NOT IN ('pending','complete')
             OR typeof(created) != 'integer' OR created < 0
         LIMIT 1
       )`,
    ) === 1
  ) {
    throw new CorruptError("schema v12 migration found invalid pack metadata");
  }
  if (
    db.scalar<unknown>(
      `SELECT EXISTS(
         SELECT 1 FROM git_pack_objects
          WHERE typeof(repo_id) != 'integer' OR repo_id < 1
             OR typeof(oid) != 'text' OR length(CAST(oid AS BLOB)) != 40
             OR typeof(pack_id) != 'integer' OR pack_id < 0
             OR typeof(offset) != 'integer' OR offset < 0
             OR typeof(data_off) != 'integer' OR data_off < 0
             OR typeof(data_len) != 'integer' OR data_len < 0
             OR typeof(type) != 'text' OR type NOT IN ('blob','tree','commit','tag')
             OR typeof(size) != 'integer' OR size < 0
             OR typeof(entry_size) != 'integer' OR entry_size < 0
             OR (base_oid IS NOT NULL AND (
                  typeof(base_oid) != 'text' OR length(CAST(base_oid AS BLOB)) != 40
                ))
         LIMIT 1
       )`,
    ) === 1
  ) {
    throw new CorruptError("schema v12 migration found invalid pack-object metadata");
  }
}

interface MigrationObjectRow {
  repo_id: number;
  oid: string;
  type: string;
  size: number;
  stored?: string;
  pack_id?: number;
}

function requireMigrationObject(row: MigrationObjectRow, storage: "loose" | "pack"): void {
  if (
    !Number.isSafeInteger(row.repo_id) ||
    row.repo_id < 1 ||
    !isOid(row.oid) ||
    (row.type !== "tree" && row.type !== "commit") ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    row.size > V12_MAX_SOURCE_BYTES ||
    (storage === "loose" && row.stored !== "raw" && row.stored !== "zlib") ||
    (storage === "pack" &&
      (!Number.isSafeInteger(row.pack_id) || row.pack_id === undefined || row.pack_id < 0))
  ) {
    throw new CorruptError(`schema v12 migration found an invalid ${storage} source`);
  }
}

function migrationPackStore(db: SqlDatabase, repoId: number): PackStore {
  const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
  const chunks = new ByteLru<string, Uint8Array>(MAX_PACK_ROW_CACHE_BYTES, (chunk) => chunk.length);
  const external = (oid: string): RawObject | null =>
    readMigrationLooseObjects(db, repoId, [oid]).get(oid) ?? null;
  return new PackStore(
    db,
    repoId,
    objects,
    chunks,
    new MemoryCoordinator(),
    `migration:${repoId}`,
    external,
    (oids) => readMigrationLooseObjects(db, repoId, oids),
    (oids) => readMigrationLooseInfo(db, repoId, oids),
  );
}

function migrationObjectBatches(rows: readonly MigrationObjectRow[]): MigrationObjectRow[][] {
  const batches: MigrationObjectRow[][] = [];
  let pending: MigrationObjectRow[] = [];
  let bytes = 0;
  let repoId = -1;
  for (const row of rows) {
    if (
      pending.length > 0 &&
      (row.repo_id !== repoId ||
        pending.length >= V12_PROJECTION_BATCH_SOURCES ||
        bytes + row.size > V12_PROJECTION_BATCH_BYTES)
    ) {
      batches.push(pending);
      pending = [];
      bytes = 0;
    }
    pending.push(row);
    bytes += row.size;
    repoId = row.repo_id;
  }
  if (pending.length > 0) batches.push(pending);
  return batches;
}

function rebuildMigrationProjections(
  db: SqlDatabase,
  rows: readonly MigrationObjectRow[],
  objects: ReadonlyMap<string, RawObject>,
  storage: "loose" | "pack",
): void {
  const trees: TreeSourceInput[] = [];
  const commits = [];
  for (const row of rows) {
    const object = objects.get(row.oid);
    if (
      object === undefined ||
      object.type !== row.type ||
      object.data.length !== row.size ||
      hashObject(row.type === "tree" ? "tree" : "commit", object.data) !== row.oid
    ) {
      throw new CorruptError(`schema v12 migration found corrupt ${storage} object bytes`);
    }
    if (row.type === "tree") {
      trees.push({
        repoId: row.repo_id,
        treeOid: row.oid,
        storage,
        sourceId: storage === "loose" ? 0 : (row.pack_id ?? -1),
        objectSize: row.size,
        chunks: [object.data],
      });
    } else {
      commits.push(prepareCommitCache({ repoId: row.repo_id, oid: row.oid, data: object.data }));
    }
  }
  indexTreeSources(db, trees);
  const result = insertCommitCaches(db, commits);
  if (result.written !== commits.length || result.skipped !== 0) {
    throw new CorruptError("schema v12 migration could not rebuild commit projections");
  }
}

function tableExists(db: SqlDatabase, name: string): boolean {
  const exists = db.scalar<unknown>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
    name,
  );
  if (exists !== 0 && exists !== 1) throw new CorruptError("schema table probe is invalid");
  return exists === 1;
}

function readPackedBatch(
  packs: PackStore,
  rows: readonly MigrationObjectRow[],
): Map<string, RawObject> {
  try {
    return packs.readObjects(rows.map((row) => row.oid));
  } catch (error) {
    if (hasErrorCode(error, "E2BIG") || hasErrorCode(error, "ECORRUPT")) throw error;
    throw new CorruptError("schema v12 migration could not read complete pack bytes", {
      cause: error,
    });
  }
}

export function migrateV12(db: SqlDatabase, statements: readonly string[]): void {
  requireV11Metadata(db);
  const sourceStats = db.one<{ sources: number; bytes: number; largest: number }>(
    `SELECT count(*) AS sources, coalesce(sum(size), 0) AS bytes,
            coalesce(max(size), 0) AS largest
       FROM (
         SELECT size FROM git_objects WHERE type IN ('tree','commit')
         UNION ALL
         SELECT object.size FROM git_pack_objects object
         JOIN git_pack_meta pack ON pack.repo_id = object.repo_id
          AND pack.pack_id = object.pack_id AND pack.state = 'complete'
         WHERE object.type IN ('tree','commit')
       )`,
  );
  if (
    sourceStats === undefined ||
    !Number.isSafeInteger(sourceStats.sources) ||
    !Number.isSafeInteger(sourceStats.bytes) ||
    !Number.isSafeInteger(sourceStats.largest) ||
    sourceStats.sources < 0 ||
    sourceStats.bytes < 0 ||
    sourceStats.largest < 0
  ) {
    throw new CorruptError("schema v12 migration projection preflight is invalid");
  }
  if (
    sourceStats.sources > V12_MAX_PROJECTION_SOURCES ||
    sourceStats.bytes > V12_MAX_TOTAL_SOURCE_BYTES ||
    sourceStats.largest > V12_MAX_SOURCE_BYTES
  ) {
    throw new GitError("E2BIG", "schema v12 migration exceeds its projection rebuild capacity");
  }

  for (const trigger of [
    "git_blob_id_updates_begin",
    "git_blob_id_updates_mapping",
    "git_blob_id_updates_finish",
    "git_blob_id_updates_invalid",
    "git_tree_effective_loose_insert",
    "git_tree_effective_loose_delete",
    "git_tree_effective_pack_complete",
    "git_tree_effective_pack_delete",
    "git_tree_effective_pack_hide",
  ]) {
    db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  db.run("DROP VIEW IF EXISTS git_blob_id_updates");
  db.run("DROP VIEW IF EXISTS git_tree_entries_wide");
  db.run("DROP INDEX IF EXISTS git_tree_entries_by_name_bytes");
  db.run("DROP INDEX IF EXISTS git_pack_objects_loc");
  db.run("DROP INDEX IF EXISTS git_blob_ids_by_generation");

  const renamed: string[] = [];
  for (const table of [
    "git_blob_ids",
    "git_commits",
    "git_tree_effective",
    "git_tree_entries",
    "git_tree_sources",
    "git_objects",
    "git_pack_meta",
    "git_pack_objects",
  ]) {
    if (!tableExists(db, table)) continue;
    db.run(`ALTER TABLE ${table} RENAME TO ${table}_v11`);
    renamed.push(table);
  }

  for (const prefix of [
    "CREATE TABLE IF NOT EXISTS git_blob_ids",
    "CREATE TABLE IF NOT EXISTS git_blob_id_state",
    "CREATE INDEX IF NOT EXISTS git_blob_ids_by_generation",
    "CREATE TABLE IF NOT EXISTS git_objects",
    "CREATE TABLE IF NOT EXISTS git_commits",
    "CREATE TABLE IF NOT EXISTS git_pack_meta",
    "CREATE TABLE IF NOT EXISTS git_pack_objects",
    "CREATE INDEX IF NOT EXISTS git_pack_objects_loc",
    "CREATE TABLE IF NOT EXISTS git_tree_sources",
    "CREATE TABLE IF NOT EXISTS git_tree_entries",
    "CREATE INDEX IF NOT EXISTS git_tree_entries_by_name_bytes",
    "CREATE TABLE IF NOT EXISTS git_tree_effective",
  ]) {
    db.run(currentStatement(statements, prefix));
  }

  if (renamed.includes("git_blob_ids")) {
    // The cache is disposable, so preserve a repository only when its whole cache fits v12 bounds.
    db.run(
      `INSERT INTO git_blob_ids (repo_id, content_id, oid, generation)
       WITH stats AS (
         SELECT repo_id, count(*) AS rows, coalesce(sum(length(content_id)), 0) AS bytes,
                sum(CASE
                  WHEN typeof(repo_id) = 'integer' AND repo_id >= 1
                   AND typeof(content_id) = 'blob'
                   AND length(content_id) <= ${MAX_CACHED_CONTENT_ID_BYTES}
                   AND typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40
                  THEN 0 ELSE 1 END) AS invalid
           FROM git_blob_ids_v11 GROUP BY repo_id
       ), eligible AS (
         SELECT repo_id FROM stats
          WHERE rows <= ${MAX_BLOB_ID_CACHE_ROWS}
            AND bytes <= ${MAX_BLOB_ID_CACHE_CONTENT_BYTES}
            AND invalid = 0
       )
       SELECT cache.repo_id, cache.content_id, cache.oid, 1
         FROM git_blob_ids_v11 cache
         JOIN eligible ON eligible.repo_id = cache.repo_id`,
    );
    db.run(
      "INSERT INTO git_blob_id_state (repo_id, generation) SELECT DISTINCT repo_id, 1 FROM git_blob_ids",
    );
  }
  db.run(
    `INSERT INTO git_objects (repo_id, oid, type, size, stored)
     SELECT repo_id, oid, type, size, stored FROM git_objects_v11`,
  );
  db.run(
    `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
     SELECT repo_id, pack_id, size, count, state, created FROM git_pack_meta_v11`,
  );
  db.run(
    `INSERT INTO git_pack_objects
       (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
     SELECT repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid
       FROM git_pack_objects_v11`,
  );
  db.run(
    `INSERT INTO git_tree_sources
       (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
     SELECT repo_id, oid, 'loose', 0, 0, size, NULL, NULL
       FROM git_objects WHERE type = 'tree'`,
  );
  db.run(
    `INSERT INTO git_tree_sources
       (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
     SELECT object.repo_id, object.oid, 'pack', object.pack_id, 0, object.size, NULL, NULL
       FROM git_pack_objects object
       JOIN git_pack_meta pack ON pack.repo_id = object.repo_id
        AND pack.pack_id = object.pack_id AND pack.state = 'complete'
      WHERE object.type = 'tree'`,
  );
  db.run(
    `INSERT INTO git_tree_effective (repo_id, tree_oid, source_key)
     SELECT repo_id, tree_oid, source_key FROM git_tree_sources WHERE storage = 'loose'`,
  );
  db.run(
    `INSERT OR IGNORE INTO git_tree_effective (repo_id, tree_oid, source_key)
     SELECT repo_id, tree_oid, source_key FROM git_tree_sources WHERE storage = 'pack'`,
  );

  const looseRows = db.all<MigrationObjectRow>(
    `SELECT repo_id, oid, type, size, stored FROM git_objects
      WHERE type IN ('tree','commit') ORDER BY repo_id, oid`,
  );
  for (const row of looseRows) requireMigrationObject(row, "loose");
  for (const batch of migrationObjectBatches(looseRows)) {
    const repoId = batch[0]?.repo_id;
    if (repoId === undefined) continue;
    const objects = readMigrationLooseObjects(
      db,
      repoId,
      batch.map((row) => row.oid),
    );
    rebuildMigrationProjections(db, batch, objects, "loose");
  }

  const packedRows = db.all<MigrationObjectRow>(
    `SELECT object.repo_id, object.oid, object.type, object.size, object.pack_id
       FROM git_pack_objects object
       JOIN git_pack_meta pack ON pack.repo_id = object.repo_id
        AND pack.pack_id = object.pack_id AND pack.state = 'complete'
      WHERE object.type IN ('tree','commit')
      ORDER BY object.repo_id, object.oid`,
  );
  for (const row of packedRows) requireMigrationObject(row, "pack");
  let activeRepo = -1;
  let packs: PackStore | null = null;
  for (const batch of migrationObjectBatches(packedRows)) {
    const repoId = batch[0]?.repo_id;
    if (repoId === undefined) continue;
    if (packs === null || activeRepo !== repoId) {
      activeRepo = repoId;
      packs = migrationPackStore(db, repoId);
    }
    rebuildMigrationProjections(db, batch, readPackedBatch(packs, batch), "pack");
  }
  const incomplete = db.scalar<unknown>(
    "SELECT EXISTS(SELECT 1 FROM git_tree_sources WHERE complete = 0)",
  );
  if (incomplete !== 0 && incomplete !== 1) {
    throw new CorruptError("schema v12 migration tree-source probe is invalid");
  }
  if (incomplete === 1) {
    throw new CorruptError("schema v12 migration left an incomplete authoritative tree source");
  }

  for (const table of [
    "git_commits_v11",
    "git_tree_effective_v11",
    "git_tree_entries_v11",
    "git_tree_sources_v11",
    "git_blob_ids_v11",
    "git_objects_v11",
    "git_pack_objects_v11",
    "git_pack_meta_v11",
  ]) {
    if (tableExists(db, table)) db.run(`DROP TABLE ${table}`);
  }
  db.run(currentStatement(statements, "CREATE VIEW IF NOT EXISTS git_tree_entries_wide"));
  for (const prefix of [
    "CREATE VIEW IF NOT EXISTS git_blob_id_updates",
    "CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_begin",
    "CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_mapping",
    "CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_finish",
    "CREATE TRIGGER IF NOT EXISTS git_blob_id_updates_invalid",
    "CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_insert",
    "CREATE TRIGGER IF NOT EXISTS git_tree_effective_loose_delete",
    "CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_complete",
    "CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_delete",
    "CREATE TRIGGER IF NOT EXISTS git_tree_effective_pack_hide",
  ]) {
    db.run(currentStatement(statements, prefix));
  }
}
