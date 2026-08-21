import { Workspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { ComputerWorktree } from "../src/compat/computer/worktree.js";
import { initializeFsSchema } from "../src/fs/schema.js";
import { MAX_HANDLE_MATERIALIZE_BYTES } from "../src/fs/store/read.js";
import { realpath } from "../src/fs/store/resolve.js";
import { glob as sqliteGlob } from "../src/fs/store/scan.js";
import { writeFiles } from "../src/fs/store/write.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

describe("ComputerWorktree compatibility", () => {
  it("scans canonical paths beneath a symlinked root", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/target", { recursive: true });
    provider.writeFileSync("/target/f", "x");
    provider.symlinkSync("/target", "/alias");
    const worktree = new ComputerWorktree(provider);

    expect(worktree.scan("/alias", { limit: 1 }).map((entry) => entry.path)).toEqual(["/target/f"]);
  });

  it("stats only the candidate consumed by a limited flat scan", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    for (let index = 0; index < 100; index++) {
      provider.writeFileSync(`/f${String(index).padStart(3, "0")}`, "x");
    }

    class CountingWorktree extends ComputerWorktree {
      stats = 0;

      override stat(path: string) {
        this.stats++;
        return super.stat(path);
      }
    }

    const worktree = new CountingWorktree(provider);
    expect(worktree.scan("/", { limit: 1 }).map((entry) => entry.path)).toEqual(["/f000"]);
    expect(worktree.stats).toBeLessThanOrEqual(2);
  });

  it("does not resolve every flat symlink before honoring the limit", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.writeFileSync("/target", "x");
    for (let index = 0; index < 100; index++) {
      provider.symlinkSync("/target", `/link${String(index).padStart(3, "0")}`);
    }

    class CountingWorktree extends ComputerWorktree {
      stats = 0;

      override stat(path: string) {
        this.stats++;
        return super.stat(path);
      }
    }

    const worktree = new CountingWorktree(provider);
    expect(worktree.scan("/", { limit: 1 }).map((entry) => entry.path)).toEqual(["/link000"]);
    expect(worktree.stats).toBeLessThanOrEqual(2);
  });

  it("checks a file before consuming a following dot-dot component", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.writeFileSync("/file", "x");
    provider.mkdirSync("/target", { recursive: true });
    provider.writeFileSync("/target/f", "x");
    const worktree = new ComputerWorktree(provider);

    expect(() => worktree.scan("/file/../target", { limit: 1 })).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("returns a branded canonical realpath for a symlinked root", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/target", { recursive: true });
    provider.symlinkSync("/target", "/alias");
    const worktree = new ComputerWorktree(provider);

    expect(worktree.realpath("/alias/./")).toBe("/target");
  });

  it("includes an exact successor sibling after pruning a subtree", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/dir", { recursive: true });
    provider.writeFileSync("/dir/child", "x");
    provider.writeFileSync("/dir0", "y");
    const worktree = new ComputerWorktree(provider);

    expect(
      worktree.scan("/", { afterSubtree: "/dir", limit: 1 }).map((entry) => entry.path),
    ).toEqual(["/dir0"]);
  });

  it("discovers regular files without following a matching symlink", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/repo/a", { recursive: true });
    provider.writeFileSync("/repo/a/.gitignore", "nested");
    provider.writeFileSync("/target", "target");
    provider.symlinkSync("/target", "/repo/.gitignore");
    const worktree = new ComputerWorktree(provider);
    const root = worktree.realpath("/repo");

    const { handles } = worktree.discoverFiles(root, "*/.gitignore");
    const batch = worktree.readFileHandles(handles);
    const handle = handles[0];
    if (handle === undefined) throw new Error("fixture handle missing");

    expect(handles.map((handle) => handle.path)).toEqual(["/repo/a/.gitignore"]);
    expect(new TextDecoder().decode(batch.files.get(handle.path))).toBe("nested");
  });

  it("pages discovery with an exact canonical resume cursor", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    for (let index = 0; index < 3; index++) {
      provider.mkdirSync(`/repo/d${index}`, { recursive: true });
      provider.writeFileSync(`/repo/d${index}/.gitignore`, String(index));
    }
    const worktree = new ComputerWorktree(provider);
    const root = worktree.realpath("/repo");

    const first = worktree.discoverFiles(root, "*/.gitignore", { limit: 2 });
    if (first.next === null) throw new Error("first page did not return a cursor");
    const second = worktree.discoverFiles(root, "*/.gitignore", { after: first.next, limit: 2 });

    expect(first.handles.map((handle) => handle.path)).toEqual([
      "/repo/d0/.gitignore",
      "/repo/d1/.gitignore",
    ]);
    expect(second.handles.map((handle) => handle.path)).toEqual(["/repo/d2/.gitignore"]);
    expect(second.next).toBeNull();
    expect(() => worktree.discoverFiles(root, "*", { limit: 1001 })).toThrow(/1 to 1000/);
    expect(() => worktree.discoverFiles(root, "x".repeat(51))).toThrow(/51 bytes/);
  });

  it("matches standalone SQLite GLOB character-class semantics", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/repo", { recursive: true });
    const names = [
      "!",
      "-",
      "+",
      "0",
      "A",
      "[",
      "]",
      "^",
      "_",
      "`",
      "\\",
      "\\x",
      "a",
      "b",
      "c",
      "x",
      "y",
      "z",
    ];
    for (const name of names) provider.writeFileSync(`/repo/${name}`, name);
    const worktree = new ComputerWorktree(provider);

    const db = new TestDatabase();
    initializeFsSchema(db);
    writeFiles(db, [
      { path: "/repo" },
      ...names.map((name) => ({ path: `/repo/${name}`, bytes: new TextEncoder().encode(name) })),
    ]);
    const root = realpath(db, "/repo");
    const patterns: string[] = [
      "/repo/[^x]",
      "/repo/[!x]",
      "/repo/[a-c]",
      "/repo/[]]",
      "/repo/[[]",
      "/repo/[a-]",
      "/repo/[z-a]",
      "/repo/\\x",
      "/repo/+",
      "/repo/[x",
    ];
    for (const prefix of ["", "^"]) {
      for (const tail of ["-a", "--", "-^", "-z", "a-c", "a-", "a-b-c"]) {
        patterns.push(`/repo/[${prefix}]${tail}]`);
      }
    }

    for (const pattern of patterns) {
      expect(worktree.glob("/repo", pattern), pattern).toEqual(sqliteGlob(db, root, pattern));
    }
  });

  it("does not use a leading literal closing bracket as a range endpoint", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/repo", { recursive: true });
    for (const name of ["]", "-", "a", "b"]) provider.writeFileSync(`/repo/${name}`, name);
    const worktree = new ComputerWorktree(provider);

    const db = new TestDatabase();
    initializeFsSchema(db);
    writeFiles(db, [
      { path: "/repo" },
      ...["]", "-", "a", "b"].map((name) => ({
        path: `/repo/${name}`,
        bytes: new TextEncoder().encode(name),
      })),
    ]);
    const root = realpath(db, "/repo");

    expect(worktree.glob("/repo", "/repo/[]-a]")).toEqual(["/repo/-", "/repo/]", "/repo/a"]);
    expect(worktree.glob("/repo", "/repo/[^]-a]")).toEqual(["/repo/b"]);
    expect(worktree.glob("/repo", "/repo/[]-a]")).toEqual(sqliteGlob(db, root, "/repo/[]-a]"));
    expect(worktree.glob("/repo", "/repo/[^]-a]")).toEqual(sqliteGlob(db, root, "/repo/[^]-a]"));
  });

  it("bounds and validates caller handles before provider access", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/repo", { recursive: true });
    provider.writeFileSync("/repo/.gitignore", "x");

    class CountingWorktree extends ComputerWorktree {
      stats = 0;

      override stat(path: string) {
        this.stats++;
        return super.stat(path);
      }
    }

    const worktree = new CountingWorktree(provider);
    const page = worktree.discoverFiles(worktree.realpath("/repo"), "*/.gitignore");
    const handle = page.handles[0];
    if (handle === undefined) throw new Error("fixture handle missing");
    worktree.stats = 0;

    expect(() => worktree.readFileHandles(Array.from({ length: 5_001 }, () => handle))).toThrow(
      /at most 5000 handles/,
    );
    expect(worktree.stats).toBe(0);

    Object.defineProperty(handle, "path", { value: "/repo/../repo/.gitignore" });
    expect(() => worktree.readFileHandles([handle])).toThrow(/invalid canonical path/);
    expect(worktree.stats).toBe(0);
  });

  it("rejects a forged huge stale handle before reading any range", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/repo", { recursive: true });
    provider.writeFileSync("/repo/.gitignore", "x");

    class CountingRangeWorktree extends ComputerWorktree {
      ranges = 0;

      override readRange(path: string, offset: number, length: number): Uint8Array {
        this.ranges++;
        return super.readRange(path, offset, length);
      }
    }

    const worktree = new CountingRangeWorktree(provider);
    const page = worktree.discoverFiles(worktree.realpath("/repo"), "*/.gitignore");
    const handle = page.handles[0];
    if (handle === undefined) throw new Error("fixture handle missing");
    const forged = { ...handle, size: Number.MAX_SAFE_INTEGER };

    expect(() => worktree.readFileHandles([forged])).toThrowError(
      expect.objectContaining({ code: "ESTALE" }),
    );
    expect(worktree.ranges).toBe(0);
  });

  it("rejects validated oversized metadata before reading any range", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/repo", { recursive: true });
    provider.writeFileSync("/repo/.gitignore", "x");

    class OversizedWorktree extends ComputerWorktree {
      ranges = 0;

      override stat(path: string) {
        const stat = super.stat(path);
        if (path === "/repo/.gitignore" && stat?.type === "file") {
          return { ...stat, size: MAX_HANDLE_MATERIALIZE_BYTES + 1 };
        }
        return stat;
      }

      override readRange(path: string, offset: number, length: number): Uint8Array {
        this.ranges++;
        return super.readRange(path, offset, length);
      }
    }

    const worktree = new OversizedWorktree(provider);
    const page = worktree.discoverFiles(worktree.realpath("/repo"), "*/.gitignore");

    expect(() => worktree.readFileHandles(page.handles)).toThrowError(
      expect.objectContaining({ code: "EFBIG" }),
    );
    expect(worktree.ranges).toBe(0);
  });
});
