import { registerNativeDriveReads } from "@kompjutr/drive";
import type { SqlDatabase } from "@kompjutr/sqlite";
import { realpathOwned } from "./resolve.js";
import { scanOwned } from "./scan.js";

/** Register direct SQL reads without exposing them on the filesystem surface. */
export function registerNativeOwnedReads(worktree: object, db: SqlDatabase): void {
  registerNativeDriveReads(worktree, {
    realpath: (path) => realpathOwned(db, path),
    scan: (root, options) => scanOwned(db, root, options),
  });
}
