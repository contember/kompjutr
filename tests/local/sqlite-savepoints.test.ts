import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeSqliteDatabase } from "@kompjutr/local";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalFixture, localFixture } from "./helpers.js";

const fixtures: LocalFixture[] = [];

function database(): NodeSqliteDatabase {
  const fixture = localFixture();
  fixtures.push(fixture);
  return new NodeSqliteDatabase(join(fixture.base, "scopes.sqlite"));
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

describe("local SQL savepoints", () => {
  it.each([
    [
      "CREATE TABLE leaked (value TEXT)",
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'leaked'",
    ],
    [
      "CREATE TEMP TABLE leaked (value TEXT)",
      "SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name = 'leaked'",
    ],
    ["PRAGMA user_version = 42", "PRAGMA user_version"],
  ])("rolls back %s like SQLite", (write, read) => {
    using db = database();
    const oracle = new DatabaseSync(":memory:");
    try {
      oracle.exec("BEGIN; SAVEPOINT nested");
      oracle.exec(write);
      oracle.exec("ROLLBACK TO nested; RELEASE nested; COMMIT");
      db.transactionSync(() => {
        expect(() =>
          db.transactionSync(() => {
            db.run(write);
            throw new Error("nested failure");
          }),
        ).toThrow("nested failure");
        expect(db.one(read)).toEqual(oracle.prepare(read).get());
      });
      expect(db.one(read)).toEqual(oracle.prepare(read).get());
    } finally {
      oracle.close();
    }
  });

  it.each([false, true])("invalidates a suspended writer, created outside: %s", (outside) => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    let cursor: Iterator<Record<string, unknown>> | undefined;
    db.transactionSync(() => {
      db.run("INSERT INTO sample VALUES ('outer')");
      if (outside)
        cursor = db
          .iterate("INSERT INTO sample VALUES ('leaked') RETURNING value")
          [Symbol.iterator]();
      expect(() =>
        db.transactionSync(() => {
          cursor ??= db
            .iterate("INSERT INTO sample VALUES ('leaked') RETURNING value")
            [Symbol.iterator]();
          expect(cursor.next().value).toEqual({ value: "leaked" });
          throw new Error("nested failure");
        }),
      ).toThrow("nested failure");
      expect(() => cursor?.next()).toThrowError(expect.objectContaining({ code: "ESTALE" }));
      cursor?.return?.();
      expect(db.all("SELECT value FROM sample")).toEqual([{ value: "outer" }]);
    });
    expect(db.all("SELECT value FROM sample")).toEqual([{ value: "outer" }]);
  });

  it("invalidates an unstarted cursor from a failed scope", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    let rows: Iterable<Record<string, unknown>> | undefined;
    db.transactionSync(() => {
      expect(() =>
        db.transactionSync(() => {
          rows = db.iterate("INSERT INTO sample VALUES ('late') RETURNING value");
          throw new Error("nested failure");
        }),
      ).toThrow("nested failure");
    });
    expect(() => rows?.[Symbol.iterator]().next()).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );
    expect(db.scalar("SELECT COUNT(*) FROM sample")).toBe(0);
  });

  it("rolls back released child scopes with their failed parent", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    let cursor: Iterator<Record<string, unknown>> | undefined;
    db.transactionSync(() => {
      db.run("INSERT INTO sample VALUES ('outer')");
      expect(() =>
        db.transactionSync(() => {
          cursor = db.transactionSync(() => {
            db.run("INSERT INTO sample VALUES ('child')");
            return db.iterate("SELECT value FROM sample")[Symbol.iterator]();
          });
          expect(cursor.next().done).toBe(false);
          throw new Error("parent failure");
        }),
      ).toThrow("parent failure");
      expect(() => cursor?.next()).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    });
    expect(db.all("SELECT value FROM sample")).toEqual([{ value: "outer" }]);
  });

  it("preserves successful scopes around a caught deeper failure", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    db.transactionSync(() =>
      db.transactionSync(() => {
        db.run("INSERT INTO sample VALUES ('middle')");
        expect(() =>
          db.transactionSync(() => {
            db.run("INSERT INTO sample VALUES ('deep')");
            throw new Error("deep failure");
          }),
        ).toThrow("deep failure");
        db.run("INSERT INTO sample VALUES ('after')");
      }),
    );
    expect(db.all("SELECT value FROM sample")).toEqual([{ value: "middle" }, { value: "after" }]);
  });

  it("keeps successful read cursors usable after savepoint release and commit", () => {
    using db = database();
    const cursor = db.transactionSync(() =>
      db.transactionSync(() => {
        const rows = db.iterate("SELECT 1 AS n UNION ALL SELECT 2 AS n")[Symbol.iterator]();
        expect(rows.next().value).toEqual({ n: 1 });
        return rows;
      }),
    );
    expect(cursor.next().value).toEqual({ n: 2 });
    expect(cursor.next().done).toBe(true);
  });

  it("invalidates pending writers when the outer transaction rolls back", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    const cursor = db
      .iterate("INSERT INTO sample VALUES ('outer') RETURNING value")
      [Symbol.iterator]();
    expect(() =>
      db.transactionSync(() => {
        expect(cursor.next().done).toBe(false);
        throw new Error("outer failure");
      }),
    ).toThrow("outer failure");
    expect(() => cursor.next()).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(db.scalar("SELECT COUNT(*) FROM sample")).toBe(0);
  });

  it("does not interpret a signed SQLite schema cookie as a recovery counter", () => {
    using db = database();
    db.run("PRAGMA schema_version = -1");
    expect(db.scalar("PRAGMA schema_version")).toBe(-1);
    expect(db.transactionSync(() => db.transactionSync(() => db.scalar("SELECT 123")))).toBe(123);
  });

  it("rolls back a savepoint whose pending writer prevents release", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    let cursor: Iterator<Record<string, unknown>> | undefined;
    db.transactionSync(() => {
      db.run("INSERT INTO sample VALUES ('outer')");
      expect(() =>
        db.transactionSync(() => {
          cursor = db
            .iterate("INSERT INTO sample VALUES ('nested') RETURNING value")
            [Symbol.iterator]();
          expect(cursor.next().done).toBe(false);
        }),
      ).toThrow(/SQL statements in progress/);
      expect(() => cursor?.next()).toThrowError(expect.objectContaining({ code: "ESTALE" }));
      db.run("INSERT INTO sample VALUES ('after')");
    });
    expect(db.all("SELECT value FROM sample")).toEqual([{ value: "outer" }, { value: "after" }]);
  });

  it("rolls back earlier scope writes after a cursor constraint error", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT UNIQUE)");
    db.transactionSync(() => {
      db.run("INSERT INTO sample VALUES ('outer')");
      expect(() =>
        db.transactionSync(() => {
          db.run("INSERT INTO sample VALUES ('nested')");
          const cursor = db
            .iterate("INSERT INTO sample VALUES ('outer') RETURNING value")
            [Symbol.iterator]();
          cursor.next();
        }),
      ).toThrow(/UNIQUE constraint failed/);
      expect(db.all("SELECT value FROM sample")).toEqual([{ value: "outer" }]);
    });
  });

  it("recovers an outer commit blocked by a pending writer", () => {
    using db = database();
    db.run("CREATE TABLE sample (value TEXT)");
    let cursor: Iterator<Record<string, unknown>> | undefined;
    expect(() =>
      db.transactionSync(() => {
        cursor = db
          .iterate("INSERT INTO sample VALUES ('uncommitted') RETURNING value")
          [Symbol.iterator]();
        expect(cursor.next().done).toBe(false);
      }),
    ).toThrow(/SQL statements in progress/);
    expect(() => cursor?.next()).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(db.scalar("SELECT COUNT(*) FROM sample")).toBe(0);
    db.transactionSync(() => db.run("INSERT INTO sample VALUES ('after')"));
    expect(db.all("SELECT value FROM sample")).toEqual([{ value: "after" }]);
  });
});
