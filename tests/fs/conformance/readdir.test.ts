// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";
import { conformance } from "./harness.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function setup() {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 0);
  const ops = createFilesystemOps(db, { now: () => 0 });
  return { ops, api: conformance(ops) };
}

describe("readdir", () => {
  it("returns an empty array for an empty directory", () => {
    expect(setup().api.readdir("/")).toEqual([]);
  });

  it("lists files and directories with dirent shape", () => {
    const { ops, api } = setup();
    ops.mkdir("/sub");
    ops.writeFile("/file.txt", bytes("x"));
    expect(api.readdir("/")).toEqual([
      { name: "file.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: "sub", isFile: false, isDirectory: true, isSymbolicLink: false },
    ]);
  });

  it("sorts entries by UTF-8 byte order", () => {
    const { ops, api } = setup();
    for (const name of ["b", "a", "c"]) ops.writeFile(`/${name}`, new Uint8Array(0));
    expect(api.readdir("/").map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  });

  it("paginates committed entries by stable order", () => {
    const { ops, api } = setup();
    for (const name of ["a", "b", "c", "d"]) ops.writeFile(`/${name}`, bytes(name));
    expect(api.readdir("/", { limit: 2, offset: 0 }).map((entry) => entry.name)).toEqual([
      "a",
      "b",
    ]);
    expect(api.readdir("/", { limit: 2, offset: 2 }).map((entry) => entry.name)).toEqual([
      "c",
      "d",
    ]);
  });

  it("keeps UTF-8 filename pages stable", () => {
    const { ops, api } = setup();
    const bmpName = "\uE000";
    const astralName = "\u{10000}";
    ops.writeFile(`/${astralName}`, new Uint8Array(0));
    ops.writeFile(`/${bmpName}`, new Uint8Array(0));
    expect(api.readdir("/", { limit: 1 }).map((entry) => entry.name)).toEqual([bmpName]);
    expect(api.readdir("/", { limit: 1, offset: 1 }).map((entry) => entry.name)).toEqual([
      astralName,
    ]);
  });

  it("rejects invalid offsets", () => {
    const { api } = setup();
    expect(() => api.readdir("/", { offset: -1 })).toThrowError(
      "readdir offset must be a non-negative safe integer",
    );
  });

  it("uses the requested nested directory", () => {
    const { ops, api } = setup();
    ops.mkdir("/a/b", { recursive: true });
    ops.writeFile("/a/b/leaf.txt", bytes("x"));
    expect(api.readdir("/a/b")).toEqual([
      { name: "leaf.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);
  });

  it("canonicalizes the parent input", () => {
    const { ops, api } = setup();
    ops.mkdir("/a");
    ops.writeFile("/a/x", new Uint8Array(0));
    expect(api.readdir("/a//.").map((entry) => entry.name)).toEqual(["x"]);
  });

  it("follows a symlink to a directory", () => {
    const { ops, api } = setup();
    ops.mkdir("/real");
    ops.writeFile("/real/x", new Uint8Array(0));
    ops.symlink("/real", "/alias");
    expect(api.readdir("/alias").map((entry) => entry.name)).toEqual(["x"]);
  });

  it("throws ENOENT for missing paths", () => {
    const { api } = setup();
    expect(() => api.readdir("/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    expect(() => api.readdir("/no/such/path")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("includes symlink entries", () => {
    const { ops, api } = setup();
    ops.symlink("/target", "/link");
    expect(api.readdir("/")).toContainEqual({
      name: "link",
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
  });

  it("throws ENOTDIR when called on a file", () => {
    const { ops, api } = setup();
    ops.writeFile("/file.txt", bytes("x"));
    expect(() => api.readdir("/file.txt")).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});

// Discarded inherited cases: four write-buffer merge/commit tests are out of
// scope, and the SQL-spy case asserts the superseded `vfs_dirents` schema.
