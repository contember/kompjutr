// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { CHUNK_SIZE, initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";
import { conformance } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function setup() {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 0);
  const ops = createFilesystemOps(db, { now: () => 0 });
  return { ops, api: conformance(ops) };
}

describe("readFile", () => {
  it("returns all file bytes", () => {
    const { ops, api } = setup();
    ops.writeFile("/a.txt", encoder.encode("hello workspace"));
    expect(decoder.decode(api.readBack("/a.txt"))).toBe("hello workspace");
  });

  it("returns bytes that decode as UTF-8", () => {
    const { ops, api } = setup();
    ops.writeFile("/a.txt", encoder.encode("příliš žluťoučký"));
    expect(decoder.decode(api.readBack("/a.txt"))).toBe("příliš žluťoučký");
  });

  it("preserves arbitrary binary bytes", () => {
    const { ops, api } = setup();
    const expected = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    ops.writeFile("/a.bin", expected);
    expect(api.readBack("/a.bin")).toEqual(expected);
  });

  it("reads a requested range across chunk boundaries", () => {
    const { ops } = setup();
    const value = new Uint8Array(CHUNK_SIZE + 8);
    value.fill(0x41, 0, CHUNK_SIZE);
    value.fill(0x42, CHUNK_SIZE);
    ops.writeFile("/big", value);
    expect(Array.from(ops.readRange("/big", CHUNK_SIZE - 4, 8))).toEqual([
      0x41, 0x41, 0x41, 0x41, 0x42, 0x42, 0x42, 0x42,
    ]);
  });

  it("clamps ranges at EOF", () => {
    const { ops } = setup();
    ops.writeFile("/a.txt", encoder.encode("hello"));
    expect(decoder.decode(ops.readRange("/a.txt", 1, 3))).toBe("ell");
    expect(decoder.decode(ops.readRange("/a.txt", 4, 10))).toBe("o");
    expect(ops.readRange("/a.txt", 5, 10)).toHaveLength(0);
    expect(ops.readRange("/a.txt", 0, 0)).toHaveLength(0);
  });

  it("rejects invalid byte ranges", () => {
    const { ops } = setup();
    ops.writeFile("/a.txt", encoder.encode("hello"));
    expect(() => ops.readRange("/a.txt", -1, 1)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => ops.readRange("/a.txt", 0, Number.MAX_SAFE_INTEGER + 1)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("returns empty bytes for an empty file", () => {
    const { ops } = setup();
    ops.writeFile("/empty", new Uint8Array(0));
    expect(ops.readFile("/empty")).toHaveLength(0);
  });

  it("does not mutate revision metadata when reading", () => {
    const { ops } = setup();
    ops.writeFile("/x.txt", encoder.encode("hello"));
    const before = ops.stat("/x.txt")?.rev;
    ops.readFile("/x.txt");
    ops.readRange("/x.txt", 0, 2);
    expect(ops.stat("/x.txt")?.rev).toBe(before);
  });

  it("rejects ENOENT for missing paths", () => {
    const { ops } = setup();
    expect(() => ops.readFile("/missing")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => ops.readFile("/no/such/file")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("rejects EISDIR for directories", () => {
    const { ops } = setup();
    ops.mkdir("/d");
    expect(() => ops.readFile("/d")).toThrowError(expect.objectContaining({ code: "EISDIR" }));
  });
});

// Discarded inherited cases: stream chunk shape and snapshot-on-open depend on
// DOFS's async stream/content-addressed blobs; pending buffers and blob GC are
// intentionally outside the standalone runtime.
