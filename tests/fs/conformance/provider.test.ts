// Ported from cloudflare/computer's provider.test.ts (MIT).
// Discarded cases: watch support (feature removed), sync change recording
// (vfs_changes removed), and pending write buffers (buffer removed). Raw
// vfs_nodes size assertions are covered through the public Stats size.

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";
import { shellQuote, withReadScope } from "../../../src/fs/compat/computer.js";
import { NodeFsCompat } from "../../../src/fs/compat/node.js";
import { createFilesystemOps } from "../../../src/fs/ops.js";
import { initializeFsSchema } from "../../../src/fs/schema.js";
import { currentRev } from "../../../src/fs/store/meta.js";
import { readFileHandles, readFiles } from "../../../src/fs/store/read.js";
import { removeFiles } from "../../../src/fs/store/remove.js";
import { realpath } from "../../../src/fs/store/resolve.js";
import { discoverFiles, glob, globPage, scan } from "../../../src/fs/store/scan.js";
import { discoverFilesContaining } from "../../../src/fs/store/search.js";
import { makeDirectories, writeFiles } from "../../../src/fs/store/write.js";
import type { Filesystem } from "../../../src/fs/types.js";
import { TestDatabase } from "../../helpers/db.js";

const FIXED_TIME = 1_000;

function createTestProvider(): NodeFsCompat {
  const db = new TestDatabase();
  initializeFsSchema(db, () => FIXED_TIME);
  const ops = createFilesystemOps(db, { now: () => FIXED_TIME });
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
    globPage: (root, pattern, options) => globPage(db, realpath(db, root), pattern, options),
    writeFiles: (entries, options) => writeFiles(db, entries, options),
    makeDirectories: (paths) => makeDirectories(db, paths),
    removeFiles: (paths, options) => removeFiles(db, paths, options),
    withReadScope: (work) => work(),
  };
  return new NodeFsCompat(filesystem);
}

describe("NodeFsCompat — provider shape", () => {
  it("reports the supported feature set", () => {
    const provider = createTestProvider();
    expect(provider.readonly).toBe(false);
    expect(provider.supportsSymlinks).toBe(true);
    expect(provider.supportsWatch).toBe(false);
  });

  it("mkdirSync creates a directory", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/a", { mode: 0o755 });
    expect(provider.existsSync("/a")).toBe(true);
  });

  it("statSync returns a complete Stats-shaped object", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/a");
    const stats = provider.statSync("/a");
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isFile()).toBe(false);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.mode).toBe(0o40755);
    expect(stats.mtimeMs).toBe(FIXED_TIME);
    expect(stats.mtime).toEqual(new Date(FIXED_TIME));
    expect(stats.blocks).toBe(0);
    expect(stats.isBlockDevice()).toBe(false);
    expect(stats.isCharacterDevice()).toBe(false);
    expect(stats.isFIFO()).toBe(false);
    expect(stats.isSocket()).toBe(false);
  });

  it("lstatSync reports a symlink while statSync follows it", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/target", "x");
    provider.symlinkSync("/target", "/link");
    expect(provider.lstatSync("/link").isSymbolicLink()).toBe(true);
    expect(provider.statSync("/link").isFile()).toBe(true);
  });

  it("readdirSync returns names or full Dirent objects", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/a");
    provider.writeFileSync("/file", "x");
    provider.symlinkSync("/file", "/link");
    expect(provider.readdirSync("/")).toEqual(["a", "file", "link"]);
    const entries = provider.readdirSync("/", { withFileTypes: true });
    expect(entries.map((entry) => entry.name)).toEqual(["a", "file", "link"]);
    expect(entries[0]?.isDirectory()).toBe(true);
    expect(entries[1]?.isFile()).toBe(true);
    expect(entries[2]?.isSymbolicLink()).toBe(true);
    expect(entries[2]?.parentPath).toBe("/");
    expect(entries[2]?.path).toBe("/link");
  });

  it("readdir overloads return names when withFileTypes is false", async () => {
    const provider = createTestProvider();
    provider.writeFileSync("/file", "x");
    const syncNames: string[] = provider.readdirSync("/", { withFileTypes: false });
    const asyncNames: string[] = await provider.readdir("/", { withFileTypes: false });
    expect(syncNames).toEqual(["file"]);
    expect(asyncNames).toEqual(["file"]);
  });

  it("writeFileSync and readFileSync round-trip text and bytes", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/text", "žluťoučký", "utf8");
    provider.writeFileSync("/bytes", Buffer.from([1, 2, 3]));
    expect(provider.readFileSync("/text", "utf8")).toBe("žluťoučký");
    const bytes = provider.readFileSync("/bytes");
    expect(Buffer.isBuffer(bytes)).toBe(true);
    if (typeof bytes === "string") throw new Error("readFileSync returned text without encoding");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("linkSync creates a second name for one inode", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    provider.linkSync("/a", "/b");
    expect(provider.statSync("/a").ino).toBe(provider.statSync("/b").ino);
    expect(provider.statSync("/a").nlink).toBe(2);
    provider.writeFileSync("/b", "changed");
    expect(provider.readFileSync("/a", "utf8")).toBe("changed");
    provider.unlinkSync("/a");
    expect(provider.readFileSync("/b", "utf8")).toBe("changed");
    expect(provider.statSync("/b").nlink).toBe(1);
  });

  it("renameSync from one hardlink onto another removes only the source name", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    provider.linkSync("/a", "/b");
    provider.renameSync("/a", "/b");
    expect(provider.existsSync("/a")).toBe(false);
    expect(provider.readFileSync("/b", "utf8")).toBe("hello");
    expect(provider.statSync("/b").nlink).toBe(1);
  });

  it("linkSync rejects missing sources, collisions, directories, and missing parents", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "hello");
    provider.mkdirSync("/dir");
    expect(() => provider.linkSync("/missing", "/new")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => provider.linkSync("/a", "/a")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(() => provider.linkSync("/dir", "/dir-link")).toThrowError(
      expect.objectContaining({ code: "EPERM" }),
    );
    expect(() => provider.linkSync("/a", "/missing/b")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("unlinkSync removes a link without removing its target", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/target", "content");
    provider.symlinkSync("/target", "/link");
    provider.unlinkSync("/link");
    expect(provider.existsSync("/link")).toBe(false);
    expect(provider.readFileSync("/target", "utf8")).toBe("content");
  });

  it("rmdirSync removes an empty directory", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/a");
    provider.rmdirSync("/a");
    expect(provider.existsSync("/a")).toBe(false);
  });

  it("renameSync moves an entry", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "x");
    provider.renameSync("/a", "/b");
    expect(provider.existsSync("/a")).toBe(false);
    expect(provider.readFileSync("/b", "utf8")).toBe("x");
  });

  it("realpathSync canonicalises and resolves links", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/real");
    provider.symlinkSync("/real", "/alias");
    expect(provider.realpathSync("/alias/./../alias")).toBe("/real");
  });

  it("accessSync resolves existing paths", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/a");
    expect(() => provider.accessSync("/a")).not.toThrow();
    expect(() => provider.accessSync("/missing")).toThrowError(
      expect.objectContaining({ code: "ENOENT", syscall: "access", path: "/missing" }),
    );
  });

  it("existsSync returns true and false for ordinary paths", () => {
    const provider = createTestProvider();
    expect(provider.existsSync("/missing")).toBe(false);
    provider.mkdirSync("/present");
    expect(provider.existsSync("/present")).toBe(true);
  });

  it("async twins resolve the same values", async () => {
    const provider = createTestProvider();
    await provider.mkdir("/dir");
    await provider.writeFile("/dir/a", "hello");
    expect(await provider.readFile("/dir/a", "utf8")).toBe("hello");
    expect((await provider.stat("/dir/a")).isFile()).toBe(true);
    expect(await provider.readdir("/dir")).toEqual(["a"]);
    await provider.rename("/dir/a", "/dir/b");
    await provider.unlink("/dir/b");
    expect(await provider.exists("/dir/b")).toBe(false);
  });
});

