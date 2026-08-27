import { rethrowMaintenanceRootEpochError } from "./maintenance/control.js";

/** A structural subset of the Durable Object SQL cursor. */
export interface SQLCursorLike<Row extends object = Record<string, unknown>> extends Iterable<Row> {
  toArray(): Row[];
}

/** A structural subset of Durable Object SQLite storage. */
export interface SQLStorageLike {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SQLCursorLike<Row>;
}

/** The storage methods needed by the standalone runtime. */
export interface DurableObjectStorageLike {
  sql: SQLStorageLike;
  transactionSync?<T>(closure: () => T): T;
}

export interface SqlDatabase {
  run(query: string, ...bindings: unknown[]): void;
  all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined;
  scalar<T>(query: string, ...bindings: unknown[]): T | undefined;
  /** Lazy row iteration. Implementations must not materialise the cursor. */
  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
  transactionSync<T>(closure: () => T): T;
}

function objectRow<Row extends object>(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRow<Row extends object>(value: unknown): Row {
  if (!objectRow<Row>(value)) throw new Error("SQL cursor yielded a non-row value");
  const entries = Object.entries(value).map(([key, field]) => [
    key,
    field instanceof ArrayBuffer ? new Uint8Array(field) : field,
  ]);
  const normalized = Object.fromEntries(entries);
  if (!objectRow<Row>(normalized)) throw new Error("SQL cursor yielded a non-row value");
  return normalized;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
}

function requireSynchronous<T>(value: T): T {
  if (!isThenable(value)) return value;
  void Promise.resolve(value).catch(() => {});
  throw new Error("transactionSync closure returned an asynchronous result");
}

/** Refine a platform SQL cursor into a lazy iterable without trusting its type. */
export function* iterateSqlCursor(cursor: unknown): Generator<Record<string, unknown>> {
  if (typeof cursor !== "object" || cursor === null) {
    throw new Error("SQL cursor is not iterable");
  }
  const factory = Reflect.get(cursor, Symbol.iterator);
  if (typeof factory !== "function") throw new Error("SQL cursor is not iterable");
  const iterator = Reflect.apply(factory, cursor, []);
  if (typeof iterator !== "object" || iterator === null) {
    throw new Error("SQL cursor returned no iterator");
  }
  const next = Reflect.get(iterator, "next");
  if (typeof next !== "function") throw new Error("SQL cursor iterator has no next method");
  let finished = false;
  try {
    for (;;) {
      const step = Reflect.apply(next, iterator, []);
      if (typeof step !== "object" || step === null) {
        throw new Error("SQL cursor iterator returned an invalid step");
      }
      const done = Reflect.get(step, "done");
      if (done === true) {
        finished = true;
        return;
      }
      if (done !== false && done !== undefined) {
        throw new Error("SQL cursor iterator returned an invalid done flag");
      }
      yield normalizeRow(Reflect.get(step, "value"));
    }
  } finally {
    if (!finished) {
      const close = Reflect.get(iterator, "return");
      if (typeof close === "function") Reflect.apply(close, iterator, []);
    }
  }
}

/** Durable Object SQLite adapter shared by the filesystem and git stores. */
export class Database implements SqlDatabase {
  readonly sql: SQLStorageLike;

  constructor(private readonly storage: DurableObjectStorageLike) {
    this.sql = storage.sql;
  }

  run(query: string, ...bindings: unknown[]): void {
    try {
      this.sql.exec(query, ...bindings);
    } catch (error) {
      rethrowMaintenanceRootEpochError(error);
    }
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.sql
      .exec<Row>(query, ...bindings)
      .toArray()
      .map(normalizeRow<Row>);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    return row === undefined ? undefined : Object.values(row)[0];
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    return iterateSqlCursor(this.sql.exec(query, ...bindings));
  }

  transactionSync<T>(closure: () => T): T {
    if (this.storage.transactionSync !== undefined) {
      return this.storage.transactionSync(() => requireSynchronous(closure()));
    }
    throw new Error("Durable Object storage does not support synchronous transactions");
  }
}

/** Blob values must reach SQLite as bytes, not as a view over a larger buffer. */
export function blob(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

/** BLOB columns are normalized by Database, but structural adapters may call this directly. */
export function readBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("expected a BLOB column");
}
