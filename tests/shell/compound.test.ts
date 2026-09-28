// Local pins for compound commands: the refusals, the run-wide loop iteration
// limit, what a loop variable exports, `set -u` (whose unset names the parity
// harness cannot express; each expectation below was taken from Bash 5.2),
// retained-byte release, laziness, and where the planner's rewrites stop.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { ByteStream } from "../../packages/do/src/shell/exec/bytes.js";
import {
  type Command,
  type RetainedBudget,
  result,
} from "../../packages/do/src/shell/exec/context.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { parse } from "../../packages/do/src/shell/parse/parser.js";
import { planScript } from "../../packages/do/src/shell/plan/plan.js";
import type { PlannedPipeline } from "../../packages/do/src/shell/plan/types.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

function empty(): ByteStream {
  return (function* (): ByteStream {})();
}

function fixture(commands?: ReadonlyMap<string, Command>): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
  fs.writeFiles([
    { path: "/repo/lines.txt", bytes: ENCODER.encode("l1\nl2\nl3\n") },
    { path: "/repo/sub/inner.txt", bytes: ENCODER.encode("inner\n") },
    { path: "/repo/big.txt", bytes: ENCODER.encode("x\n".repeat(50_000)) },
  ]);
  return createShell({ fs, cwd: "/repo", commands });
}

function firstPipeline(source: string): PlannedPipeline {
  const step = planScript(parse(source)).steps[0];
  if (step === undefined) throw new Error("no steps");
  return step.pipeline;
}

describe("compound refusals", () => {
  it.each([
    ["while true; do echo x; done", "`while` is not supported"],
    ["until false; do echo x; done", "`until` is not supported"],
    ["case x in x) echo x;; esac", "`case` is not supported"],
    ["select x in a; do echo; done", "`select` is not supported"],
    ["function f { echo; }", "`function` is not supported"],
    ["f() { echo; }", "function definition is not supported"],
    ["time ls", "`time` is not supported"],
    ["coproc cat", "`coproc` is not supported"],
    ["for x; do echo; done", "`for` without `in` (over positional parameters) is not supported"],
    ["for x do echo; done", "`for` without `in` (over positional parameters) is not supported"],
    ["for ((i=0; i<2; i++)); do echo; done", "arithmetic command is not supported"],
    ["((1 + 1))", "arithmetic command is not supported"],
    ["[[ -f x ]]", "conditional expression is not supported"],
    ["echo x &", "background execution is not supported"],
    ["{ echo x & }", "background execution is not supported"],
    ["for 1x in a; do echo; done", "`for` needs a variable name"],
  ])("refuses %j before running anything", async (source, message) => {
    const run = await fixture().run(`echo before; ${source}`);
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toBe(`kompjutr: ${message}\n`);
  });

  it.each([
    ["{ echo a }", "syntax error: unexpected end of input, expected `}`"],
    ["{ echo a; } foo", "syntax error near unexpected token `foo'"],
    ["{ }", "syntax error near unexpected token `}'"],
    ["{", "syntax error: unexpected end of input"],
    ["( )", "syntax error near unexpected token `)'"],
    ["(echo a", "syntax error: unexpected end of input, expected `)`"],
    ["echo a)", "syntax error near unexpected token `)'"],
    ["if true; then fi", "syntax error near unexpected token `fi'"],
    ["if true; fi", "syntax error near unexpected token `fi'"],
    ["if true; then echo; fi foo", "syntax error near unexpected token `foo'"],
    ["if true; then echo; else fi", "syntax error near unexpected token `fi'"],
    ["for x in a b do echo; done", "syntax error near unexpected token `done'"],
    ["for x in a; echo; done", "syntax error near unexpected token `echo'"],
    ["for x in a; do done", "syntax error near unexpected token `done'"],
    ["for x in a | b; do echo; done", "syntax error near unexpected token `|'"],
    ["done", "syntax error near unexpected token `done'"],
    ["echo a; fi", "syntax error near unexpected token `fi'"],
    ["echo a | then", "syntax error near unexpected token `then'"],
    ["for i in 1; do; echo a; done", "syntax error near unexpected token `;'"],
    ["echo a; ; echo b", "syntax error near unexpected token `;'"],
    ["ls | | wc", "syntax error near unexpected token `|'"],
  ])("refuses the syntax error in %j", async (source, message) => {
    const run = await fixture().run(source);
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toBe(`kompjutr: ${message}\n`);
  });

  it.each([
    ["set", "set: listing variables is not supported\n"],
    ["set -x", "set: -x is not supported\n"],
    ["set -ex", "set: -x is not supported\n"],
    ["set +v", "set: +v is not supported\n"],
    ["set -o xtrace", "set: -o xtrace is not supported\n"],
    ["set -o", "set: -o without an option name is not supported\n"],
    ["set --", "set: positional parameters are not supported\n"],
    ["set -", "set: positional parameters are not supported\n"],
    ["set a b", "set: positional parameters are not supported\n"],
  ])("refuses %j and leaves the options alone", async (source, stderr) => {
    const run = await fixture().run(`${source}; false; echo reached`);
    expect(run).toMatchObject({ stdout: "reached\n", stderr, exitCode: 0 });
  });
});

