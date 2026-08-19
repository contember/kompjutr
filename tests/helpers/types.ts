// Structural copies of the two storage interfaces @cloudflare/computer
// consumes. Kept local so test fixtures don't reach into the package's
// bundled .d.ts chunk names.

export interface SQLCursorLike<Row extends object = Record<string, unknown>> {
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
  transaction?<T>(closure: () => T | Promise<T>): T | Promise<T>;
  transactionSync?<T>(closure: () => T): T;
}
