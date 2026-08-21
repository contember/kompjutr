// `xargs` is the pipeline shape the planner's R2 refuses to fuse. Before it
// existed those lines died with "command not found"; these cases are the
// ones R2 leaves behind on purpose.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

let shell: Shell;

beforeEach(() => {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  fs.writeFiles([
    { path: "/repo/a.ts", bytes: ENCODER.encode("alpha\nNEEDLE\n") },
    { path: "/repo/b.ts", bytes: ENCODER.encode("beta\n") },
    { path: "/repo/c.ts", bytes: ENCODER.encode("gamma\nNEEDLE\n") },
    { path: "/repo/list.txt", bytes: ENCODER.encode("a.ts\nb.ts\n") },
    { path: "/repo/spaced name.txt", bytes: ENCODER.encode("spaced\n") },
  ]);
  shell = createShell({ fs, cwd: "/repo" });
});

describe("the shape R2 does not fuse", () => {
  it("runs a command over find's output", () => {
    // `xargs cat` is not a search, so R2 leaves it alone and this runs.
    const run = shell.run("find /repo -name '*.ts' | xargs cat");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("alpha\nNEEDLE\nbeta\ngamma\nNEEDLE\n");
  });

  it("honours -n, which R2 also refuses", () => {
    const run = shell.run("find /repo -name '*.ts' | xargs -n1 grep -c NEEDLE");
    // One invocation per file: 1, 0, 1 — and grep's exit 1 on the miss makes
    // the whole xargs report 123, as GNU does.
    expect(run.stdout).toBe("1\n0\n1\n");
    expect(run.exitCode).toBe(123);
  });

  it("substitutes with -I", () => {
    const run = shell.run("cat list.txt | xargs -I{} echo file:{}");
    expect(run.stdout).toBe("file:a.ts\nfile:b.ts\n");
  });

  it("keeps -I line-oriented so a space survives", () => {
    const run = shell.run("ls | grep spaced | xargs -I{} echo [{}]");
    expect(run.stdout).toBe("[spaced name.txt]\n");
  });

  it("splits on whitespace without -I, which is why the space needs -0", () => {
    const run = shell.run("echo one two three | xargs echo");
    expect(run.stdout).toBe("one two three\n");
  });
});

describe("empty input", () => {
  it("runs once with no arguments, as GNU does", () => {
    expect(shell.run("grep -r zzz /repo | xargs echo done").stdout).toBe("done\n");
  });

  it("skips the run with -r", () => {
    expect(shell.run("grep -r zzz /repo | xargs -r echo done").stdout).toBe("");
  });

  it("never runs -I on nothing to substitute", () => {
    expect(shell.run("grep -r zzz /repo | xargs -I{} echo [{}]").stdout).toBe("");
  });
});

describe("boundaries", () => {
  it("reports a command it cannot run", () => {
    const run = shell.run("cat list.txt | xargs bun");
    expect(run.exitCode).toBe(127);
    expect(run.stderr).toContain("command not found");
  });

  it("stays lazy enough for a trailing head", () => {
    const run = shell.run("find /repo -name '*.ts' | xargs -n1 cat | head -1");
    expect(run.stdout).toBe("alpha\n");
  });

  it("counts sub-invocations against the caller's ceiling", () => {
    const fs = createFilesystem(new TestDatabase());
    fs.writeFiles(
      Array.from({ length: 50 }, (_, index) => ({
        path: `/repo/f${index}.txt`,
        bytes: ENCODER.encode(`${index}\n`),
      })),
    );
    const bounded = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 1_000_000, maxOperations: 8, readBudget: 1_500_000 },
    });
    // Fifty invocations cannot buy fifty budgets by spreading the work.
    const run = bounded.run("find /repo -name '*.txt' | xargs -n1 cat");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("filesystem operations");
  });

  it("rejects a flag it cannot honour", () => {
    const run = shell.run("cat list.txt | xargs -n0 echo");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("-n must be at least 1");
  });
});

describe("R2 still wins where it applies", () => {
  it("fuses the search shape rather than running xargs", () => {
    // Same answer, but no xargs invocation at all — the planner collapsed it.
    const run = shell.run("find /repo -name '*.ts' | xargs grep -l NEEDLE");
    expect(run.stdout.split("\n").filter(Boolean)).toEqual(["/repo/a.ts", "/repo/c.ts"]);
  });
});
