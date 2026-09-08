import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  firstSqlRowValue,
  iterateSqlCursor,
  rethrowSqliteError,
  type SqlDatabase,
} from "@kompjutr/sqlite";
import { localError } from "../errors.js";
import { requireCanonicalAbsolutePath } from "../paths.js";
import type { RecoveryTransactionOwner } from "../recovery/contracts.js";
import { requireSqlitePaths } from "./files.js";

const LOCAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  recovery_generation INTEGER NOT NULL CHECK (recovery_generation >= 0),
  root TEXT,
  recovery_directory TEXT,
  CHECK ((root IS NULL) = (recovery_directory IS NULL))
);
INSERT OR IGNORE INTO local_runtime_state
  (singleton, recovery_generation, root, recovery_directory) VALUES (1, 0, NULL, NULL);`;

const OBSERVATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS observation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_revision INTEGER NOT NULL CHECK (next_revision >= 1)
);
INSERT OR IGNORE INTO observation_state (singleton, next_revision) VALUES (1, 1);`;

function sqliteBinding(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw localError("EINVAL", "unsupported SQLite binding value");
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}

function requireCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw localError("ECORRUPT", `${label} is not a safe nonnegative integer`);
  }
  return Number(value);
}

function* normalizedRows(
  cursor: unknown,
  observed: () => void,
): Generator<Record<string, unknown>> {
  try {
    for (const row of iterateSqlCursor(cursor)) {
      observed();
      yield row;
    }
  } catch (error) {
    rethrowSqliteError(error);
  }
}

export interface NodeSqliteDatabaseOptions {
  readonly mutationScope?: object;
  readonly recovery?: RecoveryTransactionOwner;
  readonly root?: string;
  readonly recoveryDirectory?: string;
}

interface SqlEffects {
  readonly changes: number;
  readonly schema: number;
}

export interface NodeSqliteMetrics {
  readonly statements: number;
  readonly rows: number;
}

export class NodeSqliteDatabase implements SqlDatabase {
  readonly mutationScope: object;
  readonly #path: string;
  readonly #observationPath: string;
  readonly #recovery: RecoveryTransactionOwner | undefined;
  #connection: DatabaseSync;
  #observationConnection: DatabaseSync | null = null;
  #primaryClosed = false;
  #depth = 0;
  #closed = false;
  #asyncResultDetected = false;
  #nestedFailureLeftEffects = false;
  #statements = 0;
  #rows = 0;

  constructor(path: string, options: NodeSqliteDatabaseOptions = {}) {
    requireSqlitePaths(path, "SQLite database");
    if ((options.root === undefined) !== (options.recoveryDirectory === undefined)) {
      throw localError("EINVAL", "root and recoveryDirectory must be configured together");
    }
    if (options.root !== undefined && options.recoveryDirectory !== undefined) {
      requireCanonicalAbsolutePath(options.root, "root");
      requireCanonicalAbsolutePath(options.recoveryDirectory, "recoveryDirectory");
    }
    this.#path = path;
    this.#observationPath = `${path}.observations`;
    this.#recovery = options.recovery;
    this.mutationScope = options.mutationScope ?? this;
    this.#connection = this.#open();
    try {
      this.#connection.exec(LOCAL_SCHEMA);
      if (options.root !== undefined && options.recoveryDirectory !== undefined) {
        this.#bindRuntimePaths(options.root, options.recoveryDirectory);
      }
    } catch (error) {
      this.#connection.close();
      throw error;
    }
  }

  #open(): DatabaseSync {
    requireSqlitePaths(this.#path, "SQLite database");
    const connection = new DatabaseSync(this.#path);
    try {
      connection.exec("PRAGMA journal_mode = WAL");
      connection.exec("PRAGMA synchronous = FULL");
      connection.exec("PRAGMA foreign_keys = ON");
      return connection;
    } catch (error) {
      try {
        connection.close();
      } catch {}
      throw error;
    }
  }

  #bindRuntimePaths(root: string, recoveryDirectory: string): void {
    this.#connection
      .prepare(
        `UPDATE local_runtime_state SET root = ?, recovery_directory = ?
         WHERE singleton = 1 AND root IS NULL AND recovery_directory IS NULL`,
      )
      .run(root, recoveryDirectory);
    const row: unknown = this.#connection
      .prepare("SELECT root, recovery_directory FROM local_runtime_state WHERE singleton = 1")
      .get();
    if (typeof row !== "object" || row === null) {
      throw localError("ECORRUPT", "local runtime identity row is missing");
    }
    const storedRoot: unknown = Reflect.get(row, "root");
    const storedRecovery: unknown = Reflect.get(row, "recovery_directory");
    if (storedRoot !== root || storedRecovery !== recoveryDirectory) {
      throw localError("EINVAL", "SQLite state belongs to another root or recovery directory");
    }
  }

