import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import { CHUNK_SIZE } from "../../src/fs/schema.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function open() {
  const db = new TestDatabase();
  const fs = createFilesystem(db, { now: () => 2_000 });
  return { db, fs };
}

describe("Filesystem.copyFiles", () => {
  it("copies files and symlinks without bringing content through JavaScript", () => {
    const { db, fs } = open();
    const contentId = new Uint8Array([1, 2, 3]);
    fs.writeFiles([
      {
        path: "/source/file",
        bytes: ENCODER.encode("content"),
        mode: 0o751,
        mtime: 1_234,
        contentId,
      },
      { path: "/source/link", target: "file" },
    ]);
    db.storage.histogram = new Map();

    const batch = fs.copyFiles([
      { source: "/source/file", destination: "/copy/file" },
      { source: "/source/link", destination: "/copy/link" },
    ]);

    expect(batch).toEqual({ copied: 2, remaining: [] });
    expect(DECODER.decode(fs.readFile("/copy/file"))).toBe("content");
    expect(fs.stat("/copy/file")).toMatchObject({
      type: "file",
      mode: 0o100751,
      mtime: 1_234,
    });
    expect(fs.stat("/copy/file")?.contentId).toEqual(contentId);
    expect(fs.stat("/copy/link")).toMatchObject({ type: "symlink", target: "file" });
    expect(
      [...db.storage.histogram.keys()].some((query) => query.startsWith("SELECT chunks.bytes")),
    ).toBe(false);
  });

  it("returns a deferred suffix at the byte budget", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/a", bytes: new Uint8Array(4) },
      { path: "/b", bytes: new Uint8Array(4) },
      { path: "/c", bytes: new Uint8Array(4) },
    ]);
    const entries = [
      { source: "/a", destination: "/out/a" },
      { source: "/b", destination: "/out/b" },
      { source: "/c", destination: "/out/c" },
    ];
    const before = fs.rev();

    const first = fs.copyFiles(entries, { budget: 6 });
    const second = fs.copyFiles(first.remaining, { budget: 6 });
    const third = fs.copyFiles(second.remaining, { budget: 6 });

    expect([first.copied, second.copied, third.copied]).toEqual([1, 1, 1]);
    expect(third.remaining).toEqual([]);
    expect(fs.rev()).toBe(before + 3);
  });

  it("makes hard-linked source names independent at the destination", () => {
    const { fs } = open();
    fs.writeFile("/source", ENCODER.encode("original"));
    fs.link("/source", "/source-link");

    fs.copyFiles([
      { source: "/source", destination: "/a" },
      { source: "/source-link", destination: "/b" },
    ]);
    fs.writeFile("/a", ENCODER.encode("changed"));

    expect(fs.stat("/a")?.ino).not.toBe(fs.stat("/b")?.ino);
    expect(DECODER.decode(fs.readFile("/b"))).toBe("original");
    expect(DECODER.decode(fs.readFile("/source"))).toBe("original");
  });

  it("atomically replaces a destination and leaves source storage intact", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/source", bytes: new Uint8Array(CHUNK_SIZE + 3).fill(7) },
      { path: "/destination", bytes: new Uint8Array(CHUNK_SIZE * 2).fill(9) },
    ]);
    const before = fs.rev();

    fs.copyFiles([{ source: "/source", destination: "/destination" }]);

    expect(fs.rev()).toBe(before + 1);
    expect(fs.readFile("/destination")).toEqual(fs.readFile("/source"));
  });

  it("rejects copying a directory inside itself before mutation", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/source/file", bytes: ENCODER.encode("x") }]);
    const before = fs.rev();

    expect(() => fs.copyFiles([{ source: "/source", destination: "/source/copy" }])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(fs.rev()).toBe(before);
    expect(fs.stat("/source/copy")).toBeNull();
  });

  it("rejects corrupt source chunks before mutating", () => {
    const { db, fs } = open();
    fs.writeFile("/source", ENCODER.encode("valid"));
    const inode = fs.stat("/source")?.ino;
    if (inode === undefined) throw new Error("source inode missing");
    db.run("UPDATE fs_nodes SET size = 99 WHERE inode = ?", inode);
    const before = fs.rev();

    expect(() => fs.copyFiles([{ source: "/source", destination: "/copy" }])).toThrow(
      "invalid metadata",
    );
    expect(fs.rev()).toBe(before);
    expect(fs.stat("/copy")).toBeNull();
  });
});
