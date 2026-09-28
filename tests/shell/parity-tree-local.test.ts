// What the tree/du parity suite cannot compare: the shell's `du` size model
// and output order, entries the parity seed cannot create (symlinks, hard
// links, empty directories, executable files), listings that span pages, and
// the options refused on purpose.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { WriteEntry } from "../../packages/do/src/fs/types.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

function shellOver(entries: readonly WriteEntry[]): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  fs.writeFiles([{ path: "/repo", mode: 0o755 }, ...entries]);
  return createShell({ fs, cwd: "/repo" });
}

function file(path: string, bytes: number | string, mode = 0o644): WriteEntry {
  const content = typeof bytes === "string" ? bytes : "x".repeat(bytes);
  return { path: `/repo/${path}`, bytes: ENCODER.encode(content), mode };
}

describe("du reports apparent sizes; the filesystem has no blocks", () => {
  const shell = shellOver([
    file("big", 1500),
    file("k1", 1024),
    file("k2", 1025),
    file("mb", 3_000_000),
    { path: "/repo/empty", mode: 0o755 },
  ]);

  it("prints 1024-byte units rounded up by default and with -k, as --apparent-size does", async () => {
    for (const source of [
      "du big k1 k2 mb",
      "du -k big k1 k2 mb",
      "du --apparent-size big k1 k2 mb",
    ]) {
      const run = await shell.run(source);
      expect(run.stdout, source).toBe("2\tbig\n1\tk1\n2\tk2\n2930\tmb\n");
    }
  });

  it("prints MiB rounded up with -m and human units with -h", async () => {
    expect((await shell.run("du -m big mb")).stdout).toBe("1\tbig\n3\tmb\n");
    expect((await shell.run("du -h big k1 k2 mb")).stdout).toBe(
      "1.5K\tbig\n1.0K\tk1\n1.1K\tk2\n2.9M\tmb\n",
    );
  });

  it("counts a directory as zero bytes of its own", async () => {
    expect((await shell.run("du empty")).stdout).toBe("0\tempty\n");
    expect((await shell.run("du -sb empty")).stdout).toBe("0\tempty\n");
  });
});

describe("du aggregates in one path-order pass", () => {
  const shell = shellOver([
    file("a/x", 3),
    file("a/b/c", 5),
    file("a.txt", 7),
    file("a-b/y", 11),
    file("z", 13),
  ]);

  it("prints each directory when the scan leaves its subtree, files as they are met", async () => {
    // `a-b` and `a.txt` sort between `a` and `a/`, so `a` is still open while
    // they are visited and closes after them.
    const run = await shell.run("du -ab .");
    expect(run.stdout).toBe(
      [
        "11\t./a-b/y",
        "11\t./a-b",
        "7\t./a.txt",
        "5\t./a/b/c",
        "5\t./a/b",
        "3\t./a/x",
        "8\t./a",
        "13\t./z",
        "39\t.",
        "",
      ].join("\n"),
    );
    expect(run.exitCode).toBe(0);
  });

  it("limits rows by depth without changing the totals", async () => {
    expect((await shell.run("du -b -d 1 .")).stdout).toBe("11\t./a-b\n8\t./a\n39\t.\n");
    expect((await shell.run("du -sb .")).stdout).toBe("39\t.\n");
  });
});

describe("du links", () => {
  it("counts a hard-linked file once per operand", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
    fs.writeFiles([{ path: "/repo", mode: 0o755 }, file("d/f", 100), file("e/g", 1)]);
    fs.link("/repo/d/f", "/repo/d/h");
    fs.link("/repo/d/f", "/repo/e/i");
    const linked = createShell({ fs, cwd: "/repo" });

    expect((await linked.run("du -ab d")).stdout).toBe("100\td/f\n100\td\n");
    expect((await linked.run("du -sb d e")).stdout).toBe("100\td\n101\te\n");
    expect((await linked.run("du -b d/f d/h")).stdout).toBe("100\td/f\n100\td/h\n");
  });

  it("counts a symlink as its target's length and does not follow it", async () => {
    const shell = shellOver([
      file("d/f", 100),
      { path: "/repo/l", target: "d" },
      { path: "/repo/d/m", target: "../nowhere" },
    ]);
    expect((await shell.run("du -ab .")).stdout).toBe(
      "100\t./d/f\n10\t./d/m\n110\t./d\n1\t./l\n111\t.\n",
    );
    expect((await shell.run("du -b l")).stdout).toBe("1\tl\n");
    expect((await shell.run("du -ab l/")).stdout).toBe("100\tl/f\n10\tl/m\n110\tl/\n");
  });
});

