// Ported from Cloudflare DOFS under MIT. See LICENSES/cloudflare-computer.txt.

import { describe, expect, it } from "vitest";

import { createFilesystemOps } from "../../../packages/do/src/fs/ops.js";
import { initializeFsSchema } from "../../../packages/do/src/fs/schema.js";
import { TestDatabase } from "../../helpers/db.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function setup() {
  let now = 1000;
  const db = new TestDatabase();
  initializeFsSchema(db, () => 0);
  const ops = createFilesystemOps(db, { now: () => now });
  return { db, ops, setNow: (value: number) => (now = value) };
}

describe("chmod", () => {
  it("updates a regular file mode", () => {
    const { ops } = setup();
    ops.writeFile("/a", bytes("hi"));
    ops.chmod("/a", 0o600);
    expect(ops.stat("/a")?.mode).toBe(0o100600);
  });

  it("updates a directory mode", () => {
    const { ops } = setup();
    ops.mkdir("/d");
    ops.chmod("/d", 0o700);
    expect(ops.stat("/d")?.mode).toBe(0o040700);
  });

  it("masks the supplied mode to twelve bits", () => {
    const { ops } = setup();
    ops.writeFile("/a", bytes("hi"));
    ops.chmod("/a", 0o100644);
    expect(ops.stat("/a")?.mode).toBe(0o100644);
  });

  it("updates mtime and revision", () => {
    const { ops, setNow } = setup();
    ops.writeFile("/a", bytes("hi"));
    const before = ops.stat("/a")?.rev ?? 0;
    setNow(5000);
    ops.chmod("/a", 0o600);
    expect(ops.stat("/a")).toMatchObject({ mtime: 5000, rev: before + 1 });
  });

  it("follows a symlink", () => {
    const { ops } = setup();
    ops.writeFile("/target", bytes("hi"));
    ops.symlink("/target", "/link");
    ops.chmod("/link", 0o600);
    expect(ops.statTarget("/target")?.mode).toBe(0o100600);
    expect(ops.stat("/link")?.mode).toBe(0o120777);
  });

  it("rejects a missing path", () => {
    const { ops } = setup();
    expect(() => ops.chmod("/missing", 0o600)).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

// The old-schema revision case is asserted through public Stat.rev. The one
// discarded inherited case is the removed read-only mount subsystem.
