// Raw single-path storage operations. Callers resolve lexical paths and apply
// POSIX validation; this layer owns the bounded SQL mutations.

import { readBlob, type SqlDatabase } from "../../sqlite/db.js";
import { codePointLength, dirname, subtreeSuccessor } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import {
  type Dirent,
  type EntryType,
  type RealPath,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  type Stat,
} from "../types.js";

const PERMISSION_BITS = 0o7777;
const CHUNK_WRITE_BUDGET = 3 * CHUNK_SIZE;

const TYPE_BITS: Record<EntryType, number> = {
  file: S_IFREG,
  dir: S_IFDIR,
  symlink: S_IFLNK,
};

interface StatRow {
  inode: number;
  type: string;
  mode: number;
  mtime: number;
  size: number;
  rev: number;
  nlink: number;
  link_target: string | null;
  content_id: unknown;
}

interface FileRow {
  inode: number;
  type: string;
  size: number;
}

interface DirentRow {
  name: string;
  type: string;
}

interface ChunkRow {
  idx: number;
  bytes: unknown;
}

interface ChunkWrite {
  idx: number;
  bytes: Uint8Array;
}

interface RenameRow {
  source_inode: number | null;
  target_inode: number | null;
  target_child: number;
}

const STAT_SQL = `SELECT p.inode AS inode, n.type AS type, n.mode AS mode,
       n.mtime AS mtime, n.size AS size, n.rev AS rev, n.nlink AS nlink,
       n.link_target AS link_target, n.content_id AS content_id
  FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path = ?`;

const FILE_SQL = `SELECT p.inode AS inode, n.type AS type, n.size AS size
  FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path = ?`;

const BUMP_REV = "UPDATE fs_meta SET v = v + 1 WHERE k = 'rev'";

const UPSERT_CHUNKS = `WITH rows AS (
  SELECT json_extract(j.value, '$.x') AS idx,
         substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.n')) AS bytes
    FROM json_each(?) j
)
INSERT INTO fs_chunks (inode, idx, bytes)
SELECT ?, idx, bytes FROM rows
WHERE true
ON CONFLICT(inode, idx) DO UPDATE SET bytes = excluded.bytes`;

function entryType(value: string): EntryType {
  if (value === "file" || value === "dir" || value === "symlink") return value;
  throw new Error(`fs_nodes.type is not a known entry type: ${value}`);
}

function toStat(row: StatRow): Stat {
  const type = entryType(row.type);
  return {
    type,
    mode: TYPE_BITS[type] | (row.mode & PERMISSION_BITS),
    size: row.size,
    mtime: row.mtime,
    ino: row.inode,
    nlink: row.nlink,
    rev: row.rev,
    target: row.link_target,
    contentId: row.content_id === null ? null : readBlob(row.content_id),
  };
}

