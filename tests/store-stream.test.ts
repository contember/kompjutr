// The streaming store API: paged index scans, bounded mutation, and
// object writes and reads that never hold the whole object.

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../src/db/db.js";
import { concat, toHex, utf8 } from "../src/git/common/bytes.js";
import { hashObject, MODE_FILE, serializeTree } from "../src/git/common/objects.js";
import { Sha1 } from "../src/git/common/sha1.js";
import { MAX_BLOB_ID_CACHE_ROWS } from "../src/git/store/blob-id-cache.js";
import {
  type IndexEntry,
  type IndexSink,
  type IndexStore,
  type InitialStateSession,
  SqliteGitDatabase,
} from "../src/git/store/index.js";
import { readMaintenanceRootEpoch } from "../src/git/store/maintenance/control.js";
import {
  MAX_SCRATCH_INDEX_NAME_BYTES,
  MAX_SCRATCH_INDEXES_PER_REPOSITORY,
} from "../src/git/store/schema.js";
import { sharedRepoStoreMutations } from "../src/git/store/shared.js";
import { TestDatabase } from "./helpers/db.js";

/** Records the widest result returned by any single query. */
class WidestDatabase implements SqlDatabase {
  widestRows = 0;
  widestBlob = 0;
  widestResultBlob = 0;
  widestStringBytes = 0;
  /** Most bound parameters any one statement carried. The platform cap is 100. */
  widestBindings = 0;
  deleteStatements = 0;
  initialStateWrites = 0;
  failInitialStateWrite = 0;

  constructor(private readonly inner: SqlDatabase = new TestDatabase()) {}

  #measure(bindings: unknown[]): void {
    if (bindings.length > this.widestBindings) this.widestBindings = bindings.length;
    for (const binding of bindings) {
      if (typeof binding === "string") {
        const bytes = new TextEncoder().encode(binding).byteLength;
        if (bytes > this.widestStringBytes) this.widestStringBytes = bytes;
      }
      if (binding instanceof Uint8Array && binding.length > this.widestBlob) {
        this.widestBlob = binding.length;
      }
    }
  }

  run(query: string, ...bindings: unknown[]): void {
    this.#measure(bindings);
    if (/^\s*DELETE\s+FROM\s+git_index\b/.test(query)) this.deleteStatements++;
    if (/^\s*(?:WITH[\s\S]*?)?INSERT INTO git_(?:index|blob_ids|blob_id_updates)\b/.test(query)) {
      this.initialStateWrites++;
      if (this.initialStateWrites === this.failInitialStateWrite) {
        throw new Error("injected initial state write");
      }
    }
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#measure(bindings);
    const rows = this.inner.all<Row>(query, ...bindings);
    if (rows.length > this.widestRows) this.widestRows = rows.length;
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#measure(bindings);
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#measure(bindings);
    return this.inner.scalar<T>(query, ...bindings);
  }

  *iterate(query: string, ...bindings: unknown[]): Generator<Record<string, unknown>> {
    this.#measure(bindings);
    for (const row of this.inner.iterate(query, ...bindings)) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array && value.byteLength > this.widestResultBlob) {
          this.widestResultBlob = value.byteLength;
        }
      }
      yield row;
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function open(db: SqlDatabase = new TestDatabase()) {
  const database = new SqliteGitDatabase(db);
  return database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
}

