// F2 — the bulk read primitive (P2 from §7.0).
//
// Two halves, both required: the bytes come back exactly as they went in,
// and the budget is enforced by the query. The second half is the one that
// is easy to fake, so `ProbeDatabase` below measures the largest result set
// any single statement carried rather than trusting `remaining` to appear.

import { describe, expect, it } from "vitest";

import { normalize } from "../../src/fs/path.js";
import { CHUNK_SIZE, initializeFsSchema } from "../../src/fs/schema.js";
import {
  DEFAULT_READ_BUDGET,
  MAX_HANDLE_MATERIALIZE_BYTES,
  readFile,
  readFileHandles,
  readFiles,
  readRange,
} from "../../src/fs/store/read.js";
import { realpath } from "../../src/fs/store/resolve.js";
import { discoverFiles } from "../../src/fs/store/scan.js";
import { writeFiles } from "../../src/fs/store/write.js";
import type { SqlDatabase } from "../../src/sqlite/db.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const MIB = 1024 * 1024;
const FIXED_MTIME = 1_700_000_000_000;

/**
 * A finer probe than `SqliteTestStorage` offers: the maximum rows and BLOB
 * bytes any one result carried. `node:sqlite` will happily hand back a 50 MB
 * result set that a Durable Object would not, so the ceiling has to be
 * asserted rather than inferred from the fact that nothing crashed.
 */
class ProbeDatabase implements SqlDatabase {
  maxResultRows = 0;
  maxResultBytes = 0;

  constructor(readonly inner: TestDatabase) {}

  get statementCount(): number {
    return this.inner.storage.statementCount;
  }

  reset(): void {
    this.maxResultRows = 0;
    this.maxResultBytes = 0;
    this.inner.storage.resetCounters();
  }

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    const rows = this.inner.all<Row>(query, ...bindings);
    this.#measure(rows);
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    const row = this.inner.one<Row>(query, ...bindings);
    if (row !== undefined) this.#measure([row]);
    return row;
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }

  #measure(rows: readonly object[]): void {
    this.maxResultRows = Math.max(this.maxResultRows, rows.length);
    let bytes = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) bytes += value.byteLength;
        else if (value instanceof ArrayBuffer) bytes += value.byteLength;
      }
    }
    this.maxResultBytes = Math.max(this.maxResultBytes, bytes);
  }
}

// -- fixture -------------------------------------------------------------
// Direct SQL only. F3 (bulk write) is being written in parallel and does
// not exist yet, so nothing here may depend on it.

class Fixture {
  readonly db: ProbeDatabase;
  #nextInode = 2;
  #dirs = new Set<string>(["/"]);

  constructor() {
    const inner = new TestDatabase(new SqliteTestStorage());
    initializeFsSchema(inner, () => FIXED_MTIME);
    this.db = new ProbeDatabase(inner);
  }

  transaction(work: () => void): void {
    this.db.transactionSync(work);
  }

  mkdir(path: string): void {
    const real = normalize(path);
    if (this.#dirs.has(real)) return;
    const parent = parentOf(real);
    this.mkdir(parent);
    const inode = this.#claimInode();
    this.db.run(
      `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
       VALUES (?, 'dir', ?, ?, 0, 0, 1)`,
      inode,
      0o755,
      FIXED_MTIME,
    );
    this.db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)", real, parent, inode);
    this.#dirs.add(real);
  }

  /** A file row plus its chunk rows, exactly as §3.3 lays them out. */
  file(path: string, bytes: Uint8Array): void {
    const inode = this.#addFile(path, bytes.length);
    for (let idx = 0; idx * CHUNK_SIZE < bytes.length; idx++) {
      // .slice(), not .subarray(): a BLOB must reach SQLite as its own
      // bytes, not as a view over a larger buffer.
      const chunk = bytes.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
      this.db.run("INSERT INTO fs_chunks (inode, idx, bytes) VALUES (?, ?, ?)", inode, idx, chunk);
    }
  }

