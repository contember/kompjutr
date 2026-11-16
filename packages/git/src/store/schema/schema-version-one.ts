// Frozen 0.1.4 definitions of the tables schema version 2 rebuilt. Never edit:
// a version-one database is recognized by this exact text.

export const VERSION_ONE_REPOSITORIES = `CREATE TABLE IF NOT EXISTS git_repositories (
     id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
       id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
     ),
     lifecycle TEXT NOT NULL DEFAULT 'ready' CHECK (
       lifecycle IN ('ready', 'provisional')
     ),
     clone_expires_ms INTEGER CHECK (
       clone_expires_ms IS NULL
       OR clone_expires_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     fetch_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       fetch_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     shallow_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       shallow_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     checkout_revision INTEGER NOT NULL DEFAULT 0 CHECK (
       checkout_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     source_generation INTEGER NOT NULL DEFAULT 0 CHECK (
       source_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
     ),
     CHECK (
       (lifecycle = 'ready' AND clone_expires_ms IS NULL)
       OR (lifecycle = 'provisional' AND clone_expires_ms IS NOT NULL)
     )
   ) STRICT`;

export const VERSION_ONE_MAINTENANCE_RUNS = `CREATE TABLE IF NOT EXISTS git_maintenance_runs (
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
   ) STRICT`;

// ADD COLUMN cannot change a table CHECK, so "provisional implies workspace"
// moves into the kind column's own CHECK.
const KIND_COLUMN = `kind TEXT NOT NULL DEFAULT 'workspace' CHECK (
       kind IN ('workspace', 'bare') AND (kind = 'workspace' OR lifecycle = 'ready')
     )`;
const DEFAULT_BRANCH_COLUMN = `default_branch TEXT NOT NULL DEFAULT 'refs/heads/main' CHECK (
       substr(default_branch, 1, 11) = 'refs/heads/'
       AND length(default_branch) > 11
       AND instr(default_branch, char(0)) = 0
       AND instr(default_branch, char(10)) = 0
       AND instr(default_branch, char(13)) = 0
     )`;

export const VERSION_ONE_REPOSITORY_ALTERATIONS = [
  `ALTER TABLE git_repositories ADD COLUMN ${KIND_COLUMN}`,
  `ALTER TABLE git_repositories ADD COLUMN ${DEFAULT_BRANCH_COLUMN}`,
];

// SQLite splices each added column in before the first table constraint as
// ", <definition>"; this is the text the two alterations leave behind.
const TABLE_CONSTRAINT = `,
     CHECK (
       (lifecycle = 'ready' AND clone_expires_ms IS NULL)`;
if (!VERSION_ONE_REPOSITORIES.includes(TABLE_CONSTRAINT)) {
  throw new Error("version-one repository definition lost its table constraint anchor");
}
export const MIGRATED_REPOSITORIES = VERSION_ONE_REPOSITORIES.replace(
  TABLE_CONSTRAINT,
  `, ${KIND_COLUMN}, ${DEFAULT_BRANCH_COLUMN}${TABLE_CONSTRAINT}`,
);

/** Every git_maintenance_runs column; version 2 changed only a CHECK. */
export const VERSION_ONE_MAINTENANCE_RUN_COLUMNS =
  "repo_id, run_id, observed_root_epoch, observed_source_generation, phase, started_ms, " +
  "root_source, cursor_checkout_id, cursor_text, cursor_ordinal, reachable_objects, " +
  "queued_objects, reclaimed_objects, reclaimed_packs, reclaimed_bytes, next_eligible_ms, restarted";
