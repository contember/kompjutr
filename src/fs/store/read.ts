// P2 from §7.0 — bulk read. One statement per byte budget.
//
// The budget bounds every SQL *statement*, not the call. Selecting by inode
// alone returns every chunk of a 50 MB file in one result set and the
// database wrapper materialises the whole thing; a Worker has 128 MB for the
// entire isolate. So the chunk query is paged by `(inode, idx)` with a row
// limit derived from the budget, and a file that alone exceeds the budget is
// either reported in `remaining` or assembled from bounded pages — never
// pulled across the wire in one result set.

import { readBlob, type SqlDatabase } from "../../db/db.js";
import { normalize } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type {
  HandleReadBatch,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
} from "../types.js";
import { realpath } from "./resolve.js";

/** Bytes per statement, below the platform's 2 MB bound-value ceiling. */
export const DEFAULT_READ_BUDGET = 1_500_000;

/** Bounds both the JSON binding and each path-lookup result set. */
const LOOKUP_BATCH_BYTES = 1_500_000;

interface NodeRow {
  path: string;
  inode: number;
  type: string;
  size: number;
  chunk_count: number;
  chunk_bytes: number;
  first_idx: number | null;
  last_idx: number | null;
}

interface ChunkRow {
  inode: number;
  idx: number;
  bytes: unknown;
}

interface RangeRow {
  idx: number;
  bytes: unknown;
}

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

/** Leaves room for query results and runtime overhead below the 100 MB gate. */
export const MAX_HANDLE_MATERIALIZE_BYTES = 32 * 1024 * 1024;

/** An inode to assemble, and the length `fs_nodes` says it has. */
interface Target {
  inode: number;
  size: number;
}

interface Planned extends Target {
  /** The canonical path this target was found under. */
  real: string;
}

// `json_each(?)` binds the whole path list as ONE parameter, so the
// 100-parameter ceiling is never approached however long the list is.
const LOOKUP_MANY_SQL = `SELECT p.path AS path, p.inode AS inode, n.type AS type, n.size AS size,
       count(c.idx) AS chunk_count, coalesce(sum(length(c.bytes)), 0) AS chunk_bytes,
       min(c.idx) AS first_idx, max(c.idx) AS last_idx
     FROM fs_paths p
     JOIN fs_nodes n ON n.inode = p.inode
     LEFT JOIN fs_chunks c ON c.inode = p.inode
    WHERE p.path IN (SELECT value FROM json_each(?))
    GROUP BY p.path, p.inode, n.type, n.size`;

const LOOKUP_ONE_SQL = `SELECT p.path AS path, p.inode AS inode, n.type AS type, n.size AS size,
       count(c.idx) AS chunk_count, coalesce(sum(length(c.bytes)), 0) AS chunk_bytes,
       min(c.idx) AS first_idx, max(c.idx) AS last_idx
     FROM fs_paths p
     JOIN fs_nodes n ON n.inode = p.inode
     LEFT JOIN fs_chunks c ON c.inode = p.inode
    WHERE p.path = ?
    GROUP BY p.path, p.inode, n.type, n.size`;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function lookupMany(db: SqlDatabase, paths: readonly string[]): NodeRow[] {
  const out: NodeRow[] = [];
  let items: string[] = [];
  let bytes = 2;

  const flush = (): void => {
    if (items.length === 0) return;
    out.push(...db.all<NodeRow>(LOOKUP_MANY_SQL, `[${items.join(",")}]`));
    items = [];
    bytes = 2;
  };

  for (const path of paths) {
    const item = JSON.stringify(path);
    const itemBytes = utf8Length(item);
    if (items.length > 0 && bytes + itemBytes + 1 > LOOKUP_BATCH_BYTES) flush();
    items.push(item);
    bytes += itemBytes + 1;
  }
  flush();
  return out;
}