  /**
   * The same, but generated chunk by chunk, so a 50 MB fixture never exists
   * in JS as one buffer. Chunk `i` holds `pseudoRandom(_, seed + i)`.
   */
  streamedFile(path: string, chunks: number, lastChunkBytes: number, seed: number): void {
    const size = (chunks - 1) * CHUNK_SIZE + lastChunkBytes;
    const inode = this.#addFile(path, size);
    for (let idx = 0; idx < chunks; idx++) {
      const length = idx === chunks - 1 ? lastChunkBytes : CHUNK_SIZE;
      this.db.run(
        "INSERT INTO fs_chunks (inode, idx, bytes) VALUES (?, ?, ?)",
        inode,
        idx,
        pseudoRandom(length, seed + idx),
      );
    }
  }

  symlink(path: string, target: string): void {
    const real = normalize(path);
    const parent = parentOf(real);
    this.mkdir(parent);
    const inode = this.#claimInode();
    this.db.run(
      `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target)
       VALUES (?, 'symlink', ?, ?, ?, 0, 1, ?)`,
      inode,
      0o777,
      FIXED_MTIME,
      target.length,
      target,
    );
    this.db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)", real, parent, inode);
  }

  #addFile(path: string, size: number): number {
    const real = normalize(path);
    const parent = parentOf(real);
    this.mkdir(parent);
    const inode = this.#claimInode();
    this.db.run(
      `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
       VALUES (?, 'file', ?, ?, ?, 0, 1)`,
      inode,
      0o644,
      FIXED_MTIME,
      size,
    );
    this.db.run("INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)", real, parent, inode);
    return inode;
  }

  #claimInode(): number {
    const inode = this.#nextInode++;
    this.db.run("UPDATE fs_meta SET v = ? WHERE k = 'next_inode'", this.#nextInode);
    return inode;
  }
}

function parentOf(real: string): string {
  const slash = real.lastIndexOf("/");
  return slash <= 0 ? "/" : real.slice(0, slash);
}

/** xorshift32 — deterministic, and unlike anything a bug would invent. */
function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** Byte equality with a useful failure message and no megabyte-wide diff. */
function expectBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  if (!(actual instanceof Uint8Array)) return;
  expect(actual.length).toBe(expected.length);
  let mismatch = -1;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      mismatch = i;
      break;
    }
  }
  expect(mismatch).toBe(-1);
}

/** Drain `remaining` the way a caller is expected to. Never loops forever. */
function readAll(
  db: SqlDatabase,
  paths: readonly string[],
  budget: number,
): { files: Map<string, Uint8Array>; rounds: number } {
  const files = new Map<string, Uint8Array>();
  let queue: readonly string[] = paths;
  let rounds = 0;
  while (queue.length > 0) {
    rounds++;
    if (rounds > paths.length + 2) throw new Error("readFiles made no progress");
    const batch = readFiles(db, queue, { budget });
    for (const [path, bytes] of batch.files) files.set(path, bytes);
    queue = batch.remaining;
  }
  return { files, rounds };
}

