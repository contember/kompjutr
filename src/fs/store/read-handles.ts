import { readBlob, type SqlDatabase } from "../../db/db.js";
import { normalize } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type { HandleReadBatch, RealPath, RegularFileHandle } from "../types.js";
import { DEFAULT_READ_BUDGET, MAX_HANDLE_MATERIALIZE_BYTES } from "./read-limits.js";

const LOOKUP_BATCH_BYTES = 1_500_000;
const HANDLE_BATCH_MAX = 5_000;

interface HandleChunkRow {
  ord: number;
  current_inode: number | null;
  current_type: string | null;
  current_size: number | null;
  current_rev: number | null;
  chunk_count: number;
  chunk_bytes: number;
  first_idx: number | null;
  last_idx: number | null;
  non_blob_chunks: number;
  non_integer_indices: number;
  invalid_chunk_sizes: number;
  content_ok: number;
  idx: number | null;
  storage_type: string;
  bytes: unknown;
}

const HANDLE_CHUNKS_SQL = `WITH requested AS (
       SELECT CAST(key AS INTEGER) AS ord,
              json_extract(value, '$.path') AS path,
              json_extract(value, '$.ino') AS expected_inode,
              json_extract(value, '$.size') AS expected_size,
              json_extract(value, '$.rev') AS expected_rev
         FROM json_each(?)
     ), current AS (
       SELECT requested.ord AS ord,
              requested.expected_inode AS expected_inode,
              requested.expected_size AS expected_size,
              requested.expected_rev AS expected_rev,
              fs_paths.inode AS current_inode,
              fs_nodes.type AS current_type,
              fs_nodes.size AS current_size,
              fs_nodes.rev AS current_rev,
              count(fs_chunks.idx) AS chunk_count,
              coalesce(sum(length(fs_chunks.bytes)), 0) AS chunk_bytes,
              min(fs_chunks.idx) AS first_idx,
              max(fs_chunks.idx) AS last_idx,
              coalesce(sum(CASE
                WHEN fs_chunks.idx IS NOT NULL AND typeof(fs_chunks.bytes) <> 'blob' THEN 1
                ELSE 0
              END), 0) AS non_blob_chunks,
              coalesce(sum(CASE
                WHEN fs_chunks.idx IS NOT NULL AND typeof(fs_chunks.idx) <> 'integer' THEN 1
                ELSE 0
              END), 0) AS non_integer_indices,
              coalesce(sum(CASE
                WHEN fs_chunks.idx IS NOT NULL
                 AND length(fs_chunks.bytes) <> min(?, fs_nodes.size - fs_chunks.idx * ?)
                THEN 1
                ELSE 0
              END), 0) AS invalid_chunk_sizes
         FROM requested
         LEFT JOIN fs_paths
           ON fs_paths.path = requested.path
          AND fs_paths.inode = requested.expected_inode
         LEFT JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode
         LEFT JOIN fs_chunks ON fs_chunks.inode = fs_nodes.inode
        GROUP BY requested.ord, requested.expected_inode, requested.expected_size,
                 requested.expected_rev, fs_paths.inode, fs_nodes.type, fs_nodes.size, fs_nodes.rev
     ), checked AS (
       SELECT current.*,
              CASE
                WHEN typeof(current.current_size) = 'integer' AND current.current_size >= 0
                THEN CAST((current.current_size + ? - 1) / ? AS INTEGER)
                ELSE -1
              END AS expected_chunks
         FROM current
     ), validated AS (
       SELECT checked.*,
              CASE WHEN checked.current_inode = checked.expected_inode
                     AND checked.current_type = 'file'
                     AND checked.current_size = checked.expected_size
                     AND checked.current_rev = checked.expected_rev
                     AND checked.current_size <= ?
                     AND checked.chunk_count = checked.expected_chunks
                     AND checked.chunk_bytes = checked.current_size
                     AND checked.non_blob_chunks = 0
                     AND checked.non_integer_indices = 0
                     AND checked.invalid_chunk_sizes = 0
                     AND ((checked.expected_chunks = 0
                           AND checked.first_idx IS NULL AND checked.last_idx IS NULL)
                       OR (checked.expected_chunks > 0
                           AND checked.first_idx = 0
                           AND checked.last_idx = checked.expected_chunks - 1))
                   THEN 1 ELSE 0 END AS content_ok
         FROM checked
     ), batch AS (
       SELECT min(content_ok) AS all_valid FROM validated
     )
     SELECT validated.ord AS ord,
            validated.current_inode AS current_inode,
            validated.current_type AS current_type,
            validated.current_size AS current_size,
            validated.current_rev AS current_rev,
            validated.chunk_count AS chunk_count,
            validated.chunk_bytes AS chunk_bytes,
            validated.first_idx AS first_idx,
            validated.last_idx AS last_idx,
            validated.non_blob_chunks AS non_blob_chunks,
            validated.non_integer_indices AS non_integer_indices,
            validated.invalid_chunk_sizes AS invalid_chunk_sizes,
            validated.content_ok AS content_ok,
            fs_chunks.idx AS idx,
            typeof(fs_chunks.bytes) AS storage_type,
            substr(fs_chunks.bytes, 1, ?) AS bytes
       FROM validated
       LEFT JOIN fs_chunks
         ON (SELECT all_valid FROM batch) = 1
        AND validated.content_ok = 1
        AND fs_chunks.inode = validated.current_inode
        AND fs_chunks.idx > ?
      ORDER BY validated.ord, fs_chunks.idx
      LIMIT ?`;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateHandleInputs(handles: readonly RegularFileHandle[]): void {
  if (handles.length > HANDLE_BATCH_MAX) {
    throw new Error(`readFileHandles: at most ${HANDLE_BATCH_MAX} handles may be read at once`);
  }
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    if (
      typeof handle.path !== "string" ||
      !handle.path.startsWith("/") ||
      normalize(handle.path) !== handle.path
    ) {
      throw new Error(`readFileHandles: handle ${index} has an invalid canonical path`);
    }
    if (
      !Number.isSafeInteger(handle.ino) ||
      !Number.isSafeInteger(handle.size) ||
      handle.size < 0 ||
      !Number.isSafeInteger(handle.rev)
    ) {
      throw new Error(`readFileHandles: handle ${index} has invalid metadata`);
    }
  }
}

