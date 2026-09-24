export const MAINTENANCE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_maintenance_control (
     repo_id INTEGER PRIMARY KEY CHECK (repo_id >= 1),
     root_epoch INTEGER NOT NULL CHECK (
       root_epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     next_run_id INTEGER NOT NULL CHECK (
       next_run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_runs (
     repo_id INTEGER PRIMARY KEY CHECK (repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     observed_root_epoch INTEGER NOT NULL CHECK (
       observed_root_epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     observed_source_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       observed_source_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     phase TEXT NOT NULL CHECK (phase IN (
       'roots', 'mark', 'loose', 'packs', 'finish'
     )),
     started_ms INTEGER NOT NULL CHECK (
       started_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     root_source TEXT NOT NULL CHECK (root_source IN (
       'refs', 'heads', 'reflogs', 'index', 'index-baseline', 'shallow', 'operations', 'done'
     )),
     cursor_checkout_id INTEGER CHECK (
       cursor_checkout_id IS NULL OR (
         cursor_checkout_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     cursor_text TEXT CHECK (
       cursor_text IS NULL OR (
         instr(cursor_text, char(0)) = 0
       )
     ),
     cursor_ordinal INTEGER CHECK (
       cursor_ordinal IS NULL OR (
         cursor_ordinal BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     reachable_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       reachable_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     queued_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       queued_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       reclaimed_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_packs INTEGER NOT NULL DEFAULT 0 CHECK (
       reclaimed_packs BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
       reclaimed_bytes BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     next_eligible_ms INTEGER CHECK (
       next_eligible_ms IS NULL OR (
         next_eligible_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     restarted INTEGER NOT NULL DEFAULT 0 CHECK (
       restarted IN (0, 1)
     ),
     UNIQUE (repo_id, run_id),
     FOREIGN KEY (repo_id) REFERENCES git_maintenance_control (repo_id) ON DELETE CASCADE
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_objects (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     source_mask INTEGER NOT NULL CHECK (
       source_mask BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     expanded INTEGER NOT NULL CHECK (expanded IN (0, 1)),
     shallow_boundary INTEGER NOT NULL CHECK (
       shallow_boundary IN (0, 1)
     ),
     edge_cursor INTEGER NOT NULL CHECK (
       edge_cursor BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_maintenance_objects_queue
     ON git_maintenance_objects (repo_id, run_id, expanded, oid)`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_shallow (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_loose_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     oid TEXT NOT NULL CHECK (length(CAST(oid AS BLOB)) = 40),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       unreachable_since_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (
       pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       unreachable_since_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) STRICT, WITHOUT ROWID`,
] as const;
