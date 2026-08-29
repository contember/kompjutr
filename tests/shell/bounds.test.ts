// The branches that only run at a boundary.
//
// Both of these are fallbacks: code that exists because a limit elsewhere
// can be crossed, and that therefore never runs in a small fixture. A
// fallback nothing exercises is a fallback nobody knows is broken.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem, ScanEntry } from "../../src/fs/types.js";
import { createGit } from "../../src/git/client.js";
import { createGitCommand } from "../../src/git/shell.js";
import { Workspace } from "../../src/runtime/workspace.js";
import { encode } from "../../src/shell/exec/bytes.js";
import { type Command, result } from "../../src/shell/exec/context.js";
import { sqlGlobFor } from "../../src/shell/exec/glob.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

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

  it("cp -r never reads file bodies into the shell", () => {
    const guarded: Filesystem = {
      ...fs,
      readFile: () => {
        throw new Error("shell retained a file body");
      },
      readFiles: () => {
        throw new Error("shell retained file bodies");
      },
    };
    const guardedShell = createShell({ fs: guarded, cwd: "/repo" });

    expect(guardedShell.run("cp -r /repo/src /repo/copy").exitCode).toBe(0);
    expect(fs.stat("/repo/copy/f01199.ts")?.type).toBe("file");
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
  it("accepts the exact path cap and fails closed on the first path beyond it", () => {
    fs.writeFiles(
      Array.from({ length: 10_000 }, (_, index) => ({
        path: `/repo/glob/f${String(index).padStart(5, "0")}.txt`,
        bytes: new Uint8Array(0),
      })),
    );

    expect(shell.run("true /repo/glob/*.txt").exitCode).toBe(0);
    fs.writeFile("/repo/glob/f10000.txt", new Uint8Array(0));
    const run = shell.run("echo /repo/glob/*.txt");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("E2BIG");
  });
});

