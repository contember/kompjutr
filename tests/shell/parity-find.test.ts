// `find -exec`, `-delete`, `-depth`, `-size`, `-empty`, `-newer`, `-mmin`, and
// `-mtime`, compared with GNU find through Bash. GNU walks in readdir order,
// so multi-line listings compare through `sort`. The seeded tree carries one
// fixed 2023 mtime on both sides; the time tests use only windows whose answer
// does not depend on the clock. Nothing here mutates a directory before a
// `-newer` test, because a mutation stamps Bash's side with the real clock.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "src/a.ts": "needle\n",
  "src/b.md": "x".repeat(600),
  "src/deep/c.ts": "",
  "src/deep/d.ts": "y".repeat(1025),
  "src-x/z.ts": "needle\n",
  "src.bak": "z".repeat(512),
  "top.ts": "",
  "docs/readme.md": "# r\n",
};

describe("the find parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("find matches GNU find", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "find . -name '*.ts' -exec echo {} \\; | sort",
    "find src -type f -exec echo pre-{}-post x{}{} \\; | sort",
    "find src -name a.ts -exec echo found {} +",
    "find src -type f -exec wc -c {} + | sort",
    "find docs -name '*.md' -exec cat {} +",
    "find src -name '*.md' -exec wc -c {} \\;",
    "find src -name a.ts -print -exec echo batch {} +",
    "find src/deep -type f -exec echo one {} + -exec echo two {} +",
    "find src-x top.ts -exec echo {} +",
    "find src -name '*.ts' -exec grep -l needle {} +",
  ])("runs -exec: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -type f -exec grep -q needle {} \\; -print | sort",
    "find . -type f ! -exec grep -q needle {} \\; | sort",
    "find . -type f \\( -exec test -s {} \\; -o -print \\) | sort",
    "find . -type f -exec test -s {} \\; -exec echo sized {} \\; | sort",
    "find . -name top.ts -exec test -s {} \\;",
    "find . -name top.ts -exec test -s {} +",
    "find . -name top.ts -exec nosuchcommand {} \\;",
    "find . -name top.ts -exec nosuchcommand {} +",
  ])("treats -exec as a test and reports its status: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -exec",
    "find . -exec echo",
    "find . -exec \\;",
    "find . -exec +",
    "find . -exec echo +",
    "find . -exec echo {} {} +",
    "find . -exec echo a{} {} +",
    "find . -exec echo {} x +",
    "find . -exec echo {} + extra",
  ])("reports GNU -exec diagnostics: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -name '*.md' -delete; find . | sort",
    "find src -delete; find . | sort",
    "find . -delete; find . | sort",
    "find src -name '*.ts' -print -delete | sort; find . | sort",
    "find . -name '*.ts' -delete -o -print | sort; find . | sort",
    "find src/deep -mindepth 1 -delete; find . | sort",
    "find src -depth -prune -delete; find . | sort",
    "find top.ts src.bak -delete; find . | sort",
    "find src -type f -exec rm {} \\; -o -type d -delete; find . | sort",
    "find src -type f -name '*.ts' -exec rm {} \\; -o -type d -delete; find . | sort",
    "mkdir -p e/f/g && find . -type d -empty -delete -print && find . | sort",
    "mkdir -p e/f/g && touch e/f/k && find e -empty -delete && find . | sort",
  ])("deletes depth first: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -name src -delete",
    "find . -maxdepth 1 -type d -delete 2>&1 | sort",
    "find src -type d -delete",
    "find . -prune -delete",
    "find ./ -maxdepth 0 -delete",
    "find src/.. -maxdepth 0 -delete",
    "find src/deep/. -maxdepth 0 -delete",
    "find . -delete x",
  ])("reports GNU -delete diagnostics: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -depth | sort",
    "find . -d -type f | sort",
    "find src -depth -name deep",
    "find src/deep -depth",
    "find . -depth -maxdepth 1 | sort",
    "find . -mindepth 2 -depth | sort",
  ])("lists depth first: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "0",
    "1",
    "2",
    "3",
    "-1",
    "+1",
    "-2",
    "+2",
    "0c",
    "7c",
    "+7c",
    "-7c",
    "512c",
    "+512c",
    "-512c",
    "1k",
    "-1k",
    "+1k",
    "2k",
    "1M",
    "-1M",
    "+1M",
    "1G",
    "300w",
    "+300w",
    "1b",
    "3b",
  ])("sizes files with -size %s", async (size) => {
    await compare(`find . -type f -size ${size} | sort`);
  });

  it.each([
    "find . -size x",
    "find . -size 1x",
    "find . -size ''",
    "find . -size +-",
    "find . -size 1kk",
    "find . -size 1.5",
    "find . -size",
  ])("reports GNU -size diagnostics: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -empty | sort",
    "find . -type f -empty | sort",
    "find . ! -empty -type f | sort",
    "mkdir e && find . -empty | sort",
    "mkdir -p e/f && find . -type d -empty | sort",
    "mkdir -p e/f && find e -empty",
    "mkdir e && find e -maxdepth 0 -empty",
    "mkdir -p e/f && find . -maxdepth 1 -empty | sort",
    "find . -maxdepth 1 -empty | sort",
  ])("tests -empty: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -newer src/a.ts | sort",
    "find . ! -newer src/a.ts | sort",
    "find . -newer src -o -name top.ts | sort",
    "find . -newer missing",
    "find missing . -newer top.ts",
    "find . -newer",
  ])("tests -newer: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "find . -mtime +1 | sort",
    "find . -mtime +0 -type f | sort",
    "find . -mtime -1 | sort",
    "find . -mtime 0 | sort",
    "find . -mtime -1.5 | sort",
    "find . -mmin +5 -type f | sort",
    "find . -mmin -5 | sort",
    "find . -mmin 1 | sort",
    "find . ! -mmin -60 -name '*.md' | sort",
    "find . -mtime x",
    "find . -mmin 1k",
    "find . -mtime ''",
    "find . -mmin",
  ])("tests ages: %j", async (source) => {
    await compare(source);
  });
});