describe("readFile — content parity", () => {
  const cases: Array<[string, number]> = [
    ["an empty file", 0],
    ["a file smaller than one chunk", 1000],
    ["a file of exactly one chunk", CHUNK_SIZE],
    ["a file spanning several chunks", CHUNK_SIZE * 3 + 1234],
  ];

  for (const [name, size] of cases) {
    it(`round-trips ${name}`, () => {
      const fixture = new Fixture();
      const written = pseudoRandom(size, size + 1);
      fixture.transaction(() => fixture.file("/repo/a.bin", written));

      expectBytes(readFile(fixture.db, "/repo/a.bin"), written);
      const batch = readFiles(fixture.db, ["/repo/a.bin"], { budget: 8 * MIB });
      expect(batch.remaining).toEqual([]);
      expectBytes(batch.files.get("/repo/a.bin"), written);
    });
  }

  it("round-trips a chunk boundary that falls mid-multibyte-character", () => {
    const fixture = new Fixture();
    // '€' is E2 82 AC: its first byte is the last byte of chunk 0 and its
    // other two open chunk 1. Anything that decoded per chunk corrupts here.
    const text = `${"a".repeat(CHUNK_SIZE - 1)}€${"b".repeat(10)}`;
    const written = new TextEncoder().encode(text);
    expect(written.length).toBe(CHUNK_SIZE + 12);
    fixture.transaction(() => fixture.file("/repo/utf8.txt", written));

    const read = readFile(fixture.db, "/repo/utf8.txt");
    expectBytes(read, written);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(read)).toBe(text);
    expectBytes(
      readRange(fixture.db, "/repo/utf8.txt", CHUNK_SIZE - 1, 3),
      written.slice(-13, -10),
    );
  });

  it("follows a symlink, and rejects a missing or non-file path", () => {
    const fixture = new Fixture();
    const written = pseudoRandom(64, 7);
    fixture.transaction(() => {
      fixture.file("/repo/real.bin", written);
      fixture.symlink("/repo/link.bin", "real.bin");
      fixture.mkdir("/repo/sub");
    });

    expectBytes(readFile(fixture.db, "/repo/link.bin"), written);
    expect(() => readFile(fixture.db, "/repo/nope.bin")).toThrow(/ENOENT/);
    expect(() => readFile(fixture.db, "/repo/sub")).toThrow(/EISDIR/);
  });
});

describe("readFiles", () => {
  it("omits a path that has gone missing, without erroring", () => {
    const fixture = new Fixture();
    const a = pseudoRandom(100, 1);
    const c = pseudoRandom(200, 2);
    fixture.transaction(() => {
      fixture.file("/repo/a.bin", a);
      fixture.file("/repo/c.bin", c);
      fixture.mkdir("/repo/d");
    });

    const batch = readFiles(fixture.db, [
      "/repo/a.bin",
      "/repo/gone.bin",
      "/repo/d",
      "/repo/c.bin",
    ]);
    expect([...batch.files.keys()]).toEqual(["/repo/a.bin", "/repo/c.bin"]);
    expectBytes(batch.files.get("/repo/a.bin"), a);
    expectBytes(batch.files.get("/repo/c.bin"), c);
    expect(batch.remaining).toEqual([]);
  });

  it("costs one lookup plus one statement per byte budget, and never overruns it", () => {
    const fixture = new Fixture();
    // 9,329 files of 2,560 bytes = 23,882,240 bytes (~23.9 MB). Uniform so
    // the batch count is arithmetic rather than luck: 409 files fill a 1 MiB
    // budget, so 23 batches cover them, plus the one path lookup.
    const count = 9329;
    const size = 2560;
    const paths: string[] = [];
    fixture.transaction(() => {
      for (let i = 0; i < count; i++) {
        const path = `/repo/d${i % 64}/f${i}.bin`;
        fixture.file(path, pseudoRandom(size, i));
        paths.push(path);
      }
    });

    fixture.db.reset();
    const batch = readFiles(fixture.db, paths, { budget: MIB });
    const statements = fixture.db.statementCount;

    expect(batch.remaining).toEqual([]);
    expect(batch.files.size).toBe(count);
    expect(statements).toBeLessThanOrEqual(24);

    // The budget has to bind the query, not the caller's bookkeeping.
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(MIB);

    let total = 0;
    for (const bytes of batch.files.values()) total += bytes.length;
    expect(total).toBe(count * size);
    for (const i of [0, 1, 4242, count - 1]) {
      expectBytes(batch.files.get(`/repo/d${i % 64}/f${i}.bin`), pseudoRandom(size, i));
    }
  });

  it("assembles a 50 MB file from bounded result sets, never in one", () => {
    const fixture = new Fixture();
    const chunks = 100; // 100 x 512 KiB = 52,428,800 bytes
    fixture.transaction(() => fixture.streamedFile("/repo/huge.bin", chunks, CHUNK_SIZE, 900));

    fixture.db.reset();
    const batch = readFiles(fixture.db, ["/repo/huge.bin"], { budget: MIB });

    const bytes = batch.files.get("/repo/huge.bin");
    expect(bytes?.length).toBe(chunks * CHUNK_SIZE);
    expectBytes(bytes?.slice(0, CHUNK_SIZE), pseudoRandom(CHUNK_SIZE, 900));
    expectBytes(bytes?.slice(99 * CHUNK_SIZE), pseudoRandom(CHUNK_SIZE, 999));

    // The whole point: 52 MB of content, and no statement carried more than
    // the budget. Selecting by inode alone would show 52,428,800 here.
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(MIB);
    expect(fixture.db.maxResultRows).toBeLessThanOrEqual(2);
  });

  it("bounds readFile's result sets on a huge file too", () => {
    const fixture = new Fixture();
    fixture.transaction(() => fixture.streamedFile("/repo/huge.bin", 40, 1000, 500));

    fixture.db.reset();
    const bytes = readFile(fixture.db, "/repo/huge.bin");
    expect(bytes.length).toBe(39 * CHUNK_SIZE + 1000);
    expectBytes(bytes.slice(39 * CHUNK_SIZE), pseudoRandom(1000, 539));
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(DEFAULT_READ_BUDGET);
  });
});

