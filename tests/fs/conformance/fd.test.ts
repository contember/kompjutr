// Ported from cloudflare/computer's provider.fd.test.ts (MIT): 28 of 29
// cases. The discarded case compares private vfs_chunks hashes; the new
// filesystem has no content-addressed chunk hashes to preserve.

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { NodeFsCompat } from "../../../src/fs/compat/node.js";
import { createFilesystemOps } from "../../../src/fs/ops.js";
import { initializeFsSchema } from "../../../src/fs/schema.js";
import { currentRev } from "../../../src/fs/store/meta.js";
import { readFileHandles, readFiles } from "../../../src/fs/store/read.js";
import { removeFiles } from "../../../src/fs/store/remove.js";
import { realpath } from "../../../src/fs/store/resolve.js";
import { discoverFiles, glob, scan } from "../../../src/fs/store/scan.js";
import { discoverFilesContaining } from "../../../src/fs/store/search.js";
import { makeDirectories, writeFiles } from "../../../src/fs/store/write.js";
import type { Filesystem } from "../../../src/fs/types.js";
import { TestDatabase } from "../../helpers/db.js";

const CHUNK_SIZE = 512 * 1024;

function createTestProvider(): NodeFsCompat {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 1_000);
  const ops = createFilesystemOps(db, { now: () => 1_000 });
  const filesystem: Filesystem = {
    ...ops,
    rev: () => currentRev(db),
    realpath: (path) => realpath(db, path),
    scan: (root, options) => scan(db, realpath(db, root), options),
    discoverFiles: (root, pattern, options) => discoverFiles(db, root, pattern, options),
    discoverFilesContaining: (root, pattern, needle, options) =>
      discoverFilesContaining(db, root, pattern, needle, options),
    readFileHandles: (handles, options) => readFileHandles(db, handles, options),
    readFiles: (paths, options) => readFiles(db, paths, options),
    glob: (root, pattern, options) => glob(db, realpath(db, root), pattern, options),
    writeFiles: (entries, options) => writeFiles(db, entries, options),
    makeDirectories: (paths) => makeDirectories(db, paths),
    removeFiles: (paths, options) => removeFiles(db, paths, options),
    withReadScope: (work) => work(),
  };
  return new NodeFsCompat(filesystem);
}

describe("NodeFsCompat — file descriptors", () => {
  it("openSync allocates a positive integer", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    const fd = provider.openSync("/a", "r");
    expect(Number.isInteger(fd)).toBe(true);
    expect(fd).toBeGreaterThan(0);
    provider.closeSync(fd);
  });

  it("openSync('r') on a missing file throws ENOENT", () => {
    const provider = createTestProvider();
    expect(() => provider.openSync("/missing", "r")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("openSync('w') creates a missing file as empty", () => {
    const provider = createTestProvider();
    const fd = provider.openSync("/new", "w");
    expect(provider.existsSync("/new")).toBe(true);
    expect(provider.statSync("/new").size).toBe(0);
    provider.closeSync(fd);
  });

  it("openSync('w') truncates an existing file", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "before");
    const fd = provider.openSync("/a", "w");
    expect(provider.statSync("/a").size).toBe(0);
    provider.closeSync(fd);
  });

  it("openSync('a') opens for append without truncating", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    const fd = provider.openSync("/a", "a");
    expect(provider.statSync("/a").size).toBe(5);
    provider.closeSync(fd);
  });

  it("closeSync on an unknown fd throws EBADF", () => {
    const provider = createTestProvider();
    expect(() => provider.closeSync(9999)).toThrowError(expect.objectContaining({ code: "EBADF" }));
  });

  it("fstatSync mirrors statSync for the fd's path", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello", { mode: 0o644 });
    const fd = provider.openSync("/a", "r");
    const stat = provider.fstatSync(fd);
    expect(stat.size).toBe(5);
    expect(stat.isFile()).toBe(true);
    provider.closeSync(fd);
  });
});

