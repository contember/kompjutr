// What the Bash harness cannot compare for find: refusals the shell owns,
// operation cost, `-exec +` batch bounds, the post-order the shell walks in,
// and time windows that need a pinned clock. The windows restate what GNU
// find 4.10 printed for files touched at those ages.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { WriteEntry } from "../../packages/do/src/fs/types.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

function shellOver(paths: readonly string[], mtimes: Readonly<Record<string, number>> = {}): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => NOW });
  const entries: WriteEntry[] = paths.map((path) => ({
    path: `/repo/${path}`,
    bytes: ENCODER.encode(path),
    mtime: mtimes[path] ?? NOW,
  }));
  fs.writeFiles([{ path: "/repo", mode: 0o755 }, ...entries]);
  return createShell({ fs, cwd: "/repo", now: () => NOW });
}

/** `directories` × `files` regular files, one level deep. */
function wideTree(directories: number, files: number): string[] {
  const paths: string[] = [];
  for (let directory = 0; directory < directories; directory++) {
    for (let file = 0; file < files; file++) {
      paths.push(`d${String(directory).padStart(3, "0")}/f${String(file).padStart(3, "0")}.ts`);
    }
  }
  return paths;
}

describe("find refusals", () => {
  it.each([
    "-execdir",
    "-ok",
    "-okdir",
    "-atime",
    "-amin",
    "-ctime",
    "-cmin",
    "-anewer",
    "-newermt",
  ])("refuses %s by name", async (predicate) => {
    const run = await shellOver(["a.ts"]).run(`find . ${predicate} x`);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(`find: ${predicate} is not supported`);
    expect(run.stdout).toBe("");
  });

  it("refuses -exec {} + without a command", async () => {
    const run = await shellOver(["a.ts"]).run("find . -exec {} +");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe("find: -exec {} + without a command is not supported\n");
  });
});

describe("find -delete cost", () => {
  it("removes 500 files in 50 directories in a handful of operations", async () => {
    const shell = shellOver(wideTree(50, 10));
    const run = await shell.run("find . -delete");
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    // One stat, one scan page, one removal call per generation.
    expect(run.operations).toBeLessThan(10);
    expect((await shell.run("find .")).stdout).toBe(".\n");
  });

  it("grows with scan pages and batches, not with entries", async () => {
    const shell = shellOver(wideTree(500, 10));
    const run = await shell.run("find . -delete");
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.operations).toBeLessThan(40);
    expect((await shell.run("find .")).stdout).toBe(".\n");
  });

  it("empties deep chains and siblings that sort between a directory and its children", async () => {
    const paths = ["a.txt", "a-b/x", "a/c0", "a/c.d/e", "a/c/f/g/h/i/j/k", "a/c/f/g/h/i/l", "z"];
    const shell = shellOver(paths);
    const run = await shell.run("find . -delete");
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect((await shell.run("find .")).stdout).toBe(".\n");
  });

  it("keeps a directory whose kept child spans a batch flush", async () => {
    const paths = [...wideTree(3, 700), "d001/keep.md"];
    const shell = shellOver(paths);
    const run = await shell.run("find . -name '*.ts' -delete -o -type d -delete");
    expect(run.stderr).toBe("find: cannot delete './d001': Directory not empty\n");
    expect(run.exitCode).toBe(1);
    expect((await shell.run("find .")).stdout).toBe(".\n./d001\n./d001/keep.md\n");
  });
});

describe("find -empty cost", () => {
  it("reads emptiness from the scan rather than one listing per directory", async () => {
    const shell = shellOver(wideTree(50, 10));
    await shell.run("mkdir e1 e2 d010/e3");
    const run = await shell.run("find . -type d -empty");
    expect(run.stdout).toBe("./d010/e3\n./e1\n./e2\n");
    expect(run.operations).toBeLessThan(10);
  });
});

describe("find -exec batches", () => {
  it("runs one invocation for 500 paths", async () => {
    const shell = shellOver(wideTree(50, 10));
    const run = await shell.run("find . -name '*.ts' -exec echo {} +");
    const lines = run.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split(" ")).toHaveLength(500);
    expect(run.operations).toBeLessThan(10);
  });

  it("splits a batch at GNU's 128 KiB command buffer", async () => {
    const long = "x".repeat(120);
    const paths = Array.from({ length: 2_000 }, (_, index) => `${long}${index}.ts`);
    const run = await shellOver(paths).run("find . -name '*.ts' -exec echo {} +");
    const lines = run.stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.flatMap((line) => line.split(" "))).toHaveLength(2_000);
    for (const line of lines) {
      const argvBytes = `echo ${line}`
        .split(" ")
        .reduce((total, part) => total + part.length + 1, 0);
      expect(argvBytes).toBeLessThanOrEqual(131_072);
    }
  });
});

describe("find orders the shell owns", () => {
  // GNU follows readdir; this shell walks path byte order, children first.
  it("lists -depth in post-order over path byte order", async () => {
    const run = await shellOver(["src/a-b/x", "src/a/c", "src/a.txt"]).run("find src -depth");
    expect(run.stdout).toBe("src/a-b/x\nsrc/a-b\nsrc/a.txt\nsrc/a/c\nsrc/a\nsrc\n");
  });
});

describe("find time tests against a pinned clock", () => {
  const ages: Readonly<Record<string, number>> = {
    "m0.5": 0.5 * MINUTE,
    m1: 1 * MINUTE + 1_000,
    "m1.5": 1.5 * MINUTE,
    "m2.5": 2.5 * MINUTE,
    "d0.5": 0.5 * DAY,
    "d1.2": 1.2 * DAY,
    "d2.5": 2.5 * DAY,
    "d3.5": 3.5 * DAY,
  };
  const mtimes = Object.fromEntries(Object.entries(ages).map(([name, age]) => [name, NOW - age]));

  it.each([
    ["-mmin 1", "m0.5"],
    ["-mmin 2", "m1 m1.5"],
    ["-mmin +1", "d0.5 d1.2 d2.5 d3.5 m1 m1.5 m2.5"],
    ["-mmin -2", "m0.5 m1 m1.5"],
    ["-mtime 0", "d0.5 m0.5 m1 m1.5 m2.5"],
    ["-mtime 1", "d1.2"],
    ["-mtime +0", "d1.2 d2.5 d3.5"],
    ["-mtime +1", "d2.5 d3.5"],
    ["-mtime -1", "d0.5 m0.5 m1 m1.5 m2.5"],
    ["-mtime -3", "d0.5 d1.2 d2.5 m0.5 m1 m1.5 m2.5"],
  ])("find -type f %s", async (test, expected) => {
    const run = await shellOver(Object.keys(ages), mtimes).run(`find . -type f ${test}`);
    const names = run.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(2));
    expect(names.join(" ")).toBe(expected);
  });

  it("compares -newer strictly by mtime", async () => {
    const run = await shellOver(Object.keys(ages), mtimes).run("find . -type f -newer m1.5");
    expect(run.stdout).toBe("./m0.5\n./m1\n");
  });
});
