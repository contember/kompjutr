// `cat`'s display options against uutils cat through Bash: numbering,
// squeezing, visible ends, tabs and control bytes, and clap's diagnostics.
// `--help` and `--version` describe the host binary and are refused locally.

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
  "f.txt": "a\tb\n\n\n\nc\x01d\x7f\xc3\xa9\r\n\nlast",
  "g.txt": "one\n\n\ntwo\n",
  "crlf.txt": "x\r\ny\rz\r",
  "blank.txt": "\n\n\n",
  "high.bin": new Uint8Array([0x80, 0x89, 0x8a, 0x9b, 0xa0, 0xff, 0x0a, 0x00, 0x1f, 0x0a]),
  "dir/inner.txt": "inner\n",
};

describe("the cat options parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("cat options match uutils cat", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "cat -n f.txt",
    "cat -b f.txt",
    "cat -s f.txt",
    "cat -E f.txt",
    "cat -T f.txt",
    "cat -v f.txt",
    "cat -A f.txt",
    "cat -e f.txt",
    "cat -t f.txt",
    "cat -u f.txt",
    "cat -nb f.txt",
    "cat -bn f.txt",
    "cat -sn f.txt",
    "cat -sb f.txt",
    "cat -nE f.txt",
    "cat -sA g.txt",
    "cat -nsET f.txt",
    "cat -n -s g.txt",
    "cat -E crlf.txt",
    "cat -A crlf.txt",
    "cat -T crlf.txt",
    "cat -v high.bin",
    "cat -T high.bin",
    "cat -A high.bin",
    "cat -s blank.txt",
    "cat -sn blank.txt",
    "cat -b blank.txt",
    "cat -nE blank.txt",
  ])("renders one file: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "cat --number f.txt",
    "cat --number-nonblank g.txt",
    "cat --squeeze-blank g.txt",
    "cat --show-ends g.txt",
    "cat --show-tabs f.txt",
    "cat --show-nonprinting f.txt",
    "cat --show-all f.txt",
    "cat --num f.txt",
    "cat --squeeze g.txt",
    "cat --show-t f.txt",
  ])("accepts the long spelling: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "cat -n f.txt g.txt",
    "cat -s g.txt blank.txt g.txt",
    "cat -b g.txt f.txt",
    "cat -n crlf.txt g.txt",
    "printf 'p\\n\\nq\\n' | cat -n",
    "printf 'p\\n\\nq\\n' | cat -n -",
    "printf 'p\\n' | cat -n g.txt - g.txt",
    "printf 'p\\n' | cat - g.txt",
    "printf 'p\\n' | cat - -",
    "printf 'p\\n' | cat -",
    "cat -- g.txt",
    "cat -n -- g.txt",
    "cat -A -n f.txt | head -3",
  ])("renders across inputs: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "cat -x f.txt",
    "cat -nx f.txt",
    "cat -xn f.txt",
    "cat --foo f.txt",
    "cat --show f.txt",
    "cat --numbr f.txt",
    "cat --x f.txt",
    "cat --number=3 f.txt",
    "cat --number-nonblank=x f.txt",
    "cat -n=3 f.txt",
    "cat -5 f.txt",
  ])("refuses with clap's diagnostic: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "cat -n missing.txt",
    "cat -n g.txt missing.txt g.txt",
    "cat missing.txt",
    "cat g.txt missing.txt",
    "cat -- -n",
    "cat -n dir",
    "cat dir",
    "cat dir g.txt",
  ])("reports unreadable operands: %j", async (source) => {
    await compare(source);
  });
});

describe("cat refuses what describes the host binary", () => {
  it.each(["cat --help", "cat -h", "cat --version", "cat -V"])("%s", async (source) => {
    const fs = createFilesystem(new TestDatabase());
    fs.writeFiles([{ path: "/repo", mode: 0o755 }]);
    const shell = createShell({ fs, cwd: "/repo" });
    const run = await shell.exec(source);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(run.stderr)).toMatch(
      /^cat: --(help|version) is not supported\n$/,
    );
  });
});

describe("cat display state crosses read chunks", () => {
  it.each([
    "cat -A f.txt g.txt crlf.txt",
    "cat -ns g.txt blank.txt",
    "cat -E crlf.txt",
    "cat -vb high.bin",
  ])("renders %s the same with a 3-byte read budget", async (source) => {
    const run = async (readBudget: number): Promise<Uint8Array> => {
      const fs = createFilesystem(new TestDatabase());
      fs.writeFiles([
        { path: "/repo", mode: 0o755 },
        ...Object.entries(TREE).map(([relative, content]) => ({
          path: `/repo/${relative}`,
          bytes: typeof content === "string" ? new TextEncoder().encode(content) : content,
        })),
      ]);
      const limits = { maxOutputBytes: 1_000_000, maxOperations: 10_000, readBudget };
      const shell = createShell({ fs, cwd: "/repo", limits });
      const result = await shell.exec(source);
      expect(result.exitCode).toBe(0);
      return result.stdout;
    };
    expect(await run(3)).toEqual(await run(1_500_000));
  });
});
