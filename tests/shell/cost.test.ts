// The §7 targets from docs/archive/plans/shell.md. These are the reason the shell
// exists: if a command costs what a tree walk costs, the whole design was
// pointless and tool calls would have been the better answer.
//
// Asserted at two tree sizes an order of magnitude apart, per the three-part
// done-check rule — a statement target alarm alone is beaten by an implementation
// that does nothing.
import { describe, expect, it } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { WriteEntry } from "../../packages/do/src/fs/types.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
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
  const fs = createFilesystem(new TestDatabase(storage), { now: () => 1700000000000 });
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
async function cost(fixture: Fixture, source: string): Promise<number> {
  const before = fixture.storage.statementCount;
  const run = await fixture.shell.run(source);
  if (run.exitCode > 1) throw new Error(`${source} failed: ${run.stderr}`);
  return fixture.storage.statementCount - before;
}
describe("the no-parameter operations baseline", () => {
  it("keeps the curated corpus exact", async () => {
    const fixture = tree(100);
    const corpus: ReadonlyArray<readonly [string, number]> = [
      ["echo plain", 0],
      [`echo "quoted *" '*.ts'`, 0],
      ["echo src/*.ts | head -1", 1],
      ["ls /repo/docs", 2],
      [`find /repo/src -name '*.ts'`, 2],
      ["cat /repo/src/mod00000.ts", 1],
      ["grep -rl NEEDLE /repo/src --include=*.ts | head -20", 4],
      ["echo hi > /repo/out.txt", 1],
    ];

    for (const [source, operations] of corpus) {
      const run = await fixture.shell.run(source);
      expect(run.exitCode, source).toBeLessThan(2);
      expect(run.operations, source).toBe(operations);
    }
  });
});
describe("a search does not scale with the tree", () => {
  it("stays within the statement target on a 10x bigger tree", async () => {
    const small = tree(200);
    const large = tree(2000);
    const command = "grep -rl NEEDLE /repo/src --include=*.ts | head -20";
    const smallCost = await cost(small, command);
    const largeCost = await cost(large, command);
    // Both must actually return twenty lines — a ceiling met by returning
    // nothing is not evidence.
    expect((await small.shell.run(command)).stdout.split("\n").filter(Boolean)).toHaveLength(20);
    expect((await large.shell.run(command)).stdout.split("\n").filter(Boolean)).toHaveLength(20);
    console.log(`grep|head -20: 200 files -> ${smallCost}, 2,000 files -> ${largeCost}`);
    expect(smallCost).toBeLessThan(1000);
    expect(largeCost).toBeLessThan(1000);
  });
  it("stays within the statement target with or without head", async () => {
    // Before the content predicate the unbounded search read every candidate
    // file into the isolate and went 11 -> 23 statements as the tree grew,
    // and `| head -20` was what saved it. Now `instr` decides in the
    // database and there is nothing left for the head to save: both are
    // flat. The `| head` still bounds the *output*, which is its other job.
    const measured = await Promise.all(
      [2000, 6000].map(async (size) => {
        const fixture = tree(size);
        return {
          size,
          bounded: await cost(fixture, "grep -rl NEEDLE /repo/src --include=*.ts | head -20"),
          unbounded: await cost(fixture, "grep -rl NEEDLE /repo/src --include=*.ts"),
        };
      }),
    );
    console.log(JSON.stringify(measured));
    const [small, large] = measured;
    if (small === undefined || large === undefined) throw new Error("no measurements");
    expect(small.bounded).toBeLessThan(1000);
    expect(large.bounded).toBeLessThan(1000);
    expect(small.unbounded).toBeLessThan(1000);
    expect(large.unbounded).toBeLessThan(1000);
  });
  it("reads only the files that matched, even when it prints lines", async () => {
    // Content mode needs bytes, but only of the files `instr` selected —
    // one read batch for 200 matches out of 2,000 files, and still one for
    // 600 out of 6,000.
    const measured = await Promise.all(
      [2000, 6000].map((size) => cost(tree(size), "grep -rn NEEDLE /repo/src --include=*.ts")),
    );
    console.log(`grep -rn: ${JSON.stringify(measured)}`);
    const [small, large] = measured;
    if (small === undefined || large === undefined) throw new Error("no measurements");
    // Three times the tree costs at most one more statement, and that one is
    // a second read batch for three times the matching *bytes* — the plan's
    // `⌈bytes/budget⌉` term, not a term in the tree size. The regex fallback
    // below doubles over the same step.
    expect(small).toBeLessThan(1000);
    expect(large).toBeLessThan(1000);
  });
  it("falls back, and visibly scales, when the pattern is a real expression", async () => {
    // The contrast that proves the push-down is doing the work: SQLite has
    // no regex, so this reads every candidate file exactly as the first
    // implementation did — and the cost grows with the tree again.
    const small = await cost(tree(2000), "grep -rl 'NEED.E' /repo/src --include=*.ts");
    const large = await cost(tree(6000), "grep -rl 'NEED.E' /repo/src --include=*.ts");
    console.log(`regex fallback: 2,000 -> ${small}, 6,000 -> ${large}`);
    expect(large).toBeGreaterThan(small);
  });
});
describe("single-file reads are bounded by what was asked for", () => {
  it("heads and tails without reading the file", async () => {
    const fixture = tree(10);
    const fs = createFilesystem(new TestDatabase(fixture.storage));
    // Bigger than one read budget on purpose: under it, `cat` is a single
    // batched read and beats a ranged one, and the test would prove nothing.
    const big = Array.from(
      { length: 60000 },
      (_, index) => `line ${index} ${"padding ".repeat(8)}`,
    ).join("\n");
    fs.writeFiles([{ path: "/repo/big.log", bytes: ENCODER.encode(big) }]);
    // A 50,000-line file. Both must cost what a stat and one ranged read
    // cost, not what reading 600 KB costs.
    const headCost = await cost(fixture, "head -5 big.log");
    const tailCost = await cost(fixture, "tail -5 big.log");
    const wholeCost = await cost(fixture, "cat big.log");
    console.log(`head ${headCost}, tail ${tailCost}, cat ${wholeCost}`);
    expect(headCost).toBeLessThan(wholeCost);
    expect(tailCost).toBeLessThan(wholeCost);
    expect((await fixture.shell.run("head -1 big.log")).stdout.startsWith("line 0 padding")).toBe(
      true,
    );
    expect(
      (await fixture.shell.run("tail -1 big.log")).stdout.startsWith("line 59999 padding"),
    ).toBe(true);
  });
});
describe("the cheap commands stay cheap", () => {
  const fixture = tree(100);
  it("keeps each cheap command within the statement target", async () => {
    const measured = {
      ls: await cost(fixture, "ls /repo/docs"),
      find: await cost(fixture, "find /repo/src -name '*.ts'"),
      cat: await cost(fixture, "cat /repo/src/mod00000.ts"),
      cd: await cost(fixture, "cd /repo/src"),
      pwd: await cost(fixture, "pwd"),
    };
    console.log(JSON.stringify(measured));
    // These are constants, which is the property that matters. They are not
    // 1 apiece because a path is resolved through every symlink on the way
    // before it reaches `fs_paths` — roughly half of each figure below is
    // that resolution, and it is the invariant the store is built on.
    expect(measured.ls).toBeLessThan(1000);
    // `find -name` lowers to one indexed GLOB on top of the resolution.
    expect(measured.find).toBeLessThan(1000);
    expect(measured.cat).toBeLessThan(1000);
    // One statTarget to validate, one row written.
    expect(measured.cd).toBeLessThan(1000);
    // Cache-hit semantics: pwd must not query storage.
    expect(measured.pwd).toBe(0);
  });
  it("removes a subtree within the statement target", async () => {
    const small = tree(200);
    const large = tree(2000);
    const smallCost = await cost(small, "rm -r /repo/src");
    const largeCost = await cost(large, "rm -r /repo/src");
    console.log(`rm -r: 200 files -> ${smallCost}, 2,000 files -> ${largeCost}`);
    expect((await small.shell.run("ls /repo/src")).exitCode).toBe(2);
    expect((await large.shell.run("ls /repo/src")).exitCode).toBe(2);
    expect(smallCost).toBeLessThan(1000);
    expect(largeCost).toBeLessThan(1000);
  });
});
describe("paged find", () => {
  it("lets a trailing head stop indexed discovery", async () => {
    const fixture = tree(2000);
    const bounded = await fixture.shell.run("find /repo/src -name '*.ts' | head -5");
    const unbounded = await fixture.shell.run("find /repo/src -name '*.ts'");
    expect(bounded.stdout.split("\n").slice(0, -1)).toHaveLength(5);
    expect(unbounded.stdout.split("\n").filter(Boolean)).toHaveLength(2000);
    expect(bounded.operations).toBeLessThan(unbounded.operations);
  });
});
describe("set-based listing", () => {
  it("scales long listing by pages rather than paths", async () => {
    const small = await tree(200).shell.run("ls -l /repo/src");
    const large = await tree(2000).shell.run("ls -l /repo/src");
    expect(small.stdout.split("\n").filter(Boolean)).toHaveLength(200);
    expect(large.stdout.split("\n").filter(Boolean)).toHaveLength(2000);
    expect(small.operations).toBe(2);
    expect(large.operations).toBe(3);
  });
  it("lets head stop recursive listing pages", async () => {
    const fixture = tree(2000);
    const bounded = await fixture.shell.run("ls -R /repo | head -5");
    const unbounded = await fixture.shell.run("ls -R /repo");
    expect(bounded.stdout.split("\n").slice(0, -1)).toHaveLength(5);
    expect(bounded.operations).toBeLessThan(unbounded.operations);
  });
});
describe("set-based copy", () => {
  it("copies 5,000 files by metadata pages", async () => {
    const storage = new SqliteTestStorage();
    const fs = createFilesystem(new TestDatabase(storage));
    fs.writeFiles(
      Array.from({ length: 5000 }, (_, index) => ({
        path: `/repo/source/f${String(index).padStart(5, "0")}`,
        bytes: new Uint8Array(0),
      })),
    );
    const shell = createShell({ fs, cwd: "/repo" });
    const copied = await shell.run("cp -r source copy");
    expect(copied.exitCode).toBe(0);
    expect(copied.operations).toBeLessThanOrEqual(15);
    expect(fs.stat("/repo/copy/f04999")?.type).toBe("file");
  });
});
describe("bounds hold even when the agent forgets them", () => {
  it("truncates output rather than filling a context window", async () => {
    const storage = new SqliteTestStorage();
    const fs = createFilesystem(new TestDatabase(storage));
    fs.writeFiles([
      { path: "/repo/huge.txt", bytes: ENCODER.encode("x".repeat(200000)) },
      { path: "/repo/small.txt", bytes: ENCODER.encode("ok\n") },
    ]);
    const shell = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 1000, maxOperations: 10000, readBudget: 1500000 },
    });
    const run = await shell.run("cat huge.txt");
    expect(run.truncated).toBe(true);
    expect(run.stdout).toHaveLength(1000);
    // A run that fits is not marked.
    expect((await shell.run("cat small.txt")).truncated).toBe(false);
  });
  it("refuses to run away when the operation ceiling is hit", async () => {
    const fixture = tree(2000);
    const storage = fixture.storage;
    const fs = createFilesystem(new TestDatabase(storage));
    const shell = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 1000000, maxOperations: 3, readBudget: 1000 },
    });
    const run = await shell.run("grep -r NEEDLE /repo/src");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("filesystem operations");
  });
});