function appendRemaining(
  out: RegularFileHandle[],
  handles: readonly RegularFileHandle[],
  from: number,
): void {
  for (let index = from; index < handles.length; index++) {
    const handle = handles[index];
    if (handle !== undefined) out.push(handle);
  }
}

function corrupt(inode: number, detail: string): Error {
  return Object.assign(new Error(`EIO: corrupt chunks for inode ${inode}: ${detail}`), {
    code: "EIO",
  });
}

function stale(handle: RegularFileHandle): Error {
  return Object.assign(new Error(`ESTALE: file handle is stale, '${handle.path}'`), {
    code: "ESTALE",
  });
}

function efbig(handle: RegularFileHandle, size: number): Error {
  return Object.assign(
    new Error(
      `EFBIG: '${handle.path}' is ${size} bytes; handle reads are capped at ${MAX_HANDLE_MATERIALIZE_BYTES}`,
    ),
    { code: "EFBIG" },
  );
}

function expectedChunkCount(size: number): number {
  return Math.ceil(size / CHUNK_SIZE);
}

function expectedChunkLength(target: { size: number }, index: number): number {
  return Math.min(CHUNK_SIZE, target.size - index * CHUNK_SIZE);
}

function validateHandleRow(handle: RegularFileHandle, row: HandleChunkRow): number {
  if (
    row.current_inode !== handle.ino ||
    row.current_type !== "file" ||
    row.current_size !== handle.size ||
    row.current_rev !== handle.rev
  ) {
    throw stale(handle);
  }
  if (!Number.isSafeInteger(row.current_size) || row.current_size < 0) {
    throw corrupt(handle.ino, "file size is not a non-negative safe integer");
  }
  const expected = expectedChunkCount(row.current_size);
  if (
    row.chunk_count !== expected ||
    row.chunk_bytes !== row.current_size ||
    row.non_blob_chunks !== 0 ||
    row.non_integer_indices !== 0 ||
    row.invalid_chunk_sizes !== 0 ||
    (expected === 0
      ? row.first_idx !== null || row.last_idx !== null
      : row.first_idx !== 0 || row.last_idx !== expected - 1)
  ) {
    throw corrupt(handle.ino, "metadata does not describe contiguous BLOB content");
  }
  return row.current_size;
}

