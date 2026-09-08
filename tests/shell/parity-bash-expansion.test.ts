// Named parameters are compared with Bash under the controlled environment in
// shell-parity.ts. Limit refusals and deliberately unsupported forms are local.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { type ByteStream, encode } from "../../packages/do/src/shell/exec/bytes.js";
import {
  type Command,
  type RetainedBudget,
  result,
} from "../../packages/do/src/shell/exec/context.js";
import { createShell, DEFAULT_LIMITS, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  ".root.ts": "",
  "alpha.ts": "",
  "beta.ts": "",
  "notes.md": "",
  "sub/.nested.ts": "",
  "sub/deep/deep.ts": "",
  "sub/nested.ts": "",
  ".hidden/inside.ts": "",
  ".hidden/.both.ts": "",
  "visible/.nested.ts": "",
  "visible/open.ts": "",
  "order-\uE000.ts": "",
  "order-\u{10000}.ts": "",
};

describe.skipIf(!REAL_BASH)("named parameter expansion matches Bash", () => {
  async function compare(source: string, env: Readonly<Record<string, string>>): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE, env }));
  }

  it("expands mixed words and multiple parameters", async () => {
    await compare(`printf '<%s>\\n' pre${"$"}{VALUE}post`, { VALUE: "one two" });
    await compare(`printf '<%s>\\n' a${"$"}{ONE}b${"$"}{TWO}c`, {
      ONE: "1 2",
      TWO: "3 4",
    });
  });

  it("keeps double-quoted expansion in one field", async () => {
    await compare(`printf '<%s>\\n' "pre\${VALUE}post"`, { VALUE: "one two *.ts" });
  });

  it("drops an unquoted empty expansion but retains a quoted one", async () => {
    await compare(`printf '<%s>\\n' before $EMPTY "$EMPTY" after`, { EMPTY: "" });
  });

  it("splits unquoted expansion on default IFS", async () => {
    await compare(`printf '<%s>\\n' $VALUE`, { VALUE: " one\ttwo\nthree " });
  });

  it("collapses repeated IFS whitespace and drops whitespace-only values", async () => {
    await compare(`printf '<%s>\\n' before $VALUE after`, {
      VALUE: " \t\n  one \t\t \n two \n\n ",
    });
    await compare(`printf '<%s>\\n' before $VALUE after`, { VALUE: " \t\n  " });
  });

  it("keeps escaped and single-quoted dollars literal", async () => {
    await compare(String.raw`printf '<%s>\n' \$NAME "\$NAME" '$NAME'`, { NAME: "expanded" });
  });

  it("pathname-expands typed and generated relative patterns as relative argv", async () => {
    await compare(`printf '<%s>\\n' *.ts ./*.ts $PATTERN`, { PATTERN: "*.ts" });
  });

  it("does not split or pathname-expand a quoted generated pattern", async () => {
    await compare(`printf '<%s>\\n' "$PATTERN"`, { PATTERN: "*.ts one" });
  });

  it("pathname-expands every generated field independently", async () => {
    await compare(`printf '<%s>\\n' $PATTERNS`, { PATTERNS: "*.md sub/*.ts" });
  });

  it("retains unmatched generated patterns", async () => {
    await compare(`printf '<%s>\\n' $PATTERNS`, {
      PATTERNS: "missing*.ts absent?.md",
    });
  });

  it("requires an explicit leading dot in every pathname component", async () => {
    await compare(`printf '<%s>\\n' *.ts */*.ts`, {});
    await compare(`printf '<%s>\\n' .*.ts */.*.ts .hidden/*.ts`, {});
    await compare(`printf '<%s>\\n' [.]root.ts`, {});
  });

  it("treats repeated stars as one star with globstar disabled", async () => {
    await compare(`printf '<%s>\\n' ***.ts **/*.ts`, {});
  });

  it("orders UTF-8 pathname matches like Bash under the C locale", async () => {
    await compare(`printf '<%s>\\n' order-*.ts`, {});
  });
});