// Row-value comparison so the resume predicate rides the (inode, idx)
// primary key rather than turning into a scan with an OR.
const CHUNK_PAGE_SQL = `SELECT c.inode AS inode, c.idx AS idx,
       substr(c.bytes, 1, ?) AS bytes
     FROM fs_chunks c
    WHERE c.inode IN (SELECT value FROM json_each(?))
      AND (c.inode, c.idx) > (?, ?)
    ORDER BY c.inode, c.idx
    LIMIT ?`;

const CHUNK_RANGE_SQL = `SELECT c.idx AS idx, substr(c.bytes, 1, ?) AS bytes
     FROM fs_chunks c
    WHERE c.inode = ? AND c.idx > ? AND c.idx <= ?
    ORDER BY c.idx
    LIMIT ?`;

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

/** Also bounds metadata-only rows for large batches of empty files. */
const HANDLE_BATCH_MAX = 5_000;

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

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: "ENOENT",
  });
}

function eisdir(path: string): Error {
  return Object.assign(new Error(`EISDIR: illegal operation on a directory, '${path}'`), {
    code: "EISDIR",
  });
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

function validatedTarget(row: NodeRow): Target {
  const expected = expectedChunkCount(row.size);
  if (
    row.size < 0 ||
    row.chunk_count !== expected ||
    row.chunk_bytes !== row.size ||
    (expected === 0
      ? row.first_idx !== null || row.last_idx !== null
      : row.first_idx !== 0 || row.last_idx !== expected - 1)
  ) {
    throw corrupt(row.inode, "metadata does not describe contiguous file content");
  }
  return { inode: row.inode, size: row.size };
}

/**
 * Rows one chunk statement may carry.
 *
 * A batch that fits the budget is asked for exactly the chunks its recorded
 * sizes imply, so it costs one statement and cannot return more than the
 * budget. A single file that does not fit is capped at whole chunks instead
 * — a statement can never carry less than one chunk, so `CHUNK_SIZE` is the
 * floor on any bound expressible here.
 */
function rowLimitFor(targets: readonly Target[], budget: number): number {
  let bytes = 0;
  let rows = 0;
  for (const target of targets) {
    bytes += target.size;
    rows += Math.ceil(target.size / CHUNK_SIZE);
  }
  if (bytes <= budget) return Math.max(1, rows);
  return Math.max(1, Math.floor(budget / CHUNK_SIZE));
}

/**
 * One inode, paged on `idx` alone.
 *
 * The multi-inode query's row-value resume is not pushed into the
 * `(inode, idx)` seek — `EXPLAIN QUERY PLAN` shows `inode=?` only — so a
 * file taking many pages would re-walk its own index entries once per page.
 * This shape seeks straight to the resume point, which is what the
 * over-budget file needs.
 */
function readOne(db: SqlDatabase, target: Target, rowLimit: number): Uint8Array {
  const out = new Uint8Array(target.size);
  if (target.size === 0) return out;

  const lastIdx = Math.ceil(target.size / CHUNK_SIZE) - 1;
  let afterIdx = -1;
  while (afterIdx < lastIdx) {
    const rows = db.all<RangeRow>(
      CHUNK_RANGE_SQL,
      CHUNK_SIZE + 1,
      target.inode,
      afterIdx,
      lastIdx,
      rowLimit,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.idx !== afterIdx + 1) throw corrupt(target.inode, `missing chunk ${afterIdx + 1}`);
      afterIdx = row.idx;
      const at = row.idx * CHUNK_SIZE;
      const bytes = readBlob(row.bytes);
      const expected = expectedChunkLength(target, row.idx);
      if (bytes.length !== expected) throw corrupt(target.inode, `invalid chunk ${row.idx} size`);
      out.set(bytes, at);
    }
  }
  if (afterIdx !== lastIdx) throw corrupt(target.inode, `missing chunk ${afterIdx + 1}`);
  return out;
}

/**
 * Assemble every target from `fs_chunks`, paging by `(inode, idx)`.
 *
 * One statement when the recorded sizes are honest, which is the whole
 * point; the loop exists so a store that disagrees with itself costs extra
 * statements rather than an unbounded result set.
 */
