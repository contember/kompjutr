// Local pins for command substitution, assignments, export/unset, and the
// `${…}` operators: every refusal, the nesting limit, the retained,
// operation, and loop budgets a substitution shares with its run, what an
// injected command sees as its environment, and cases the parity harness
// cannot express. Expectations without a parity comparison were taken from
// Bash 5.2 by hand.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { ByteStream } from "../../packages/do/src/shell/exec/bytes.js";
import { type Command, result } from "../../packages/do/src/shell/exec/context.js";
import { createShell, DEFAULT_LIMITS, type Shell } from "../../packages/do/src/shell/index.js";
import { parse } from "../../packages/do/src/shell/parse/parser.js";
import { planScript } from "../../packages/do/src/shell/plan/plan.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

function one(text: string): ByteStream {
  return (function* (): ByteStream {
    yield ENCODER.encode(text);
  })();
}

/** Prints the environment it was handed, one `NAME=value` per line in name order. */
const printEnv: Command = (context) => {
  const env = context.env ?? {};
  const names = Object.keys(env).sort();
  return result(one(names.map((name) => `${name}=${env[name]}\n`).join("")));
};

function fixture(options: { maxRetainedBytes?: number; maxOperations?: number } = {}): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
  fs.writeFiles([
    { path: "/repo/lines.txt", bytes: ENCODER.encode("l1\nl2\nl3\n") },
    { path: "/repo/big.txt", bytes: ENCODER.encode("x".repeat(4_000)) },
  ]);
  return createShell({
    fs,
    cwd: "/repo",
    now: () => 0,
    commands: new Map([["probe", printEnv]]),
    limits: {
      ...DEFAULT_LIMITS,
      maxRetainedBytes: options.maxRetainedBytes ?? DEFAULT_LIMITS.maxRetainedBytes,
      maxOperations: options.maxOperations ?? DEFAULT_LIMITS.maxOperations,
    },
  });
}

describe("refusals fail before anything runs", () => {
  it.each([
    ["echo $((1 + 1))", "arithmetic expansion is not supported"],
    ["echo $(echo $((1)))", "arithmetic expansion is not supported"],
    ["echo $1", "positional parameter"],
    ['echo "$(echo $@)"', "special parameter"],
    ["cat <(ls)", "process substitution is not supported"],
    [`echo \${x%y}`, `parameter expansion operator in \${x%y} is not supported`],
    [`echo \${x#y}`, "parameter expansion operator"],
    [`echo \${x/a/b}`, "parameter expansion operator"],
    [`echo \${x^}`, "parameter expansion operator"],
    [`echo \${x,}`, "parameter expansion operator"],
    [`echo \${x:1}`, "parameter expansion operator"],
    [`echo \${x[0]}`, "parameter expansion operator"],
    [`echo \${!x}`, `parameter \${!x} is not supported`],
    [`echo \${#}`, `parameter \${#} is not supported`],
    [`echo \${#x[@]}`, `parameter \${#x[@]} is not supported`],
    [`echo \${?:-x}`, `parameter \${?:-x} is not supported`],
    ["echo $'a\\n'", "ANSI-C quoting ($'…') is not supported"],
    ['echo $"a"', 'locale translation ($"…") is not supported'],
    [`echo "\${x:-'a'}"`, "a single quote in the word of a double-quoted parameter expansion"],
    ["echo $(< lines.txt)", "`$(< file)` is not supported; use `$(cat file)`"],
    ["readonly x=1", "`readonly` is not supported"],
    ["local x", "`local` is not supported"],
    ["declare x=1", "`declare` is not supported"],
    ["typeset x", "`typeset` is not supported"],
    ["x=1 export y", "assignments before `export` are not supported"],
    ["x=1 unset y", "assignments before `unset` are not supported"],
    ["x[1]=a", "array assignment is not supported"],
    ["IFS=: echo x", "changing IFS is not supported"],
    ["IFS=,", "changing IFS is not supported"],
    ["for IFS in a; do :; done", "changing IFS is not supported"],
    ["cat <<$(echo E)\nE", "expansions in here-document delimiters are not supported"],
    ["echo $(cat <<E)\nE", "a here-document must end inside its command substitution"],
    ["echo x 2>&1 > $f", "unquoted expansion in a redirection target after a stderr redirection"],
    ["echo x 2>err.txt > $(echo out)", "command substitution or unquoted expansion"],
    ["echo x &> log > $f", "after a stderr redirection other than 2>/dev/null"],
    ["echo x >&$(echo 2)", "parameters in redirection targets of `>&` are not supported"],
    ["echo before; echo $(echo", "unterminated command substitution: no closing `)`"],
    ["echo before; echo `echo", "unterminated command substitution: no closing backquote"],
    [`echo before; echo \${x:-a`, "unterminated parameter expansion"],
    ["echo before; echo $(if)", "syntax error"],
    ["echo before; x=$(while true; do :; done)", "`while` is not supported"],
  ])("%j", async (source, message) => {
    const run = await fixture().run(source);
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain(message);
  });

  it.each([
    ["export", "export: listing exported variables is not supported\n"],
    ["export -p", "export: -p is not supported\n"],
    ["export -f x", "export: -f is not supported\n"],
    ["export -n", "export: listing exported variables is not supported\n"],
    ["unset", "unset: unset without names is not supported\n"],
    ["unset -f x", "unset: -f is not supported\n"],
    ["unset -n x", "unset: -n is not supported\n"],
    ["export IFS=:", "export: changing IFS is not supported\n"],
    ["unset IFS", "unset: changing IFS is not supported\n"],
    ["cmd=readonly; $cmd x", "readonly: this command is not supported\n"],
    ["e=export; x=1 $e y", "export: assignments before this command are not supported\n"],
  ])("refuses the builtin form %j with status 2", async (source, stderr) => {
    expect(await fixture().run(source)).toMatchObject({ stdout: "", stderr, exitCode: 2 });
  });

  it(`refuses assigning IFS through \${IFS:=…} when the run has none`, async () => {
    const run = await fixture().run(`echo \${IFS:=x}`);
    expect(run).toMatchObject({ stdout: "", exitCode: 2 });
    expect(run.stderr).toContain("changing IFS is not supported");
  });

  it("plans a substitution's list with the rest of the script", () => {
    const plan = planScript(parse("echo $(cat lines.txt | head -1)"));
    const part = plan.steps[0]?.pipeline.commands[0];
    if (part?.kind !== "command") throw new Error("expected a command");
    const substitution = part.args[0]?.parts[0];
    if (substitution?.kind !== "substitution") throw new Error("expected a substitution");
    expect(substitution.body.steps[0]?.pipeline.limitHint).toBe(1);
  });
});

