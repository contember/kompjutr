// F3 — the bulk write. Two halves, both required: the writes must round-trip
// exactly, and they must cost a constant number of metadata statements.
//
// Everything is read back with direct SQL. F1 (scan) and F2 (read) are being
// written in parallel with this file and cannot be imported.
//
// The fixture is deliberately non-ASCII, including a directory whose own name
// is non-ASCII. §7.0's `substr()` trap — bytes over a BLOB, characters over
// TEXT — raises no error and returns the right *number* of rows; only a
// non-ASCII path shows the mis-sliced boundaries.

import { describe, expect, it } from "vitest";

import { comparePaths } from "../../src/fs/path.js";
import { CHUNK_SIZE, initializeFsSchema } from "../../src/fs/schema.js";
import { currentRev } from "../../src/fs/store/meta.js";
import { makeDirectories, writeFiles } from "../../src/fs/store/write.js";
import type { WriteEntry } from "../../src/fs/types.js";
import { readBlob, type SqlDatabase } from "../../src/sqlite/db.js";
import { TestDatabase } from "../helpers/db.js";

// -- harness ---------------------------------------------------------

/** Records every statement and its bindings, then delegates. */
class RecordingDatabase implements SqlDatabase {
  readonly statements: { query: string; bindings: unknown[] }[] = [];

  constructor(private readonly inner: SqlDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.statements.push({ query, bindings });
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.statements.push({ query, bindings });
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.statements.push({ query, bindings });
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.statements.push({ query, bindings });
    return this.inner.scalar<T>(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }

  maxBindings(): number {
    return this.statements.reduce((most, entry) => Math.max(most, entry.bindings.length), 0);
  }
}

function setup(): TestDatabase {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 1_600_000_000_000);
  return db;
}

/** Statements issued by `work`, measured on the storage counter. */
function statements(db: TestDatabase, work: () => void): number {
  db.storage.resetCounters();
  work();
  return db.storage.statementCount;
}

// -- direct-SQL read-back --------------------------------------------

interface Row {
  path: string;
  parent: string;
  inode: number;
  type: string;
  mode: number;
  mtime: number;
  size: number;
  rev: number;
  nlink: number;
  link_target: string | null;
  content_id: unknown;
}

const ROW_SQL = `
SELECT p.path AS path, p.parent AS parent, p.inode AS inode,
       n.type AS type, n.mode AS mode, n.mtime AS mtime, n.size AS size,
       n.rev AS rev, n.nlink AS nlink, n.link_target AS link_target,
       n.content_id AS content_id
  FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode`;

function rowAt(db: SqlDatabase, path: string): Row | undefined {
  return db.one<Row>(`${ROW_SQL} WHERE p.path = ?`, path);
}

function allRows(db: SqlDatabase): Row[] {
  return db.all<Row>(`${ROW_SQL} ORDER BY p.path`);
}

