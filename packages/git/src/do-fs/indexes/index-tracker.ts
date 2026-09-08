import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { isCanonicalAbsolutePath, isCanonicalGitPath } from "../../common/paths.js";
import { int, nullable, oneOf, RowShape, text } from "../../common/rows.js";
import { comparePaths } from "../../common/streams.js";
import {
  bumpMaintenanceRootEpoch,
  MAINTENANCE_ROOT_EPOCH_EXHAUSTED,
} from "../../store/maintenance/control.js";
import {
  INDEX_DIRTY,
  normalizedSql,
  TRACKER_FORMAT,
  TRIGGER_NAMES,
  TRIGGERS,
  WORKTREE_DIRTY,
} from "./index-tracker-triggers.js";

export { INDEX_DIRTY, WORKTREE_DIRTY } from "./index-tracker-triggers.js";

export type IndexTrackerState =
  | { available: false }
  | { available: true; baselineTreeOid: string | null };

export interface IndexTrackerDirty {
  path: string;
  flags: number;
}

const DEFAULT_PAGE_ROWS = 1_000;
const MAX_PAGE_ROWS = 1_000;
const MAX_PAGE_BYTES = 1024 * 1024;

const TRACKER_STATE_ROW = new RowShape({
  baseline_tree_oid: nullable(text()),
  format: int(1),
  complete: oneOf([0, 1]),
});
const TRACKER_DIRTY_ROW = new RowShape({
  path: text(),
  flags: oneOf([INDEX_DIRTY, WORKTREE_DIRTY, INDEX_DIRTY | WORKTREE_DIRTY]),
});

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
  if (!isCanonicalGitPath(path)) return null;
  let bytes = 0;
  for (let at = 0; at < path.length; at++) {
    const unit = path.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      at++;
      bytes += 4;
    } else if (unit < 0x80) {
      bytes++;
    } else if (unit < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
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
  const stored = db.one(
    `SELECT baseline_tree_oid, format, complete
       FROM git_index_state WHERE checkout_id = ?`,
    checkoutId,
  );
  if (stored === undefined) return { available: false };
  const row = TRACKER_STATE_ROW.decode(stored);
  if (row.complete !== 1 || row.format !== TRACKER_FORMAT) {
    return { available: false };
  }
  return { available: true, baselineTreeOid: row.baseline_tree_oid };
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
      const entry = TRACKER_DIRTY_ROW.decode(row);
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
        (metadata.root !== "/" && !isCanonicalAbsolutePath(metadata.root)) ||
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
