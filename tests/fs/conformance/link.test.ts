import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

function setup() {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 0);
  return createFilesystemOps(db, { now: () => 0 });
}

describe("link", () => {
  it("creates a second name for one file inode", () => {
    const fs = setup();
    fs.writeFile("/a", bytes("shared"));
    const before = fs.stat("/a")?.rev ?? 0;
    fs.link("/a", "/b");
    expect(fs.stat("/a")).toMatchObject({ nlink: 2, rev: before + 1 });
    expect(fs.stat("/b")).toMatchObject({
      ino: fs.stat("/a")?.ino,
      nlink: 2,
      rev: before + 1,
    });
    expect(text(fs.readFile("/b"))).toBe("shared");
  });

  it("shares subsequent writes through either name", () => {
    const fs = setup();
    fs.writeFile("/a", bytes("old"));
    fs.link("/a", "/b");
    fs.writeFile("/b", bytes("new"));
    expect(text(fs.readFile("/a"))).toBe("new");
  });

  it("keeps the inode alive until its final name is removed", () => {
    const fs = setup();
    fs.writeFile("/a", bytes("shared"));
    fs.link("/a", "/b");
    fs.unlink("/a");
    expect(fs.stat("/a")).toBeNull();
    expect(fs.stat("/b")?.nlink).toBe(1);
    expect(text(fs.readFile("/b"))).toBe("shared");
  });

  it("follows the source symlink but resolves the destination parent", () => {
    const fs = setup();
    fs.mkdir("/real");
    fs.writeFile("/source", bytes("shared"));
    fs.symlink("/source", "/source-link");
    fs.symlink("/real", "/dir-link");
    fs.link("/source-link", "/dir-link/new");
    expect(fs.stat("/source")?.ino).toBe(fs.stat("/real/new")?.ino);
  });

  it("rejects missing sources, non-files, missing parents, and collisions", () => {
    const fs = setup();
    fs.mkdir("/dir");
    fs.writeFile("/file", bytes("x"));
    fs.writeFile("/taken", bytes("x"));
    expect(() => fs.link("/missing", "/new")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => fs.link("/dir", "/new")).toThrowError(expect.objectContaining({ code: "EPERM" }));
    expect(() => fs.link("/file", "/missing/new")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => fs.link("/file", "/taken")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });
});

// DOFS had no dedicated inherited hard-link test file; these cases pin §3.8.
