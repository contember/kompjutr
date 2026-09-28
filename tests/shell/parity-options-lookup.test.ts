// `type` and `command -v`/`-V` against Bash 5.2's builtins, and `ls -h`.
//
// Only host-independent answers are compared: keywords, builtins, missing
// names, and coreutils the test host installs at /usr/bin. Everything that
// depends on the registry rather than on Bash — injected commands, a builtin
// with no binary under `-P`, the refusals — is pinned locally.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { type Command, result } from "../../packages/do/src/shell/exec/context.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { agreeWithBash, compareWithBash, REAL_BASH } from "../helpers/shell-parity.js";

describe("the lookup parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("type and command match Bash", () => {
  it.each([
    "type cd",
    "type echo printf test [ pwd true false exit type command",
    "type if then else elif fi for in do done while until case esac function select { } !",
    "type ls cat sort grep head wc which",
    "type nope",
    "type cd nope ls",
    "type",
    "type -t cd if ls nope",
    "type -t nope",
    "type -p cd ls nope",
    "type -P ls cat",
    "type -P echo true [",
    "type -P nope",
    "type -f cd ls",
    "type -tp ls cd",
    "type -pt ls cd",
    "type -Pt ls",
    "type -type ls",
    "type --path ls",
    "type -- cd",
    "type -",
    "type -x",
    "type -tx cd",
    "type --foo",
    "command -v cd if ls nope [",
    "command -v nope",
    "command -v nope cd",
    "command -v cd nope",
    "command -v",
    "command -v -- cd",
    "command -V cd ls if nope",
    "command -V nope",
    "command -vV cd ls",
    "command -Vv cd ls",
    "command",
    "command -x",
    "command --foo",
    "command -v sort && echo found",
  ])("%s", async (source) => {
    agreeWithBash(await compareWithBash(source));
  });
});

describe("type and command over the registry", () => {
  const fs = createFilesystem(new TestDatabase());
  fs.writeFiles([{ path: "/repo", mode: 0o755 }]);
  const injected: Command = () => result((function* () {})());
  const shell = createShell({ fs, cwd: "/repo", commands: new Map([["tool", injected]]) });

  it("has no file for a builtin that coreutils does not ship", async () => {
    expect(await shell.run("type -P cd")).toMatchObject({ exitCode: 1, stdout: "", stderr: "" });
  });
  it("does not see an injected command, as which does not", async () => {
    expect(await shell.run("type tool")).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "bash: line 1: type: tool: not found\n",
    });
    expect(await shell.run("command -v tool")).toMatchObject({ exitCode: 1, stdout: "" });
  });
  it("reports a Bash keyword the parser does not know as missing", async () => {
    expect(await shell.run("type -t '[[' time coproc")).toMatchObject({ exitCode: 1, stdout: "" });
  });
  it("does not resolve a path, since commands are registry names", async () => {
    expect(await shell.run("command -v /usr/bin/ls")).toMatchObject({ exitCode: 1, stdout: "" });
  });
  it.each([
    ["type -a echo", "type: -a is not supported: there is no PATH to search\n"],
    ["command -p ls", "command: -p is not supported: there is no PATH to search\n"],
    ["command -pv ls", "command: -p is not supported: there is no PATH to search\n"],
    ["command ls /repo", "command: running ls through command is not supported; run ls directly\n"],
  ])("refuses %s", async (source, stderr) => {
    expect(await shell.run(source)).toMatchObject({ exitCode: 2, stdout: "", stderr });
  });
});

describe("ls -h", () => {
  const MTIME = Date.UTC(2024, 0, 2, 3, 4);
  const sizes = [0, 1, 1023, 1024, 1025, 1536, 10239, 10240, 10241, 1048575, 1048576, 5000000];
  const fs = createFilesystem(new TestDatabase(), { now: () => MTIME });
  fs.writeFiles([
    { path: "/repo", mode: 0o755, mtime: MTIME },
    ...sizes.map((size) => ({
      path: `/repo/f${String(size).padStart(7, "0")}`,
      bytes: new Uint8Array(size),
      mode: 0o644,
      mtime: MTIME,
    })),
  ]);
  const shell = createShell({ fs, cwd: "/repo" });

  it("prints sizes as uutils ls -lh does, in the -l layout", async () => {
    const run = await shell.run("ls -lh");
    expect(run.exitCode).toBe(0);
    const expected = [
      ["0", "f0000000"],
      ["1", "f0000001"],
      ["1023", "f0001023"],
      ["1.0K", "f0001024"],
      ["1.1K", "f0001025"],
      ["1.5K", "f0001536"],
      ["10K", "f0010239"],
      ["10K", "f0010240"],
      ["11K", "f0010241"],
      ["1024K", "f1048575"],
      ["1.0M", "f1048576"],
      ["4.8M", "f5000000"],
    ].map(([size, name]) => `-rw-r--r-- ${(size ?? "").padStart(8)} 2024-01-02 03:04 ${name}\n`);
    expect(run.stdout).toBe(expected.join(""));
  });
  it("keeps the -l layout for a file operand and a recursive listing", async () => {
    expect((await shell.run("ls -hl f0001025")).stdout).toBe(
      "-rw-r--r--     1.1K 2024-01-02 03:04 f0001025\n",
    );
    expect((await shell.run("ls -lhR")).stdout).toContain("     1.0M 2024-01-02 03:04 f1048576\n");
  });
  it("changes nothing without -l", async () => {
    expect(await shell.run("ls -h f0001025")).toMatchObject({ stdout: "f0001025\n", exitCode: 0 });
  });
});