describe("NodeFsCompat — Computer bulk extensions", () => {
  it("walk returns metadata and applies depth, offset, limit, and exclusions", async () => {
    const provider = createTestProvider();
    provider.mkdirSync("/tree/sub", { recursive: true });
    provider.writeFileSync("/tree/a", "a");
    provider.writeFileSync("/tree/sub/b", "bb");
    provider.writeFileSync("/tree/.hidden", "h");
    provider.mkdirSync("/tree/skip");
    provider.writeFileSync("/tree/skip/c", "ccc");

    const shallow = await provider.walk("/tree", { depth: 1, excludeHidden: true });
    expect(shallow.map((entry) => entry.path)).toEqual(["/tree/a", "/tree/skip", "/tree/sub"]);
    expect(shallow[0]).toMatchObject({ type: "file", size: 1, mtime: FIXED_TIME });

    const selected = await provider.walk("/tree", { exclude: ["skip"], offset: 1, limit: 2 });
    expect(selected.map((entry) => entry.path)).toEqual(["/tree/a", "/tree/sub"]);
  });

  it("readFiles preserves order and reports per-path errors", async () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "A");
    provider.mkdirSync("/dir");
    const rows = await provider.readFiles(["/missing", "/a", "/dir", "/a"]);
    expect(rows.map((row) => [row.path, row.error])).toEqual([
      ["/missing", "ENOENT"],
      ["/a", undefined],
      ["/dir", "EISDIR"],
      ["/a", undefined],
    ]);
    expect(rows[1]?.content).toEqual(new TextEncoder().encode("A"));
    expect(rows[3]?.content).toEqual(new TextEncoder().encode("A"));
  });

  it("writeFiles and rmFiles preserve the prerelease provider shape", async () => {
    const provider = createTestProvider();
    await provider.writeFiles(
      [
        { path: "/nested/a", content: "A", mode: 0o600 },
        { path: "/nested/b", content: Buffer.from("B") },
      ],
      { createParents: true },
    );
    expect(provider.readFileSync("/nested/a", "utf8")).toBe("A");
    expect(provider.statSync("/nested/a").mode & 0o777).toBe(0o600);
    await provider.rmFiles(["/nested/a", "/nested/b"]);
    expect(provider.existsSync("/nested/a")).toBe(false);
    expect(provider.existsSync("/nested/b")).toBe(false);
  });

  it("bulk methods preserve first-class defaults when options are omitted", async () => {
    const provider = createTestProvider();
    await provider.writeFiles([{ path: "/missing/parent/file", content: "created" }]);
    expect(provider.readFileSync("/missing/parent/file", "utf8")).toBe("created");
    await expect(provider.rmFiles(["/not-there"])).resolves.toBeUndefined();
  });
});

describe("Computer compatibility helpers", () => {
  it("withReadScope is an async pass-through", async () => {
    const provider = createTestProvider();
    const result = await withReadScope(provider.db, async () => 42);
    expect(result).toBe(42);
  });

  it.each([
    ["main", "main"],
    ["/workspace/my-repo", "/workspace/my-repo"],
    ["hello world", "'hello world'"],
    ["$(whoami)", "'$(whoami)'"],
    ["it's", "'it'\\''s'"],
    ["", "''"],
  ])("shellQuote(%s)", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });
});
