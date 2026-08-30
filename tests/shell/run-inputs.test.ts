import { describe, expect, it, vi } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import type { GitCliRunner } from "../../src/git/cli/types.js";
import { createGitCommand } from "../../src/git/shell.js";
import type { ByteStream } from "../../src/shell/exec/bytes.js";
import { type Command, RetainedBudget, result } from "../../src/shell/exec/context.js";
import { RunInputOwner } from "../../src/shell/exec/execute.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const FORMER_ARGUMENT_BYTES_MAX = 1_000_000;
const FORMER_STDIN_BYTES_MAX = 1024 * 1024;
const ENV_ENTRY_MAX = 256;
const FORMER_ENV_BYTES_MAX = 1024 * 1024;
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

  it("preserves a partially consumed byte or line suffix for a later pipeline", () => {
    const subject = fixture();

    expect(subject.shell.run("head -c 1; cat", { stdin: "abc" }).stdout).toBe("abc");
    expect(subject.shell.run("head -c 0; cat", { stdin: "abc" }).stdout).toBe("abc");
    expect(subject.shell.run("head -n 1; cat", { stdin: "first\nsecond\n" }).stdout).toBe(
      "first\nsecond\n",
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
      stdin: new Uint8Array(FORMER_STDIN_BYTES_MAX + 1),
      env,
    });

    expect(run).toMatchObject({ exitCode: 2, operations: 0, peakRetainedBytes: 0 });
    expect(run.stderr).toContain("unterminated single quote");
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it("accepts caller-owned stdin beyond the former component limit", () => {
    let calls = 0;
    const called: Command = () => {
      calls++;
      return result(empty());
    };
    const supplied = new Uint8Array(FORMER_STDIN_BYTES_MAX + 1);
    const shell = createShell({
      fs: fixture().filesystem,
      cwd: "/repo",
      commands: new Map([["called", called]]),
      limits: {
        maxOutputBytes: 1_000_000,
        maxOperations: 10,
        readBudget: 1_000,
        maxRetainedBytes: supplied.length,
      },
    });

    expect(shell.run("called", { stdin: supplied })).toMatchObject({
      exitCode: 0,
      operations: 0,
      peakRetainedBytes: supplied.length,
    });
    expect(calls).toBe(1);
  });

  it("measures UTF-8 before encoding and enforces configured retained memory", () => {
    const subject = fixture();
    const exact = `${"a".repeat(FORMER_STDIN_BYTES_MAX - 4)}😀`;

    expect(subject.shell.run("true", { stdin: exact }).peakRetainedBytes).toBe(
      FORMER_STDIN_BYTES_MAX,
    );
    expect(subject.shell.run("true", { stdin: `${exact}a` })).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: FORMER_STDIN_BYTES_MAX + 1,
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

  it("releases the shared input and pipeline owner on success, error, and early close", () => {
    let retained: RetainedBudget | undefined;
    const observe: Command = (context) => {
      retained = context.fs.retained;
      return result(context.stdin ?? empty());
    };
    const fail: Command = (context) => {
      retained = context.fs.retained;
      throw new Error("injected command failure");
    };
    const subject = fixture(
      new Map([
        ["observe", observe],
        ["fail", fail],
      ]),
    );

    expect(subject.shell.run("observe", { stdin: "success" }).exitCode).toBe(0);
    expect(retained?.available).toBe(retained?.max);

    expect(() => subject.shell.run("fail", { stdin: "error" })).toThrow("injected command failure");
    expect(retained?.available).toBe(retained?.max);

    expect(subject.shell.run("observe | head -0", { stdin: "early" }).exitCode).toBe(0);
    expect(retained?.available).toBe(retained?.max);
  });

  it("releases merged diagnostics when a command warns and then throws synchronously", () => {
    const failure = new Error("injected failure after warning");
    let retained: RetainedBudget | undefined;
    const warnThenFail: Command = (context) => {
      retained = context.fs.retained;
      context.warn("retained warning");
      throw failure;
    };
    const subject = fixture(new Map([["warn-then-fail", warnThenFail]]));

    expect(() => subject.shell.run("warn-then-fail argument 2>&1")).toThrow(failure);
    expect(retained?.available).toBe(retained?.max);
  });

  it("releases earlier expanded arguments when a later argument exceeds the aggregate", () => {
    let calls = 0;
    const called: Command = () => {
      calls++;
      return result(empty());
    };
    const subject = fixture();
    const bounded = createShell({
      fs: subject.filesystem,
      cwd: "/repo",
      commands: new Map([["called", called]]),
      limits: {
        maxOutputBytes: 100,
        maxOperations: 10,
        readBudget: 100,
        maxRetainedBytes: 8,
      },
    });
    const originalRetain = RetainedBudget.prototype.retain;
    let retained: RetainedBudget | undefined;
    const retain = vi.spyOn(RetainedBudget.prototype, "retain").mockImplementation(function (
      this: RetainedBudget,
      bytes,
      label,
    ) {
      retained = this;
      return originalRetain.call(this, bytes, label);
    });

    try {
      const run = bounded.run("called abc defghi");
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain("retained-memory limit");
      expect(run.peakRetainedBytes).toBe(3);
      expect(calls).toBe(0);
      expect(retained?.available).toBe(8);
    } finally {
      retain.mockRestore();
    }
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

  it("keeps the entry cap but accepts env beyond the former byte component limit", () => {
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

    const formerExcess = { K: "a".repeat(FORMER_ENV_BYTES_MAX) };
    expect(subject.shell.run("called", { env: formerExcess })).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: FORMER_ENV_BYTES_MAX + 1,
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

  it("charges stdin, env, and expanded argv to one exact aggregate owner", () => {
    let calls = 0;
    const called: Command = () => {
      calls++;
      return result(empty());
    };
    const subject = fixture();
    const withLimit = (maxRetainedBytes: number): Shell =>
      createShell({
        fs: subject.filesystem,
        cwd: "/repo",
        commands: new Map([["called", called]]),
        limits: {
          maxOutputBytes: 100,
          maxOperations: 10,
          readBudget: 100,
          maxRetainedBytes,
        },
      });
    const options = { stdin: "1234", env: { E: "env" } };

    expect(withLimit(16).run("called 12345678", options)).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: 16,
    });
    expect(calls).toBe(1);

    const excess = withLimit(16).run("called 123456789", options);
    expect(excess).toMatchObject({ exitCode: 2, peakRetainedBytes: 8 });
    expect(excess.stderr).toContain("retained-memory limit");
    expect(calls).toBe(1);
  });

  it("accepts expanded argv beyond the former byte component limit", () => {
    let length = 0;
    const inspect: Command = (context) => {
      length = context.argv[0]?.length ?? 0;
      return result(empty());
    };
    const subject = fixture(new Map([["inspect", inspect]]));
    const argument = "a".repeat(FORMER_ARGUMENT_BYTES_MAX + 1);

    expect(subject.shell.run(`inspect ${argument}`)).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: argument.length,
    });
    expect(length).toBe(argument.length);
  });
});