function readTargets(
  db: SqlDatabase,
  targets: readonly Target[],
  rowLimit: number,
): Map<number, Uint8Array> {
  const only = targets.length === 1 ? targets[0] : undefined;
  if (only !== undefined) return new Map([[only.inode, readOne(db, only, rowLimit)]]);

  const buffers = new Map<number, Uint8Array>();
  const filled = new Map<number, number>();
  const nextIndex = new Map<number, number>();
  const targetsByInode = new Map<number, Target>();
  const inodes: number[] = [];
  let outstanding = 0;
  for (const target of targets) {
    buffers.set(target.inode, new Uint8Array(target.size));
    filled.set(target.inode, 0);
    nextIndex.set(target.inode, 0);
    targetsByInode.set(target.inode, target);
    inodes.push(target.inode);
    if (target.size > 0) outstanding++;
  }

  const list = JSON.stringify(inodes);
  let afterInode = -1;
  let afterIdx = -1;

  while (outstanding > 0) {
    const rows = db.all<ChunkRow>(
      CHUNK_PAGE_SQL,
      CHUNK_SIZE + 1,
      list,
      afterInode,
      afterIdx,
      rowLimit,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      afterInode = row.inode;
      afterIdx = row.idx;
      const buffer = buffers.get(row.inode);
      const target = targetsByInode.get(row.inode);
      if (buffer === undefined || target === undefined) continue;
      const expectedIndex = nextIndex.get(row.inode) ?? 0;
      if (row.idx !== expectedIndex) throw corrupt(row.inode, `missing chunk ${expectedIndex}`);
      const at = row.idx * CHUNK_SIZE;
      const bytes = readBlob(row.bytes);
      const expected = expectedChunkLength(target, row.idx);
      if (bytes.length !== expected) throw corrupt(row.inode, `invalid chunk ${row.idx} size`);
      buffer.set(bytes, at);
      nextIndex.set(row.inode, expectedIndex + 1);
      const before = filled.get(row.inode) ?? 0;
      const after = before + bytes.length;
      filled.set(row.inode, after);
      if (before < buffer.length && after >= buffer.length) outstanding--;
    }
    if (rows.length < rowLimit) break;
  }

  if (outstanding > 0) throw corrupt(afterInode, "file content ended before its recorded size");

  return buffers;
}

function lookupFile(db: SqlDatabase, path: string): Target {
  const real = realpath(db, path);
  const row = db.one<NodeRow>(LOOKUP_ONE_SQL, real);
  if (row === undefined) throw enoent(path);
  if (row.type === "dir") throw eisdir(path);
  if (row.type !== "file") throw enoent(path);
  return validatedTarget(row);
}

/**
 * Several files in one round trip, under a byte budget.
 *
 * Paths are taken as real paths — the ones `scan` produced. Resolving each
 * through `realpath` would cost a statement per path and put the 9,329-file
 * gate out of reach; a lexical path with a symlinked ancestor therefore
 * reads as missing. `readFile` is the single-path entry point that resolves.
 *
 * A path that is absent, is a directory, or is a symlink yields no entry and
 * is not an error. A file is complete in `files` or listed in `remaining`,
 * never split between them.
 */