describe("du refuses what it does not admit", () => {
  const shell = shellOver([file("f", 1)]);

  it.each([
    ["du -x f", "du: invalid option -- 'x'\n"],
    ["du -L f", "du: invalid option -- 'L'\n"],
    ["du --exclude='*.ts' f", "du: unrecognized option '--exclude=*.ts'\n"],
    ["du --block-size=1 f", "du: unrecognized option '--block-size=1'\n"],
    ["du -d -1 f", "du: invalid maximum depth '-1'\n"],
    ["du -d", "du: option requires an argument -- -d\n"],
  ])("%s", async (source, stderr) => {
    const run = await shell.run(source);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(stderr);
    expect(run.exitCode).toBe(1);
  });
});

describe("tree shows what the parity seed cannot create", () => {
  const shell = shellOver([
    file("a/x", "x"),
    file("run.sh", "#!/bin/sh\n", 0o755),
    { path: "/repo/empty", mode: 0o755 },
    { path: "/repo/lnk", target: "a" },
    { path: "/repo/dang", target: "nowhere" },
    { path: "/repo/tool", target: "run.sh" },
  ]);

  it("prints symlinks with their targets and counts a link to a directory as one", async () => {
    expect((await shell.run("tree")).stdout).toBe(
      [
        ".",
        "|-- a",
        "|   `-- x",
        "|-- dang -> nowhere",
        "|-- empty",
        "|-- lnk -> a",
        "|-- run.sh",
        "`-- tool -> run.sh",
        "",
        "4 directories, 4 files",
        "",
      ].join("\n"),
    );
  });

  it("classifies executables and link targets with -F", async () => {
    expect((await shell.run("tree -F")).stdout).toBe(
      [
        "./",
        "|-- a/",
        "|   `-- x",
        "|-- dang -> nowhere",
        "|-- empty/",
        "|-- lnk -> a/",
        "|-- run.sh*",
        "`-- tool -> run.sh*",
        "",
        "4 directories, 4 files",
        "",
      ].join("\n"),
    );
  });

  it("keeps links to directories under -d and sorts them with directories under --dirsfirst", async () => {
    expect((await shell.run("tree -d")).stdout).toBe(
      ".\n|-- a\n|-- empty\n`-- lnk -> a\n\n4 directories\n",
    );
    expect((await shell.run("tree --dirsfirst --noreport")).stdout).toBe(
      [
        ".",
        "|-- a",
        "|   `-- x",
        "|-- empty",
        "|-- lnk -> a",
        "|-- dang -> nowhere",
        "|-- run.sh",
        "`-- tool -> run.sh",
        "",
      ].join("\n"),
    );
  });
  it("treats a link to a directory as a directory for -P and -I", async () => {
    expect((await shell.run("tree -P 'l*'")).stdout).toBe(
      ".\n|-- a\n|-- empty\n`-- lnk -> a\n\n4 directories, 0 files\n",
    );
    expect((await shell.run("tree -I 'lnk/' --noreport")).stdout).toBe(
      ".\n|-- a\n|   `-- x\n|-- dang -> nowhere\n|-- empty\n|-- run.sh\n`-- tool -> run.sh\n",
    );
  });
});

describe("tree across listing pages", () => {
  const names = Array.from({ length: 1_203 }, (_, index) => `f${String(index).padStart(4, "0")}`);
  const shell = shellOver([
    ...names.map((name) => file(`many/${name}`, "")),
    file("many/zdir/leaf", ""),
    file("tail", ""),
  ]);

  it("knows the last sibling when it sits on a later page", async () => {
    const run = await shell.run("tree many");
    const lines = run.stdout.split("\n");
    expect(lines[1]).toBe("|-- f0000");
    expect(lines[1_203]).toBe("|-- f1202");
    expect(lines.slice(1_204, 1_206)).toEqual(["`-- zdir", "    `-- leaf"]);
    expect(run.stdout.endsWith("\n2 directories, 1204 files\n")).toBe(true);
  });

  it("puts directories first across pages", async () => {
    const run = await shell.run("tree --dirsfirst --noreport many");
    const lines = run.stdout.split("\n");
    expect(lines.slice(0, 4)).toEqual(["many", "|-- zdir", "|   `-- leaf", "|-- f0000"]);
    expect(lines.at(-2)).toBe("`-- f1202");
  });
});

describe("tree refuses what it does not admit", () => {
  const shell = shellOver([file("f", "")]);

  it.each([
    ["tree -x", "tree: unsupported option '-x'\n"],
    ["tree -s", "tree: unsupported option '-s'\n"],
    ["tree --prune", "tree: unsupported option '--prune'\n"],
    ["tree --noreport=1", "tree: unsupported option '--noreport=1'\n"],
    ["tree --charset=latin1", "tree: unsupported charset 'latin1'\n"],
    ["tree --charset", "tree: Missing argument to --charset\n"],
  ])("%s", async (source, stderr) => {
    const run = await shell.run(source);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(stderr);
    expect(run.exitCode).toBe(1);
  });
});
