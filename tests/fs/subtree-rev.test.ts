// A subtree revision lets a host cache one directory's state per session: it
// must move whenever anything at or below the directory changes, and must not
// move for a write anywhere else.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createMountedFilesystem } from "../../packages/do/src/fs/mounted/view.js";
import { createInitialWorktreeWriter } from "../../packages/do/src/fs/store/initial-write.js";
import type { Filesystem, RealPath } from "../../packages/do/src/fs/types.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const ENCODER = new TextEncoder();

function text(value: string): Uint8Array {
  return ENCODER.encode(value);
}

function open(storage = new SqliteTestStorage()) {
  let clock = 1_000;
  const db = new TestDatabase(storage);
  const fs = createFilesystem(db, { now: () => clock++ });
  return { db, fs, storage };
}

function seeded(fs: Filesystem): void {
  fs.writeFiles([
    { path: "/sessions/a/src/main.ts", bytes: text("a") },
    { path: "/sessions/a/README.md", bytes: text("# a") },
    { path: "/sessions/b/src/main.ts", bytes: text("b") },
    { path: "/sessions/b/README.md", bytes: text("# b") },
    { path: "/shared/tool", bytes: text("tool") },
  ]);
}

/** Everything a cache of `root` could observe: its own stat, every entry, every byte. */
function observe(fs: Filesystem, root: RealPath): string {
  const self = fs.stat(root);
  if (self === null) return "absent";
  const rows = [JSON.stringify({ ...self, ino: 0, rev: 0, nlink: 0 })];
  if (self.type !== "dir") rows.push(Array.from(fs.readFile(root)).join(","));
  for (const entry of fs.scanStream(root)) {
    const bytes = entry.type === "file" ? Array.from(fs.readFile(entry.path)).join(",") : "";
    rows.push(`${entry.path} ${entry.type} ${entry.mode} ${entry.mtime} ${entry.size} ${bytes}`);
  }
  return rows.join("\n");
}

function watch(fs: Filesystem, ...roots: string[]) {
  const real = roots.map((root) => fs.realpath(root));
  const read = () => real.map((root) => fs.subtreeRev(root));
  let last = read();
  return {
    /** Which watched roots moved since the previous call. */
    moved(): boolean[] {
      const now = read();
      const moved = now.map((value, index) => value !== last[index]);
      for (const [index, value] of now.entries()) {
        expect(value).toBeGreaterThanOrEqual(last[index] ?? 0);
      }
      last = now;
      return moved;
    },
  };
}

