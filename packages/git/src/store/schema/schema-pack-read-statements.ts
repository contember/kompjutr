// Owner-scoped scratch for one paged packed read. The discovery frontier lives
// here instead of the isolate heap, so `origins x depth` costs rows, not memory.
// The literals mirror `MAX_DELTA_DEPTH` (50,000) and `MAX_PACK_BLOB_INPUTS`
// (4,096) in `../pack/shared.ts`; schema text cannot import from the pack layer.

const OWNER = `repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
  read_id TEXT NOT NULL CHECK (typeof(read_id) = 'text' AND length(read_id) > 0)`;
const OWNER_FOREIGN_KEY = `FOREIGN KEY (repo_id, read_id)
  REFERENCES git_pack_read_scopes (repo_id, read_id) ON DELETE CASCADE`;
const STEP = `step INTEGER NOT NULL CHECK (
    typeof(step) = 'integer' AND step BETWEEN 0 AND 50000
  )`;

export const PACK_READ_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_pack_read_scopes (
     ${OWNER},
     PRIMARY KEY (repo_id, read_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_read_pages (
     ${OWNER},
     ${STEP},
     entry_limit INTEGER NOT NULL CHECK (
       typeof(entry_limit) = 'integer' AND entry_limit BETWEEN 1 AND 4096
     ),
     PRIMARY KEY (repo_id, read_id, step),
     ${OWNER_FOREIGN_KEY}
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_read_frontier (
     ${OWNER},
     ${STEP},
     oid TEXT NOT NULL COLLATE BINARY
       CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     origin_id INTEGER NOT NULL CHECK (
       typeof(origin_id) = 'integer' AND origin_id BETWEEN 0 AND 4095
     ),
     depth INTEGER NOT NULL CHECK (
       typeof(depth) = 'integer' AND depth BETWEEN 0 AND 50000
     ),
     PRIMARY KEY (repo_id, read_id, step, oid, origin_id),
     UNIQUE (repo_id, read_id, origin_id, oid),
     ${OWNER_FOREIGN_KEY}
   ) WITHOUT ROWID`,
] as const;
