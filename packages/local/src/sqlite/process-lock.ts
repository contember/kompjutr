import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { errorCode, localError, normalizeHostError } from "../errors.js";
import { requireCanonicalAbsolutePath } from "../paths.js";
import { syncDirectory } from "../recovery/fs.js";
import { requireSqlitePaths } from "./files.js";

const LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  root TEXT NOT NULL,
  state_directory TEXT NOT NULL,
  recovery_directory TEXT NOT NULL
);`;

export interface ProcessLockIdentity {
  readonly root: string;
  readonly stateDirectory: string;
  readonly recoveryDirectory: string;
}

function sqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqliteCode: unknown = Reflect.get(error, "sqliteCode");
  const errcode: unknown = Reflect.get(error, "errcode");
  return (
    errorCode(error) === "SQLITE_BUSY" ||
    sqliteCode === "SQLITE_BUSY" ||
    sqliteCode === 5 ||
    errcode === "SQLITE_BUSY" ||
    errcode === 5
  );
}

export class ProcessLock {
  readonly #path: string;
  readonly #connection: DatabaseSync;
  #closed = false;

  private constructor(path: string, connection: DatabaseSync) {
    this.#path = path;
    this.#connection = connection;
  }

  static acquire(path: string, identity: ProcessLockIdentity): ProcessLock {
    try {
      requireCanonicalAbsolutePath(path, "workspace lock");
      requireCanonicalAbsolutePath(identity.root, "root");
      requireCanonicalAbsolutePath(identity.stateDirectory, "stateDirectory");
      requireCanonicalAbsolutePath(identity.recoveryDirectory, "recoveryDirectory");
      requireSqlitePaths(path, "workspace lock");
      const connection = new DatabaseSync(path);
      try {
        connection.exec("PRAGMA busy_timeout = 0");
        connection.exec("BEGIN IMMEDIATE");
        connection.exec(LOCK_SCHEMA);
        connection
          .prepare(
            `INSERT OR IGNORE INTO workspace_identity
             (singleton, root, state_directory, recovery_directory) VALUES (1, ?, ?, ?)`,
          )
          .run(identity.root, identity.stateDirectory, identity.recoveryDirectory);
        const row: unknown = connection
          .prepare(
            `SELECT root, state_directory, recovery_directory
             FROM workspace_identity WHERE singleton = 1`,
          )
          .get();
        if (typeof row !== "object" || row === null) {
          throw localError("ECORRUPT", "workspace lock identity row is missing", path);
        }
        if (
          Reflect.get(row, "root") !== identity.root ||
          Reflect.get(row, "state_directory") !== identity.stateDirectory ||
          Reflect.get(row, "recovery_directory") !== identity.recoveryDirectory
        ) {
          throw localError("EINVAL", "workspace root is bound to another state configuration");
        }
        connection.exec("COMMIT");
        syncDirectory(dirname(path));
        connection.exec("BEGIN EXCLUSIVE");
        return new ProcessLock(path, connection);
      } catch (error) {
        try {
          if (connection.isTransaction) connection.exec("ROLLBACK");
        } catch {}
        try {
          connection.close();
        } catch {}
        throw error;
      }
    } catch (error) {
      if (sqliteBusy(error)) throw localError("EBUSY", "local workspace is already locked", path);
      normalizeHostError(error, "acquire workspace lock", path);
    }
  }

  close(): void {
    if (this.#closed) return;
    let failure: unknown;
    try {
      if (this.#connection.isTransaction) this.#connection.exec("ROLLBACK");
    } catch (error) {
      failure = error;
    }
    try {
      this.#connection.close();
      this.#closed = true;
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) normalizeHostError(failure, "release workspace lock", this.#path);
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
