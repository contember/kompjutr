// Local properties of the line and column filters that no reference can
// witness: pull-based output, bounded retained memory, and the forms the
// shell refuses explicitly instead of approximating.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { Limits } from "../../packages/do/src/shell/exec/context.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const LONG_LINE = `${"x".repeat(4096)}:tail\n`;

function shellWith(limits?: Limits): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  fs.writeFiles([
    { path: "/repo/long.txt", bytes: ENCODER.encode(LONG_LINE) },
    { path: "/repo/a.txt", bytes: ENCODER.encode("a\nb\n") },
  ]);
  return createShell({ fs, cwd: "/repo", limits });
}

let shell: Shell;
beforeEach(() => {
  shell = shellWith();
});

describe("output is pulled", () => {
  it("stops seq when head stops reading", async () => {
    const run = await shell.run("seq 1 100000000 | head -2");
    expect(run).toMatchObject({ stdout: "1\n2\n", exitCode: 0 });
    expect(run.peakRetainedBytes).toBeLessThan(64 * 1024);
  });

  it.each([
    "seq 1 100000000 | cut -c1 | head -2",
    "seq 1 100000000 | tr 0-9 a-j | head -2",
    "seq 1 100000000 | rev | head -2",
    "seq 1 100000000 | nl | head -2",
    "seq 1 100000000 | comm - a.txt | head -2",
  ])("streams through a filter: %j", async (source) => {
    const run = await shell.run(source);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.split("\n")).toHaveLength(3);
    expect(run.peakRetainedBytes).toBeLessThan(64 * 1024);
  });
});

describe("retained memory", () => {
  const limits: Limits = {
    maxOutputBytes: 1_000_000,
    maxOperations: 10_000,
    readBudget: 1_500_000,
    maxRetainedBytes: 2048,
  };

  it.each([
    "cut -d: -f2 long.txt",
    "nl long.txt",
    "rev long.txt",
    "comm long.txt a.txt",
    "cat long.txt | cut -b1",
  ])("fails an over-long line loudly: %j", async (source) => {
    const run = await shellWith(limits).run(source);
    expect(run.stdout).toBe("");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/retained-memory limit/);
    expect(run.peakRetainedBytes).toBeLessThanOrEqual(2048);
  });

  it("holds no input for tr", async () => {
    const run = await shellWith(limits).run("tr x y < long.txt | wc -c");
    expect(run).toMatchObject({ stdout: "4102\n", exitCode: 0 });
  });

  it("fails a seq operand whose digits exceed the budget", async () => {
    const run = await shellWith(limits).run("seq 1e999999 1e999999");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/retained-memory limit/);
  });

  it("fails an nl width that exceeds the budget", async () => {
    const run = await shellWith(limits).run("nl -w 100000 a.txt");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/retained-memory limit/);
  });
});

describe("explicit refusals", () => {
  it.each([
    ["cut --help", "cut: --help is not supported\n"],
    ["cut --version", "cut: --version is not supported\n"],
    ["tr -h", "tr: --help is not supported\n"],
    ["nl --help", "nl: --help is not supported\n"],
    ["nl -V", "nl: --version is not supported\n"],
    ["comm --help", "comm: --help is not supported\n"],
    ["seq --help", "seq: --help is not supported\n"],
    ["rev -h", "rev: -h is not supported\n"],
    ["rev --version", "rev: --version is not supported\n"],
    ["nl -b p^a a.txt", "nl: numbering style 'p^a' (a regular expression) is not supported\n"],
    ["seq -f %a 1", "seq: the %a directive is not supported\n"],
    ["seq 1 inf", "seq: the number 'inf' is not supported\n"],
    ["seq 0x10", "seq: the number '0x10' is not supported\n"],
  ])("%j", async (source, stderr) => {
    const run = await shell.run(source);
    expect(run).toMatchObject({ stdout: "", stderr, exitCode: 2 });
  });
});
