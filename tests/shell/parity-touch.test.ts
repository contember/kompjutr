import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import { createShell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const REAL_TOUCH = spawnSync("touch", ["--version"]).status === 0;
const ENCODER = new TextEncoder();
describe.skipIf(!REAL_TOUCH)("touch parity", () => {
  it("matches files, directories, final symlinks, dangling symlinks, and missing files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-touch-"));
    try {
      writeFileSync(join(directory, "file"), "content");
      mkdirSync(join(directory, "directory"));
      symlinkSync("file", join(directory, "link"));
      symlinkSync("dangling-target", join(directory, "dangling"));
      const old = new Date(1000);
      utimesSync(join(directory, "file"), old, old);
      utimesSync(join(directory, "directory"), old, old);
      const linkMtime = lstatSync(join(directory, "link")).mtimeMs;
      const real = spawnSync("touch", ["file", "directory", "link", "dangling", "missing"], {
        cwd: directory,
        encoding: "utf8",
      });
      let current = 1000;
      const fs = createFilesystem(new TestDatabase(), { now: () => current });
      fs.writeFiles([
        { path: "/repo/file", bytes: ENCODER.encode("content") },
        { path: "/repo/directory" },
        { path: "/repo/link", target: "file" },
        { path: "/repo/dangling", target: "dangling-target" },
      ]);
      const oursLinkMtime = fs.stat("/repo/link")?.mtime;
      current = 2000;
      const ours = await createShell({ fs, cwd: "/repo" }).run(
        "touch file directory link dangling missing",
      );
      expect({ stdout: ours.stdout, exitCode: ours.exitCode }).toEqual({
        stdout: real.stdout,
        exitCode: real.status,
      });
      expect(readFileSync(join(directory, "file"), "utf8")).toBe("content");
      expect(lstatSync(join(directory, "directory")).isDirectory()).toBe(true);
      expect(lstatSync(join(directory, "link")).mtimeMs).toBe(linkMtime);
      expect(lstatSync(join(directory, "dangling-target")).isFile()).toBe(true);
      expect(lstatSync(join(directory, "missing")).isFile()).toBe(true);
      expect(new TextDecoder().decode(fs.readFile("/repo/file"))).toBe("content");
      expect(fs.stat("/repo/directory")?.type).toBe("dir");
      expect(fs.stat("/repo/link")?.mtime).toBe(oursLinkMtime);
      expect(fs.stat("/repo/dangling-target")?.type).toBe("file");
      expect(fs.stat("/repo/missing")?.type).toBe("file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
