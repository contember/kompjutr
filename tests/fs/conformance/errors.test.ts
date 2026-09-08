// Error-shape conformance distilled from cloudflare/computer's provider and
// filesystem tests (MIT). Mount/write-buffer errors are out of scope because
// both subsystems were deliberately removed.

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { NodeFsCompat } from "../../../packages/do/src/fs/compat/node.js";
import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { copyFiles } from "../../../packages/do/src/fs/store/copy.js";
import { currentRev } from "../../../packages/do/src/fs/store/meta.js";
import { readFileHandles, readFiles } from "../../../packages/do/src/fs/store/read.js";
import { removeFiles } from "../../../packages/do/src/fs/store/remove.js";
import {
  realpath,
  realpaths,
  realpathsNoFollow,
} from "../../../packages/do/src/fs/store/resolve.js";
import {
  discoverFiles,
  glob,
  globPage,
  listEntries,
  scan,
} from "../../../packages/do/src/fs/store/scan.js";
import { discoverFilesContaining } from "../../../packages/do/src/fs/store/search.js";
import { writeFileStream } from "../../../packages/do/src/fs/store/stream-write.js";
import { touchFiles } from "../../../packages/do/src/fs/store/touch.js";
import { makeDirectories, writeFiles } from "../../../packages/do/src/fs/store/write.js";
import type { Filesystem } from "../../../packages/do/src/fs/types.js";
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
    discoverFiles: (root, pattern, options) => discoverFiles(db, root, pattern, options),
    discoverFilesContaining: (root, pattern, needle, options) =>
      discoverFilesContaining(db, root, pattern, needle, options),
    readFileHandles: (handles, options) => readFileHandles(db, handles, options),
    readFiles: (paths, options) => readFiles(db, paths, options),
    glob: (root, pattern, options) => glob(db, realpath(db, root), pattern, options),
    globPage: (root, pattern, options) => globPage(db, realpath(db, root), pattern, options),
    listEntries: (root, options) => listEntries(db, realpath(db, root), options),
    writeFiles: (entries, options) => writeFiles(db, entries, options),
    copyFiles: (entries, options) => {
      const sources = realpathsNoFollow(
        db,
        entries.map((entry) => entry.source),
      );
      const destinations = realpathsNoFollow(
        db,
        entries.map((entry) => entry.destination),
      );
      const resolved = [];
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        const destination = destinations[index];
        if (source === undefined || destination === undefined) throw new Error("incomplete batch");
        resolved.push({ source, destination });
      }
      const copied = copyFiles(db, resolved, options);
      return { copied, remaining: entries.slice(copied) };
    },
    touchFiles: (paths, options) =>
      touchFiles(db, realpaths(db, paths), options?.mtime ?? 1_000, options?.create),
    writeFileStream: (path, chunks, options) =>
      writeFileStream(db, realpath(db, path), chunks, options?.append === true, 1_000),
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
    ["internalModuleStat", () => createTestProvider().internalModuleStat("/x")],
    ["watchFile", () => createTestProvider().watchFile("/x")],
  ])("%s remains an explicit ENOSYS stub", (_name, call) => {
    expect(call).toThrowError(expect.objectContaining({ code: "ENOSYS" }));
  });
});
