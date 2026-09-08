// Set-based copies stay inside SQLite: JS plans bounded metadata pages, while
// content moves with INSERT ... SELECT and never enters the isolate.

import type { SqlDatabase } from "../../db/db.js";
import { filesystemError as fsError } from "../errors.js";
import { comparePaths, dirname, normalize } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type { CopyOptions, EntryType, RealPath } from "../types.js";
import { allocateInodes, bumpRev } from "./meta.js";
import { utf8Length } from "./write/write-batches.js";

const DEFAULT_COPY_BUDGET = 1_500_000;
export const COPY_ENTRY_LIMIT = 1_000;
const MAX_JSON_BYTES = 1_500_000;
const DEFAULT_DIR_MODE = 0o755;

export interface ResolvedCopyEntry {
  source: RealPath;
  destination: RealPath;
}

interface SourceRow {
  path: unknown;
  inode: unknown;
  type: unknown;
  mode: unknown;
  size: unknown;
  mtime: unknown;
  rev: unknown;
  nlink: unknown;
  link_target: unknown;
  content_id_kind: unknown;
  chunk_count: unknown;
  chunk_bytes: unknown;
  first_idx: unknown;
  last_idx: unknown;
  invalid_chunks: unknown;
}

interface Source {
  path: string;
  inode: number;
  type: EntryType;
  size: number;
}

interface ExistingRow {
  path: unknown;
  inode: unknown;
  type: unknown;
}

interface Existing {
  path: string;
  inode: number;
  type: EntryType;
}

interface Planned {
  source: Source;
  destination: RealPath;
  previousInode: number | null;
}

interface PathRow {
  path: string;
  parent: string;
  inode: number;
}

const SELECT_SOURCES = `SELECT p.path AS path,
       p.inode AS inode,
       n.type AS type,
       n.mode AS mode,
       n.size AS size,
       n.mtime AS mtime,
       n.rev AS rev,
       n.nlink AS nlink,
       n.link_target AS link_target,
       CASE WHEN n.content_id IS NULL THEN 'null' ELSE typeof(n.content_id) END AS content_id_kind,
       count(c.idx) AS chunk_count,
       coalesce(sum(length(c.bytes)), 0) AS chunk_bytes,
       min(c.idx) AS first_idx,
       max(c.idx) AS last_idx,
       coalesce(sum(CASE
         WHEN c.idx IS NOT NULL
          AND (typeof(c.idx) <> 'integer'
            OR typeof(c.bytes) <> 'blob'
            OR length(c.bytes) <> min(${CHUNK_SIZE}, n.size - c.idx * ${CHUNK_SIZE}))
         THEN 1 ELSE 0 END), 0) AS invalid_chunks
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
  LEFT JOIN fs_chunks c ON c.inode = p.inode
 WHERE p.path IN (SELECT value FROM json_each(?))
 GROUP BY p.path, p.inode, n.type, n.mode, n.size, n.mtime, n.rev, n.nlink,
          n.link_target, n.content_id`;

const SELECT_EXISTING = `SELECT p.path AS path, p.inode AS inode, n.type AS type
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path IN (SELECT value FROM json_each(?))`;

const INSERT_IMPLICIT_DIRS = `INSERT INTO fs_nodes
       (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(value, '$.i'), 'dir', ?, ?, 0, ?, 1, NULL, NULL
  FROM json_each(?)`;

const INSERT_COPIED_NODES = `INSERT INTO fs_nodes
       (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(j.value, '$.d'),
       source.type,
       source.mode,
       source.mtime,
       source.size,
       ?,
       1,
       source.link_target,
       source.content_id
  FROM json_each(?) j
  JOIN fs_nodes source ON source.inode = json_extract(j.value, '$.s')`;

const COPY_CHUNKS = `INSERT INTO fs_chunks (inode, idx, bytes)
SELECT json_extract(j.value, '$.d'), chunks.idx, chunks.bytes
  FROM json_each(?) j
  JOIN fs_chunks chunks ON chunks.inode = json_extract(j.value, '$.s')`;

