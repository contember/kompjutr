import { MAX_OBJECT_BYTES } from "../common/objects.js";

const COMMIT_TABLE = `CREATE TABLE IF NOT EXISTS git_commits (
  repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
  oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
  parents TEXT NOT NULL CHECK (
    typeof(parents) = 'text' AND json_valid(parents) AND json_type(parents) = 'array'
  ),
  tree TEXT NOT NULL CHECK (typeof(tree) = 'text' AND length(CAST(tree AS BLOB)) = 40),
  author_name BLOB NOT NULL CHECK (typeof(author_name) = 'blob'),
  author_email BLOB NOT NULL CHECK (typeof(author_email) = 'blob'),
  author_time INTEGER NOT NULL CHECK (typeof(author_time) = 'integer'),
  author_timezone INTEGER NOT NULL CHECK (typeof(author_timezone) = 'integer'),
  committer_name BLOB NOT NULL CHECK (typeof(committer_name) = 'blob'),
  committer_email BLOB NOT NULL CHECK (typeof(committer_email) = 'blob'),
  committer_time INTEGER NOT NULL CHECK (typeof(committer_time) = 'integer'),
  committer_timezone INTEGER NOT NULL CHECK (typeof(committer_timezone) = 'integer'),
  message BLOB NOT NULL CHECK (typeof(message) = 'blob'),
  gpgsig BLOB CHECK (gpgsig IS NULL OR typeof(gpgsig) = 'blob'),
  object_size INTEGER NOT NULL CHECK (typeof(object_size) = 'integer' AND object_size >= 0),
  cache_bytes INTEGER NOT NULL CHECK (typeof(cache_bytes) = 'integer' AND cache_bytes >= 0),
  PRIMARY KEY (repo_id, oid),
  FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
) WITHOUT ROWID`;

export const OBJECT_SCHEMA_STATEMENTS = [
  // Loose objects: everything created locally, zlib-deflated and chunked.
  // A future repack folds them into a pack; nothing here depends on that.
  // `stored` names the encoding of the chunk bytes: 'zlib' or 'raw'.
  // Deflating an already-incompressible or tiny object costs more than it
  // saves, and the threshold is a client option.
  `CREATE TABLE IF NOT EXISTS git_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND ${MAX_OBJECT_BYTES}
     ),
     stored TEXT NOT NULL DEFAULT 'zlib'
       CHECK (typeof(stored) = 'text' AND stored IN ('zlib','raw')),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE TRIGGER IF NOT EXISTS git_promised_blobs_loose_present
   AFTER INSERT ON git_objects
   BEGIN
     DELETE FROM git_promised_blobs
      WHERE repo_id = NEW.repo_id AND oid = NEW.oid;
   END`,

  // Full parsed commits for graph walks and reads. This remains a derived
  // cache: source metadata is validated before a row can be returned.
  COMMIT_TABLE,

  `CREATE TABLE IF NOT EXISTS git_object_chunks (
     repo_id INTEGER NOT NULL,
     oid TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, oid, seq),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   )`,

  // Received packs are kept verbatim, still compressed. `state` is
  // 'pending' until the trailer has been verified and every entry
  // indexed; an interrupted fetch leaves a pending pack that the next
  // ingest reclaims.
  `CREATE TABLE IF NOT EXISTS git_pack_meta (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (typeof(pack_id) = 'integer' AND pack_id >= 0),
     size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
     count INTEGER NOT NULL CHECK (typeof(count) = 'integer' AND count >= 0),
     state TEXT NOT NULL CHECK (typeof(state) = 'text' AND state IN ('pending','complete')),
     created INTEGER NOT NULL CHECK (typeof(created) = 'integer' AND created >= 0),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  // Ordinary pack ingestion is async. This durable generation lease prevents
  // another store facade from reclaiming or reusing its pending identity.
  `CREATE TABLE IF NOT EXISTS git_pack_ingest_control (
     repo_id INTEGER PRIMARY KEY CHECK (
       typeof(repo_id) = 'integer' AND repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     owner_generation INTEGER NOT NULL CHECK (
       typeof(owner_generation) = 'integer'
       AND owner_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     last_pack_id INTEGER NOT NULL CHECK (
       typeof(last_pack_id) = 'integer' AND last_pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     active_pack_id INTEGER CHECK (
       active_pack_id IS NULL OR (
         typeof(active_pack_id) = 'integer'
         AND active_pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
         AND active_pack_id <= last_pack_id
       )
     ),
     expires_ms INTEGER CHECK (
       expires_ms IS NULL OR (
         typeof(expires_ms) = 'integer' AND expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     CHECK ((active_pack_id IS NULL) = (expires_ms IS NULL)),
     CHECK (active_pack_id IS NULL OR owner_generation >= 1),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id, active_pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_data (
     repo_id INTEGER NOT NULL,
     pack_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data BLOB NOT NULL,
     PRIMARY KEY (repo_id, pack_id, seq),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_pack_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     pack_id INTEGER NOT NULL CHECK (typeof(pack_id) = 'integer' AND pack_id >= 0),
     offset INTEGER NOT NULL CHECK (typeof(offset) = 'integer' AND offset >= 0),
     data_off INTEGER NOT NULL CHECK (typeof(data_off) = 'integer' AND data_off >= 0),
     data_len INTEGER NOT NULL CHECK (typeof(data_len) = 'integer' AND data_len >= 0),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND ${MAX_OBJECT_BYTES}
     ),
     entry_size INTEGER NOT NULL CHECK (typeof(entry_size) = 'integer' AND entry_size >= 0),
     base_oid TEXT CHECK (
       base_oid IS NULL OR (typeof(base_oid) = 'text' AND length(CAST(base_oid AS BLOB)) = 40)
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   )`,

  `CREATE INDEX IF NOT EXISTS git_pack_objects_loc
     ON git_pack_objects (repo_id, pack_id, offset)`,

  // Every pack keeps its own authenticated index while git_pack_objects
  // remains the canonical read owner for each OID.
  `CREATE TABLE IF NOT EXISTS git_pack_entries (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (typeof(pack_id) = 'integer' AND pack_id >= 0),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     offset INTEGER NOT NULL CHECK (typeof(offset) = 'integer' AND offset >= 0),
     data_off INTEGER NOT NULL CHECK (typeof(data_off) = 'integer' AND data_off >= 0),
     data_len INTEGER NOT NULL CHECK (typeof(data_len) = 'integer' AND data_len >= 0),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND ${MAX_OBJECT_BYTES}
     ),
     entry_size INTEGER NOT NULL CHECK (typeof(entry_size) = 'integer' AND entry_size >= 0),
     base_oid TEXT CHECK (
       base_oid IS NULL OR (typeof(base_oid) = 'text' AND length(CAST(base_oid AS BLOB)) = 40)
     ),
     PRIMARY KEY (repo_id, pack_id, offset),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_pack_entries_by_oid
     ON git_pack_entries (repo_id, oid, pack_id, offset)`,

  // Maintenance asks the reverse question — which OIDs a surviving pack still
  // needs as a delta base — once per swept loose object.
  `CREATE INDEX IF NOT EXISTS git_pack_entries_by_base
     ON git_pack_entries (repo_id, base_oid) WHERE base_oid IS NOT NULL`,

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
   )`,

  `CREATE INDEX IF NOT EXISTS git_pack_pending_by_base
     ON git_pack_pending (repo_id, base_oid) WHERE base_oid IS NOT NULL`,
] as const;
