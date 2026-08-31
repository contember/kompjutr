// P3 — the bulk write, and the reason the runtime exists at all. A checkout
// of 9,329 files costs ~420,000 statements through a per-path API; through
// this one it costs a constant handful of metadata statements plus one per
// payload budget of content.
//
// Every statement here is one of two shapes, both from §7.0 of
// docs/archive/plans/standalone-runtime.md:
//
//   * metadata rows carry no BLOBs, so they are fed straight from
//     `json_each(?)` — one statement for thousands of rows;
//   * rows carrying bytes use the concatenated-payload form — one payload
//     BLOB plus a JSON offset array, cut apart with `substr()`.
//
// `substr()` counts BYTES over a BLOB and CHARACTERS over TEXT. Only the
// chunk payload and the `content_id` payload are BLOBs, so byte offsets are
// correct there; every path and every symlink target travels inside the
// JSON, where the question never arises.
//
// `WHERE true` before `ON CONFLICT` is mandatory, not decorative: SQLite
// cannot parse an upsert on a SELECT-fed INSERT without it.

import { blob, type SqlDatabase } from "../../db/db.js";
import { filesystemError as fsError } from "../errors.js";
import { comparePaths } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type { EntryType, WriteEntry, WriteOptions } from "../types.js";
import { allocateInodes, bumpRev } from "./meta.js";
import { realpathsNoFollow } from "./resolve.js";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
/** POSIX reports 0777 for every symlink, and so does dofs (`fs/symlink.ts:61`). */
const DEFAULT_SYMLINK_MODE = 0o777;
const MODE_BITS = 0o7777;

/** Bytes per content statement. The platform caps a bound value at 2 MB. */
const DEFAULT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2_000_000;

/**
 * A JSON argument is a bound value too, so it lives under the same 2 MB
 * ceiling as a BLOB. 1.5 MB leaves room for the framing and still keeps the
 * 9,329-file node batch (~840 KB) in a single statement.
 */
const MAX_JSON_BYTES = 1_500_000;

/** Upper bound on one serialised offset item, so grouping never re-measures. */
const OFFSET_ITEM_BYTES = 80;

interface Planned {
  path: string;
  type: EntryType;
  mode: number;
  mtime: number;
  bytes: Uint8Array | null;
  target: string | null;
  contentId: Uint8Array | null;
}

interface NodeRow {
  inode: number;
  type: EntryType;
  mode: number;
  mtime: number;
  size: number;
  target: string | null;
  contentId: Uint8Array | null;
}

interface PathRow {
  path: string;
  parent: string;
  inode: number;
}

interface ChunkRow {
  inode: number;
  idx: number;
  bytes: Uint8Array;
}

interface ExistingRow {
  path: string;
  inode: number;
  type: EntryType;
}

// -- SQL -------------------------------------------------------------

/**
 * Metadata upsert. Bindings, in the order the `?`s appear: the node JSON,
 * the revision, the concatenated `content_id` payload. The `WITH` clause is
 * there so the JSON binds first and the order reads the way a caller
 * thinks about it.
 *
 * `nlink` is deliberately absent from the DO UPDATE list: it counts
 * `fs_paths` rows, and overwriting a path adds none.
 */
const UPSERT_NODES = `
WITH j(value) AS (SELECT value FROM json_each(?))
INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(value, '$.i'),
       json_extract(value, '$.t'),
       json_extract(value, '$.m'),
       json_extract(value, '$.mt'),
       json_extract(value, '$.s'),
       ?,
       1,
       json_extract(value, '$.l'),
       CASE WHEN json_extract(value, '$.ca') > 0
            THEN substr(?, json_extract(value, '$.ca'), json_extract(value, '$.cn'))
            ELSE NULL END
  FROM j
 WHERE true
ON CONFLICT(inode) DO UPDATE SET
  type = excluded.type,
  mode = excluded.mode,
  mtime = excluded.mtime,
  size = excluded.size,
  rev = excluded.rev,
  link_target = excluded.link_target,
  content_id = excluded.content_id`;

/**
 * New path keys only — an overwritten path keeps its row, so no conflict is
 * reachable and a plain INSERT is right: a duplicate here would be a bug
 * and should raise rather than be absorbed.
 *
 * `ORDER BY j.key` makes "a parent lands before its children" a property of
 * the statement rather than of `json_each`'s undocumented iteration order.
 */
const INSERT_PATHS = `
INSERT INTO fs_paths (path, parent, inode)
SELECT json_extract(j.value, '$.p'),
       json_extract(j.value, '$.pa'),
       json_extract(j.value, '$.i')
  FROM json_each(?) j
 ORDER BY j.key`;