  #observations(): DatabaseSync {
    if (this.#observationConnection !== null) return this.#observationConnection;
    requireSqlitePaths(this.#observationPath, "observation database");
    const connection = new DatabaseSync(this.#observationPath);
    try {
      connection.exec("PRAGMA journal_mode = WAL");
      connection.exec("PRAGMA synchronous = FULL");
      connection.exec(OBSERVATION_SCHEMA);
      this.#observationConnection = connection;
      return connection;
    } catch (error) {
      try {
        connection.close();
      } catch {}
      throw error;
    }
  }

  #requireOpen(): DatabaseSync {
    if (this.#closed) throw localError("EBADF", "SQLite database is closed", this.#path);
    return this.#connection;
  }

  run(query: string, ...bindings: unknown[]): void {
    try {
      const connection = this.#requireOpen();
      this.#statements++;
      if (bindings.length === 0 && /;\s*\S/.test(query)) {
        connection.exec(query);
        return;
      }
      connection.prepare(query).run(...bindings.map(sqliteBinding));
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    try {
      this.#statements++;
      const iterator = this.#requireOpen()
        .prepare(query)
        .iterate(...bindings.map(sqliteBinding));
      const rows = Array.from(iterateSqlCursor<Row>(iterator));
      this.#rows += rows.length;
      return rows;
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    try {
      this.#statements++;
      const iterator = this.#requireOpen()
        .prepare(query)
        .iterate(...bindings.map(sqliteBinding));
      for (const row of iterateSqlCursor<Row>(iterator)) {
        this.#rows++;
        return row;
      }
      return undefined;
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    return row === undefined ? undefined : firstSqlRowValue(row);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    try {
      this.#statements++;
      const iterator = this.#requireOpen()
        .prepare(query)
        .iterate(...bindings.map(sqliteBinding));
      return normalizedRows(iterator, () => this.#rows++);
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  recoveryGeneration(): number {
    return requireCounter(
      this.scalar("SELECT recovery_generation FROM local_runtime_state WHERE singleton = 1"),
      "recovery generation",
    );
  }

  metrics(): NodeSqliteMetrics {
    return { statements: this.#statements, rows: this.#rows };
  }

  resetMetrics(): void {
    this.#statements = 0;
    this.#rows = 0;
  }

  leaseObservationRevisions(count: number): { start: number; end: number } {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw localError("EINVAL", "observation revision lease must be a positive safe integer");
    }
    const connection = this.#observations();
    connection.exec("BEGIN IMMEDIATE");
    try {
      const row: unknown = connection
        .prepare("SELECT next_revision FROM observation_state WHERE singleton = 1")
        .get();
      const start = requireCounter(
        typeof row === "object" && row !== null ? Reflect.get(row, "next_revision") : undefined,
        "next observation revision",
      );
      const end = start + count;
      if (!Number.isSafeInteger(end)) {
        throw localError("E2BIG", "observation revisions are exhausted");
      }
      connection
        .prepare("UPDATE observation_state SET next_revision = ? WHERE singleton = 1")
        .run(end);
      connection.exec("COMMIT");
      return { start, end };
    } catch (error) {
      if (connection.isTransaction) connection.exec("ROLLBACK");
      throw error;
    }
  }

  transactionSync<T>(closure: () => T): T {
    if (this.#depth > 0) {
      const sql = this.#sqlEffects();
      const disk = this.#recovery?.diskEffects ?? 0;
      let nested: T;
      try {
        nested = closure();
      } catch (error) {
        if (this.#nestedScopeChanged(sql, disk)) this.#nestedFailureLeftEffects = true;
        throw error;
      }
      if (isThenable(nested)) {
        this.#asyncResultDetected = true;
        void Promise.resolve(nested).catch(() => {});
        throw localError("EINVAL", "transactionSync closure returned an asynchronous result");
      }
      return nested;
    }
    const connection = this.#requireOpen();
    this.#asyncResultDetected = false;
    this.#nestedFailureLeftEffects = false;
    connection.exec("BEGIN IMMEDIATE");
    this.#depth++;
    let baseGeneration: number;
    try {
      baseGeneration = this.recoveryGeneration();
      this.#recovery?.begin(baseGeneration);
    } catch (error) {
      this.#rollbackAfterFailure(error, true);
    }
    let result: T;
    let diskChanged = false;
    try {
      result = closure();
      if (isThenable(result)) {
        this.#asyncResultDetected = true;
        void Promise.resolve(result).catch(() => {});
        throw localError("EINVAL", "transactionSync closure returned an asynchronous result");
      }
      if (this.#asyncResultDetected) {
        throw localError(
          "EINVAL",
          "nested transactionSync closure returned an asynchronous result",
        );
      }
      if (this.#nestedFailureLeftEffects) {
        throw localError(
          "ERECOVERY",
          "a failed nested transaction made the transaction abort-only",
        );
      }
      if (this.#recovery?.abortOnly === true) {
        throw localError("ERECOVERY", "a failed disk operation made the transaction abort-only");
      }
      diskChanged = (this.#recovery?.diskEffects ?? 0) > 0;
      if (diskChanged) {
        if (baseGeneration === Number.MAX_SAFE_INTEGER) {
          throw localError("E2BIG", "recovery generation is exhausted");
        }
        this.run(
          "UPDATE local_runtime_state SET recovery_generation = ? WHERE singleton = 1",
          baseGeneration + 1,
        );
        this.#recovery?.checkpoint("generation-written");
      }
    } catch (error) {
      this.#rollbackAfterFailure(error);
    }

    try {
      if (diskChanged) this.#recovery?.checkpoint("before-commit");
      connection.exec("COMMIT");
      if (diskChanged) this.#recovery?.checkpoint("after-commit");
    } catch (error) {
      this.#settleUncertain(error);
    }

    this.#depth--;
    try {
      this.#recovery?.commitSucceeded();
    } catch (error) {
      this.#poison();
      throw error;
    }
    return result;
  }

  /** Rows and schema this connection changed, counting what a rollback later undoes. */
  #sqlEffects(): SqlEffects {
    const row = this.one<Record<string, unknown>>(
      `SELECT total_changes() AS changes,
              (SELECT schema_version FROM pragma_schema_version()) AS schema`,
    );
    return {
      changes: requireCounter(row?.changes, "total change count"),
      schema: requireCounter(row?.schema, "schema version"),
    };
  }

  #nestedScopeChanged(sql: SqlEffects, disk: number): boolean {
    if ((this.#recovery?.diskEffects ?? 0) !== disk) return true;
    try {
      const current = this.#sqlEffects();
      return current.changes !== sql.changes || current.schema !== sql.schema;
    } catch {
      // An unreadable connection cannot prove the nested closure changed nothing.
      return true;
    }
  }

  #rollbackAfterFailure(error: unknown, poisonAfterSettlement = false): never {
    let rollbackFailure: unknown;
    try {
      if (this.#connection.isTransaction) this.#connection.exec("ROLLBACK");
    } catch (caught) {
      rollbackFailure = caught;
    }
    this.#depth = 0;
    if (rollbackFailure !== undefined) {
      this.#recoverAfterUncertainConnection(
        error,
        poisonAfterSettlement || this.#asyncResultDetected,
      );
    }
    try {
      this.#recovery?.rollback();
    } catch (recoveryFailure) {
      this.#poison();
      throw recoveryFailure;
    }
    if (poisonAfterSettlement || this.#asyncResultDetected) this.#poison();
    throw error;
  }

  #settleUncertain(error: unknown): never {
    this.#recoverAfterUncertainConnection(error);
  }

  #recoverAfterUncertainConnection(error: unknown, poisonAfterSettlement = false): never {
    try {
      this.#connection.close();
      this.#primaryClosed = true;
    } catch (closeFailure) {
      this.#depth = 0;
      this.#poison();
      throw closeFailure;
    }
    try {
      this.#connection = this.#open();
      this.#primaryClosed = false;
      this.#depth = 0;
      this.#recovery?.settleUncertain(this.recoveryGeneration());
    } catch (settlementFailure) {
      this.#poison();
      throw settlementFailure;
    }
    if (poisonAfterSettlement) this.#poison();
    throw error;
  }

  #poison(): void {
    this.#closed = true;
    this.#depth = 0;
    this.#recovery?.abandon();
    this.#closeConnections();
  }

  #closeConnections(): unknown {
    let failure: unknown;
    if (this.#observationConnection !== null) {
      try {
        this.#observationConnection.close();
        this.#observationConnection = null;
      } catch (error) {
        failure = error;
      }
    }
    if (!this.#primaryClosed) {
      try {
        this.#connection.close();
        this.#primaryClosed = true;
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  close(): void {
    if (this.#closed && this.#primaryClosed && this.#observationConnection === null) return;
    if (this.#depth !== 0) throw localError("EBUSY", "cannot close SQLite during a transaction");
    this.#closed = true;
    const failure = this.#closeConnections();
    if (failure !== undefined) throw failure;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
