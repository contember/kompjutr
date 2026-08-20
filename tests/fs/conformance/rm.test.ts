// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../src/fs/ops.js";
import { initializeFsSchema } from "../../../src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function setup() {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 0);
  return { db, ops: createFilesystemOps(db, { now: () => 0 }) };
}

describe("rm", () => {
  it("removes a single file", () => {
    const { ops } = setup();
    ops.writeFile("/a", bytes("hi"));
    ops.rm("/a", { force: false });
    expect(ops.stat("/a")).toBeNull();
    expect(ops.readdir("/")).toEqual([]);
  });

  it("bumps revision once per call", () => {
    const { db, ops } = setup();
    ops.writeFile("/a", bytes("hi"));
    const before = db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'") ?? 0;
    ops.rm("/a", { force: false });
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(before + 1);
  });

  it("removes through an intermediate symlink at the real path", () => {
    const { ops } = setup();
    ops.mkdir("/real");
    ops.writeFile("/real/file", bytes("x"));
    ops.symlink("/real", "/link");
    ops.rm("/link/file", { force: false });
    expect(ops.stat("/real/file")).toBeNull();
    expect(ops.stat("/link")?.type).toBe("symlink");
  });

  it("removes a symlink without removing its target", () => {
    const { ops } = setup();
    ops.writeFile("/target", bytes("still here"));
    ops.symlink("/target", "/link");
    ops.rm("/link", { force: false });
    expect(ops.stat("/link")).toBeNull();
    expect(ops.statTarget("/target")).not.toBeNull();
  });

  it("recursive removal does not follow symlinks out of the tree", () => {
    const { ops } = setup();
    ops.writeFile("/outside", bytes("still here"));
    ops.mkdir("/d");
    ops.symlink("/outside", "/d/link");
    ops.rm("/d", { recursive: true, force: false });
    expect(ops.stat("/d")).toBeNull();
    expect(ops.statTarget("/outside")).not.toBeNull();
  });

  it("removes a dangling symlink", () => {
    const { ops } = setup();
    ops.symlink("/missing", "/dangling");
    ops.rm("/dangling", { force: false });
    expect(ops.stat("/dangling")).toBeNull();
  });

  it("honors force for a missing path", () => {
    const { ops } = setup();
    expect(() => ops.rm("/missing", { force: false })).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => ops.rm("/missing", { force: true })).not.toThrow();
  });

  it("rejects root even with recursive and force", () => {
    const { ops } = setup();
    for (const options of [
      { force: false },
      { recursive: true, force: false },
      { recursive: true, force: true },
    ]) {
      expect(() => ops.rm("/", options)).toThrowError(expect.objectContaining({ code: "EPERM" }));
    }
  });

  it("removes an empty directory without recursive", () => {
    const { ops } = setup();
    ops.mkdir("/d");
    ops.rm("/d", { force: false });
    expect(ops.stat("/d")).toBeNull();
  });

  it("rejects a non-empty directory without recursive", () => {
    const { ops } = setup();
    ops.mkdir("/d");
    ops.writeFile("/d/a", bytes("x"));
    expect(() => ops.rm("/d", { force: false })).toThrowError(
      expect.objectContaining({ code: "ENOTEMPTY" }),
    );
  });

  it("recursively removes a directory tree", () => {
    const { ops } = setup();
    ops.mkdir("/d/e/f", { recursive: true });
    ops.writeFile("/d/a", bytes("x"));
    ops.writeFile("/d/e/b", bytes("y"));
    ops.writeFile("/d/e/f/c", bytes("z"));
    ops.rm("/d", { recursive: true, force: false });
    for (const path of ["/d", "/d/a", "/d/e/b", "/d/e/f/c"]) {
      expect(ops.stat(path)).toBeNull();
    }
  });

  it("recursive removes a directory symlink without its target", () => {
    const { ops } = setup();
    ops.mkdir("/target/sub", { recursive: true });
    ops.writeFile("/target/sub/file", bytes("content"));
    ops.symlink("/target", "/link");
    ops.rm("/link", { recursive: true, force: false });
    expect(ops.stat("/link")).toBeNull();
    expect(new TextDecoder().decode(ops.readFile("/target/sub/file"))).toBe("content");
  });

  it("recursive still bumps revision only once", () => {
    const { db, ops } = setup();
    ops.mkdir("/d");
    ops.writeFile("/d/a", bytes("x"));
    ops.writeFile("/d/b", bytes("y"));
    const before = db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'") ?? 0;
    ops.rm("/d", { recursive: true, force: false });
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(before + 1);
  });

  it("recursive removal cleans up file chunks", () => {
    const { db, ops } = setup();
    ops.mkdir("/d");
    ops.writeFile("/d/a", bytes("first"));
    ops.writeFile("/d/b", bytes("second"));
    ops.rm("/d", { recursive: true, force: false });
    expect(db.scalar<number>("SELECT count(*) FROM fs_chunks")).toBe(0);
  });

  it("accepts explicit false options and missing intermediate force", () => {
    const { ops } = setup();
    expect(() => ops.rm("/no/such/path", { force: true })).not.toThrow();
    ops.writeFile("/a", bytes("x"));
    ops.rm("/a", { recursive: false, force: false });
    expect(ops.stat("/a")).toBeNull();
  });

  it("provides unlink and rmdir type checks", () => {
    const { ops } = setup();
    ops.writeFile("/file", bytes("x"));
    ops.mkdir("/dir");
    expect(() => ops.unlink("/dir")).toThrowError(expect.objectContaining({ code: "EISDIR" }));
    expect(() => ops.rmdir("/file")).toThrowError(expect.objectContaining({ code: "ENOTDIR" }));
    ops.unlink("/file");
    ops.rmdir("/dir");
    expect(ops.exists("/file")).toBe(false);
    expect(ops.exists("/dir")).toBe(false);
  });
});

// Discarded inherited cases: six tombstone/blob-GC assertions exercise the
// removed sync protocol and content-addressed blob store.