describe("retained-memory bounds", () => {
  const chunks: Command = (context) =>
    result(
      (function* () {
        for (const argument of context.argv) yield encode(argument);
      })(),
    );

  it("caps stderr independently from stdout", () => {
    const warn: Command = (context) => {
      context.warn("x".repeat(100));
      return result((function* () {})());
    };
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([["warn", warn]]),
      limits: {
        maxOutputBytes: 32,
        maxOperations: 100,
        readBudget: 32,
        maxRetainedBytes: 64,
      },
    });

    const run = bounded.run("warn");
    expect(run.stderr).toHaveLength(32);
    expect(run.stdout).toBe("");
    expect(run.truncated).toBe(true);
  });

  it("accepts stderr at its exact public limit", () => {
    const warn: Command = (context) => {
      context.warn("x".repeat(25));
      return result((function* () {})());
    };
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([["warn", warn]]),
      limits: {
        maxOutputBytes: 32,
        maxOperations: 100,
        readBudget: 32,
        maxRetainedBytes: 64,
      },
    });

    const run = bounded.run("warn");
    expect(run.stderr).toHaveLength(32);
    expect(run.truncated).toBe(false);
  });

  it("streams multi-file cat and redirects beyond the retained limit", () => {
    fs.writeFiles([
      { path: "/repo/a", bytes: ENCODER.encode("a".repeat(20)) },
      { path: "/repo/b", bytes: ENCODER.encode("b".repeat(20)) },
    ]);
    const bounded = createShell({
      fs,
      cwd: "/repo",
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 32,
        maxRetainedBytes: 32,
      },
    });

    const streamed = bounded.run("cat a b");
    expect(streamed.exitCode, streamed.stderr).toBe(0);
    expect(streamed.stdout).toBe(`${"a".repeat(20)}${"b".repeat(20)}`);
    const redirected = bounded.run("cat a b > combined");
    expect(redirected.exitCode, redirected.stderr).toBe(0);
    expect(redirected.stdout).toBe("");
    expect(new TextDecoder().decode(fs.readFile("/repo/combined"))).toBe(
      `${"a".repeat(20)}${"b".repeat(20)}`,
    );

    fs.writeFile("/repo/large", ENCODER.encode("x".repeat(40)));
    const small = createShell({
      fs,
      cwd: "/repo",
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 8,
        maxRetainedBytes: 8,
      },
    });
    expect(small.run("cat large")).toMatchObject({ stdout: "x".repeat(40), exitCode: 0 });
  });

  it("accepts xargs at the exact limit and rejects the first byte over", () => {
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([["chunks", chunks]]),
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 8,
        maxRetainedBytes: 44,
      },
    });

    expect(bounded.run("chunks 12345678 | xargs echo")).toMatchObject({
      stdout: "12345678\n",
      exitCode: 0,
    });
    const over = bounded.run("chunks 123456789 | xargs echo");
    expect(over.exitCode).toBe(2);
    expect(over.stderr).toContain("retained-memory limit");
  });

  it("accepts a sort buffer at its exact limit and rejects the next input byte", () => {
    const one: Command = () =>
      result(
        (function* () {
          yield encode("a\n");
        })(),
      );
    const two: Command = () =>
      result(
        (function* () {
          yield encode("ab\n");
        })(),
      );
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([
        ["one", one],
        ["two", two],
      ]),
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 8,
        maxRetainedBytes: 3,
      },
    });

    expect(bounded.run("one | sort")).toMatchObject({ stdout: "a\n", exitCode: 0 });
    expect(bounded.run("two | sort").exitCode).toBe(2);
  });

  it("accepts line carry at its exact limit and rejects the next input byte", () => {
    const eight: Command = () =>
      result(
        (function* () {
          yield encode("1234");
          yield encode("5678");
        })(),
      );
    const nine: Command = () =>
      result(
        (function* () {
          yield encode("1234");
          yield encode("56789");
        })(),
      );
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([
        ["eight", eight],
        ["nine", nine],
      ]),
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 16,
        maxRetainedBytes: 25,
      },
    });

    expect(bounded.run("eight | grep 1")).toMatchObject({ stdout: "12345678\n", exitCode: 0 });
    expect(bounded.run("nine | grep 1").exitCode).toBe(2);
  });

  it("bounds growing head and tail probes at their exact limits", () => {
    fs.writeFiles([{ path: "/repo/probe", bytes: ENCODER.encode("xxxx") }]);
    const headBounded = createShell({
      fs,
      cwd: "/repo",
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 16,
        maxRetainedBytes: 11,
      },
    });
    const tailBounded = createShell({
      fs,
      cwd: "/repo",
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 16,
        maxRetainedBytes: 19,
      },
    });

    expect(headBounded.run("head -1 probe")).toMatchObject({ stdout: "xxxx", exitCode: 0 });
    expect(tailBounded.run("tail -1 probe")).toMatchObject({ stdout: "xxxx\n", exitCode: 0 });

    fs.writeFile("/repo/probe", ENCODER.encode("xxxxx"));
    expect(headBounded.run("head -1 probe").exitCode).toBe(2);
    expect(tailBounded.run("tail -1 probe").exitCode).toBe(2);
  });

  it("rolls a redirect back when an upstream retained limit fails", () => {
    fs.writeFiles([{ path: "/repo/target", bytes: ENCODER.encode("old") }]);
    const failLate: Command = (context) =>
      result(
        (function* () {
          yield encode("partial");
          const release = context.fs.retained.retain(100, "late failure");
          release();
        })(),
      );
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([["fail-late", failLate]]),
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 8,
        maxRetainedBytes: 8,
      },
    });

    const run = bounded.run("fail-late > target");
    expect(run.exitCode).toBe(2);
    expect(new TextDecoder().decode(fs.readFile("/repo/target"))).toBe("old");
  });

  it("does not normalize an injected coded exception during a redirect", () => {
    fs.writeFiles([{ path: "/repo/target", bytes: ENCODER.encode("old") }]);
    const broken: Command = () =>
      result(
        (function* () {
          yield encode("partial");
          throw Object.assign(new Error("injected failure"), { code: "EBUG" });
        })(),
      );
    const bounded = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([["broken", broken]]),
    });

    expect(() => bounded.run("broken > target")).toThrow("injected failure");
    expect(new TextDecoder().decode(fs.readFile("/repo/target"))).toBe("old");
  });
});