describe("named parameter expansion boundaries", () => {
  let fs: Filesystem;
  let shell: Shell;

  beforeEach(() => {
    fs = createFilesystem(new TestDatabase());
    shell = createShell({ fs, cwd: "/repo" });
  });

  it("expands an unset name to empty", async () => {
    expect(
      await shell.run(`printf '<%s>\\n' before $UNSET "$UNSET" "$toString" after`),
    ).toMatchObject({
      stdout: "<before>\n<>\n<>\n<after>\n",
      stderr: "",
      exitCode: 0,
    });
  });

  const unsupportedBareParameters = [
    { label: "positional parameter", parameter: "$1" },
    { label: "argument parameter", parameter: "$@" },
    { label: "argument-list parameter", parameter: "$*" },
    { label: "argument-count parameter", parameter: "$#" },
    { label: "status parameter", parameter: "$?" },
    { label: "background-process parameter", parameter: "$!" },
    { label: "option-flags parameter", parameter: "$-" },
    { label: "process parameter", parameter: "$$" },
  ];

  it.each(unsupportedBareParameters)("rejects unsupported $label", async ({ parameter }) => {
    const run = await shell.run(`echo ${parameter}`);
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain("parameter");
  });

  it.each(unsupportedBareParameters)("rejects quoted unsupported $label", async ({ parameter }) => {
    const run = await shell.run(`echo "${parameter}"`);
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain("parameter");
  });

  it.each([
    ["$COMMAND arg", "command names"],
    ["echo out > $TARGET", "redirection targets"],
    ["echo out 1>&$TARGET", "redirection targets"],
    ["NAME=value echo out", "assignment"],
    ["NAME=$VALUE echo out", "assignment"],
    [`echo ${"$"}{NAME:-fallback}`, "operator"],
  ])("rejects %s", async (source, message) => {
    const run = await shell.run(source, {
      env: { COMMAND: "echo", TARGET: "out", NAME: "set", VALUE: "value" },
    });
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain(message);
  });

  it("applies the argv-count bound to fields generated by splitting", async () => {
    const run = await shell.run("true $VALUES", { env: { VALUES: "x ".repeat(10_001) } });
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain("E2BIG");
  });

  it("applies the argv-count bound to matches from a generated pattern", async () => {
    fs.writeFiles(
      Array.from({ length: 10_001 }, (_, index) => ({
        path: `/repo/glob/f${String(index).padStart(5, "0")}.txt`,
        bytes: new Uint8Array(0),
      })),
    );
    const run = await shell.run("true $PATTERN", { env: { PATTERN: "glob/*.txt" } });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("E2BIG");
  });

  it("charges generated fields to the retained-byte bound", async () => {
    const atLimit = createShell({
      fs,
      cwd: "/repo",
      limits: { ...DEFAULT_LIMITS, maxRetainedBytes: 21 },
    });
    const overLimit = createShell({
      fs,
      cwd: "/repo",
      sessionId: "over-limit",
      limits: { ...DEFAULT_LIMITS, maxRetainedBytes: 20 },
    });
    expect(await atLimit.run("true $VALUE", { env: { VALUE: "12345678" } })).toMatchObject({
      exitCode: 0,
      peakRetainedBytes: 21,
    });
    const over = await overLimit.run("true $VALUE", { env: { VALUE: "12345678" } });
    expect(over.exitCode).toBe(2);
    expect(over.stderr).toContain("retained-memory limit");
  });

  it("expands every command from the frozen environment snapshot", async () => {
    const supplied = { VALUE: "before" };
    let captured: readonly string[] = [];
    const mutate: Command = async () => {
      await Promise.resolve();
      supplied.VALUE = "after";
      return result(empty());
    };
    const capture: Command = (context) => {
      captured = context.argv;
      return result(empty());
    };
    const snapshotShell = createShell({
      fs,
      cwd: "/repo",
      sessionId: "snapshot",
      commands: new Map([
        ["mutate", mutate],
        ["capture", capture],
      ]),
    });

    expect(await snapshotShell.run("mutate; capture $VALUE", { env: supplied })).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(supplied.VALUE).toBe("after");
    expect(captured).toEqual(["before"]);
  });

  it.each(["1>&2 2>/dev/null", "2>/dev/null 1>&2"])(
    "releases generated argv after async rejection with %s",
    async (redirections) => {
      const failure = new Error("async expansion witness rejected");
      let retained: RetainedBudget | undefined;
      const reject: Command = (context) => {
        retained = context.fs.retained;
        return result(
          (async function* (): ByteStream {
            await Promise.resolve();
            context.warn("before rejection");
            yield encode(context.argv[0] ?? "");
            await Promise.resolve();
            throw failure;
          })(),
        );
      };
      const rejectingShell = createShell({
        fs,
        cwd: "/repo",
        sessionId: redirections,
        commands: new Map([["reject", reject]]),
      });

      await expect(
        rejectingShell.run(`reject $VALUE ${redirections}`, { env: { VALUE: "generated" } }),
      ).rejects.toThrow(failure);
      expect(retained?.available).toBe(retained?.max);
    },
  );
});

function* empty(): ByteStream {}
