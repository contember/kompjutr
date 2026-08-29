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

describe("Filesystem.writeFileStream", () => {
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

  it("rolls back an overwrite when the source throws", () => {
    const { fs } = open();
    fs.writeFile("/file", ENCODER.encode("old"));
    const before = fs.rev();
    const failing = (function* (): Generator<Uint8Array, void, undefined> {
      yield ENCODER.encode("partial");
      throw new Error("upstream failed");
    })();

    expect(() => fs.writeFileStream("/file", failing)).toThrow("upstream failed");

    expect(DECODER.decode(fs.readFile("/file"))).toBe("old");
    expect(fs.rev()).toBe(before);
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
