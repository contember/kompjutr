// `find`, `ls`, and recursive search print results under each operand as it
// was typed, compared with GNU find, ls, grep, and ripgrep through Bash.
// GNU find walks in readdir order, so its listings compare through `sort`.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "src/a.ts": "needle\n",
  "src/b.md": "needle\n",
  "src/Deep/c.TS": "",
  "src-x/z.ts": "needle\n",
  "top.ts": "other\n",
  ".hid/h.ts": "",
  "node_modules/m/i.js": "",
};

describe("the path parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("paths match GNU tools", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "find . | sort",
    "find src | sort",
    "find src/ | sort",
    "find -name '*.md'",
    "find src top.ts -name '*.ts' | sort",
    "find . -maxdepth 0",
  ])("prints under the starting point as typed: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -name '*.ts' | sort",
    "find . -iname '*.ts' | sort",
    "find . -name '*.TS' | sort",
    "find . -path '*src*' | sort",
    "find . -path './src/*' -name '*.ts' | sort",
    "find . -type f,d -name 'src*' | sort",
  ])("matches names and paths: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -name '*.ts' -o -name '*.md' | sort",
    "find . \\( -name '*.ts' -o -name '*.md' \\) -type f | sort",
    "find . -type f -not -name '*.ts' | sort",
    "find . ! -type d | sort",
    "find . -name a.ts -print -name a.ts -print",
    "find . -false -o -name top.ts",
    "find . -true -a -name top.ts",
  ])("combines tests with operators: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -path ./src -prune -o -print | sort",
    "find . -name node_modules -prune -o -name '*.js' -print | sort",
    "find . -name node_modules -prune -o -type f -print | sort",
    "find . -maxdepth 1 | sort",
    "find . -maxdepth 1 -type d | sort",
    "find . -name '*.ts' -maxdepth 1 | sort",
    "find . -mindepth 2 -type f | sort",
  ])("limits the walk: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -name '*.ts' -print0 | xargs -0 -n1 echo | sort",
    "find src -type f -print0 | xargs -0 grep -l needle | sort",
  ])("separates with NUL: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find missing src -name a.ts",
    "find . -bogus",
    "find . -name",
    "find . -type q",
    "find . \\( -name a.ts",
    "find . -name a.ts \\)",
    "find . -o -name x",
    "find . -name x -o",
    "find . -maxdepth x",
    "find . -name a.ts extra",
  ])("reports GNU diagnostics: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "ls -R src",
    "ls -R src/",
    "ls src top.ts",
    "ls top.ts src/a.ts",
    "ls src/*.ts",
    "ls -d src src-x",
    "ls missing src",
  ])("lists operands as typed: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "grep -r needle . | sort",
    "grep -rl needle src/ | sort",
    "grep -rn needle | sort",
    "grep -r needle missing src | sort",
    "grep -rc needle . | sort",
    "rg -l needle src | sort",
    "rg needle ./src | sort",
    "find . -name '*.ts' | xargs grep -l needle | sort",
  ])("searches under the operand as typed: %j", async (source) => {
    await compare(source);
  });
});

describe("find refusals and orders the shell owns", () => {
  const encoder = new TextEncoder();

  function shell() {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles(
      Object.entries(TREE).map(([path, text]) => ({
        path: `/repo/${path}`,
        bytes: encoder.encode(typeof text === "string" ? text : ""),
      })),
    );
    return createShell({ fs, cwd: "/repo" });
  }

  it.each(["-execdir", "-ok", "-regex", "-amin"])("refuses %s by name", async (predicate) => {
    const run = await shell().run(`find . ${predicate} x`);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(`find: ${predicate} is not supported`);
  });

  // GNU find follows readdir; this shell lists in path byte order.
  it("walks in path byte order", async () => {
    const run = await shell().run("find src src-x");
    expect(run.stdout).toBe(
      "src\nsrc/Deep\nsrc/Deep/c.TS\nsrc/a.ts\nsrc/b.md\nsrc-x\nsrc-x/z.ts\n",
    );
  });

  // Real rg reads a piped stdin instead, so the harness cannot ask it.
  it("searches the working directory with rg and no path", async () => {
    const run = await shell().run("rg -l needle");
    expect(run.stdout).toBe("src-x/z.ts\nsrc/a.ts\nsrc/b.md\n");
  });
});
