import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitCliInput, GitCliRunner, GitCliRunOptions } from "../../src/git/cli/types.js";
import { createGit } from "../../src/git/client.js";
import { createGitCommand } from "../../src/git/shell.js";
import { Workspace } from "../../src/runtime/workspace.js";
import { type Command, result } from "../../src/shell/exec/context.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
interface GitShellFixture {
  readonly workspace: Workspace;
  readonly shell: Shell;
}
async function fixture(commits = 0): Promise<GitShellFixture> {
  let clock = 1577836800000;
  const workspace = new Workspace({
    storage: new SqliteTestStorage(),
    git: createGit(),
    defaultGitIdentity: IDENTITY,
    now: () => clock,
  });
  workspace.filesystem.mkdir("/repo");
  await workspace.git.init({ dir: "/repo" });
  for (let index = 1; index <= commits; index++) {
    workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode(`version ${index}\n`));
    await workspace.git.add({ dir: "/repo", paths: ["file.txt"] });
    await workspace.git.commit({ dir: "/repo", message: `commit ${index}` });
    clock += 1000;
  }
  const shell = createShell({
    fs: workspace.filesystem,
    cwd: "/repo",
    commands: new Map([["git", createGitCommand(workspace.git)]]),
  });
  return { workspace, shell };
}
describe("injected git command", () => {
  let subject: GitShellFixture;
  beforeEach(async () => {
    subject = await fixture(4);
  });
  it("runs status and bounded log pipelines without charging Git SQL as shell operations", async () => {
    subject.workspace.filesystem.writeFile("/repo/untracked.txt", ENCODER.encode("new\n"));
    expect(await subject.shell.run("git status --porcelain | wc -l")).toMatchObject({
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
      operations: 0,
    });
    const log = await subject.shell.run("git log --oneline | head -3");
    expect(log.exitCode, log.stderr).toBe(0);
    expect(log.stdout.trim().split("\n")).toHaveLength(3);
  });
  it("routes everyday repository, branch, revision, and index reads", async () => {
    expect(await subject.shell.run("git rev-parse --show-toplevel")).toMatchObject({
      stdout: "/repo\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await subject.shell.run("git branch --show-current")).toMatchObject({
      stdout: "main\n",
      exitCode: 0,
    });
    expect(await subject.shell.run("git branch --list | wc -l")).toMatchObject({
      stdout: "1\n",
      exitCode: 0,
    });
    expect(await subject.shell.run("git ls-files --cached")).toMatchObject({
      stdout: "file.txt\n",
      exitCode: 0,
    });
    expect((await subject.shell.run("git status")).stdout).toBe(
      "On branch main\nnothing to commit, working tree clean\n",
    );
  });
  it("redirects diff bytes atomically", async () => {
    subject.workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode("changed\n"));
    const expected = await subject.workspace.git.runCli({ argv: ["diff"], cwd: "/repo" });
    const run = await subject.shell.run("git diff > out.patch");
    expect(run).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(DECODER.decode(subject.workspace.filesystem.readFile("/repo/out.patch"))).toBe(
      expected.stdout,
    );
  });
  it("routes staged diff aliases without exposing later worktree edits", async () => {
    subject.workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode("staged\n"));
    await subject.workspace.git.add({ dir: "/repo", paths: ["file.txt"] });
    subject.workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode("unstaged\n"));
    const expected = await subject.workspace.git.runCli({
      argv: ["diff", "--cached"],
      cwd: "/repo",
    });

    expect(await subject.shell.run("git diff --staged")).toMatchObject({
      stdout: expected.stdout,
      stderr: "",
      exitCode: 0,
    });
    expect(expected.stdout).toContain("+staged");
    expect(expected.stdout).not.toContain("unstaged");
  });
  it("preserves exit status through AND-OR lists", async () => {
    expect(await subject.shell.run("git diff && echo clean")).toMatchObject({
      stdout: "clean\n",
      exitCode: 0,
    });
    expect(await subject.shell.run("git unknown && echo no || echo recovered")).toMatchObject({
      stdout: "recovered\n",
      exitCode: 0,
    });
  });
  it("preserves refusal diagnostics byte-for-byte, merged or dropped", async () => {
    const expected = await subject.workspace.git.runCli({ argv: ["push"], cwd: "/repo" });
    expect(await subject.shell.run("git push")).toMatchObject({
      stdout: "",
      stderr: expected.stderr,
      exitCode: expected.exitCode,
    });
    expect(await subject.shell.run("git push 2>&1")).toMatchObject({
      stdout: expected.stderr,
      stderr: "",
      exitCode: expected.exitCode,
    });
    expect(await subject.shell.run("git push 2>/dev/null")).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: expected.exitCode,
    });
  });
});
describe("git command shell seam", () => {
  it("forwards a supplied env snapshot and omits an absent env field", async () => {
    const inputs: GitCliInput[] = [];
    const runner: GitCliRunner = {
      async runCli(input) {
        inputs.push(input);
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      },
    };
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    workspace.filesystem.mkdir("/repo");
    const shell = createShell({
      fs: workspace.filesystem,
      cwd: "/repo",
      commands: new Map([["git", createGitCommand(runner)]]),
    });
    const env = {
      GIT_AUTHOR_NAME: "Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    };
    await shell.run("git diff");
    await shell.run("git diff", { env });
    expect(inputs[0]).toEqual({ argv: ["diff"], cwd: "/repo" });
    expect(inputs[1]).toEqual({ argv: ["diff"], cwd: "/repo", env });
    expect(inputs[1]?.env).not.toBe(env);
    expect(Object.isFrozen(inputs[1]?.env)).toBe(true);
  });
  it("commits with the caller's author and committer environment", async () => {
    const workspace = new Workspace({
      storage: new SqliteTestStorage(),
      git: createGit(),
      now: () => 1577836800000,
    });
    workspace.filesystem.mkdir("/repo");
    await workspace.git.init({ dir: "/repo" });
    workspace.filesystem.writeFile("/repo/file.txt", ENCODER.encode("content\n"));
    const shell = createShell({
      fs: workspace.filesystem,
      cwd: "/repo",
      commands: new Map([["git", createGitCommand(workspace.git)]]),
    });
    expect((await shell.run("git add file.txt")).exitCode).toBe(0);
    const committed = await shell.run("git commit -m identity", {
      env: {
        GIT_AUTHOR_NAME: "Shell Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Shell Committer",
        GIT_COMMITTER_EMAIL: "committer@example.com",
      },
    });
    expect(committed.exitCode, committed.stderr).toBe(0);
    expect(
      (
        await workspace.git.runCli({
          argv: ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"],
          cwd: "/repo",
        })
      ).stdout,
    ).toBe("Shell Author <author@example.com>\nShell Committer <committer@example.com>\n");
  });
  it("passes cwd, argv, demand, and exact destination ceilings to one runner", async () => {
    const calls: Array<{
      input: GitCliInput;
      options: GitCliRunOptions | undefined;
    }> = [];
    const runner: GitCliRunner = {
      async runCli(input, options) {
        calls.push({ input, options });
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      },
    };
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    workspace.filesystem.mkdir("/repo");
    const shell = createShell({
      fs: workspace.filesystem,
      cwd: "/repo",
      commands: new Map([["git", createGitCommand(runner)]]),
      limits: {
        maxOutputBytes: 20,
        maxOperations: 100,
        readBudget: 100,
        maxRetainedBytes: 100,
      },
    });
    await shell.run("echo 1234; git diff");
    await shell.run("git log | head -3");
    await shell.run("git diff > patch");
    await shell.run("git push 2>&1");
    await shell.run("git push 2>/dev/null");
    expect(calls[0]).toEqual({
      input: { argv: ["diff"], cwd: "/repo" },
      options: {
        maxStdoutBytes: 15,
        maxStderrBytes: 20,
        maxCombinedOutputBytes: 35,
        discardStderr: false,
      },
    });
    expect(calls[1]).toEqual({
      input: { argv: ["log"], cwd: "/repo" },
      options: {
        maxStdoutBytes: 97,
        maxStderrBytes: 20,
        maxCombinedOutputBytes: 117,
        discardStderr: false,
        logLimitHint: 3,
      },
    });
    expect(calls[2]?.options).toEqual({
      maxStdoutBytes: 96,
      maxStderrBytes: 20,
      maxCombinedOutputBytes: 116,
      discardStderr: false,
    });
    expect(calls[3]?.options).toEqual({
      maxStdoutBytes: 20,
      maxStderrBytes: 20,
      maxCombinedOutputBytes: 20,
      discardStderr: false,
    });
    expect(calls[4]?.options).toEqual({
      maxStdoutBytes: 20,
      maxStderrBytes: 0,
      maxCombinedOutputBytes: 20,
      discardStderr: true,
    });
  });
  it("closes an ignored pipeline stdin without reading it", async () => {
    const probe = new ProbeStream();
    const source: Command = () => result(probe);
    const runner: GitCliRunner = {
      async runCli() {
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      },
    };
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const shell = createShell({
      fs: workspace.filesystem,
      commands: new Map([
        ["source", source],
        ["git", createGitCommand(runner)],
      ]),
    });
    expect((await shell.run("source | git diff")).exitCode).toBe(0);
    expect(probe.reads).toBe(0);
    expect(probe.closes).toBe(1);
  });
  it("merges raw stdout and stderr without rewriting either stream", async () => {
    const runner: GitCliRunner = {
      async runCli() {
        return {
          stdout: "stdout\n",
          stderr: "first\nsecond\n",
          exitCode: 7,
          truncated: false,
        };
      },
    };
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const shell = createShell({
      fs: workspace.filesystem,
      commands: new Map([["git", createGitCommand(runner)]]),
    });
    expect(await shell.run("git diff 2>&1")).toMatchObject({
      stdout: "stdout\nfirst\nsecond\n",
      stderr: "",
      exitCode: 7,
    });
  });
  it("propagates a pre-truncated Git result when the shell sink has room", async () => {
    const runner: GitCliRunner = {
      async runCli() {
        return { stdout: "short\n", stderr: "", exitCode: 0, truncated: true };
      },
    };
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const shell = createShell({
      fs: workspace.filesystem,
      commands: new Map([["git", createGitCommand(runner)]]),
    });

    expect(await shell.run("git status --short")).toMatchObject({
      stdout: "short\n",
      truncated: true,
      exitCode: 0,
    });
  });
  it.each([
    { source: "git diff | ignore; reserve", stderr: "err\n" },
    { source: "git diff 2>&1 | head -0; reserve", stderr: "" },
    { source: "git diff | ignore < input; reserve", stderr: "err\n" },
  ])(
    "settles an unpulled Git output before the next retained command: $source",
    async ({ source, stderr }) => {
      const runner: GitCliRunner = {
        async runCli() {
          return { stdout: "out\n", stderr: "err\n", exitCode: 0, truncated: false };
        },
      };
      const ignore: Command = () => result((function* () {})());
      const reserve: Command = (context) => {
        const release = context.fs.retained.retain(16, "post-git command");
        release();
        return result((function* () {})());
      };
      const workspace = new Workspace({ storage: new SqliteTestStorage() });
      workspace.filesystem.writeFile("/input", new Uint8Array(0));
      const shell = createShell({
        fs: workspace.filesystem,
        commands: new Map([
          ["git", createGitCommand(runner)],
          ["ignore", ignore],
          ["reserve", reserve],
        ]),
        limits: {
          maxOutputBytes: 100,
          maxOperations: 100,
          readBudget: 100,
          maxRetainedBytes: 16,
        },
      });
      expect(await shell.run(source)).toMatchObject({ stdout: "", stderr, exitCode: 0 });
    },
  );
  it("classifies structurally shaped Git limits without Error identity", async () => {
    const foreign: unknown = runInNewContext(
      'Object.assign(new Error("git CLI stderr exceeds 2 bytes"), { code: "E2BIG" })',
    );
    const cases: ReadonlyArray<{
      readonly error: unknown;
      readonly limit: "arguments" | "output";
      readonly message: string;
    }> = [
      {
        error: { code: "E2BIG", message: "git CLI stdout exceeds 1 bytes" },
        limit: "output",
        message: "git CLI stdout exceeds 1 bytes",
      },
      {
        error: foreign,
        limit: "output",
        message: "git CLI stderr exceeds 2 bytes",
      },
      {
        error: { code: "E2BIG", message: "git CLI combined output exceeds 3 bytes" },
        limit: "output",
        message: "git CLI combined output exceeds 3 bytes",
      },
      {
        error: { code: "E2BIG", message: "git CLI argv exceeds 256 entries" },
        limit: "arguments",
        message: "git CLI argv exceeds 256 entries",
      },
    ];
    for (const entry of cases) {
      let caught: unknown;
      const runner: GitCliRunner = {
        async runCli() {
          throw entry.error;
        },
      };
      const inspect: Command = async (context) => {
        try {
          return await createGitCommand(runner)(context);
        } catch (error) {
          caught = error;
          throw error;
        }
      };
      const workspace = new Workspace({ storage: new SqliteTestStorage() });
      const shell = createShell({
        fs: workspace.filesystem,
        commands: new Map([["inspect", inspect]]),
      });
      expect(await shell.run("inspect diff")).toMatchObject({
        stderr: `kompjutr: ${entry.message}\n`,
        exitCode: 2,
      });
      expect(caught).toMatchObject({
        name: "ShellLimitError",
        limit: entry.limit,
        message: entry.message,
      });
    }
  });
  it("preserves non-E2BIG and malformed exception identity", async () => {
    const originals: readonly unknown[] = [
      { code: "EIO", message: "coded" },
      { code: "E2BIG", message: 42 },
      new Error("unrecognized"),
    ];
    for (const original of originals) {
      const runner: GitCliRunner = {
        async runCli() {
          throw original;
        },
      };
      const workspace = new Workspace({ storage: new SqliteTestStorage() });
      const shell = createShell({
        fs: workspace.filesystem,
        commands: new Map([["git", createGitCommand(runner)]]),
      });
      let caught: unknown;
      try {
        await shell.run("git diff");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(original);
    }
  });
});
class ProbeStream implements IterableIterator<Uint8Array, void, undefined> {
  reads = 0;
  closes = 0;
  [Symbol.iterator](): IterableIterator<Uint8Array, void, undefined> {
    return this;
  }
  [Symbol.dispose](): void {
    this.return();
  }
  next(..._args: [] | [undefined]): IteratorResult<Uint8Array, void> {
    this.reads++;
    return { done: false, value: ENCODER.encode("unread\n") };
  }
  return(_value?: undefined): IteratorResult<Uint8Array, void> {
    this.closes++;
    return { done: true, value: undefined };
  }
  throw(error: unknown): IteratorResult<Uint8Array, void> {
    throw error;
  }
}
