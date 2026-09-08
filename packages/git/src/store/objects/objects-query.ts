import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError, ObjectNotFoundError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { int, nullable, oneOf, RowShape } from "../../common/rows.js";
import type { ObjectReadInfo } from "../core/contracts.js";
import { nextPrefix } from "../refs/config.js";
import {
  isObjectType,
  MAX_BLOB_BATCH_OIDS,
  OBJECT_CHUNK,
  type ObjectDatabaseContext,
  type ObjectQueryContext,
  OID_PROBE_PAGE,
} from "./objects-shared.js";

const OBJECT_INFO_ROW = new RowShape({
  source: nullable(oneOf(["loose", "pack"])),
  type: nullable(oneOf(["blob", "tree", "commit", "tag"])),
  size: nullable(int(0)),
  stored: nullable(oneOf(["raw", "zlib"])),
  chunk_rows: int(0),
  first_chunk: nullable(int(0)),
  last_chunk: nullable(int(0)),
  largest_chunk: int(0),
  stored_bytes: int(0),
});

export function looseRow(
  context: ObjectDatabaseContext,
  oid: string,
): { type: ObjectType; size: number; stored: string } | null {
  return (
    context.db.one<{ type: ObjectType; size: number; stored: string }>(
      "SELECT type, size, stored FROM git_objects WHERE repo_id = ? AND oid = ?",
      context.repoId,
      oid,
    ) ?? null
  );
}

export function hasObject(context: ObjectQueryContext, oid: string): boolean {
  if (context.cacheKeys.hasLoose && looseRow(context, oid) !== null) return true;
  return context.packs.typeAndSize(oid) !== null;
}

export function hasAllObjects(context: ObjectDatabaseContext, oids: Iterable<string>): Set<string> {
  const found = new Set<string>();
  let page: string[] = [];
  const probe = (): void => {
    if (page.length === 0) return;
    for (const row of context.db.all<{ oid: string }>(
      `SELECT j.value AS oid FROM json_each(?) j
        WHERE EXISTS (SELECT 1 FROM git_objects o WHERE o.repo_id = ? AND o.oid = j.value)
           OR EXISTS (
             SELECT 1 FROM git_pack_objects p
             JOIN git_pack_meta m
               ON m.repo_id = p.repo_id AND m.pack_id = p.pack_id AND m.state = 'complete'
              WHERE p.repo_id = ? AND p.oid = j.value
           )`,
      JSON.stringify(page),
      context.repoId,
      context.repoId,
    )) {
      found.add(row.oid);
    }
    page = [];
  };
  for (const oid of oids) {
    page.push(oid);
    if (page.length >= OID_PROBE_PAGE) probe();
  }
  probe();
  return found;
}

export function missingObjects(context: ObjectDatabaseContext, oids: Iterable<string>): string[] {
  const wanted = [...new Set(oids)];
  const present = hasAllObjects(context, wanted);
  return wanted.filter((oid) => !present.has(oid));
}

export function objectTypeAndSize(
  context: ObjectQueryContext,
  oid: string,
): { type: ObjectType; size: number } | null {
  if (context.cacheKeys.hasLoose) {
    const row = looseRow(context, oid);
    if (row !== null) return { type: row.type, size: row.size };
  }
  return context.packs.typeAndSize(oid);
}

