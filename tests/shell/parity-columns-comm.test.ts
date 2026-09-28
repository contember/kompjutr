// `comm` against uutils comm 0.2.2 through Bash. Column suppression, the
// output delimiter, `-z`, `--total`, stdin operands, and the unsorted-input
// diagnostics with and without `--check-order` compare byte for byte.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "s1.txt": "a\nb\nc\n",
  "s2.txt": "b\nc\nd\n",
  "copy.txt": "a\nb\nc\n",
  "u1.txt": "b\na\nc\n",
  "u2.txt": "c\nb\na\n",
  "nonl.txt": "a\nb",
  "dup.txt": "a\na\nb\n",
  "ctl.txt": "a\na\u0001\nb\n",
  "z1.bin": new Uint8Array([0x61, 0x00, 0x62, 0x00, 0x63, 0x0a, 0x64, 0x00]),
  "z2.bin": new Uint8Array([0x62, 0x00, 0x63, 0x0a, 0x64, 0x00]),
  "empty.txt": "",
};

describe("the comm parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("comm matches uutils comm", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "comm s1.txt s2.txt",
    "comm -1 s1.txt s2.txt",
    "comm -2 s1.txt s2.txt",
    "comm -3 s1.txt s2.txt",
    "comm -12 s1.txt s2.txt",
    "comm -13 s1.txt s2.txt",
    "comm -23 s1.txt s2.txt",
    "comm -123 s1.txt s2.txt",
    "comm -1 -1 s1.txt s2.txt",
    "comm s1.txt empty.txt",
    "comm empty.txt s2.txt",
    "comm s1.txt nonl.txt",
    "comm dup.txt s1.txt",
    "comm ctl.txt s1.txt",
    "comm --output-delimiter=, s1.txt s2.txt",
    "comm --output-delimiter=:: -1 s1.txt s2.txt",
    "comm --output-delimiter x -3 s1.txt s2.txt",
    "comm --output-delimiter -x s1.txt s2.txt",
    "comm --output-delimiter=x --output-delimiter=x s1.txt s2.txt",
    "comm --output-delimiter= s1.txt s2.txt",
    "comm --total s1.txt s2.txt",
    "comm --total -12 --output-delimiter=: s1.txt s2.txt",
    "comm -z z1.bin z2.bin",
    "comm -z --total z1.bin z2.bin",
    "comm - s2.txt < s1.txt",
    "comm s1.txt - < s2.txt",
    "comm s1.txt -",
    "comm - - < s1.txt",
    "printf 'a\\nb' | comm - s1.txt",
    "comm --tot s1.txt s2.txt",
  ])("compares: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "comm u1.txt s2.txt",
    "comm s2.txt u1.txt",
    "comm u1.txt u2.txt",
    "comm --check-order u1.txt s2.txt",
    "comm --check-order s2.txt u2.txt",
    "comm --nocheck-order u1.txt s2.txt",
    "comm u1.txt u1.txt",
    "comm --check-order u1.txt u1.txt",
    "comm -3 u1.txt s2.txt",
    "comm --total u1.txt s2.txt",
    "comm - u1.txt < u1.txt",
  ])("checks order: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "comm",
    "comm s1.txt",
    "comm --check-order s1.txt",
    "comm s1.txt s2.txt extra",
    "comm --check-order --nocheck-order s1.txt s2.txt",
    "comm --nocheck-order --check-order s1.txt s2.txt",
    "comm --check-order --nocheck-order",
    "comm --output-delimiter=, --output-delimiter=: s1.txt s2.txt",
    "comm --output-delimiter=, --output-delimiter=: missing.txt s2.txt",
    "comm missing.txt s2.txt",
    "comm s1.txt missing.txt",
    "comm . s1.txt",
    "comm -4 s1.txt s2.txt",
    "comm -x s1.txt s2.txt",
    "comm --bogus s1.txt s2.txt",
    "comm --output-delimiter",
  ])("fails as uutils does: %j", async (source) => {
    await compare(source);
  });
});
