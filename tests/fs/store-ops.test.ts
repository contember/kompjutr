import { describe, expect, it } from "vitest";

import { CHUNK_SIZE, initializeFsSchema } from "../../src/fs/schema.js";
import { currentRev } from "../../src/fs/store/meta.js";
import {
  chmodRaw,
  linkRaw,
  readdirRaw,
  renameRaw,
  statRaw,
  truncateRaw,
  writeRangeRaw,
} from "../../src/fs/store/ops.js";
import { readFile } from "../../src/fs/store/read.js";
import { realpath, realpathNoFollow } from "../../src/fs/store/resolve.js";
import { writeFiles } from "../../src/fs/store/write.js";
import { S_IFDIR, S_IFREG } from "../../src/fs/types.js";
import type { SqlDatabase } from "../../src/sqlite/db.js";
import { TestDatabase } from "../helpers/db.js";

class MeasuringDatabase implements SqlDatabase {
  maxBlobResultBytes = 0;
  maxBlobBindingBytes = 0;

  constructor(private readonly inner: SqlDatabase) {}

  private measureBindings(bindings: readonly unknown[]): void {
    for (const value of bindings) {
      const bytes =
        value instanceof Uint8Array
          ? value.byteLength
          : value instanceof ArrayBuffer
            ? value.byteLength
            : 0;
      this.maxBlobBindingBytes = Math.max(this.maxBlobBindingBytes, bytes);
    }
  }

  private measureRows(rows: readonly object[]): void {
    let bytes = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) bytes += value.byteLength;
      }
    }
    this.maxBlobResultBytes = Math.max(this.maxBlobResultBytes, bytes);
  }

  run(query: string, ...bindings: unknown[]): void {
    this.measureBindings(bindings);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.measureBindings(bindings);
    const rows = this.inner.all<Row>(query, ...bindings);
    this.measureRows(rows);
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.measureBindings(bindings);
    const row = this.inner.one<Row>(query, ...bindings);
    if (row !== undefined) this.measureRows([row]);
    return row;
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.measureBindings(bindings);
    return this.inner.scalar<T>(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function setup(): TestDatabase {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 1_600_000_000_000);
  return db;
}

function pattern(length: number, seed = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i++) out[i] = (seed + i * 37 + (i >> 9)) & 0xff;
  return out;
}

function writeFileFixture(
  db: SqlDatabase,
  path: string,
  bytes: Uint8Array,
  options: { mode?: number; contentId?: Uint8Array } = {},
): void {
  writeFiles(db, [
    {
      path,
      bytes,
      mode: options.mode,
      mtime: 1_650_000_000_000,
      contentId: options.contentId,
    },
  ]);
}

function operationStatements(db: TestDatabase, work: () => void): number {
  db.storage.resetCounters();
  work();
  return db.storage.statementCount;
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(Buffer.compare(actual, expected)).toBe(0);
}

interface ChunkCorruption {
  name: string;
  apply(db: SqlDatabase, inode: number): void;
}

const chunkCorruptions: readonly ChunkCorruption[] = [
  {
    name: "missing",
    apply(db: SqlDatabase, inode: number): void {
      db.run("DELETE FROM fs_chunks WHERE inode = ? AND idx = 0", inode);
    },
  },
  {
    name: "short",
    apply(db: SqlDatabase, inode: number): void {
      db.run(
        "UPDATE fs_chunks SET bytes = ? WHERE inode = ? AND idx = 0",
        new Uint8Array([1]),
        inode,
      );
    },
  },
  {
    name: "oversized",
    apply(db: SqlDatabase, inode: number): void {
      db.run(
        "UPDATE fs_chunks SET bytes = ? WHERE inode = ? AND idx = 0",
        new Uint8Array([1, 2, 3, 99]),
        inode,
      );
    },
  },
  {
    name: "text storage",
    apply(db: SqlDatabase, inode: number): void {
      db.run("UPDATE fs_chunks SET bytes = 'abc' WHERE inode = ? AND idx = 0", inode);
    },
  },
  {
    name: "orphan",
    apply(db: SqlDatabase, inode: number): void {
      db.run(
        "INSERT INTO fs_chunks (inode, idx, bytes) VALUES (?, 1, ?)",
        inode,
        new Uint8Array([0]),
      );
    },
  },
];

function corruptThreeByteFile(db: SqlDatabase, path: string, kind: ChunkCorruption): number {
  writeFileFixture(db, path, new Uint8Array([1, 2, 3]));
  const stat = statRaw(db, realpath(db, path));
  if (stat === null) throw new Error(`fixture missing at ${path}`);
  kind.apply(db, stat.ino);
  return currentRev(db);
}

