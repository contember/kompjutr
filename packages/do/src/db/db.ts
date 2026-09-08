import {
  firstSqlRowValue,
  iterateSqlCursor,
  normalizeSqlRow,
  rethrowSqliteError,
  type SqlDatabase,
} from "@kompjutr/sqlite";

export {
  blob,
  GitError,
  iterateSqlCursor,
  MAINTENANCE_ROOT_EPOCH_EXHAUSTED,
  MAX_ROUTING_CHECKOUTS,
  MAX_ROUTING_CHECKOUTS_RETAINED_BYTES,
  MAX_ROUTING_ROOTS_UTF8_BYTES,
  normalizeSqlRow,
  readBlob,
  rethrowMaintenanceRootEpochError,
  rethrowSqliteError,
  type SqlDatabase,
} from "@kompjutr/sqlite";

export interface SQLCursorLike<Row extends object = Record<string, unknown>> extends Iterable<Row> {
  toArray(): Row[];
}

export interface SQLStorageLike {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SQLCursorLike<Row>;
}

export interface DurableObjectStorageLike {
  sql: SQLStorageLike;
  transactionSync?<T>(closure: () => T): T;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}

function requireSynchronous<T>(value: T): T {
  if (!isThenable(value)) return value;
  void Promise.resolve(value).catch(() => {});
  throw new Error("transactionSync closure returned an asynchronous result");
}

function* normalizeSqlRows(cursor: unknown): Generator<Record<string, unknown>> {
  try {
    yield* iterateSqlCursor(cursor);
  } catch (error) {
    rethrowSqliteError(error);
  }
}

/** Durable Object SQLite adapter shared by the filesystem and Git stores. */
export class Database implements SqlDatabase {
  readonly mutationScope: object;
  readonly sql: SQLStorageLike;

  constructor(private readonly storage: DurableObjectStorageLike) {
    this.mutationScope = storage;
    this.sql = storage.sql;
  }

  run(query: string, ...bindings: unknown[]): void {
    try {
      this.sql.exec(query, ...bindings);
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    try {
      return this.sql
        .exec<Row>(query, ...bindings)
        .toArray()
        .map(normalizeSqlRow<Row>);
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    return row === undefined ? undefined : firstSqlRowValue(row);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    try {
      return normalizeSqlRows(this.sql.exec(query, ...bindings));
    } catch (error) {
      rethrowSqliteError(error);
    }
  }

  transactionSync<T>(closure: () => T): T {
    if (this.storage.transactionSync === undefined) {
      throw new Error("Durable Object storage does not support synchronous transactions");
    }
    return this.storage.transactionSync(() => requireSynchronous(closure()));
  }
}
