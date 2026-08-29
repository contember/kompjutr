import { describe, expect, it, vi } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import type { GitCliRunner } from "../../src/git/cli/types.js";
import { createGitCommand } from "../../src/git/shell.js";
import type { ByteStream } from "../../src/shell/exec/bytes.js";
import { type Command, result } from "../../src/shell/exec/context.js";
import { RunInputOwner } from "../../src/shell/exec/execute.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const STDIN_BYTES_MAX = 1024 * 1024;
const ENV_ENTRY_MAX = 256;
const ENV_BYTES_MAX = 1024 * 1024;
const ENCODER = new TextEncoder();

interface Fixture {
  readonly filesystem: Filesystem;
  readonly shell: Shell;
}

function fixture(commands?: ReadonlyMap<string, Command>): Fixture {
  const filesystem = createFilesystem(new TestDatabase(new SqliteTestStorage()));
  filesystem.mkdir("/repo");
  filesystem.writeFile("/repo/input.txt", ENCODER.encode("file input\n"));
  return {
    filesystem,
    shell: createShell({ fs: filesystem, cwd: "/repo", commands }),
  };
}

function empty(): ByteStream {
  return (function* (): ByteStream {})();
}

describe("caller stdin", () => {
  it("matches a redirect for text and stays byte-exact for binary input", () => {
    const subject = fixture();
    const redirected = subject.shell.exec("cat < input.txt");

    expect(subject.shell.exec("cat", { stdin: "file input\n" }).stdout).toEqual(redirected.stdout);
    expect(subject.shell.exec("cat", { stdin: new Uint8Array([0, 255, 10]) }).stdout).toEqual(
      new Uint8Array([0, 255, 10]),
    );
    expect(subject.shell.run("cat | wc -c", { stdin: "four" }).stdout).toBe("4\n");
  });

  it("shares one cursor across selected pipelines without replaying consumed bytes", () => {
    const subject = fixture();

    expect(subject.shell.run("true; cat", { stdin: "left\n" }).stdout).toBe("left\n");
    expect(subject.shell.run("cat; cat", { stdin: "once\n" }).stdout).toBe("once\n");
    expect(subject.shell.run("false && cat; cat", { stdin: "selected\n" }).stdout).toBe(
      "selected\n",
    );
  });

  it("keeps caller stdin after a redirect, command miss, and early downstream close", () => {
    const subject = fixture();

    expect(subject.shell.run("cat < input.txt; cat", { stdin: "caller\n" }).stdout).toBe(
      "file input\ncaller\n",
    );
    expect(subject.shell.run("missing || cat", { stdin: "fallback\n" })).toMatchObject({
      stdout: "fallback\n",
      exitCode: 0,
    });
    expect(subject.shell.run("cat | head -0; cat", { stdin: "unpulled\n" }).stdout).toBe(
      "unpulled\n",
    );
  });

  it("lets repeated borrow closes and the Git adapter leave the owner for a later pipeline", () => {
    const closeTwice: Command = (context) => {
      context.stdin?.return();
      context.stdin?.return();
      return result(empty());
    };
    const runner: GitCliRunner = {
      runCli() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const subject = fixture(
      new Map([
        ["close-twice", closeTwice],
        ["git", createGitCommand(runner)],
      ]),
    );

    expect(subject.shell.run("close-twice; cat", { stdin: "borrowed\n" }).stdout).toBe(
      "borrowed\n",
    );
    expect(subject.shell.run("git diff; cat", { stdin: "after git\n" }).stdout).toBe("after git\n");
  });

  it("snapshots caller-owned binary bytes before invoking a command", () => {
    const supplied = new Uint8Array([65, 10]);
    const mutate: Command = (context) => {
      supplied[0] = 66;
      return result(context.stdin ?? empty());
    };
    const subject = fixture(new Map([["mutate", mutate]]));

    expect(subject.shell.exec("mutate", { stdin: supplied }).stdout).toEqual(
      new Uint8Array([65, 10]),
    );
  });

  it("closes the run owner exactly once across every execution path", () => {
    const failure = new Error("boom");
    const boom: Command = () => {
      throw failure;
    };
    const closeTwice: Command = (context) => {
      context.stdin?.return();
      context.stdin?.return();
      return result(empty());
    };
    const runner: GitCliRunner = {
      runCli() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const subject = fixture(
      new Map([
        ["boom", boom],
        ["close-twice", closeTwice],
        ["git", createGitCommand(runner)],
      ]),
    );
    const close = vi.spyOn(RunInputOwner.prototype, "close");

    try {
      expect(subject.shell.run("true", { stdin: "ok" }).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
      expect(subject.shell.run("missing || cat", { stdin: "fallback" }).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(2);
      expect(subject.shell.run("cat | head -0", { stdin: "early" }).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(3);
      expect(subject.shell.run("cat < input.txt", { stdin: "redirected" }).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(4);
      expect(subject.shell.run("close-twice", { stdin: "borrowed" }).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(5);
      expect(subject.shell.run("git diff", { stdin: "git" }).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(6);
      expect(() => subject.shell.run("boom", { stdin: "fail" })).toThrow(failure);
      expect(close).toHaveBeenCalledTimes(7);
    } finally {
      close.mockRestore();
    }
  });

  it("parses before creating or measuring a run input", () => {
    const subject = fixture();
    const close = vi.spyOn(RunInputOwner.prototype, "close");
    const env: Record<string, string> = {};
    for (let index = 0; index <= ENV_ENTRY_MAX; index++) env[`K${index}`] = "";
    const run = subject.shell.run("'unterminated", {
      stdin: new Uint8Array(STDIN_BYTES_MAX + 1),
      env,
    });

    expect(run).toMatchObject({ exitCode: 2, operations: 0, peakRetainedBytes: 0 });
    expect(run.stderr).toContain("unterminated single quote");
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it("accepts the exact byte cap and rejects its first excess before work", () => {
    let calls = 0;
    const called: Command = () => {
      calls++;
      return result(empty());
    };
    const exact = createShell({
      fs: fixture().filesystem,
      cwd: "/repo",
      commands: new Map([["called", called]]),
      limits: {
        maxOutputBytes: 1_000_000,
        maxOperations: 10,
        readBudget: 1_000,
        maxRetainedBytes: STDIN_BYTES_MAX,
      },
    });

    expect(exact.run("called", { stdin: new Uint8Array(STDIN_BYTES_MAX) })).toMatchObject({
      exitCode: 0,
      operations: 0,
      peakRetainedBytes: STDIN_BYTES_MAX,
    });
    expect(calls).toBe(1);

    const excess = exact.run("called", { stdin: new Uint8Array(STDIN_BYTES_MAX + 1) });
    expect(excess).toMatchObject({ exitCode: 2, operations: 0, peakRetainedBytes: 0 });
    expect(excess.stderr).toContain("caller stdin exceeds");
    expect(calls).toBe(1);
  });

  it("measures UTF-8 before encoding and enforces configured retained memory", () => {
    const subject = fixture();
    const exact = `${"a".repeat(STDIN_BYTES_MAX - 4)}😀`;

    expect(subject.shell.run("true", { stdin: exact }).peakRetainedBytes).toBe(STDIN_BYTES_MAX);
    expect(subject.shell.run("true", { stdin: `${exact}a` })).toMatchObject({
      exitCode: 2,
      operations: 0,
      peakRetainedBytes: 0,
    });

    let called = false;
    const retained = createShell({
      fs: subject.filesystem,
      cwd: "/repo",
      commands: new Map([
        [
          "called",
          () => {
            called = true;
            return result(empty());
          },
        ],
      ]),
      limits: {
        maxOutputBytes: 1_000,
        maxOperations: 10,
        readBudget: 1_000,
        maxRetainedBytes: 3,
      },
    });
    expect(retained.run("called", { stdin: "four" })).toMatchObject({
      exitCode: 2,
      operations: 0,
      peakRetainedBytes: 0,
    });
    expect(called).toBe(false);
  });

  it("preserves behavior when run options are absent", () => {
    const subject = fixture();

    expect(subject.shell.run("pwd")).toEqual(subject.shell.run("pwd", {}));
  });
});

describe("caller environment", () => {
  it("provides one frozen snapshot to direct and nested injected commands", () => {
    const supplied: Record<string, string> = { VALUE: "before" };
    Object.setPrototypeOf(supplied, { INHERITED: "excluded" });
    let direct: Readonly<Record<string, string>> | undefined;
    let nested: Readonly<Record<string, string>> | undefined;
    const inspect: Command = (context) => {
      direct = context.env;
      supplied.VALUE = "after";
      supplied.ADDED = "later";
      return result(empty());
    };
    const inner: Command = (context) => {
      nested = context.env;
      return result(empty());
    };
    const outer: Command = (context) => context.invoke("inner", []) ?? result(empty());
    const subject = fixture(
      new Map([
        ["inspect", inspect],
        ["inner", inner],
        ["outer", outer],
      ]),
    );

    expect(subject.shell.run("inspect; outer", { env: supplied }).exitCode).toBe(0);
    expect(direct).toEqual({ VALUE: "before" });
    expect(direct?.INHERITED).toBeUndefined();
    expect(nested).toBe(direct);
    expect(Object.isFrozen(direct)).toBe(true);

    subject.shell.run("inspect");
    expect(direct).toBeUndefined();
  });

  it("accepts exact entry and UTF-8 byte caps and rejects their first excesses", () => {
    let calls = 0;
    const called: Command = () => {
      calls++;
      return result(empty());
    };
    const subject = fixture(new Map([["called", called]]));
    const exactEntries: Record<string, string> = {};
    const excessEntries: Record<string, string> = {};
    for (let index = 0; index < ENV_ENTRY_MAX; index++) exactEntries[`K${index}`] = "";
    for (let index = 0; index <= ENV_ENTRY_MAX; index++) excessEntries[`K${index}`] = "";

    expect(subject.shell.run("called", { env: exactEntries }).exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(subject.shell.run("called", { env: excessEntries })).toMatchObject({
      exitCode: 2,
      operations: 0,
      peakRetainedBytes: 0,
    });
    expect(calls).toBe(1);

    const exactBytes = { K: `${"a".repeat(ENV_BYTES_MAX - 5)}😀` };
    expect(subject.shell.run("called", { env: exactBytes })).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: ENV_BYTES_MAX,
    });
    expect(calls).toBe(2);
    expect(subject.shell.run("called", { env: { ...exactBytes, X: "" } })).toMatchObject({
      exitCode: 2,
      operations: 0,
      peakRetainedBytes: 0,
    });
    expect(calls).toBe(2);
  });

  it("reserves env and stdin together before allocating either snapshot", () => {
    const subject = fixture();
    const withLimit = (maxRetainedBytes: number): Shell =>
      createShell({
        fs: subject.filesystem,
        cwd: "/repo",
        limits: {
          maxOutputBytes: 100,
          maxOperations: 10,
          readBudget: 100,
          maxRetainedBytes,
        },
      });
    const close = vi.spyOn(RunInputOwner.prototype, "close");

    try {
      expect(withLimit(4).run("true", { env: { A: "bbb" } })).toMatchObject({
        exitCode: 0,
        peakRetainedBytes: 4,
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(withLimit(3).run("true", { env: { A: "bbb" } })).toMatchObject({
        exitCode: 2,
        peakRetainedBytes: 0,
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(withLimit(4).run("true", { stdin: "xy", env: { A: "b" } })).toMatchObject({
        exitCode: 0,
        peakRetainedBytes: 4,
      });
      expect(close).toHaveBeenCalledTimes(2);
      expect(withLimit(3).run("true", { stdin: "xy", env: { A: "b" } })).toMatchObject({
        exitCode: 2,
        peakRetainedBytes: 0,
      });
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });
});