describe("NodeFsCompat — readSync", () => {
  it("reads from the fd's position when position is null", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello workspace");
    const fd = provider.openSync("/a", "r");
    const buffer = Buffer.alloc(5);
    expect(provider.readSync(fd, buffer, 0, 5, null)).toBe(5);
    expect(buffer.toString()).toBe("hello");
    expect(provider.readSync(fd, buffer, 0, 5, null)).toBe(5);
    expect(buffer.toString()).toBe(" work");
    provider.closeSync(fd);
  });

  it("reads at an explicit position without moving the fd", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello workspace");
    const fd = provider.openSync("/a", "r");
    const buffer = Buffer.alloc(5);
    expect(provider.readSync(fd, buffer, 0, 5, 6)).toBe(5);
    expect(buffer.toString()).toBe("works");
    provider.readSync(fd, buffer, 0, 5, null);
    expect(buffer.toString()).toBe("hello");
    provider.closeSync(fd);
  });

  it("returns 0 when reading past EOF", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "tiny");
    const fd = provider.openSync("/a", "r");
    expect(provider.readSync(fd, Buffer.alloc(10), 0, 10, 100)).toBe(0);
    provider.closeSync(fd);
  });

  it("respects the buffer offset", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "abcde");
    const fd = provider.openSync("/a", "r");
    const buffer = Buffer.alloc(10).fill(0x2e);
    expect(provider.readSync(fd, buffer, 3, 5, 0)).toBe(5);
    expect(buffer.toString()).toBe("...abcde..");
    provider.closeSync(fd);
  });

  it("reads across a chunk boundary", () => {
    const provider = createTestProvider();
    const bytes = new Uint8Array(CHUNK_SIZE + 100);
    bytes.fill(0x41);
    bytes.fill(0x42, CHUNK_SIZE);
    provider.writeFileSync("/big", bytes);
    const fd = provider.openSync("/big", "r");
    const buffer = Buffer.alloc(200);
    expect(provider.readSync(fd, buffer, 0, 200, CHUNK_SIZE - 100)).toBe(200);
    expect([...buffer.subarray(0, 100)].every((value) => value === 0x41)).toBe(true);
    expect([...buffer.subarray(100)].every((value) => value === 0x42)).toBe(true);
    provider.closeSync(fd);
  });
});

describe("NodeFsCompat — direct range methods", () => {
  it("exposes direct create, write range, and truncate methods", () => {
    const provider = createTestProvider();
    provider.createFileSync("/direct.txt", { mode: 0o600 });
    expect(provider.statSync("/direct.txt").mode & 0o777).toBe(0o600);
    expect(provider.writeRangeSync("/direct.txt", Buffer.from("abcdef"), 0)).toBe(6);
    expect(provider.writeRangeSync("/direct.txt", Buffer.from("Z"), 3)).toBe(1);
    expect(provider.readFileSync("/direct.txt", "utf8")).toBe("abcZef");
    provider.truncateFileSync("/direct.txt", 4);
    expect(provider.readFileSync("/direct.txt", "utf8")).toBe("abcZ");
  });
});