describe("readFiles — remaining", () => {
  it("defers a file larger than the budget instead of truncating it", () => {
    const fixture = new Fixture();
    const small = pseudoRandom(10, 3);
    const tail = pseudoRandom(20, 4);
    fixture.transaction(() => {
      fixture.file("/repo/small.bin", small);
      fixture.streamedFile("/repo/big.bin", 8, CHUNK_SIZE, 300);
      fixture.file("/repo/tail.bin", tail);
    });

    const paths = ["/repo/small.bin", "/repo/big.bin", "/repo/tail.bin"];
    const batch = readFiles(fixture.db, paths, { budget: 1024 });

    expect([...batch.files.keys()]).toEqual(["/repo/small.bin"]);
    expectBytes(batch.files.get("/repo/small.bin"), small);
    expect(batch.files.has("/repo/big.bin")).toBe(false);
    expect(batch.remaining).toEqual(["/repo/big.bin", "/repo/tail.bin"]);
  });

  it("splits a batch on the budget without splitting a file", () => {
    const fixture = new Fixture();
    const contents = new Map<string, Uint8Array>();
    fixture.transaction(() => {
      for (let i = 0; i < 12; i++) {
        const bytes = pseudoRandom(400, 40 + i);
        contents.set(`/repo/f${i}.bin`, bytes);
        fixture.file(`/repo/f${i}.bin`, bytes);
      }
    });

    fixture.db.reset();
    const batch = readFiles(fixture.db, [...contents.keys()], { budget: 1000 });
    // 1,000 bytes holds two 400-byte files, so all twelve arrive in six
    // statements plus the lookup — and none of them arrives half-read.
    expect(batch.files.size).toBe(12);
    expect(batch.remaining).toEqual([]);
    expect(fixture.db.statementCount).toBe(7);
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(1000);
    for (const [path, bytes] of contents) expectBytes(batch.files.get(path), bytes);
  });

  it("returns only a prefix under a call-wide byte ceiling", () => {
    const fixture = new Fixture();
    fixture.transaction(() => {
      fixture.file("/repo/a", pseudoRandom(6, 1));
      fixture.file("/repo/b", pseudoRandom(6, 2));
      fixture.file("/repo/c", pseudoRandom(2, 3));
    });

    const batch = readFiles(fixture.db, ["/repo/a", "/repo/b", "/repo/c"], {
      budget: 100,
      maxBytes: 8,
    });

    expect([...batch.files.keys()]).toEqual(["/repo/a"]);
    expect(batch.remaining).toEqual(["/repo/b", "/repo/c"]);
  });

  it("makes progress on every re-call and terminates", () => {
    const fixture = new Fixture();
    const expected = new Map<string, number>();
    fixture.transaction(() => {
      fixture.streamedFile("/repo/big1.bin", 3, 4096, 610);
      expected.set("/repo/big1.bin", 2 * CHUNK_SIZE + 4096);
      fixture.file("/repo/mid.bin", pseudoRandom(700, 620));
      expected.set("/repo/mid.bin", 700);
      fixture.streamedFile("/repo/big2.bin", 2, 8192, 630);
      expected.set("/repo/big2.bin", CHUNK_SIZE + 8192);
      fixture.file("/repo/last.bin", pseudoRandom(300, 640));
      expected.set("/repo/last.bin", 300);
    });

    fixture.db.reset();
    const { files, rounds } = readAll(fixture.db, [...expected.keys()], 1024);
    expect(rounds).toBe(2);
    expect(files.size).toBe(expected.size);
    for (const [path, size] of expected) expect(files.get(path)?.length).toBe(size);
    expectBytes(files.get("/repo/big2.bin")?.slice(0, CHUNK_SIZE), pseudoRandom(CHUNK_SIZE, 630));
    expectBytes(files.get("/repo/mid.bin"), pseudoRandom(700, 620));
    // A budget below one chunk still cannot make a statement carry less
    // than one chunk — that is the floor, and it is well short of 4.5 MB.
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(CHUNK_SIZE);
  });
});

