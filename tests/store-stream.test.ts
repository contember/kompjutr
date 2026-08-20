// The streaming store API: paged index scans, bounded mutation, and
// object writes and reads that never hold the whole object.

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { concat, toHex } from "../src/core/bytes.js";
import { hashObject } from "../src/core/objects.js";
import { Sha1 } from "../src/core/sha1.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { type IndexEntry, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

/** Records the widest result any single query returned — the memory probe. */
class WidestDatabase implements SqlDatabase {
  widestRows = 0;
  widestBlob = 0;

  constructor(private readonly inner: SqlDatabase = new TestDatabase()) {}

  run(query: string, ...bindings: unknown[]): void {
    for (const binding of bindings) {
      if (binding instanceof Uint8Array && binding.length > this.widestBlob) {
        this.widestBlob = binding.length;
      }
    }
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    const rows = this.inner.all<Row>(query, ...bindings);
    if (rows.length > this.widestRows) this.widestRows = rows.length;
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function open(db: SqlDatabase = new TestDatabase()) {
  const database = new SqliteGitDatabase(db);
  return database.open(database.create("/repo", "ref: refs/heads/main"));
}

function entry(path: string, stage = 0, oid = "0".repeat(40)): IndexEntry {
  return { path, stage, mode: 0o100644, oid, size: null, mtime: null, ino: null };
}

describe("indexScan", () => {
  it("yields exactly what indexEntries does", () => {
    const store = open();
    const paths = ["a.txt", "a/b.txt", "ab.txt", "z/y/x.txt", "\u{1F600}.txt", ".txt"];
    for (const path of paths) store.indexPut(entry(path));
    expect([...store.indexScan()]).toEqual(store.indexEntries());
  });

  it("does not drop a conflict stage across a page boundary", () => {
    const store = open();
    // Every page boundary lands mid-path with pageSize 1, which is exactly
    // the case a cursor keyed on the path alone loses.
    for (const stage of [1, 2, 3]) store.indexPut(entry("conflict.txt", stage));
    store.indexPut(entry("after.txt"));
    const scanned = [...store.indexScan({ pageSize: 1 })];
    expect(scanned.map((row) => `${row.path}:${row.stage}`)).toEqual([
      "after.txt:0",
      "conflict.txt:1",
      "conflict.txt:2",
      "conflict.txt:3",
    ]);
  });

  it("never materialises more than one page, whatever the index holds", () => {
    const db = new WidestDatabase();
    const store = open(db);
    store.db.transactionSync(() => {
      for (let i = 0; i < 5000; i++) store.indexPut(entry(`dir${i % 50}/file${i}.txt`));
    });
    db.widestRows = 0;
    let seen = 0;
    for (const _ of store.indexScan({ pageSize: 64 })) seen++;
    expect(seen).toBe(5000);
    expect(db.widestRows).toBeLessThanOrEqual(64);

    db.widestRows = 0;
    expect(store.indexEntries()).toHaveLength(5000);
    expect(db.widestRows).toBe(5000); // the unbounded path, for contrast
  });

  it("restricts to a prefix, including the prefix path itself", () => {
    const store = open();
    for (const path of ["src", "src/a.txt", "src/deep/b.txt", "srcs/c.txt", "other.txt"]) {
      store.indexPut(entry(path));
    }
    expect([...store.indexScan({ prefix: "src" })].map((row) => row.path)).toEqual([
      "src",
      "src/a.txt",
      "src/deep/b.txt",
    ]);
  });

  it("resumes after a given (path, stage)", () => {
    const store = open();
    for (const stage of [0, 2]) store.indexPut(entry("a.txt", stage));
    store.indexPut(entry("b.txt"));
    const rest = [...store.indexScan({ after: { path: "a.txt", stage: 0 } })];
    expect(rest.map((row) => `${row.path}:${row.stage}`)).toEqual(["a.txt:2", "b.txt:0"]);
  });
});

describe("indexApply", () => {
  it("keeps a remove and a re-put of one path in the order they were made", () => {
    const store = open();
    store.indexPut(entry("a.txt", 1));
    store.indexApply((sink) => {
      sink.remove("a.txt");
      sink.put(entry("a.txt", 0, "1".repeat(40)));
    });
    expect(store.indexEntries()).toEqual([entry("a.txt", 0, "1".repeat(40))]);
  });

  it("applies in batches rather than holding every mutation", () => {
    const store = open();
    let visible = 0;
    store.indexApply(
      (sink) => {
        for (let i = 0; i < 100; i++) {
          sink.put(entry(`f${String(i).padStart(3, "0")}.txt`));
          // A flush has landed by now, so the table is already growing.
          if (i === 49) visible = store.indexEntries().length;
        }
      },
      { flushEvery: 10 },
    );
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(100);
    expect(store.indexEntries()).toHaveLength(100);
  });
});

describe("indexReplace", () => {
  it("accepts a generator and clears what was there", () => {
    const store = open();
    store.indexPut(entry("old.txt"));
    function* rows(): Generator<IndexEntry> {
      for (let i = 0; i < 25; i++) yield entry(`new${i}.txt`);
    }
    store.indexReplace(rows(), { flushEvery: 4 });
    const paths = store.indexEntries().map((row) => row.path);
    expect(paths).toHaveLength(25);
    expect(paths).not.toContain("old.txt");
  });

  it("clears the index when the stream is empty", () => {
    const store = open();
    store.indexPut(entry("old.txt"));
    store.indexReplace([]);
    expect(store.indexEntries()).toEqual([]);
  });
});

describe("writeStream", () => {
  const slice = (data: Uint8Array, size: number) =>
    function* (): Generator<Uint8Array> {
      for (let offset = 0; offset < data.length; offset += size) {
        yield data.subarray(offset, offset + size);
      }
    };

  it("agrees with write on the oid and on the bytes", () => {
    const store = open();
    const data = randomBytes(700_000);
    const streamed = store.writeStream("blob", data.length, slice(data, 8192));
    expect(streamed).toBe(hashObject("blob", data));
    expect(store.read(streamed)?.type).toBe("blob");
    expect(hashObject("blob", store.read(streamed)?.data ?? new Uint8Array())).toBe(streamed);
  });

  it("writes no row larger than one deflate chunk", () => {
    const db = new WidestDatabase();
    const store = open(db);
    const data = randomBytes(4_000_000);
    db.widestBlob = 0;
    store.writeStream("blob", data.length, slice(data, 64 * 1024));
    expect(db.widestBlob).toBeLessThanOrEqual(64 * 1024);

    // The buffered path, for contrast: one row holds a megabyte.
    db.widestBlob = 0;
    store.write("blob", randomBytes(4_000_000));
    expect(db.widestBlob).toBeGreaterThan(64 * 1024);
  });

  it("writes nothing when the object is already stored", () => {
    const db = new WidestDatabase();
    const store = open(db);
    const data = randomBytes(50_000);
    const oid = store.write("blob", data);
    const rows = () =>
      store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE repo_id = ?", 1);
    const before = rows();
    db.widestBlob = 0;
    expect(store.writeStream("blob", data.length, slice(data, 4096))).toBe(oid);
    // Dedup happens after the hashing pass and before a single row is touched.
    expect(db.widestBlob).toBe(0);
    expect(rows()).toBe(before);
  });

  it("refuses a stream whose length disagrees with the declared size", () => {
    const store = open();
    const data = randomBytes(100);
    expect(() => store.writeStream("blob", 99, slice(data, 100))).toThrow(/streamed 100 bytes/);
  });

  it("stores an empty object", () => {
    const store = open();
    const oid = store.writeStream("blob", 0, function* () {});
    expect(oid).toBe(hashObject("blob", new Uint8Array(0)));
    expect(store.read(oid)?.data).toEqual(new Uint8Array(0));
  });

  it("hashes the same way for any chunking", () => {
    const store = open();
    const data = randomBytes(300_000);
    const expected = hashObject("blob", data);
    for (const size of [1, 7, 1024, 65_536, data.length]) {
      expect(store.writeStream("blob", data.length, slice(data, size))).toBe(expected);
    }
    // And the incremental hash matches a one-shot over the same header.
    const one = new Sha1();
    one.update(new TextEncoder().encode(`blob ${data.length}\0`)).update(data);
    expect(toHex(one.digest())).toBe(expected);
  });
});

describe("readChunks", () => {
  it("reassembles to exactly what read returns, for a loose object", () => {
    const store = open();
    const data = randomBytes(900_000);
    const oid = store.write("blob", data);
    const chunks = store.readChunks(oid);
    expect(chunks).not.toBeNull();
    expect(hashObject("blob", concat([...(chunks ?? [])]))).toBe(hashObject("blob", data));
  });

  it("delivers a loose object in more than one piece", () => {
    const store = open();
    // Incompressible, so the deflated form is larger than one feed window.
    const data = randomBytes(900_000);
    const oid = store.writeStream("blob", data.length, function* () {
      yield data;
    });
    const pieces = [...(store.readChunks(oid) ?? [])];
    expect(pieces.length).toBeGreaterThan(1);
    expect(hashObject("blob", concat(pieces))).toBe(hashObject("blob", data));
  });

  it("returns null for an unknown object", () => {
    const store = open();
    expect(store.readChunks("0".repeat(40))).toBeNull();
  });
});
