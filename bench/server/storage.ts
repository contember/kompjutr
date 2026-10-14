import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "@kompjutr/do";

export interface SqlCounts {
  statements: number;
  returnedRows: number;
}

export class CountedStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;
  constructor(
    private readonly inner: DurableObjectStorageLike,
    private readonly totals: SqlCounts = { statements: 0, returnedRows: 0 },
  ) {
    this.sql = {
      exec: (query, ...bindings) => {
        this.totals.statements++;
        return new CountedCursor(
          inner.sql.exec(query, ...bindings),
          () => this.totals.returnedRows++,
        );
      },
    };
  }
  transactionSync<T>(closure: () => T): T {
    if (this.inner.transactionSync === undefined) throw new Error("transactionSync required");
    return this.inner.transactionSync(closure);
  }
  reset(): void {
    this.totals.statements = 0;
    this.totals.returnedRows = 0;
  }
  counts() {
    return { ...this.totals };
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