/** P3 verbatim: one payload BLOB, one JSON offset array, byte offsets. */
const UPSERT_CHUNKS = `
INSERT INTO fs_chunks (inode, idx, bytes)
SELECT json_extract(j.value, '$.i'),
       json_extract(j.value, '$.x'),
       substr(?, json_extract(j.value, '$.at'), json_extract(j.value, '$.n'))
  FROM json_each(?) j
 WHERE true
ON CONFLICT(inode, idx) DO UPDATE SET bytes = excluded.bytes`;

const DELETE_CHUNKS = "DELETE FROM fs_chunks WHERE inode IN (SELECT value FROM json_each(?))";

const SELECT_EXISTING = `
SELECT p.path AS path, p.inode AS inode, n.type AS type
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path IN (SELECT value FROM json_each(?))`;

// -- helpers ---------------------------------------------------------

/** UTF-8 length, which is what a bound TEXT value actually costs. */
function utf8Length(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) total += 1;
    else if (unit < 0x800) total += 2;
    else if (unit >= 0xd800 && unit < 0xdc00) {
      total += 4;
      i++;
    } else total += 3;
  }
  return total;
}

function parentOf(path: string): string {
  if (path === "/") return "";
  const slash = path.lastIndexOf("/");
  return slash === 0 ? "/" : path.slice(0, slash);
}

/** Every ancestor of `path` except the root, which is always a directory. */
function strictAncestors(path: string): string[] {
  const out: string[] = [];
  let slash = path.indexOf("/", 1);
  while (slash > 0) {
    out.push(path.slice(0, slash));
    slash = path.indexOf("/", slash + 1);
  }
  return out;
}

function payloadBudgetOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAYLOAD_BYTES;
  }
  return Math.min(Math.floor(requested), MAX_PAYLOAD_BYTES);
}

/**
 * Group pre-serialised JSON items into as few statements as the 2 MB bound
 * value ceiling allows. `sizes` are UTF-8 byte counts, measured when the
 * items were built.
 */
function jsonBatches(items: readonly string[], sizes: readonly number[]): string[] {
  const out: string[] = [];
  let group: string[] = [];
  let bytes = 2;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const size = sizes[i];
    if (item === undefined || size === undefined) continue;
    if (group.length > 0 && bytes + size + 1 > MAX_JSON_BYTES) {
      out.push(`[${group.join(",")}]`);
      group = [];
      bytes = 2;
    }
    group.push(item);
    bytes += size + 1;
  }
  if (group.length > 0) out.push(`[${group.join(",")}]`);
  return out;
}

/** One JSON-fed query per batch, results concatenated. */
function selectByPaths<Row extends object>(
  db: SqlDatabase,
  sql: string,
  paths: readonly string[],
): Row[] {
  if (paths.length === 0) return [];
  const items = paths.map((path) => JSON.stringify(path));
  const sizes = items.map(utf8Length);
  const out: Row[] = [];
  for (const batch of jsonBatches(items, sizes)) out.push(...db.all<Row>(sql, batch));
  return out;
}

function toPlanned(path: string, entry: WriteEntry, now: number): Planned {
  if (entry.target !== undefined && entry.bytes !== undefined) {
    throw fsError("EINVAL", "a write entry carries both bytes and a symlink target", path);
  }
  const mtime = entry.mtime ?? now;
  const contentId = entry.contentId ?? null;
  if (entry.target !== undefined) {
    return {
      path,
      type: "symlink",
      mode: (entry.mode ?? DEFAULT_SYMLINK_MODE) & MODE_BITS,
      mtime,
      bytes: null,
      target: entry.target,
      contentId,
    };
  }
  if (entry.bytes !== undefined) {
    return {
      path,
      type: "file",
      mode: (entry.mode ?? DEFAULT_FILE_MODE) & MODE_BITS,
      mtime,
      bytes: entry.bytes,
      target: null,
      contentId,
    };
  }
  return {
    path,
    type: "dir",
    mode: (entry.mode ?? DEFAULT_DIR_MODE) & MODE_BITS,
    mtime,
    bytes: null,
    target: null,
    contentId: null,
  };
}

function implicitDirectory(inode: number, now: number): NodeRow {
  return {
    inode,
    type: "dir",
    mode: DEFAULT_DIR_MODE,
    mtime: now,
    size: 0,
    target: null,
    contentId: null,
  };
}

function nodeRowOf(entry: Planned, inode: number): NodeRow {
  let size = 0;
  if (entry.type === "file") size = entry.bytes?.length ?? 0;
  // POSIX: a symlink's size is the byte length of its target.
  else if (entry.type === "symlink") size = utf8Length(entry.target ?? "");
  return {
    inode,
    type: entry.type,
    mode: entry.mode,
    mtime: entry.mtime,
    size,
    target: entry.target,
    contentId: entry.contentId,
  };
}

