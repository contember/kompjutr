export const TRANSFER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS git_transfers (
     transfer_id INTEGER PRIMARY KEY AUTOINCREMENT,
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}),
     released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
     phase TEXT NOT NULL DEFAULT 'common' CHECK (phase IN ('common', 'wanted', 'complete')),
     UNIQUE (repo_id, transfer_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS git_transfers_cleanup
     ON git_transfers (repo_id, released, expires_ms, transfer_id)`,
  `CREATE TABLE IF NOT EXISTS git_transfer_roots (
     root_id INTEGER PRIMARY KEY AUTOINCREMENT,
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     transfer_id INTEGER NOT NULL CHECK (transfer_id >= 1),
     oid TEXT NOT NULL CHECK (length(oid) = 40),
     UNIQUE (repo_id, transfer_id, oid),
     FOREIGN KEY (repo_id, transfer_id)
       REFERENCES git_transfers (repo_id, transfer_id) ON DELETE CASCADE
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS git_transfer_roots_page
     ON git_transfer_roots (repo_id, root_id)`,
  `CREATE TABLE IF NOT EXISTS git_transfer_objects (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     transfer_id INTEGER NOT NULL CHECK (transfer_id >= 1),
     side TEXT NOT NULL CHECK (side IN ('common', 'wanted')),
     oid TEXT NOT NULL CHECK (length(oid) = 40),
     expanded INTEGER NOT NULL DEFAULT 0 CHECK (expanded IN (0, 1)),
     edge_cursor INTEGER NOT NULL DEFAULT 0 CHECK (edge_cursor >= 0),
     edge_offset INTEGER CHECK (edge_offset IS NULL OR edge_offset >= 0),
     PRIMARY KEY (repo_id, transfer_id, side, oid),
     FOREIGN KEY (repo_id, transfer_id)
       REFERENCES git_transfers (repo_id, transfer_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS git_transfer_objects_frontier
     ON git_transfer_objects (repo_id, transfer_id, side, expanded, oid)`,
];