describe("NodeFsCompat — writeSync", () => {
  it("writes at position 0 and updates content", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    const fd = provider.openSync("/a", "r+");
    expect(provider.writeSync(fd, Buffer.from("HELLO"), 0, 5, 0)).toBe(5);
    provider.closeSync(fd);
    expect(provider.readFileSync("/a", "utf8")).toBe("HELLO");
  });

  it("writes at a non-zero offset", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello world");
    const fd = provider.openSync("/a", "r+");
    provider.writeSync(fd, Buffer.from("WORLD"), 0, 5, 6);
    provider.closeSync(fd);
    expect(provider.readFileSync("/a", "utf8")).toBe("hello WORLD");
  });

  it("extends the file when writing at EOF", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hi");
    const fd = provider.openSync("/a", "r+");
    provider.writeSync(fd, Buffer.from("bye"), 0, 3, 2);
    provider.closeSync(fd);
    expect(provider.readFileSync("/a", "utf8")).toBe("hibye");
  });

  it("zero-fills a gap when writing past EOF", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "ab");
    const fd = provider.openSync("/a", "r+");
    provider.writeSync(fd, Buffer.from("z"), 0, 1, 5);
    provider.closeSync(fd);
    const output = provider.readFileSync("/a");
    if (typeof output === "string") throw new Error("readFileSync returned text without encoding");
    expect([...output]).toEqual([0x61, 0x62, 0, 0, 0, 0x7a]);
  });

  it("advances the fd position when position is null", () => {
    const provider = createTestProvider();
    const fd = provider.openSync("/a", "w");
    provider.writeSync(fd, Buffer.from("abc"), 0, 3, null);
    provider.writeSync(fd, Buffer.from("def"), 0, 3, null);
    provider.closeSync(fd);
    expect(provider.readFileSync("/a", "utf8")).toBe("abcdef");
  });

  it("writes across a chunk boundary", () => {
    const provider = createTestProvider();
    const bytes = new Uint8Array(CHUNK_SIZE + 100);
    bytes.fill(0x41);
    bytes.fill(0x42, CHUNK_SIZE);
    provider.writeFileSync("/big", bytes);
    const fd = provider.openSync("/big", "r+");
    provider.writeSync(fd, Buffer.alloc(200, 0x5a), 0, 200, CHUNK_SIZE - 100);
    provider.closeSync(fd);
    const output = provider.readFileSync("/big");
    if (typeof output === "string") throw new Error("readFileSync returned text without encoding");
    expect(output.byteLength).toBe(CHUNK_SIZE + 100);
    expect(output[CHUNK_SIZE - 101]).toBe(0x41);
    expect(output[CHUNK_SIZE - 100]).toBe(0x5a);
    expect(output[CHUNK_SIZE + 99]).toBe(0x5a);
  });

  it("append mode writes at the current EOF", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    const fd = provider.openSync("/a", "a");
    provider.writeSync(fd, Buffer.from(" world"), 0, 6, 0);
    provider.closeSync(fd);
    expect(provider.readFileSync("/a", "utf8")).toBe("hello world");
  });
});

describe("NodeFsCompat — truncateSync and ftruncateSync", () => {
  it("truncateSync shrinks a file", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello world");
    provider.truncateSync("/a", 5);
    expect(provider.readFileSync("/a", "utf8")).toBe("hello");
  });

  it("truncateSync grows a file with zero fill", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "abc");
    provider.truncateSync("/a", 6);
    const output = provider.readFileSync("/a");
    if (typeof output === "string") throw new Error("readFileSync returned text without encoding");
    expect([...output]).toEqual([0x61, 0x62, 0x63, 0, 0, 0]);
  });

  it("truncateSync to zero leaves an empty file", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    provider.truncateSync("/a", 0);
    expect(provider.statSync("/a").size).toBe(0);
  });

  it("truncateSync at the same size preserves bytes", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    provider.truncateSync("/a", 5);
    expect(provider.readFileSync("/a", "utf8")).toBe("hello");
  });

  it("truncateSync shrinks across a chunk boundary", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/big", new Uint8Array(CHUNK_SIZE + 100).fill(0x41));
    provider.truncateSync("/big", CHUNK_SIZE - 10);
    expect(provider.statSync("/big").size).toBe(CHUNK_SIZE - 10);
  });

  it("truncateSync grows across a chunk boundary", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "ab");
    provider.truncateSync("/a", CHUNK_SIZE + 100);
    const output = provider.readFileSync("/a");
    if (typeof output === "string") throw new Error("readFileSync returned text without encoding");
    expect(output.byteLength).toBe(CHUNK_SIZE + 100);
    expect(output[0]).toBe(0x61);
    expect(output[1]).toBe(0x62);
    expect(output[2]).toBe(0);
    expect(output[CHUNK_SIZE + 99]).toBe(0);
  });

  it("truncateSync on a missing file throws ENOENT", () => {
    const provider = createTestProvider();
    expect(() => provider.truncateSync("/missing", 0)).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("ftruncateSync mirrors truncateSync through an fd", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello world");
    const fd = provider.openSync("/a", "r+");
    provider.ftruncateSync(fd, 5);
    provider.closeSync(fd);
    expect(provider.readFileSync("/a", "utf8")).toBe("hello");
  });
});
