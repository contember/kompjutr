import { closeSync, mkdirSync, openSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { classifyDirectoryEntry } from "../../packages/local/src/drive/external-sort.js";
import { TestDatabase } from "../helpers/db.js";
import { localFixture } from "./helpers.js";

describe("DiskDrive ordered traversal", () => {
  it("discovers regular files only, exactly as the Durable Object twin does", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "dir"));
    writeFileSync(join(fixture.root, "dir", "nested.txt"), "nested");
    writeFileSync(join(fixture.root, "file.txt"), "content");
    symlinkSync("file.txt", join(fixture.root, "link.txt"));
    symlinkSync("nowhere.txt", join(fixture.root, "dangling.txt"));
    const workspace = fixture.workspace();
    const durable = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
    durable.writeFiles(
      [
        { path: "/dir/nested.txt", bytes: new TextEncoder().encode("nested") },
        { path: "/file.txt", bytes: new TextEncoder().encode("content") },
      ],
      { parents: true },
    );
    durable.symlink("file.txt", "/link.txt");
    durable.symlink("nowhere.txt", "/dangling.txt");
    try {
      const local = workspace.drive.discoverFiles(workspace.drive.realpath("/"), "*.txt");
      expect(local.handles.map((handle) => handle.path)).toEqual(["/dir/nested.txt", "/file.txt"]);
      expect(
        durable.discoverFiles(durable.realpath("/"), "*.txt").handles.map((handle) => handle.path),
      ).toEqual(local.handles.map((handle) => handle.path));
      expect(
        workspace.drive.scan("/", { limit: 10, filesOnly: true }).map((entry) => entry.path),
      ).toContain("/link.txt");
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("orders direct file and directory names without traversal markers", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a"));
    writeFileSync(join(fixture.root, "a.txt"), "sibling");
    const workspace = fixture.workspace();
    try {
      expect(workspace.drive.readdir("/").map((entry) => entry.name)).toEqual(["a", "a.txt"]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("stats a directory entry when the host reports an unknown type", () => {
    const fixture = localFixture();
    const path = join(fixture.root, "unknown.txt");
    writeFileSync(path, "content");
    try {
      expect(
        classifyDirectoryEntry(
          {
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => false,
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isFIFO: () => false,
            isSocket: () => false,
          },
          path,
        ),
      ).toBe("file");
    } finally {
      fixture.dispose();
    }
  });

  it("finishes below-frontier empty directories without creating a run", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a", "b"), { recursive: true });
    const workspace = fixture.workspace();
    try {
      expect([...workspace.drive.scanStream("/")].map((entry) => entry.path)).toEqual([
        "/a",
        "/a/b",
      ]);
      expect(readdirSync(join(fixture.state, "spills"))).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("emits Git UTF-8 path order and prunes before descending", () => {
    const fixture = localFixture();
    for (const path of ["a.txt", "a/file", "z", "\u{10000}", "\uE000"]) {
      const host = join(fixture.root, path);
      if (path.includes("/")) mkdirSync(join(fixture.root, "a"), { recursive: true });
      writeFileSync(host, path);
    }
    mkdirSync(join(fixture.root, "pruned"));
    writeFileSync(join(fixture.root, "pruned/hidden"), "hidden");
    const workspace = fixture.workspace();
    try {
      const paths = [
        ...workspace.drive.scanStream("/", {
          filesOnly: false,
          pruneDirectory: (path) => path === "/pruned",
        }),
      ].map((entry) => entry.path);
      expect(paths).toEqual(["/a", "/a.txt", "/a/file", "/pruned", "/z", "/\uE000", "/\u{10000}"]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("keeps directory rows in path order across one-row pages", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a"));
    writeFileSync(join(fixture.root, "a/file"), "nested");
    writeFileSync(join(fixture.root, "a.txt"), "sibling");
    const workspace = fixture.workspace();
    try {
      const paths: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = workspace.drive.scan("/", { after, limit: 1 });
        const entry = page[0];
        if (entry === undefined) break;
        paths.push(entry.path);
        after = entry.path;
      }
      expect(paths).toEqual(["/a", "/a.txt", "/a/file"]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("spills wide directories and removes every run after early return", () => {
    const fixture = localFixture();
    for (let index = 0; index < 1_100; index++) {
      writeFileSync(join(fixture.root, `file-${String(index).padStart(4, "0")}`), "x");
    }
    const workspace = fixture.workspace();
    try {
      expect(workspace.drive.scan("/", { limit: 10 })).toHaveLength(10);
      expect(readdirSync(join(fixture.state, "spills"))).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("merges more initial runs than one fan-in and cleans them after early return", () => {
    const fixture = localFixture();
    for (let index = 32_999; index >= 0; index--) {
      writeFileSync(join(fixture.root, `file-${String(index).padStart(5, "0")}`), "");
    }
    const workspace = fixture.workspace();
    try {
      expect(workspace.drive.scan("/", { limit: 1 }).map((entry) => entry.path)).toEqual([
        "/file-00000",
      ]);
      expect(readdirSync(join(fixture.state, "spills"))).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("spills retained directory entries when the traversal frontier is full", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a", "a"), { recursive: true });
    for (const parent of [fixture.root, join(fixture.root, "a")]) {
      for (let index = 0; index < 1_022; index++) {
        writeFileSync(join(parent, `z-${String(index).padStart(4, "0")}`), "");
      }
    }
    writeFileSync(join(fixture.root, "a", "a", "file"), "");
    const workspace = fixture.workspace();
    try {
      const scan = workspace.drive.scanStream("/");
      expect(scan.next().value?.path).toBe("/a");
      expect(scan.next().value?.path).toBe("/a/a");
      expect(scan.next().value?.path).toBe("/a/a/file");
      expect(readdirSync(join(fixture.state, "spills"))).not.toEqual([]);
      scan.return(undefined);
      expect(readdirSync(join(fixture.state, "spills"))).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("rejects invalid UTF-8 directory names", () => {
    const fixture = localFixture();
    for (let index = 0; index < 1_024; index++) {
      writeFileSync(join(fixture.root, `valid-${String(index).padStart(4, "0")}`), "x");
    }
    const invalid = Buffer.concat([Buffer.from(`${fixture.root}/`), Buffer.from([0xff])]);
    const fd = openSync(invalid, "w");
    closeSync(fd);
    const workspace = fixture.workspace();
    try {
      expect(() => [...workspace.drive.scanStream("/")]).toThrowError(
        expect.objectContaining({ code: "EILSEQ" }),
      );
      expect(readdirSync(join(fixture.state, "spills"))).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("prunes excluded roots before reading their directory entries", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "nested"));
    const invalid = Buffer.concat([Buffer.from(`${fixture.root}/nested/`), Buffer.from([0xff])]);
    const fd = openSync(invalid, "w");
    closeSync(fd);
    writeFileSync(join(fixture.root, "visible"), "visible");
    const workspace = fixture.workspace();
    try {
      expect(
        workspace.drive
          .discoverFiles(workspace.drive.realpath("/"), "*", {
            excludeRoots: ["/nested"],
          })
          .handles.map((handle) => handle.path),
      ).toEqual(["/visible"]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });
});