// -- writers ---------------------------------------------------------

/**
 * One statement per 1.5 MB of JSON, with the `content_id`s riding along as
 * one concatenated BLOB — JSON cannot carry bytes, and hex plus `unhex()`
 * would assume a SQLite version we have not verified on the Durable Object.
 */
function writeNodes(db: SqlDatabase, rows: readonly NodeRow[], rev: number): void {
  let group: NodeRow[] = [];
  let jsonBytes = 2;
  let idBytes = 0;

  const flush = (): void => {
    if (group.length === 0) return;
    const ids = new Uint8Array(idBytes);
    const items: string[] = [];
    let at = 0;
    for (const row of group) {
      const id = row.contentId;
      let start = 0;
      if (id !== null) {
        ids.set(id, at);
        start = at + 1; // substr() is 1-based
        at += id.length;
      }
      items.push(
        `{"i":${row.inode},"t":${JSON.stringify(row.type)},"m":${row.mode},` +
          `"mt":${row.mtime},"s":${row.size},"l":${JSON.stringify(row.target)},` +
          `"ca":${start},"cn":${id?.length ?? 0}}`,
      );
    }
    db.run(UPSERT_NODES, `[${items.join(",")}]`, rev, blob(ids));
    group = [];
    jsonBytes = 2;
    idBytes = 0;
  };

  for (const row of rows) {
    // Upper bound: the fixed keys plus generous room for the numbers.
    const estimate = 96 + utf8Length(JSON.stringify(row.target));
    const idSize = row.contentId?.length ?? 0;
    if (
      group.length > 0 &&
      (jsonBytes + estimate > MAX_JSON_BYTES || idBytes + idSize > MAX_PAYLOAD_BYTES)
    ) {
      flush();
    }
    group.push(row);
    jsonBytes += estimate;
    idBytes += idSize;
  }
  flush();
}

function writePaths(db: SqlDatabase, rows: readonly PathRow[]): void {
  if (rows.length === 0) return;
  const items = rows.map(
    (row) =>
      `{"p":${JSON.stringify(row.path)},"pa":${JSON.stringify(row.parent)},"i":${row.inode}}`,
  );
  const sizes = items.map(utf8Length);
  for (const batch of jsonBatches(items, sizes)) db.run(INSERT_PATHS, batch);
}

/** P3. One statement per payload budget, whatever the file count. */
function writeChunks(db: SqlDatabase, rows: readonly ChunkRow[], budget: number): void {
  let group: ChunkRow[] = [];
  let items: string[] = [];
  let payloadBytes = 0;
  let jsonBytes = 2;

  const flush = (): void => {
    if (group.length === 0) return;
    const payload = new Uint8Array(payloadBytes);
    let at = 0;
    for (const row of group) {
      payload.set(row.bytes, at);
      at += row.bytes.length;
    }
    db.run(UPSERT_CHUNKS, blob(payload), `[${items.join(",")}]`);
    group = [];
    items = [];
    payloadBytes = 0;
    jsonBytes = 2;
  };

  for (const row of rows) {
    const overBudget = payloadBytes + row.bytes.length > budget;
    const overJson = jsonBytes + OFFSET_ITEM_BYTES > MAX_JSON_BYTES;
    if (group.length > 0 && (overBudget || overJson)) flush();
    // Offsets are into the payload this row is about to join, so the item
    // is built after any flush has reset the cursor to zero.
    const item = `{"i":${row.inode},"x":${row.idx},"at":${payloadBytes + 1},"n":${row.bytes.length}}`;
    group.push(row);
    items.push(item);
    payloadBytes += row.bytes.length;
    jsonBytes += OFFSET_ITEM_BYTES;
  }
  flush();
}

// -- the contract ----------------------------------------------------

/**
 * Create or overwrite many entries in a constant number of metadata
 * statements plus one per `payloadBudget` of content.
 *
 * Directories, files and symlinks may be mixed. Entries are applied in path
 * order, so a parent directory always lands before its children, and a
 * duplicate path is resolved last-one-wins.
 *
 * An existing directory is left exactly as it is — not re-created, not
 * re-timestamped — whether it was named explicitly or implied by
 * `parents`. Overwriting a file replaces its bytes and drops every stale
 * chunk, so a shorter overwrite cannot leave the previous tail readable,
 * and it clears `content_id` unless the caller supplies a new one.
 */