function encodeHandles(handles: readonly RegularFileHandle[]): string {
  return JSON.stringify(
    handles.map((handle) => ({
      path: handle.path,
      ino: handle.ino,
      size: handle.size,
      rev: handle.rev,
    })),
  );
}

function readHandlePage(
  db: SqlDatabase,
  handles: readonly RegularFileHandle[],
  afterIdx: number,
  rowLimit: number,
): HandleChunkRow[] {
  return db.all<HandleChunkRow>(
    HANDLE_CHUNKS_SQL,
    encodeHandles(handles),
    CHUNK_SIZE,
    CHUNK_SIZE,
    CHUNK_SIZE,
    CHUNK_SIZE,
    MAX_HANDLE_MATERIALIZE_BYTES,
    CHUNK_SIZE + 1,
    afterIdx,
    rowLimit,
  );
}

function readHandleGroup(
  db: SqlDatabase,
  handles: readonly RegularFileHandle[],
  budget: number,
): Map<RealPath, Uint8Array> {
  const rowLimit = handles.length + Math.ceil(budget / CHUNK_SIZE);
  const rows = readHandlePage(db, handles, -1, rowLimit);
  const files = new Map<RealPath, Uint8Array>();
  const next = new Map<number, number>();
  const sizes = new Map<number, number>();
  for (const row of rows) {
    const handle = handles[row.ord];
    if (handle === undefined)
      throw new Error(`readFileHandles: unexpected handle index ${row.ord}`);
    const size = validateHandleRow(handle, row);
    if (size > MAX_HANDLE_MATERIALIZE_BYTES) throw efbig(handle, size);
    if (row.content_ok !== 1) {
      throw corrupt(handle.ino, "SQL validation disagreed with file metadata");
    }
    sizes.set(row.ord, size);
  }
  for (let ord = 0; ord < handles.length; ord++) {
    const handle = handles[ord];
    if (handle === undefined) continue;
    const size = sizes.get(ord);
    if (size === undefined) throw corrupt(handle.ino, "handle metadata row is missing");
    files.set(handle.path, new Uint8Array(size));
    next.set(ord, 0);
  }
  for (const row of rows) {
    const handle = handles[row.ord];
    if (handle === undefined)
      throw new Error(`readFileHandles: unexpected handle index ${row.ord}`);
    if (row.idx === null) continue;
    const expectedIndex = next.get(row.ord) ?? 0;
    if (row.idx !== expectedIndex) throw corrupt(handle.ino, `missing chunk ${expectedIndex}`);
    if (row.storage_type !== "blob") throw corrupt(handle.ino, `chunk ${row.idx} is not a BLOB`);
    const bytes = readBlob(row.bytes);
    const size = sizes.get(row.ord);
    if (size === undefined) throw corrupt(handle.ino, "validated size is missing");
    if (bytes.length !== expectedChunkLength({ size }, row.idx)) {
      throw corrupt(handle.ino, `invalid chunk ${row.idx} size`);
    }
    files.get(handle.path)?.set(bytes, row.idx * CHUNK_SIZE);
    next.set(row.ord, expectedIndex + 1);
  }
  for (let ord = 0; ord < handles.length; ord++) {
    const handle = handles[ord];
    if (handle === undefined) continue;
    const size = sizes.get(ord);
    if (size === undefined) throw corrupt(handle.ino, "validated size is missing");
    if ((next.get(ord) ?? 0) !== expectedChunkCount(size)) {
      throw corrupt(handle.ino, `missing chunk ${next.get(ord) ?? 0}`);
    }
  }
  return files;
}

