import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { GitError, hasErrorCode, UnsupportedOperationError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { int, nullable, oneOf, RowShape } from "../../common/rows.js";
import type { SharedRepoStore } from "../index.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";

export const TRANSFER_TTL_MS = 5 * 60 * 1000;
export const TRANSFER_PAGE = 128;

export interface TransferOwner {
  repoId: number;
  transferId: number;
}
export interface TransferRoot {
  oid: string;
  type?: ObjectType;
}
export interface TransferOptions {
  wanted: Iterable<TransferRoot>;
  common?: Iterable<TransferRoot>;
  nowMs: number;
  ttlMs?: number;
}

const OWNER_ROW = new RowShape({
  expires_ms: int(0),
  released: oneOf([0, 1]),
  phase: oneOf(["common", "wanted", "complete"]),
});

export function requireTransferTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new GitError("EINVAL", "transfer clock must return non-negative integer milliseconds");
  }
}

function expiry(nowMs: number, ttlMs: number): number {
  requireTransferTime(nowMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(nowMs + ttlMs)) {
    throw new GitError("EINVAL", "transfer lifetime must be a positive safe integer");
  }
  return nowMs + ttlMs;
}

export function assertTransfer(store: SharedRepoStore, owner: TransferOwner, nowMs: number) {
  requireTransferTime(nowMs);
  if (
    owner.repoId !== store.repoId ||
    !Number.isSafeInteger(owner.transferId) ||
    owner.transferId < 1
  ) {
    throw new GitError("EINVAL", "transfer owner belongs to another repository or is invalid");
  }
  const raw = store.db.one<Record<string, unknown>>(
    "SELECT expires_ms, released, phase FROM git_transfers WHERE repo_id = ? AND transfer_id = ?",
    owner.repoId,
    owner.transferId,
  );
  if (raw === undefined) throw new GitError("ESTALE", "transfer no longer exists");
  const row = OWNER_ROW.decode(raw);
  if (row.released !== 0 || row.expires_ms <= nowMs) {
    throw new GitError("ESTALE", "transfer is released or expired");
  }
  return row;
}

function insertRoots(
  store: SharedRepoStore,
  owner: TransferOwner,
  side: "common" | "wanted",
  roots: Iterable<TransferRoot>,
): void {
  let page: TransferRoot[] = [];
  function flush(): void {
    if (page.length === 0) return;
    const infos = new Map(
      store.objectInfo(page.map((root) => root.oid)).map((info) => [info.oid, info]),
    );
    for (const root of page) {
      const info = infos.get(root.oid);
      if (info === undefined)
        throw new GitError("ENOTFOUND", `transfer root ${root.oid} is missing`);
      if (root.type !== undefined && info.type !== root.type) {
        throw new GitError(
          "EINVAL",
          `transfer root ${root.oid} is ${info.type}, expected ${root.type}`,
        );
      }
    }
    const payload = JSON.stringify(page.map((root) => root.oid));
    store.db.run(
      `INSERT OR IGNORE INTO git_transfer_roots (repo_id, transfer_id, oid)
      SELECT ?, ?, value FROM json_each(?)`,
      owner.repoId,
      owner.transferId,
      payload,
    );
    store.db.run(
      `INSERT OR IGNORE INTO git_transfer_objects (repo_id, transfer_id, side, oid)
      SELECT ?, ?, ?, value FROM json_each(?)`,
      owner.repoId,
      owner.transferId,
      side,
      payload,
    );
    page = [];
  }
  for (const root of roots) {
    if (!isOid(root.oid)) throw new GitError("EINVAL", "transfer root OID is invalid");
    page.push(root);
    if (page.length === TRANSFER_PAGE) flush();
  }
  flush();
}

export function requireCompleteRepository(store: SharedRepoStore): void {
  const completeness = new RowShape({ shallow: oneOf([0, 1]), promised: oneOf([0, 1]) }).decode(
    store.db.one<Record<string, unknown>>(
      `SELECT EXISTS (SELECT 1 FROM git_shallow WHERE repo_id = ?) AS shallow,
              EXISTS (SELECT 1 FROM git_promised_blobs WHERE repo_id = ?) AS promised`,
      store.repoId,
      store.repoId,
    ),
  );
  if (completeness.shallow !== 0 || completeness.promised !== 0) {
    throw new UnsupportedOperationError(
      "server transfers require a complete repository without shallow boundaries or unresolved promises",
    );
  }
}