const UPSERT_PATHS = `INSERT INTO fs_paths (path, parent, inode)
SELECT json_extract(j.value, '$.p'),
       json_extract(j.value, '$.pa'),
       json_extract(j.value, '$.i')
  FROM json_each(?) j
 WHERE true
ON CONFLICT(path) DO UPDATE SET inode = excluded.inode`;

const RELINK_OLD = `UPDATE fs_nodes
   SET nlink = (SELECT count(*) FROM fs_paths p WHERE p.inode = fs_nodes.inode),
       rev = ?
 WHERE inode IN (SELECT value FROM json_each(?))
   AND EXISTS (SELECT 1 FROM fs_paths p WHERE p.inode = fs_nodes.inode)`;

const DELETE_OLD_CHUNKS = `DELETE FROM fs_chunks
 WHERE inode IN (SELECT value FROM json_each(?))
   AND NOT EXISTS (SELECT 1 FROM fs_paths p WHERE p.inode = fs_chunks.inode)`;

const DELETE_OLD_NODES = `DELETE FROM fs_nodes
 WHERE inode IN (SELECT value FROM json_each(?))
   AND NOT EXISTS (SELECT 1 FROM fs_paths p WHERE p.inode = fs_nodes.inode)`;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function entryType(value: unknown): EntryType {
  if (value === "file" || value === "dir" || value === "symlink") return value;
  throw new Error("copyFiles: source row contains an invalid type");
}

function validateSource(row: SourceRow): Source {
  const type = entryType(row.type);
  const expectedChunks =
    isSafeInteger(row.size) && row.size >= 0 ? Math.ceil(row.size / CHUNK_SIZE) : -1;
  if (
    typeof row.path !== "string" ||
    normalize(row.path) !== row.path ||
    !isSafeInteger(row.inode) ||
    row.inode < 1 ||
    !isSafeInteger(row.mode) ||
    row.mode < 0 ||
    row.mode > 0o7777 ||
    !isSafeInteger(row.size) ||
    row.size < 0 ||
    !isSafeInteger(row.mtime) ||
    !isSafeInteger(row.rev) ||
    row.rev < 0 ||
    !isSafeInteger(row.nlink) ||
    row.nlink < 1 ||
    (row.link_target !== null && typeof row.link_target !== "string") ||
    (row.content_id_kind !== "null" && row.content_id_kind !== "blob") ||
    !isSafeInteger(row.chunk_count) ||
    !isSafeInteger(row.chunk_bytes) ||
    (row.first_idx !== null && (!isSafeInteger(row.first_idx) || row.first_idx < 0)) ||
    (row.last_idx !== null && (!isSafeInteger(row.last_idx) || row.last_idx < 0)) ||
    !isSafeInteger(row.invalid_chunks) ||
    row.invalid_chunks !== 0 ||
    (type === "file" &&
      (row.chunk_count !== expectedChunks ||
        row.chunk_bytes !== row.size ||
        (expectedChunks === 0
          ? row.first_idx !== null || row.last_idx !== null
          : row.first_idx !== 0 || row.last_idx !== expectedChunks - 1))) ||
    (type !== "file" &&
      (row.chunk_count !== 0 ||
        row.chunk_bytes !== 0 ||
        row.first_idx !== null ||
        row.last_idx !== null)) ||
    (type === "dir" && (row.size !== 0 || row.link_target !== null)) ||
    (type === "file" && row.link_target !== null) ||
    (type === "symlink" && (row.link_target === null || row.size !== utf8Length(row.link_target)))
  ) {
    throw new Error("copyFiles: source row contains invalid metadata");
  }
  return {
    path: row.path,
    inode: row.inode,
    type,
    size: row.size,
  };
}