export function readFiles(
  db: SqlDatabase,
  paths: readonly string[],
  options: ReadOptions = {},
): ReadBatch {
  const budget = options.budget ?? DEFAULT_READ_BUDGET;
  if (!(budget > 0)) throw new Error("readFiles: budget must be positive");
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("readFiles: maxBytes must be a positive safe integer");
  }

  // Deduplicate on the canonical path; key the result by the caller's string.
  const order: string[] = [];
  const callers = new Map<string, string[]>();
  for (const input of paths) {
    const real = normalize(input);
    const seen = callers.get(real);
    if (seen === undefined) {
      callers.set(real, [input]);
      order.push(real);
    } else {
      seen.push(input);
    }
  }

  const files = new Map<string, Uint8Array>();
  const remaining: string[] = [];
  if (order.length === 0) return { files, remaining };

  const found = new Map<string, NodeRow>();
  for (const row of lookupMany(db, order)) {
    found.set(row.path, row);
  }

  const deliver = (planned: readonly Planned[], contents: Map<number, Uint8Array>): void => {
    for (const entry of planned) {
      const bytes = contents.get(entry.inode);
      if (bytes === undefined) continue;
      for (const caller of callers.get(entry.real) ?? []) files.set(caller, bytes);
    }
  };

  let pending: Planned[] = [];
  let pendingBytes = 0;
  let selectedBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    deliver(pending, readTargets(db, pending, rowLimitFor(pending, budget)));
    pending = [];
    pendingBytes = 0;
  };

  let stopped = order.length;
  for (let index = 0; index < order.length; index++) {
    const real = order[index];
    if (real === undefined) continue;
    const row = found.get(real);
    if (row === undefined || row.type !== "file") continue;
    const target = validatedTarget(row);

    if (selectedBytes + target.size > maxBytes) {
      flush();
      stopped = index;
      break;
    }

    if (target.size > budget) {
      if (options.deferOversized === true) {
        flush();
        stopped = index;
        break;
      }
      // Deferring is only safe while the caller can still make progress by
      // re-calling; if nothing has been read yet, re-calling would loop
      // forever, so page this one file instead.
      if (files.size > 0 || pending.length > 0) {
        stopped = index;
        break;
      }
      const single: Planned = { real, ...target };
      deliver([single], readTargets(db, [single], rowLimitFor([single], budget)));
      selectedBytes += target.size;
      continue;
    }

    if (pendingBytes + target.size > budget) flush();
    pending.push({ real, ...target });
    pendingBytes += target.size;
    selectedBytes += target.size;
  }
  flush();

  for (let index = stopped; index < order.length; index++) {
    const real = order[index];
    if (real === undefined) continue;
    for (const caller of callers.get(real) ?? []) remaining.push(caller);
  }

  return { files, remaining };
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

/** The whole file. Follows symlinks; throws ENOENT when it is not there. */
export function readFile(db: SqlDatabase, path: string): Uint8Array {
  const target = lookupFile(db, path);
  const contents = readTargets(db, [target], rowLimitFor([target], DEFAULT_READ_BUDGET));
  return contents.get(target.inode) ?? new Uint8Array(0);
}

/** Up to `length` bytes at `offset`. Short only at EOF. */
export function readRange(
  db: SqlDatabase,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  const target = lookupFile(db, path);
  const start = Math.max(0, Math.trunc(offset));
  const end = Math.min(target.size, start + Math.max(0, Math.trunc(length)));
  if (end <= start) return new Uint8Array(0);

  const out = new Uint8Array(end - start);
  const lastIdx = Math.floor((end - 1) / CHUNK_SIZE);
  const rowLimit = Math.max(1, Math.floor(DEFAULT_READ_BUDGET / CHUNK_SIZE));
  let afterIdx = Math.floor(start / CHUNK_SIZE) - 1;

  while (afterIdx < lastIdx) {
    const rows = db.all<RangeRow>(
      CHUNK_RANGE_SQL,
      CHUNK_SIZE + 1,
      target.inode,
      afterIdx,
      lastIdx,
      rowLimit,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.idx !== afterIdx + 1) throw corrupt(target.inode, `missing chunk ${afterIdx + 1}`);
      afterIdx = row.idx;
      const bytes = readBlob(row.bytes);
      const expected = expectedChunkLength(target, row.idx);
      if (bytes.length !== expected) throw corrupt(target.inode, `invalid chunk ${row.idx} size`);
      const chunkStart = row.idx * CHUNK_SIZE;
      const from = Math.max(start, chunkStart);
      const to = Math.min(end, chunkStart + bytes.length);
      if (to > from) out.set(bytes.subarray(from - chunkStart, to - chunkStart), from - start);
    }
  }

  if (afterIdx !== lastIdx) throw corrupt(target.inode, `missing chunk ${afterIdx + 1}`);

  return out;
}
