import { MAX_OBJECT_BYTES } from "../../common/objects.js";

const COMMIT_COLUMNS = `
  repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
  oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
  parents TEXT NOT NULL CHECK (
    json_valid(parents) AND json_type(parents) = 'array'
  ),
  tree TEXT NOT NULL CHECK (length(CAST(tree AS BLOB)) = 40),
  author_name BLOB NOT NULL,
  author_email BLOB NOT NULL,
  author_time INTEGER NOT NULL,
  author_timezone INTEGER NOT NULL,
  committer_name BLOB NOT NULL,
  committer_email BLOB NOT NULL,
  committer_time INTEGER NOT NULL,
  committer_timezone INTEGER NOT NULL,
  message BLOB,
  gpgsig BLOB CHECK (gpgsig IS NULL OR message IS NOT NULL),
  object_size INTEGER NOT NULL CHECK (object_size >= 0)`;

const COMMIT_TABLE = `CREATE TABLE IF NOT EXISTS git_commits (
  ${COMMIT_COLUMNS},
  PRIMARY KEY (repo_id, oid),
  FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`;

export const OBJECT_SCHEMA_STATEMENTS = [
  // Loose objects: everything created locally, zlib-deflated and chunked.
  `CREATE TABLE IF NOT EXISTS git_objects (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     type TEXT NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       size BETWEEN 0 AND ${MAX_OBJECT_BYTES}
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT`,

  `CREATE TRIGGER IF NOT EXISTS git_promised_blobs_loose_present
   AFTER INSERT ON git_objects
   BEGIN
     DELETE FROM git_promised_blobs
      WHERE repo_id = NEW.repo_id AND oid = NEW.oid;
   END`,

  // One parsed row per stored commit, written with the object. A NULL message
  // marks a row that would exceed the platform row ceiling: message and gpgsig
  // are then read from the object.
  COMMIT_TABLE,

  `CREATE TABLE IF NOT EXISTS git_pack_commit_staging (
     ${COMMIT_COLUMNS},
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     PRIMARY KEY (repo_id, pack_id, oid),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_object_chunks (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) STRICT`,

  // Received packs are kept verbatim, still compressed. `state` is
  // 'pending' until the trailer has been verified and every entry
  // indexed; an interrupted fetch leaves a pending pack that the next
  // ingest reclaims.
  `CREATE TABLE IF NOT EXISTS git_pack_meta (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     size INTEGER NOT NULL CHECK (size >= 0),
     count INTEGER NOT NULL CHECK (count >= 0),
     state TEXT NOT NULL CHECK (state IN ('pending','complete')),
     created INTEGER NOT NULL CHECK (created >= 0),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT`,

  // Ordinary pack ingestion is async. This durable generation lease prevents
  // another store facade from reclaiming or reusing its pending identity.
  `CREATE TABLE IF NOT EXISTS git_pack_ingest_control (
     repo_id INTEGER PRIMARY KEY CHECK (
       repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     owner_generation INTEGER NOT NULL CHECK (
       owner_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     last_pack_id INTEGER NOT NULL CHECK (
       last_pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     active_pack_id INTEGER CHECK (
       active_pack_id IS NULL OR (
         active_pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
         AND active_pack_id <= last_pack_id
       )
     ),
     expires_ms INTEGER CHECK (
       expires_ms IS NULL OR (
         expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     CHECK ((active_pack_id IS NULL) = (expires_ms IS NULL)),
     CHECK (active_pack_id IS NULL OR owner_generation >= 1),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id, active_pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id)
   ) STRICT, WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_data (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS git_pack_objects (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     offset INTEGER NOT NULL CHECK (offset >= 0),
     data_off INTEGER NOT NULL CHECK (data_off >= 0),
     data_len INTEGER NOT NULL CHECK (data_len >= 0),
     type TEXT NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       size BETWEEN 0 AND ${MAX_OBJECT_BYTES}
     ),
     entry_size INTEGER NOT NULL CHECK (entry_size >= 0),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT`,

  `CREATE INDEX IF NOT EXISTS git_pack_objects_loc
     ON git_pack_objects (repo_id, pack_id, offset)`,

  // Every pack keeps its own authenticated index while git_pack_objects
  // remains the canonical read owner for each OID. Packs are self-contained:
  // a delta names its base by offset inside the same pack.
  `CREATE TABLE IF NOT EXISTS git_pack_entries (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (pack_id >= 0),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     offset INTEGER NOT NULL CHECK (offset >= 0),
     data_off INTEGER NOT NULL CHECK (data_off >= 0),
     data_len INTEGER NOT NULL CHECK (data_len >= 0),
     type TEXT NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       size BETWEEN 0 AND ${MAX_OBJECT_BYTES}
     ),
     entry_size INTEGER NOT NULL CHECK (entry_size >= 0),
     base_offset INTEGER CHECK (
       base_offset IS NULL OR (
         base_offset >= 0 AND base_offset != offset
       )
     ),
     PRIMARY KEY (repo_id, pack_id, offset),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_pack_entries_by_oid
     ON git_pack_entries (repo_id, oid, pack_id, offset)`,

  // Delta entries whose base had not been seen yet when the pack was
  // scanned. Drained before the pack is marked complete.
  `CREATE TABLE IF NOT EXISTS git_pack_pending (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     offset INTEGER NOT NULL,
     data_off INTEGER NOT NULL,
     data_len INTEGER NOT NULL,
     entry_size INTEGER NOT NULL,
     base_oid TEXT,
     base_offset INTEGER,
     PRIMARY KEY (repo_id, pack_id, offset),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT`,
] as const;