function fsError(code: string, message: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${message}, '${path}'`), { code, path });
}

function fileAt(db: SqlDatabase, path: RealPath): FileRow {
  const row = db.one<FileRow>(FILE_SQL, path);
  if (row === undefined) throw fsError("ENOENT", "no such file or directory", path);
  if (row.type === "dir") {
    throw fsError("EISDIR", "illegal operation on a directory", path);
  }
  if (row.type !== "file") throw fsError("EINVAL", "not a regular file", path);
  return row;
}

/** Read metadata for one already-resolved path. */
export function statRaw(db: SqlDatabase, path: RealPath): Stat | null {
  const row = db.one<StatRow>(STAT_SQL, path);
  return row === undefined ? null : toStat(row);
}

/** Read direct children and their entry types for one already-resolved directory. */
export function readdirRaw(db: SqlDatabase, path: RealPath): Dirent[] {
  return db
    .all<DirentRow>(
      `SELECT substr(p.path, length(p.parent) + CASE WHEN p.parent = '/' THEN 1 ELSE 2 END) AS name,
              n.type AS type
         FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode
        WHERE p.parent = ?
        ORDER BY p.path`,
      path,
    )
    .map((row) => ({ name: row.name, type: entryType(row.type) }));
}

function boundaryChunks(
  db: SqlDatabase,
  inode: number,
  firstIdx: number,
  lastIdx: number,
  offset: number,
  end: number,
): Map<number, Uint8Array> {
  const indices = new Set<number>();
  if (offset % CHUNK_SIZE !== 0) indices.add(firstIdx);
  if (end % CHUNK_SIZE !== 0) indices.add(lastIdx);
  if (indices.size === 0) return new Map();

  const out = new Map<number, Uint8Array>();
  for (const row of db.all<ChunkRow>(
    `SELECT idx, bytes FROM fs_chunks
      WHERE inode = ? AND idx IN (SELECT value FROM json_each(?))`,
    inode,
    JSON.stringify([...indices]),
  )) {
    out.set(row.idx, readBlob(row.bytes));
  }
  return out;
}

function planChunkWrites(
  existing: ReadonlyMap<number, Uint8Array>,
  bytes: Uint8Array,
  offset: number,
  oldSize: number,
): ChunkWrite[] {
  if (bytes.length === 0) return [];
  const end = offset + bytes.length;
  const newSize = Math.max(oldSize, end);
  const firstIdx = Math.floor(offset / CHUNK_SIZE);
  const lastIdx = Math.floor((end - 1) / CHUNK_SIZE);
  const writes: ChunkWrite[] = [];

  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const chunkStart = idx * CHUNK_SIZE;
    const writeStart = Math.max(offset, chunkStart);
    const writeEnd = Math.min(end, chunkStart + CHUNK_SIZE);
    const sourceStart = writeStart - offset;
    const sourceEnd = writeEnd - offset;
    const wholeChunk = writeStart === chunkStart && writeEnd === chunkStart + CHUNK_SIZE;

    if (wholeChunk) {
      writes.push({ idx, bytes: bytes.subarray(sourceStart, sourceEnd) });
      continue;
    }

    const storedLength = Math.min(CHUNK_SIZE, newSize - chunkStart);
    const chunk = new Uint8Array(storedLength);
    const previous = existing.get(idx);
    if (previous !== undefined) chunk.set(previous.subarray(0, storedLength));
    chunk.set(bytes.subarray(sourceStart, sourceEnd), writeStart - chunkStart);
    writes.push({ idx, bytes: chunk });
  }
  return writes;
}

function writeChunkBatches(db: SqlDatabase, inode: number, writes: readonly ChunkWrite[]): void {
  let start = 0;
  while (start < writes.length) {
    let end = start;
    let payloadLength = 0;
    while (end < writes.length) {
      const row = writes[end];
      if (row === undefined) break;
      if (end > start && payloadLength + row.bytes.length > CHUNK_WRITE_BUDGET) break;
      payloadLength += row.bytes.length;
      end++;
    }

    const payload = new Uint8Array(payloadLength);
    const items: { x: number; a: number; n: number }[] = [];
    let at = 0;
    for (let index = start; index < end; index++) {
      const row = writes[index];
      if (row === undefined) continue;
      payload.set(row.bytes, at);
      items.push({ x: row.idx, a: at + 1, n: row.bytes.length });
      at += row.bytes.length;
    }
    db.run(UPSERT_CHUNKS, payload, JSON.stringify(items), inode);
    start = end;
  }
}

/** Write a byte range without reading or materialising the rest of the file. */
export function writeRangeRaw(
  db: SqlDatabase,
  path: RealPath,
  bytes: Uint8Array,
  offset: number,
  mtime: number,
): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + bytes.length)) {
    throw fsError("EINVAL", `invalid write offset: ${offset}`, path);
  }

  db.transactionSync(() => {
    const file = fileAt(db, path);
    if (bytes.length === 0) return;
    const end = offset + bytes.length;
    const firstIdx = Math.floor(offset / CHUNK_SIZE);
    const lastIdx = Math.floor((end - 1) / CHUNK_SIZE);
    const existing = boundaryChunks(db, file.inode, firstIdx, lastIdx, offset, end);
    const writes = planChunkWrites(existing, bytes, offset, file.size);

    db.run(BUMP_REV);
    writeChunkBatches(db, file.inode, writes);
    db.run(
      `UPDATE fs_nodes
          SET size = max(size, ?), mtime = ?, content_id = NULL,
              rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode = ?`,
      end,
      mtime,
      file.inode,
    );
  });
}

/** Resize a file using at most one boundary-chunk update. */
export function truncateRaw(db: SqlDatabase, path: RealPath, length: number, mtime: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw fsError("EINVAL", `invalid truncate length: ${length}`, path);
  }

  db.transactionSync(() => {
    const file = fileAt(db, path);
    db.run(BUMP_REV);
    if (length < file.size) {
      const lastIdx = length === 0 ? -1 : Math.floor((length - 1) / CHUNK_SIZE);
      db.run("DELETE FROM fs_chunks WHERE inode = ? AND idx > ?", file.inode, lastIdx);
      if (length > 0 && length % CHUNK_SIZE !== 0) {
        db.run(
          "UPDATE fs_chunks SET bytes = substr(bytes, 1, ?) WHERE inode = ? AND idx = ?",
          length - lastIdx * CHUNK_SIZE,
          file.inode,
          lastIdx,
        );
      }
    }
    db.run(
      `UPDATE fs_nodes
          SET size = ?, mtime = ?, content_id = NULL,
              rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode = ?`,
      length,
      mtime,
      file.inode,
    );
  });
}

/** Add a second path for one inode and refresh its link metadata. */
export function linkRaw(db: SqlDatabase, existingPath: RealPath, newPath: RealPath): void {
  db.transactionSync(() => {
    db.run(BUMP_REV);
    db.run(
      `INSERT INTO fs_paths (path, parent, inode)
       SELECT ?, ?, inode FROM fs_paths WHERE path = ?`,
      newPath,
      dirname(newPath),
      existingPath,
    );
    db.run(
      `UPDATE fs_nodes
          SET nlink = (SELECT count(*) FROM fs_paths WHERE inode = fs_nodes.inode),
              rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)`,
      existingPath,
    );
  });
}

/** Change permission bits for every name of one inode. */
export function chmodRaw(db: SqlDatabase, path: RealPath, mode: number, mtime: number): void {
  db.transactionSync(() => {
    db.run(BUMP_REV);
    db.run(
      `UPDATE fs_nodes
          SET mode = ?, mtime = ?, rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)`,
      mode & PERMISSION_BITS,
      mtime,
      path,
    );
  });
}

const RENAME_SUBTREE = `UPDATE fs_paths
   SET path   = ? || substr(path, ? + 1),
       parent = CASE WHEN parent = ? THEN ?
                     ELSE ? || substr(parent, ? + 1) END
 WHERE path >= ? || '/' AND path < ?`;

/** Move a validated path, replacing a validated file or empty directory. */
export function renameRaw(db: SqlDatabase, oldPath: RealPath, newPath: RealPath): void {
  if (oldPath === newPath) return;
  const oldLength = codePointLength(oldPath);
  db.transactionSync(() => {
    const classified = db.one<RenameRow>(
      `SELECT (SELECT inode FROM fs_paths WHERE path = ?) AS source_inode,
              (SELECT inode FROM fs_paths WHERE path = ?) AS target_inode,
              EXISTS (SELECT 1 FROM fs_paths
                       WHERE path >= ? || '/' AND path < ?) AS target_child`,
      oldPath,
      newPath,
      newPath,
      subtreeSuccessor(newPath),
    );
    if (
      classified !== undefined &&
      classified.source_inode !== null &&
      classified.source_inode === classified.target_inode
    ) {
      db.run(BUMP_REV);
      db.run("DELETE FROM fs_paths WHERE path = ?", oldPath);
      db.run(
        `UPDATE fs_nodes
            SET nlink = (SELECT count(*) FROM fs_paths
                          WHERE inode = fs_nodes.inode),
                rev = (SELECT v FROM fs_meta WHERE k = 'rev')
          WHERE inode = ?`,
        classified.source_inode,
      );
      return;
    }
    if (classified !== undefined && classified.target_child === 1) {
      throw fsError("ENOTEMPTY", "directory not empty", newPath);
    }
    db.run(BUMP_REV);
    db.run(
      `DELETE FROM fs_chunks
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)
          AND 1 = (SELECT count(*) FROM fs_paths
                    WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?))`,
      newPath,
      newPath,
    );
    db.run(
      `DELETE FROM fs_nodes
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)
          AND 1 = (SELECT count(*) FROM fs_paths
                    WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?))`,
      newPath,
      newPath,
    );
    db.run(
      `UPDATE fs_nodes
          SET nlink = (SELECT count(*) - 1 FROM fs_paths
                        WHERE inode = fs_nodes.inode),
              rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)
          AND 1 < (SELECT count(*) FROM fs_paths
                    WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?))`,
      newPath,
      newPath,
    );
    db.run("DELETE FROM fs_paths WHERE path = ?", newPath);
    db.run(
      RENAME_SUBTREE,
      newPath,
      oldLength,
      oldPath,
      newPath,
      newPath,
      oldLength,
      oldPath,
      subtreeSuccessor(oldPath),
    );
    db.run(
      "UPDATE fs_paths SET path = ?, parent = ? WHERE path = ?",
      newPath,
      dirname(newPath),
      oldPath,
    );
    db.run(
      `UPDATE fs_nodes
          SET rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode IN (
          SELECT inode FROM fs_paths
           WHERE path = ? OR (path >= ? || '/' AND path < ?)
        )`,
      newPath,
      newPath,
      subtreeSuccessor(newPath),
    );
  });
}
