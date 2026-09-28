// The system commands where the reference cannot be compared: the run
// environment snapshot, the clock, real waiting, random names, and the
// intentional refusals. The comparable forms live in parity-system.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { MAX_SLEEP_SECONDS } from "../../packages/do/src/shell/commands/system/sleep.js";
import { createShell, type Limits, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

// 2024-03-05T07:08:09.123Z, a Tuesday.
const NOW = Date.UTC(2024, 2, 5, 7, 8, 9, 123);

function subject(options: { limits?: Limits; directories?: readonly string[] } = {}): {
  shell: Shell;
  fs: ReturnType<typeof createFilesystem>;
} {
  const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
  fs.writeFiles([
    { path: "/repo", mode: 0o755 },
    { path: "/repo/a.txt", bytes: new TextEncoder().encode("hello\n"), mode: 0o644 },
    ...(options.directories ?? []).map((path) => ({ path, mode: 0o755 })),
  ]);
  const shell = createShell({
    fs,
    cwd: "/repo",
    now: () => NOW,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { shell, fs };
}

describe("env", () => {
  it("prints the run environment in the order the caller supplied it", async () => {
    const { shell } = subject();
    const run = await shell.run("env", { env: { ZED: "1", ALPHA: "2", MID: "3" } });
    expect(run).toMatchObject({ stdout: "ZED=1\nALPHA=2\nMID=3\n", stderr: "", exitCode: 0 });
  });

  it("prints nothing without a run environment", async () => {
    const { shell } = subject();
    expect(await shell.run("env")).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("edits the snapshot: a reassignment keeps its place, a new name goes last", async () => {
    const { shell } = subject();
    const run = await shell.run("env -u B A=9 C=3", { env: { A: "1", B: "2" } });
    expect(run.stdout).toBe("A=9\nC=3\n");
  });

  it("hands the edited environment to the command it runs", async () => {
    const { shell } = subject();
    const run = await shell.run("env -u B C=3 env", { env: { A: "1", B: "2" } });
    expect(run.stdout).toBe("A=1\nC=3\n");
  });

  it("refuses an integer-like name, whose place a record cannot keep", async () => {
    const { shell } = subject();
    const run = await shell.run("env -i B=1 1=2");
    expect(run).toMatchObject({
      stdout: "",
      stderr:
        "env: variable name '1' is not supported: the environment cannot keep integer-like names in order\n",
      exitCode: 125,
    });
  });

  it("refuses to run a command that could not read this stage's input", async () => {
    const { shell } = subject();
    const run = await shell.run("echo hi | env base64");
    expect(run).toMatchObject({
      stdout: "",
      stderr: "env: cannot run 'base64' with standard input: the invoked command cannot read it\n",
      exitCode: 125,
    });
  });

  it("refuses the options it does not implement", async () => {
    const { shell } = subject();
    const run = await shell.run("env -C / env");
    expect(run).toMatchObject({
      stderr: "env: option '--chdir' is not supported\n",
      exitCode: 125,
    });
  });
});

describe("date", () => {
  it.each([
    ["date", "Tue Mar  5 07:08:09 UTC 2024\n"],
    ["date -u", "Tue Mar  5 07:08:09 UTC 2024\n"],
    ["date +%s.%N", "1709622489.123000000\n"],
    ["date +%3N", "123\n"],
    ["date -I", "2024-03-05\n"],
    ["date -Iseconds", "2024-03-05T07:08:09+00:00\n"],
    ["date -Ins", "2024-03-05T07:08:09,123000000+00:00\n"],
    ["date --rfc-3339=ns", "2024-03-05 07:08:09.123000000+00:00\n"],
    ["date -R", "Tue, 05 Mar 2024 07:08:09 +0000\n"],
    ["date '+%F %T %Z'", "2024-03-05 07:08:09 UTC\n"],
    // uutils 0.2.2 adds the host clock's nanoseconds to a `-d` instant; the
    // parsed fraction is what `-d` describes.
    ["date -d @1.5 +%s.%N", "1.500000000\n"],
    ["date -d 2024-01-02T03:04:05.123Z +%N", "123000000\n"],
    ["date -d @-5 '+%s %_5s %05s'", "-5 -    5 -00005\n"],
    ["date -d @-1", "Wed Dec 31 23:59:59 UTC 1969\n"],
    ["date -d 0099-01-01 +%Y", "0099\n"],
  ])("renders %j from ShellOptions.now", async (source, expected) => {
    const { shell } = subject();
    expect(await shell.run(source)).toMatchObject({ stdout: expected, stderr: "", exitCode: 0 });
  });

  it("accepts a TZ that already means UTC and refuses any other", async () => {
    const { shell } = subject();
    expect((await shell.run("date +%Z", { env: { TZ: "UTC" } })).stdout).toBe("UTC\n");
    expect((await shell.run("date -u +%Z", { env: { TZ: "Europe/Prague" } })).stdout).toBe("UTC\n");
    expect(await shell.run("date", { env: { TZ: "Europe/Prague" } })).toMatchObject({
      stdout: "",
      stderr: "date: time zone 'Europe/Prague' is not supported: the shell has only UTC\n",
      exitCode: 1,
    });
  });

  it.each([
    [
      "date -d yesterday",
      "date: date string 'yesterday' is not supported: use @EPOCH or an ISO-8601 date and time\n",
    ],
    [
      "date -d bogus",
      "date: date string 'bogus' is not supported: use @EPOCH or an ISO-8601 date and time\n",
    ],
    ["date 01020304", "date: operand '01020304' is not supported: setting the clock is refused\n"],
    ["date -R +%Y", "date: multiple output formats specified\n"],
    ["date -I -R", "date: multiple output formats specified\n"],
    ["date +%c", "date: conversion '%c' is not supported\n"],
    ["date +%:a", "date: conversion '%:a' is not supported\n"],
    ["date -s 2024-01-01", "date: option '--set' is not supported\n"],
    ["date -r a.txt", "date: option '--reference' is not supported\n"],
    [
      "date -x",
      "error: unexpected argument '-x' found\n\n  tip: to pass '-x' as a value, use '-- -x'\n\nFor more information, try '--help'.\n",
    ],
    ["date a b", "error: unexpected argument 'b' found\n\nFor more information, try '--help'.\n"],
  ])("refuses %j", async (source, stderr) => {
    const { shell } = subject();
    expect(await shell.run(source)).toMatchObject({ stdout: "", stderr, exitCode: 1 });
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the summed interval before it finishes", async () => {
    vi.useFakeTimers();
    const { shell } = subject();
    let settled = false;
    const running = shell.run("sleep 1 0.5s").then((run) => {
      settled = true;
      return run;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("admits exactly the cap", async () => {
    vi.useFakeTimers();
    const { shell } = subject();
    const running = shell.run(`sleep ${MAX_SLEEP_SECONDS / 60}m`);
    await vi.advanceTimersByTimeAsync(MAX_SLEEP_SECONDS * 1000);
    expect((await running).exitCode).toBe(0);
  });

  it("really waits on the real clock", async () => {
    const { shell } = subject();
    expect(await shell.run("sleep 0.01")).toMatchObject({ stderr: "", exitCode: 0 });
  });

  it.each([
    ["sleep 61", "61"],
    ["sleep 30 31", "61"],
    ["sleep 1m 1s", "61"],
    ["sleep 1h", "3600"],
    ["sleep inf", "Infinity"],
  ])("refuses %j above the cap", async (source, total) => {
    const { shell } = subject();
    expect(await shell.run(source)).toMatchObject({
      stdout: "",
      stderr: `sleep: total interval of ${total} seconds exceeds the 60-second limit: one shell run must finish inside one Durable Object request\n`,
      exitCode: 1,
    });
  });

  it("refuses a hexadecimal interval rather than calling it invalid", async () => {
    const { shell } = subject();
    expect(await shell.run("sleep 0x1")).toMatchObject({
      stderr: "sleep: hexadecimal interval '0x1' is not supported\n",
      exitCode: 1,
    });
  });
});

describe("mktemp", () => {
  const NAME = /^[0-9A-Za-z]+$/;

  it("creates a 0600 file under /tmp by default", async () => {
    const { shell, fs } = subject({ directories: ["/tmp"] });
    const run = await shell.run("mktemp");
    expect(run).toMatchObject({ stderr: "", exitCode: 0 });
    const path = run.stdout.trimEnd();
    expect(path).toMatch(/^\/tmp\/tmp\.[0-9A-Za-z]{10}$/);
    expect(fs.stat(path)).toMatchObject({ type: "file", size: 0 });
    expect((fs.stat(path)?.mode ?? 0) & 0o777).toBe(0o600);
  });

  it("creates a 0700 directory with -d", async () => {
    const { shell, fs } = subject({ directories: ["/tmp"] });
    const path = (await shell.run("mktemp -d")).stdout.trimEnd();
    expect(fs.stat(path)?.type).toBe("dir");
    expect((fs.stat(path)?.mode ?? 0) & 0o777).toBe(0o700);
  });

  it("does not create a missing /tmp", async () => {
    const { shell, fs } = subject();
    expect(await shell.run("mktemp")).toMatchObject({
      stdout: "",
      stderr:
        "mktemp: failed to create file via template '/tmp/tmp.XXXXXXXXXX': No such file or directory\n",
      exitCode: 1,
    });
    expect(await shell.run("mktemp -d")).toMatchObject({
      stderr:
        "mktemp: failed to create directory via template '/tmp/tmp.XXXXXXXXXX': No such file or directory\n",
      exitCode: 1,
    });
    expect(fs.stat("/tmp")).toBeNull();
  });

  it("is silent under -q but still fails", async () => {
    const { shell } = subject();
    expect(await shell.run("mktemp -q")).toMatchObject({ stdout: "", stderr: "", exitCode: 1 });
  });

  it("names a file relative to the cwd from a template, keeping text after the X's", async () => {
    const { shell, fs } = subject();
    const name = (await shell.run("mktemp fooXXXX.txt")).stdout.trimEnd();
    expect(name).toMatch(/^foo[0-9A-Za-z]{4}\.txt$/);
    expect(fs.stat(`/repo/${name}`)?.type).toBe("file");
  });

  it("prints a name without creating it under -u", async () => {
    const { shell, fs } = subject();
    const name = (await shell.run("mktemp -u -p /nowhere")).stdout.trimEnd();
    expect(name).toMatch(/^\/nowhere\/tmp\.[0-9A-Za-z]{10}$/);
    expect(fs.stat(name)).toBeNull();
  });

  it("places the template under -p, --tmpdir, -t, and TMPDIR", async () => {
    const { shell } = subject({ directories: ["/repo/d", "/scratch"] });
    const env = { TMPDIR: "/scratch" };
    const cases: Array<[string, RegExp]> = [
      ["mktemp -p d aXXX", /^d\/a[0-9A-Za-z]{3}$/],
      ["mktemp -p /repo/d/ aXXX", /^\/repo\/d\/a[0-9A-Za-z]{3}$/],
      ["mktemp --tmpdir=d aXXX", /^d\/a[0-9A-Za-z]{3}$/],
      ["mktemp --tmpdir aXXX", /^\/scratch\/a[0-9A-Za-z]{3}$/],
      ["mktemp -t aXXX", /^\/scratch\/a[0-9A-Za-z]{3}$/],
      ["mktemp -t -p d aXXX", /^\/scratch\/a[0-9A-Za-z]{3}$/],
      ["mktemp", /^\/scratch\/tmp\.[0-9A-Za-z]{10}$/],
      ["mktemp --suffix=.log", /^\/scratch\/tmp\.[0-9A-Za-z]{10}\.log$/],
    ];
    for (const [source, expected] of cases) {
      const run = await shell.run(source, { env });
      expect(run.stderr, source).toBe("");
      expect(run.stdout.trimEnd(), source).toMatch(expected);
    }
  });

  it("fails when the parent is a file", async () => {
    const { shell } = subject();
    expect(await shell.run("mktemp a.txt/XXX")).toMatchObject({
      stderr: "mktemp: failed to create file via template 'a.txt/XXX': Not a directory\n",
      exitCode: 1,
    });
  });

  it("draws every replaced character from the reference alphabet", async () => {
    const { shell } = subject();
    const names = await Promise.all(
      Array.from({ length: 20 }, async () =>
        (await shell.run("mktemp -u XXXXXXXX")).stdout.trimEnd(),
      ),
    );
    for (const name of names) expect(name).toMatch(NAME);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("checksums and base64 under the retained budget", () => {
  const limits: Limits = {
    maxOutputBytes: 10_000_000,
    maxOperations: 10_000,
    readBudget: 64 * 1024,
    maxRetainedBytes: 512 * 1024,
  };

  it("holds a hashed input whole, so an input over the budget fails loudly", async () => {
    const { shell, fs } = subject({ limits });
    fs.writeFiles([{ path: "/repo/big.bin", bytes: new Uint8Array(600 * 1024), mode: 0o644 }]);
    const run = await shell.run("sha256sum big.bin");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("retained-memory limit");
  });

  it("streams base64 both ways through an input larger than the budget", async () => {
    const { shell, fs } = subject({ limits });
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => (index * 31) % 251);
    fs.writeFiles([{ path: "/repo/big.bin", bytes, mode: 0o644 }]);
    const run = await shell.run("base64 big.bin | base64 -d | wc -c");
    expect(run).toMatchObject({ stdout: `${bytes.length}\n`, stderr: "", exitCode: 0 });
    expect(run.peakRetainedBytes).toBeLessThanOrEqual(512 * 1024);
  });

  it("does not register md5sum: crypto.subtle has no MD5", async () => {
    const { shell } = subject();
    expect((await shell.run("md5sum a.txt")).exitCode).toBe(127);
  });
});
