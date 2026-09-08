// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";
import { conformance } from "./harness.js";

function setup(now = 0) {
  const db = new TestDatabase();
  initializeFsSchema(db, () => now);
  const ops = createFilesystemOps(db, { now: () => now });
  return { ops, api: conformance(ops) };
}

describe("mkdir", () => {
  it("creates a top-level directory with default metadata", () => {
    const { ops, api } = setup(2000);
    const before = ops.stat("/")?.rev ?? 0;
    ops.mkdir("/a");
    expect(api.stat("/a")).toMatchObject({
      isDirectory: true,
      mode: 0o755,
      mtime: 2000,
      rev: before + 1,
    });
  });

  it("honors the supplied mode", () => {
    const { ops } = setup();
    ops.mkdir("/locked", { mode: 0o700 });
    expect(ops.stat("/locked")?.mode).toBe(0o040700);
  });

  it("rejects a missing parent without recursive", () => {
    const { ops } = setup();
    expect(() => ops.mkdir("/no/such/parent")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("rejects a file parent segment", () => {
    const { ops } = setup();
    ops.writeFile("/a", new Uint8Array(0));
    expect(() => ops.mkdir("/a/b")).toThrowError(expect.objectContaining({ code: "ENOTDIR" }));
  });

  it("rejects an existing directory without recursive", () => {
    const { ops } = setup();
    ops.mkdir("/a");
    expect(() => ops.mkdir("/a")).toThrowError(expect.objectContaining({ code: "EEXIST" }));
  });

  it("rejects an existing file", () => {
    const { ops } = setup();
    ops.writeFile("/a", new Uint8Array(0));
    expect(() => ops.mkdir("/a")).toThrowError(expect.objectContaining({ code: "EEXIST" }));
  });

  it("recursive creates missing ancestors", () => {
    const { ops } = setup();
    ops.mkdir("/x/y/z", { recursive: true });
    expect(ops.stat("/x")?.type).toBe("dir");
    expect(ops.stat("/x/y")?.type).toBe("dir");
    expect(ops.stat("/x/y/z")?.type).toBe("dir");
  });

  it("recursive is idempotent for an existing directory", () => {
    const { ops } = setup();
    ops.mkdir("/a/b", { recursive: true });
    expect(() => ops.mkdir("/a/b", { recursive: true })).not.toThrow();
  });

  it("recursive still rejects an existing file", () => {
    const { ops } = setup();
    ops.mkdir("/a");
    ops.writeFile("/a/b", new Uint8Array(0));
    expect(() => ops.mkdir("/a/b", { recursive: true })).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });

  it("rejects creating root", () => {
    const { ops } = setup();
    expect(() => ops.mkdir("/")).toThrowError(expect.objectContaining({ code: "EEXIST" }));
  });

  it("accepts explicit recursive false", () => {
    const { ops } = setup();
    ops.mkdir("/dir", { recursive: false });
    expect(() => ops.mkdir("/dir", { recursive: false })).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });
});

// The formerly schema-only revision case is asserted through public Stat.rev.
