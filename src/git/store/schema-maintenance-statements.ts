export const MAINTENANCE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS git_loose_object_lifecycle (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     created_ms INTEGER NOT NULL CHECK (
       typeof(created_ms) = 'integer' AND created_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_control (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     root_epoch INTEGER NOT NULL CHECK (
       typeof(root_epoch) = 'integer' AND root_epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     next_run_id INTEGER NOT NULL CHECK (
       typeof(next_run_id) = 'integer' AND next_run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_runs (
     repo_id INTEGER PRIMARY KEY CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     observed_root_epoch INTEGER NOT NULL CHECK (
       typeof(observed_root_epoch) = 'integer'
       AND observed_root_epoch BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     phase TEXT NOT NULL CHECK (typeof(phase) = 'text' AND phase IN (
       'roots', 'mark', 'classify-loose', 'repack',
       'classify-packs', 'sweep-loose', 'sweep-packs', 'finish'
     )),
     started_ms INTEGER NOT NULL CHECK (
       typeof(started_ms) = 'integer' AND started_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     root_source TEXT NOT NULL CHECK (typeof(root_source) = 'text' AND root_source IN (
       'refs', 'heads', 'reflogs', 'index', 'index-baseline', 'shallow', 'operations', 'done'
     )),
     cursor_checkout_id INTEGER CHECK (
       cursor_checkout_id IS NULL OR (
         typeof(cursor_checkout_id) = 'integer'
         AND cursor_checkout_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     cursor_text TEXT CHECK (
       cursor_text IS NULL OR (
         typeof(cursor_text) = 'text'
         AND instr(cursor_text, char(0)) = 0
       )
     ),
     cursor_ordinal INTEGER CHECK (
       cursor_ordinal IS NULL OR (
         typeof(cursor_ordinal) = 'integer'
         AND cursor_ordinal BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     reachable_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reachable_objects) = 'integer'
       AND reachable_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     queued_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(queued_objects) = 'integer'
       AND queued_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     repacked_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(repacked_objects) = 'integer'
       AND repacked_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_objects INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reclaimed_objects) = 'integer'
       AND reclaimed_objects BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_packs INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reclaimed_packs) = 'integer'
       AND reclaimed_packs BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     reclaimed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(reclaimed_bytes) = 'integer'
       AND reclaimed_bytes BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     next_eligible_ms INTEGER CHECK (
       next_eligible_ms IS NULL OR (
         typeof(next_eligible_ms) = 'integer'
         AND next_eligible_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     restarted INTEGER NOT NULL DEFAULT 0 CHECK (
       typeof(restarted) = 'integer' AND restarted IN (0, 1)
     ),
     UNIQUE (repo_id, run_id),
     FOREIGN KEY (repo_id) REFERENCES git_maintenance_control (repo_id) ON DELETE CASCADE
   )`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     source_mask INTEGER NOT NULL CHECK (
       typeof(source_mask) = 'integer' AND source_mask BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     expanded INTEGER NOT NULL CHECK (typeof(expanded) = 'integer' AND expanded IN (0, 1)),
     shallow_boundary INTEGER NOT NULL CHECK (
       typeof(shallow_boundary) = 'integer' AND shallow_boundary IN (0, 1)
     ),
     physical_only INTEGER NOT NULL CHECK (
       typeof(physical_only) = 'integer' AND physical_only IN (0, 1)
     ),
     edge_cursor INTEGER NOT NULL CHECK (
       typeof(edge_cursor) = 'integer' AND edge_cursor BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS git_maintenance_objects_queue
     ON git_maintenance_objects (repo_id, run_id, expanded, physical_only, oid)`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_shallow (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     PRIMARY KEY (repo_id, run_id, oid),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_repack_batches (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     batch_id INTEGER NOT NULL CHECK (
       typeof(batch_id) = 'integer' AND batch_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     state TEXT NOT NULL CHECK (
       typeof(state) = 'text' AND state IN ('selected', 'pending', 'published')
     ),
     pack_id INTEGER CHECK (
       pack_id IS NULL OR (
         typeof(pack_id) = 'integer' AND pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       )
     ),
     object_count INTEGER NOT NULL CHECK (
       typeof(object_count) = 'integer' AND object_count BETWEEN 0 AND 2048
     ),
     inflated_bytes INTEGER NOT NULL CHECK (
       typeof(inflated_bytes) = 'integer'
       AND inflated_bytes BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       AND (inflated_bytes <= 33554432 OR object_count = 1)
     ),
     stored_bytes INTEGER NOT NULL CHECK (
       typeof(stored_bytes) = 'integer' AND stored_bytes BETWEEN 0 AND 67108864
     ),
     PRIMARY KEY (repo_id, run_id, batch_id),
     UNIQUE (repo_id, run_id),
     CHECK (
       (state = 'selected' AND pack_id IS NULL)
       OR (state IN ('pending', 'published') AND pack_id IS NOT NULL)
     ),
     FOREIGN KEY (repo_id, run_id)
       REFERENCES git_maintenance_runs (repo_id, run_id) ON DELETE CASCADE,
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_maintenance_repack_objects (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     run_id INTEGER NOT NULL CHECK (
       typeof(run_id) = 'integer' AND run_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     batch_id INTEGER NOT NULL CHECK (
       typeof(batch_id) = 'integer' AND batch_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 2047),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     size INTEGER NOT NULL CHECK (
       typeof(size) = 'integer' AND size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, run_id, oid),
     UNIQUE (repo_id, run_id, batch_id, ordinal),
     FOREIGN KEY (repo_id, run_id, batch_id)
       REFERENCES git_maintenance_repack_batches (repo_id, run_id, batch_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_loose_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       typeof(unreachable_since_ms) = 'integer'
       AND unreachable_since_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, oid),
     FOREIGN KEY (repo_id, oid) REFERENCES git_objects (repo_id, oid) ON DELETE CASCADE
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS git_pack_gc_candidates (
     repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
     pack_id INTEGER NOT NULL CHECK (
       typeof(pack_id) = 'integer' AND pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     unreachable_since_ms INTEGER NOT NULL CHECK (
       typeof(unreachable_since_ms) = 'integer'
       AND unreachable_since_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     PRIMARY KEY (repo_id, pack_id),
     FOREIGN KEY (repo_id, pack_id)
       REFERENCES git_pack_meta (repo_id, pack_id) ON DELETE CASCADE
   ) WITHOUT ROWID`,
] as const;
