import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";
import {
  bumpMaintenanceRootEpoch,
  MAINTENANCE_ROOT_EPOCH_EXHAUSTED,
} from "./maintenance/control.js";

export const INDEX_DIRTY = 1;
export const WORKTREE_DIRTY = 2;

export type IndexTrackerState =
  | { available: false }
  | { available: true; baselineTreeOid: string | null };

export interface IndexTrackerDirty {
  path: string;
  flags: number;
}

const TRACKER_FORMAT = 1;
const DEFAULT_PAGE_ROWS = 1_000;
const MAX_PAGE_ROWS = 1_000;
const MAX_PAGE_BYTES = 1024 * 1024;

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

const TRIGGERS = [
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

const TRIGGER_NAMES = TRIGGERS.map(triggerName);

function normalizedSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^CREATE TRIGGER IF NOT EXISTS /, "CREATE TRIGGER ");
}

function validateCheckoutId(checkoutId: number): void {
  if (!Number.isSafeInteger(checkoutId) || checkoutId <= 0) {
    throw new CorruptError("invalid checkout id");
  }
}

function isMaintenanceEpochExhaustion(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "message") === MAINTENANCE_ROOT_EPOCH_EXHAUSTED
  );
}

function relativePathBytes(path: string): number | null {
  if (path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("\0")) {
    return null;
  }
  let bytes = 0;
  let segmentStart = 0;
  for (let at = 0; at < path.length; at++) {
    const unit = path.charCodeAt(at);
    if (unit === 0x2f) {
      const segmentLength = at - segmentStart;
      if (
        segmentLength === 0 ||
        (segmentLength === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
        (segmentLength === 2 &&
          path.charCodeAt(segmentStart) === 0x2e &&
          path.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        return null;
      }
      segmentStart = at + 1;
      bytes++;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(++at);
      if (next < 0xdc00 || next > 0xdfff) return null;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    } else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
  }
  const segmentLength = path.length - segmentStart;
  if (
    (segmentLength === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
    (segmentLength === 2 &&
      path.charCodeAt(segmentStart) === 0x2e &&
      path.charCodeAt(segmentStart + 1) === 0x2e)
  ) {
    return null;
  }
  return bytes;
}

function validRoot(root: string): boolean {
  if (!root.startsWith("/") || root.includes("\0")) return false;
  if (root === "/") return true;
  if (root.endsWith("/")) return false;
  let segmentStart = 1;
  for (let at = 1; at <= root.length; at++) {
    if (at === root.length || root.charCodeAt(at) === 0x2f) {
      const length = at - segmentStart;
      if (
        length === 0 ||
        (length === 1 && root.charCodeAt(segmentStart) === 0x2e) ||
        (length === 2 &&
          root.charCodeAt(segmentStart) === 0x2e &&
          root.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        return false;
      }
      segmentStart = at + 1;
      continue;
    }
    const unit = root.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = root.charCodeAt(++at);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateDirty(entry: IndexTrackerDirty): void {
  if (typeof entry.path !== "string" || relativePathBytes(entry.path) === null) {
    throw new CorruptError("index tracker has an invalid path");
  }
  if (!Number.isInteger(entry.flags) || entry.flags < INDEX_DIRTY || entry.flags > 3) {
    throw new CorruptError("index tracker has invalid dirty flags");
  }
}

interface EncodedEntrySize {
  bindingBytes: number;
}

function encodedEntrySize(entry: IndexTrackerDirty): EncodedEntrySize {
  let bindingBytes = 5 + String(entry.flags).length;
  for (let at = 0; at < entry.path.length; at++) {
    const unit = entry.path.charCodeAt(at);
    if (unit === 0x22 || unit === 0x5c) {
      bindingBytes += 2;
    } else if (unit < 0x20) {
      bindingBytes += 6;
    } else if (unit < 0x80) {
      bindingBytes++;
    } else if (unit < 0x800) {
      bindingBytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      at++;
      bindingBytes += 4;
    } else {
      bindingBytes += 3;
    }
    if (!Number.isSafeInteger(bindingBytes)) {
      throw new GitError("E2BIG", "index tracker entry encoding exceeds the safe integer range");
    }
  }
  return { bindingBytes };
}

function insertPage(db: SqlDatabase, checkoutId: number, page: IndexTrackerDirty[]): void {
  const json = JSON.stringify(page.map((entry) => [entry.path, entry.flags]));
  db.run(
    `INSERT INTO git_index_dirty (checkout_id, path, flags)
       SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]')
         FROM json_each(?)
        WHERE true
       ON CONFLICT (checkout_id, path) DO UPDATE SET flags = flags | excluded.flags`,
    checkoutId,
    json,
  );
}

export function initializeIndexTracker(db: SqlDatabase): void {
  db.transactionSync(() => {
    const installed = new Map<string, string>();
    for (const row of db.all<Record<string, unknown>>(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name IN (SELECT value FROM json_each(?))`,
      JSON.stringify(TRIGGER_NAMES),
    )) {
      if (typeof row.name === "string" && typeof row.sql === "string") {
        installed.set(row.name, normalizedSql(row.sql));
      }
    }
    const replace = TRIGGERS.some(
      (definition, index) =>
        installed.get(TRIGGER_NAMES[index] ?? "") !== normalizedSql(definition),
    );
    if (replace) {
      const exhausted = db.scalar<unknown>(
        `SELECT EXISTS(
           SELECT 1
             FROM git_index_state state
             JOIN git_checkouts checkout ON checkout.id = state.checkout_id
             JOIN git_maintenance_control control ON control.repo_id = checkout.repo_id
            WHERE state.complete = 1 AND control.root_epoch = ?
            LIMIT 1
         )`,
        Number.MAX_SAFE_INTEGER,
      );
      if (exhausted !== 0 && exhausted !== 1) {
        throw new CorruptError("index tracker epoch exhaustion probe is invalid");
      }
      if (exhausted === 1) throw new GitError("E2BIG", MAINTENANCE_ROOT_EPOCH_EXHAUSTED);
      db.run(
        `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
         SELECT DISTINCT checkout.repo_id, 1, 1
           FROM git_index_state state
           JOIN git_checkouts checkout ON checkout.id = state.checkout_id
          WHERE state.complete = 1
         ON CONFLICT(repo_id) DO UPDATE SET root_epoch = root_epoch + 1`,
      );
      db.run("UPDATE git_index_state SET complete = 0 WHERE complete = 1");
      for (const name of TRIGGER_NAMES) db.run(`DROP TRIGGER IF EXISTS ${name}`);
      for (const trigger of TRIGGERS) db.run(trigger);
    }
    db.run(
      `INSERT OR IGNORE INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
       SELECT id, NULL, ?, 0 FROM git_checkouts`,
      TRACKER_FORMAT,
    );
  });
}

export function readIndexTrackerState(db: SqlDatabase, checkoutId: number): IndexTrackerState {
  validateCheckoutId(checkoutId);
  const row = db.one<Record<string, unknown>>(
    `SELECT CASE
              WHEN baseline_tree_oid IS NULL THEN NULL
              WHEN typeof(baseline_tree_oid) = 'text'
                AND length(CAST(baseline_tree_oid AS BLOB)) = 40
                THEN baseline_tree_oid
            END AS baseline_tree_oid,
            CASE WHEN baseline_tree_oid IS NULL
                    OR (typeof(baseline_tree_oid) = 'text'
                      AND length(CAST(baseline_tree_oid AS BLOB)) = 40)
                 THEN 1 ELSE 0 END AS baseline_valid,
            CASE WHEN typeof(format) = 'integer' THEN format END AS format,
            CASE WHEN typeof(complete) = 'integer' THEN complete END AS complete
       FROM git_index_state WHERE checkout_id = ?`,
    checkoutId,
  );
  if (
    row === undefined ||
    row.complete !== 1 ||
    row.format !== TRACKER_FORMAT ||
    row.baseline_valid !== 1
  ) {
    return { available: false };
  }
  const baseline = row.baseline_tree_oid;
  if (baseline !== null && (typeof baseline !== "string" || !isOid(baseline))) {
    return { available: false };
  }
  return { available: true, baselineTreeOid: baseline };
}

function* dirtyRows(
  db: SqlDatabase,
  checkoutId: number,
  pageRows: number,
): Generator<IndexTrackerDirty> {
  let after: string | null = null;
  for (;;) {
    let ordinal = 0;
    let hasMore = false;
    for (const row of db.iterate(
      `SELECT path, flags
             FROM git_index_dirty
            WHERE checkout_id = ? AND (? IS NULL OR path > ? COLLATE BINARY)
            ORDER BY path COLLATE BINARY LIMIT ?`,
      checkoutId,
      after,
      after,
      pageRows + 1,
    )) {
      const path = row.path;
      const flags = row.flags;
      if (typeof path !== "string" || typeof flags !== "number") {
        throw new CorruptError("index tracker has a malformed dirty row");
      }
      const entry: IndexTrackerDirty = { path, flags };
      validateDirty(entry);
      if (after !== null && comparePaths(entry.path, after) <= 0) {
        throw new CorruptError("index tracker dirty rows are unordered");
      }
      if (ordinal === pageRows) {
        hasMore = true;
        break;
      }
      after = entry.path;
      ordinal++;
      yield entry;
    }
    if (!hasMore) return;
  }
}

export function iterateIndexTrackerDirty(
  db: SqlDatabase,
  checkoutId: number,
  pageRows: number = DEFAULT_PAGE_ROWS,
): Iterable<IndexTrackerDirty> {
  validateCheckoutId(checkoutId);
  if (!Number.isSafeInteger(pageRows) || pageRows <= 0 || pageRows > MAX_PAGE_ROWS) {
    throw new CorruptError("invalid index tracker page size");
  }
  return dirtyRows(db, checkoutId, pageRows);
}

export function invalidateIndexTracker(db: SqlDatabase, checkoutId: number): void {
  validateCheckoutId(checkoutId);
  db.transactionSync(() => {
    const checkout = db.one<Record<string, unknown>>(
      `SELECT checkout.repo_id, state.complete
         FROM git_checkouts checkout
         LEFT JOIN git_index_state state ON state.checkout_id = checkout.id
        WHERE checkout.id = ?`,
      checkoutId,
    );
    if (checkout === undefined) throw new CorruptError("index tracker checkout is missing");
    if (
      typeof checkout.repo_id !== "number" ||
      !Number.isSafeInteger(checkout.repo_id) ||
      checkout.repo_id < 1 ||
      (checkout.complete !== null && checkout.complete !== 0 && checkout.complete !== 1)
    ) {
      throw new CorruptError("index tracker checkout state is malformed");
    }
    db.run(
      `INSERT INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
       VALUES (?, NULL, ?, 0)
       ON CONFLICT (checkout_id) DO UPDATE SET complete = 0`,
      checkoutId,
      TRACKER_FORMAT,
    );
    if (checkout.complete === 1) bumpMaintenanceRootEpoch(db, checkout.repo_id);
  });
}

/** Move only a complete tracker's baseline; the caller owns any outer transaction. */
export function advanceIndexTrackerBaseline(
  db: SqlDatabase,
  checkoutId: number,
  baselineTreeOid: string | null,
): boolean {
  validateCheckoutId(checkoutId);
  if (baselineTreeOid !== null && !isOid(baselineTreeOid)) {
    throw new CorruptError("invalid index tracker baseline tree");
  }
  return db.transactionSync(() => {
    const row = db.one<Record<string, unknown>>(
      `UPDATE git_index_state
          SET baseline_tree_oid = ?
        WHERE checkout_id = ? AND format = ? AND complete = 1
        RETURNING checkout_id, baseline_tree_oid, format, complete`,
      baselineTreeOid,
      checkoutId,
      TRACKER_FORMAT,
    );
    if (row === undefined) return false;
    if (
      row.checkout_id !== checkoutId ||
      row.baseline_tree_oid !== baselineTreeOid ||
      row.format !== TRACKER_FORMAT ||
      row.complete !== 1
    ) {
      throw new CorruptError("index tracker baseline update returned malformed state");
    }
    const repoId = db.scalar<unknown>("SELECT repo_id FROM git_checkouts WHERE id = ?", checkoutId);
    if (typeof repoId !== "number" || !Number.isSafeInteger(repoId) || repoId < 1) {
      throw new CorruptError("index tracker baseline repository is invalid");
    }
    bumpMaintenanceRootEpoch(db, repoId);
    return true;
  });
}

export function resealIndexTracker(
  db: SqlDatabase,
  checkoutId: number,
  baselineTreeOid: string | null,
  entries: Iterable<IndexTrackerDirty>,
): boolean {
  validateCheckoutId(checkoutId);
  if (baselineTreeOid !== null && !isOid(baselineTreeOid)) {
    throw new CorruptError("invalid index tracker baseline tree");
  }
  try {
    return db.transactionSync(() => {
      const metadata = db.one<Record<string, unknown>>(
        `SELECT checkout.root, checkout.repo_id,
                state.complete AS previous_complete
           FROM git_checkouts checkout
           LEFT JOIN git_index_state state ON state.checkout_id = checkout.id
          WHERE checkout.id = ?`,
        checkoutId,
      );
      if (metadata === undefined) return false;
      if (
        typeof metadata.root !== "string" ||
        !validRoot(metadata.root) ||
        typeof metadata.repo_id !== "number" ||
        !Number.isSafeInteger(metadata.repo_id) ||
        metadata.repo_id < 1 ||
        (metadata.previous_complete !== null &&
          metadata.previous_complete !== 0 &&
          metadata.previous_complete !== 1)
      ) {
        throw new CorruptError("index tracker checkout row is malformed");
      }
      db.run(
        `INSERT INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
         VALUES (?, NULL, ?, 0)
         ON CONFLICT (checkout_id) DO UPDATE SET complete = 0`,
        checkoutId,
        TRACKER_FORMAT,
      );
      const root = db.one<Record<string, unknown>>(
        `SELECT nodes.type AS type
           FROM fs_paths paths JOIN fs_nodes nodes ON nodes.inode = paths.inode
          WHERE paths.path = ?`,
        metadata.root,
      );
      if (root === undefined || root.type !== "dir") {
        if (metadata.previous_complete === 1) {
          bumpMaintenanceRootEpoch(db, metadata.repo_id);
        }
        return false;
      }

      db.run("DELETE FROM git_index_dirty WHERE checkout_id = ?", checkoutId);
      let page: IndexTrackerDirty[] = [];
      let pageBindingBytes = 2;
      const flush = (): void => {
        if (page.length === 0) return;
        insertPage(db, checkoutId, page);
        page = [];
        pageBindingBytes = 2;
      };
      try {
        for (const entry of entries) {
          validateDirty(entry);
          const encoded = encodedEntrySize(entry);
          const separator = page.length === 0 ? 0 : 1;
          if (
            page.length === MAX_PAGE_ROWS ||
            (page.length !== 0 &&
              pageBindingBytes + encoded.bindingBytes + separator > MAX_PAGE_BYTES)
          ) {
            flush();
          }
          page.push({ path: entry.path, flags: entry.flags });
          pageBindingBytes += encoded.bindingBytes + (page.length === 1 ? 0 : 1);
          if (!Number.isSafeInteger(pageBindingBytes)) {
            throw new GitError("E2BIG", "index tracker reseal encoding is too large");
          }
          if (page.length === 1 && pageBindingBytes > MAX_PAGE_BYTES) flush();
        }
        flush();
      } catch (error) {
        if (!hasErrorCode(error, "E2BIG")) throw error;
        if (metadata.previous_complete === 1) bumpMaintenanceRootEpoch(db, metadata.repo_id);
        return false;
      }
      db.run(
        `UPDATE git_index_state
            SET baseline_tree_oid = ?, format = ?, complete = 1
          WHERE checkout_id = ?`,
        baselineTreeOid,
        TRACKER_FORMAT,
        checkoutId,
      );
      bumpMaintenanceRootEpoch(db, metadata.repo_id);
      return true;
    });
  } catch (error) {
    if (!hasErrorCode(error, "E2BIG") || isMaintenanceEpochExhaustion(error)) throw error;
    invalidateIndexTracker(db, checkoutId);
    return false;
  }
}
