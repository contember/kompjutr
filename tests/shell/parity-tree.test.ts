// `tree` against tree 2.2.1 and `du` against uutils du through Bash. The seed
// puts names that sort between `a` and `a/` (`a-b`, `a.txt`) next to `a`, so
// a walk that follows path order instead of sibling order is caught.
//
// `du` compares only host-independent forms: apparent sizes (uutils counts a
// directory as 0 bytes, as the shell does) where the output has one row per
// operand or a single chain of directories. Several siblings print in the
// host's readdir order, which is not comparable; parity-tree-local.test.ts pins
// the shell's order and its block-free default instead.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "a/x": "hi\n",
  "a/b/c": "22\n",
  "a.txt": "1\n",
  "a-b/y": "y\n",
  big: "z".repeat(1500),
  "src/z.ts": "z\n",
  "src-old/q": "q\n",
  ".hidden/f": "h\n",
  ".g": "g\n",
  "sp ace/back\\slash": "s\n",
  "é.txt": "e\n",
  "chain/one/two/leaf": "x".repeat(2048),
};

describe("the tree parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("tree matches tree 2.2.1", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "tree",
    "tree .",
    "tree -a",
    "tree -d",
    "tree -L 1",
    "tree -L 2",
    "tree -L2",
    "tree -dL1",
    "tree -L 01",
    "tree -f",
    "tree -F",
    "tree -i",
    "tree -fi",
    "tree --noreport",
    "tree --dirsfirst",
    "tree --dirsfirst -a",
    "tree --charset=utf-8",
    "tree --charset utf8",
    "tree --charset=ascii",
    "tree -adfF --dirsfirst -L 3",
  ])("walks: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "tree -I 'src*|big'",
    "tree -I 'b/'",
    "tree -I a -I big",
    "tree -I 'a/b'",
    "tree -P '*.ts'",
    "tree -P x -P q",
    "tree -P '[a-b]*'",
    "tree -P '[^a]*'",
    "tree -P '?.txt'",
    "tree -P '*c*' -a",
    "tree -P 'a*/'",
    "tree -P '\\x'",
    "tree -P '*.txt|big' -d",
  ])("filters: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "tree a src",
    "tree a/",
    "tree -f a/",
    "tree -F a/",
    "tree -f -F a",
    "tree -fF a//",
    "tree -dF a/",
    "tree -dfF",
    "tree chain",
    "tree 'sp ace'",
    "tree a.txt",
    "tree nope",
    "tree nope a",
    "tree a nope",
    "tree -- a",
    "tree | head -3",
  ])("operands: %j", async (source) => {
    await compare(source);
  });

  it.each(["tree -L 0", "tree -L x", "tree -L", "tree -P", "tree -I"])(
    "rejects: %j",
    async (source) => {
      await compare(source);
    },
  );
});

describe.skipIf(!REAL_BASH)("du matches uutils du on host-independent forms", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "du -b big",
    "du --bytes a.txt",
    "du --apparent-size big",
    "du --apparent-size -k big",
    "du --apparent-size -m big",
    "du --apparent-size -h big",
    "du -bh big",
    "du -bk big",
    "du -km --apparent-size big",
    "du -b big a.txt",
    "du -cb big a.txt",
    "du -b -d 0 big",
  ])("files: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "du -sb",
    "du -sb .",
    "du -sb a",
    "du -sb a/",
    "du -sb a//",
    "du -sb a src a",
    "du -sbc a src",
    "du --summarize --bytes --total a src",
    "du -sh --apparent-size .",
    "du -shc --apparent-size a big",
    "du -s --apparent-size -m chain",
    "du -b -d 0 a",
    "du -b --max-depth=0 a",
    "du -b --max-depth 0 a",
    "du -sab a",
    "du -ab a/b",
    "du -b chain",
    "du -ab chain",
    "du -ab chain/",
    "du --apparent-size -a chain",
    "du -abh chain",
    "du -b -d 1 chain",
    "du -ab -d 2 chain",
  ])("directories: %j", async (source) => {
    await compare(source);
  });

  it.each(["du -b nope", "du -b -c nope", "du -sb big nope a", "du -s -d 1 a", "du -b -d x a"])(
    "fails: %j",
    async (source) => {
      await compare(source);
    },
  );
});
