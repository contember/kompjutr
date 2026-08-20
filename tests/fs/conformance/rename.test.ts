import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../src/fs/ops.js";
import { initializeFsSchema } from "../../../src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

function setup() {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 0);
  return { db, fs: createFilesystemOps(db, { now: () => 0 }) };
}

describe("rename", () => {
  it("moves a file without changing its inode or bytes", () => {
    const { fs } = setup();
    fs.writeFile("/old", bytes("content"));
    const before = fs.stat("/old");
    fs.rename("/old", "/new");
    expect(fs.stat("/old")).toBeNull();
    expect(fs.stat("/new")?.ino).toBe(before?.ino);
    expect(text(fs.readFile("/new"))).toBe("content");
  });

  it("moves every descendant of a directory", () => {
    const { fs } = setup();
    fs.mkdir("/old/deep", { recursive: true });
    fs.writeFile("/old/a", bytes("a"));
    fs.writeFile("/old/deep/b", bytes("b"));
    fs.rename("/old", "/new");
    expect(fs.stat("/old")).toBeNull();
    expect(text(fs.readFile("/new/a"))).toBe("a");
    expect(text(fs.readFile("/new/deep/b"))).toBe("b");
  });

  it("resolves both parents through symlinks", () => {
    const { fs } = setup();
    fs.mkdir("/left");
    fs.mkdir("/right");
    fs.writeFile("/left/file", bytes("x"));
    fs.symlink("/left", "/from");
    fs.symlink("/right", "/to");
    fs.rename("/from/file", "/to/file");
    expect(fs.stat("/left/file")).toBeNull();
    expect(text(fs.readFile("/right/file"))).toBe("x");
  });

  it("overwrites files and empty directories compatibly", () => {
    const { fs } = setup();
    fs.writeFile("/source", bytes("new"));
    fs.writeFile("/target", bytes("old"));
    fs.rename("/source", "/target");
    expect(text(fs.readFile("/target"))).toBe("new");

    fs.mkdir("/source-dir");
    fs.mkdir("/target-dir");
    fs.rename("/source-dir", "/target-dir");
    expect(fs.stat("/target-dir")?.type).toBe("dir");
  });

  it("rejects incompatible and non-empty overwrites", () => {
    const { fs } = setup();
    fs.writeFile("/file", bytes("x"));
    fs.mkdir("/dir");
    expect(() => fs.rename("/file", "/dir")).toThrowError(
      expect.objectContaining({ code: "EISDIR" }),
    );
    expect(() => fs.rename("/dir", "/file")).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
    fs.mkdir("/other/child", { recursive: true });
    expect(() => fs.rename("/dir", "/other")).toThrowError(
      expect.objectContaining({ code: "ENOTEMPTY" }),
    );
  });

  it("rejects missing paths, missing parents, root, and self moves", () => {
    const { fs } = setup();
    fs.mkdir("/dir");
    expect(() => fs.rename("/missing", "/new")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => fs.rename("/dir", "/missing/new")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => fs.rename("/", "/root")).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() => fs.rename("/dir", "/dir/child")).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("bumps revision exactly once and stamps the moved subtree", () => {
    const { db, fs } = setup();
    fs.mkdir("/old/deep", { recursive: true });
    fs.writeFile("/old/deep/file", bytes("x"));
    const before = db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'") ?? 0;
    fs.rename("/old", "/new");
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(before + 1);
    expect(fs.stat("/new")?.rev).toBe(before + 1);
    expect(fs.stat("/new/deep/file")?.rev).toBe(before + 1);
  });

  it("removes the source name when both names share one inode", () => {
    const { fs } = setup();
    fs.writeFile("/source", bytes("shared"));
    fs.link("/source", "/target");
    const before = fs.stat("/source")?.rev ?? 0;
    const inode = fs.stat("/target")?.ino;

    fs.rename("/source", "/target");

    expect(fs.stat("/source")).toBeNull();
    expect(fs.stat("/target")).toMatchObject({ ino: inode, nlink: 1, rev: before + 1 });
    expect(text(fs.readFile("/target"))).toBe("shared");
  });
});

// DOFS had no dedicated inherited rename test file; these cases pin POSIX
// overwrite, symlink-parent, subtree, and revision semantics.