export function createTransfer(store: SharedRepoStore, options: TransferOptions): TransferOwner {
  const expires = expiry(options.nowMs, options.ttlMs ?? TRANSFER_TTL_MS);
  return store.db.transactionSync(() => {
    requireCompleteRepository(store);
    const row = store.db.one<Record<string, unknown>>(
      "INSERT INTO git_transfers (repo_id, expires_ms) VALUES (?, ?) RETURNING transfer_id",
      store.repoId,
      expires,
    );
    const decoded = new RowShape({ transfer_id: int(1) }).decode(row);
    const owner = { repoId: store.repoId, transferId: decoded.transfer_id };
    insertRoots(store, owner, "common", options.common ?? []);
    insertRoots(store, owner, "wanted", options.wanted);
    bumpMaintenanceRootEpoch(store.db, store.repoId);
    return owner;
  });
}

export function renewTransfer(
  store: SharedRepoStore,
  owner: TransferOwner,
  nowMs: number,
  ttlMs = TRANSFER_TTL_MS,
): void {
  const expires = expiry(nowMs, ttlMs);
  store.db.transactionSync(() => {
    assertTransfer(store, owner, nowMs);
    // Unreleased roots remain roots past their deadline, so renewal changes no root set.
    store.db.run(
      "UPDATE git_transfers SET expires_ms = max(expires_ms, ?) WHERE repo_id = ? AND transfer_id = ?",
      expires,
      owner.repoId,
      owner.transferId,
    );
  });
}

export function releaseTransfer(store: SharedRepoStore, owner: TransferOwner): void {
  if (owner.repoId !== store.repoId)
    throw new GitError("EINVAL", "transfer belongs to another repository");
  let db: SqlDatabase;
  try {
    db = store.db;
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) return;
    throw error;
  }
  db.transactionSync(() => {
    const row = db.one<Record<string, unknown>>(
      `UPDATE git_transfers SET released = 1
      WHERE repo_id = ? AND transfer_id = ? AND released = 0 RETURNING transfer_id`,
      owner.repoId,
      owner.transferId,
    );
    if (row !== undefined) bumpMaintenanceRootEpoch(db, store.repoId);
  });
}

/** Release one expired owner or remove one fixed page of an already released owner's rows. */
export function cleanupTransfers(store: SharedRepoStore, nowMs: number): boolean {
  requireTransferTime(nowMs);
  return store.db.transactionSync(() => {
    const expired = store.db.one<Record<string, unknown>>(
      `SELECT transfer_id FROM git_transfers
      WHERE repo_id = ? AND released = 0 AND expires_ms <= ? ORDER BY expires_ms, transfer_id LIMIT 1`,
      store.repoId,
      nowMs,
    );
    if (expired !== undefined) {
      const row = new RowShape({ transfer_id: int(1) }).decode(expired);
      releaseTransfer(store, { repoId: store.repoId, transferId: row.transfer_id });
      return false;
    }
    const raw = store.db.one<Record<string, unknown>>(
      `SELECT transfer_id FROM git_transfers
      WHERE repo_id = ? AND released = 1 ORDER BY expires_ms, transfer_id LIMIT 1`,
      store.repoId,
    );
    if (raw === undefined) return true;
    const { transfer_id: id } = new RowShape({ transfer_id: int(1) }).decode(raw);
    store.db.run(
      `DELETE FROM git_transfer_objects WHERE repo_id = ? AND transfer_id = ? AND (side, oid) IN
      (SELECT side, oid FROM git_transfer_objects WHERE repo_id = ? AND transfer_id = ? ORDER BY side, oid LIMIT ${TRANSFER_PAGE})`,
      store.repoId,
      id,
      store.repoId,
      id,
    );
    store.db.run(
      `DELETE FROM git_transfer_roots WHERE root_id IN
      (SELECT root_id FROM git_transfer_roots WHERE repo_id = ? AND transfer_id = ? ORDER BY oid LIMIT ${TRANSFER_PAGE})`,
      store.repoId,
      id,
    );
    store.db.run(
      `DELETE FROM git_transfers WHERE repo_id = ? AND transfer_id = ?
      AND NOT EXISTS (SELECT 1 FROM git_transfer_objects WHERE repo_id = ? AND transfer_id = ?)
      AND NOT EXISTS (SELECT 1 FROM git_transfer_roots WHERE repo_id = ? AND transfer_id = ?)`,
      store.repoId,
      id,
      store.repoId,
      id,
      store.repoId,
      id,
    );
    return false;
  });
}

export function nextTransferExpiryMs(store: SharedRepoStore): number | null {
  return new RowShape({ expires_ms: nullable(int(0)) }).decode(
    store.db.one<Record<string, unknown>>(
      "SELECT min(expires_ms) AS expires_ms FROM git_transfers WHERE repo_id = ? AND released = 0",
      store.repoId,
    ),
  ).expires_ms;
}
