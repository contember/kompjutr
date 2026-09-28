// `diff` against GNU diff through Bash. Output formats, diagnostics, and
// realistic edits compare byte for byte. Where several minimal edit scripts
// exist, GNU's placement comes from its own heuristics, so random inputs
// compare the size of the script rather than its placement.

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
  a: "one\ntwo\nthree\n",
  b: "one\n2\nthree\nfour\n",
  nonl: "one\ntwo\nthree",
  bin: "x\0y\n",
  "sub/a": "one\n",
};

const SOURCE = `import { a } from "./a.js";

export function one(x: number): number {
  if (x > 0) {
    return x;
  }
  return 0;
}

export function two(y: string): string {
  const z = y.trim();
  return z;
}
`;

const EDITS: ReadonlyArray<readonly [string, string]> = [
  ["rename a symbol", SOURCE.replace("function two", "function second")],
  ["insert a line", SOURCE.replace("  const z", "  // trimmed\n  const z")],
  ["delete a block", SOURCE.replace("  if (x > 0) {\n    return x;\n  }\n", "")],
  ["append a function", `${SOURCE}\nexport const three = 3;\n`],
  ["prepend an import", `import { b } from "./b.js";\n${SOURCE}`],
  ["drop the final newline", SOURCE.slice(0, -1)],
  [
    "change two distant lines",
    SOURCE.replace("return 0;", "return -1;").replace("./a.js", "./b.js"),
  ],
];

describe("the diff parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("diff matches GNU diff", () => {
  async function compare(source: string, tree: ShellTree = TREE): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree }));
  }

  it.each([
    "diff a b",
    "diff -u a b",
    "diff -U0 a b",
    "diff -U 1 a b",
    "diff -q a b",
    "diff --brief a b",
    "diff -s a a",
    "diff a a",
    "diff nonl a",
    "diff -u nonl a",
    "diff bin a",
    "diff a sub",
    "diff sub a",
    "cat a | diff - b",
  ])("formats: %j", async (source) => {
    await compare(source);
  });

  it.each(["diff a missing", "diff a", "diff a b c", "diff -U x a b"])(
    "reports trouble: %j",
    async (source) => {
      await compare(source);
    },
  );

  it.each(EDITS)("shows a realistic edit: %s", async (_name, edited) => {
    await compare("diff -u before after; diff before after", {
      before: SOURCE,
      after: edited,
    });
  });

  it("finds an edit script exactly as small as GNU's", async () => {
    const random = seeded(7);
    const text = (): string => {
      const lines = Array.from(
        { length: Math.floor(random() * 10) },
        () => "abc}"[Math.floor(random() * 4)],
      );
      return lines.join("\n") + (random() < 0.9 ? "\n" : "");
    };
    const decoder = new TextDecoder();
    for (let round = 0; round < 60; round++) {
      const parity = await compareWithBash("diff a b | grep -c '^[<>]'", {
        tree: { a: text(), b: text() },
      });
      expect(decoder.decode(parity.ours.stdout)).toBe(decoder.decode(parity.bash.stdout));
    }
  });
});

describe("diff refusals and the placement it owns", () => {
  const encoder = new TextEncoder();

  function shell(files: Readonly<Record<string, string>>) {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles(
      Object.entries(files).map(([path, text]) => ({
        path: `/repo/${path}`,
        bytes: encoder.encode(text),
      })),
    );
    return createShell({ fs, cwd: "/repo" });
  }

  it.each(["-r", "-w", "-b", "-i", "-c", "-y"])("refuses %s by name", async (flag) => {
    const run = await shell({ a: "x\n", b: "y\n" }).run(`diff ${flag} a b`);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(`diff: ${flag} is not supported; supported: -u, -U N, -q, -s\n`);
  });

  it("refuses comparing two directories", async () => {
    const run = await shell({ "one/a": "", "two/a": "" }).run("diff one two");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe("diff: comparing directories is not supported\n");
  });

  // GNU deletes lines 3-8 here; deleting 4-9 is equally minimal.
  it("places an ambiguous run by its own rule", async () => {
    const run = await shell({ a: "a\nb\na\nc\nb\nc\na\na\na\n", b: "a\n}\nb\na\n" }).run(
      "diff a b",
    );
    expect(run.stdout).toBe("1a2\n> }\n4,9d4\n< c\n< b\n< c\n< a\n< a\n< a\n");
    expect(run.exitCode).toBe(1);
  });
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}