describe("git destination preflight", () => {
  it("rolls a commit back before direct terminal output overflows", async () => {
    const subject = await stagedGit();
    const bounded = gitShell(subject.workspace, {
      maxOutputBytes: 1,
      maxOperations: 100,
      readBudget: 100,
      maxRetainedBytes: 1_000,
    });

    const run = bounded.run("git commit -m overflow");

    expect(run).toMatchObject({ stdout: "", exitCode: 2 });
    await expectUnchanged(subject);
  });

  it("rolls a commit back before an upstream pipeline output overflows", async () => {
    const subject = await stagedGit();
    const bounded = gitShell(subject.workspace, {
      maxOutputBytes: 1_000,
      maxOperations: 100,
      readBudget: 100,
      maxRetainedBytes: 64,
    });

    const run = bounded.run("git commit -m overflow | head -1");

    expect(run).toMatchObject({ stdout: "", exitCode: 2 });
    await expectUnchanged(subject);
  });

  it("rolls a commit and redirect back before redirected output overflows", async () => {
    const subject = await stagedGit();
    subject.workspace.filesystem.writeFile("/repo/result", ENCODER.encode("old"));
    const expectedStatus = await subject.workspace.git.status({ dir: "/repo" });
    const bounded = gitShell(subject.workspace, {
      maxOutputBytes: 1_000,
      maxOperations: 100,
      readBudget: 100,
      maxRetainedBytes: 64,
    });

    const run = bounded.run("git commit -m overflow > result");

    expect(run).toMatchObject({ stdout: "", exitCode: 2 });
    expect(new TextDecoder().decode(subject.workspace.filesystem.readFile("/repo/result"))).toBe(
      "old",
    );
    expect(await subject.workspace.git.log({ dir: "/repo" })).toEqual(subject.log);
    expect(await subject.workspace.git.status({ dir: "/repo" })).toEqual(expectedStatus);
  });

  it("publishes no partial Git refusal when direct stderr exceeds the sink", async () => {
    const subject = await stagedGit();
    const bounded = gitShell(subject.workspace, {
      maxOutputBytes: 12,
      maxOperations: 100,
      readBudget: 100,
      maxRetainedBytes: 1_000,
    });

    const run = bounded.run("git push");

    expect(run).toMatchObject({ stdout: "", exitCode: 2, truncated: true });
    expect(run.stderr).not.toContain("No configured push destination");
    await expectUnchanged(subject);
  });

  it("does not charge dropped Git stderr to a zero-byte sink", async () => {
    const subject = await stagedGit();
    const bounded = gitShell(subject.workspace, {
      maxOutputBytes: 0,
      maxOperations: 100,
      readBudget: 100,
      maxRetainedBytes: 1_000,
    });

    const run = bounded.run("git push 2>/dev/null");

    expect(run).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 128,
      truncated: false,
    });
    await expectUnchanged(subject);
  });
});

interface StagedGit {
  readonly workspace: Workspace;
  readonly log: Awaited<ReturnType<Workspace["git"]["log"]>>;
  readonly status: Awaited<ReturnType<Workspace["git"]["status"]>>;
}

async function stagedGit(): Promise<StagedGit> {
  const workspace = new Workspace({
    storage: new SqliteTestStorage(),
    git: createGit(),
    defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    now: () => 1_577_836_800_000,
  });
  workspace.filesystem.mkdir("/repo");
  await workspace.git.init({ dir: "/repo" });
  workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode("base\n"));
  await workspace.git.add({ dir: "/repo", paths: ["file.txt"] });
  await workspace.git.commit({ dir: "/repo", message: "base" });
  workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode("changed\n"));
  await workspace.git.add({ dir: "/repo", paths: ["file.txt"] });
  return {
    workspace,
    log: await workspace.git.log({ dir: "/repo" }),
    status: await workspace.git.status({ dir: "/repo" }),
  };
}

function gitShell(
  workspace: Workspace,
  limits: Parameters<typeof createShell>[0]["limits"],
): Shell {
  return createShell({
    fs: workspace.filesystem,
    cwd: "/repo",
    commands: new Map([["git", createGitCommand(workspace.git)]]),
    limits,
  });
}

async function expectUnchanged(subject: StagedGit): Promise<void> {
  expect(await subject.workspace.git.log({ dir: "/repo" })).toEqual(subject.log);
  expect(await subject.workspace.git.status({ dir: "/repo" })).toEqual(subject.status);
}