describe("the loop iteration limit", () => {
  it("admits exactly the argv ceiling of iterations across nested loops", async () => {
    // 100 outer iterations plus 100 * 99 inner ones.
    const run = await fixture().run(
      "for a in {1..100}; do for b in {1..99}; do true; done; done; echo done",
    );
    expect(run).toMatchObject({ stdout: "done\n", stderr: "", exitCode: 0 });
  });

  it("fails the run on the first iteration past the ceiling", async () => {
    const run = await fixture().run(
      "for a in {1..101}; do for b in {1..99}; do true; done; done; echo unreachable",
    );
    expect(run).toMatchObject({
      stdout: "",
      stderr: "kompjutr: for: exceeded the 10000-iteration loop iteration limit\n",
      exitCode: 2,
    });
  });

  it("counts subshells and pipeline stages against the same run-wide budget", async () => {
    const run = await fixture().run(
      "(for i in {1..6000}; do true; done); for i in {1..6000}; do true; done | cat",
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("loop iteration limit");
  });
});

describe("loop variables", () => {
  function capturing(): {
    shell: Shell;
    seen: Array<Readonly<Record<string, string>> | undefined>;
  } {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const capture: Command = (context) => {
      seen.push(context.env);
      return result(empty());
    };
    return { shell: fixture(new Map([["capture", capture]])), seen };
  }

  it("binds a shell variable that commands do not see in their environment", async () => {
    const { shell, seen } = capturing();
    const run = await shell.run("for x in 1 2; do capture; echo $x; done; echo after $x", {
      env: { KEEP: "k" },
    });
    expect(run.stdout).toBe("1\n2\nafter 2\n");
    expect(seen).toEqual([{ KEEP: "k" }, { KEEP: "k" }]);
  });

  it("updates the environment when the name was already exported", async () => {
    const { shell, seen } = capturing();
    await shell.run("for x in 1; do capture; done; capture", { env: { x: "0" } });
    expect(seen).toEqual([{ x: "1" }, { x: "1" }]);
  });

  it("keeps a variable set inside a subshell or a pipeline stage out of the parent", async () => {
    const run = await fixture().run(
      '(for x in in-sub; do true; done); for x in in-stage; do true; done | cat; echo "<$x>"',
    );
    expect(run.stdout).toBe("<>\n");
  });
});

describe("set -u", () => {
  it.each([
    ["set -u; echo $X; echo after", "", "bash: line 1: X: unbound variable\n", 127],
    [`set -u; echo "${"$"}{X}"`, "", "bash: line 1: X: unbound variable\n", 127],
    ["set -eu; echo $X", "", "bash: line 1: X: unbound variable\n", 1],
    ["set -u; echo $X 2>/dev/null; echo $?", "", "bash: line 1: X: unbound variable\n", 127],
    ["set -u; true $X && echo no; echo no", "", "bash: line 1: X: unbound variable\n", 127],
    ["set -u; { echo $X; }; echo no", "", "bash: line 1: X: unbound variable\n", 127],
    ["set -u; if true; then echo $X; fi; echo no", "", "bash: line 1: X: unbound variable\n", 127],
    ["set -u\nfor i in $X; do true; done; echo no", "", "bash: line 2: X: unbound variable\n", 127],
    ["set -u\necho a\necho $X", "a\n", "bash: line 3: X: unbound variable\n", 127],
    ["set -u; (echo $X; echo no); echo $?", "1\n", "bash: line 1: X: unbound variable\n", 0],
    ["(set -u; echo $X); echo $?", "1\n", "bash: line 1: X: unbound variable\n", 0],
    [
      "set -u; (for i in 1; do echo $X; done); echo $?",
      "1\n",
      "bash: line 1: X: unbound variable\n",
      0,
    ],
    ["set -u; echo $X | cat; echo after $?", "after 0\n", "bash: line 1: X: unbound variable\n", 0],
    ["set -uo pipefail; echo $X | cat; echo $?", "127\n", "bash: line 1: X: unbound variable\n", 0],
    ["set -euo pipefail; echo $X | cat; echo $?", "", "bash: line 1: X: unbound variable\n", 1],
    [
      "set -uo pipefail; { echo $X; } | cat; echo $?",
      "1\n",
      "bash: line 1: X: unbound variable\n",
      0,
    ],
    ["set -u; cat <<< $X; echo $?", "127\n", "bash: line 1: X: unbound variable\n", 0],
    ["set -u; cat <<E\n$X\nE\necho $?", "127\n", "bash: line 1: X: unbound variable\n", 0],
    ["set -u; cat <<< $X || echo alt $?", "alt 127\n", "bash: line 1: X: unbound variable\n", 0],
    [
      "set -u; (cat <<< $X; echo in $?); echo $?",
      "in 1\n0\n",
      "bash: line 1: X: unbound variable\n",
      0,
    ],
    ["set -eu; cat <<< $X; echo no", "", "bash: line 1: X: unbound variable\n", 1],
    [`set -u; true; echo $? ${"$"}{?}`, "0 0\n", "", 0],
    ['set -u; set +u; echo "<$X>"', "<>\n", "", 0],
    ["set -o nounset; echo $X", "", "bash: line 1: X: unbound variable\n", 127],
  ])("matches Bash for %j", async (source, stdout, stderr, exitCode) => {
    expect(await fixture().run(source)).toMatchObject({ stdout, stderr, exitCode });
  });

  it("treats a caller variable and a loop variable as set", async () => {
    const run = await fixture().run("set -u; for i in a; do echo $i$SET; done; echo $i", {
      env: { SET: "!" },
    });
    expect(run).toMatchObject({ stdout: "a!\na\n", stderr: "", exitCode: 0 });
  });
});

describe("compound execution", () => {
  it("keeps a group's cd and discards a subshell's or a pipeline stage's", async () => {
    const shell = fixture();
    expect((await shell.run("(cd sub)")).cwd).toBe("/repo");
    expect((await shell.run("cd sub | cat")).cwd).toBe("/repo");
    expect((await shell.run("{ cd sub; } | cat")).cwd).toBe("/repo");
    expect((await shell.run("{ cd sub; }")).cwd).toBe("/repo/sub");
    expect(shell.cwd()).toBe("/repo/sub");
  });

  it("stops the body of a compound stage when its consumer stops pulling", async () => {
    const run = await fixture().run("for i in {1..500}; do cat big.txt; done | head -1");
    expect(run).toMatchObject({ stdout: "x\n", exitCode: 0 });
    expect(run.operations).toBeLessThan(10);
  });

  it("shares a stage's stdin among the body's commands", async () => {
    const shell = fixture();
    expect((await shell.run("{ head -1; cat; } < lines.txt")).stdout).toBe("l1\nl2\nl3\n");
    expect((await shell.run("cat lines.txt | { head -1; cat; }")).stdout).toBe("l1\n");
    expect((await shell.run("{ head -1; cat; }", { stdin: "caller\nrest\n" })).stdout).toBe(
      "caller\nrest\n",
    );
  });

  // `head -c N` reads exactly N bytes from a pipe, so Bash leaves the rest for
  // the next reader (`abc\n`, `a\nb\n`). The cursor cannot tell a byte count
  // from a read-ahead `head -n`, whose chunk a pipe consumes, so the chunk is
  // consumed here too.
  it("consumes the chunk a partial reader took from a pipe", async () => {
    const shell = fixture();
    expect((await shell.run("echo abc | { head -c1; cat; }")).stdout).toBe("a");
    expect((await shell.run("echo abc | for i in 1 2; do head -c1; echo; done")).stdout).toBe(
      "a\n\n",
    );
  });

  it("releases every retained byte once compound stages settle", async () => {
    let retained: RetainedBudget | undefined;
    const capture: Command = (context) => {
      retained = context.fs.retained;
      return result(empty());
    };
    const shell = fixture(new Map([["capture", capture]]));
    const run = await shell.run(
      [
        "capture",
        "for x in a b; do echo $x; done | { head -1; cat; } 2>&1 | cat",
        "{ head -1; cat; } < lines.txt > out.txt",
        "(for y in 1 2; do echo $y >&2; done) 2> err.txt",
        "for i in 1 2; do break; done | cat",
        "cat big.txt | { head -1; } | cat",
      ].join("\n"),
    );
    expect(run.exitCode).toBe(0);
    expect(retained?.available).toBe(retained?.max);
  });

  it("hands a body's commands the bounds of the compound's destinations", async () => {
    const seen: Array<{ discardStderr: boolean; maxStdoutBytes: number }> = [];
    const probe: Command = (context) => {
      seen.push({
        discardStderr: context.output.discardStderr,
        maxStdoutBytes: context.output.maxStdoutBytes,
      });
      return result(empty());
    };
    const shell = fixture(new Map([["probe", probe]]));
    await shell.run(
      "{ probe; } 2>/dev/null; { ( probe ); } 2>/dev/null; { probe; }; { probe; } | cat",
    );
    expect(seen).toEqual([
      { discardStderr: true, maxStdoutBytes: 1_000_000 },
      { discardStderr: true, maxStdoutBytes: 1_000_000 },
      { discardStderr: false, maxStdoutBytes: 1_000_000 },
      { discardStderr: false, maxStdoutBytes: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it("releases retained bytes when a compound stage rejects", async () => {
    const failure = new Error("compound witness rejected");
    let retained: RetainedBudget | undefined;
    const reject: Command = (context) => {
      retained = context.fs.retained;
      return result(
        (async function* (): ByteStream {
          await Promise.resolve();
          yield ENCODER.encode(context.argv[0] ?? "");
          throw failure;
        })(),
      );
    };
    const shell = fixture(new Map([["reject", reject]]));
    await expect(shell.run("for x in value; do reject $x; done 2>&1 | { cat; }")).rejects.toThrow(
      failure,
    );
    expect(retained?.available).toBe(retained?.max);
  });
});

describe("planning around compound stages", () => {
  it("publishes no demand hint across a compound boundary", () => {
    expect(firstPipeline("{ grep -r x .; } | head -3")).toMatchObject({
      limitHint: null,
      fusions: [],
    });
    expect(firstPipeline("for f in a; do grep -r x .; done | head -3").limitHint).toBeNull();
  });

  it("does not fuse find into a search across a compound boundary", () => {
    expect(firstPipeline("(find . -name '*.ts') | xargs grep x").fusions).toEqual([]);
  });

  it("still plans the pipelines inside a compound body", () => {
    const group = firstPipeline("{ find . -name '*.ts' | xargs grep x | head -2; }").commands[0];
    if (group?.kind !== "group") throw new Error("expected a group");
    const inner = group.body.steps[0]?.pipeline;
    expect(inner?.limitHint).toBe(2);
    expect(inner?.fusions).toEqual([
      "find | xargs grep fused into one search",
      "head -2 published as a demand hint",
    ]);
  });
});