function validateExisting(row: ExistingRow): Existing {
  if (
    typeof row.path !== "string" ||
    normalize(row.path) !== row.path ||
    !isSafeInteger(row.inode) ||
    row.inode < 1
  ) {
    throw new Error("copyFiles: destination row contains invalid metadata");
  }
  return { path: row.path, inode: row.inode, type: entryType(row.type) };
}

function jsonBatches(items: readonly string[]): string[] {
  const out: string[] = [];
  let group: string[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = utf8Length(item);
    if (group.length > 0 && bytes + itemBytes + 1 > MAX_JSON_BYTES) {
      out.push(`[${group.join(",")}]`);
      group = [];
      bytes = 2;
    }
    group.push(item);
    bytes += itemBytes + 1;
  }
  if (group.length > 0) out.push(`[${group.join(",")}]`);
  return out;
}

function selectByPaths<Row extends object>(
  db: SqlDatabase,
  sql: string,
  paths: readonly string[],
): Row[] {
  const out: Row[] = [];
  for (const batch of jsonBatches(paths.map((path) => JSON.stringify(path)))) {
    out.push(...db.all<Row>(sql, batch));
  }
  return out;
}

function strictAncestors(path: string): string[] {
  const out: string[] = [];
  let slash = path.indexOf("/", 1);
  while (slash > 0) {
    out.push(path.slice(0, slash));
    slash = path.indexOf("/", slash + 1);
  }
  return out;
}

function writeJsonBatches(
  db: SqlDatabase,
  sql: string,
  items: readonly string[],
  ...bindings: readonly unknown[]
): void {
  for (const batch of jsonBatches(items)) db.run(sql, ...bindings, batch);
}

function allocatedInode(inodes: ReadonlyMap<string, number>, path: string): number {
  const inode = inodes.get(path);
  if (inode === undefined) throw new Error("copyFiles: inode allocation is incomplete");
  return inode;
}

