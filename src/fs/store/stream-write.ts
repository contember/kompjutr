// Atomic streamed writes for shell redirects. Content stays in bounded chunks;
// an upstream exception rolls the complete transaction back.

import { blob, type SqlDatabase } from "../../sqlite/db.js";
import { filesystemError as fsError } from "../errors.js";
import { dirname, normalize } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type { RealPath } from "../types.js";
import { allocateInodes, bumpRev } from "./meta.js";

const DEFAULT_FILE_MODE = 0o644;
const MAX_STREAM_BYTES = 96 * 1024 * 1024;
const MAX_CONTENT_STATEMENTS = 900;

interface TargetRow {
  inode: unknown;
  type: unknown;
  size: unknown;
  chunk_count: unknown;
  chunk_bytes: unknown;
  first_idx: unknown;
  last_idx: unknown;
  invalid_chunks: unknown;
}

interface ParentRow {
  path: unknown;
  type: unknown;
}

const TARGET_SQL = `SELECT p.inode AS inode,
       n.type AS type,
       n.size AS size,
       count(c.idx) AS chunk_count,
       coalesce(sum(length(c.bytes)), 0) AS chunk_bytes,
       min(c.idx) AS first_idx,
       max(c.idx) AS last_idx,
       coalesce(sum(CASE
         WHEN c.idx IS NOT NULL
          AND (typeof(c.idx) <> 'integer'
            OR typeof(c.bytes) <> 'blob'
            OR c.idx < 0
            OR length(c.bytes) <> min(${CHUNK_SIZE}, n.size - c.idx * ${CHUNK_SIZE}))
         THEN 1 ELSE 0 END), 0) AS invalid_chunks
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
  LEFT JOIN fs_chunks c ON c.inode = p.inode
 WHERE p.path = ?
 GROUP BY p.inode, n.type, n.size`;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function existingFile(db: SqlDatabase, path: RealPath): { inode: number; size: number } | null {
  const row = db.one<TargetRow>(TARGET_SQL, path);
  if (row === undefined) return null;
  if (row.type === "dir") throw fsError("EISDIR", "cannot redirect to a directory", path);
  if (row.type !== "file") throw fsError("EINVAL", "redirect target is not a regular file", path);
  const expected = isSafeInteger(row.size) && row.size >= 0 ? Math.ceil(row.size / CHUNK_SIZE) : -1;
  if (
    !isSafeInteger(row.inode) ||
    row.inode < 1 ||
    !isSafeInteger(row.size) ||
    row.size < 0 ||
    !isSafeInteger(row.chunk_count) ||
    !isSafeInteger(row.chunk_bytes) ||
    !isSafeInteger(row.invalid_chunks) ||
    row.chunk_count !== expected ||
    row.chunk_bytes !== row.size ||
    row.invalid_chunks !== 0 ||
    (expected === 0
      ? row.first_idx !== null || row.last_idx !== null
      : row.first_idx !== 0 || row.last_idx !== expected - 1)
  ) {
    throw fsError("EIO", "redirect target has corrupt content", path);
  }
  return { inode: row.inode, size: row.size };
}

function requireParent(db: SqlDatabase, path: RealPath): void {
  const parent = dirname(path);
  const row = db.one<ParentRow>(
    `SELECT p.path AS path, n.type AS type
       FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode
      WHERE p.path = ?`,
    parent,
  );
  if (row === undefined) throw fsError("ENOENT", "redirect parent does not exist", path);
  if (typeof row.path !== "string" || normalize(row.path) !== row.path) {
    throw fsError("EIO", "redirect parent row is corrupt", path);
  }
  if (row.type !== "dir") throw fsError("ENOTDIR", "redirect parent is not a directory", path);
}

/** Write one file in one transaction and one logical revision. */
export function writeFileStream(
  db: SqlDatabase,
  path: RealPath,
  chunks: Iterable<Uint8Array>,
  append: boolean,
  mtime: number,
): void {
  if (!Number.isSafeInteger(mtime)) throw fsError("EINVAL", "mtime must be a safe integer");
  requireParent(db, path);
  const existing = existingFile(db, path);

  db.transactionSync(() => {
    const rev = bumpRev(db);
    const inode = existing?.inode ?? allocateInodes(db, 1);
    if (existing === null) {
      db.run(
        `INSERT INTO fs_nodes
           (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
         VALUES (?, 'file', ?, ?, 0, ?, 1, NULL, NULL)`,
        inode,
        DEFAULT_FILE_MODE,
        mtime,
        rev,
      );
      db.run(
        "INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)",
        path,
        dirname(path),
        inode,
      );
    } else if (!append) {
      db.run("DELETE FROM fs_chunks WHERE inode = ?", inode);
    }

    let offset = append ? (existing?.size ?? 0) : 0;
    let streamed = 0;
    let statements = 0;
    for (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) {
        throw fsError("EINVAL", "redirect stream yielded a non-byte chunk", path);
      }
      if (
        !Number.isSafeInteger(streamed + chunk.length) ||
        streamed + chunk.length > MAX_STREAM_BYTES
      ) {
        throw fsError("EFBIG", `redirect exceeds ${MAX_STREAM_BYTES} bytes`, path);
      }
      let at = 0;
      while (at < chunk.length) {
        if (statements >= MAX_CONTENT_STATEMENTS) {
          throw fsError("EFBIG", "redirect exceeds its SQL statement limit", path);
        }
        const idx = Math.floor(offset / CHUNK_SIZE);
        const within = offset % CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE - within, chunk.length - at);
        if (!Number.isSafeInteger(offset + length)) {
          throw fsError("EFBIG", "redirect target exceeds the safe file-size limit", path);
        }
        const piece = blob(chunk.subarray(at, at + length));
        if (within === 0) {
          db.run("INSERT INTO fs_chunks (inode, idx, bytes) VALUES (?, ?, ?)", inode, idx, piece);
        } else {
          db.run(
            `UPDATE fs_chunks
                SET bytes = CAST(bytes || ? AS BLOB)
              WHERE inode = ? AND idx = ? AND length(bytes) = ?`,
            piece,
            inode,
            idx,
            within,
          );
        }
        statements++;
        streamed += length;
        offset += length;
        at += length;
      }
    }

    db.run(
      `UPDATE fs_nodes
          SET size = ?, mtime = ?, rev = ?, content_id = NULL
        WHERE inode = ?`,
      offset,
      mtime,
      rev,
      inode,
    );
  });
}
