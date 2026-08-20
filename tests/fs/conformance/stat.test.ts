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
  return { ops, api: conformance(ops) };
}

describe("stat", () => {
  it("reports a regular file", () => {
    const { ops, api } = setup(1234);
    ops.writeFile("/a.txt", bytes("hello"), { mode: 0o644 });
    expect(api.stat("/a.txt")).toMatchObject({
      name: "a.txt",
      mode: 0o644,
      size: 5,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mtime: 1234,
    });
  });

  it("reports a directory", () => {
    const { ops, api } = setup();
    ops.mkdir("/d", { mode: 0o700 });
    expect(api.stat("/d")).toMatchObject({
      name: "d",
      mode: 0o700,
      size: 0,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });
  });

  it("follows symlinks", () => {
    const { ops, api } = setup();
    ops.writeFile("/target", bytes("hello"), { mode: 0o600 });
    ops.symlink("/target", "/link");
    expect(api.stat("/link")).toMatchObject({
      isFile: true,
      isSymbolicLink: false,
      mode: 0o600,
      size: 5,
    });
  });

  it("throws ENOENT for a missing target", () => {
    const { api } = setup();
    expect(() => api.stat("/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });
});

describe("lstat", () => {
  it("reports a symlink without following it", () => {
    const { ops, api } = setup();
    ops.writeFile("/target", bytes("hello world"));
    ops.symlink("/target", "/link");
    expect(api.lstat("/link")).toMatchObject({
      isSymbolicLink: true,
      isFile: false,
      isDirectory: false,
      size: bytes("/target").length,
      mode: 0o777,
    });
  });

  it("matches stat for non-symlink nodes", () => {
    const { ops, api } = setup();
    ops.writeFile("/a.txt", bytes("hi"));
    expect(api.lstat("/a.txt")).toEqual(api.stat("/a.txt"));
  });

  it("throws ENOENT for a missing path", () => {
    const { api } = setup();
    expect(() => api.lstat("/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });

  it("returns a dangling symlink itself", () => {
    const { ops, api } = setup();
    ops.symlink("/nowhere", "/dangling");
    expect(api.lstat("/dangling")).toMatchObject({ isSymbolicLink: true, size: 8 });
  });
});
