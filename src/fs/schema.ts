// The filesystem's tables. Everything under `fs_`; nothing here is shared
// with the git schema, which lives in `src/git/store/schema.ts`.
//
// The shape that matters: `fs_paths` is keyed on the whole path under
// BINARY collation, so the physical storage order IS git's tree order and
// a working-tree walk is an indexed range scan rather than a traversal.

import type { SqlDatabase } from "../db/db.js";

export const FS_SCHEMA_VERSION = 1;

/** DOFS uses 512 KiB; the Durable Object BLOB ceiling is 2 MB. */
export const CHUNK_SIZE = 512 * 1024;

export const ROOT_INODE = 1;

const STATEMENTS = [
  // Seeded rows: 'schema_version', 'rev', 'next_inode'.
  //   rev        — monotonic, bumped once per mutating call, not per row.
  //   next_inode — an explicit allocator, because a bulk write has to know
  //                its inodes before it can build the payload, and
  //                AUTOINCREMENT also writes sqlite_sequence per insert.
  `CREATE TABLE IF NOT EXISTS fs_meta (
     k TEXT PRIMARY KEY,
     v INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS fs_nodes (
     inode INTEGER PRIMARY KEY,
     type TEXT NOT NULL CHECK(type IN ('file','dir','symlink')),
     mode INTEGER NOT NULL DEFAULT 420,
     mtime INTEGER NOT NULL,
     size INTEGER NOT NULL DEFAULT 0,
     rev INTEGER NOT NULL DEFAULT 0,
     nlink INTEGER NOT NULL DEFAULT 1,
     link_target TEXT,
     content_id BLOB
   )`,

  // WITHOUT ROWID so the row lives in the (path) PK b-tree leaf: a range
  // scan on `path` is the physical scan order and `inode` is read straight
  // from the leaf with no rowid hop.
  //
  // `path` is always a REAL path — every symlink on the way already
  // resolved. Writing a lexical path here would shadow its own target.
  `CREATE TABLE IF NOT EXISTS fs_paths (
     path TEXT NOT NULL PRIMARY KEY,
     parent TEXT NOT NULL,
     inode INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // readdir: WHERE parent = ? ORDER BY path. Covering — on a WITHOUT ROWID
  // table the PK is the row locator, so `path` is in the index leaf. The
  // basename is sliced in JS; there is no `name` column.
  `CREATE INDEX IF NOT EXISTS fs_paths_by_parent ON fs_paths(parent, path)`,

  // Reverse lookup for unlink/link/nlink.
  `CREATE INDEX IF NOT EXISTS fs_paths_by_inode ON fs_paths(inode)`,

  // A rowid table on purpose: rows carry up to CHUNK_SIZE of payload, and
  // WITHOUT ROWID wants small rows.
  `CREATE TABLE IF NOT EXISTS fs_chunks (
     inode INTEGER NOT NULL,
     idx INTEGER NOT NULL,
     bytes BLOB NOT NULL,
     PRIMARY KEY (inode, idx)
   )`,
] as const;

/**
 * Create the filesystem tables and seed the root directory.
 *
 * Deliberately absent: no index on `fs_nodes.rev` (nothing reads it yet and
 * it would cost an entry per row on every bulk write), no content-addressed
 * blob table, no manifests, no GC. Two identical files store their bytes
 * twice; in exchange the write path never hashes.
 */
export function initializeFsSchema(db: SqlDatabase, now: () => number = Date.now): void {
  db.transactionSync(() => {
    for (const statement of STATEMENTS) db.run(statement);

    db.run("INSERT OR IGNORE INTO fs_meta (k, v) VALUES ('rev', 0)");
    db.run("INSERT OR IGNORE INTO fs_meta (k, v) VALUES ('next_inode', ?)", ROOT_INODE + 1);

    db.run(
      `INSERT OR IGNORE INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
       VALUES (?, 'dir', ?, ?, 0, 0, 1)`,
      ROOT_INODE,
      0o755,
      now(),
    );
    db.run("INSERT OR IGNORE INTO fs_paths (path, parent, inode) VALUES ('/', '', ?)", ROOT_INODE);

    db.run("INSERT OR REPLACE INTO fs_meta (k, v) VALUES ('schema_version', ?)", FS_SCHEMA_VERSION);
  });
}
