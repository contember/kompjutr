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
import type { ReadBatch, ReadOptions } from "../types.js";
import { DEFAULT_READ_BUDGET } from "./read-limits.js";
import { realpath } from "./resolve.js";

export { readFileHandles } from "./read-handles.js";
export { DEFAULT_READ_BUDGET, MAX_HANDLE_MATERIALIZE_BYTES } from "./read-limits.js";

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

function expectedChunkCount(size: number): number {
  return Math.ceil(size / CHUNK_SIZE);
}

function expectedChunkLength(target: { size: number }, index: number): number {
  return Math.min(CHUNK_SIZE, target.size - index * CHUNK_SIZE);
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
