import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { localError } from "../errors.js";
import { requireCanonicalAbsolutePath } from "../paths.js";
import { syncDirectory } from "../recovery/fs.js";
import { requireSqlitePaths } from "./files.js";

const OWNER_SCHEMA = `
CREATE TABLE IF NOT EXISTS recovery_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  root TEXT NOT NULL,
  state_directory TEXT NOT NULL,
  recovery_directory TEXT NOT NULL
);`;

export interface RecoveryOwnerIdentity {
  readonly root: string;
  readonly stateDirectory: string;
  readonly recoveryDirectory: string;
}

export function recoveryOwnerPath(recoveryDirectory: string): string {
  return `${recoveryDirectory}.kompjutr-owner.sqlite`;
}

export function bindRecoveryOwner(identity: RecoveryOwnerIdentity): void {
  requireCanonicalAbsolutePath(identity.root, "root");
  requireCanonicalAbsolutePath(identity.stateDirectory, "stateDirectory");
  requireCanonicalAbsolutePath(identity.recoveryDirectory, "recoveryDirectory");
  const path = recoveryOwnerPath(identity.recoveryDirectory);
  requireSqlitePaths(path, "recovery owner");
  const connection = new DatabaseSync(path);
  try {
    connection.exec("PRAGMA busy_timeout = 0");
    connection.exec("BEGIN IMMEDIATE");
    connection.exec(OWNER_SCHEMA);
    connection
      .prepare(
        `INSERT OR IGNORE INTO recovery_identity
         (singleton, root, state_directory, recovery_directory) VALUES (1, ?, ?, ?)`,
      )
      .run(identity.root, identity.stateDirectory, identity.recoveryDirectory);
    const row: unknown = connection
      .prepare(
        `SELECT root, state_directory, recovery_directory
         FROM recovery_identity WHERE singleton = 1`,
      )
      .get();
    if (typeof row !== "object" || row === null) {
      throw localError("ECORRUPT", "recovery owner identity row is missing", path);
    }
    if (
      Reflect.get(row, "root") !== identity.root ||
      Reflect.get(row, "state_directory") !== identity.stateDirectory ||
      Reflect.get(row, "recovery_directory") !== identity.recoveryDirectory
    ) {
      throw localError("EINVAL", "recovery directory belongs to another workspace", path);
    }
    connection.exec("COMMIT");
  } catch (error) {
    try {
      if (connection.isTransaction) connection.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    connection.close();
  }
  syncDirectory(dirname(path));
}
