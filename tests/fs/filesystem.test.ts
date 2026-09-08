import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { TestDatabase } from "../helpers/db.js";

function open(now = 1_700_000_000_000) {
  const db = new TestDatabase();
  const fs = createFilesystem(db, { now: () => now });
  return { db, fs };
}

describe("Filesystem composition", () => {
  it("uses the injected clock for explicit entries and implicit parents", () => {
    const { fs } = open(123_456);

    fs.writeFiles([{ path: "/parent/child/file.txt", bytes: new TextEncoder().encode("x") }]);

    expect(fs.stat("/parent")?.mtime).toBe(123_456);
    expect(fs.stat("/parent/child")?.mtime).toBe(123_456);
    expect(fs.stat("/parent/child/file.txt")?.mtime).toBe(123_456);
  });

  it("resolves bulk reads and removals through symlinked ancestors", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/target/file.txt", bytes: new TextEncoder().encode("hello") }]);
    fs.symlink("/target", "/alias");

    const batch = fs.readFiles(["/alias/file.txt"]);
    expect(new TextDecoder().decode(batch.files.get("/alias/file.txt"))).toBe("hello");

    fs.removeFiles(["/alias/file.txt"], { force: false });
    expect(fs.stat("/target/file.txt")).toBeNull();
  });

  it("preserves input order and the retry boundary across aliases", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/target", bytes: new Uint8Array([1]) },
      { path: "/y", bytes: new Uint8Array(20) },
    ]);
    fs.symlink("/target", "/a");
    fs.symlink("/target", "/c");

    const stopped = fs.readFiles(["/a", "/y", "/c"], { budget: 10 });
    expect([...stopped.files.keys()]).toEqual(["/a"]);
    expect(stopped.remaining).toEqual(["/y", "/c"]);

    const complete = fs.readFiles(["/a", "/y", "/c"]);
    expect([...complete.files.keys()]).toEqual(["/a", "/y", "/c"]);
    expect(complete.remaining).toEqual([]);
  });

  it("resolves a scan root once across pages", () => {
    const { db, fs } = open();
    fs.writeFiles([
      { path: "/root/a", bytes: new Uint8Array([1]) },
      { path: "/root/b", bytes: new Uint8Array([2]) },
    ]);
    db.storage.resetCounters();

    const first = fs.scan("/root", { limit: 1 });
    const second = fs.scan("/root", { after: first[0]?.path, limit: 1 });
    const third = fs.scan("/root", { after: second[0]?.path, limit: 1 });

    expect([...first, ...second].map((entry) => entry.path)).toEqual(["/root/a", "/root/b"]);
    expect(third).toEqual([]);
    expect(db.storage.statementCount).toBe(4);
  });

  it("invalidates a paged scan root after a mutation", () => {
    const { db, fs } = open();
    fs.writeFiles([
      { path: "/root/a", bytes: new Uint8Array([1]) },
      { path: "/root/b", bytes: new Uint8Array([2]) },
    ]);
    const first = fs.scan("/root", { limit: 1 });
    fs.writeFile("/root/c", new Uint8Array([3]));
    db.storage.resetCounters();

    fs.scan("/root", { after: first[0]?.path, limit: 10 });

    expect(db.storage.statementCount).toBe(2);
  });

  it("keeps an exact successor sibling after pruning a paged subtree", () => {
    const { db, fs } = open();
    fs.writeFiles([
      { path: "/dir/child", bytes: new Uint8Array([1]) },
      { path: "/dir0", bytes: new Uint8Array([2]) },
    ]);
    db.storage.resetCounters();

    expect(fs.scan("/", { limit: 1 }).map((entry) => entry.path)).toEqual(["/dir"]);
    expect(fs.scan("/", { afterSubtree: "/dir", limit: 1 }).map((entry) => entry.path)).toEqual([
      "/dir0",
    ]);
    expect(db.storage.statementCount).toBe(3);
  });

  it("discovers and reads regular files in exactly one plus one statements", () => {
    const { db, fs } = open();
    fs.writeFiles([
      { path: "/repo/.gitignore", bytes: new TextEncoder().encode("root") },
      { path: "/repo/a/.gitignore", bytes: new TextEncoder().encode("nested") },
      { path: "/target", bytes: new TextEncoder().encode("target") },
      { path: "/repo/link/.gitignore", target: "/target" },
    ]);
    const root = fs.realpath("/repo");
    db.storage.resetCounters();

    const { handles } = fs.discoverFiles(root, "*/.gitignore");
    const batch = fs.readFileHandles(handles);

    expect(handles.map((handle) => handle.path)).toEqual([
      "/repo/.gitignore",
      "/repo/a/.gitignore",
    ]);
    expect([...batch.files.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "root",
      "nested",
    ]);
    expect(db.storage.statementCount).toBe(2);
  });

  it("refuses to open beside an unimported Computer filesystem", () => {
    const db = new TestDatabase();
    db.run("CREATE TABLE vfs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    db.run("INSERT INTO vfs_meta (k, v) VALUES ('rev', 7)");

    expect(() => createFilesystem(db)).toThrow(/must be imported/);
  });

  it("refuses incomplete Computer metadata", () => {
    const db = new TestDatabase();
    db.run("CREATE TABLE vfs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");

    expect(() => createFilesystem(db)).toThrow(/vfs_meta\.rev is missing/);
  });
});
