// Error-shape conformance distilled from cloudflare/computer's provider and
// filesystem tests (MIT). Mount/write-buffer errors are out of scope because
// both subsystems were deliberately removed.

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { NodeFsCompat } from "../../../src/fs/compat/node.js";
import { createFilesystemOps } from "../../../src/fs/ops.js";
import { initializeFsSchema } from "../../../src/fs/schema.js";
import { currentRev } from "../../../src/fs/store/meta.js";
import { readFiles } from "../../../src/fs/store/read.js";
import { removeFiles } from "../../../src/fs/store/remove.js";
import { realpath } from "../../../src/fs/store/resolve.js";
import { glob, scan } from "../../../src/fs/store/scan.js";
import { makeDirectories, writeFiles } from "../../../src/fs/store/write.js";
import type { Filesystem } from "../../../src/fs/types.js";
import { TestDatabase } from "../../helpers/db.js";

function createTestProvider(): NodeFsCompat {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 1_000);
  const ops = createFilesystemOps(db, { now: () => 1_000 });
  const filesystem: Filesystem = {
    ...ops,
    rev: () => currentRev(db),
    realpath: (path) => realpath(db, path),
    scan: (root, options) => scan(db, realpath(db, root), options),
    readFiles: (paths, options) => readFiles(db, paths, options),
    glob: (root, pattern, options) => glob(db, realpath(db, root), pattern, options),
    writeFiles: (entries, options) => writeFiles(db, entries, options),
    makeDirectories: (paths) => makeDirectories(db, paths),
    removeFiles: (paths, options) => removeFiles(db, paths, options),
    withReadScope: (work) => work(),
  };
  return new NodeFsCompat(filesystem);
}

describe("NodeFsCompat — error mapping", () => {
  it("statSync and lstatSync map missing results to node-shaped ENOENT errors", () => {
    const provider = createTestProvider();
    expect(() => provider.statSync("/missing")).toThrowError(
      expect.objectContaining({ code: "ENOENT", path: "/missing", syscall: "stat" }),
    );
    expect(() => provider.lstatSync("/missing")).toThrowError(
      expect.objectContaining({ code: "ENOENT", path: "/missing", syscall: "lstat" }),
    );
  });

  it("existsSync swallows every error, including ELOOP", () => {
    const provider = createTestProvider();
    provider.symlinkSync("/b", "/a");
    provider.symlinkSync("/a", "/b");
    expect(provider.existsSync("/a")).toBe(false);
  });

  it("accessSync maps a missing path to ENOENT", () => {
    const provider = createTestProvider();
    expect(() => provider.accessSync("/missing")).toThrowError(
      expect.objectContaining({ code: "ENOENT", path: "/missing", syscall: "access" }),
    );
  });

  it("openSync rejects unsupported flags with EINVAL", () => {
    const provider = createTestProvider();
    expect(() => provider.openSync("/a", "not-a-flag")).toThrowError(
      expect.objectContaining({ code: "EINVAL", syscall: "open" }),
    );
  });

  it("exclusive create rejects an existing file with EEXIST", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "x");
    expect(() => provider.openSync("/a", "wx")).toThrowError(
      expect.objectContaining({ code: "EEXIST", path: "/a", syscall: "open" }),
    );
  });

  it("openSync rejects a directory with EISDIR", () => {
    const provider = createTestProvider();
    provider.mkdirSync("/dir");
    expect(() => provider.openSync("/dir", "r")).toThrowError(
      expect.objectContaining({ code: "EISDIR", path: "/dir", syscall: "open" }),
    );
  });

  it("closed and unknown fds report EBADF", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "x");
    const fd = provider.openSync("/a", "r+");
    provider.closeSync(fd);
    expect(() => provider.readSync(fd, Buffer.alloc(1), 0, 1, null)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => provider.writeSync(fd, Buffer.from("x"))).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => provider.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    expect(() => provider.ftruncateSync(fd, 0)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => provider.closeSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
  });

  it("fd access modes are enforced", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "x");
    const readOnly = provider.openSync("/a", "r");
    const writeOnly = provider.openSync("/a", "a");
    expect(() => provider.writeSync(readOnly, Buffer.from("x"))).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => provider.ftruncateSync(readOnly, 0)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => provider.readSync(writeOnly, Buffer.alloc(1), 0, 1, null)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
  });

  it("readSync and writeSync reject invalid ranges", () => {
    const provider = createTestProvider();
    provider.writeFileSync("/a", "x");
    const fd = provider.openSync("/a", "r+");
    expect(() => provider.readSync(fd, Buffer.alloc(1), 1, 1, null)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => provider.writeSync(fd, Buffer.alloc(1), 0, 2, null)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => provider.readSync(fd, Buffer.alloc(1), 0, 1, -1)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it.each([
    ["appendFileSync", () => createTestProvider().appendFileSync("/x", "y")],
    ["copyFileSync", () => createTestProvider().copyFileSync("/x", "/y")],
    ["internalModuleStat", () => createTestProvider().internalModuleStat("/x")],
    ["watchFile", () => createTestProvider().watchFile("/x")],
  ])("%s remains an explicit ENOSYS stub", (_name, call) => {
    expect(call).toThrowError(expect.objectContaining({ code: "ENOSYS" }));
  });
});
