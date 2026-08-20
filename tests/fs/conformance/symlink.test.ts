// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../src/fs/ops.js";
import { initializeFsSchema } from "../../../src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";
import { conformance } from "./harness.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function setup(now = 0) {
  const db = new TestDatabase();
  initializeFsSchema(db, () => now);
  const ops = createFilesystemOps(db, { now: () => now });
  return { db, ops, api: conformance(ops) };
}

describe("symlink and readlink", () => {
  it("creates a link with the requested target", () => {
    const { db, ops } = setup(5000);
    const before = db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'") ?? 0;
    ops.symlink("/target", "/link");
    expect(ops.readlink("/link")).toBe("/target");
    expect(ops.stat("/link")).toMatchObject({ mtime: 5000, rev: before + 1 });
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(before + 1);
  });

  it("rejects an existing path", () => {
    const { ops } = setup();
    ops.writeFile("/a", bytes("x"));
    expect(() => ops.symlink("/target", "/a")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });

  it("rejects a missing parent", () => {
    const { ops } = setup();
    expect(() => ops.symlink("/t", "/no/such/link")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("creates a nested symlink", () => {
    const { ops } = setup();
    ops.mkdir("/a/b", { recursive: true });
    ops.symlink("/t", "/a/b/link");
    expect(ops.readlink("/a/b/link")).toBe("/t");
  });

  it("readlink rejects missing and non-link paths", () => {
    const { ops } = setup();
    ops.writeFile("/file", bytes("x"));
    expect(() => ops.readlink("/missing")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => ops.readlink("/file")).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("follows links by stat and preserves them by lstat", () => {
    const { ops, api } = setup();
    ops.writeFile("/target", bytes("content"));
    ops.symlink("/target", "/link");
    expect(api.stat("/link").isFile).toBe(true);
    expect(api.lstat("/link").isSymbolicLink).toBe(true);
  });

  it("follows a chain of links", () => {
    const { ops } = setup();
    ops.writeFile("/target", bytes("content"));
    ops.symlink("/target", "/a");
    ops.symlink("/a", "/b");
    ops.symlink("/b", "/c");
    expect(ops.statTarget("/c")?.ino).toBe(ops.statTarget("/target")?.ino);
  });

  it("distinguishes dangling stat from lstat", () => {
    const { ops } = setup();
    ops.symlink("/missing", "/dangling");
    expect(ops.statTarget("/dangling")).toBeNull();
    expect(ops.stat("/dangling")?.type).toBe("symlink");
  });

  it("resolves a bare relative target from the link parent", () => {
    const { ops } = setup();
    ops.mkdir("/dir");
    ops.writeFile("/dir/target", bytes("hello"));
    ops.symlink("target", "/dir/link");
    expect(ops.statTarget("/dir/link")?.ino).toBe(ops.statTarget("/dir/target")?.ino);
  });

  it("resolves dot and parent segments in relative targets", () => {
    const { ops } = setup();
    ops.mkdir("/dir/sub", { recursive: true });
    ops.writeFile("/dir/target", bytes("hello"));
    ops.symlink("./target", "/dir/dot");
    ops.symlink("../target", "/dir/sub/parent");
    expect(ops.statTarget("/dir/dot")?.ino).toBe(ops.statTarget("/dir/target")?.ino);
    expect(ops.statTarget("/dir/sub/parent")?.ino).toBe(ops.statTarget("/dir/target")?.ino);
  });

  it("clamps leading parent segments at root", () => {
    const { ops } = setup();
    ops.writeFile("/target", bytes("hello"));
    ops.symlink("../../target", "/link");
    expect(ops.statTarget("/link")?.ino).toBe(ops.statTarget("/target")?.ino);
  });

  it("resolves path segments after a relative link", () => {
    const { ops } = setup();
    ops.mkdir("/dir/real", { recursive: true });
    ops.writeFile("/dir/real/file", bytes("hello"));
    ops.symlink("real", "/dir/link");
    expect(ops.statTarget("/dir/link/file")?.ino).toBe(ops.statTarget("/dir/real/file")?.ino);
  });

  it("reports ENOENT for a dangling relative target", () => {
    const { ops, api } = setup();
    ops.symlink("missing", "/dangling");
    expect(() => api.stat("/dangling")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });

  it.each(["file/", "file//", "file/../target"])(
    "does not traverse past a file in target %s",
    (target) => {
      const { ops } = setup();
      ops.writeFile("/file", bytes("file"));
      ops.writeFile("/target", bytes("target"));
      ops.symlink(target, "/link");
      expect(ops.statTarget("/link")).toBeNull();
      expect(() => ops.readFile("/link")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
      expect(() => ops.readRange("/link", 0, 1)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    },
  );

  it("throws ELOOP on a cycle", () => {
    const { ops } = setup();
    ops.symlink("/b", "/a");
    ops.symlink("/a", "/b");
    expect(() => ops.statTarget("/a")).toThrowError(expect.objectContaining({ code: "ELOOP" }));
  });
});

// The old-schema revision case is asserted through public Stat.rev. The one
// discarded inherited case is the removed read-only mount subsystem.