/** Copy a bounded prefix and return how many input entries made progress. */
export function copyFiles(
  db: SqlDatabase,
  entries: readonly ResolvedCopyEntry[],
  options: CopyOptions = {},
  now: () => number = Date.now,
): number {
  if (entries.length === 0) return 0;
  const budget = options.budget ?? DEFAULT_COPY_BUDGET;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error("copyFiles: budget must be a positive safe integer");
  }
  const page = entries.slice(0, COPY_ENTRY_LIMIT);

  const sources = new Map<string, Source>();
  for (const row of selectByPaths<SourceRow>(
    db,
    SELECT_SOURCES,
    page.map((entry) => entry.source),
  )) {
    const source = validateSource(row);
    sources.set(source.path, source);
  }

  const selected: Array<{ source: Source; destination: RealPath }> = [];
  let bytes = 0;
  for (const entry of page) {
    const source = sources.get(entry.source);
    if (source === undefined) throw fsError("ENOENT", "no such file or directory", entry.source);
    const size = source.type === "file" ? source.size : 0;
    if (selected.length > 0 && bytes + size > budget) {
      break;
    }
    selected.push({ source, destination: entry.destination });
    bytes += size;
  }

  const destinations = new Set<string>();
  const byDestination = new Map<string, Source>();
  for (const entry of selected) {
    if (destinations.has(entry.destination)) {
      throw fsError("EINVAL", "duplicate copy destination", entry.destination);
    }
    destinations.add(entry.destination);
    byDestination.set(entry.destination, entry.source);
    if (entry.source.path === entry.destination) {
      throw fsError("EINVAL", "source and destination are the same file", entry.source.path);
    }
    if (
      entry.source.type === "dir" &&
      entry.destination.startsWith(`${entry.source.path === "/" ? "" : entry.source.path}/`)
    ) {
      throw fsError("EINVAL", "cannot copy a directory into itself", entry.destination);
    }
  }

  const required = new Set<string>();
  for (const entry of selected) {
    for (const ancestor of strictAncestors(entry.destination)) {
      const named = byDestination.get(ancestor);
      if (named === undefined) required.add(ancestor);
      else if (named.type !== "dir") {
        throw fsError("ENOTDIR", "a parent path segment is not a directory", ancestor);
      }
    }
  }

  const existing = new Map<string, Existing>();
  for (const row of selectByPaths<ExistingRow>(db, SELECT_EXISTING, [
    ...required,
    ...destinations,
  ])) {
    const found = validateExisting(row);
    existing.set(found.path, found);
  }

  const implicit: string[] = [];
  for (const path of required) {
    const found = existing.get(path);
    if (found === undefined) {
      if (options.parents === false) {
        throw fsError("ENOENT", "parent directory missing", path);
      }
      implicit.push(path);
    } else if (found.type !== "dir") {
      throw fsError("ENOTDIR", "a parent path segment is not a directory", path);
    }
  }

  const planned: Planned[] = [];
  for (const entry of selected) {
    const found = existing.get(entry.destination);
    if (found?.inode === entry.source.inode) {
      throw fsError("EINVAL", "source and destination are the same file", entry.destination);
    }
    if (found?.type === "dir" && entry.source.type === "dir") continue;
    if (found?.type === "dir") {
      throw fsError("EISDIR", "cannot replace a directory", entry.destination);
    }
    if (found !== undefined && entry.source.type === "dir") {
      throw fsError("EEXIST", "cannot replace a file with a directory", entry.destination);
    }
    planned.push({
      source: entry.source,
      destination: entry.destination,
      previousInode: found?.inode ?? null,
    });
  }
  if (planned.length === 0 && implicit.length === 0) return selected.length;

  const orderedPaths = [...implicit, ...planned.map((entry) => entry.destination)].sort(
    comparePaths,
  );
  const timestamp = now();
  db.transactionSync(() => {
    const rev = bumpRev(db);
    const firstInode = allocateInodes(db, orderedPaths.length);
    const inodes = new Map<string, number>();
    for (let index = 0; index < orderedPaths.length; index++) {
      const path = orderedPaths[index];
      if (path !== undefined) inodes.set(path, firstInode + index);
    }

    const implicitItems = implicit.map((path) => `{"i":${allocatedInode(inodes, path)}}`);
    writeJsonBatches(db, INSERT_IMPLICIT_DIRS, implicitItems, DEFAULT_DIR_MODE, timestamp, rev);

    const copiedItems = planned.map(
      (entry) => `{"s":${entry.source.inode},"d":${allocatedInode(inodes, entry.destination)}}`,
    );
    writeJsonBatches(db, INSERT_COPIED_NODES, copiedItems, rev);
    writeJsonBatches(db, COPY_CHUNKS, copiedItems);

    const pathRows: PathRow[] = [
      ...implicit.map((path) => ({
        path,
        parent: dirname(path),
        inode: allocatedInode(inodes, path),
      })),
      ...planned.map((entry) => ({
        path: entry.destination,
        parent: dirname(entry.destination),
        inode: allocatedInode(inodes, entry.destination),
      })),
    ].sort((left, right) => comparePaths(left.path, right.path));
    const pathItems = pathRows.map(
      (row) =>
        `{"p":${JSON.stringify(row.path)},"pa":${JSON.stringify(row.parent)},"i":${row.inode}}`,
    );
    writeJsonBatches(db, UPSERT_PATHS, pathItems);

    const oldInodes = [
      ...new Set(
        planned
          .map((entry) => entry.previousInode)
          .filter((inode): inode is number => inode !== null),
      ),
    ];
    if (oldInodes.length > 0) {
      const encoded = JSON.stringify(oldInodes);
      db.run(RELINK_OLD, rev, encoded);
      db.run(DELETE_OLD_CHUNKS, encoded);
      db.run(DELETE_OLD_NODES, encoded);
    }
  });

  return selected.length;
}
