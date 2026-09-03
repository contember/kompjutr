import { CorruptError } from "../../common/errors.js";
import { MAINTENANCE_ROOT_EPOCH_EXHAUSTED } from "../maintenance/control.js";

export const INDEX_DIRTY = 1;
export const WORKTREE_DIRTY = 2;
export const TRACKER_FORMAT = 1;

function invalidPathSql(path: string): string {
  return `typeof(${path}) <> 'text'
    OR ${path} = ''
    OR substr(${path}, 1, 1) = '/'
    OR substr(${path}, -1) = '/'
    OR instr(${path}, char(0)) > 0
    OR instr(${path}, '//') > 0
    OR ${path} = '.' OR ${path} = '..'
    OR substr(${path}, 1, 2) = './'
    OR substr(${path}, 1, 3) = '../'
    OR instr(${path}, '/./') > 0
    OR instr(${path}, '/../') > 0
    OR substr(${path}, -2) = '/.'
    OR substr(${path}, -3) = '/..'`;
}

function ownerRows(paths: string): string {
  return `SELECT checkout.id AS checkout_id,
                 CASE WHEN checkout.root = '/' THEN substr(p.path, 2)
                      WHEN p.path = checkout.root THEN ''
                      ELSE substr(p.path, length(checkout.root) + 2) END AS relative
            FROM (${paths}) p
            JOIN git_checkouts checkout ON checkout.id = (
              SELECT candidate.id
                FROM git_checkouts candidate
               WHERE candidate.root = '/'
                  OR p.path = candidate.root
                  OR substr(p.path, 1, length(candidate.root) + 1) = candidate.root || '/'
               ORDER BY length(candidate.root) DESC, candidate.id DESC
               LIMIT 1
            )`;
}

function baselineInvalidationEpoch(checkoutIds: string): string {
  const repositories = `SELECT DISTINCT checkout.repo_id
    FROM git_checkouts checkout
    JOIN git_index_state state ON state.checkout_id = checkout.id AND state.complete = 1
    JOIN (${checkoutIds}) affected ON affected.checkout_id = checkout.id`;
  return `SELECT CASE WHEN EXISTS (
            SELECT 1 FROM (${repositories}) repository
            JOIN git_maintenance_control control ON control.repo_id = repository.repo_id
             WHERE control.root_epoch = ${Number.MAX_SAFE_INTEGER}
          ) THEN RAISE(ABORT, '${MAINTENANCE_ROOT_EPOCH_EXHAUSTED}') END;
          INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
          SELECT repo_id, 1, 1 FROM (${repositories}) WHERE true
          ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1;`;
}

function worktreeJournal(paths: string): string {
  const owners = ownerRows(paths);
  const invalid = `(${invalidPathSql("relative")})
    OR relative = '.gitignore'
    OR substr(relative, -11) = '/.gitignore'`;
  const invalidOwners = `SELECT checkout_id FROM (${owners}) owners WHERE ${invalid}`;
  return `${baselineInvalidationEpoch(invalidOwners)}
          UPDATE git_index_state
             SET complete = 0
           WHERE complete = 1
             AND checkout_id IN (
               ${invalidOwners}
             );
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT checkout_id, relative, ${WORKTREE_DIRTY}
            FROM (${owners}) owners
           WHERE NOT (${invalidPathSql("relative")})
             AND relative <> '.gitignore'
             AND substr(relative, -11) <> '/.gitignore'
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = owners.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;`;
}

function indexUpsert(row: "OLD" | "NEW", flags: number): string {
  const invalid = invalidPathSql(`${row}.path`);
  const invalidCheckout = `SELECT ${row}.checkout_id AS checkout_id WHERE ${invalid}`;
  return `${baselineInvalidationEpoch(invalidCheckout)}
          UPDATE git_index_state
             SET complete = 0
           WHERE checkout_id = ${row}.checkout_id AND complete = 1 AND (${invalid});
          INSERT INTO git_index_dirty (checkout_id, path, flags)
          SELECT ${row}.checkout_id, ${row}.path, ${flags}
           WHERE NOT (${invalid})
             AND EXISTS (
               SELECT 1 FROM git_index_state state
                WHERE state.checkout_id = ${row}.checkout_id AND state.complete = 1
             )
          ON CONFLICT (checkout_id, path) DO UPDATE
          SET flags = flags | excluded.flags;`;
}

const INDEX_SEMANTIC_CHANGE = `OLD.checkout_id IS NOT NEW.checkout_id
  OR OLD.path IS NOT NEW.path
  OR OLD.stage IS NOT NEW.stage
  OR OLD.mode IS NOT NEW.mode
  OR OLD.oid IS NOT NEW.oid`;

