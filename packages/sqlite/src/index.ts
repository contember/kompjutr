export class GitError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "GitError";
  }
}

export const MAINTENANCE_ROOT_EPOCH_EXHAUSTED = "maintenance root epoch is exhausted";

export function rethrowMaintenanceRootEpochError(error: unknown): never {
  if (error instanceof Error && error.message.includes(MAINTENANCE_ROOT_EPOCH_EXHAUSTED)) {
    throw new GitError("E2BIG", MAINTENANCE_ROOT_EPOCH_EXHAUSTED);
  }
  throw error;
}

export interface SqlDatabase {
  /** Equal identities mean database and drive mutations share one atomic scope. */
  readonly mutationScope?: object;
  run(query: string, ...bindings: unknown[]): void;
  all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined;
  scalar<T>(query: string, ...bindings: unknown[]): T | undefined;
  /** Implementations must return a lazy cursor and close it on early return. */
  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
  /**
   * Nested calls share the outer transaction. Roll back a failed nested scope,
   * or refuse the outer commit when its effects cannot be undone independently.
   * Effects awaiting that refusal may remain visible inside the transaction.
   */
  transactionSync<T>(closure: () => T): T;
}

function objectRow<Row extends object>(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSqlRow<Row extends object>(value: unknown): Row {
  if (!objectRow<Row>(value)) throw new Error("SQL cursor yielded a non-row value");
  let normalized: Row | null = null;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const field = Reflect.get(value, key);
    if (!(field instanceof ArrayBuffer)) continue;
    normalized ??= { ...value };
    Reflect.set(normalized, key, new Uint8Array(field));
  }
  return normalized ?? value;
}

export function firstSqlRowValue<T>(row: Record<string, T>): T | undefined {
  for (const key in row) {
    if (Object.hasOwn(row, key)) return row[key];
  }
  return undefined;
}

function sqliteValueTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  const sqliteCode = Reflect.get(error, "sqliteCode");
  const errcode = Reflect.get(error, "errcode");
  return (
    code === "SQLITE_TOOBIG" ||
    code === 18 ||
    sqliteCode === "SQLITE_TOOBIG" ||
    sqliteCode === 18 ||
    errcode === "SQLITE_TOOBIG" ||
    errcode === 18
  );
}

export function rethrowSqliteError(error: unknown): never {
  if (sqliteValueTooLarge(error)) {
    throw new GitError("E2BIG", "SQLite rejected a value as too large", { cause: error });
  }
  rethrowMaintenanceRootEpochError(error);
}

export function* iterateSqlCursor<Row extends object = Record<string, unknown>>(
  cursor: unknown,
): Generator<Row> {
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
      yield normalizeSqlRow<Row>(Reflect.get(step, "value"));
    }
  } finally {
    if (!finished) {
      const close = Reflect.get(iterator, "return");
      if (typeof close === "function") Reflect.apply(close, iterator, []);
    }
  }
}

/**
 * A copy the caller cannot reach. Never `.slice()`: on a `Buffer` — what
 * `node:fs` and `node:http` hand back — that is Node's alias for `subarray()`
 * and returns a view over the caller's memory.
 */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** A driver-ready array whose view covers its whole backing buffer. */
export function blob(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : ownedBytes(bytes);
}

export function readBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("expected a BLOB column");
}

export const MAX_ROUTING_CHECKOUTS = 8_192;
export const MAX_ROUTING_CHECKOUTS_RETAINED_BYTES = 16 * 1024 * 1024;
export const MAX_ROUTING_ROOTS_UTF8_BYTES = 6 * 1024 * 1024;
