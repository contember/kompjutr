// `diff` over directories against GNU diff through Bash: `Only in` lines,
// common subdirectories, per-file headers carrying the switches as spelled,
// type mismatches, binary files, `-q`, `-s`, `-u`, `-N`, and exit status. The
// parity seed has regular files only, so symlinks and the cost of identity
// shortcuts are pinned locally below.

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
  "l/f": "a\nb\n",
  "r/f": "a\nc\n",
  "l/same": "same\n",
  "r/same": "same\n",
  "l/onlyl": "x\n",
  "r/onlyr": "y\n",
  "l/onlyl_dir/q": "z\n",
  "r/onlyr_dir/q": "z\n",
  "l/sub/deep/x": "d\n",
  "r/sub/deep/x": "e\n",
  "l/sub/deep/same": "s\n",
  "r/sub/deep/same": "s\n",
  "l/sub/only": "o\n",
  "l/b/x": "3\n",
  "r/b/x": "4\n",
  "l/b.txt": "1\n",
  "r/b.txt": "2\n",
  "l/bin": "x\0\n",
  "r/bin": "y\0\n",
  "l/binsame": "x\0",
  "r/binsame": "x\0",
  "l/u": "f\n",
  "r/u/g": "g\n",
  "l/empty": "",
  "r/empty/z": "z\n",
  "l/void": "",
  "r/void": "",
  "l/t/g": "g\n",
  "l/z": "1\n",
  "r/z": "2\n",
  "l/é": "1\n",
  "r/é": "2\n",
  "l/😀": "1\n",
  "r/\u{ffff}": "2\n",
  "l/a b": "1\n",
  "r/a b": "2\n",
  'l/q"x\\y': "1\n",
  'r/q"x\\y': "2\n",
  "l/tab\tname": "1\n",
  "r/tab\tname": "2\n",
};

describe("the recursive diff parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("diff over directories matches GNU diff", () => {
  async function compare(source: string, tree: ShellTree = TREE): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree }));
  }

  it.each([
    "diff l r",
    "diff -r l r",
    "diff --recursive l r",
    "diff -q l r",
    "diff -rq l r",
    "diff -r --brief l r",
    "diff -s l r",
    "diff -rs l r",
    "diff -r -s -q l r",
    "diff -ru l r",
    "diff -r -U1 l r",
    "diff -rU0 l r",
    "diff --recursive -U 1 l r",
    "diff -r --unified=1 l r",
    "diff -N l r",
    "diff -Ns l r",
    "diff -Nq l r",
    "diff -rN l r",
    "diff -rNu l r",
    "diff -rNs l r",
    "diff -Nr -q l r",
    "diff -r --new-file l r",
    "diff -r -- l r",
    "diff l r -r",
    "diff -r l/ r/",
    "diff l// r//",
    "diff -r l// r",
    "diff -r l/sub r/sub",
    "diff -r l l",
    "diff -rs l l",
    "diff -r . .",
    "diff -r l/f r",
    "diff -r l/b r/b",
    "diff -rN l nonexist",
    "diff -rN nonexist r",
    "diff -N l/f r/nonexist",
    "diff -r l r | head -3",
    "diff -u 'l/a b' 'r/a b'",
    "diff -u l/é r/é",
  ])("compares: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "diff -r l nonexist",
    "diff -r nonexist r",
    "diff nx1 nx2",
    "diff -rN nx1 nx2",
    "diff -q l/u r/u",
    "echo x | diff - r",
    "echo x | diff -r r -",
  ])("reports trouble: %j", async (source) => {
    await compare(source);
  });

  it("compares identical trees as equal", async () => {
    await compare("diff -r l r && echo same; diff -rs l r", {
      "l/a": "1\n",
      "l/d/b": "2\n",
      "r/a": "1\n",
      "r/d/b": "2\n",
    });
  });
});

