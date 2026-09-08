// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { CHUNK_SIZE, initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";
import { conformance } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function setup(now = 0) {
  const db = new TestDatabase();
  initializeFsSchema(db, () => now);
  const ops = createFilesystemOps(db, { now: () => now });
  return { db, ops, api: conformance(ops) };
}

function chunkCount(db: TestDatabase, path: string): number {
  return (
    db.scalar<number>(
      `SELECT count(*) FROM fs_chunks c
         JOIN fs_paths p ON p.inode = c.inode
        WHERE p.path = ?`,
      path,
    ) ?? 0
  );
}

describe("writeFile", () => {
  it("writes small bytes into one chunk", () => {
    const { db, ops, api } = setup();
    ops.writeFile("/hello.txt", encoder.encode("hello"));
    expect(decoder.decode(api.readBack("/hello.txt"))).toBe("hello");
    expect(chunkCount(db, "/hello.txt")).toBe(1);
  });

  it("accepts arbitrary Uint8Array content", () => {
    const { ops } = setup();
    const expected = new Uint8Array([0, 1, 2, 253, 254, 255]);
    ops.writeFile("/binary", expected);
    expect(ops.readFile("/binary")).toEqual(expected);
  });

  it("writes empty files without chunks", () => {
    const { db, ops } = setup();
    ops.writeFile("/empty", new Uint8Array(0));
    expect(ops.stat("/empty")?.size).toBe(0);
    expect(chunkCount(db, "/empty")).toBe(0);
  });

  it("splits content at the storage chunk size", () => {
    const { db, ops } = setup();
    const expected = new Uint8Array(CHUNK_SIZE * 2 + 17).map((_, index) => index & 0xff);
    ops.writeFile("/large", expected);
    expect(ops.readFile("/large")).toEqual(expected);
    expect(chunkCount(db, "/large")).toBe(3);
  });

  it("rejects a missing parent", () => {
    const { ops } = setup();
    expect(() => ops.writeFile("/no/such/dir/file", encoder.encode("x"))).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("rejects a non-directory parent segment", () => {
    const { ops } = setup();
    ops.writeFile("/target", encoder.encode("file"));
    expect(() => ops.writeFile("/target/sub/child", encoder.encode("x"))).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("rejects a directory target", () => {
    const { ops } = setup();
    ops.mkdir("/d");
    expect(() => ops.writeFile("/d", encoder.encode("x"))).toThrowError(
      expect.objectContaining({ code: "EISDIR" }),
    );
  });

  it("honors mode, mtime, and revision", () => {
    const { ops } = setup(4242);
    const before = ops.stat("/")?.rev ?? 0;
    ops.writeFile("/run.sh", encoder.encode("#!/bin/sh\n"), { mode: 0o755 });
    expect(ops.stat("/run.sh")).toMatchObject({ mode: 0o100755, mtime: 4242, rev: before + 1 });
  });

  it("updates bytes, mtime, and revision on overwrite", () => {
    let now = 100;
    const db = new TestDatabase();
    initializeFsSchema(db, () => 0);
    const ops = createFilesystemOps(db, { now: () => now });
    ops.writeFile("/x", encoder.encode("v1"));
    const first = ops.stat("/x");
    now = 200;
    ops.writeFile("/x", encoder.encode("v2"));
    expect(ops.stat("/x")).toMatchObject({
      ino: first?.ino,
      mtime: 200,
      rev: (first?.rev ?? 0) + 1,
    });
    expect(decoder.decode(ops.readFile("/x"))).toBe("v2");
  });

  it("writes into an existing nested directory", () => {
    const { ops } = setup();
    ops.mkdir("/a/b", { recursive: true });
    ops.writeFile("/a/b/c", encoder.encode("nested"));
    expect(decoder.decode(ops.readFile("/a/b/c"))).toBe("nested");
  });

  it("writes through absolute and relative intermediate directory symlinks", () => {
    const { ops } = setup();
    ops.mkdir("/base/real", { recursive: true });
    ops.symlink("/base/real", "/absolute");
    ops.symlink("real", "/base/relative");
    ops.writeFile("/absolute/a", encoder.encode("a"));
    ops.writeFile("/base/relative/b", encoder.encode("b"));
    expect(decoder.decode(ops.readFile("/base/real/a"))).toBe("a");
    expect(decoder.decode(ops.readFile("/base/real/b"))).toBe("b");
  });

  it("resolves a relative final symlink from its real parent", () => {
    const { ops } = setup();
    ops.mkdir("/real/nested", { recursive: true });
    ops.symlink("/real/nested", "/alias");
    ops.symlink("../target", "/real/nested/link");
    ops.writeFile("/alias/link", encoder.encode("hello"));
    expect(decoder.decode(ops.readFile("/real/target"))).toBe("hello");
    expect(ops.statTarget("/target")).toBeNull();
  });

  it("expands a symlink before applying later parent segments", () => {
    const { ops } = setup();
    ops.mkdir("/base/dir", { recursive: true });
    ops.mkdir("/other/deep", { recursive: true });
    ops.symlink("/other/deep", "/base/dir/alias");
    ops.symlink("alias/../target", "/base/dir/link");
    ops.writeFile("/base/dir/link", encoder.encode("hello"));
    expect(decoder.decode(ops.readFile("/other/target"))).toBe("hello");
    expect(ops.statTarget("/base/dir/target")).toBeNull();
  });

  it("rejects an intermediate symlink to a file", () => {
    const { ops } = setup();
    ops.writeFile("/target", encoder.encode("file"));
    ops.symlink("/target", "/linkfile");
    expect(() => ops.writeFile("/linkfile/child", encoder.encode("x"))).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("rejects a cyclic intermediate symlink", () => {
    const { ops } = setup();
    ops.symlink("/b", "/a");
    ops.symlink("/a", "/b");
    expect(() => ops.writeFile("/a/child", encoder.encode("x"))).toThrowError(
      expect.objectContaining({ code: "ELOOP" }),
    );
  });

  it("shares one follow limit across intermediate and final links", () => {
    const { ops } = setup();
    ops.mkdir("/real");
    for (let index = 29; index >= 0; index--) {
      ops.symlink(index === 29 ? "/real" : `/dir-${index + 1}`, `/dir-${index}`);
    }
    for (let index = 19; index >= 0; index--) {
      ops.symlink(index === 19 ? "/missing" : `/file-${index + 1}`, `/file-${index}`);
    }
    ops.symlink("/file-0", "/real/link");
    expect(() => ops.writeFile("/dir-0/link", encoder.encode("x"))).toThrowError(
      expect.objectContaining({ code: "ELOOP" }),
    );
  });

  it("writes through a final symlink without putting chunks on the link inode", () => {
    const { db, ops } = setup();
    ops.writeFile("/target", encoder.encode("old"));
    ops.symlink("/target", "/link");
    ops.writeFile("/link", encoder.encode("new"));
    expect(decoder.decode(ops.readFile("/target"))).toBe("new");
    expect(
      db.scalar<number>(
        `SELECT count(*) FROM fs_chunks c
           JOIN fs_nodes n ON n.inode = c.inode
          WHERE n.type = 'symlink'`,
      ),
    ).toBe(0);
  });

  it("creates absolute and relative dangling final targets", () => {
    const { ops } = setup();
    ops.mkdir("/dir");
    ops.symlink("/created", "/absolute");
    ops.symlink("created", "/dir/relative");
    ops.writeFile("/absolute", encoder.encode("a"));
    ops.writeFile("/dir/relative", encoder.encode("b"));
    expect(decoder.decode(ops.readFile("/created"))).toBe("a");
    expect(decoder.decode(ops.readFile("/dir/created"))).toBe("b");
  });

  it("clamps final and intermediate targets above root", () => {
    const { ops } = setup();
    ops.mkdir("/real");
    ops.symlink("../../created", "/file-link");
    ops.symlink("../../real", "/dir-link");
    ops.writeFile("/file-link", encoder.encode("a"));
    ops.writeFile("/dir-link/file", encoder.encode("b"));
    expect(decoder.decode(ops.readFile("/created"))).toBe("a");
    expect(decoder.decode(ops.readFile("/real/file"))).toBe("b");
  });

  it("creates the last target in a dangling symlink chain", () => {
    const { ops } = setup();
    ops.symlink("/mid", "/link");
    ops.symlink("/missing", "/mid");
    ops.writeFile("/link", encoder.encode("new"));
    expect(decoder.decode(ops.readFile("/missing"))).toBe("new");
    expect(ops.stat("/mid")?.type).toBe("symlink");
  });

  it("range writes follow a final symlink", () => {
    const { ops } = setup();
    ops.writeFile("/target", encoder.encode("abc"));
    ops.symlink("/target", "/link");
    ops.writeRange("/link", encoder.encode("x"), 1);
    expect(decoder.decode(ops.readFile("/target"))).toBe("axc");
  });

  it("round-trips source pieces that do not align to storage chunks", () => {
    const { db, ops } = setup();
    const first = new Uint8Array(CHUNK_SIZE - 3).fill(1);
    const second = new Uint8Array(17).fill(2);
    const expected = new Uint8Array(first.length + second.length);
    expected.set(first);
    expected.set(second, first.length);
    ops.writeFile("/unaligned", expected);
    expect(ops.readFile("/unaligned")).toEqual(expected);
    expect(chunkCount(db, "/unaligned")).toBe(2);
  });

  it("creates, sparsely writes, and truncates files", () => {
    let now = 1000;
    const db = new TestDatabase();
    initializeFsSchema(db, () => 0);
    const ops = createFilesystemOps(db, { now: () => now });
    ops.createFile("/nested/deep/file", 0o600);
    expect(ops.stat("/nested")?.type).toBe("dir");
    expect(ops.stat("/nested/deep")?.type).toBe("dir");
    expect(ops.stat("/nested/deep/file")).toMatchObject({
      mode: 0o100600,
      size: 0,
      mtime: 1000,
    });

    ops.writeFile("/nested/deep/file", new Uint8Array([1, 2]), {
      mode: 0o600,
      contentId: new Uint8Array([9, 8, 7]),
    });
    const beforeRange = ops.stat("/nested/deep/file")?.rev ?? 0;
    now = 2000;
    ops.writeRange("/nested/deep/file", encoder.encode("x"), 3);
    expect(Array.from(ops.readFile("/nested/deep/file"))).toEqual([1, 2, 0, 120]);
    expect(ops.stat("/nested/deep/file")).toMatchObject({
      mode: 0o100600,
      mtime: 2000,
      rev: beforeRange + 1,
      contentId: null,
    });

    const beforeShrink = ops.stat("/nested/deep/file")?.rev ?? 0;
    now = 3000;
    ops.truncate("/nested/deep/file", 2);
    expect(Array.from(ops.readFile("/nested/deep/file"))).toEqual([1, 2]);
    expect(ops.stat("/nested/deep/file")).toMatchObject({
      mode: 0o100600,
      mtime: 3000,
      rev: beforeShrink + 1,
      contentId: null,
    });

    ops.truncate("/nested/deep/file", 5);
    expect(Array.from(ops.readFile("/nested/deep/file"))).toEqual([1, 2, 0, 0, 0]);
  });

  it("maps range and truncate errors exactly", () => {
    const { ops } = setup();
    ops.mkdir("/dir");
    ops.writeFile("/file", encoder.encode("x"));

    expect(() => ops.writeRange("/missing", encoder.encode("x"), 0)).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => ops.writeRange("/dir", encoder.encode("x"), 0)).toThrowError(
      expect.objectContaining({ code: "EISDIR" }),
    );
    expect(() => ops.writeRange("/file", encoder.encode("x"), -1)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => ops.truncate("/missing", 0)).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => ops.truncate("/dir", 0)).toThrowError(expect.objectContaining({ code: "EISDIR" }));
    expect(() => ops.truncate("/file", -1)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });
});

// Discarded inherited cases: exclusive writes and ReadableStream input are
// absent from §4.1; blob dedup, blob GC, incremental staging, and unchanged
// chunk reuse belong to the superseded content-addressed DOFS store.
