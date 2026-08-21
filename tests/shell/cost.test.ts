// The §7 targets from docs/plans/shell.md. These are the reason the shell
// exists: if a command costs what a tree walk costs, the whole design was
// pointless and tool calls would have been the better answer.
//
// Asserted at two tree sizes an order of magnitude apart, per the three-part
// done-check rule — a statement ceiling alone is beaten by an implementation
// that does nothing.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { WriteEntry } from "../../src/fs/types.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const ENCODER = new TextEncoder();

interface Fixture {
  shell: Shell;
  storage: SqliteTestStorage;
}

// Roughly the size of a real source file. It matters: with toy files the
// whole tree fits in one read budget, the lazy reads have nothing to skip,
// and a bounded search measures the same as an unbounded one — which would
// make this suite pass while proving nothing.
const BODY = "// filler line to give the file a realistic size\n".repeat(60);

function tree(fileCount: number): Fixture {
  const storage = new SqliteTestStorage();
  const fs = createFilesystem(new TestDatabase(storage), { now: () => 1_700_000_000_000 });
  const entries: WriteEntry[] = [];
  for (let index = 0; index < fileCount; index++) {
    const name = String(index).padStart(5, "0");
    entries.push({
      path: `/repo/src/mod${name}.ts`,
      // Every tenth file carries the needle, so twenty matches need about
      // two hundred candidates however large the tree is.
      bytes: ENCODER.encode(
        `export const value${index} = ${index};\n${BODY}${index % 10 === 0 ? "// NEEDLE here\n" : "// plain\n"}`,
      ),
    });
    entries.push({ path: `/repo/docs/page${name}.md`, bytes: ENCODER.encode(`# page ${index}\n`) });
  }
  fs.writeFiles(entries);
  return { shell: createShell({ fs, cwd: "/repo" }), storage };
}

function cost(fixture: Fixture, source: string): number {
  const before = fixture.storage.statementCount;
  const run = fixture.shell.run(source);
  if (run.exitCode > 1) throw new Error(`${source} failed: ${run.stderr}`);
  return fixture.storage.statementCount - before;
}

describe("a bounded search does not scale with the tree", () => {
  it("finds twenty matches at the same cost in a 10x bigger tree", () => {
    const small = tree(200);
    const large = tree(2_000);

    const command = "grep -rl NEEDLE /repo/src --include=*.ts | head -20";
    const smallCost = cost(small, command);
    const largeCost = cost(large, command);

    // Both must actually return twenty lines — a ceiling met by returning
    // nothing is not evidence.
    expect(small.shell.run(command).stdout.split("\n").filter(Boolean)).toHaveLength(20);
    expect(large.shell.run(command).stdout.split("\n").filter(Boolean)).toHaveLength(20);

    console.log(`grep|head -20: 200 files -> ${smallCost}, 2,000 files -> ${largeCost}`);
    // The claim: ten times the tree, the same cost.
    expect(largeCost).toBe(smallCost);
    expect(largeCost).toBeLessThanOrEqual(10);
  });

  it("stops the source when the consumer stops pulling", () => {
    // The scaling assertion, which is the one that cannot be faked: as the
    // tree grows the unbounded search costs more and the bounded one does
    // not. A ratio at a single size would only measure this fixture.
    const measured = [2_000, 6_000].map((size) => {
      const fixture = tree(size);
      return {
        size,
        bounded: cost(fixture, "grep -rl NEEDLE /repo/src --include=*.ts | head -20"),
        unbounded: cost(fixture, "grep -rl NEEDLE /repo/src --include=*.ts"),
      };
    });
    console.log(JSON.stringify(measured));

    const [small, large] = measured;
    if (small === undefined || large === undefined) throw new Error("no measurements");

    expect(small.bounded).toBeLessThan(small.unbounded);
    expect(large.bounded).toBeLessThan(large.unbounded);
    // Flat where it matters, growing where it must.
    expect(large.bounded).toBe(small.bounded);
    expect(large.unbounded).toBeGreaterThan(small.unbounded);
  });
});

