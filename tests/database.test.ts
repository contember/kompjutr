import { describe, expect, it } from "vitest";
import {
  Database,
  type DurableObjectStorageLike,
  iterateSqlCursor,
  type SQLCursorLike,
  type SQLStorageLike,
} from "../packages/do/src/db/db.js";
import { initializeFsSchema } from "../packages/do/src/fs/schema.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { firstSqlRowValue, normalizeSqlRow } from "../packages/sqlite/src/index.js";
import { SqliteTestStorage } from "./helpers/storage.js";

function objectRow<Row extends object>(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function toDurableObjectRow<Row extends object>(value: unknown): Row {
  if (!objectRow<Row>(value)) throw new Error("expected a SQLite row");
  const entries = Object.entries(value).map(([key, field]) => [
    key,
    field instanceof Uint8Array ? arrayBuffer(field) : field,
  ]);
  const row = Object.fromEntries(entries);
  if (!objectRow<Row>(row)) throw new Error("expected a SQLite row");
  return row;
}

class ArrayBufferCursor<Row extends object> implements SQLCursorLike<Row>, IterableIterator<Row> {
  constructor(
    private readonly inner: Iterator<Row>,
    private readonly poisonToArray: boolean,
    private readonly onNext: () => void,
  ) {}

  next(): IteratorResult<Row> {
    this.onNext();
    const step = this.inner.next();
    return step.done === true
      ? { done: true, value: undefined }
      : { done: false, value: toDurableObjectRow<Row>(step.value) };
  }

  [Symbol.iterator](): IterableIterator<Row> {
    return this;
  }

  toArray(): Row[] {
    if (this.poisonToArray) throw new Error("toArray must not be called");
    return Array.from(this);
  }
}

class ArrayBufferStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;
  cursorNextCount = 0;

  constructor(
    private readonly inner: SqliteTestStorage = new SqliteTestStorage(),
    poisonToArray = false,
  ) {
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> =>
        new ArrayBufferCursor(
          this.inner.sql.exec<Row>(query, ...bindings)[Symbol.iterator](),
          poisonToArray,
          () => {
            this.cursorNextCount++;
          },
        ),
    };
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

class PlatformStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;
  transactionCalls = 0;
  #depth = 0;
  #savepoint = 0;

  constructor(private readonly inner: SqliteTestStorage = new SqliteTestStorage()) {
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) {
          throw new Error("transaction SQL is reserved for the storage runtime");
        }
        return this.inner.sql.exec<Row>(query, ...bindings);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.transactionCalls++;
    if (this.#depth === 0) {
      this.#depth++;
      try {
        return this.inner.transactionSync(closure);
      } finally {
        this.#depth--;
      }
    }

    const savepoint = `platform_${++this.#savepoint}`;
    this.inner.db.exec(`SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = closure();
      this.inner.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.inner.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.inner.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.#depth--;
    }
  }
}

class TooBigStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike = {
    exec<Row extends object>(): SQLCursorLike<Row> {
      throw Object.assign(new Error("SQLITE_TOOBIG: string or blob too big"), {
        code: "SQLITE_TOOBIG",
      });
    },
  };
}

class MessageOnlyTooBigStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike = {
    exec<Row extends object>(): SQLCursorLike<Row> {
      throw new Error("SQLITE_TOOBIG: string or blob too big");
    },
  };
}

class TransactionalTooBigStorage implements DurableObjectStorageLike {
  readonly #platform = new PlatformStorage();
  readonly sql: SQLStorageLike = {
    exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
      if (query.includes("coded-failure")) {
        throw Object.assign(new Error("coded value failure"), { code: 18 });
      }
      return this.#platform.sql.exec<Row>(query, ...bindings);
    },
  };

  transactionSync<T>(closure: () => T): T {
    return this.#platform.transactionSync(closure);
  }
}

function openDatabase(): Database {
  return new Database(new PlatformStorage());
}

describe("Database", () => {
  it("preserves row identity when no ArrayBuffer field needs conversion", () => {
    const row = { id: 1, value: "plain" };
    expect(normalizeSqlRow(row)).toBe(row);
    const binary = { id: 2, value: arrayBuffer(new Uint8Array([1, 2])) };
    const normalized = normalizeSqlRow(binary);
    expect(normalized).not.toBe(binary);
    expect(normalized).toEqual({ id: 2, value: new Uint8Array([1, 2]) });
    expect(firstSqlRowValue({ first: 1, second: 2 })).toBe(1);
    expect(firstSqlRowValue({})).toBeUndefined();
  });

  it("normalizes engine-reported SQLite value limits without a projected ceiling", () => {
    const db = new Database(new TooBigStorage());
    for (const operation of [
      () => db.run("INSERT INTO values (?)", "value"),
      () => db.all("SELECT ?", "value"),
      () => [...db.iterate("SELECT ?", "value")],
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining({
          name: "GitError",
          code: "E2BIG",
          message: "SQLite rejected a value as too large",
        }),
      );
    }
  });

  it("does not infer SQLITE_TOOBIG from message text", () => {
    const db = new Database(new MessageOnlyTooBigStorage());
    let thrown: unknown;
    try {
      db.run("SELECT 1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new Error("SQLITE_TOOBIG: string or blob too big"));
    expect(typeof thrown === "object" && thrown !== null ? Reflect.get(thrown, "code") : null).toBe(
      undefined,
    );
  });

  it("normalizes a coded value failure and rolls back its transaction", () => {
    const db = new Database(new TransactionalTooBigStorage());
    db.run("CREATE TABLE items (value TEXT PRIMARY KEY)");

    expect(() =>
      db.transactionSync(() => {
        db.run("INSERT INTO items VALUES ('before')");
        db.run("INSERT INTO items VALUES ('coded-failure')");
      }),
    ).toThrowError(expect.objectContaining({ name: "GitError", code: "E2BIG" }));
    expect(db.all("SELECT value FROM items")).toEqual([]);
  });

  it("commits nested savepoints", () => {
    const storage = new PlatformStorage();
    const db = new Database(storage);
    db.run("CREATE TABLE items (value TEXT PRIMARY KEY)");
    expect(() => storage.sql.exec("SAVEPOINT forbidden")).toThrow(
      "transaction SQL is reserved for the storage runtime",
    );

    const result = db.transactionSync(() => {
      db.run("INSERT INTO items VALUES ('outer')");
      const nested = db.transactionSync(() => {
        db.run("INSERT INTO items VALUES ('inner')");
        return 42;
      });
      return nested + 1;
    });

    expect(result).toBe(43);
    expect(storage.transactionCalls).toBe(2);
    expect(db.all("SELECT value FROM items ORDER BY value")).toEqual([
      { value: "inner" },
      { value: "outer" },
    ]);
  });

  it("rolls back a failed savepoint without rolling back its caller", () => {
    const db = openDatabase();
    db.run("CREATE TABLE items (value TEXT PRIMARY KEY)");

    db.transactionSync(() => {
      db.run("INSERT INTO items VALUES ('before')");
      expect(() =>
        db.transactionSync(() => {
          db.run("INSERT INTO items VALUES ('rolled-back')");
          throw new Error("inner failure");
        }),
      ).toThrow("inner failure");
      db.run("INSERT INTO items VALUES ('after')");
    });

    expect(db.all("SELECT value FROM items ORDER BY value")).toEqual([
      { value: "after" },
      { value: "before" },
    ]);
  });

  it("rolls back released savepoints when the outer transaction fails", () => {
    const db = openDatabase();
    db.run("CREATE TABLE items (value TEXT PRIMARY KEY)");

    expect(() =>
      db.transactionSync(() => {
        db.run("INSERT INTO items VALUES ('outer')");
        db.transactionSync(() => db.run("INSERT INTO items VALUES ('nested')"));
        throw new Error("outer failure");
      }),
    ).toThrow("outer failure");

    expect(db.all("SELECT value FROM items")).toEqual([]);
  });

  it("rejects asynchronous outer and nested transaction results", () => {
    const db = openDatabase();
    db.run("CREATE TABLE items (value TEXT PRIMARY KEY)");

    expect(() =>
      db.transactionSync(async () => {
        db.run("INSERT INTO items VALUES ('outer-async')");
      }),
    ).toThrow("transactionSync closure returned an asynchronous result");

    db.transactionSync(() => {
      expect(() =>
        db.transactionSync(async () => {
          db.run("INSERT INTO items VALUES ('nested-async')");
        }),
      ).toThrow("transactionSync closure returned an asynchronous result");
      db.run("INSERT INTO items VALUES ('sync')");
    });

    expect(db.all("SELECT value FROM items")).toEqual([{ value: "sync" }]);
  });

  it("normalizes ArrayBuffer BLOBs across every read method", () => {
    const db = new Database(new ArrayBufferStorage());
    const source = new Uint8Array([9, 1, 2, 8]);
    db.run("CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
    db.run("INSERT INTO blobs VALUES (1, ?)", source.subarray(1, 3));

    const all = db.all<{ id: number; payload: Uint8Array }>("SELECT id, payload FROM blobs");
    const one = db.one<{ payload: Uint8Array }>("SELECT payload FROM blobs");
    const scalar = db.scalar<Uint8Array>("SELECT payload FROM blobs");
    const iterated = [...db.iterate("SELECT payload FROM blobs")];

    expect(all).toEqual([{ id: 1, payload: new Uint8Array([1, 2]) }]);
    expect(one).toEqual({ payload: new Uint8Array([1, 2]) });
    expect(scalar).toEqual(new Uint8Array([1, 2]));
    expect(iterated).toEqual([{ payload: new Uint8Array([1, 2]) }]);
  });

  it("iterates a native cursor lazily without calling toArray", () => {
    const storage = new ArrayBufferStorage(new SqliteTestStorage(), true);
    const db = new Database(storage);
    db.run("CREATE TABLE numbers (value INTEGER PRIMARY KEY)");
    db.run("INSERT INTO numbers VALUES (1)");
    db.run("INSERT INTO numbers VALUES (2)");

    const rows = db.iterate("SELECT value FROM numbers ORDER BY value");
    expect(storage.cursorNextCount).toBe(0);
    expect([...rows]).toEqual([{ value: 1 }, { value: 2 }]);
    expect(storage.cursorNextCount).toBe(3);
  });

  it("closes a platform cursor when iteration stops early", () => {
    let closed = 0;
    const cursor = {
      [Symbol.iterator]() {
        let emitted = false;
        return {
          next(): IteratorResult<{ value: number }> {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: { value: 1 } };
          },
          return(): IteratorResult<{ value: number }> {
            closed++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const rows = iterateSqlCursor(cursor);
    expect(rows.next().value).toEqual({ value: 1 });
    rows.return(undefined);
    expect(closed).toBe(1);
  });

  it("initializes the filesystem and git schemas over Durable Object storage", () => {
    const db = openDatabase();
    initializeFsSchema(db, () => 1234);
    new SqliteGitDatabase(db);

    expect(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('fs_paths', 'git_objects') ORDER BY name",
      ),
    ).toEqual([{ name: "fs_paths" }, { name: "git_objects" }]);
  });
});
