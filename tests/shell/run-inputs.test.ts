import { describe, expect, it, vi } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import type { GitCliRunner } from "../../src/git/cli/types.js";
import { createGitCommand } from "../../src/git/shell.js";
import { type ByteStream, close as closeStream, encode } from "../../src/shell/exec/bytes.js";
import { type Command, RetainedBudget, result } from "../../src/shell/exec/context.js";
import { RunInputOwner } from "../../src/shell/exec/execute.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const FORMER_ARGUMENT_BYTES_MAX = 1000000;
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
  it("matches a redirect for text and stays byte-exact for binary input", async () => {
    const subject = fixture();
    const redirected = await subject.shell.exec("cat < input.txt");
    expect((await subject.shell.exec("cat", { stdin: "file input\n" })).stdout).toEqual(
      redirected.stdout,
    );
    expect(
      (await subject.shell.exec("cat", { stdin: new Uint8Array([0, 255, 10]) })).stdout,
    ).toEqual(new Uint8Array([0, 255, 10]));
    expect((await subject.shell.run("cat | wc -c", { stdin: "four" })).stdout).toBe("4\n");
  });
  it("shares one cursor across selected pipelines without replaying consumed bytes", async () => {
    const subject = fixture();
    expect((await subject.shell.run("true; cat", { stdin: "left\n" })).stdout).toBe("left\n");
    expect((await subject.shell.run("cat; cat", { stdin: "once\n" })).stdout).toBe("once\n");
    expect((await subject.shell.run("false && cat; cat", { stdin: "selected\n" })).stdout).toBe(
      "selected\n",
    );
  });
  it("preserves a partially consumed byte or line suffix for a later pipeline", async () => {
    const subject = fixture();
    expect((await subject.shell.run("head -c 1; cat", { stdin: "abc" })).stdout).toBe("abc");
    expect((await subject.shell.run("head -c 0; cat", { stdin: "abc" })).stdout).toBe("abc");
    expect((await subject.shell.run("head -n 1; cat", { stdin: "first\nsecond\n" })).stdout).toBe(
      "first\nsecond\n",
    );
  });
  it("keeps caller stdin after a redirect, command miss, and early downstream close", async () => {
    const subject = fixture();
    expect((await subject.shell.run("cat < input.txt; cat", { stdin: "caller\n" })).stdout).toBe(
      "file input\ncaller\n",
    );
    expect(await subject.shell.run("missing || cat", { stdin: "fallback\n" })).toMatchObject({
      stdout: "fallback\n",
      exitCode: 0,
    });
    expect((await subject.shell.run("cat | head -0; cat", { stdin: "unpulled\n" })).stdout).toBe(
      "unpulled\n",
    );
  });
  it("lets repeated borrow closes and the Git adapter leave the owner for a later pipeline", async () => {
    const closeTwice: Command = async (context) => {
      await closeStream(context.stdin);
      await closeStream(context.stdin);
      return result(empty());
    };
    const runner: GitCliRunner = {
      async runCli() {
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      },
    };
    const subject = fixture(
      new Map([
        ["close-twice", closeTwice],
        ["git", createGitCommand(runner)],
      ]),
    );
    expect((await subject.shell.run("close-twice; cat", { stdin: "borrowed\n" })).stdout).toBe(
      "borrowed\n",
    );
    expect((await subject.shell.run("git diff; cat", { stdin: "after git\n" })).stdout).toBe(
      "after git\n",
    );
  });
  it("snapshots caller-owned binary bytes before invoking a command", async () => {
    const supplied = new Uint8Array([65, 10]);
    const mutate: Command = (context) => {
      supplied[0] = 66;
      return result(context.stdin ?? empty());
    };
    const subject = fixture(new Map([["mutate", mutate]]));
    expect((await subject.shell.exec("mutate", { stdin: supplied })).stdout).toEqual(
      new Uint8Array([65, 10]),
    );
  });
  it("closes the run owner exactly once across every execution path", async () => {
    const failure = new Error("boom");
    const boom: Command = () => {
      throw failure;
    };
    const closeTwice: Command = async (context) => {
      await closeStream(context.stdin);
      await closeStream(context.stdin);
      return result(empty());
    };
    const runner: GitCliRunner = {
      async runCli() {
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
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
      expect((await subject.shell.run("true", { stdin: "ok" })).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
      expect((await subject.shell.run("missing || cat", { stdin: "fallback" })).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(2);
      expect((await subject.shell.run("cat | head -0", { stdin: "early" })).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(3);
      expect((await subject.shell.run("cat < input.txt", { stdin: "redirected" })).exitCode).toBe(
        0,
      );
      expect(close).toHaveBeenCalledTimes(4);
      expect((await subject.shell.run("close-twice", { stdin: "borrowed" })).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(5);
      expect((await subject.shell.run("git diff", { stdin: "git" })).exitCode).toBe(0);
      expect(close).toHaveBeenCalledTimes(6);
      await expect(subject.shell.run("boom", { stdin: "fail" })).rejects.toThrow(failure);
      expect(close).toHaveBeenCalledTimes(7);
    } finally {
      close.mockRestore();
    }
  });
  it.each([
    ["exit", 0],
    ["false; exit", 1],
    ["exit 300", 44],
    ["exit -1", 255],
    ["exit nope", 2],
    ["exit | cat", 2],
    ["cat | exit", 2],
  ])("closes and releases every exit path exactly once: %s", async (source, exitCode) => {
    const subject = fixture();
    const close = vi.spyOn(RunInputOwner.prototype, "close");
    const originalRetain = RetainedBudget.prototype.retain;
    const releaseCalls: number[] = [];
    const retain = vi.spyOn(RetainedBudget.prototype, "retain").mockImplementation(function (
      this: RetainedBudget,
      bytes,
      label,
    ) {
      const release = originalRetain.call(this, bytes, label);
      const index = releaseCalls.push(0) - 1;
      return () => {
        releaseCalls[index] = (releaseCalls[index] ?? 0) + 1;
        release();
      };
    });
    try {
      const run = await subject.shell.run(source, { stdin: "caller", env: { A: "b" } });
      expect(run.exitCode).toBe(exitCode);
      expect(close).toHaveBeenCalledTimes(1);
      expect(releaseCalls.length).toBeGreaterThan(0);
      expect(releaseCalls.every((calls) => calls === 1)).toBe(true);
    } finally {
      retain.mockRestore();
      close.mockRestore();
    }
  });
  it("parses before creating or measuring a run input", async () => {
    const subject = fixture();
    const close = vi.spyOn(RunInputOwner.prototype, "close");
    const env: Record<string, string> = {};
    for (let index = 0; index <= ENV_ENTRY_MAX; index++) env[`K${index}`] = "";
    const run = await subject.shell.run("'unterminated", {
      stdin: new Uint8Array(FORMER_STDIN_BYTES_MAX + 1),
      env,
    });
    expect(run).toMatchObject({ exitCode: 2, operations: 0, peakRetainedBytes: 0 });
    expect(run.stderr).toContain("unterminated single quote");
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });
  it("accepts caller-owned stdin beyond the former component limit", async () => {
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
        maxOutputBytes: 1000000,
        maxOperations: 10,
        readBudget: 1000,
        maxRetainedBytes: supplied.length,
      },
    });
    expect(await shell.run("called", { stdin: supplied })).toMatchObject({
      exitCode: 0,
      operations: 0,
      peakRetainedBytes: supplied.length,
    });
    expect(calls).toBe(1);
  });
  it("measures UTF-8 before encoding and enforces configured retained memory", async () => {
    const subject = fixture();
    const exact = `${"a".repeat(FORMER_STDIN_BYTES_MAX - 4)}😀`;
    expect((await subject.shell.run("true", { stdin: exact })).peakRetainedBytes).toBe(
      FORMER_STDIN_BYTES_MAX,
    );
    expect(await subject.shell.run("true", { stdin: `${exact}a` })).toMatchObject({
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
        maxOutputBytes: 1000,
        maxOperations: 10,
        readBudget: 1000,
        maxRetainedBytes: 3,
      },
    });
    expect(await retained.run("called", { stdin: "four" })).toMatchObject({
      exitCode: 2,
      operations: 0,
      peakRetainedBytes: 0,
    });
    expect(called).toBe(false);
  });
  it("preserves behavior when run options are absent", async () => {
    const subject = fixture();
    expect(await subject.shell.run("pwd")).toEqual(await subject.shell.run("pwd", {}));
  });
  it("releases the shared input and pipeline owner on success, error, and early close", async () => {
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
    expect((await subject.shell.run("observe", { stdin: "success" })).exitCode).toBe(0);
    expect(retained?.available).toBe(retained?.max);
    await expect(subject.shell.run("fail", { stdin: "error" })).rejects.toThrow(
      "injected command failure",
    );
    expect(retained?.available).toBe(retained?.max);
    expect((await subject.shell.run("observe | head -0", { stdin: "early" })).exitCode).toBe(0);
    expect(retained?.available).toBe(retained?.max);
  });
  it("releases merged diagnostics when a command warns and then throws synchronously", async () => {
    const failure = new Error("injected failure after warning");
    let retained: RetainedBudget | undefined;
    const warnThenFail: Command = (context) => {
      retained = context.fs.retained;
      context.warn("retained warning");
      throw failure;
    };
    const subject = fixture(new Map([["warn-then-fail", warnThenFail]]));
    await expect(subject.shell.run("warn-then-fail argument 2>&1")).rejects.toThrow(failure);
    expect(retained?.available).toBe(retained?.max);
  });
  it("releases earlier expanded arguments when a later argument exceeds the aggregate", async () => {
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
      const run = await bounded.run("called abc defghi");
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
  it("provides one frozen snapshot to direct and nested injected commands", async () => {
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
    const outer: Command = async (context) =>
      (await context.invoke("inner", [])) ?? result(empty());
    const subject = fixture(
      new Map([
        ["inspect", inspect],
        ["inner", inner],
        ["outer", outer],
      ]),
    );
    expect((await subject.shell.run("inspect; outer", { env: supplied })).exitCode).toBe(0);
    expect(direct).toEqual({ VALUE: "before" });
    expect(direct?.INHERITED).toBeUndefined();
    expect(nested).toBe(direct);
    expect(Object.isFrozen(direct)).toBe(true);
    await subject.shell.run("inspect");
    expect(direct).toBeUndefined();
  });
  it("keeps the entry cap but accepts env beyond the former byte component limit", async () => {
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
    expect((await subject.shell.run("called", { env: exactEntries })).exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(await subject.shell.run("called", { env: excessEntries })).toMatchObject({
      exitCode: 2,
      operations: 0,
      peakRetainedBytes: 0,
    });
    expect(calls).toBe(1);
    const formerExcess = { K: "a".repeat(FORMER_ENV_BYTES_MAX) };
    expect(await subject.shell.run("called", { env: formerExcess })).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: FORMER_ENV_BYTES_MAX + 1,
    });
    expect(calls).toBe(2);
  });
  it("reserves env and stdin together before allocating either snapshot", async () => {
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
      expect(await withLimit(4).run("true", { env: { A: "bbb" } })).toMatchObject({
        exitCode: 0,
        peakRetainedBytes: 4,
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(await withLimit(3).run("true", { env: { A: "bbb" } })).toMatchObject({
        exitCode: 2,
        peakRetainedBytes: 0,
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(await withLimit(4).run("true", { stdin: "xy", env: { A: "b" } })).toMatchObject({
        exitCode: 0,
        peakRetainedBytes: 4,
      });
      expect(close).toHaveBeenCalledTimes(2);
      expect(await withLimit(3).run("true", { stdin: "xy", env: { A: "b" } })).toMatchObject({
        exitCode: 2,
        peakRetainedBytes: 0,
      });
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });
  it("charges stdin, env, and expanded argv to one exact aggregate owner", async () => {
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
    expect(await withLimit(16).run("called 12345678", options)).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: 16,
    });
    expect(calls).toBe(1);
    const excess = await withLimit(16).run("called 123456789", options);
    expect(excess).toMatchObject({ exitCode: 2, peakRetainedBytes: 8 });
    expect(excess.stderr).toContain("retained-memory limit");
    expect(calls).toBe(1);
  });
  it("accepts expanded argv beyond the former byte component limit", async () => {
    let length = 0;
    const inspect: Command = (context) => {
      length = context.argv[0]?.length ?? 0;
      return result(empty());
    };
    const subject = fixture(new Map([["inspect", inspect]]));
    const argument = "a".repeat(FORMER_ARGUMENT_BYTES_MAX + 1);
    expect(await subject.shell.run(`inspect ${argument}`)).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: argument.length,
    });
    expect(length).toBe(argument.length);
  });
});