describe("raw metadata reads", () => {
  it("returns complete stat metadata and ordered direct children", () => {
    const db = setup();
    const contentId = pattern(20, 7);
    writeFiles(db, [
      { path: "/repo/b.txt", bytes: new Uint8Array([2]), mode: 0o640, contentId },
      { path: "/repo/a.txt", bytes: new Uint8Array([1]) },
      { path: "/repo/nested", mode: 0o750 },
      { path: "/repo/link", target: "a.txt" },
    ]);

    const file = statRaw(db, realpath(db, "/repo/b.txt"));
    expect(file).toMatchObject({
      type: "file",
      mode: S_IFREG | 0o640,
      size: 1,
      nlink: 1,
      target: null,
    });
    expect(file?.contentId).toEqual(contentId);
    expect(statRaw(db, realpath(db, "/repo"))?.mode).toBe(S_IFDIR | 0o755);
    expect(statRaw(db, realpathNoFollow(db, "/missing"))).toBeNull();
    expect(readdirRaw(db, realpath(db, "/repo"))).toEqual([
      { name: "a.txt", type: "file" },
      { name: "b.txt", type: "file" },
      { name: "link", type: "symlink" },
      { name: "nested", type: "dir" },
    ]);
  });
});

describe("writeRangeRaw", () => {
  it("preserves boundary bytes and mode while clearing content identity", () => {
    const db = setup();
    const before = pattern(CHUNK_SIZE * 2 + 31, 11);
    writeFileFixture(db, "/repo/file.bin", before, {
      mode: 0o751,
      contentId: pattern(20, 3),
    });
    const path = realpath(db, "/repo/file.bin");
    const replacement = pattern(CHUNK_SIZE + 19, 91);
    const offset = CHUNK_SIZE - 7;
    const expected = before.slice();
    expected.set(replacement, offset);
    const initialRev = currentRev(db);

    const statements = operationStatements(db, () =>
      writeRangeRaw(db, path, replacement, offset, 1_700_000_000_001),
    );

    expect(statements).toBeLessThan(1_000);
    expectBytes(readFile(db, path), expected);
    expect(statRaw(db, path)).toMatchObject({
      mode: S_IFREG | 0o751,
      size: before.length,
      mtime: 1_700_000_000_001,
      rev: initialRev + 1,
      contentId: null,
    });
    expect(currentRev(db)).toBe(initialRev + 1);
  });

  it("zero-fills a sparse extension and writes across chunk boundaries", () => {
    const db = setup();
    writeFileFixture(db, "/repo/sparse.bin", new Uint8Array([1, 2, 3]));
    const path = realpath(db, "/repo/sparse.bin");
    const offset = CHUNK_SIZE + 5;
    const bytes = new Uint8Array([7, 8, 9]);

    writeRangeRaw(db, path, bytes, offset, 42);

    const actual = readFile(db, path);
    expect(actual.length).toBe(offset + bytes.length);
    expect([...actual.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect(actual.subarray(3, offset).every((byte) => byte === 0)).toBe(true);
    expect([...actual.subarray(offset)]).toEqual([7, 8, 9]);
  });

  it.each(chunkCorruptions)("rejects a $name chunk layout before sparse extension", (kind) => {
    const db = setup();
    const path = realpath(db, "/repo/corrupt.bin");
    const rev = corruptThreeByteFile(db, path, kind);

    expect(() => writeRangeRaw(db, path, new Uint8Array([9]), 5, 42)).toThrow(/EIO/);
    expect(statRaw(db, path)?.size).toBe(3);
    expect(currentRev(db)).toBe(rev);
  });

  it.each(chunkCorruptions)("rejects a $name chunk layout when extending from EOF", (kind) => {
    const db = setup();
    const path = realpath(db, "/repo/corrupt.bin");
    const rev = corruptThreeByteFile(db, path, kind);

    expect(() => writeRangeRaw(db, path, new Uint8Array([8, 9, 10]), 3, 42)).toThrow(/EIO/);
    expect(statRaw(db, path)?.size).toBe(3);
    expect(currentRev(db)).toBe(rev);
  });

  it.each(chunkCorruptions)("rejects a $name chunk layout when a write crosses EOF", (kind) => {
    const db = setup();
    const path = realpath(db, "/repo/corrupt.bin");
    const rev = corruptThreeByteFile(db, path, kind);

    expect(() => writeRangeRaw(db, path, new Uint8Array([8, 9, 10]), 2, 42)).toThrow(/EIO/);
    expect(statRaw(db, path)?.size).toBe(3);
    expect(currentRev(db)).toBe(rev);
  });

  it("treats an empty write as a validated no-op", () => {
    const db = setup();
    writeFileFixture(db, "/repo/empty-write.bin", new Uint8Array([1, 2, 3]));
    const path = realpath(db, "/repo/empty-write.bin");
    const before = statRaw(db, path);

    expect(
      operationStatements(db, () =>
        writeRangeRaw(db, path, new Uint8Array(0), CHUNK_SIZE * 10, 999),
      ),
    ).toBe(1);
    expect(statRaw(db, path)).toEqual(before);
    expectBytes(readFile(db, path), new Uint8Array([1, 2, 3]));
  });

  it("batches payloads below 2 MB and returns at most two boundary chunks", () => {
    const db = setup();
    writeFileFixture(db, "/repo/batched.bin", pattern(CHUNK_SIZE * 2, 1));
    const path = realpath(db, "/repo/batched.bin");
    const payload = pattern(CHUNK_SIZE * 10 + 13, 77);
    const measured = new MeasuringDatabase(db);
    const initialRev = currentRev(db);

    const statements = operationStatements(db, () => writeRangeRaw(measured, path, payload, 3, 55));

    expect(statements).toBe(9);
    expect(measured.maxBlobBindingBytes).toBe(3 * CHUNK_SIZE);
    expect(measured.maxBlobBindingBytes).toBeLessThan(2 * 1024 * 1024);
    expect(measured.maxBlobResultBytes).toBe(CHUNK_SIZE);
    const actual = readFile(db, path);
    expect([...actual.subarray(0, 3)]).toEqual([...pattern(3, 1)]);
    expectBytes(actual.subarray(3), payload);
    expect(currentRev(db)).toBe(initialRev + 1);
  });

  it("has constant statement and result-set cost as the existing file grows 10x", () => {
    const measure = (chunks: number): { statements: number; maxResult: number } => {
      const db = setup();
      const before = pattern(chunks * CHUNK_SIZE, chunks);
      writeFileFixture(db, "/repo/scaled.bin", before);
      const path = realpath(db, "/repo/scaled.bin");
      const measured = new MeasuringDatabase(db);
      const replacement = new Uint8Array([211, 212]);
      const offset = before.length - 7;
      const expected = before.slice();
      expected.set(replacement, offset);
      const statements = operationStatements(db, () =>
        writeRangeRaw(measured, path, replacement, offset, 99),
      );
      expectBytes(readFile(db, path), expected);
      return { statements, maxResult: measured.maxBlobResultBytes };
    };

    const small = measure(4);
    const large = measure(40);
    expect(large.statements).toBe(small.statements);
    expect(large.statements).toBe(5);
    expect(large.maxResult).toBe(small.maxResult);
    expect(large.maxResult).toBe(CHUNK_SIZE);
  });
});

describe("truncateRaw", () => {
  it("shrinks a boundary chunk, extends sparsely, preserves mode, and bumps once per call", () => {
    const db = setup();
    const before = pattern(CHUNK_SIZE * 3 + 29, 4);
    writeFileFixture(db, "/repo/truncate.bin", before, {
      mode: 0o710,
      contentId: pattern(20, 8),
    });
    const path = realpath(db, "/repo/truncate.bin");
    const shrinkTo = CHUNK_SIZE + 17;
    const initialRev = currentRev(db);

    const shrinkStatements = operationStatements(db, () => truncateRaw(db, path, shrinkTo, 101));
    expect(shrinkStatements).toBeLessThan(1_000);
    expectBytes(readFile(db, path), before.subarray(0, shrinkTo));
    expect(statRaw(db, path)).toMatchObject({
      mode: S_IFREG | 0o710,
      size: shrinkTo,
      mtime: 101,
      rev: initialRev + 1,
      contentId: null,
    });

    const extendTo = CHUNK_SIZE * 5 + 9;
    const extendStatements = operationStatements(db, () => truncateRaw(db, path, extendTo, 102));
    expect(extendStatements).toBeLessThan(1_000);
    const extended = readFile(db, path);
    expectBytes(extended.subarray(0, shrinkTo), before.subarray(0, shrinkTo));
    expect(extended.subarray(shrinkTo).every((byte) => byte === 0)).toBe(true);
    expect(currentRev(db)).toBe(initialRev + 2);
    expect(statRaw(db, path)).toMatchObject({
      mode: S_IFREG | 0o710,
      size: extendTo,
      mtime: 102,
      rev: initialRev + 2,
      contentId: null,
    });
  });

  it.each(chunkCorruptions)("rejects a $name chunk layout before growing a file", (kind) => {
    const db = setup();
    const path = realpath(db, "/repo/corrupt.bin");
    const rev = corruptThreeByteFile(db, path, kind);

    expect(() => truncateRaw(db, path, 5, 42)).toThrow(/EIO/);
    expect(statRaw(db, path)?.size).toBe(3);
    expect(currentRev(db)).toBe(rev);
  });

  it("rejects a REAL chunk index that otherwise matches the aggregate layout", () => {
    const db = setup();
    const path = realpath(db, "/repo/real-index.bin");
    writeFileFixture(db, path, pattern(CHUNK_SIZE * 2 + 3));
    const stat = statRaw(db, path);
    if (stat === null) throw new Error(`fixture missing at ${path}`);
    db.run("UPDATE fs_chunks SET idx = 0.5 WHERE inode = ? AND idx = 1", stat.ino);
    const rev = currentRev(db);

    expect(() => truncateRaw(db, path, stat.size + 1, 42)).toThrow(/EIO/);
    expect(statRaw(db, path)?.size).toBe(stat.size);
    expect(currentRev(db)).toBe(rev);
  });

  it("has constant cost when truncating files whose sizes differ by 10x", () => {
    const measure = (chunks: number): number => {
      const db = setup();
      const before = pattern(chunks * CHUNK_SIZE, chunks);
      writeFileFixture(db, "/repo/scaled.bin", before);
      const path = realpath(db, "/repo/scaled.bin");
      const statements = operationStatements(db, () => truncateRaw(db, path, CHUNK_SIZE, 33));
      expectBytes(readFile(db, path), before.subarray(0, CHUNK_SIZE));
      return statements;
    };

    const small = measure(4);
    const large = measure(40);
    expect(large).toBe(small);
    expect(large).toBe(4);
  });
});

describe("linkRaw and chmodRaw", () => {
  it("shares one inode and updates nlink, permissions, and revision once", () => {
    const db = setup();
    const bytes = pattern(91, 5);
    writeFileFixture(db, "/repo/source.bin", bytes, { mode: 0o640 });
    const source = realpath(db, "/repo/source.bin");
    const alias = realpathNoFollow(db, "/repo/alias.bin");
    const initialRev = currentRev(db);

    const linkStatements = operationStatements(db, () => linkRaw(db, source, alias));
    expect(linkStatements).toBe(3);
    expect(statRaw(db, source)).toMatchObject({ nlink: 2, rev: initialRev + 1 });
    expect(statRaw(db, alias)).toMatchObject({
      ino: statRaw(db, source)?.ino,
      nlink: 2,
      rev: initialRev + 1,
    });
    expectBytes(readFile(db, alias), bytes);

    const chmodStatements = operationStatements(db, () => chmodRaw(db, alias, 0o4751, 404));
    expect(chmodStatements).toBe(2);
    expect(statRaw(db, source)).toMatchObject({
      mode: S_IFREG | 0o4751,
      mtime: 404,
      rev: initialRev + 2,
      nlink: 2,
    });
    expect(currentRev(db)).toBe(initialRev + 2);
  });
});

describe("renameRaw", () => {
  it("moves a non-ASCII subtree over an empty directory with one revision", () => {
    const db = setup();
    writeFiles(db, [
      { path: "/repo/příliš/a.txt", bytes: new Uint8Array([1]) },
      { path: "/repo/příliš/日本語/b.txt", bytes: new Uint8Array([2]) },
      { path: "/repo/cíl", mode: 0o755 },
    ]);
    const oldPath = realpath(db, "/repo/příliš");
    const newPath = realpathNoFollow(db, "/repo/cíl");
    const overwrittenInode = statRaw(db, newPath)?.ino;
    const initialRev = currentRev(db);

    const statements = operationStatements(db, () => renameRaw(db, oldPath, newPath));

    expect(statements).toBe(9);
    expect(statRaw(db, oldPath)).toBeNull();
    expectBytes(readFile(db, realpath(db, "/repo/cíl/a.txt")), new Uint8Array([1]));
    expectBytes(readFile(db, realpath(db, "/repo/cíl/日本語/b.txt")), new Uint8Array([2]));
    expect(
      db.scalar<number>("SELECT count(*) FROM fs_nodes WHERE inode = ?", overwrittenInode),
    ).toBe(0);
    expect(currentRev(db)).toBe(initialRev + 1);
    expect(statRaw(db, newPath)?.rev).toBe(initialRev + 1);
    expect(statRaw(db, realpath(db, "/repo/cíl/日本語/b.txt"))?.rev).toBe(initialRev + 1);
  });

  it("deletes the node and chunks of an overwritten one-link file", () => {
    const db = setup();
    writeFileFixture(db, "/repo/source.bin", new Uint8Array([1, 2, 3]));
    writeFileFixture(db, "/repo/target.bin", pattern(CHUNK_SIZE + 7, 8));
    const source = realpath(db, "/repo/source.bin");
    const target = realpath(db, "/repo/target.bin");
    const overwrittenInode = statRaw(db, target)?.ino;

    renameRaw(db, source, target);

    expectBytes(readFile(db, target), new Uint8Array([1, 2, 3]));
    expect(
      db.scalar<number>("SELECT count(*) FROM fs_nodes WHERE inode = ?", overwrittenInode),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM fs_chunks WHERE inode = ?", overwrittenInode),
    ).toBe(0);
  });

  it("removes an overwritten file's storage but preserves its other hardlink", () => {
    const db = setup();
    writeFileFixture(db, "/repo/source.bin", new Uint8Array([1, 2, 3]));
    writeFileFixture(db, "/repo/target.bin", new Uint8Array([9, 8, 7]));
    const source = realpath(db, "/repo/source.bin");
    const target = realpath(db, "/repo/target.bin");
    const survivor = realpathNoFollow(db, "/repo/survivor.bin");
    linkRaw(db, target, survivor);
    const targetInode = statRaw(db, target)?.ino;
    const initialRev = currentRev(db);

    renameRaw(db, source, target);

    expectBytes(readFile(db, target), new Uint8Array([1, 2, 3]));
    expectBytes(readFile(db, survivor), new Uint8Array([9, 8, 7]));
    expect(statRaw(db, survivor)).toMatchObject({
      ino: targetInode,
      nlink: 1,
      rev: initialRev + 1,
    });
    expect(currentRev(db)).toBe(initialRev + 1);
  });

  it("removes the old name of the same inode and rejects a non-empty target", () => {
    const db = setup();
    writeFileFixture(db, "/repo/source.bin", new Uint8Array([1, 2, 3]));
    const source = realpath(db, "/repo/source.bin");
    const alias = realpathNoFollow(db, "/repo/alias.bin");
    linkRaw(db, source, alias);
    const linkedRev = currentRev(db);

    expect(operationStatements(db, () => renameRaw(db, source, alias))).toBe(4);
    expect(statRaw(db, source)).toBeNull();
    expect(statRaw(db, alias)).toMatchObject({ nlink: 1, rev: linkedRev + 1 });
    expect(currentRev(db)).toBe(linkedRev + 1);

    writeFiles(db, [
      { path: "/repo/source-dir/file.txt", bytes: new Uint8Array([4]) },
      { path: "/repo/target-dir/file.txt", bytes: new Uint8Array([5]) },
    ]);
    const sourceDir = realpath(db, "/repo/source-dir");
    const targetDir = realpath(db, "/repo/target-dir");
    const beforeFailure = currentRev(db);
    expect(() => renameRaw(db, sourceDir, targetDir)).toThrowError(
      "ENOTEMPTY: directory not empty",
    );
    expect(currentRev(db)).toBe(beforeFailure);
    expect(readFile(db, realpath(db, "/repo/target-dir/file.txt"))).toEqual(new Uint8Array([5]));
  });

  it("keeps a constant statement family across a 10x larger subtree", () => {
    const measure = (files: number): number => {
      const db = setup();
      const entries = Array.from({ length: files }, (_, index) => ({
        path: `/repo/source/d${index % 7}/file-${index}.txt`,
        bytes: new Uint8Array([index & 0xff]),
      }));
      writeFiles(db, entries);
      const oldPath = realpath(db, "/repo/source");
      const newPath = realpathNoFollow(db, "/repo/moved");
      const statements = operationStatements(db, () => renameRaw(db, oldPath, newPath));
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM fs_paths WHERE path >= '/repo/moved/' AND path < '/repo/moved0'",
        ),
      ).toBe(files + 7);
      return statements;
    };

    const small = measure(10);
    const large = measure(100);
    expect(large).toBe(small);
    expect(large).toBe(9);
    expect(large).toBeLessThan(1_000);
  });
});
