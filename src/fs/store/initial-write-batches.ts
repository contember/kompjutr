import { blob, type SqlDatabase } from "../../db/db.js";

export interface InitialNodeRow {
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  target: string | null;
  contentId: Uint8Array | null;
}

export interface InitialPathRow {
  path: string;
  parent: string;
  inode: number;
}

export interface InitialChunkRow {
  inode: number;
  index: number;
  bytes: Uint8Array;
}

const INSERT_NODES = `
WITH rows(value) AS (SELECT value FROM json_each(?))
INSERT INTO fs_nodes
       (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(value, '$.i'),
       json_extract(value, '$.t'),
       json_extract(value, '$.m'),
       json_extract(value, '$.mt'),
       json_extract(value, '$.s'),
       ?, 1,
       json_extract(value, '$.l'),
       CASE WHEN json_extract(value, '$.ca') > 0
            THEN substr(?, json_extract(value, '$.ca'), json_extract(value, '$.cn'))
            ELSE NULL END
  FROM rows`;

const INSERT_PATHS = `
INSERT INTO fs_paths (path, parent, inode)
SELECT json_extract(value, '$.p'),
       json_extract(value, '$.pa'),
       json_extract(value, '$.i')
  FROM json_each(?)`;

const INSERT_CHUNKS = `
INSERT INTO fs_chunks (inode, idx, bytes)
SELECT json_extract(value, '$.i'),
       json_extract(value, '$.x'),
       substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
  FROM json_each(?)`;

export function flushInitialMetadata(
  db: SqlDatabase,
  nodes: readonly InitialNodeRow[],
  paths: readonly InitialPathRow[],
  contentIdBytes: number,
  revision: number,
): void {
  const ids = new Uint8Array(contentIdBytes);
  const nodeItems: string[] = [];
  const pathItems: string[] = [];
  let at = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const path = paths[index]!;
    const contentId = node.contentId;
    let contentAt = 0;
    if (contentId !== null) {
      ids.set(contentId, at);
      contentAt = at + 1;
      at += contentId.length;
    }
    nodeItems.push(
      JSON.stringify({
        i: node.inode,
        t: node.type,
        m: node.mode,
        mt: node.mtime,
        s: node.size,
        l: node.target,
        ca: contentAt,
        cn: contentId?.length ?? 0,
      }),
    );
    pathItems.push(JSON.stringify({ p: path.path, pa: path.parent, i: path.inode }));
  }
  const nodeJson = `[${nodeItems.join(",")}]`;
  const pathJson = `[${pathItems.join(",")}]`;
  db.run(INSERT_NODES, nodeJson, revision, blob(ids));
  db.run(INSERT_PATHS, pathJson);
}

export function flushInitialChunks(
  db: SqlDatabase,
  chunks: readonly InitialChunkRow[],
  chunkBytes: number,
): void {
  const payload = new Uint8Array(chunkBytes);
  const items: string[] = [];
  let at = 0;
  for (const row of chunks) {
    payload.set(row.bytes, at);
    items.push(JSON.stringify({ i: row.inode, x: row.index, a: at + 1, n: row.bytes.length }));
    at += row.bytes.length;
  }
  const json = `[${items.join(",")}]`;
  db.run(INSERT_CHUNKS, blob(payload), json);
}