describe("async byte streams", () => {
  it("pulls delayed bytes through byte, line, and head consumers", async () => {
    const delayed: Command = () =>
      result(
        (async function* (): ByteStream {
          await Promise.resolve();
          yield encode("first\n");
          await Promise.resolve();
          yield encode("second\n");
        })(),
      );
    const subject = fixture(new Map([["delayed", delayed]]));

    expect((await subject.shell.run("delayed | cat")).stdout).toBe("first\nsecond\n");
    expect((await subject.shell.run("delayed | grep second")).stdout).toBe("second\n");
    expect((await subject.shell.run("delayed | head -1")).stdout).toBe("first\n");
  });

  it("awaits early cleanup exactly once before reading status", async () => {
    const events: string[] = [];
    let closes = 0;
    const source: Command = () => {
      const stdout = new EarlyCloseStream(events, () => {
        closes++;
      });
      return {
        stdout,
        status: () => {
          events.push("status");
          expect(events).toEqual(["return-start", "return-end", "status"]);
          return 0;
        },
      };
    };
    const base = fixture();
    const shell = createShell({
      fs: base.filesystem,
      cwd: "/repo",
      commands: new Map([["source", source]]),
      limits: { maxOutputBytes: 1, maxOperations: 10, readBudget: 100 },
    });

    expect(await shell.run("source")).toMatchObject({ stdout: "x", exitCode: 0, truncated: true });
    expect(closes).toBe(1);
  });

  it.each([
    "reject | cat",
    "reject | grep value",
    "reject | head -2",
    "reject 2>&1 | cat",
    "reject 2>/dev/null | cat",
  ])("releases caller input and retained bytes after rejection: %s", async (source) => {
    const failure = new Error("async source rejected");
    let retained: RetainedBudget | undefined;
    let cleanups = 0;
    const reject: Command = (context) => {
      retained = context.fs.retained;
      const release = context.fs.retained.retain(5, "async rejection witness");
      return result(
        (async function* (): ByteStream {
          try {
            await Promise.resolve();
            context.warn("before rejection");
            yield encode("value\n");
            await Promise.resolve();
            throw failure;
          } finally {
            cleanups++;
            release();
          }
        })(),
      );
    };
    const subject = fixture(new Map([["reject", reject]]));

    await expect(subject.shell.run(source, { stdin: "caller" })).rejects.toThrow(failure);
    expect(cleanups).toBe(1);
    expect(retained?.available).toBe(retained?.max);
  });

  it("merges or drops delayed diagnostics without changing bytes", async () => {
    const diagnostic: Command = (context) =>
      result(
        (async function* (): ByteStream {
          await Promise.resolve();
          context.diagnostic(encode("diagnostic\n"));
          yield encode("stdout\n");
        })(),
      );
    const subject = fixture(new Map([["diagnostic", diagnostic]]));

    expect(await subject.shell.run("diagnostic 2>&1")).toMatchObject({
      stdout: "diagnostic\nstdout\n",
      stderr: "",
    });
    expect(await subject.shell.run("diagnostic 2>/dev/null")).toMatchObject({
      stdout: "stdout\n",
      stderr: "",
    });
  });
});

class EarlyCloseStream implements AsyncIterableIterator<Uint8Array, void, undefined> {
  #closed = false;

  constructor(
    private readonly events: string[],
    private readonly closed: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  async next(): Promise<IteratorResult<Uint8Array, void>> {
    return this.#closed ? { done: true, value: undefined } : { done: false, value: encode("xx") };
  }

  async return(): Promise<IteratorResult<Uint8Array, void>> {
    if (this.#closed) return { done: true, value: undefined };
    this.#closed = true;
    this.events.push("return-start");
    await Promise.resolve();
    this.events.push("return-end");
    this.closed();
    return { done: true, value: undefined };
  }
}