export function objectInfo(
  context: ObjectDatabaseContext,
  oids: readonly string[],
): ObjectReadInfo[] {
  const wanted = [...new Set(oids)];
  if (wanted.length > MAX_BLOB_BATCH_OIDS) {
    throw new GitError("E2BIG", `object metadata batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
  }
  for (const oid of wanted) {
    if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
  }
  const rows = context.db.all<Record<string, unknown>>(
    `WITH wanted(ordinal, oid) AS MATERIALIZED (
       SELECT CAST(key AS INTEGER), value FROM json_each(?)
     ), chunks AS MATERIALIZED (
       SELECT chunk.oid, COUNT(*) AS chunk_rows, MIN(chunk.seq) AS first_chunk,
              MAX(chunk.seq) AS last_chunk, MAX(length(chunk.data)) AS largest_chunk,
              SUM(length(chunk.data)) AS stored_bytes
         FROM git_object_chunks chunk
         JOIN wanted ON wanted.oid = chunk.oid
        WHERE chunk.repo_id = ?
        GROUP BY chunk.oid
     )
     SELECT CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                 WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
            CASE WHEN loose.oid IS NOT NULL THEN loose.type
                 WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
            CASE WHEN loose.oid IS NOT NULL THEN loose.size
                 WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size,
            CASE WHEN loose.oid IS NOT NULL THEN loose.stored END AS stored,
            CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.chunk_rows, 0) END AS chunk_rows,
            CASE WHEN loose.oid IS NULL THEN NULL ELSE chunks.first_chunk END AS first_chunk,
            CASE WHEN loose.oid IS NULL THEN NULL ELSE chunks.last_chunk END AS last_chunk,
            CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.largest_chunk, 0) END AS largest_chunk,
            CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.stored_bytes, 0) END AS stored_bytes
       FROM wanted w
       LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
       LEFT JOIN chunks ON chunks.oid = w.oid
       LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
        AND pack.state = 'complete'
      ORDER BY w.ordinal`,
    JSON.stringify(wanted),
    context.repoId,
    context.repoId,
    context.repoId,
  );
  if (rows.length !== wanted.length) {
    throw new CorruptError("object metadata lookup returned the wrong row count");
  }
  return rows.map((raw, ordinal) => {
    const row = OBJECT_INFO_ROW.decode(raw);
    const oid = wanted[ordinal];
    if (oid === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
    if (
      row.source === null ||
      row.type === null ||
      row.size === null ||
      (row.source === "loose" && row.stored !== "raw" && row.stored !== "zlib") ||
      (row.source === "loose" && row.chunk_rows <= 0) ||
      (row.source === "loose" && row.first_chunk !== 0) ||
      (row.source === "loose" && row.last_chunk !== row.chunk_rows - 1) ||
      (row.source === "loose" && row.largest_chunk > OBJECT_CHUNK) ||
      (row.source === "loose" && row.stored === "raw" && row.stored_bytes !== row.size) ||
      (row.source === "loose" && row.stored === "zlib" && row.stored_bytes === 0) ||
      (row.source === "pack" &&
        (row.stored !== null ||
          row.chunk_rows !== 0 ||
          row.first_chunk !== null ||
          row.last_chunk !== null ||
          row.largest_chunk !== 0 ||
          row.stored_bytes !== 0))
    ) {
      if (row.source === null) throw new ObjectNotFoundError(oid);
      throw new CorruptError("object metadata lookup returned an invalid row");
    }
    return {
      oid,
      type: row.type,
      size: row.size,
      source: row.source,
      chunkRows: row.chunk_rows,
    };
  });
}

export function resolveObjectPrefix(context: ObjectQueryContext, prefix: string): string | null {
  if (prefix.length === 40) return hasObject(context, prefix) ? prefix : null;
  const found = new Set<string>();
  if (context.cacheKeys.hasLoose) {
    const upper = nextPrefix(prefix);
    for (const row of context.db.all<{ oid: string }>(
      "SELECT oid FROM git_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2",
      context.repoId,
      prefix,
      upper,
    )) {
      found.add(row.oid);
    }
  }
  for (const oid of context.packs.findPrefix(prefix, 2)) found.add(oid);
  return found.size === 1 ? [...found][0]! : null;
}

export function objectCount(context: ObjectQueryContext): number {
  const loose =
    context.db.scalar<number>(
      "SELECT COUNT(*) FROM git_objects WHERE repo_id = ?",
      context.repoId,
    ) ?? 0;
  return loose + context.packs.count();
}

export function looseObjectMetadata(
  context: ObjectDatabaseContext,
  oids: readonly string[],
): Map<string, { type: ObjectType; size: number }> {
  if (oids.length === 0) return new Map();
  const result = new Map<string, { type: ObjectType; size: number }>();
  for (const row of context.db.all<{ oid: string; type: string; size: number }>(
    `SELECT wanted.value AS oid, object.type, object.size
       FROM json_each(?) wanted
       JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.value`,
    JSON.stringify(oids),
    context.repoId,
  )) {
    if (
      !isOid(row.oid) ||
      !isObjectType(row.type) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      result.has(row.oid)
    ) {
      throw new CorruptError("loose object metadata query returned an invalid row");
    }
    result.set(row.oid, { type: row.type, size: row.size });
  }
  return result;
}
