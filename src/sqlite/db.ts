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
  /**
   * Computer's Database reserves transaction handling for this method —
   * a bare BEGIN issued through `run` would open a transaction its
   * resolve cache cannot see.
   */
  transactionSync<T>(closure: () => T): T;
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
