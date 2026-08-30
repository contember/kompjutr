import type { MemoryReservation } from "../../memory.js";
import type { SqlDatabase } from "../../sqlite/db.js";
import type { RealPath, ScanEntry, ScanOptions } from "../types.js";
import { realpathOwned } from "./resolve.js";
import { scanOwned } from "./scan.js";

const NATIVE_DATABASES = new WeakMap<object, SqlDatabase>();

/** Register the private owned-read capability of one native filesystem object. */
export function registerNativeOwnedReads(worktree: object, db: SqlDatabase): void {
  NATIVE_DATABASES.set(worktree, db);
}

/** Resolve through the native provider while its bounded result allocation is admitted. */
export function nativeRealpathOwned(
  worktree: object,
  path: string,
  reservation: MemoryReservation,
): RealPath | null {
  const db = NATIVE_DATABASES.get(worktree);
  if (db === undefined) return null;
  return realpathOwned(db, path, reservation);
}

/** Read one native SQLite page only after its authoritative metadata is admitted. */
export function nativeScanOwned(
  worktree: object,
  root: RealPath,
  options: ScanOptions,
  reservation: MemoryReservation,
): ScanEntry[] | null {
  const db = NATIVE_DATABASES.get(worktree);
  return db === undefined ? null : scanOwned(db, root, options, reservation);
}