export function writeFiles(
  db: SqlDatabase,
  entries: readonly WriteEntry[],
  options: WriteOptions = {},
  now: () => number = Date.now,
): void {
  if (entries.length === 0) return;
  const createParents = options.parents !== false;
  const budget = payloadBudgetOf(options.payloadBudget);
  const timestamp = now();

  db.transactionSync(() => {
    const real = realpathsNoFollow(
      db,
      entries.map((entry) => entry.path),
    );

    const planned = new Map<string, Planned>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const path = real[i];
      if (entry === undefined || path === undefined) continue;
      planned.set(path, toPlanned(path, entry, timestamp));
    }
    // Path order throughout, so the batch is deterministic and a parent is
    // always considered before its children.
    const targets = [...planned.values()].sort((a, b) => comparePaths(a.path, b.path));

    // Directories the entries need but did not name themselves.
    const required = new Set<string>();
    for (const target of targets) {
      for (const ancestor of strictAncestors(target.path)) {
        const named = planned.get(ancestor);
        if (named === undefined) {
          required.add(ancestor);
          continue;
        }
        if (named.type !== "dir") {
          throw fsError("ENOTDIR", "a parent path segment is not a directory", ancestor);
        }
      }
    }

    const existing = new Map<string, ExistingRow>();
    const probe = [...required, ...targets.map((target) => target.path)];
    for (const row of selectByPaths<ExistingRow>(db, SELECT_EXISTING, probe)) {
      existing.set(row.path, row);
    }

    const creating: string[] = [];
    for (const path of required) {
      const found = existing.get(path);
      if (found === undefined) {
        if (!createParents) throw fsError("ENOENT", "parent directory missing", path);
        creating.push(path);
        continue;
      }
      if (found.type !== "dir") {
        throw fsError("ENOTDIR", "a parent path segment is not a directory", path);
      }
    }

    const overwriting: Planned[] = [];
    const replaced: number[] = [];
    for (const entry of targets) {
      const found = existing.get(entry.path);
      if (found === undefined) {
        creating.push(entry.path);
        continue;
      }
      if (found.type === "dir" && entry.type === "dir") continue; // left alone
      if (found.type === "dir") throw fsError("EISDIR", "cannot replace a directory", entry.path);
      if (entry.type === "dir") {
        throw fsError("EEXIST", "cannot replace a file with a directory", entry.path);
      }
      overwriting.push(entry);
      replaced.push(found.inode);
    }

    if (creating.length === 0 && overwriting.length === 0) return;

    // Path order, so inodes ascend with paths and a parent row is both
    // built and inserted before any of its children.
    creating.sort(comparePaths);

    const rev = bumpRev(db);
    const firstInode = creating.length > 0 ? allocateInodes(db, creating.length) : 0;

    const inodes = new Map<string, number>();
    const nodes: NodeRow[] = [];
    const paths: PathRow[] = [];
    for (let i = 0; i < creating.length; i++) {
      const path = creating[i];
      if (path === undefined) continue;
      const inode = firstInode + i;
      const entry = planned.get(path);
      inodes.set(path, inode);
      nodes.push(
        entry === undefined ? implicitDirectory(inode, timestamp) : nodeRowOf(entry, inode),
      );
      paths.push({ path, parent: parentOf(path), inode });
    }
    for (let i = 0; i < overwriting.length; i++) {
      const entry = overwriting[i];
      const inode = replaced[i];
      if (entry === undefined || inode === undefined) continue;
      inodes.set(entry.path, inode);
      nodes.push(nodeRowOf(entry, inode));
    }

    // Stale content dies before the new content lands, so a shorter
    // overwrite cannot leave the old tail behind.
    if (replaced.length > 0) {
      const items = replaced.map(String);
      for (const batch of jsonBatches(
        items,
        items.map((item) => item.length),
      )) {
        db.run(DELETE_CHUNKS, batch);
      }
    }

    writeNodes(db, nodes, rev);
    writePaths(db, paths);

    const chunks: ChunkRow[] = [];
    for (const entry of targets) {
      if (entry.type !== "file" || entry.bytes === null) continue;
      const inode = inodes.get(entry.path);
      if (inode === undefined) continue;
      for (let at = 0, idx = 0; at < entry.bytes.length; at += CHUNK_SIZE, idx++) {
        chunks.push({ inode, idx, bytes: entry.bytes.subarray(at, at + CHUNK_SIZE) });
      }
    }
    writeChunks(db, chunks, budget);
  });
}

/**
 * Create directories, parents included, in a constant number of statements
 * however many are asked for. Existing ones are left alone, so a repeat
 * call writes nothing and does not move the revision.
 */
export function makeDirectories(
  db: SqlDatabase,
  paths: readonly string[],
  now: () => number = Date.now,
): void {
  writeFiles(
    db,
    paths.map((path) => ({ path })),
    { parents: true },
    now,
  );
}
