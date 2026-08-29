import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import { CHUNK_SIZE } from "../../src/fs/schema.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

function open(now = 2_000) {
  const db = new TestDatabase();
  const fs = createFilesystem(db, { now: () => now });
  return { db, fs };
}

describe("Filesystem.touchFiles", () => {
  it("updates only metadata for a large file", () => {
    const { db, fs } = open();
    const bytes = new Uint8Array(CHUNK_SIZE * 5 + 17).fill(7);
    const contentId = new Uint8Array([4, 5, 6]);
    fs.writeFiles([{ path: "/large", bytes, mode: 0o751, mtime: 1_000, contentId }]);
    const before = fs.stat("/large");
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    fs.touchFiles(["/large"], { mtime: 3_000 });

    const after = fs.stat("/large");
    expect(after).toMatchObject({
      ino: before?.ino,
      type: "file",
      mode: 0o100751,
      size: bytes.length,
      mtime: 3_000,
      nlink: 1,
      contentId,
    });
    expect(after?.rev).toBe((before?.rev ?? 0) + 1);
    expect([...db.storage.histogram.keys()].some((query) => query.includes("fs_chunks"))).toBe(
      false,
    );
  });

  it("touches directories and follows final symlinks", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/directory", mtime: 100 },
      { path: "/target", bytes: ENCODER.encode("x"), mtime: 200 },
      { path: "/link", target: "/target", mtime: 300 },
    ]);

    fs.touchFiles(["/directory", "/link"], { mtime: 4_000 });

    expect(fs.stat("/directory")?.mtime).toBe(4_000);
    expect(fs.statTarget("/link")?.mtime).toBe(4_000);
    expect(fs.stat("/link")?.mtime).toBe(300);
  });

  it("creates the target of a dangling symlink as an empty file", () => {
    const { fs } = open();
    fs.symlink("/created", "/dangling");

    fs.touchFiles(["/dangling"], { mtime: 5_000 });

    expect(fs.stat("/dangling")?.type).toBe("symlink");
    expect(fs.stat("/created")).toMatchObject({
      type: "file",
      mode: 0o100644,
      size: 0,
      mtime: 5_000,
    });
  });

  it("updates a hard-linked inode once and bumps one revision", () => {
    const { fs } = open();
    fs.writeFile("/a", ENCODER.encode("x"));
    fs.link("/a", "/b");
    const before = fs.rev();

    fs.touchFiles(["/a", "/b"], { mtime: 6_000 });

    expect(fs.rev()).toBe(before + 1);
    expect(fs.stat("/a")).toMatchObject({ mtime: 6_000, nlink: 2 });
    expect(fs.stat("/b")?.rev).toBe(fs.stat("/a")?.rev);
  });

  it("preflights a mixed set before changing anything", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/ok", bytes: ENCODER.encode("x"), mtime: 1_000 }]);
    const before = fs.stat("/ok");

    expect(() => fs.touchFiles(["/ok", "/missing/child"], { mtime: 7_000 })).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );

    expect(fs.stat("/ok")).toEqual(before);
    expect(fs.stat("/missing/child")).toBeNull();
  });

  it("updates 5,000 paths in a bounded number of statements", () => {
    const { db, fs } = open();
    const paths = Array.from(
      { length: 5_000 },
      (_, index) => `/wide/f${String(index).padStart(5, "0")}`,
    );
    fs.writeFiles(paths.map((path) => ({ path, bytes: new Uint8Array(0) })));
    db.storage.resetCounters();

    fs.touchFiles(paths, { mtime: 8_000 });

    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(fs.stat(paths[4_999] ?? "/missing")?.mtime).toBe(8_000);
  });
});
