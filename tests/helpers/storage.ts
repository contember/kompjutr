// node:sqlite-backed DurableObjectStorageLike, so the whole stack can run
// under plain vitest. Workers' DO SQL surface is a subset of this.

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { DurableObjectStorageLike, SQLCursorLike } from "./types.js";

class Cursor<Row extends object> implements SQLCursorLike<Row> {
  constructor(private readonly rows: Row[]) {}
  toArray(): Row[] {
    return this.rows;
  }
}

function toSQLiteValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export class SqliteTestStorage implements DurableObjectStorageLike {
  readonly db: DatabaseSync;
  readonly sql: {
    exec: <Row extends object>(query: string, ...bindings: unknown[]) => SQLCursorLike<Row>;
  };
  #statements = new Map<string, StatementSync>();
  #depth = 0;

  /**
   * Statements executed and rows returned since the last reset. Statement
   * counts are deterministic and are the primary metric; row counts are
   * stable to about three significant figures, so treat them as
   * approximate.
   */
  statementCount = 0;
  rowCount = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        // Multi-statement scripts go through exec(); node:sqlite's prepare()
        // only accepts a single statement.
        if (bindings.length === 0 && /;\s*\S/.test(query)) {
          this.db.exec(query);
          this.statementCount++;
          return new Cursor<Row>([]);
        }
        let stmt = this.#statements.get(query);
        if (stmt === undefined) {
          stmt = this.db.prepare(query);
          this.#statements.set(query, stmt);
        }
        const rows = (stmt.all(...(bindings.map(toSQLiteValue) as never[])) as Row[]) ?? [];
        this.statementCount++;
        this.rowCount += rows.length;
        return new Cursor<Row>(rows);
      },
    };
  }

  resetCounters(): void {
    this.statementCount = 0;
    this.rowCount = 0;
  }

  transactionSync<T>(closure: () => T): T {
    if (this.#depth > 0) return closure();
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

  /** Bytes SQLite has allocated. Stands in for `SqlStorage.databaseSize`. */
  databaseSize(): number {
    const pageCount = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    return pageCount.page_count * pageSize.page_size;
  }
}
