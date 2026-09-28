// `sed` against GNU sed through Bash. Scripts, addresses, in-place edits,
// and GNU's `-e expression #N, char M:` diagnostics compare byte for byte;
// the hold space, branches, and file commands are refused locally.

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
  "f.txt": "one\ntwo\nthree\nfour\n",
  "nonl.txt": "x\nlast",
  "p.txt": "a/b/c\n",
  "tab.txt": "a\tb\n",
};

describe("the sed parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("sed matches GNU sed", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "sed 's/o/0/' f.txt",
    "sed 's/o/0/g' f.txt",
    "sed 's/\\(o\\)\\(n\\)/\\2\\1/' f.txt",
    "sed -E 's/(o)(n)/\\2\\1/' f.txt",
    "sed -r 's/o+/0/' f.txt",
    "sed 's/o/[&]/g' f.txt",
    "sed 's#/#|#g' p.txt",
    "sed 's/\\//-/2' p.txt",
    "sed 's/[a-z]/X/2g' p.txt",
    "printf 'aaa\\n' | sed 's/a/b/3'",
    "sed -n 's/one/ONE/p' f.txt",
    "sed 's/ONE/x/I' f.txt",
    "sed 's/\\t/T/' tab.txt",
    "sed 's/a/\\n/' tab.txt",
    "printf 'a\\nb\\n' | sed 's/a/A/'",
  ])("substitutes: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sed -n 2,3p f.txt",
    "sed 2p f.txt",
    "sed 2d f.txt",
    "sed '2,3d' f.txt",
    "sed '$d' f.txt",
    "sed -n '$p' f.txt",
    "sed '/two/d' f.txt",
    "sed -n '/one/,/three/p' f.txt",
    "sed '/one/,+1d' f.txt",
    "sed -n '/t/,+1p' f.txt",
    "sed '/two/,$d' f.txt",
    "sed '2!d' f.txt",
    "sed '2,4!d' f.txt",
    "sed '2,1p' f.txt",
    "sed '0,/o/s/o/0/' f.txt",
    "sed '0,/one/d' f.txt",
  ])("selects lines by address: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sed 's/o/0/;s/t/T/' f.txt",
    "sed -e 's/o/0/' -e 's/t/T/' f.txt",
    "sed -n '/two/{p;q}' f.txt",
    "sed '2{s/t/T/;s/w/W/}' f.txt",
    "sed -n '1,3{/two/!p}' f.txt",
    "sed 2q f.txt",
    "sed 3q5 f.txt",
    "sed '1i header' f.txt",
    "sed '$a footer' f.txt",
    "sed '2c changed' f.txt",
    "sed '2,3c changed' f.txt",
    "sed = f.txt",
    "sed -n '$=' f.txt",
  ])("runs command lists: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sed 's/x/y/' nonl.txt",
    "sed p nonl.txt",
    "sed '$a tail' nonl.txt",
    "sed -n '$p' nonl.txt",
  ])("keeps a missing final newline: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sed -i 's/o/0/g' f.txt; cat f.txt",
    "sed -i '2d' f.txt nonl.txt; cat f.txt nonl.txt",
    "sed -n -i '1p' f.txt; cat f.txt",
    "sed -i '$d' f.txt; cat f.txt",
  ])("edits in place: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sed 's/o/0/' f.txt missing",
    "sed 'k' f.txt",
    "sed 's/a/b' f.txt",
    "sed 's/a/b/z' f.txt",
    "sed '{p' f.txt",
    "sed 'p}' f.txt",
    "sed 0p f.txt",
    "sed 's/a/b/0' f.txt",
  ])("reports GNU diagnostics: %j", async (source) => {
    await compare(source);
  });
});

describe("sed refusals", () => {
  const encoder = new TextEncoder();

  it.each([
    ["h", "the hold space is not supported"],
    ["b end", "branches and labels are not supported"],
    ["w out.txt", "file commands are not supported"],
    ["y/a/b/", "`y' is not supported"],
    ["N", "`N' is not supported"],
  ])("refuses %j by name", async (script, message) => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles([{ path: "/repo/f.txt", bytes: encoder.encode("one\n") }]);
    const run = await createShell({ fs, cwd: "/repo" }).run(`sed '${script}' f.txt`);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toBe(`sed: -e expression #1, char 1: ${message}\n`);
  });

  it("leaves a file unchanged when its in-place script quits early", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles([{ path: "/repo/f.txt", bytes: encoder.encode("one\ntwo\n") }]);
    const shell = createShell({ fs, cwd: "/repo" });
    await shell.run("sed -i 1q f.txt");
    expect((await shell.run("cat f.txt")).stdout).toBe("one\n");
  });
});