function bytesAt(db: SqlDatabase, path: string): Uint8Array {
  const chunks = db.all<{ bytes: unknown }>(
    `SELECT c.bytes AS bytes FROM fs_chunks c
       JOIN fs_paths p ON p.inode = c.inode
      WHERE p.path = ? ORDER BY c.idx`,
    path,
  );
  const parts = chunks.map((chunk) => readBlob(chunk.bytes));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunkCount(db: SqlDatabase, path: string): number {
  return (
    db.scalar<number>(
      `SELECT count(*) FROM fs_chunks c JOIN fs_paths p ON p.inode = c.inode WHERE p.path = ?`,
      path,
    ) ?? 0
  );
}

function contentIdAt(db: SqlDatabase, path: string): Uint8Array | null {
  const row = rowAt(db, path);
  if (row === undefined || row.content_id === null || row.content_id === undefined) return null;
  return readBlob(row.content_id);
}

// -- fixture ---------------------------------------------------------

const encoder = new TextEncoder();

// A directory whose own name is non-ASCII, plus non-ASCII basenames. Both
// halves matter: the trap mis-slices everything after the first multi-byte
// character, wherever in the path it sits.
const DIRECTORIES = [
  "příliš",
  "žluťoučký",
  "kůň",
  "úpěl",
  "ďábelské-ódy",
  "日本語",
  "🐙-chobotnice",
];

function contentId(seed: number): Uint8Array {
  const id = new Uint8Array(20);
  for (let i = 0; i < id.length; i++) id[i] = (seed * 31 + i * 7) & 0xff;
  return id;
}

function generated(count: number): WriteEntry[] {
  const entries: WriteEntry[] = [];
  for (let i = 0; i < count; i++) {
    const directory = DIRECTORIES[i % DIRECTORIES.length] ?? "ascii";
    const name = i % 3 === 0 ? `sóubor-${i}.txt` : `file-${i}.txt`;
    entries.push({
      // Generated out of path order on purpose: the batch has to sort.
      path: `/repo/${directory}/nested/${name}`,
      bytes: encoder.encode(`obsah ${i} — ${directory}\n`),
      mode: i % 5 === 0 ? 0o755 : 0o644,
      mtime: 1_700_000_000_000 + i,
      contentId: i % 2 === 0 ? contentId(i) : undefined,
    });
  }
  return entries;
}

function multiChunkBytes(): Uint8Array {
  const bytes = new Uint8Array(CHUNK_SIZE * 2 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + (i >> 11)) & 0xff;
  return bytes;
}

/** `count` generated entries plus every shape the done-check names. */
function mixedFixture(count: number): WriteEntry[] {
  return [
    ...generated(count),
    { path: "/repo/prázdný.txt", bytes: new Uint8Array(0), mtime: 1_700_000_000_001 },
    { path: "/repo/velký.bin", bytes: multiChunkBytes(), mtime: 1_700_000_000_002 },
    {
      path: "/repo/odkaz-na-kůň",
      target: "/repo/kůň/nested/file-2.txt",
      mtime: 1_700_000_000_003,
    },
    { path: "/repo/hluboký/vnořený/adresář", mode: 0o750, mtime: 1_700_000_000_004 },
    {
      path: "/repo/日本語/データ.bin",
      bytes: new Uint8Array([0, 1, 2, 250, 251, 252]),
      mtime: 1_700_000_000_005,
      contentId: contentId(999),
    },
  ];
}

// -- tests -----------------------------------------------------------

describe("writeFiles — round-trip parity", () => {
  it("reads back 2,000 mixed entries exactly: paths, bytes, modes, targets, mtimes and content ids", () => {
    const db = setup();
    const entries = mixedFixture(2_000);
    writeFiles(db, entries);

    for (const entry of entries) {
      const row = rowAt(db, entry.path);
      expect(row, entry.path).toBeDefined();
      if (row === undefined) continue;

      const expectedType =
        entry.target !== undefined ? "symlink" : entry.bytes !== undefined ? "file" : "dir";
      expect(row.type, entry.path).toBe(expectedType);
      expect(row.mtime, entry.path).toBe(entry.mtime);
      expect(row.nlink, entry.path).toBe(1);

      if (entry.mode !== undefined) expect(row.mode, entry.path).toBe(entry.mode);

      if (entry.bytes !== undefined) {
        expect(bytesAt(db, entry.path), entry.path).toEqual(entry.bytes);
        expect(row.size, entry.path).toBe(entry.bytes.length);
      }
      if (entry.target !== undefined) {
        expect(row.link_target, entry.path).toBe(entry.target);
        expect(row.size, entry.path).toBe(encoder.encode(entry.target).length);
      }
      expect(contentIdAt(db, entry.path), entry.path).toEqual(entry.contentId ?? null);
    }

    // The empty file exists and owns no chunk rows at all.
    expect(rowAt(db, "/repo/prázdný.txt")?.size).toBe(0);
    expect(chunkCount(db, "/repo/prázdný.txt")).toBe(0);

    // The multi-chunk file is stored as more than one chunk.
    expect(chunkCount(db, "/repo/velký.bin")).toBe(3);
  });

  it("stores every non-ASCII path byte-for-byte, and stores the right number of them", () => {
    const db = setup();
    const entries = generated(700);
    writeFiles(db, entries);

    const stored = new Set(allRows(db).map((row) => row.path));
    for (const entry of entries) expect(stored.has(entry.path), entry.path).toBe(true);

    // The trap loses rows to primary-key collisions as well as corrupting
    // them, so count the leaves under one non-ASCII directory explicitly.
    const expected = entries.filter((entry) => entry.path.startsWith("/repo/žluťoučký/")).length;
    const actual = db.scalar<number>(
      "SELECT count(*) FROM fs_paths WHERE parent = '/repo/žluťoučký/nested'",
    );
    expect(expected).toBeGreaterThan(0);
    expect(actual).toBe(expected);

    // `parent` is sliced from the same path, so a mis-slice shows here too.
    for (const row of allRows(db)) {
      const slash = row.path.lastIndexOf("/");
      const parent = row.path === "/" ? "" : slash === 0 ? "/" : row.path.slice(0, slash);
      expect(row.parent, row.path).toBe(parent);
    }
  });

  it("stores paths in BINARY order, which is comparePaths order", () => {
    const db = setup();
    writeFiles(db, generated(400));
    const paths = allRows(db).map((row) => row.path);
    const sorted = [...paths].sort(comparePaths);
    expect(paths).toEqual(sorted);
  });

  it("defaults mtime to the clock and mode to 0o644 / 0o755 / 0o777", () => {
    const db = setup();
    const before = Date.now();
    writeFiles(db, [
      { path: "/d/f.txt", bytes: encoder.encode("x") },
      { path: "/d/l", target: "./f.txt" },
      { path: "/d/sub" },
    ]);
    const after = Date.now();

    expect(rowAt(db, "/d/f.txt")?.mode).toBe(0o644);
    expect(rowAt(db, "/d/sub")?.mode).toBe(0o755);
    expect(rowAt(db, "/d/l")?.mode).toBe(0o777);
    expect(rowAt(db, "/d")?.mode).toBe(0o755);

    for (const path of ["/d", "/d/f.txt", "/d/l", "/d/sub"]) {
      const mtime = rowAt(db, path)?.mtime ?? 0;
      expect(mtime, path).toBeGreaterThanOrEqual(before);
      expect(mtime, path).toBeLessThanOrEqual(after);
    }
  });

  it("bumps rev once per call, not once per row", () => {
    const db = setup();
    const before = currentRev(db);
    writeFiles(db, generated(300));
    const after = currentRev(db);
    expect(after).toBe(before + 1);
    for (const row of allRows(db)) {
      if (row.path === "/") continue;
      expect(row.rev, row.path).toBe(after);
    }
  });
});

describe("writeFiles — statement cost", () => {
  it("costs a constant number of metadata statements as the file count grows", () => {
    const measure = (count: number): number => {
      const db = setup();
      return statements(db, () => {
        writeFiles(db, generated(count));
      });
    };

    const small = measure(500);
    const target = measure(2_000);
    const large = measure(5_000);

    // Ordered resolve, existence probe, bumpRev, allocateInodes (2),
    // fs_nodes, fs_paths — plus one content payload.
    expect(target).toBe(8);
    expect(small).toBe(target);
    expect(large).toBe(target);
  });

  it("adds one statement per payload budget of content and nothing else", () => {
    const bytes = new Uint8Array(64 * 1024);
    const entries: WriteEntry[] = Array.from({ length: 16 }, (_, i) => ({
      path: `/repo/velké/část-${i}.bin`,
      bytes,
      mtime: 1_700_000_000_000,
    }));
    const total = bytes.length * entries.length; // 1 MiB

    const cost = (budget: number): number => {
      const db = setup();
      return statements(db, () => {
        writeFiles(db, entries, { payloadBudget: budget });
      });
    };

    const metadata = 7;
    expect(cost(1024 * 1024)).toBe(metadata + total / (1024 * 1024));
    expect(cost(256 * 1024)).toBe(metadata + total / (256 * 1024));
    expect(cost(64 * 1024)).toBe(metadata + total / (64 * 1024));
  });

  it("issues no statement with more than 100 bound parameters", () => {
    const inner = setup();
    const db = new RecordingDatabase(inner);
    writeFiles(db, mixedFixture(2_000));
    writeFiles(db, generated(500)); // again, to cover the overwrite path
    makeDirectories(db, ["/a/b/c", "/a/b/d", "/žluťoučký/kůň"]);

    expect(db.statements.length).toBeGreaterThan(0);
    expect(db.maxBindings()).toBeLessThanOrEqual(100);
    // Nothing here needs more than the JSON, the revision and one payload.
    expect(db.maxBindings()).toBe(3);
  });
});

describe("writeFiles — parents", () => {
  it("creates missing intermediate directories by default", () => {
    const db = setup();
    writeFiles(db, [{ path: "/a/b/c/d.txt", bytes: encoder.encode("hi") }]);

    for (const path of ["/a", "/a/b", "/a/b/c"]) {
      const row = rowAt(db, path);
      expect(row, path).toBeDefined();
      expect(row?.type, path).toBe("dir");
      expect(row?.mode, path).toBe(0o755);
    }
    expect(rowAt(db, "/a/b/c/d.txt")?.type).toBe("file");
  });

  it("leaves an existing directory alone — same inode, same mtime, same rev", () => {
    const db = setup();
    writeFiles(db, [{ path: "/a/b/first.txt", bytes: encoder.encode("1"), mtime: 111 }]);
    const before = rowAt(db, "/a/b");
    const revBefore = currentRev(db);

    writeFiles(db, [{ path: "/a/b/second.txt", bytes: encoder.encode("2"), mtime: 222 }]);
    const after = rowAt(db, "/a/b");

    expect(after?.inode).toBe(before?.inode);
    expect(after?.mtime).toBe(before?.mtime);
    expect(after?.rev).toBe(before?.rev);
    expect(currentRev(db)).toBe(revBefore + 1);
  });

  it("leaves an existing directory alone when it is named explicitly too", () => {
    const db = setup();
    writeFiles(db, [{ path: "/a", mode: 0o700, mtime: 111 }]);
    const before = rowAt(db, "/a");
    writeFiles(db, [{ path: "/a", mode: 0o777, mtime: 999 }]);
    expect(rowAt(db, "/a")).toEqual(before);
  });

  it("refuses a missing parent when parents is false", () => {
    const db = setup();
    expect(() => {
      writeFiles(db, [{ path: "/a/b/c.txt", bytes: encoder.encode("x") }], { parents: false });
    }).toThrow(/ENOENT/);
    expect(rowAt(db, "/a")).toBeUndefined();
    expect(rowAt(db, "/a/b/c.txt")).toBeUndefined();
  });

  it("accepts parents: false when the parent is present, or supplied by the same call", () => {
    const db = setup();
    makeDirectories(db, ["/a/b"]);
    writeFiles(db, [{ path: "/a/b/c.txt", bytes: encoder.encode("x") }], { parents: false });
    expect(rowAt(db, "/a/b/c.txt")?.type).toBe("file");

    writeFiles(
      db,
      [{ path: "/a/b/deeper/leaf.txt", bytes: encoder.encode("y") }, { path: "/a/b/deeper" }],
      { parents: false },
    );
    expect(rowAt(db, "/a/b/deeper/leaf.txt")?.type).toBe("file");
  });

  it("refuses to write through a path segment that is a file", () => {
    const db = setup();
    writeFiles(db, [{ path: "/a/b", bytes: encoder.encode("not a directory") }]);
    expect(() => {
      writeFiles(db, [{ path: "/a/b/c.txt", bytes: encoder.encode("x") }]);
    }).toThrow(/ENOTDIR/);
  });

  it("refuses to replace a directory with a file, or a file with a directory", () => {
    const db = setup();
    writeFiles(db, [{ path: "/a/b/c.txt", bytes: encoder.encode("x") }]);
    expect(() => {
      writeFiles(db, [{ path: "/a/b", bytes: encoder.encode("clobber") }]);
    }).toThrow(/EISDIR/);
    expect(() => {
      writeFiles(db, [{ path: "/a/b/c.txt" }]);
    }).toThrow(/EEXIST/);
  });
});

describe("writeFiles — overwrite", () => {
  it("replaces content and drops every stale chunk", () => {
    const db = setup();
    const long = multiChunkBytes();
    writeFiles(db, [{ path: "/repo/dlouhý.bin", bytes: long, mtime: 1 }]);
    const inode = rowAt(db, "/repo/dlouhý.bin")?.inode;
    expect(chunkCount(db, "/repo/dlouhý.bin")).toBe(3);

    const short = encoder.encode("krátký");
    writeFiles(db, [{ path: "/repo/dlouhý.bin", bytes: short, mtime: 2 }]);

    const row = rowAt(db, "/repo/dlouhý.bin");
    expect(row?.inode).toBe(inode); // st_ino is stable across an overwrite
    expect(row?.size).toBe(short.length);
    expect(row?.mtime).toBe(2);
    expect(chunkCount(db, "/repo/dlouhý.bin")).toBe(1);
    // The tail of the previous content must not be readable.
    expect(bytesAt(db, "/repo/dlouhý.bin")).toEqual(short);
  });

  it("clears a stale content_id, and records a new one when given", () => {
    const db = setup();
    writeFiles(db, [
      { path: "/f.txt", bytes: encoder.encode("one"), contentId: contentId(1), mtime: 1 },
    ]);
    expect(contentIdAt(db, "/f.txt")).toEqual(contentId(1));

    writeFiles(db, [{ path: "/f.txt", bytes: encoder.encode("two"), mtime: 2 }]);
    expect(contentIdAt(db, "/f.txt")).toBeNull();

    writeFiles(db, [
      { path: "/f.txt", bytes: encoder.encode("three"), contentId: contentId(3), mtime: 3 },
    ]);
    expect(contentIdAt(db, "/f.txt")).toEqual(contentId(3));
  });

  it("swaps a file for a symlink and back, dropping the file's chunks", () => {
    const db = setup();
    writeFiles(db, [{ path: "/x", bytes: encoder.encode("bytes"), mtime: 1 }]);
    const inode = rowAt(db, "/x")?.inode;

    writeFiles(db, [{ path: "/x", target: "/cíl", mtime: 2 }]);
    const asLink = rowAt(db, "/x");
    expect(asLink?.type).toBe("symlink");
    expect(asLink?.inode).toBe(inode);
    expect(asLink?.link_target).toBe("/cíl");
    expect(chunkCount(db, "/x")).toBe(0);

    writeFiles(db, [{ path: "/x", bytes: encoder.encode("again"), mtime: 3 }]);
    const asFile = rowAt(db, "/x");
    expect(asFile?.type).toBe("file");
    expect(asFile?.link_target).toBeNull();
    expect(bytesAt(db, "/x")).toEqual(encoder.encode("again"));
  });

  it("resolves a duplicated path last-one-wins", () => {
    const db = setup();
    writeFiles(db, [
      { path: "/dup.txt", bytes: encoder.encode("first"), mtime: 1 },
      { path: "/./dup.txt", bytes: encoder.encode("second"), mtime: 2 },
    ]);
    expect(bytesAt(db, "/dup.txt")).toEqual(encoder.encode("second"));
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths WHERE path = '/dup.txt'")).toBe(1);
  });
});

describe("writeFiles — ordering", () => {
  it("lands a parent directory row before its children", () => {
    const inner = setup();
    const db = new RecordingDatabase(inner);
    // Supplied deepest-first, so nothing but the sort can produce the order.
    writeFiles(db, [
      { path: "/z/y/x/w/leaf.txt", bytes: encoder.encode("leaf") },
      { path: "/z/y/x/other.txt", bytes: encoder.encode("other") },
      { path: "/ž/ý/日本語/hluboko.txt", bytes: encoder.encode("deep") },
    ]);

    // Observable half: inodes are allocated in path order, so a parent's
    // inode is always lower than its children's.
    for (const row of allRows(inner)) {
      if (row.path === "/") continue;
      const slash = row.path.lastIndexOf("/");
      const parent = slash === 0 ? "/" : row.path.slice(0, slash);
      const parentRow = rowAt(inner, parent);
      expect(parentRow, parent).toBeDefined();
      expect(parentRow?.inode, row.path).toBeLessThan(row.inode);
    }

    // `fs_paths` is WITHOUT ROWID, so insertion order leaves no trace in
    // the table. Read it off the payload the INSERT was actually fed.
    const insert = db.statements.find((entry) => entry.query.includes("INSERT INTO fs_paths"));
    expect(insert).toBeDefined();
    const payload = insert?.bindings[0];
    expect(typeof payload).toBe("string");
    const items: { p: string }[] = JSON.parse(String(payload));
    const written = items.map((item) => item.p);
    expect(written).toEqual([...written].sort(comparePaths));
  });

  it("stores a path under a symlinked directory at its real location", () => {
    const db = setup();
    makeDirectories(db, ["/skutečný"]);
    writeFiles(db, [{ path: "/odkaz", target: "/skutečný" }]);

    writeFiles(db, [{ path: "/odkaz/přes-odkaz.txt", bytes: encoder.encode("real"), mtime: 7 }]);

    expect(rowAt(db, "/odkaz/přes-odkaz.txt")).toBeUndefined();
    const row = rowAt(db, "/skutečný/přes-odkaz.txt");
    expect(row?.type).toBe("file");
    expect(row?.parent).toBe("/skutečný");
    expect(bytesAt(db, "/skutečný/přes-odkaz.txt")).toEqual(encoder.encode("real"));
  });

  it("replaces a symlink rather than writing through it", () => {
    const db = setup();
    makeDirectories(db, ["/skutečný"]);
    writeFiles(db, [
      { path: "/skutečný/cíl.txt", bytes: encoder.encode("target content"), mtime: 1 },
      { path: "/odkaz.txt", target: "/skutečný/cíl.txt", mtime: 2 },
    ]);

    writeFiles(db, [{ path: "/odkaz.txt", bytes: encoder.encode("replaced"), mtime: 3 }]);

    expect(rowAt(db, "/odkaz.txt")?.type).toBe("file");
    expect(bytesAt(db, "/odkaz.txt")).toEqual(encoder.encode("replaced"));
    expect(bytesAt(db, "/skutečný/cíl.txt")).toEqual(encoder.encode("target content"));
  });
});

describe("makeDirectories", () => {
  it("costs a constant number of statements regardless of how many paths", () => {
    const paths = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => {
        const directory = DIRECTORIES[i % DIRECTORIES.length] ?? "ascii";
        return `/tree/${directory}/úroveň-${i}`;
      });

    const measure = (count: number): number => {
      const db = setup();
      return statements(db, () => {
        makeDirectories(db, paths(count));
      });
    };

    // Ordered resolve, existence probe, bumpRev, allocateInodes (2),
    // fs_nodes, fs_paths. No content, so no payload statement.
    const hundred = measure(100);
    expect(hundred).toBe(7);
    expect(measure(1_000)).toBe(hundred);
    expect(measure(5_000)).toBe(hundred);
  });

  it("creates parents and is idempotent", () => {
    const db = setup();
    makeDirectories(db, ["/a/b/c", "/a/b/d", "/žluťoučký/kůň/úpěl"]);

    const created = allRows(db);
    expect(created.map((row) => row.path)).toEqual([
      "/",
      "/a",
      "/a/b",
      "/a/b/c",
      "/a/b/d",
      "/žluťoučký",
      "/žluťoučký/kůň",
      "/žluťoučký/kůň/úpěl",
    ]);
    for (const row of created) expect(row.type, row.path).toBe("dir");

    const revAfterFirst = currentRev(db);
    const repeat = statements(db, () => {
      makeDirectories(db, ["/a/b/c", "/a/b/d", "/žluťoučký/kůň/úpěl"]);
    });

    expect(allRows(db)).toEqual(created);
    expect(currentRev(db)).toBe(revAfterFirst);
    // Two probes and nothing else: there is nothing left to create.
    expect(repeat).toBe(2);
  });

  it("does nothing at all when given no paths", () => {
    const db = setup();
    const before = currentRev(db);
    const cost = statements(db, () => {
      makeDirectories(db, []);
    });
    expect(cost).toBe(0);
    expect(currentRev(db)).toBe(before);
  });
});
