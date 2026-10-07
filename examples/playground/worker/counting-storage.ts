import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "@kompjutr/do";

export class CountingStorage implements DurableObjectStorageLike {
  statements = 0;
  rowsReturned = 0;
  readonly sql: SQLStorageLike;

  constructor(private readonly inner: DurableObjectStorageLike) {
    this.sql = {
      exec: (query, ...bindings) => {
        this.statements++;
        return new CountingCursor(inner.sql.exec(query, ...bindings), () => this.rowsReturned++);
      },
    };
  }

  reset(): void {
    this.statements = 0;
    this.rowsReturned = 0;
  }

  transactionSync<T>(closure: () => T): T {
    if (this.inner.transactionSync === undefined) throw new Error("Missing SQLite transactions");
    return this.inner.transactionSync(closure);
  }
}

class CountingCursor implements SQLCursorLike {
  constructor(
    private readonly inner: SQLCursorLike,
    private readonly count: () => void,
  ) {}

  *[Symbol.iterator](): Iterator<Record<string, unknown>> {
    for (const row of this.inner) {
      this.count();
      yield row;
    }
  }

  toArray(): Record<string, unknown>[] {
    const rows = this.inner.toArray();
    for (const _row of rows) this.count();
    return rows;
  }
}
