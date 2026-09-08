import { describe, expect, it } from "vitest";
import { readBlob, type SqlDatabase } from "../../packages/do/src/db/db.js";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { CHUNK_SIZE } from "../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function open() {
  const db = new TestDatabase();
  const fs = createFilesystem(db, { now: () => 2_000 });
  return { db, fs };
}

class LateChunkFailureDatabase implements SqlDatabase {
  chunkWrites = 0;

  constructor(
    private readonly inner: SqlDatabase,
    private readonly failAt: number,
  ) {}

  run(query: string, ...bindings: unknown[]): void {
    if (query.includes("INSERT INTO fs_chunks")) {
      this.chunkWrites++;
      if (this.chunkWrites === this.failAt) throw new Error("injected late chunk failure");
    }
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
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
}

describe("Filesystem.writeFileStream", () => {
  it("commits exact content above the former 96 MiB cumulative limit", () => {
    const { db, fs } = open();
    const size = 96 * 1024 * 1024 + 1;
    const source = new Uint8Array(2 * 1024 * 1024).fill(0x5a);
    const chunks = (function* (): Generator<Uint8Array, void, undefined> {
      let remaining = size;
      while (remaining > 0) {
        const length = Math.min(source.length, remaining);
        yield source.subarray(0, length);
        remaining -= length;
      }
    })();

    fs.writeFileStream("/large", chunks);

    let total = 0;
    let index = 0;
    for (const row of db.iterate(
      `SELECT chunk.idx, chunk.bytes
         FROM fs_paths path JOIN fs_chunks chunk ON chunk.inode = path.inode
        WHERE path.path = '/large' ORDER BY chunk.idx`,
    )) {
      expect(row.idx).toBe(index);
      const bytes = readBlob(row.bytes);
      expect(bytes.length).toBe(Math.min(CHUNK_SIZE, size - total));
      expect(bytes.every((byte) => byte === 0x5a)).toBe(true);
      total += bytes.length;
      index++;
    }
    expect(total).toBe(size);
    expect(fs.stat("/large")).toMatchObject({ size });
  });

  it("writes arbitrary chunk boundaries and appends without reading old content", () => {
    const { fs } = open();
    const first = new Uint8Array(CHUNK_SIZE - 1).fill(1);
    const second = new Uint8Array(CHUNK_SIZE + 3).fill(2);

    fs.writeFileStream("/file", [first, second]);
    fs.writeFileStream("/file", [new Uint8Array([3, 4])], { append: true });

    const bytes = fs.readFile("/file");
    expect(bytes.length).toBe(first.length + second.length + 2);
    expect(bytes.slice(-4)).toEqual(new Uint8Array([2, 2, 3, 4]));
  });

  it("commits the former 901st content statement exactly", () => {
    const { fs } = open();
    const chunks = Array.from({ length: 901 }, (_, index) => new Uint8Array([index % 251]));

    fs.writeFileStream("/file", chunks);

    expect(fs.readFile("/file")).toEqual(Uint8Array.from(chunks, (chunk) => chunk[0] ?? 0));
  });

  it("overwrites through a hardlink and clears content identity", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/file", bytes: ENCODER.encode("old"), contentId: new Uint8Array([1]) },
    ]);
    fs.link("/file", "/alias");

    fs.writeFileStream("/alias", [ENCODER.encode("new")]);

    expect(DECODER.decode(fs.readFile("/file"))).toBe("new");
    expect(fs.stat("/file")?.contentId).toBeNull();
    expect(fs.stat("/file")?.nlink).toBe(2);
  });

  it("rolls back an overwrite when the source throws after the former 96 MiB limit", () => {
    const { fs } = open();
    fs.writeFile("/file", ENCODER.encode("old"));
    const before = fs.rev();
    const failing = (function* (): Generator<Uint8Array, void, undefined> {
      const chunk = new Uint8Array(1024 * 1024).fill(0x7a);
      for (let index = 0; index < 97; index++) yield chunk;
      throw new Error("upstream failed");
    })();

    expect(() => fs.writeFileStream("/file", failing)).toThrow("upstream failed");

    expect(DECODER.decode(fs.readFile("/file"))).toBe("old");
    expect(fs.rev()).toBe(before);
  });

  it("rolls back a late SQL failure after writing beyond the former 96 MiB limit", () => {
    const inner = new TestDatabase();
    const seeded = createFilesystem(inner, { now: () => 2_000 });
    seeded.writeFile("/file", ENCODER.encode("old"));
    const before = seeded.rev();
    const db = new LateChunkFailureDatabase(inner, 194);
    const fs = createFilesystem(db, { now: () => 3_000 });
    const chunk = new Uint8Array(1024 * 1024).fill(0x6b);
    const chunks = (function* (): Generator<Uint8Array, void, undefined> {
      for (let index = 0; index < 97; index++) yield chunk;
    })();

    expect(() => fs.writeFileStream("/file", chunks)).toThrow("injected late chunk failure");

    expect(db.chunkWrites).toBe(194);
    expect(DECODER.decode(seeded.readFile("/file"))).toBe("old");
    expect(seeded.rev()).toBe(before);
  });

  it("does not leave a new path after a failed stream", () => {
    const { fs } = open();
    const failing = (function* (): Generator<Uint8Array, void, undefined> {
      yield ENCODER.encode("partial");
      throw new Error("upstream failed");
    })();

    expect(() => fs.writeFileStream("/new", failing)).toThrow("upstream failed");
    expect(fs.stat("/new")).toBeNull();
  });
});