describe("diff over directories: what the parity seed cannot express", () => {
  const encoder = new TextEncoder();

  function filesystem() {
    return createFilesystem(new TestDatabase(), { now: () => 0 });
  }

  function write(fs: ReturnType<typeof filesystem>, files: Readonly<Record<string, string>>) {
    fs.writeFiles(
      Object.entries(files).map(([path, text]) => ({
        path: `/repo/${path}`,
        bytes: encoder.encode(text),
      })),
    );
  }

  it("follows symlinks to files and directories, as GNU does by default", async () => {
    const fs = filesystem();
    write(fs, { "l/f": "a\n", "r/f": "b\n", "l/d/x": "1\n", "r/d/x": "2\n", target: "b\n" });
    fs.symlink("/repo/target", "/repo/l/link");
    fs.writeFiles([{ path: "/repo/r/link", bytes: encoder.encode("a\n") }]);
    fs.symlink("/repo/l/d", "/repo/l/dlink");
    fs.symlink("/repo/r/d", "/repo/r/dlink");
    const run = await createShell({ fs, cwd: "/repo" }).run("diff -r l r");
    expect(run.stdout).toBe(
      [
        "diff -r l/d/x r/d/x",
        "1c1",
        "< 1",
        "---",
        "> 2",
        "diff -r l/dlink/x r/dlink/x",
        "1c1",
        "< 1",
        "---",
        "> 2",
        "diff -r l/f r/f",
        "1c1",
        "< a",
        "---",
        "> b",
        "diff -r l/link r/link",
        "1c1",
        "< b",
        "---",
        "> a",
        "",
      ].join("\n"),
    );
    expect(run.exitCode).toBe(1);
  });

  it("reports a dangling symlink as missing and keeps going", async () => {
    const fs = filesystem();
    write(fs, { "l/a": "1\n", "r/a": "2\n", "r/dang": "x\n" });
    fs.symlink("/repo/nowhere", "/repo/l/dang");
    const run = await createShell({ fs, cwd: "/repo" }).run("diff -rq l r");
    expect(run.stderr).toBe("diff: l/dang: No such file or directory\n");
    expect(run.stdout).toBe("Files l/a and r/a differ\n");
    expect(run.exitCode).toBe(2);
  });

  it("names a directory loop only where both sides loop", async () => {
    const fs = filesystem();
    write(fs, { "l/s/x": "1\n", "r/s/x": "2\n" });
    fs.symlink("/repo/l", "/repo/l/s/loop");
    fs.symlink("/repo/r", "/repo/r/s/loop");
    const run = await createShell({ fs, cwd: "/repo" }).run("diff -rq l r");
    expect(run.stderr).toBe("diff: l/s/loop: recursive directory loop\n");
    expect(run.stdout).toBe("Files l/s/x and r/s/x differ\n");
    expect(run.exitCode).toBe(2);
  });

  it.each(["-x", "--exclude", "--no-dereference", "-P", "-w"])(
    "refuses %s by name",
    async (flag) => {
      const fs = filesystem();
      write(fs, { "l/a": "1\n", "r/a": "2\n" });
      const run = await createShell({ fs, cwd: "/repo" }).run(`diff -r ${flag} l r`);
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toBe(
        `diff: ${flag} is not supported; supported: -u, -U N, -q, -s, -r, -N\n`,
      );
    },
  );

  it("proves identical files equal from content ids without reading them", async () => {
    const fs = filesystem();
    const count = 200;
    const entries = [];
    for (let index = 0; index < count; index++) {
      const bytes = encoder.encode(`file ${index}\n`);
      const contentId = encoder.encode(`id-${index}`);
      const directory = `d${index % 4}`;
      entries.push({ path: `/repo/l/${directory}/f${index}`, bytes, contentId });
      entries.push({ path: `/repo/r/${directory}/f${index}`, bytes, contentId });
    }
    entries.push({ path: "/repo/l/changed", bytes: encoder.encode("1\n") });
    entries.push({ path: "/repo/r/changed", bytes: encoder.encode("2\n") });
    fs.writeFiles(entries);
    const run = await createShell({ fs, cwd: "/repo" }).run("diff -r l r");
    expect(run.stdout).toBe("diff -r l/changed r/changed\n1c1\n< 1\n---\n> 2\n");
    expect(run.exitCode).toBe(1);
    // Two top-level stats, two listings per directory pair, one batched read
    // for the changed pair: nothing per identical file.
    expect(run.operations).toBe(2 + 2 * 5 + 1);
    expect(run.operations).toBeLessThan(count / 10);
  });

  it("proves hard-linked files equal by inode without reading them", async () => {
    const fs = filesystem();
    write(fs, { "l/a": "same\n", "l/b": "same\n" });
    fs.makeDirectories(["/repo/r"]);
    fs.link("/repo/l/a", "/repo/r/a");
    fs.link("/repo/l/b", "/repo/r/b");
    const run = await createShell({ fs, cwd: "/repo" }).run("diff -rs l r");
    expect(run.stdout).toBe("Files l/a and r/a are identical\nFiles l/b and r/b are identical\n");
    expect(run.operations).toBe(2 + 2);
  });

  it("decides differing sizes under -q without reading", async () => {
    const fs = filesystem();
    write(fs, { "l/a": "1\n", "r/a": "22\n", "l/b": "1\n", "r/b": "333\n" });
    const run = await createShell({ fs, cwd: "/repo" }).run("diff -rq l r");
    expect(run.stdout).toBe("Files l/a and r/a differ\nFiles l/b and r/b differ\n");
    expect(run.operations).toBe(2 + 2);
  });
});