describe("nesting is bounded before anything runs", () => {
  const deep = (open: string, close: string, levels: number): string =>
    `echo before; ${open.repeat(levels)}echo x${close.repeat(levels)}`;

  it("admits ordinary nesting", async () => {
    const run = await fixture().run(`echo ${"$(echo ".repeat(20)}x${")".repeat(20)}`);
    expect(run).toMatchObject({ stdout: "x\n", exitCode: 0 });
  });

  it.each([
    ["command substitutions", deep("echo $(", ")", 10_000)],
    ["subshells", deep("( ", " )", 10_000)],
    ["groups", deep("{ ", "; }", 10_000)],
    ["parameter words", `echo before; echo ${"${u:-".repeat(10_000)}x${"}".repeat(10_000)}`],
    ["substitutions inside parameter words", deep(`echo $(echo \${u:-`, "})", 5_000)],
    ["compounds around substitutions", deep("( echo $( ", ") )", 40)],
  ])("refuses deeply nested %s without overflowing the stack", async (_label, source) => {
    const run = await fixture().run(source);
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain("nested deeper than 64 levels are not supported");
  });
});

describe("a substitution shares its run's budgets", () => {
  it("fails the run when captured output exceeds the retained budget", async () => {
    const run = await fixture({ maxRetainedBytes: 3_000 }).run(
      "echo before; x=$(cat big.txt); echo after",
    );
    expect(run.stdout).toBe("before\n");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      "command substitution exceeds the 3000-byte retained-memory limit",
    );
  });

  it("releases captured output once the word is used", async () => {
    const run = await fixture({ maxRetainedBytes: 9_000 }).run(
      "for i in 1 2 3; do echo $(cat big.txt) > /dev/null; done; echo done",
    );
    expect(run).toMatchObject({ stdout: "done\n", stderr: "", exitCode: 0 });
    expect(run.peakRetainedBytes).toBeLessThan(9_000);
  });

  it("charges an assigned value for as long as the variable holds it", async () => {
    // Each value holds 4,001 bytes. A substitution's subshell copies the variables
    // set so far, and capturing briefly holds the file's bytes twice more.
    const shell = fixture({ maxRetainedBytes: 20_000 });
    expect(await shell.run("x=$(cat big.txt); y=$(cat big.txt); echo ok")).toMatchObject({
      stdout: "ok\n",
      exitCode: 0,
    });
    const over = await shell.run("x=$(cat big.txt); y=$(cat big.txt); z=$(cat big.txt); echo no");
    expect(over.exitCode).toBe(2);
    expect(over.stderr).toContain("retained-memory limit");
  });

  it("counts filesystem calls inside a substitution against the run", async () => {
    const run = await fixture({ maxOperations: 2 }).run(
      "a=$(cat lines.txt); b=$(cat lines.txt); c=$(cat lines.txt)",
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("exceeded 2 filesystem operations");
  });

  it("counts loop iterations inside a substitution against the run", async () => {
    const run = await fixture().run(
      "for i in {1..4000}; do x=$(for j in 1 2; do :; done); done; echo unreached",
    );
    expect(run.stdout).toBe("");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("loop iteration limit");
  });
});