function entry(path: string, stage = 0, oid = "0".repeat(40)): IndexEntry {
  return { path, stage, mode: 0o100644, oid, size: null, mtime: null, ino: null, rev: null };
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
    for (const _ of store.indexScan()) seen++;
    expect(seen).toBe(5000);
    expect(db.widestRows).toBeLessThanOrEqual(1000);

    db.widestRows = 0;
    seen = 0;
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

  it("rejects page sizes that can truncate or unbound either index store", () => {
    const store = open();
    store.indexPut(entry("tracked.txt"));
    for (const pageSize of [0, -1, 2_049, 1.5, Number.NaN]) {
      expect(() => [...store.indexScan({ pageSize })], String(pageSize)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
    expect([...store.indexScan({ pageSize: 2_048 })]).toEqual([entry("tracked.txt")]);

    store.shared.withScratchIndex("page-size", (scratch) => {
      scratch.indexReplace([entry("scratch.txt")]);
      for (const pageSize of [0, -1, 2_049, 1.5, Number.NaN]) {
        expect(() => [...scratch.indexScan({ pageSize })], String(pageSize)).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
      }
      expect([...scratch.indexScan({ pageSize: 2_048 })]).toEqual([entry("scratch.txt")]);
    });
  });
});

describe("indexApply", () => {
  it("keeps a remove and a re-put of one path in the order they were made", () => {
    const store = open();
    store.indexPut(entry("a.txt", 1));
    store.indexApply(
      (sink) => {
        sink.remove("a.txt");
        sink.put(entry("a.txt", 0, "1".repeat(40)));
      },
      { flushEvery: 1 },
    );
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

  it("batches ordered remove and put pairs within the statement target", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    for (let index = 0; index < 500; index++) {
      store.indexPut(entry(`f${String(index).padStart(3, "0")}.txt`, 1));
    }
    inner.storage.resetCounters();
    db.widestBindings = 0;

    store.indexApply((sink) => {
      for (let index = 0; index < 500; index++) {
        const path = `f${String(index).padStart(3, "0")}.txt`;
        sink.remove(path);
        sink.put(entry(path, 0, String(index).padStart(40, "0")));
      }
    });

    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(db.widestBindings).toBeLessThanOrEqual(2);
    expect(store.indexEntries()).toEqual(
      Array.from({ length: 500 }, (_, index) => {
        const path = `f${String(index).padStart(3, "0")}.txt`;
        return entry(path, 0, String(index).padStart(40, "0"));
      }),
    );
  });

  it("keeps the last ordered mutation for every path and stage", () => {
    const store = open();
    store.indexPut(entry("a.txt", 1, "1".repeat(40)));
    store.indexPut(entry("a.txt", 2, "2".repeat(40)));
    store.indexApply((sink) => {
      sink.put(entry("a.txt", 3, "3".repeat(40)));
      sink.remove("a.txt");
      sink.put(entry("a.txt", 0, "4".repeat(40)));
      sink.put(entry("a.txt", 0, "5".repeat(40)));
      sink.put(entry("b.txt", 0, "6".repeat(40)));
      sink.remove("b.txt");
    });

    expect(store.indexEntries()).toEqual([entry("a.txt", 0, "5".repeat(40))]);
  });

  it("scales put-only flushes by pages rather than rows", () => {
    const measure = (count: number): number => {
      const inner = new TestDatabase();
      const store = open(inner);
      inner.storage.resetCounters();
      store.indexApply((sink) => {
        for (let index = 0; index < count; index++) {
          sink.put(entry(`f${String(index).padStart(4, "0")}.txt`));
        }
      });
      const statements = inner.storage.statementCount;
      expect(store.indexEntries()).toHaveLength(count);
      return statements;
    };

    expect(measure(100)).toBe(4);
    expect(measure(1_000)).toBe(6);
    expect(measure(9_329)).toBe(40);
  });

  it("bounds UTF-8 JSON bindings even when flushEvery is larger", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    const paths = Array.from({ length: 1_024 }, (_, index) => {
      const prefix = `${String(index).padStart(4, "0")}-`;
      const remaining = 2_200 - prefix.length;
      return `${prefix}${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 === 0 ? "" : "a"}`;
    });
    inner.storage.resetCounters();
    db.widestStringBytes = 0;

    store.indexApply(
      (sink) => {
        for (const path of paths) sink.put(entry(path));
      },
      { flushEvery: 10_000 },
    );
    const statements = inner.storage.statementCount;
    const stored = store.indexEntries();

    expect(statements).toBeGreaterThan(2);
    expect(statements).toBeLessThan(1_000);
    expect(db.widestStringBytes).toBeLessThanOrEqual(1_500_000);
    expect(stored.map((row) => row.path)).toEqual(paths);
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

  it("clears once and inserts replacement pages in bounded statements", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    store.indexPut(entry("old.txt"));
    inner.storage.resetCounters();
    db.widestBindings = 0;

    store.indexReplace(
      Array.from({ length: 1_000 }, (_, index) =>
        entry(`new${String(index).padStart(4, "0")}.txt`, index % 4),
      ),
    );

    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(db.widestBindings).toBeLessThanOrEqual(2);
    expect(store.indexEntries()).toHaveLength(1_000);
    expect(store.indexGet("old.txt")).toBeNull();
  });

  it("keeps a full-repository replacement within the statement target", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    inner.storage.resetCounters();

    store.indexReplace(
      Array.from({ length: 9_329 }, (_, index) => entry(`f${String(index).padStart(4, "0")}.txt`)),
    );

    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(store.indexEntries()).toHaveLength(9_329);
  });
});

describe("scratch indexes", () => {
  it("isolates rows from the checkout index and revokes the escaped handle", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    store.indexPut(entry("checkout.txt", 0, "1".repeat(40)));
    const rootEpoch = readMaintenanceRootEpoch(inner, store.repoId);
    let escaped: IndexStore | undefined;
    let escapedSink: IndexSink | undefined;

    expect(
      store.shared.withScratchIndex("snapshot", (scratch) => {
        escaped = scratch;
        scratch.indexReplace(
          [entry("a.txt", 0, "2".repeat(40)), entry("conflict.txt", 2, "3".repeat(40))],
          { flushEvery: 1 },
        );
        expect(scratch.hasConflicts()).toBe(true);
        scratch.indexApply(
          (sink) => {
            escapedSink = sink;
            sink.remove("conflict.txt");
            sink.put(entry("z.txt", 0, "4".repeat(40)));
          },
          { flushEvery: 1 },
        );
        expect([...scratch.indexScan({ pageSize: 1 })]).toEqual([
          entry("a.txt", 0, "2".repeat(40)),
          entry("z.txt", 0, "4".repeat(40)),
        ]);
        return "captured";
      }),
    ).toBe("captured");

    expect(store.indexEntries()).toEqual([entry("checkout.txt", 0, "1".repeat(40))]);
    expect(readMaintenanceRootEpoch(inner, store.repoId)).toBe(rootEpoch);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_index_entries")).toBe(0);
    const escapedHandle = escaped;
    if (escapedHandle === undefined) throw new Error("scratch handle did not escape the callback");
    expect(() => escapedHandle.indexScan().next()).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    const escapedMutationSink = escapedSink;
    if (escapedMutationSink === undefined) throw new Error("index mutation sink did not escape");
    expect(() => escapedMutationSink.put(entry("late.txt"))).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("isolates names by repository, rejects duplicates, and enforces the session cap", () => {
    const inner = new TestDatabase();
    const database = new SqliteGitDatabase(inner);
    const first = database.openCheckout(
      database.createRepository("/first", "ref: refs/heads/main"),
    );
    const second = database.openCheckout(
      database.createRepository("/second", "ref: refs/heads/main"),
    );

    first.shared.withScratchIndex("same", (firstScratch) => {
      firstScratch.indexReplace([entry("first.txt")]);
      sharedRepoStoreMutations(second.shared).withScratchIndexOwned("same", (secondScratch) => {
        secondScratch.indexReplace([entry("second.txt")]);
        expect([...firstScratch.indexScan()].map((row) => row.path)).toEqual(["first.txt"]);
        expect([...secondScratch.indexScan()].map((row) => row.path)).toEqual(["second.txt"]);
      });
      expect(() =>
        sharedRepoStoreMutations(first.shared).withScratchIndexOwned("same", () => undefined),
      ).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    });

    const nest = (depth: number): void => {
      if (depth === MAX_SCRATCH_INDEXES_PER_REPOSITORY) {
        expect(() =>
          sharedRepoStoreMutations(first.shared).withScratchIndexOwned(
            `slot-${depth}`,
            () => undefined,
          ),
        ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
        return;
      }
      sharedRepoStoreMutations(first.shared).withScratchIndexOwned(`slot-${depth}`, () =>
        nest(depth + 1),
      );
    };
    nest(0);

    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_index_entries")).toBe(0);
  });

  it("poisons the outer transaction when it catches a nested callback failure", () => {
    const inner = new TestDatabase();
    const database = new SqliteGitDatabase(inner);
    const first = database.openCheckout(
      database.createRepository("/first", "ref: refs/heads/main"),
    );
    const second = database.openCheckout(
      database.createRepository("/second", "ref: refs/heads/main"),
    );
    let thrownOid = "";

    expect(() =>
      first.shared.withScratchIndex("outer-throw", (outer) => {
        outer.indexReplace([entry("outer.txt")]);
        try {
          sharedRepoStoreMutations(second.shared).withScratchIndexOwned("inner-throw", (nested) => {
            nested.indexReplace([entry("inner.txt")]);
            thrownOid = sharedRepoStoreMutations(second.shared).writeOwned(
              "blob",
              utf8.encode("nested throw\n"),
            );
            throw new Error("nested failure");
          });
        } catch (error) {
          expect(error).toEqual(expect.objectContaining({ message: "nested failure" }));
        }
        return "must not commit";
      }),
    ).toThrow("nested failure");
    expect(second.read(thrownOid)).toBeNull();

    let thenableOid = "";
    expect(() =>
      first.shared.withScratchIndex("outer-thenable", () => {
        try {
          sharedRepoStoreMutations(first.shared).withScratchIndexOwned(
            "inner-thenable",
            (nested) => {
              nested.indexReplace([entry("thenable.txt")]);
              thenableOid = sharedRepoStoreMutations(first.shared).writeOwned(
                "blob",
                utf8.encode("nested thenable\n"),
              );
              return Promise.resolve("late");
            },
          );
        } catch (error) {
          expect(error).toEqual(expect.objectContaining({ code: "EINVAL" }));
        }
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(first.read(thenableOid)).toBeNull();

    expect(inner.scalar<number>("SELECT count(*) FROM git_objects")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_index_entries")).toBe(0);
    expect(first.shared.withScratchIndex("after-failure", () => 42)).toBe(42);
  });

  it("bounds UTF-8 names and parameterizes hostile text", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    const maximalName = `${"é".repeat((MAX_SCRATCH_INDEX_NAME_BYTES - 1) / 2)}a`;
    expect(new TextEncoder().encode(maximalName)).toHaveLength(MAX_SCRATCH_INDEX_NAME_BYTES);
    expect(store.shared.withScratchIndex(maximalName, () => 42)).toBe(42);

    for (const invalid of ["", "nul\0name", "é".repeat(128)]) {
      expect(() => store.shared.withScratchIndex(invalid, () => undefined)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }

    const hostile = "x'); DELETE FROM git_repositories; --";
    expect(() =>
      store.shared.withScratchIndex(hostile, (scratch) => {
        scratch.indexReplace([entry("hostile.txt")]);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(inner.scalar<number>("SELECT count(*) FROM git_repositories")).toBe(1);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_index_entries")).toBe(0);
  });

  it("rolls back rows and object caches after throw or thenable return", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    let thrownOid = "";
    expect(() =>
      store.shared.withScratchIndex("throw", (scratch) => {
        scratch.indexReplace([entry("throw.txt")]);
        thrownOid = sharedRepoStoreMutations(store.shared).writeOwned(
          "blob",
          utf8.encode("throw\n"),
        );
        expect(store.read(thrownOid)?.data).toEqual(utf8.encode("throw\n"));
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(store.read(thrownOid)).toBeNull();

    let thenableOid = "";
    expect(() =>
      store.shared.withScratchIndex("thenable", (scratch) => {
        scratch.indexReplace([entry("thenable.txt")]);
        thenableOid = sharedRepoStoreMutations(store.shared).writeOwned(
          "blob",
          utf8.encode("thenable\n"),
        );
        return Promise.resolve("late");
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(store.read(thenableOid)).toBeNull();

    expect(() =>
      store.shared.withScratchIndex("nested-thenable", (scratch) =>
        scratch.indexApply((sink) => {
          sink.put(entry("nested-thenable.txt"));
          return Promise.resolve("late");
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(inner.scalar<number>("SELECT count(*) FROM git_objects")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_index_entries")).toBe(0);

    const reopenedDatabase = new SqliteGitDatabase(inner);
    const checkout = reopenedDatabase.findCheckout("/repo");
    if (checkout === null) throw new Error("checkout disappeared after scratch rollback");
    const reopened = reopenedDatabase.openCheckout(checkout);
    expect(reopened.read(thrownOid)).toBeNull();
    expect(reopened.read(thenableOid)).toBeNull();
  });

  it("streams a maximal repository shape through bounded SQL and 1.5 MB JSON pages", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    inner.storage.resetCounters();
    db.widestBindings = 0;
    db.widestRows = 0;
    db.widestStringBytes = 0;

    const rows = function* (): Generator<IndexEntry> {
      for (let index = 0; index < 24_252; index++) {
        yield entry(`dir/file-${String(index).padStart(5, "0")}.txt`);
      }
    };
    const seen = store.shared.withScratchIndex("scale", (scratch) => {
      scratch.indexReplace(rows());
      let count = 0;
      scratch.indexApply((sink) => {
        for (const row of scratch.indexScan({ pageSize: 513 })) {
          sink.remove(row.path);
          sink.put({ ...row, size: 1 });
          count++;
        }
      });
      expect(scratch.hasConflicts()).toBe(false);
      return count;
    });

    expect(seen).toBe(24_252);
    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(db.widestRows).toBeLessThanOrEqual(513);
    expect(db.widestBindings).toBeLessThanOrEqual(8);
    expect(db.widestStringBytes).toBeLessThanOrEqual(1_500_000);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_indexes")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_scratch_index_entries")).toBe(0);
  });
});

describe("tryCreateInitialState", () => {
  const contentId = (value: number): Uint8Array =>
    new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]);
  const oid = (value: number): string => value.toString(16).padStart(40, "0");

  it("atomically writes an ordered empty index and binary blob mappings without DELETE", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    inner.storage.resetCounters();

    const result = store.tryCreateInitialState((session) => {
      session.put({ ...entry("a.txt", 0, oid(1)), size: 3, mtime: 4, ino: 5, rev: 6 });
      session.addBlobId({ contentId: new Uint8Array([0, 255, 0]), oid: oid(1) });
      session.put({ ...entry("z.txt", 0, oid(2)), size: 7 });
      session.addBlobId({ contentId: new Uint8Array([255, 0, 255]), oid: oid(2) });
      return "created";
    });

    expect(result).toEqual({ available: true, value: "created" });
    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(db.initialStateWrites).toBe(2);
    expect(db.deleteStatements).toBe(0);
    expect(store.indexEntries()).toEqual([
      { ...entry("a.txt", 0, oid(1)), size: 3, mtime: 4, ino: 5, rev: 6 },
      { ...entry("z.txt", 0, oid(2)), size: 7 },
    ]);
    expect(
      store.lookupBlobIds([new Uint8Array([0, 255, 0]), new Uint8Array([255, 0, 255])]),
    ).toEqual(
      new Map([
        ["00ff00", oid(1)],
        ["ff00ff", oid(2)],
      ]),
    );
  });

  it("allows an empty body", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    const rootEpoch = readMaintenanceRootEpoch(inner, store.repoId);
    inner.storage.resetCounters();
    expect(store.tryCreateInitialState(() => 42)).toEqual({ available: true, value: 42 });
    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(readMaintenanceRootEpoch(inner, store.repoId)).toBe(rootEpoch);
    expect(store.indexEntries()).toEqual([]);
  });

  it("persists blob mappings without changing index roots", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    const mapping = contentId(7);
    const objectId = oid(8);
    const rootEpoch = readMaintenanceRootEpoch(inner, store.repoId);
    inner.storage.resetCounters();

    expect(
      store.tryCreateInitialState((session) => {
        session.addBlobId({ contentId: mapping, oid: objectId });
        return "cached";
      }),
    ).toEqual({ available: true, value: "cached" });
    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(readMaintenanceRootEpoch(inner, store.repoId)).toBe(rootEpoch);
    expect(store.indexEntries()).toEqual([]);
    expect(store.lookupBlobIds([mapping])).toEqual(new Map([[toHex(mapping), objectId]]));
  });

  it("orders paths by Git UTF-8 bytes rather than JavaScript UTF-16 units", () => {
    const store = open();
    expect(
      store.tryCreateInitialState((session) => {
        session.put(entry(".txt", 0, oid(1)));
        session.put(entry("😀.txt", 0, oid(2)));
      }),
    ).toEqual({ available: true, value: undefined });
    expect(store.indexEntries().map((row) => row.path)).toEqual([".txt", "😀.txt"]);

    const reversed = open();
    expect(() =>
      reversed.tryCreateInitialState((session) => {
        session.put(entry("😀.txt", 0, oid(1)));
        session.put(entry(".txt", 0, oid(2)));
      }),
    ).toThrow("strict Git path order");
    expect(reversed.indexEntries()).toEqual([]);
  });

  it("writes and reopens the former 2,201-byte initial-path excess exactly", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    const first = entry("a".repeat(2_200), 0, oid(1));
    const formerExcess = { ...entry("b".repeat(2_201), 0, oid(2)), size: 7 };

    expect(
      store.tryCreateInitialState((session) => {
        session.put(first);
        session.put(formerExcess);
      }),
    ).toEqual({ available: true, value: undefined });
    expect(store.indexEntries()).toEqual([first, formerExcess]);

    const reopenedDatabase = new SqliteGitDatabase(inner);
    const checkout = reopenedDatabase.findCheckout("/repo");
    if (checkout === null) throw new Error("initial checkout disappeared");
    expect(reopenedDatabase.openCheckout(checkout).indexEntries()).toEqual([first, formerExcess]);
  });

  it("returns unavailable before calling the body for every existing stage", () => {
    for (const stage of [0, 2]) {
      const inner = new TestDatabase();
      const db = new WidestDatabase(inner);
      const store = open(db);
      store.indexPut(entry("existing.txt", stage, oid(stage + 1)));
      inner.storage.resetCounters();
      db.initialStateWrites = 0;
      let called = false;

      const result = store.tryCreateInitialState(() => {
        called = true;
        return "unexpected";
      });

      expect(result).toEqual({ available: false });
      expect(called).toBe(false);
      expect(inner.storage.statementCount).toBeLessThan(1_000);
      expect(db.initialStateWrites).toBe(0);
      expect(store.indexEntries()).toEqual([entry("existing.txt", stage, oid(stage + 1))]);
    }
  });

  it("streams 24,252 index rows and blob mappings through bounded state", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    inner.storage.resetCounters();
    db.widestBindings = 0;

    const result = store.tryCreateInitialState((session) => {
      for (let index = 0; index < 24_252; index++) {
        const path = `dir/file-${String(index).padStart(5, "0")}.txt`;
        const objectId = oid(index + 1);
        session.put({ ...entry(path, 0, objectId), size: index });
        session.addBlobId({ contentId: contentId(index), oid: objectId });
      }
      return 24_252;
    });

    expect(result).toEqual({ available: true, value: 24_252 });
    expect(inner.storage.statementCount).toBeLessThan(1_000);
    // Streaming replacement must not fall back to a table-wide delete.
    expect(db.deleteStatements).toBe(0);
    expect(db.widestBindings).toBeLessThanOrEqual(3);
    expect(db.widestBlob).toBeLessThanOrEqual(1024 * 1024);
    expect(db.widestStringBytes).toBeLessThanOrEqual(1_500_000);
    expect(
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_index WHERE checkout_id = ?",
        store.checkoutId,
      ),
    ).toBe(24_252);
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids WHERE repo_id = ?", store.repoId),
    ).toBe(24_252);
    expect(store.indexGet("dir/file-00000.txt")?.oid).toBe(oid(1));
    expect(store.indexGet("dir/file-24251.txt")?.oid).toBe(oid(24_252));
  });

  it("rejects duplicate, backward, and invalid entries with full rollback", () => {
    const invalid: IndexEntry[] = [
      entry("f0511.txt", 0, oid(9000)),
      entry("f0000.txt", 0, oid(9001)),
      { ...entry("f0512.txt", 1, oid(9002)) },
      { ...entry("f0512.txt", 0, oid(9003)), mode: 0o100600 },
      { ...entry("f0512.txt", 0, "not-an-oid") },
      { ...entry("f0512.txt", 0, oid(9004)), size: -1 },
      entry("../invalid.txt", 0, oid(9005)),
      entry("f0512-\ud800.txt", 0, oid(9006)),
    ];

    for (const rejected of invalid) {
      const store = open();
      expect(() =>
        store.tryCreateInitialState((session) => {
          for (let index = 0; index < 512; index++) {
            session.put(entry(`f${String(index).padStart(4, "0")}.txt`, 0, oid(index + 1)));
          }
          session.addBlobId({ contentId: contentId(1), oid: oid(1) });
          session.put(rejected);
        }),
      ).toThrow();
      expect(store.indexEntries()).toEqual([]);
      expect(store.lookupBlobIds([contentId(1)])).toEqual(new Map());
    }
  });

  it("keeps initial state bounded when its disposable cache exceeds the row cap", () => {
    const store = open();
    const result = store.tryCreateInitialState((session) => {
      session.put(entry("kept.txt", 0, oid(1)));
      for (let index = 0; index <= MAX_BLOB_ID_CACHE_ROWS; index++) {
        session.addBlobId({ contentId: contentId(index), oid: oid(index + 1) });
      }
      return "created";
    });
    const oldestContentId = contentId(0);
    const overCapContentId = contentId(MAX_BLOB_ID_CACHE_ROWS);

    expect(result).toEqual({ available: true, value: "created" });
    expect(store.indexEntries()).toEqual([entry("kept.txt", 0, oid(1))]);
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids WHERE repo_id = ?", store.repoId),
    ).toBeLessThanOrEqual(MAX_BLOB_ID_CACHE_ROWS);
    expect(store.lookupBlobIds([oldestContentId, overCapContentId])).toEqual(
      new Map([[toHex(overCapContentId), oid(MAX_BLOB_ID_CACHE_ROWS + 1)]]),
    );
    expect(
      store.blobIdMismatches([
        { contentId: oldestContentId, oid: oid(1) },
        { contentId: overCapContentId, oid: oid(MAX_BLOB_ID_CACHE_ROWS + 1) },
      ]),
    ).toEqual(new Map([[0, null]]));
  });

  it("invalidates captured sessions after body errors and thenables", () => {
    const thrownStore = open();
    let thrownSession: InitialStateSession | undefined;
    expect(() =>
      thrownStore.tryCreateInitialState((session) => {
        thrownSession = session;
        throw new Error("body failed");
      }),
    ).toThrow("body failed");
    const endedThrownSession = thrownSession;
    if (endedThrownSession === undefined) throw new Error("body did not capture its session");
    expect(() => endedThrownSession.put(entry("late.txt"))).toThrow("no longer active");

    const asyncStore = open();
    let asyncSession: InitialStateSession | undefined;
    expect(() =>
      asyncStore.tryCreateInitialState((session) => {
        asyncSession = session;
        session.put(entry("pending.txt"));
        session.addBlobId({ contentId: contentId(1), oid: oid(1) });
        return new Promise<void>(() => undefined).then(() => {
          session.put(entry("never.txt"));
          return "later";
        });
      }),
    ).toThrow("asynchronous result");
    const endedAsyncSession = asyncSession;
    if (endedAsyncSession === undefined) throw new Error("body did not capture its session");
    expect(() => endedAsyncSession.addBlobId({ contentId: contentId(1), oid: oid(1) })).toThrow(
      "no longer active",
    );
    expect(asyncStore.indexEntries()).toEqual([]);
  });

  it("rolls back both sinks when a later flush fails", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    db.failInitialStateWrite = 10;
    let bodyCaught = false;

    expect(() =>
      store.tryCreateInitialState((session) => {
        try {
          for (let index = 0; index < 5_000; index++) {
            const objectId = oid(index + 1);
            session.put(entry(`f${String(index).padStart(4, "0")}.txt`, 0, objectId));
            session.addBlobId({ contentId: contentId(index), oid: objectId });
          }
        } catch (error) {
          bodyCaught = true;
          expect(error).toEqual(new Error("injected initial state write"));
        }
      }),
    ).toThrow("injected initial state write");

    expect(db.initialStateWrites).toBe(10);
    expect(bodyCaught).toBe(true);
    expect(store.indexEntries()).toEqual([]);
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids WHERE repo_id = ?", store.repoId),
    ).toBe(0);
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

  it("uses raw storage through 4 KiB and zlib immediately above it", () => {
    for (const size of [4_096, 4_097]) {
      const store = open();
      const data = new Uint8Array(randomBytes(size));
      const oid = store.writeStream("blob", data.length, slice(data, 7));
      expect(
        store.db.scalar<string>(
          "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
          1,
          oid,
        ),
      ).toBe(size === 4_096 ? "raw" : "zlib");
      expect(oid).toBe(hashObject("blob", data));
      expect(store.read(oid)?.data).toEqual(data);
      expect(concat([...(store.readChunks(oid) ?? [])])).toEqual(data);
    }
  });

  it("rejects changed same-size storage passes at 4 KiB and 4 KiB plus one", () => {
    for (const size of [4_096, 4_097]) {
      const store = open();
      const first = new Uint8Array(randomBytes(size));
      const second = first.slice();
      second[second.length - 1] = (second[second.length - 1] ?? 0) ^ 0xff;
      let pass = 0;
      const chunks = () => {
        const data = pass++ === 0 ? first : second;
        return slice(data, 113)();
      };
      const oid = hashObject("blob", first);

      expect(() => store.writeStream("blob", size, chunks)).toThrow(/stream changed after hashing/);
      expect(store.has(oid)).toBe(false);
      expect(
        store.db.scalar<number>(
          "SELECT COUNT(*) FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
          1,
          oid,
        ),
      ).toBe(0);
    }
  });

  it("rolls back a changed tree storage pass and its parsed index", () => {
    const store = open();
    const entries = Array.from({ length: 160 }, (_, index) => ({
      mode: MODE_FILE,
      name: `file-${String(index).padStart(3, "0")}.txt`,
      oid: String(index).padStart(40, "0"),
    }));
    const first = serializeTree(entries);
    const second = first.slice();
    second[second.length - 1] = (second[second.length - 1] ?? 0) ^ 0xff;
    expect(first.length).toBeGreaterThan(4_096);
    let pass = 0;
    const oid = hashObject("tree", first);

    expect(() =>
      store.writeStream("tree", first.length, () => [pass++ === 0 ? first : second]),
    ).toThrow(/stream changed after hashing/);
    expect(store.has(oid)).toBe(false);
    expect(
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = ? AND tree_oid = ?",
        1,
        oid,
      ),
    ).toBe(0);
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

describe("object batches", () => {
  /** Tree objects the size a real directory listing produces. */
  const trees = (count: number): Uint8Array[] =>
    Array.from({ length: count }, (_, i) =>
      concat(
        Array.from({ length: 6 }, (_, entry) =>
          utf8.encode(`100644 file-${i}-${entry}.ts\0${String(i).padStart(20, "\0")}`),
        ),
      ),
    );

  it("flushes 3,293 objects within the statement target", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    const objects = trees(3293);

    inner.storage.resetCounters();
    db.widestBindings = 0;
    const oids = store.writeObjects((batch) => objects.map((data) => batch.write("tree", data)));

    expect(inner.storage.statementCount).toBeLessThan(1_000);
    // Four columns of multi-row VALUES would cap at 25 rows; the payload
    // form binds three parameters whatever the batch holds.
    expect(db.widestBindings).toBeLessThanOrEqual(100);

    // The count means nothing unless every object actually landed.
    expect(new Set(oids).size).toBe(objects.length);
    expect(
      inner.scalar<number>("SELECT COUNT(*) FROM git_loose_object_lifecycle WHERE repo_id = ?", 1),
    ).toBe(objects.length);
    objects.forEach((data, at) => {
      expect(oids[at]).toBe(hashObject("tree", data));
      expect(store.read(oids[at]!)?.data).toEqual(data);
    });
    expect(store.objectCount()).toBe(objects.length);
  });

  it("re-flushing the same objects writes no rows at all", () => {
    const inner = new TestDatabase();
    const store = open(inner);
    const objects = trees(500);
    store.writeObjects((batch) => {
      for (const data of objects) batch.write("tree", data);
    });
    const chunks = () =>
      store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE repo_id = ?", 1);

    const before = chunks();
    inner.storage.resetCounters();
    store.writeObjects((batch) => {
      for (const data of objects) batch.write("tree", data);
    });
    // Guard acquire, one object probe, guard release; no delete or insert.
    expect(inner.storage.statementCount).toBe(3);
    expect(chunks()).toBe(before);
  });

  it("splits into one payload per budget, and never one row per object", () => {
    const inner = new TestDatabase();
    const db = new WidestDatabase(inner);
    const store = open(db);
    // Incompressible, so 40 × 8 KB really is ~320 KB of payload.
    const objects = Array.from({ length: 40 }, () => new Uint8Array(randomBytes(8192)));

    inner.storage.resetCounters();
    db.widestBindings = 0;
    store.writeObjects((batch) => {
      for (const data of objects) batch.write("blob", data);
    });
    // 320 KB fits one default payload, so the object count never shows up
    // in the statement count at all.
    expect(inner.storage.statementCount).toBeLessThan(1_000);
    expect(db.widestBindings).toBeLessThanOrEqual(100);
    for (const data of objects) {
      expect(store.read(hashObject("blob", data))?.data).toEqual(data);
    }
  });

  it("keeps a payload under the budget the caller set", () => {
    const db = new WidestDatabase();
    const store = open(db);
    const objects = Array.from({ length: 32 }, () => new Uint8Array(randomBytes(16 * 1024)));
    db.widestBlob = 0;
    store.writeObjects(
      (batch) => {
        for (const data of objects) batch.write("blob", data);
      },
      { payloadBytes: 64 * 1024 },
    );
    // One object may overshoot the budget, never two: the flush happens
    // as soon as the buffer reaches it.
    expect(db.widestBlob).toBeLessThanOrEqual(64 * 1024 + 17 * 1024);
    for (const data of objects) {
      expect(store.read(hashObject("blob", data))?.data).toEqual(data);
    }
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