describe("readFileHandles", () => {
  function discovered(bytes = pseudoRandom(1000, 71)) {
    const fixture = new Fixture();
    fixture.transaction(() => fixture.file("/repo/.gitignore", bytes));
    const root = realpath(fixture.db, "/repo");
    const handle = discoverFiles(fixture.db, root, "*/.gitignore").handles[0];
    if (handle === undefined) throw new Error("fixture handle missing");
    return { fixture, handle, bytes };
  }

  it("returns a budget-fitting handle in one bounded statement", () => {
    const { fixture, handle, bytes } = discovered();
    fixture.db.reset();

    const batch = readFileHandles(fixture.db, [handle]);

    expectBytes(batch.files.get(handle.path), bytes);
    expect(batch.remaining).toEqual([]);
    expect(fixture.db.statementCount).toBe(1);
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(DEFAULT_READ_BUDGET);
  });

  it("rejects an oversized caller batch before issuing SQL", () => {
    const { fixture, handle } = discovered();
    const handles = Array.from({ length: 5_001 }, () => handle);
    fixture.db.reset();

    expect(() => readFileHandles(fixture.db, handles)).toThrow(/at most 5000 handles/);
    expect(fixture.db.statementCount).toBe(0);
  });

  it.each([
    ["relative", "repo/.gitignore"],
    ["non-canonical", "/repo/../repo/.gitignore"],
    ["overlong", `/${"x".repeat(4_096)}`],
  ])("rejects a %s caller handle path before issuing SQL", (_name, path) => {
    const { fixture, handle } = discovered();
    Object.defineProperty(handle, "path", { value: path });
    fixture.db.reset();

    expect(() => readFileHandles(fixture.db, [handle])).toThrow(/invalid canonical path/);
    expect(fixture.db.statementCount).toBe(0);
  });

  it("returns at most one global byte budget and preserves the retry boundary", () => {
    const fixture = new Fixture();
    fixture.transaction(() => {
      fixture.file("/repo/a", pseudoRandom(700, 1));
      fixture.file("/repo/b", pseudoRandom(700, 2));
      fixture.file("/repo/c", pseudoRandom(100, 3));
    });
    const { handles } = discoverFiles(fixture.db, realpath(fixture.db, "/repo"), "*");
    fixture.db.reset();

    const batch = readFileHandles(fixture.db, handles, { budget: 1000 });

    expect([...batch.files.keys()]).toEqual(["/repo/a"]);
    expect(batch.remaining.map((handle) => handle.path)).toEqual(["/repo/b", "/repo/c"]);
    expect(fixture.db.statementCount).toBe(1);
  });

  it("rejects a handle after its node changes or path disappears", () => {
    const changed = discovered();
    writeFiles(changed.fixture.db, [
      { path: changed.handle.path, bytes: pseudoRandom(changed.bytes.length, 99) },
    ]);
    expect(() => readFileHandles(changed.fixture.db, [changed.handle])).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );

    const removed = discovered();
    removed.fixture.db.run("DELETE FROM fs_paths WHERE path = ?", removed.handle.path);
    expect(() => readFileHandles(removed.fixture.db, [removed.handle])).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );
  });

  it.each([
    ["missing chunk", "DELETE FROM fs_chunks WHERE inode = 3 AND idx = 0"],
    ["extra chunk", "INSERT INTO fs_chunks (inode, idx, bytes) VALUES (3, 1, zeroblob(1))"],
    ["non-BLOB chunk", "UPDATE fs_chunks SET bytes = 'text' WHERE inode = 3 AND idx = 0"],
    ["non-integer index", "UPDATE fs_chunks SET idx = 0.5 WHERE inode = 3 AND idx = 0"],
  ])("rejects a %s added after discovery", (_name, sql) => {
    const { fixture, handle } = discovered();
    fixture.db.run(sql);

    expect(() => readFileHandles(fixture.db, [handle])).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });

  it("rejects compensating short and oversized chunks", () => {
    const bytes = pseudoRandom(CHUNK_SIZE + 10, 81);
    const { fixture, handle } = discovered(bytes);
    fixture.db.run(
      `UPDATE fs_chunks SET bytes = zeroblob(${CHUNK_SIZE - 1}) WHERE inode = ? AND idx = 0`,
      handle.ino,
    );
    fixture.db.run(
      "UPDATE fs_chunks SET bytes = zeroblob(11) WHERE inode = ? AND idx = 1",
      handle.ino,
    );

    expect(() => readFileHandles(fixture.db, [handle])).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });

  it("suppresses every BLOB when one handle in a batch is corrupt", () => {
    const fixture = new Fixture();
    fixture.transaction(() => {
      fixture.streamedFile("/repo/a", 2, CHUNK_SIZE, 101);
      fixture.file("/repo/b", pseudoRandom(100, 102));
    });
    const { handles } = discoverFiles(fixture.db, realpath(fixture.db, "/repo"), "*");
    const corruptHandle = handles[0];
    if (corruptHandle === undefined) throw new Error("fixture handle missing");
    fixture.db.run("DELETE FROM fs_chunks WHERE inode = ? AND idx = 0", corruptHandle.ino);
    fixture.db.reset();

    expect(() => readFileHandles(fixture.db, handles)).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
    expect(fixture.db.statementCount).toBe(1);
    expect(fixture.db.maxResultBytes).toBe(0);
  });

  it("rejects a forged huge stale handle without returning or allocating its claimed size", () => {
    const { fixture, handle } = discovered();
    const forged = { ...handle, size: Number.MAX_SAFE_INTEGER };
    fixture.db.reset();

    expect(() => readFileHandles(fixture.db, [forged])).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );
    expect(fixture.db.statementCount).toBe(1);
    expect(fixture.db.maxResultBytes).toBe(0);
  });

  it("rejects a valid oversized file before returning BLOBs or materializing it", () => {
    const fixture = new Fixture();
    const chunks = Math.floor(MAX_HANDLE_MATERIALIZE_BYTES / CHUNK_SIZE) + 1;
    fixture.transaction(() => fixture.streamedFile("/repo/oversized", chunks, CHUNK_SIZE, 3000));
    const page = discoverFiles(fixture.db, realpath(fixture.db, "/repo"), "*");
    const handle = page.handles[0];
    if (handle === undefined) throw new Error("fixture handle missing");
    fixture.db.reset();

    expect(() => readFileHandles(fixture.db, [handle])).toThrowError(
      expect.objectContaining({ code: "EFBIG" }),
    );
    expect(fixture.db.statementCount).toBe(1);
    expect(fixture.db.maxResultBytes).toBe(0);
    expect(MAX_HANDLE_MATERIALIZE_BYTES + DEFAULT_READ_BUDGET + CHUNK_SIZE).toBeLessThan(100 * MIB);
  });
});