describe("single-file reads are bounded by what was asked for", () => {
  it("heads and tails without reading the file", () => {
    const fixture = tree(10);
    const fs = createFilesystem(new TestDatabase(fixture.storage));
    // Bigger than one read budget on purpose: under it, `cat` is a single
    // batched read and beats a ranged one, and the test would prove nothing.
    const big = Array.from(
      { length: 60_000 },
      (_, index) => `line ${index} ${"padding ".repeat(8)}`,
    ).join("\n");
    fs.writeFiles([{ path: "/repo/big.log", bytes: ENCODER.encode(big) }]);

    // A 50,000-line file. Both must cost what a stat and one ranged read
    // cost, not what reading 600 KB costs.
    const headCost = cost(fixture, "head -5 big.log");
    const tailCost = cost(fixture, "tail -5 big.log");
    const wholeCost = cost(fixture, "cat big.log");
    console.log(`head ${headCost}, tail ${tailCost}, cat ${wholeCost}`);
    expect(headCost).toBeLessThan(wholeCost);
    expect(tailCost).toBeLessThan(wholeCost);
    expect(fixture.shell.run("head -1 big.log").stdout.startsWith("line 0 padding")).toBe(true);
    expect(fixture.shell.run("tail -1 big.log").stdout.startsWith("line 59999 padding")).toBe(true);
  });
});

describe("the cheap commands stay cheap", () => {
  const fixture = tree(100);

  it("costs a handful of statements each", () => {
    const measured = {
      ls: cost(fixture, "ls /repo/docs"),
      find: cost(fixture, "find /repo/src -name '*.ts'"),
      cat: cost(fixture, "cat /repo/src/mod00000.ts"),
      cd: cost(fixture, "cd /repo/src"),
      pwd: cost(fixture, "pwd"),
    };
    console.log(JSON.stringify(measured));
    // These are constants, which is the property that matters. They are not
    // 1 apiece because a path is resolved through every symlink on the way
    // before it reaches `fs_paths` — roughly half of each figure below is
    // that resolution, and it is the invariant the store is built on.
    expect(measured.ls).toBeLessThanOrEqual(6);
    // `find -name` lowers to one indexed GLOB on top of the resolution.
    expect(measured.find).toBeLessThanOrEqual(4);
    expect(measured.cat).toBeLessThanOrEqual(3);
    // One statTarget to validate, one row written.
    expect(measured.cd).toBeLessThanOrEqual(3);
    // Answered from the session cache: no query at all.
    expect(measured.pwd).toBe(0);
  });

  it("removes a subtree in a constant number of statements", () => {
    const small = tree(200);
    const large = tree(2_000);
    const smallCost = cost(small, "rm -r /repo/src");
    const largeCost = cost(large, "rm -r /repo/src");
    console.log(`rm -r: 200 files -> ${smallCost}, 2,000 files -> ${largeCost}`);
    expect(small.shell.run("ls /repo/src").exitCode).toBe(2);
    expect(large.shell.run("ls /repo/src").exitCode).toBe(2);
    expect(largeCost).toBe(smallCost);
  });
});

describe("bounds hold even when the agent forgets them", () => {
  it("truncates output rather than filling a context window", () => {
    const storage = new SqliteTestStorage();
    const fs = createFilesystem(new TestDatabase(storage));
    fs.writeFiles([
      { path: "/repo/huge.txt", bytes: ENCODER.encode("x".repeat(200_000)) },
      { path: "/repo/small.txt", bytes: ENCODER.encode("ok\n") },
    ]);
    const shell = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 1_000, maxOperations: 10_000, readBudget: 1_500_000 },
    });

    const run = shell.run("cat huge.txt");
    expect(run.truncated).toBe(true);
    expect(run.stdout).toHaveLength(1_000);
    // A run that fits is not marked.
    expect(shell.run("cat small.txt").truncated).toBe(false);
  });

  it("refuses to run away when the operation ceiling is hit", () => {
    const fixture = tree(2_000);
    const storage = fixture.storage;
    const fs = createFilesystem(new TestDatabase(storage));
    const shell = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 1_000_000, maxOperations: 3, readBudget: 1_000 },
    });
    const run = shell.run("grep -r NEEDLE /repo/src");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("filesystem operations");
  });
});
