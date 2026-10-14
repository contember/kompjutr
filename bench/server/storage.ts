import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "@kompjutr/do";

export class CountedStorage implements DurableObjectStorageLike {
  statements = 0;
  rows = 0;
  readonly sql: SQLStorageLike;
  constructor(private readonly inner: DurableObjectStorageLike) {
    this.sql = {
      exec: (query, ...bindings) => {
        this.statements++;
        return new CountedCursor(inner.sql.exec(query, ...bindings), () => this.rows++);
      },
    };
  }
  transactionSync<T>(closure: () => T): T {
    if (this.inner.transactionSync === undefined) throw new Error("transactionSync required");
    return this.inner.transactionSync(closure);
  }
  reset(): void {
    this.statements = 0;
    this.rows = 0;
  }
  counts() {
    return { statements: this.statements, returnedRows: this.rows };
  }
}

class CountedCursor<Row extends object> implements SQLCursorLike<Row> {
  constructor(
    private readonly inner: SQLCursorLike<Row>,
    private readonly count: () => void,
  ) {}
  *[Symbol.iterator](): Iterator<Row> {
    for (const row of this.inner) {
      this.count();
      yield row;
    }
  }
  toArray(): Row[] {
    return Array.from(this);
  }
}
