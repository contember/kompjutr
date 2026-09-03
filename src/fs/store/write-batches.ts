import { blob, type SqlDatabase } from "../../db/db.js";
import type { EntryType } from "../types.js";

const DEFAULT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_JSON_BYTES = 1_500_000;
const OFFSET_ITEM_BYTES = 80;

export interface WriteNodeRow {
  inode: number;
  type: EntryType;
  mode: number;
  mtime: number;
  size: number;
  target: string | null;
  contentId: Uint8Array | null;
}

export interface WritePathRow {
  path: string;
  parent: string;
  inode: number;
}

export interface WriteChunkRow {
  inode: number;
  idx: number;
  bytes: Uint8Array;
}

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

const INSERT_PATHS = `
INSERT INTO fs_paths (path, parent, inode)
SELECT json_extract(j.value, '$.p'),
       json_extract(j.value, '$.pa'),
       json_extract(j.value, '$.i')
  FROM json_each(?) j
 ORDER BY j.key`;

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

/** UTF-8 length, which is what a bound TEXT value actually costs. */
export function utf8Length(value: string): number {
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

export function payloadBudgetOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAYLOAD_BYTES;
  }
  return Math.min(Math.floor(requested), MAX_PAYLOAD_BYTES);
}

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

export function selectExistingRows<Row extends object>(
  db: SqlDatabase,
  paths: readonly string[],
): Row[] {
  if (paths.length === 0) return [];
  const items = paths.map((path) => JSON.stringify(path));
  const sizes = items.map(utf8Length);
  const out: Row[] = [];
  for (const batch of jsonBatches(items, sizes)) {
    out.push(...db.all<Row>(SELECT_EXISTING, batch));
  }
  return out;
}

export function writeNodes(db: SqlDatabase, rows: readonly WriteNodeRow[], rev: number): void {
  let group: WriteNodeRow[] = [];
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
        start = at + 1;
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

export function writePaths(db: SqlDatabase, rows: readonly WritePathRow[]): void {
  if (rows.length === 0) return;
  const items = rows.map(
    (row) =>
      `{"p":${JSON.stringify(row.path)},"pa":${JSON.stringify(row.parent)},"i":${row.inode}}`,
  );
  const sizes = items.map(utf8Length);
  for (const batch of jsonBatches(items, sizes)) db.run(INSERT_PATHS, batch);
}

export function writeChunks(db: SqlDatabase, rows: readonly WriteChunkRow[], budget: number): void {
  let group: WriteChunkRow[] = [];
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
    const item = `{"i":${row.inode},"x":${row.idx},"at":${payloadBytes + 1},"n":${row.bytes.length}}`;
    group.push(row);
    items.push(item);
    payloadBytes += row.bytes.length;
    jsonBytes += OFFSET_ITEM_BYTES;
  }
  flush();
}

export function deleteChunks(db: SqlDatabase, inodes: readonly number[]): void {
  const items = inodes.map(String);
  for (const batch of jsonBatches(
    items,
    items.map((item) => item.length),
  )) {
    db.run(DELETE_CHUNKS, batch);
  }
}