function readLargeHandle(db: SqlDatabase, handle: RegularFileHandle, budget: number): Uint8Array {
  const rowLimit = Math.max(1, Math.floor(budget / CHUNK_SIZE));
  let out: Uint8Array | undefined;
  let size: number | undefined;
  let lastIdx: number | undefined;
  let afterIdx = -1;
  for (;;) {
    const rows = readHandlePage(db, [handle], afterIdx, rowLimit);
    if (rows.length === 0) break;
    for (const row of rows) {
      const validatedSize = validateHandleRow(handle, row);
      if (validatedSize > MAX_HANDLE_MATERIALIZE_BYTES) throw efbig(handle, validatedSize);
      if (row.content_ok !== 1) {
        throw corrupt(handle.ino, "SQL validation disagreed with file metadata");
      }
      if (out === undefined) {
        size = validatedSize;
        lastIdx = expectedChunkCount(validatedSize) - 1;
        out = new Uint8Array(validatedSize);
      }
      if (row.idx === null) break;
      if (row.idx !== afterIdx + 1) {
        throw corrupt(handle.ino, `missing chunk ${afterIdx + 1}`);
      }
      if (row.storage_type !== "blob") throw corrupt(handle.ino, `chunk ${row.idx} is not a BLOB`);
      const bytes = readBlob(row.bytes);
      if (bytes.length !== expectedChunkLength({ size: validatedSize }, row.idx)) {
        throw corrupt(handle.ino, `invalid chunk ${row.idx} size`);
      }
      out.set(bytes, row.idx * CHUNK_SIZE);
      afterIdx = row.idx;
    }
    if (lastIdx !== undefined && afterIdx >= lastIdx) break;
    if (rows.length < rowLimit) break;
  }
  if (out === undefined || size === undefined || lastIdx === undefined) {
    throw corrupt(handle.ino, "handle metadata row is missing");
  }
  if (size === 0) return out;
  if (afterIdx !== lastIdx) throw corrupt(handle.ino, `missing chunk ${afterIdx + 1}`);
  return out;
}

/** Read validated discovery handles without resolving or looking up paths again. */
export function readFileHandles(
  db: SqlDatabase,
  handles: readonly RegularFileHandle[],
  options: { budget?: number } = {},
): HandleReadBatch {
  const budget = options.budget ?? DEFAULT_READ_BUDGET;
  if (!(budget > 0)) throw new Error("readFileHandles: budget must be positive");
  if (budget > DEFAULT_READ_BUDGET) {
    throw new Error(`readFileHandles: budget must not exceed ${DEFAULT_READ_BUDGET} bytes`);
  }
  validateHandleInputs(handles);

  const files = new Map<RealPath, Uint8Array>();
  const remaining: RegularFileHandle[] = [];
  const pending: RegularFileHandle[] = [];
  let pendingBytes = 0;
  let pendingBindingBytes = 2;

  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    const bindingBytes =
      utf8Length(
        JSON.stringify({
          path: handle.path,
          ino: handle.ino,
          size: handle.size,
          rev: handle.rev,
        }),
      ) + 1;
    if (
      pending.length >= HANDLE_BATCH_MAX ||
      pendingBindingBytes + bindingBytes > LOOKUP_BATCH_BYTES ||
      (pending.length > 0 && pendingBytes + handle.size > budget)
    ) {
      appendRemaining(remaining, handles, index);
      break;
    }
    if (handle.size > budget) {
      if (pending.length > 0) {
        appendRemaining(remaining, handles, index);
        break;
      }
      files.set(handle.path, readLargeHandle(db, handle, budget));
      appendRemaining(remaining, handles, index + 1);
      break;
    }
    pending.push(handle);
    pendingBytes += handle.size;
    pendingBindingBytes += bindingBytes;
  }
  if (pending.length > 0) {
    for (const [path, bytes] of readHandleGroup(db, pending, budget)) files.set(path, bytes);
  }
  return { files, remaining };
}
