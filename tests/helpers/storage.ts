// node:sqlite-backed DurableObjectStorageLike, so the whole stack can run
// under plain vitest. Workers' DO SQL surface is a subset of this.

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { DurableObjectStorageLike, SQLCursorLike } from "./types.js";

function isObjectRow<Row extends object>(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Cursor<Row extends object> implements SQLCursorLike<Row>, IterableIterator<Row> {
  #prefetched: IteratorResult<unknown> | null;
  #finished = false;

  constructor(
    private readonly iterator: Iterator<unknown>,
    private readonly onRow: () => void,
    private readonly onDone: () => void,
  ) {
    // Advancing once executes writes while keeping reads lazy.
    this.#prefetched = this.#pull();
  }

  #pull(): IteratorResult<unknown> {
    const step = this.iterator.next();
    if (step.done === true && !this.#finished) {
      this.#finished = true;
      this.onDone();
    } else this.onRow();
    return step;
  }

  next(): IteratorResult<Row> {
    if (this.#finished && this.#prefetched === null) return { done: true, value: undefined };
    const step = this.#prefetched ?? this.#pull();
    this.#prefetched = null;
    if (step.done === true) return { done: true, value: undefined };
    if (!isObjectRow<Row>(step.value)) throw new Error("SQLite yielded a non-row value");
    return { done: false, value: step.value };
  }

  return(): IteratorResult<Row> {
    if (!this.#finished) {
      this.iterator.return?.();
      this.#finished = true;
      this.#prefetched = null;
      this.onDone();
    }
    return { done: true, value: undefined };
  }

  [Symbol.iterator](): IterableIterator<Row> {
    return this;
  }

  toArray(): Row[] {
    return Array.from(this);
  }
}

/**
 * The platform rejects SQL transaction statements outright, so the double must
 * too — otherwise a `BEGIN` emitted by `src/` passes here and fails only in a
 * Durable Object. Its own `transactionSync` goes straight to `db`, below this.
 */
const TRANSACTION_SQL = /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

function rejectTransactionSQL(query: string): void {
  if (TRANSACTION_SQL.test(query)) {
    throw new Error("transaction SQL is reserved for the storage runtime");
  }
}

function toSQLiteValue(value: unknown): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error("unsupported SQLite binding");
}

export class SqliteTestStorage implements DurableObjectStorageLike {
  readonly db: DatabaseSync;
  readonly sql: {
    exec: <Row extends object>(
      query: string,
      ...bindings: unknown[]
    ) => SQLCursorLike<Row> & IterableIterator<Row>;
  };
  #idleStatements = new Map<string, StatementSync[]>();
  #depth = 0;

  /**
   * Statements executed and rows returned since the last reset. Statement
   * counts are deterministic and are the primary metric; row counts are
   * stable to about three significant figures, so treat them as
   * approximate.
   */
  statementCount = 0;
  rowCount = 0;

  /**
   * Statements by query text, when a caller opts in. Off by default: the
   * benchmark wants to know which layer the statements came from, and
   * nothing else should pay for a Map write per statement.
   */
  histogram: Map<string, number> | null = null;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.sql = {
      exec: <Row extends object>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> & IterableIterator<Row> => {
        // Multi-statement scripts go through exec(); node:sqlite's prepare()
        // only accepts a single statement.
        rejectTransactionSQL(query);
        this.#record(query);
        if (bindings.length === 0 && /;\s*\S/.test(query)) {
          this.db.exec(query);
          this.statementCount++;
          return new Cursor<Row>(
            [][Symbol.iterator](),
            () => {
              this.rowCount++;
            },
            () => {},
          );
        }
        const stmt = this.#acquire(query);
        this.statementCount++;
        return new Cursor<Row>(
          stmt.iterate(...bindings.map(toSQLiteValue)),
          () => {
            this.rowCount++;
          },
          () => this.#release(query, stmt),
        );
      },
    };
  }

  #record(query: string): void {
    if (this.histogram === null) return;
    const fingerprint = query.replace(/\s+/g, " ").trim().slice(0, 120);
    this.histogram.set(fingerprint, (this.histogram.get(fingerprint) ?? 0) + 1);
  }

  #acquire(query: string): StatementSync {
    const idle = this.#idleStatements.get(query);
    return idle?.pop() ?? this.db.prepare(query);
  }

  #release(query: string, stmt: StatementSync): void {
    const idle = this.#idleStatements.get(query);
    if (idle === undefined) this.#idleStatements.set(query, [stmt]);
    else if (idle.length === 0) idle.push(stmt);
  }

  resetCounters(): void {
    this.statementCount = 0;
    this.rowCount = 0;
    this.histogram?.clear();
  }

  *iterate(query: string, ...bindings: unknown[]): Generator<Record<string, unknown>> {
    rejectTransactionSQL(query);
    this.#record(query);
    const stmt = this.#acquire(query);
    this.statementCount++;
    try {
      for (const value of stmt.iterate(...bindings.map(toSQLiteValue))) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("SQLite yielded a non-row value");
        }
        this.rowCount++;
        yield Object.fromEntries(Object.entries(value));
      }
    } finally {
      this.#release(query, stmt);
    }
  }

  transactionSync<T>(closure: () => T): T {
    if (this.#depth > 0) return this.#savepoint(closure);
    this.#depth++;
    this.db.exec("BEGIN");
    try {
      const result = closure();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth--;
    }
  }

  /** Nested scopes roll back alone, as workerd's `transactionSync` does with savepoints. */
  #savepoint<T>(closure: () => T): T {
    const name = `_nested_${this.#depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = closure();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#depth--;
    }
  }

  /** Bytes SQLite has allocated. Stands in for `SqlStorage.databaseSize`. */
  databaseSize(): number {
    const pageCount = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    return pageCount.page_count * pageSize.page_size;
  }
}