describe("what commands see as their environment", () => {
  it("exports a prefix assignment to that command only", async () => {
    const run = await fixture().run("A=1 probe; echo --; probe", { env: { KEEP: "k" } });
    expect(run.stdout).toBe("A=1\nKEEP=k\n--\nKEEP=k\n");
  });

  it("keeps a plain assignment out of the environment until it is exported", async () => {
    const run = await fixture().run(
      "B=1; probe; export B; echo --; probe; export -n B; echo --; probe",
    );
    expect(run.stdout).toBe("--\nB=1\n--\n");
  });

  it("keeps a snapshot name exported through reassignment and drops it on unset", async () => {
    const run = await fixture().run("KEEP=changed; probe; unset KEEP; echo --; probe", {
      env: { KEEP: "k", OTHER: "o" },
    });
    expect(run.stdout).toBe("KEEP=changed\nOTHER=o\n--\nOTHER=o\n");
  });

  it("never mutates the caller's snapshot and starts each run from it", async () => {
    const env = { KEEP: "k" };
    const shell = fixture();
    await shell.run("export KEEP=changed NEW=1; unset KEEP", { env });
    expect(env).toEqual({ KEEP: "k" });
    expect((await shell.run("probe", { env })).stdout).toBe("KEEP=k\n");
  });

  it("hands an invoked command the prefix assignments too", async () => {
    const run = await fixture().run("echo x | A=1 xargs probe");
    expect(run.stdout).toBe("A=1\n");
  });
});

describe("cases the parity harness cannot express", () => {
  it("runs a substitution inside double quotes rather than printing it", async () => {
    const run = await fixture().run('echo "[$(date -u +%Y)]" "[`date -u +%Y`]"');
    expect(run).toMatchObject({ stdout: "[1970] [1970]\n", stderr: "", exitCode: 0 });
  });

  it("reads the run's stdin in a substitution before the command does", async () => {
    const run = await fixture().run('echo "[$(cat)]"; cat', { stdin: "in\n" });
    expect(run).toMatchObject({ stdout: "[in]\n", exitCode: 0 });
  });

  it(`counts \${#NAME} in characters under a UTF-8 locale and in bytes otherwise`, async () => {
    const shell = fixture();
    const source = `x=héllo; echo \${#x}`;
    expect((await shell.run(source)).stdout).toBe("6\n");
    expect((await shell.run(source, { env: { LC_ALL: "C" } })).stdout).toBe("6\n");
    expect((await shell.run(source, { env: { LC_ALL: "C.UTF-8" } })).stdout).toBe("5\n");
    expect((await shell.run(source, { env: { LANG: "en_US.utf8" } })).stdout).toBe("5\n");
  });

  it("reports an unset name under set -u inside a substitution and continues", async () => {
    const run = await fixture().run('set -u; x=$(echo $nope; echo in); echo "[$x] $?"');
    expect(run).toMatchObject({
      stdout: "[] 1\n",
      stderr: "bash: line 1: nope: unbound variable\n",
      exitCode: 0,
    });
  });

  it("names the expanding command's line from inside a substitution", async () => {
    const run = await fixture().run("true\necho $(nope)\necho `nope2`");
    expect(run.stderr).toBe(
      "bash: line 2: nope: command not found\nbash: line 3: nope2: command not found\n",
    );
  });

  it("does not leak cwd, variables, or options out of a substitution", async () => {
    const shell = fixture();
    const run = await shell.run('x=$(cd /; set -u; y=1; pwd); echo "$x $(pwd) [$y]"; echo $nope');
    expect(run).toMatchObject({ stdout: "/ /repo []\n\n", exitCode: 0 });
    expect(shell.cwd()).toBe("/repo");
  });
});
