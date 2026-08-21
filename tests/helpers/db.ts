import type { SqlDatabase } from "../../src/sqlite/db.js";
import { SqliteTestStorage } from "./storage.js";

/**
 * Structural stand-in for @cloudflare/dofs's `Database`, so store tests
 * can run without constructing a Workspace.
 */
export class TestDatabase implements SqlDatabase {
  #depth = 0;

  constructor(readonly storage: SqliteTestStorage = new SqliteTestStorage()) {}

  run(query: string, ...bindings: unknown[]): void {
    this.storage.sql.exec(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    if (row === undefined) return undefined;
    return Object.values(row)[0];
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    return this.storage.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    if (this.#depth > 0) return closure();
    this.#depth++;
    try {
      return this.storage.transactionSync(closure);
    } finally {
      this.#depth--;
    }
  }
}
