import { lstatSync } from "node:fs";

import { errorCode, localError } from "../errors.js";

function requireNonSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw localError("EACCES", `${label} must not be a symbolic link`, path);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function requireSqlitePaths(path: string, label: string): void {
  if (!path.isWellFormed() || path.includes("\0")) {
    throw localError("EINVAL", `${label} path is invalid`, path);
  }
  for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
    requireNonSymlink(candidate, label);
  }
}