const INDEX_STAT_CHANGE = `OLD.size IS NOT NEW.size
  OR OLD.mtime IS NOT NEW.mtime
  OR OLD.ino IS NOT NEW.ino
  OR OLD.rev IS NOT NEW.rev`;

const COMPLETE_GATE = "EXISTS (SELECT 1 FROM git_index_state WHERE complete = 1)";

export const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS index_tracker_index_insert
   AFTER INSERT ON git_index WHEN ${COMPLETE_GATE}
   BEGIN
     ${indexUpsert("NEW", INDEX_DIRTY | WORKTREE_DIRTY)}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_index_delete
   AFTER DELETE ON git_index WHEN ${COMPLETE_GATE}
   BEGIN
     ${indexUpsert("OLD", INDEX_DIRTY | WORKTREE_DIRTY)}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_index_update_semantic
   AFTER UPDATE ON git_index WHEN ${COMPLETE_GATE} AND (${INDEX_SEMANTIC_CHANGE})
   BEGIN
     ${indexUpsert("OLD", INDEX_DIRTY | WORKTREE_DIRTY)}
     ${indexUpsert("NEW", INDEX_DIRTY | WORKTREE_DIRTY)}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_index_update_stat
   AFTER UPDATE ON git_index
   WHEN ${COMPLETE_GATE} AND NOT (${INDEX_SEMANTIC_CHANGE}) AND (${INDEX_STAT_CHANGE})
   BEGIN
     ${indexUpsert("OLD", WORKTREE_DIRTY)}
     ${indexUpsert("NEW", WORKTREE_DIRTY)}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_paths_insert
   AFTER INSERT ON fs_paths WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT NEW.path AS path")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_paths_delete
   AFTER DELETE ON fs_paths WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT OLD.path AS path")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_paths_update
   AFTER UPDATE ON fs_paths WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT OLD.path AS path UNION ALL SELECT NEW.path AS path")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_nodes_insert
   AFTER INSERT ON fs_nodes WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT path FROM fs_paths WHERE inode = NEW.inode")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_nodes_delete
   AFTER DELETE ON fs_nodes WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT path FROM fs_paths WHERE inode = OLD.inode")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_nodes_update
   AFTER UPDATE ON fs_nodes WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal(
       "SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode",
     )}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_chunks_insert
   AFTER INSERT ON fs_chunks WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT path FROM fs_paths WHERE inode = NEW.inode")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_chunks_delete
   AFTER DELETE ON fs_chunks WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal("SELECT path FROM fs_paths WHERE inode = OLD.inode")}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_chunks_update
   AFTER UPDATE ON fs_chunks WHEN ${COMPLETE_GATE}
   BEGIN
     ${worktreeJournal(
       "SELECT path FROM fs_paths WHERE inode = OLD.inode UNION SELECT path FROM fs_paths WHERE inode = NEW.inode",
     )}
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_checkout_insert
   AFTER INSERT ON git_checkouts
   BEGIN
     INSERT OR IGNORE INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
     VALUES (NEW.id, NULL, ${TRACKER_FORMAT}, 0);
     UPDATE git_index_state
        SET complete = 0
      WHERE checkout_id = (
        SELECT ancestor.id FROM git_checkouts ancestor
         WHERE ancestor.id <> NEW.id
           AND (ancestor.root = '/'
             OR NEW.root = ancestor.root
             OR substr(NEW.root, 1, length(ancestor.root) + 1) = ancestor.root || '/')
         ORDER BY length(ancestor.root) DESC, ancestor.id DESC
         LIMIT 1
      );
   END`,
  `CREATE TRIGGER IF NOT EXISTS index_tracker_checkout_delete
   AFTER DELETE ON git_checkouts
   BEGIN
     UPDATE git_index_state
        SET complete = 0
      WHERE checkout_id = (
        SELECT ancestor.id FROM git_checkouts ancestor
         WHERE ancestor.root = '/'
            OR OLD.root = ancestor.root
            OR substr(OLD.root, 1, length(ancestor.root) + 1) = ancestor.root || '/'
         ORDER BY length(ancestor.root) DESC, ancestor.id DESC
         LIMIT 1
      );
   END`,
];

function triggerName(definition: string): string {
  const prefix = "CREATE TRIGGER IF NOT EXISTS ";
  const end = definition.indexOf("\n");
  if (!definition.startsWith(prefix) || end < prefix.length) {
    throw new CorruptError("invalid owned index tracker trigger definition");
  }
  return definition.slice(prefix.length, end);
}

export const TRIGGER_NAMES = TRIGGERS.map(triggerName);

export function normalizedSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^CREATE TRIGGER IF NOT EXISTS /, "CREATE TRIGGER ");
}