describe("readRange", () => {
  const size = CHUNK_SIZE * 2 + 5000;
  const written = pseudoRandom(size, 77);

  function withFile(): Fixture {
    const fixture = new Fixture();
    fixture.transaction(() => fixture.file("/repo/r.bin", written));
    return fixture;
  }

  it("reads a range inside one chunk", () => {
    const fixture = withFile();
    expectBytes(readRange(fixture.db, "/repo/r.bin", 100, 50), written.slice(100, 150));
  });

  it("reads a range that spans a chunk boundary", () => {
    const fixture = withFile();
    const from = CHUNK_SIZE - 10;
    expectBytes(readRange(fixture.db, "/repo/r.bin", from, 20), written.slice(from, from + 20));
  });

  it("reads a range spanning three chunks", () => {
    const fixture = withFile();
    const from = CHUNK_SIZE - 3;
    const length = CHUNK_SIZE + 7;
    expectBytes(
      readRange(fixture.db, "/repo/r.bin", from, length),
      written.slice(from, from + length),
    );
  });

  it("returns short only at EOF", () => {
    const fixture = withFile();
    expectBytes(readRange(fixture.db, "/repo/r.bin", size - 10, 100), written.slice(size - 10));
    expectBytes(readRange(fixture.db, "/repo/r.bin", 0, size + 1000), written);
    expectBytes(readRange(fixture.db, "/repo/r.bin", size, 10), new Uint8Array(0));
    expectBytes(readRange(fixture.db, "/repo/r.bin", 10, 0), new Uint8Array(0));
    // Anything not running into EOF gets exactly the length it asked for.
    expect(readRange(fixture.db, "/repo/r.bin", size - 11, 10).length).toBe(10);
    expect(readRange(fixture.db, "/repo/r.bin", 0, CHUNK_SIZE * 2).length).toBe(CHUNK_SIZE * 2);
  });

  it("bounds its result sets on a huge range", () => {
    const fixture = new Fixture();
    fixture.transaction(() => fixture.streamedFile("/repo/huge.bin", 30, CHUNK_SIZE, 800));

    fixture.db.reset();
    const bytes = readRange(fixture.db, "/repo/huge.bin", 0, 30 * CHUNK_SIZE);
    expect(bytes.length).toBe(30 * CHUNK_SIZE);
    expectBytes(bytes.slice(29 * CHUNK_SIZE), pseudoRandom(CHUNK_SIZE, 829));
    expect(fixture.db.maxResultBytes).toBeLessThanOrEqual(DEFAULT_READ_BUDGET);
  });
});

