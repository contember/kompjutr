import type { SqlDatabase } from "../../db/db.js";
import type { RealPath, ScanEntry, ScanOptions } from "../types.js";
import { realpathOwned } from "./resolve.js";
import { scanOwned } from "./scan.js";

const NATIVE_DATABASES = new WeakMap<object, SqlDatabase>();

/** Register the private owned-read capability of one native filesystem object. */
export function registerNativeOwnedReads(worktree: object, db: SqlDatabase): void {
  NATIVE_DATABASES.set(worktree, db);
}

/** Resolve through the native provider without widening its public contract. */
export function nativeRealpathOwned(worktree: object, path: string): RealPath | null {
  const db = NATIVE_DATABASES.get(worktree);
  if (db === undefined) return null;
  return realpathOwned(db, path);
}

/** Read one page through the native provider without widening its public contract. */
export function nativeScanOwned(
  worktree: object,
  root: RealPath,
  options: ScanOptions,
): ScanEntry[] | null {
  const db = NATIVE_DATABASES.get(worktree);
  return db === undefined ? null : scanOwned(db, root, options);
}
