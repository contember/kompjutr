// Bulk timestamp updates preserve content and preflight the complete set before
// one revision bump. Missing targets become empty regular files.

import type { SqlDatabase } from "../../sqlite/db.js";
import { filesystemError as fsError } from "../errors.js";
import { comparePaths, dirname, normalize } from "../path.js";
import type { EntryType, RealPath } from "../types.js";
import { allocateInodes, bumpRev } from "./meta.js";

export const TOUCH_PATH_LIMIT = 10_000;
const MAX_JSON_BYTES = 1_500_000;
const DEFAULT_FILE_MODE = 0o644;
const ENCODER = new TextEncoder();

interface NodeRow {
  path: unknown;
  inode: unknown;
  type: unknown;
  mode: unknown;
  mtime: unknown;
  size: unknown;
  rev: unknown;
  nlink: unknown;
  link_target: unknown;
  content_id_kind: unknown;
}

interface Node {
  path: string;
  inode: number;
  type: EntryType;
}

const SELECT_NODES = `SELECT p.path AS path,
       p.inode AS inode,
       n.type AS type,
       n.mode AS mode,
       n.mtime AS mtime,
       n.size AS size,
       n.rev AS rev,
       n.nlink AS nlink,
       n.link_target AS link_target,
       CASE WHEN n.content_id IS NULL THEN 'null' ELSE typeof(n.content_id) END AS content_id_kind
  FROM fs_paths p
  JOIN fs_nodes n ON n.inode = p.inode
 WHERE p.path IN (SELECT value FROM json_each(?))`;

const INSERT_NODES = `INSERT INTO fs_nodes
       (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(value, '$.i'), 'file', ?, ?, 0, ?, 1, NULL, NULL
  FROM json_each(?)`;

const INSERT_PATHS = `INSERT INTO fs_paths (path, parent, inode)
SELECT json_extract(value, '$.p'), json_extract(value, '$.pa'), json_extract(value, '$.i')
  FROM json_each(?)
 ORDER BY json_extract(value, '$.p')`;

const UPDATE_EXISTING = `UPDATE fs_nodes
   SET mtime = ?, rev = ?
 WHERE inode IN (SELECT value FROM json_each(?))`;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function entryType(value: unknown): EntryType {
  if (value === "file" || value === "dir" || value === "symlink") return value;
  throw new Error("touchFiles: row contains an invalid type");
}

function validatedNode(row: NodeRow): Node {
  const type = entryType(row.type);
  if (
    typeof row.path !== "string" ||
    normalize(row.path) !== row.path ||
    !isSafeInteger(row.inode) ||
    row.inode < 1 ||
    !isSafeInteger(row.mode) ||
    row.mode < 0 ||
    row.mode > 0o7777 ||
    !isSafeInteger(row.mtime) ||
    !isSafeInteger(row.size) ||
    row.size < 0 ||
    !isSafeInteger(row.rev) ||
    row.rev < 0 ||
    !isSafeInteger(row.nlink) ||
    row.nlink < 1 ||
    (row.link_target !== null && typeof row.link_target !== "string") ||
    (row.content_id_kind !== "null" && row.content_id_kind !== "blob") ||
    (type === "dir" && (row.size !== 0 || row.link_target !== null)) ||
    (type === "file" && row.link_target !== null) ||
    (type === "symlink" && row.link_target === null)
  ) {
    throw new Error("touchFiles: row contains invalid metadata");
  }
  return { path: row.path, inode: row.inode, type };
}

function jsonBatches(items: readonly string[]): string[] {
  const out: string[] = [];
  let group: string[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = ENCODER.encode(item).byteLength;
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

function selectNodes(db: SqlDatabase, paths: readonly string[]): Node[] {
  const out: Node[] = [];
  const items = paths.map((path) => JSON.stringify(path));
  for (const batch of jsonBatches(items)) {
    for (const row of db.all<NodeRow>(SELECT_NODES, batch)) out.push(validatedNode(row));
  }
  return out;
}

function runBatches(
  db: SqlDatabase,
  sql: string,
  items: readonly string[],
  ...bindings: readonly unknown[]
): void {
  for (const batch of jsonBatches(items)) db.run(sql, ...bindings, batch);
}

/** Update a complete resolved set atomically, creating missing regular files. */
export function touchFiles(
  db: SqlDatabase,
  paths: readonly RealPath[],
  mtime: number,
  create = true,
): void {
  if (paths.length === 0) return;
  if (paths.length > TOUCH_PATH_LIMIT) {
    throw fsError("E2BIG", `touch accepts at most ${TOUCH_PATH_LIMIT} paths`);
  }
  if (!Number.isSafeInteger(mtime)) throw fsError("EINVAL", "mtime must be a safe integer");

  const unique = [...new Set(paths)].sort(comparePaths);
  const found = new Map<string, Node>();
  for (const node of selectNodes(db, unique)) found.set(node.path, node);
  const missing = unique.filter((path) => !found.has(path));

  if (!create && missing.length > 0) {
    throw fsError("ENOENT", "no such file or directory", missing[0]);
  }

  if (missing.length > 0) {
    const parents = [...new Set(missing.map(dirname))];
    const parentNodes = new Map(selectNodes(db, parents).map((node) => [node.path, node]));
    for (const path of missing) {
      const parent = dirname(path);
      const node = parentNodes.get(parent);
      if (node === undefined) throw fsError("ENOENT", "parent directory missing", path);
      if (node.type !== "dir") throw fsError("ENOTDIR", "parent is not a directory", path);
    }
  }

  const existingInodes = [...new Set([...found.values()].map((node) => node.inode))];
  db.transactionSync(() => {
    const rev = bumpRev(db);
    if (missing.length > 0) {
      const firstInode = allocateInodes(db, missing.length);
      const items = missing.map((path, index) => ({ path, inode: firstInode + index }));
      runBatches(
        db,
        INSERT_NODES,
        items.map((item) => `{"i":${item.inode}}`),
        DEFAULT_FILE_MODE,
        mtime,
        rev,
      );
      runBatches(
        db,
        INSERT_PATHS,
        items.map(
          (item) =>
            `{"p":${JSON.stringify(item.path)},"pa":${JSON.stringify(dirname(item.path))},"i":${item.inode}}`,
        ),
      );
    }
    runBatches(db, UPDATE_EXISTING, existingInodes.map(String), mtime, rev);
  });
}