describe("subtreeRev", () => {
  it("moves for writes inside the subtree and not for writes beside it", () => {
    const { fs } = open();
    seeded(fs);
    const roots = watch(fs, "/sessions/a", "/sessions/b", "/sessions", "/");

    fs.writeFile("/sessions/a/src/main.ts", text("a2"));
    expect(roots.moved()).toEqual([true, false, true, true]);

    fs.writeFiles([{ path: "/sessions/b/src/new.ts", bytes: text("new") }]);
    expect(roots.moved()).toEqual([false, true, true, true]);

    fs.writeFile("/shared/tool", text("tool2"));
    expect(roots.moved()).toEqual([false, false, false, true]);

    fs.mkdir("/sessions/c");
    expect(roots.moved()).toEqual([false, false, true, true]);
  });

  it("moves for every kind of mutation inside the subtree", () => {
    const { fs } = open();
    seeded(fs);
    const roots = watch(fs, "/sessions/a", "/sessions/b");
    const inA: Array<[string, () => void]> = [
      ["writeRange", () => fs.writeRange("/sessions/a/README.md", text("!"), 1)],
      ["truncate", () => fs.truncate("/sessions/a/README.md", 1)],
      ["chmod", () => fs.chmod("/sessions/a/README.md", 0o600)],
      ["touch", () => fs.touchFiles(["/sessions/a/src/main.ts"])],
      ["touch create", () => fs.touchFiles(["/sessions/a/src/touched.ts"])],
      ["stream", () => fs.writeFileStream("/sessions/a/log", [text("x")])],
      ["stream append", () => fs.writeFileStream("/sessions/a/log", [text("y")], { append: true })],
      ["copy", () => fs.copyFiles([{ source: "/shared/tool", destination: "/sessions/a/tool" }])],
      ["symlink", () => fs.symlink("src/main.ts", "/sessions/a/link")],
      ["unlink", () => fs.unlink("/sessions/a/link")],
      ["rename within", () => fs.rename("/sessions/a/tool", "/sessions/a/src/tool")],
      ["rm -r", () => fs.rm("/sessions/a/src", { recursive: true })],
      ["mkdir -p", () => fs.makeDirectories(["/sessions/a/x/y/z"])],
      ["rmdir", () => fs.rmdir("/sessions/a/x/y/z")],
    ];
    for (const [name, mutate] of inA) {
      mutate();
      expect({ name, moved: roots.moved() }).toEqual({ name, moved: [true, false] });
    }
  });

  it("moves for renames in and out and for an ancestor's removal", () => {
    const { fs } = open();
    seeded(fs);
    const roots = watch(fs, "/sessions/a", "/sessions/b", "/sessions/b/src");

    fs.rename("/sessions/a/README.md", "/sessions/b/README.from-a");
    expect(roots.moved()).toEqual([true, true, false]);

    fs.rename("/sessions/b/src", "/trash");
    expect(roots.moved()).toEqual([false, true, true]);

    fs.rename("/trash", "/sessions/b/src");
    expect(roots.moved()).toEqual([false, true, true]);

    fs.removeFiles(["/sessions"], { recursive: true });
    expect(roots.moved()).toEqual([true, true, true]);

    fs.writeFiles([{ path: "/sessions/b/src/main.ts", bytes: text("again") }]);
    expect(roots.moved()).toEqual([false, true, true]);
  });

  it("moves a directory for a write through a hard link named elsewhere", () => {
    const { fs } = open();
    seeded(fs);
    fs.link("/shared/tool", "/sessions/a/tool");
    const roots = watch(fs, "/sessions/a", "/sessions/b");

    fs.writeFile("/shared/tool", text("changed through the other name"));
    expect(roots.moved()).toEqual([true, false]);

    fs.writeRange("/shared/tool", text("C"), 0);
    expect(roots.moved()).toEqual([true, false]);
  });

  it("does not move for a call that changes nothing", () => {
    const { fs } = open();
    seeded(fs);
    const roots = watch(fs, "/sessions/a");

    fs.makeDirectories(["/sessions/a/src"]);
    fs.removeFiles(["/sessions/a/missing"]);
    fs.writeRange("/sessions/a/README.md", new Uint8Array(0), 0);
    expect(roots.moved()).toEqual([false]);
  });

  it("answers for a root that does not exist yet and keeps moving after it is removed", () => {
    const { fs } = open();
    seeded(fs);
    const root = fs.realpath("/sessions/z");
    const before = fs.subtreeRev(root);

    fs.writeFiles([{ path: "/sessions/z/file", bytes: text("z") }]);
    const created = fs.subtreeRev(root);
    expect(created).toBeGreaterThan(before);

    fs.rm("/sessions/z", { recursive: true });
    const removed = fs.subtreeRev(root);
    expect(removed).toBeGreaterThan(created);

    fs.writeFile("/shared/tool", text("elsewhere"));
    expect(fs.subtreeRev(root)).toBe(removed);
  });

  it("survives a reopen of the same storage", () => {
    const first = open();
    seeded(first.fs);
    first.fs.writeFile("/sessions/a/README.md", text("before reopen"));
    const root = first.fs.realpath("/sessions/a");
    const value = first.fs.subtreeRev(root);

    const second = open(first.storage);
    expect(second.fs.subtreeRev(root)).toBe(value);
    second.fs.writeFile("/sessions/b/README.md", text("other session"));
    expect(second.fs.subtreeRev(root)).toBe(value);
    second.fs.writeFile("/sessions/a/README.md", text("after reopen"));
    expect(second.fs.subtreeRev(root)).toBeGreaterThan(value);
  });

  it("moves for an initial worktree write", () => {
    const { db, fs } = open();
    seeded(fs);
    const roots = watch(fs, "/sessions/c", "/sessions/a");

    const result = createInitialWorktreeWriter(db, () => 5_000).tryRun("/sessions/c", (session) => {
      session.writeFile("readme.txt", text("c"));
    });
    expect(result.kind).toBe("committed");
    expect(roots.moved()).toEqual([true, false]);
  });

  it("reads in one statement whatever the subtree's size", () => {
    const storage = new SqliteTestStorage();
    const { fs } = open(storage);
    fs.writeFiles(
      Array.from({ length: 2_000 }, (_, index) => ({
        path: `/sessions/a/dir${index % 20}/file${index}`,
        bytes: text(String(index)),
      })),
    );
    const root = fs.realpath("/sessions/a");
    const before = storage.statementCount;
    fs.subtreeRev(root);
    expect(storage.statementCount - before).toBe(1);
  });

  it("follows a mounted view's mounts", () => {
    const { fs } = open();
    seeded(fs);
    const view = createMountedFilesystem(fs, [
      { path: "/home/session", source: "/sessions/a", mode: "rw" },
      { path: "/opt/shared", source: "/shared", mode: "ro" },
    ]);
    const roots = watch(view, "/home/session", "/home", "/opt/shared", "/elsewhere");

    view.writeFile("/home/session/README.md", text("through the view"));
    expect(roots.moved()).toEqual([true, true, false, false]);

    fs.writeFile("/sessions/b/README.md", text("another session"));
    expect(roots.moved()).toEqual([false, false, false, false]);

    fs.writeFile("/shared/tool", text("shared"));
    expect(roots.moved()).toEqual([false, false, true, false]);
  });

  it("moves exactly when an observer of the subtree could see a change", () => {
    // Seeded walk over a small namespace with two session roots and a shared
    // area. After every call, a root whose observable state changed must have
    // moved, and a root the call's paths cannot reach must not have.
    let seed = 0x5eed;
    const random = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % limit;
    };
    const { fs } = open();
    seeded(fs);
    const names = ["/sessions/a", "/sessions/b", "/shared"];
    const leaves = ["x", "y", "d/x", "d/y", "d/e/x"];
    const pick = (): string => `${names[random(names.length)]}/${leaves[random(leaves.length)]}`;
    const watched = ["/sessions/a", "/sessions/b", "/sessions/a/d"].map((root) =>
      fs.realpath(root),
    );
    const reaches = (root: string, paths: readonly string[]): boolean =>
      paths.some(
        (path) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
      );

    for (let step = 0; step < 400; step++) {
      const before = watched.map((root) => ({
        state: observe(fs, root),
        rev: fs.subtreeRev(root),
      }));
      const target = pick();
      const other = pick();
      let touched: string[] = [target];
      try {
        switch (random(7)) {
          case 0:
            fs.writeFiles([{ path: target, bytes: text(`v${step}`) }]);
            break;
          case 1:
            fs.rm(target, { recursive: true, force: true });
            break;
          case 2:
            touched = [target, other];
            fs.rename(target, other);
            break;
          case 3:
            fs.makeDirectories([target]);
            break;
          case 4:
            touched = [target, other];
            fs.copyFiles([{ source: target, destination: other }]);
            break;
          case 5:
            fs.touchFiles([target]);
            break;
          default:
            fs.writeRange(target, text("!"), random(4));
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error)) throw error;
      }
      for (const [index, root] of watched.entries()) {
        const previous = before[index];
        if (previous === undefined) continue;
        const rev = fs.subtreeRev(root);
        expect(rev).toBeGreaterThanOrEqual(previous.rev);
        if (observe(fs, root) !== previous.state) expect(rev).toBeGreaterThan(previous.rev);
        if (!reaches(root, touched)) expect(rev).toBe(previous.rev);
      }
    }
  });
});
