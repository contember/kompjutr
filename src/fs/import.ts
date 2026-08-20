// One-time, in-database migration from Computer's v5 filesystem tables.
//
// This is deliberately the only production module that reads `vfs_*`.
// Git state already lives in `git_*`; only the working tree moves.

import type { SqlDatabase } from "../sqlite/db.js";

export const COMPUTER_IMPORT_ACKNOWLEDGEMENT =
  "computer-is-quiescent-and-provider-is-unused-in-this-isolate";

export interface ImportFromComputerOptions {
  /** Required because private pending fd buffers are invisible to SQLite. */
  acknowledgement: typeof COMPUTER_IMPORT_ACKNOWLEDGEMENT;
  /** Milliseconds written to the divergence latch. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ComputerImportResult {
  entries: number;
  files: number;
  bytes: number;
  vfsRev: number;
}

interface PreconditionRow {
  vfs_rev: number | null;
  schema_version: number | null;
  source_root: number;
  target_paths: number;
  target_nodes: number;
  target_chunks: number;
  target_root: number;
  target_latch: number;
  entries: number;
  files: number;
  bytes: number;
  integrity_errors: number;
}

interface LatchRow {
  current_rev: number;
  imported_rev: number | null;
}

const CHILD_PATH =
  "CASE WHEN source.path = '/' THEN '/' || dirent.name ELSE source.path || '/' || dirent.name END";

const IMPORTED_PATHS = `
WITH RECURSIVE imported_paths(path, parent, source_inode) AS (
  SELECT '/', '', node.inode
    FROM vfs_nodes node
   WHERE node.inode = 1
  UNION ALL
  SELECT ${CHILD_PATH}, source.path, child.inode
    FROM imported_paths source
    JOIN vfs_dirents dirent ON dirent.parent_inode = source.source_inode
    JOIN vfs_nodes child ON child.inode = dirent.child_inode
   WHERE dirent.name <> '.git'
     AND child.mount_root IS NULL
)`;

// The root keeps inode 1. Every other reachable source inode gets one inode
// from the explicit target allocator; hardlinked paths share that mapping.
const MAPPED_NODES = `${IMPORTED_PATHS},
imported_nodes(source_inode, nlink) AS (
  SELECT source_inode, count(*)
    FROM imported_paths
   WHERE path <> '/'
   GROUP BY source_inode
),
mapped_nodes(source_inode, nlink, target_inode) AS (
  SELECT source_inode,
         nlink,
         (SELECT v FROM fs_meta WHERE k = 'next_inode')
           + row_number() OVER (ORDER BY source_inode) - 1
    FROM imported_nodes
)`;

const PRECONDITION = `${IMPORTED_PATHS},
reachable_nodes(source_inode) AS (
  SELECT DISTINCT source_inode FROM imported_paths
),
chunk_checks(inode, node_type, idx, recorded_size, actual_size, expected_idx) AS (
  SELECT chunk.inode,
         node.type,
         chunk.idx,
         chunk.size,
         length(blob.bytes),
         row_number() OVER (PARTITION BY chunk.inode ORDER BY chunk.idx) - 1
    FROM reachable_nodes reachable
    JOIN vfs_nodes node ON node.inode = reachable.source_inode
    JOIN vfs_chunks chunk ON chunk.inode = reachable.source_inode
    LEFT JOIN vfs_blob_bytes blob ON blob.hash = chunk.hash
),
manifest_rows(inode, node_size, node_hash, manifest_hash, manifest_size, encoded_text) AS (
  SELECT node.inode,
         node.size,
         node.manifest_hash,
         manifest.hash,
         manifest.size,
         CAST(manifest.encoded AS TEXT)
    FROM reachable_nodes reachable
    JOIN vfs_nodes node ON node.inode = reachable.source_inode AND node.type = 'file'
    LEFT JOIN vfs_manifests manifest ON manifest.hash = node.manifest_hash
),
valid_manifests(inode, manifest_size, encoded_text) AS (
  SELECT inode, manifest_size, encoded_text
    FROM manifest_rows
   WHERE node_hash IS NOT NULL
     AND manifest_hash IS NOT NULL
     AND json_valid(encoded_text)
),
manifest_chunks(inode, idx, hash_type, hash, size_type, size) AS (
  SELECT manifest.inode,
         CAST(entry.key AS INTEGER),
         json_type(entry.value, '$.hash'),
         lower(json_extract(entry.value, '$.hash')),
         json_type(entry.value, '$.size'),
         json_extract(entry.value, '$.size')
    FROM valid_manifests manifest,
         json_each(manifest.encoded_text, '$.chunks') entry
)
SELECT (SELECT v FROM vfs_meta WHERE k = 'rev') AS vfs_rev,
       (SELECT v FROM vfs_meta WHERE k = 'schema_version') AS schema_version,
       (SELECT count(*) FROM vfs_nodes WHERE inode = 1) AS source_root,
       (SELECT count(*) FROM fs_paths) AS target_paths,
       (SELECT count(*) FROM fs_nodes) AS target_nodes,
       (SELECT count(*) FROM fs_chunks) AS target_chunks,
       (SELECT count(*) FROM fs_paths WHERE path = '/' AND parent = '' AND inode = 1)
         AS target_root,
       (SELECT count(*) FROM fs_meta WHERE k IN ('imported_vfs_rev', 'imported_at'))
         AS target_latch,
       (SELECT count(*) FROM imported_paths WHERE path <> '/') AS entries,
       (SELECT count(*)
          FROM imported_paths path
          JOIN vfs_nodes node ON node.inode = path.source_inode
         WHERE path.path <> '/' AND node.type = 'file') AS files,
       coalesce((SELECT sum(actual_size)
                   FROM chunk_checks
                  WHERE node_type = 'file'), 0) AS bytes,
       (SELECT count(*)
          FROM chunk_checks
         WHERE node_type <> 'file'
            OR idx <> expected_idx
            OR recorded_size < 0
            OR actual_size IS NULL
            OR recorded_size <> actual_size)
       + (SELECT count(*)
            FROM reachable_nodes reachable
            JOIN vfs_nodes node ON node.inode = reachable.source_inode
           WHERE node.type = 'symlink' AND node.link_target IS NULL)
       + (SELECT count(*)
            FROM manifest_rows manifest
           WHERE CASE
                   WHEN manifest.node_hash IS NULL THEN
                     CASE
                       WHEN manifest.node_size
                            <> coalesce((SELECT sum(actual_size) FROM chunk_checks chunk
                                          WHERE chunk.inode = manifest.inode), 0) THEN 1
                       ELSE 0
                     END
                   WHEN manifest.manifest_hash IS NULL THEN 1
                   WHEN NOT json_valid(manifest.encoded_text) THEN 1
                   WHEN json_type(manifest.encoded_text, '$.version') IS NOT 'integer' THEN 1
                   WHEN json_extract(manifest.encoded_text, '$.version') <> 1 THEN 1
                   WHEN json_type(manifest.encoded_text, '$.chunks') IS NOT 'array' THEN 1
                   WHEN json_array_length(manifest.encoded_text, '$.chunks')
                        <> (SELECT count(*) FROM chunk_checks chunk
                             WHERE chunk.inode = manifest.inode) THEN 1
                   WHEN manifest.manifest_size
                        <> coalesce((SELECT sum(recorded_size) FROM chunk_checks chunk
                                      WHERE chunk.inode = manifest.inode), 0) THEN 1
                   WHEN manifest.manifest_size
                        <> coalesce((SELECT sum(actual_size) FROM chunk_checks chunk
                                      WHERE chunk.inode = manifest.inode), 0) THEN 1
                   ELSE 0
                 END = 1)
       + (SELECT count(*)
            FROM manifest_chunks manifest
            LEFT JOIN vfs_chunks chunk
              ON chunk.inode = manifest.inode AND chunk.idx = manifest.idx
           WHERE manifest.hash_type IS NOT 'text'
              OR manifest.size_type IS NOT 'integer'
              OR chunk.inode IS NULL
              OR lower(hex(chunk.hash)) IS NOT manifest.hash
              OR chunk.size IS NOT manifest.size)
         AS integrity_errors`;

const UPDATE_ROOT = `
UPDATE fs_nodes
   SET type = (SELECT type FROM vfs_nodes WHERE inode = 1),
       mode = (SELECT mode FROM vfs_nodes WHERE inode = 1),
       mtime = (SELECT mtime FROM vfs_nodes WHERE inode = 1),
       size = 0,
       rev = (SELECT rev FROM vfs_nodes WHERE inode = 1),
       nlink = 1,
       link_target = (SELECT link_target FROM vfs_nodes WHERE inode = 1),
       content_id = (SELECT manifest_hash FROM vfs_nodes WHERE inode = 1)
 WHERE inode = 1`;

const INSERT_NODES = `${MAPPED_NODES},
file_sizes(source_inode, size) AS (
  SELECT mapped.source_inode, coalesce(sum(length(blob.bytes)), 0)
    FROM mapped_nodes mapped
    LEFT JOIN vfs_chunks chunk ON chunk.inode = mapped.source_inode
    LEFT JOIN vfs_blob_bytes blob ON blob.hash = chunk.hash
   GROUP BY mapped.source_inode
)
INSERT INTO fs_nodes
       (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT mapped.target_inode,
       source.type,
       source.mode,
       source.mtime,
       CASE source.type
         WHEN 'dir' THEN 0
         WHEN 'symlink' THEN length(CAST(coalesce(source.link_target, '') AS BLOB))
         ELSE file_sizes.size
       END,
       source.rev,
       mapped.nlink,
       source.link_target,
       source.manifest_hash
  FROM mapped_nodes mapped
  JOIN vfs_nodes source ON source.inode = mapped.source_inode
  JOIN file_sizes ON file_sizes.source_inode = mapped.source_inode`;

const INSERT_PATHS = `${MAPPED_NODES}
INSERT INTO fs_paths (path, parent, inode)
SELECT path.path, path.parent, mapped.target_inode
  FROM imported_paths path
  JOIN mapped_nodes mapped ON mapped.source_inode = path.source_inode
 WHERE path.path <> '/'`;

const INSERT_CHUNKS = `${MAPPED_NODES}
INSERT INTO fs_chunks (inode, idx, bytes)
SELECT mapped.target_inode, chunk.idx, blob.bytes
  FROM mapped_nodes mapped
  JOIN vfs_nodes source ON source.inode = mapped.source_inode AND source.type = 'file'
  JOIN vfs_chunks chunk ON chunk.inode = mapped.source_inode
  JOIN vfs_blob_bytes blob ON blob.hash = chunk.hash`;

const ADVANCE_ALLOCATOR = `${IMPORTED_PATHS}
UPDATE fs_meta
   SET v = v + (SELECT count(DISTINCT source_inode)
                  FROM imported_paths
                 WHERE path <> '/')
 WHERE k = 'next_inode'`;

const READ_LATCH = `
SELECT current.v AS current_rev, imported.v AS imported_rev
  FROM vfs_meta current
  LEFT JOIN fs_meta imported ON imported.k = 'imported_vfs_rev'
 WHERE current.k = 'rev'`;

function validatePrecondition(row: PreconditionRow | undefined): PreconditionRow {
  if (row === undefined || row.vfs_rev === null || row.source_root !== 1) {
    throw new Error("Computer filesystem is not initialized");
  }
  if (row.schema_version !== 5) {
    throw new Error(`unsupported Computer filesystem schema version: ${row.schema_version}`);
  }
  if (row.integrity_errors !== 0) {
    throw new Error(`Computer filesystem integrity check failed: ${row.integrity_errors} errors`);
  }
  if (
    row.target_paths !== 1 ||
    row.target_nodes !== 1 ||
    row.target_chunks !== 0 ||
    row.target_root !== 1 ||
    row.target_latch !== 0
  ) {
    throw new Error("standalone filesystem import requires fresh fs_* tables containing only root");
  }
  return row;
}

function writeLatch(db: SqlDatabase, vfsRev: number, importedAt: number): void {
  db.run("INSERT OR REPLACE INTO fs_meta (k, v) VALUES ('rev', ?)", vfsRev);
  db.run(
    `INSERT OR REPLACE INTO fs_meta (k, v)
     VALUES ('imported_vfs_rev', ?), ('imported_at', ?)`,
    vfsRev,
    importedAt,
  );
}

/**
 * Import Computer's committed working tree without moving file bytes through JS.
 *
 * Computer must be quiescent, and no Computer provider may have been constructed
 * or used in this isolate/request. Its pending fd buffers live in a private
 * WeakMap and cannot be observed through `db`; acknowledging otherwise would
 * permit a silently stale import. The acknowledgement is checked before SQL.
 *
 * Computer-managed `.git` subtrees are pruned. Target inodes are freshly
 * allocated, except the filesystem root, whose stable inode is 1 in both
 * schemas. Root mode and mtime are copied explicitly.
 */
export function importFromComputer(
  db: SqlDatabase,
  options: ImportFromComputerOptions,
): ComputerImportResult {
  if (options?.acknowledgement !== COMPUTER_IMPORT_ACKNOWLEDGEMENT) {
    throw new Error(
      `importFromComputer requires acknowledgement '${COMPUTER_IMPORT_ACKNOWLEDGEMENT}'`,
    );
  }
  const now = options.now ?? Date.now;

  return db.transactionSync(() => {
    const source = validatePrecondition(db.one<PreconditionRow>(PRECONDITION));
    const vfsRev = source.vfs_rev;
    if (vfsRev === null) throw new Error("Computer filesystem has no vfs_meta.rev row");

    db.run(UPDATE_ROOT);
    db.run(INSERT_NODES);
    db.run(INSERT_PATHS);
    db.run(INSERT_CHUNKS);
    db.run(ADVANCE_ALLOCATOR);
    writeLatch(db, vfsRev, now());

    return {
      entries: source.entries,
      files: source.files,
      bytes: source.bytes,
      vfsRev,
    };
  });
}

/**
 * Throw when Computer wrote to a database after its working tree was imported.
 * A fresh standalone database has no `vfs_meta` table and is accepted.
 */
export function assertComputerImportCurrent(db: SqlDatabase): void {
  let row: LatchRow | undefined;
  try {
    row = db.one<LatchRow>(READ_LATCH);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table: vfs_meta")) return;
    throw error;
  }
  if (row === undefined || row.imported_rev === null) return;
  if (row.current_rev !== row.imported_rev) {
    throw new Error(
      `Computer filesystem changed after import: vfs_meta.rev moved from ${row.imported_rev} to ${row.current_rev}`,
    );
  }
}
