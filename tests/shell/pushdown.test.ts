// The SQL content predicate is an optimisation, so the only thing that
// really matters about it is that it changes nothing. Every case here runs
// the same search twice — once where `instr` decides it, once forced down
// the read-and-match path — and demands the same answer.
//
// `-F` forces the fast path on a pattern that has metacharacters; wrapping
// the same pattern so it looks like an expression forces the slow one.
import { beforeEach, describe, expect, it } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import { CHUNK_SIZE } from "../../src/fs/schema.js";
import type { Filesystem } from "../../src/fs/types.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
let fs: Filesystem;
let shell: Shell;
beforeEach(() => {
  fs = createFilesystem(new TestDatabase(), { now: () => 1700000000000 });
  fs.writeFiles([
    { path: "/repo/a.ts", bytes: ENCODER.encode("one\nNEEDLE here\ntwo\n") },
    { path: "/repo/b.ts", bytes: ENCODER.encode("nothing\n") },
    { path: "/repo/sub/c.ts", bytes: ENCODER.encode("NEEDLE\nNEEDLE twice\n") },
    { path: "/repo/upper.ts", bytes: ENCODER.encode("needle in lower case\n") },
    { path: "/repo/dotted.ts", bytes: ENCODER.encode("NEED.E literal dot\n") },
  ]);
  shell = createShell({ fs, cwd: "/repo" });
});
/** The same search, both ways. `-F` takes the predicate; `[N]EEDLE` cannot. */
async function bothWays(flags: string, needle: string): Promise<[string, string]> {
  const fast = await shell.run(`grep ${flags} ${needle} /repo`);
  const slow = await shell.run(`grep ${flags} '[${needle.slice(0, 1)}]${needle.slice(1)}' /repo`);
  return [fast.stdout, slow.stdout];
}
describe("the fast path answers what the slow one would", () => {
  it("agrees on which files match", async () => {
    const [fast, slow] = await bothWays("-rl", "NEEDLE");
    expect(fast).toBe(slow);
    expect(fast.split("\n").filter(Boolean)).toEqual(["/repo/a.ts", "/repo/sub/c.ts"]);
  });
  it("agrees on the lines and their numbers", async () => {
    const [fast, slow] = await bothWays("-rn", "NEEDLE");
    expect(fast).toBe(slow);
    expect(fast).toContain("/repo/a.ts:2:NEEDLE here");
    expect(fast).toContain("/repo/sub/c.ts:2:NEEDLE twice");
  });
  it("agrees on counts", async () => {
    const [fast, slow] = await bothWays("-rc", "NEEDLE");
    expect(fast).toBe(slow);
  });
  it("agrees on context lines", async () => {
    const [fast, slow] = await bothWays("-rB1", "NEEDLE");
    expect(fast).toBe(slow);
    expect(fast).toContain("one");
  });
  it("agrees with an include filter", async () => {
    const fast = (await shell.run("grep -rl NEEDLE /repo --include=*.ts")).stdout;
    const slow = (await shell.run("grep -rl '[N]EEDLE' /repo --include=*.ts")).stdout;
    expect(fast).toBe(slow);
  });
  it("agrees when nothing matches, exit code included", async () => {
    const fast = await shell.run("grep -rl ZZZZ /repo");
    const slow = await shell.run("grep -rl '[Z]ZZZ' /repo");
    expect(fast.stdout).toBe(slow.stdout);
    expect(fast.exitCode).toBe(slow.exitCode);
    expect(fast.exitCode).toBe(1);
  });
});
describe("the predicate is not used where it would be wrong", () => {
  it("falls back for -i, since instr does not fold case", async () => {
    const run = await shell.run("grep -rli NEEDLE /repo");
    expect(run.stdout.split("\n").filter(Boolean).sort()).toEqual([
      "/repo/a.ts",
      "/repo/sub/c.ts",
      "/repo/upper.ts",
    ]);
  });
  it("falls back for -v, which asks about absence", async () => {
    const run = await shell.run("grep -rlv NEEDLE /repo");
    expect(run.stdout).toContain("/repo/b.ts");
    // a.ts has non-matching lines too, so -l with -v names it as well.
    expect(run.stdout).toContain("/repo/a.ts");
  });
  it("treats a regex metacharacter as a regex, not as bytes", async () => {
    // `NEED.E` must match `NEEDLE`, not only the file with a literal dot.
    const asRegex = (await shell.run("grep -rl 'NEED.E' /repo")).stdout.split("\n").filter(Boolean);
    expect(asRegex.sort()).toEqual(["/repo/a.ts", "/repo/dotted.ts", "/repo/sub/c.ts"]);
    // With -F the same pattern is bytes, and only the literal dot matches.
    const asBytes = (await shell.run("grep -rlF 'NEED.E' /repo")).stdout
      .split("\n")
      .filter(Boolean);
    expect(asBytes).toEqual(["/repo/dotted.ts"]);
  });
  it("uses the predicate for rg too, with rg's own dialect", async () => {
    expect(
      (await shell.run("rg -l NEEDLE /repo")).stdout.split("\n").filter(Boolean).sort(),
    ).toEqual(["/repo/a.ts", "/repo/sub/c.ts"]);
    // rg is always ERE, so `+` is an operator and must not go down the fast
    // path as bytes.
    expect((await shell.run("rg -l 'NEEDLE+' /repo")).exitCode).toBe(0);
    expect((await shell.run("rg -lF 'NEEDLE+' /repo")).exitCode).toBe(1);
  });
});
describe("the modes that reached the fast path later", () => {
  it("rg -c agrees with itself, since it omits the zero rows", async () => {
    // `grep -c` cannot use the predicate — it prints a row per file
    // searched, zeros included — but rg lists only matches, which is
    // exactly what the predicate returns.
    const fast = (await shell.run("rg -c NEEDLE /repo")).stdout;
    const slow = (await shell.run("rg -c '[N]EEDLE' /repo")).stdout;
    expect(fast).toBe(slow);
    expect(fast).not.toContain(":0");
  });
  it("rg skips a walked binary file on both paths", async () => {
    fs.writeFiles([
      { path: "/repo/bin.dat", bytes: new Uint8Array([78, 69, 69, 68, 76, 69, 0, 9]) },
    ]);
    const fast = (await shell.run("rg -l NEEDLE /repo")).stdout;
    const slow = (await shell.run("rg -l '[N]EEDLE' /repo")).stdout;
    expect(fast).toBe(slow);
    expect(fast).not.toContain("bin.dat");
    // grep, whose walk reports them, sees it on both paths too.
    expect((await shell.run("grep -rl NEEDLE /repo")).stdout).toContain("bin.dat");
    expect((await shell.run("grep -rl '[N]EEDLE' /repo")).stdout).toContain("bin.dat");
  });
  it("grep -L takes the slow path and still agrees", async () => {
    // The complement of a predicate that returns matches is not something
    // the predicate can answer, so this always walks. The answer is what
    // has to match.
    const [fast, slow] = await bothWays("-rL", "NEEDLE");
    expect(fast).toBe(slow);
    expect(fast.split("\n").filter(Boolean).sort()).toEqual([
      "/repo/b.ts",
      "/repo/dotted.ts",
      "/repo/upper.ts",
    ]);
  });
});
describe("the case the database cannot decide", () => {
  it("finds a needle straddling a chunk boundary", async () => {
    // `instr` sees one chunk at a time and would answer "no". The file comes
    // back undecided and is read, so the search still finds it.
    const head = "a".repeat(CHUNK_SIZE - 3);
    fs.writeFiles([{ path: "/repo/big.log", bytes: ENCODER.encode(`${head}NEEDLE\ntail\n`) }]);
    const run = await shell.run("grep -rl NEEDLE /repo");
    expect(run.stdout).toContain("/repo/big.log");
    // And the slow path agrees, which is the whole point.
    expect((await shell.run("grep -rl '[N]EEDLE' /repo")).stdout).toContain("/repo/big.log");
  });
  it("does not claim a multi-chunk file that has no match", async () => {
    fs.writeFiles([{ path: "/repo/big.log", bytes: ENCODER.encode("z".repeat(CHUNK_SIZE + 10)) }]);
    expect((await shell.run("grep -rl NEEDLE /repo")).stdout).not.toContain("big.log");
  });
});