describe("corrupt chunk detection", () => {
  const size = CHUNK_SIZE * 2 + 3;

  function corrupted(sql: string): TestDatabase {
    const db = new TestDatabase();
    initializeFsSchema(db, () => FIXED_MTIME);
    writeFiles(db, [{ path: "/f", bytes: new Uint8Array(size).fill(7) }]);
    db.run(sql);
    return db;
  }

  it.each([
    ["missing first", "DELETE FROM fs_chunks WHERE inode = 2 AND idx = 0"],
    ["missing middle", "DELETE FROM fs_chunks WHERE inode = 2 AND idx = 1"],
    ["missing trailing", "DELETE FROM fs_chunks WHERE inode = 2 AND idx = 2"],
    [
      "short chunk",
      `UPDATE fs_chunks SET bytes = zeroblob(${CHUNK_SIZE - 1}) WHERE inode = 2 AND idx = 1`,
    ],
    [
      "oversized chunk",
      `UPDATE fs_chunks SET bytes = zeroblob(${CHUNK_SIZE + 1}) WHERE inode = 2 AND idx = 1`,
    ],
  ])("rejects a %s", (_name, sql) => {
    const db = corrupted(sql);

    expect(() => readFile(db, "/f")).toThrowError(expect.objectContaining({ code: "EIO" }));
    expect(() => readFiles(db, ["/f"])).toThrowError(expect.objectContaining({ code: "EIO" }));
    expect(() => readRange(db, "/f", 0, size)).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });
});
