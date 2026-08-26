// The branches that only run at a boundary.
//
// Both of these are fallbacks: code that exists because a limit elsewhere
// can be crossed, and that therefore never runs in a small fixture. A
// fallback nothing exercises is a fallback nobody knows is broken.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem, ScanEntry } from "../../src/fs/types.js";
import { sqlGlobFor } from "../../src/shell/exec/glob.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

let fs: Filesystem;
let shell: Shell;

beforeEach(() => {
  fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  shell = createShell({ fs, cwd: "/repo" });
});

/** Every entry under `root`, however many pages it takes. */
function everything(root: string): ScanEntry[] {
  const all: ScanEntry[] = [];
  let after: string | undefined;
  for (;;) {
    const page = fs.scan(root, after === undefined ? { limit: 1_000 } : { after, limit: 1_000 });
    all.push(...page);
    if (page.length < 1_000) return all;
    const last = page[page.length - 1];
    if (last === undefined) return all;
    after = last.path;
  }
}

describe("a glob too long for SQLite to narrow with", () => {
  // The platform caps a GLOB pattern at 50 bytes. Over that the shell drops
  // the narrowing and scans the subtree instead — correct either way, only
  // slower — and this directory name is what puts the pattern over.
  const LONG = "a-directory-name-long-enough-to-pass-the-ceiling";

  beforeEach(() => {
    fs.writeFiles([
      { path: `/repo/${LONG}/x.ts`, bytes: ENCODER.encode("x\n") },
      { path: `/repo/${LONG}/y.md`, bytes: ENCODER.encode("y\n") },
      { path: `/repo/${LONG}/nested/z.ts`, bytes: ENCODER.encode("z\n") },
      { path: "/repo/short/x.ts", bytes: ENCODER.encode("x\n") },
      { path: "/repo/short/nested/z.ts", bytes: ENCODER.encode("z\n") },
    ]);
  });

  it("is over the ceiling, which is what puts this branch in play", () => {
    expect(sqlGlobFor(`/repo/${LONG}/*.ts`)).toBeNull();
    expect(sqlGlobFor("/repo/short/*.ts")).not.toBeNull();
  });

  it("expands to the same answer the narrowed path gives", () => {
    // `*` still does not cross `/`: the scanned superset is filtered in JS
    // exactly as the narrowed one is, so `nested/z.ts` is not in either.
    expect(shell.run(`echo /repo/${LONG}/*.ts`).stdout).toBe(`/repo/${LONG}/x.ts\n`);
    expect(shell.run("echo /repo/short/*.ts").stdout).toBe("/repo/short/x.ts\n");
  });

  it("still crosses directories for **", () => {
    expect(shell.run(`echo /repo/${LONG}/**/*.ts`).stdout.trim().split(" ")).toEqual([
      `/repo/${LONG}/nested/z.ts`,
      `/repo/${LONG}/x.ts`,
    ]);
  });

  it("searches a deep root, where the include narrowing degrades too", () => {
    fs.writeFiles([{ path: `/repo/${LONG}/deep/hit.ts`, bytes: ENCODER.encode("NEEDLE\n") }]);
    const run = shell.run(`grep -rl --include=*.ts NEEDLE /repo/${LONG}`);
    expect(run.stdout).toBe(`/repo/${LONG}/deep/hit.ts\n`);
  });
});

describe("a tree bigger than one discovery page", () => {
  const COUNT = 1_200;

  beforeEach(() => {
    fs.writeFiles(
      Array.from({ length: COUNT }, (_, index) => ({
        path: `/repo/src/f${String(index).padStart(5, "0")}.ts`,
        bytes: ENCODER.encode(`const v${index} = ${index};\n`),
      })),
    );
  });

  it("cp -r copies every file, not just the first page", () => {
    expect(shell.run("cp -r /repo/src /repo/copy").exitCode).toBe(0);

    const copied = everything("/repo/copy").filter((entry) => entry.type === "file");
    expect(copied).toHaveLength(COUNT);
    // The last file is the one a page-boundary bug loses.
    const last = fs.readFile(`/repo/copy/f${String(COUNT - 1).padStart(5, "0")}.ts`);
    expect(new TextDecoder().decode(last)).toBe(`const v${COUNT - 1} = ${COUNT - 1};\n`);
  });

  it("cp -r carries directories and symlinks across the boundary", () => {
    fs.mkdir("/repo/src/zz-last-dir");
    fs.symlink("/repo/src/f00000.ts", "/repo/src/zz-link.ts");

    expect(shell.run("cp -r /repo/src /repo/copy").exitCode).toBe(0);
    expect(fs.stat("/repo/copy/zz-last-dir")?.type).toBe("dir");
    expect(fs.stat("/repo/copy/zz-link.ts")?.type).toBe("symlink");
  });

  it("rm -r removes it whatever the page size", () => {
    expect(shell.run("rm -r /repo/src").exitCode).toBe(0);
    expect(fs.stat("/repo/src")).toBeNull();
    expect(everything("/repo")).toHaveLength(0);
  });

  it("a search pages through all of it", () => {
    fs.writeFiles([{ path: "/repo/src/zz-last.ts", bytes: ENCODER.encode("NEEDLE\n") }]);
    // The needle is in the very last file by sort order, so a search that
    // stops at the first page never finds it.
    expect(shell.run("grep -rl NEEDLE /repo/src").stdout).toBe("/repo/src/zz-last.ts\n");
  });
});

describe("argument expansion bounds", () => {
  it("fails closed on the first path beyond the argv cap", () => {
    fs.writeFiles(
      Array.from({ length: 10_001 }, (_, index) => ({
        path: `/repo/glob/f${String(index).padStart(5, "0")}.txt`,
        bytes: new Uint8Array(0),
      })),
    );

    const run = shell.run("echo /repo/glob/*.txt");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("E2BIG");
  });
});
