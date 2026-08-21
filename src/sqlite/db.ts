/**
 * The slice of `@cloudflare/dofs`'s `Database` this package uses.
 * Declared structurally so the SQLite store can be exercised against any
 * SQL storage, and so nothing here imports a Computer-internal type.
 */
export interface SqlDatabase {
  run(query: string, ...bindings: unknown[]): void;
  all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined;
  scalar<T>(query: string, ...bindings: unknown[]): T | undefined;
  /** Lazy row iteration. Implementations must not materialise the cursor. */
  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
  /**
   * Computer's Database reserves transaction handling for this method —
   * a bare BEGIN issued through `run` would open a transaction its
   * resolve cache cannot see.
   */
  transactionSync<T>(closure: () => T): T;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SQL iterator yielded a non-row value");
  }
  return Object.fromEntries(Object.entries(value));
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
  for (;;) {
    const step = Reflect.apply(next, iterator, []);
    if (typeof step !== "object" || step === null) {
      throw new Error("SQL cursor iterator returned an invalid step");
    }
    const done = Reflect.get(step, "done");
    if (done === true) return;
    if (done !== false && done !== undefined) {
      throw new Error("SQL cursor iterator returned an invalid done flag");
    }
    yield record(Reflect.get(step, "value"));
  }
}

/** Blob values must reach SQLite as bytes, not as a view over a larger buffer. */
export function blob(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

/** BLOB columns come back as ArrayBuffer on the DO runtime, Uint8Array on node. */
export function readBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("expected a BLOB column");
}
