// `patch` against GNU patch 2.8 through Bash. Each case runs twice on a fresh
// tree: once ending in `patch`, so its stdout, stderr, and exit status
// compare, and once followed by `cat` and `ls`, so the patched files,
// backups, and rejects compare too. Bash runs patch without a terminal, so
// every question GNU asks takes its default answer on both sides. The
// inspection ends in `echo`, because uutils `cat` and ours disagree on the
// status for several missing operands, which is not what this suite pins.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { DEFAULT_LIMITS } from "../../packages/do/src/shell/exec/context.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const LINES = Array.from({ length: 30 }, (_, index) => `${index + 1}\n`).join("");

const TREE: ShellTree = {
  "src/a.txt": "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  "src/b.txt": "alpha\nbeta\ngamma\n",
  "nums.txt": LINES,
  "nonl.txt": "first\nlast",
};

async function compare(command: string, diff: string, inspect: string, tree = TREE): Promise<void> {
  const script = `${command} <<'EOF'\n${diff}EOF\n`;
  agreeWithBash(await compareWithBash(script, { tree }));
  agreeWithBash(await compareWithBash(`${script}${inspect}\necho end\n`, { tree }));
}

const A_CHANGE = `--- a/src/a.txt
+++ b/src/a.txt
@@ -2,3 +2,3 @@
 two
-three
+THREE
 four
@@ -8,3 +8,4 @@
 eight
 nine
+nine and a half
 ten
`;

const B_CHANGE = `--- a/src/b.txt
+++ b/src/b.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`;

const LINK_FILES: Readonly<Record<string, string>> = {
  "w/in/t.txt": "x\n",
  "w/in2/t.txt": "x\n",
  "outside/t.txt": "x\n",
};
const LINKS: ReadonlyArray<readonly [string, string]> = [
  ["w/out", "../outside"],
  ["w/back", "../w/in"],
  ["w/inl", "in"],
  ["w/in/up", "../in2"],
  ["w/leaf", "../outside/t.txt"],
];

/**
 * The parity harness seeds regular files only and the shell has no `ln` yet,
 * so this compares against GNU patch directly: both trees get the same files
 * and relative symbolic links, then run the same script under `LC_ALL=C`.
 */
async function compareWithLinks(script: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kompjutr-patch-links-"));
  try {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.makeDirectories(["/repo/w/in", "/repo/w/in2", "/repo/outside"]);
    for (const [path, text] of Object.entries(LINK_FILES)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
      fs.writeFiles([
        { path: `/repo/${path}`, bytes: new TextEncoder().encode(text), mode: 0o644 },
      ]);
    }
    for (const [path, target] of LINKS) {
      symlinkSync(target, join(directory, path));
      fs.symlink(target, `/repo/${path}`);
    }
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC", IFS: " \t\n" };
    const bash = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      cwd: directory,
      env,
    });
    const ours = await createShell({ fs, cwd: "/repo" }).exec(script, { env });
    expect(ours.stdout).toEqual(Uint8Array.from(bash.stdout));
    expect(ours.stderr).toEqual(Uint8Array.from(bash.stderr));
    expect(ours.exitCode).toBe(bash.status);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the patch parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("patch matches GNU patch", () => {
  it.each([
    ["patch -p1", A_CHANGE, "cat src/a.txt; ls src"],
    ["patch -p1", `${A_CHANGE}${B_CHANGE}`, "cat src/a.txt src/b.txt; ls src"],
    ["patch --strip=1", B_CHANGE, "cat src/b.txt"],
    ["patch -p 1 -s", `${A_CHANGE}${B_CHANGE}`, "cat src/a.txt src/b.txt"],
    ["cd src && patch -p2", A_CHANGE, "cat a.txt"],
    ["patch", B_CHANGE.replaceAll("a/src/", "").replaceAll("b/src/", "src/"), "ls src"],
    [
      "patch -p0",
      B_CHANGE.replaceAll("a/src/", "src/").replaceAll("b/src/", "src/"),
      "cat src/b.txt",
    ],
    ["patch -d src -p2", B_CHANGE, "cat src/b.txt"],
    ["patch -p1 src/b.txt", B_CHANGE, "cat src/b.txt"],
  ])("applies exactly: %s", async (command, diff, inspect) => {
    await compare(command, diff, inspect);
  });

  const shifted = `--- nums.txt
+++ nums.txt
@@ -5,7 +5,7 @@
 5
 6
 7
-8
+EIGHT
 9
 10
 11
@@ -20,7 +20,7 @@
 20
 21
 22
-23
+TWENTY-THREE
 23c
 24
 25
`;
  const offsetTree: ShellTree = {
    ...TREE,
    "nums.txt": `0a\n0b\n0c\n${LINES.replace("23\n", "23\n23b\n")}`,
  };

  it.each([
    ["patch", shifted, "cat nums.txt; ls"],
    ["patch --no-backup-if-mismatch", shifted, "ls"],
    ["patch -s", shifted, "ls"],
  ])("finds a hunk at an offset and fails another: %s", async (command, diff, inspect) => {
    await compare(command, diff, `${inspect}; cat nums.txt.rej`, offsetTree);
  });

  it.each([
    ["one line earlier", LINES.replace("2\n", "")],
    ["three lines earlier", LINES.replace("1\n2\n3\n", "")],
    ["one line later", `0\n${LINES}`],
  ])("reports offsets in both directions: %s", async (_, nums) => {
    const twice = shifted.replace(" 23c", " 23b");
    await compare(
      "patch",
      `${twice}${twice.replaceAll("EIGHT", "8!").replace("-8\n", "-EIGHT\n")}`,
      "cat nums.txt; ls",
      {
        ...TREE,
        "nums.txt": nums.replace("23\n", "23\n23b\n"),
      },
    );
  });

  const fuzzy = `--- nums.txt
+++ nums.txt
@@ -10,7 +10,7 @@
 10
 11
 12
-13
+THIRTEEN
 14
 15
 16
`;
  it.each([
    ["one context line changed at each end", { "nums.txt": LINES.replace("10\n", "X\n") }, "patch"],
    [
      "two context lines changed",
      { "nums.txt": LINES.replace("10\n", "X\n").replace("11\n", "Y\n") },
      "patch",
    ],
    ["fuzz with an offset", { "nums.txt": `0\n${LINES.replace("16\n", "Z\n")}` }, "patch"],
    [
      "fuzz limited by -F1",
      { "nums.txt": LINES.replace("10\n", "X\n").replace("11\n", "Y\n") },
      "patch -F1",
    ],
    ["fuzz refused by --fuzz=0", { "nums.txt": LINES.replace("16\n", "Z\n") }, "patch --fuzz=0"],
    [
      "too much drift",
      { "nums.txt": LINES.replace("10\n", "X\n").replace("11\n", "Y\n").replace("12\n", "W\n") },
      "patch",
    ],
  ])("applies with fuzz: %s", async (_, tree, command) => {
    await compare(command, fuzzy, "ls; cat nums.txt; cat nums.txt.rej", tree);
  });

  const applied = { ...TREE, "src/b.txt": "alpha\nBETA\ngamma\n" };
  it.each([
    "patch -p1",
    "patch -p1 -N",
    "patch -p1 --forward",
    "patch -p1 -t",
    "patch -p1 -f",
    "patch -p1 -s",
    "patch -p1 -R",
    "patch -p1 -R -t",
    "patch -p1 -R -N",
    "patch -p1 --dry-run",
    "patch -p1 -t --dry-run",
  ])("detects a reversed patch: %s", async (command) => {
    await compare(command, B_CHANGE, "cat src/b.txt; ls src; cat src/b.txt.rej", applied);
  });

  it.each([
    "patch -p1 -R",
    "patch -p1 -R -t",
    "patch -p1 -R -N",
    "patch -p1 -R -f",
    "patch -p1 -R --dry-run",
  ])("detects an unreversed patch: %s", async (command) => {
    await compare(command, B_CHANGE, "cat src/b.txt; ls src; cat src/b.txt.rej", TREE);
  });

  it.each([
    ["patch -p1 -R", applied],
    ["patch -p1 --reverse --dry-run", applied],
    ["patch -p1 --dry-run", TREE],
  ])("reverses and dry-runs: %s", async (command, tree) => {
    await compare(command, B_CHANGE, "cat src/b.txt; ls src", tree);
  });

  const gitCreateDelete = `diff --git a/new/dir/n.txt b/new/dir/n.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new/dir/n.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/b.txt b/src/b.txt
deleted file mode 100644
index 1111111..0000000
--- a/src/b.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-alpha
-beta
-gamma
`;
  const plainCreateDelete = `--- /dev/null
+++ b/created.txt
@@ -0,0 +1 @@
+made
--- a/src/b.txt	2020-01-01 00:00:00.000000000 +0000
+++ /dev/null	1970-01-01 00:00:00.000000000 +0000
@@ -1,3 +0,0 @@
-alpha
-beta
-gamma
`;
  it.each([
    ["patch -p1", gitCreateDelete],
    ["patch -p1 --dry-run", gitCreateDelete],
    ["patch -p1 -R", gitCreateDelete],
    ["patch -p1", plainCreateDelete],
    ["patch -p1 -R", plainCreateDelete],
  ])("creates and deletes files: %s", async (command, diff) => {
    await compare(command, diff, "ls; ls src; cat new/dir/n.txt created.txt");
  });

  it.each([
    [
      "git",
      "diff --git a/src/b.txt b/src/b.txt\ndeleted file mode 100644\nindex 1..0000000\n",
      "diff --git a/src/b.txt b/src/b.txt\nnew file mode 100644\nindex 0000000..2\n",
    ],
    ["plain", "", ""],
  ])("deletes and recreates one file in a %s diff", async (_, deleting, creating) => {
    const diff = `${deleting}--- a/src/b.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-alpha\n-beta\n-gamma\n${creating}--- /dev/null\n+++ b/src/b.txt\n@@ -0,0 +1 @@\n+reborn\n`;
    await compare("patch -p1", diff, "ls src; cat src/b.txt");
  });

  it.each(["patch -p1", "patch -p1 --no-backup-if-mismatch"])(
    "backs up a file deleted at an offset: %s",
    async (command) => {
      const diff = "--- a/src/b.txt\n+++ /dev/null\n@@ -2,3 +0,0 @@\n-alpha\n-beta\n-gamma\n";
      await compare(command, diff, "ls src; cat src/b.txt.orig");
    },
  );

  it("applies a patch twice and refuses to recreate or re-delete", async () => {
    await compare(
      `patch -p1 <<'EOF'\n${gitCreateDelete}EOF\npatch -p1`,
      gitCreateDelete,
      "ls; ls src; cat new/dir/n.txt",
    );
  });

  it.each([
    ["patch -p1", "src/c.txt"],
    ["patch -p1 -E", "src/c.txt"],
    ["patch -p1", "src/d.txt"],
  ])("empties or keeps a file: %s %s", async (command, file) => {
    const emptied = `--- a/${file}\n+++ b/${file}\n@@ -1 +0,0 @@\n-only\n`;
    const deleted = `--- a/${file}\n+++ /dev/null\n@@ -1 +0,0 @@\n-only\n`;
    await compare(command, file === "src/c.txt" ? emptied : deleted, "ls src; cat src/d.txt", {
      ...TREE,
      "src/c.txt": "only\n",
      "src/d.txt": "only\nmore\n",
    });
  });

  it.each([
    [
      "removes the final newline",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -2,2 +2,2 @@\n beta\n-gamma\n+gamma\n\\ No newline at end of file\n",
      "src/b.txt",
    ],
    [
      "adds a final newline",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -1,2 +1,2 @@\n first\n-last\n\\ No newline at end of file\n+last\n",
      "nonl.txt",
    ],
    [
      "changes an incomplete line",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -1,2 +1,2 @@\n first\n-last\n\\ No newline at end of file\n+LAST\n\\ No newline at end of file\n",
      "nonl.txt",
    ],
    [
      "appends after an incomplete line",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -2,0 +3 @@\n+extra\n",
      "nonl.txt",
    ],
    [
      "rejects an incomplete line",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -1,2 +1,2 @@\n first\n-other\n\\ No newline at end of file\n+x\n\\ No newline at end of file\n",
      "nonl.txt nonl.txt.rej",
    ],
  ])("keeps missing final newlines: %s", async (_, diff, files) => {
    await compare("patch -p1", diff, `cat -A ${files}`);
  });

  it.each([
    [
      "commentary before the header",
      `This change renames a thing.\n\nSigned-off: nobody\n${B_CHANGE}`,
    ],
    [
      "an email with a git header",
      `From 123 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n\n---\n src/b.txt | 2 +-\n\ndiff --git a/src/b.txt b/src/b.txt\nindex 1..2 100644\n${B_CHANGE}-- \n2.40.0\n`,
    ],
    ["comments and trailing text", `# a comment\n${B_CHANGE}# another\ntrailing words\n`],
    ["a hunk with a function heading", B_CHANGE.replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,3 @@ fn()")],
  ])("skips text around patches: %s", async (_, diff) => {
    await compare("patch -p1", diff, "cat src/b.txt");
  });

  it.each([
    ["only garbage", "nothing to see\nhere\n"],
    ["a missing line number", "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -x +1 @@\n a\n"],
    ["a bad hunk line", "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n?beta\n"],
    [
      "a truncated hunk",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,8 +1,8 @@\n alpha\n-beta\n+BETA\n",
    ],
    [
      "chopped trailing blank context",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,4 +1,4 @@\n alpha\n-beta\n+BETA\n gamma\n",
    ],
    [
      "too many lines",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n+more\n gamma\n",
    ],
    [
      "a malformed second file after a good one",
      `${A_CHANGE}--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,2 +1,2 @@\n alpha\n!beta\n`,
    ],
    ["a header without hunks", "--- a/src/b.txt\n+++ b/src/b.txt\n"],
    ["an empty input", ""],
  ])("diagnoses malformed input: %s", async (_, diff) => {
    await compare("patch -p1", diff, "cat src/a.txt src/b.txt; ls src");
  });

  it.each([
    ["an unterminated last line", `${B_CHANGE}trailing`],
    ["an unterminated hunk line", B_CHANGE.slice(0, -1)],
    ["an unterminated header", "--- a/src/b.txt"],
    ["a NUL byte in the commentary", `note\0\n${B_CHANGE}`],
    ["a NUL byte in a hunk", B_CHANGE.replace("BETA", "BE\0TA")],
    ["CRLF line endings", B_CHANGE.replaceAll("\n", "\r\n")],
    ["an indented patch", B_CHANGE.replaceAll(/^/gm, "  ")],
  ])("reads raw input: %s", async (_, diff) => {
    const tree = { ...TREE, "change.diff": diff };
    const script = "patch -p1 < change.diff";
    agreeWithBash(await compareWithBash(script, { tree }));
    agreeWithBash(await compareWithBash(`${script}\ncat -A src/b.txt\n`, { tree }));
  });

  it.each(["patch", "patch -p2", "patch -p1 -t", "patch -p1 -f", "patch -p1 -s"])(
    "reports a file it cannot find: %s",
    async (command) => {
      const missing = `Some text\n--- a/nowhere/x.txt\n+++ b/nowhere/x.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n${B_CHANGE}`;
      await compare(command, missing, "cat src/b.txt; ls; ls src");
    },
  );

  const renames = `diff --git a/src/a.txt b/moved/a.txt
similarity index 90%
rename from src/a.txt
rename to moved/a.txt
index 1..2 100644
--- a/src/a.txt
+++ b/moved/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/src/b.txt b/copy.txt
similarity index 100%
copy from src/b.txt
copy to copy.txt
diff --git a/nonl.txt b/nonl.txt
old mode 100644
new mode 100755
`;
  it.each(["patch -p1", "patch -p1 --dry-run"])(
    "follows git renames, copies, and modes: %s",
    async (command) => {
      await compare(
        command,
        renames,
        "ls; ls src moved; cat moved/a.txt copy.txt; test -x nonl.txt && echo executable",
      );
    },
  );

  it("applies git diffs against the tree as it was", async () => {
    const twice = `diff --git a/src/b.txt b/src/b.txt\nindex 1..2 100644\n${B_CHANGE}diff --git a/src/b.txt b/src/b.txt\nindex 2..3 100644\n${B_CHANGE.replace("-beta\n+BETA", "-BETA\n+Beta")}`;
    await compare("patch -p1", twice, "cat src/b.txt; ls src");
  });

  it.each([
    [
      "quoted git names",
      'diff --git "a/sp ace.txt" "b/sp ace.txt"\nindex 1..2 100644\n--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -1 +1 @@\n-x\n+y\n',
      "cat 'sp ace.txt'",
    ],
    [
      "names with spaces before a tab",
      "--- a/sp ace.txt\t2020-01-01 00:00:00.000000000 +0000\n+++ b/sp ace.txt\t2020-01-01 00:00:00.000000000 +0000\n@@ -1 +1 @@\n-x\n+y\n",
      "cat 'sp ace.txt'",
    ],
    [
      "an Index line alone",
      "Index: src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    [
      "an insertion at the top",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -0,0 +1 @@\n+zero\n",
      "cat src/b.txt",
    ],
    [
      "misordered insertions",
      "--- a/nums.txt\n+++ b/nums.txt\n@@ -20,0 +21 @@\n+late\n@@ -5,0 +7 @@\n+early\n",
      "cat nums.txt.rej; cat nums.txt",
    ],
    [
      "CRLF input against an LF patch",
      "--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n",
      "cat -A crlf.txt crlf.txt.rej",
    ],
    [
      "a satisfied Prereq",
      "Prereq: alpha\n--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    [
      "a missing Prereq",
      "Prereq: omega\n--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    ["a dangerous name", "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y\n", "ls"],
    [
      "a dangerous name to create",
      "--- /dev/null\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+new\n",
      "ls",
    ],
    [
      "an Index line with a matching name",
      "Index: b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    [
      "a creation into an existing file",
      "--- /dev/null\n+++ b/src/b.txt\n@@ -0,0 +1 @@\n+new\n",
      "cat src/b.txt; ls src",
    ],
    [
      "a creation into an empty file",
      "--- /dev/null\n+++ b/empty.txt\n@@ -0,0 +1 @@\n+new\n",
      "cat empty.txt; ls",
    ],
    [
      "a larger fuzz factor",
      "--- a/nums.txt\n+++ b/nums.txt\n@@ -10,7 +10,7 @@\n X\n Y\n Z\n-13\n+THIRTEEN\n 14\n 15\n 16\n",
      "cat nums.txt",
    ],
  ])("reads names and odd forms: %s", async (_, diff, inspect) => {
    const tree = {
      ...TREE,
      "sp ace.txt": "x\n",
      "crlf.txt": "a\r\nb\r\n",
      "empty.txt": "",
    };
    await compare("patch -p1", diff, inspect, tree);
    await compare("patch -p1 -F3 -t", diff, inspect, tree);
  });

  it.each([
    ["patch -p1", "modify", "out/t.txt"],
    ["patch -p1", "create", "out/new.txt"],
    ["patch -p1", "create", "out/deeper/new.txt"],
    ["patch -p1 --dry-run", "create", "out/new.txt"],
    ["patch -p1", "modify", "back/t.txt"],
    ["patch -p1", "create", "back/new.txt"],
    ["patch -p1", "modify", "inl/t.txt"],
    ["patch -p1", "create", "inl/new.txt"],
    ["patch -p1", "modify", "in/up/t.txt"],
    ["patch -p1", "create", "in/up/new.txt"],
    ["patch -p1", "modify", "leaf"],
    ["patch -p1", "fail", "out/t.txt"],
    ["patch -p1 out/t.txt", "fail", "out/t.txt"],
  ])("follows symbolic links only inside the tree: %s, %s %s", async (command, action, name) => {
    const header = action === "create" ? "--- /dev/null\n" : `--- a/${name}\n`;
    const body =
      action === "create"
        ? "@@ -0,0 +1 @@\n+y\n"
        : action === "fail"
          ? "@@ -1 +1 @@\n-q\n+y\n"
          : "@@ -1 +1 @@\n-x\n+y\n";
    const script = `cd w && ${command} <<'EOF'\n${header}+++ b/${name}\n${body}EOF\n`;
    const inspect = "ls . in in2 ../outside; cat ../outside/t.txt in/t.txt in2/t.txt; echo end\n";
    await compareWithLinks(script);
    await compareWithLinks(`${script}${inspect}`);
  });

  it("reports a git binary patch as GNU does", async () => {
    const binary = `diff --git a/bin.dat b/bin.dat\nindex 1..2 100644\nGIT binary patch\nliteral 3\nKcmZ?\n\nliteral 0\nHcmV?d00001\n\n${B_CHANGE}`;
    await compare("patch -p1", binary, "cat src/b.txt; ls", { ...TREE, "bin.dat": "abc" });
  });

  it.each(["patch -p1 -r all.rej", "patch -p1 --reject-file=- ", "patch -p1 -r all.rej --dry-run"])(
    "collects rejects: %s",
    async (command) => {
      const failing = `${A_CHANGE.replace("-three\n", "-trois\n")}${B_CHANGE.replace("-beta\n", "-bravo\n")}`;
      await compare(command, failing, "ls; ls src; cat all.rej");
    },
  );

  it.each([
    "patch -i change.diff -p1",
    "patch --input=change.diff --strip 1",
    "patch -p1 src/b.txt change.diff",
    "patch -p1 -i missing.diff",
    "patch -p1 -i src",
  ])("reads the patch from a file: %s", async (command) => {
    const tree = { ...TREE, "change.diff": B_CHANGE };
    agreeWithBash(await compareWithBash(`${command}\ncat src/b.txt\n`, { tree }));
    agreeWithBash(await compareWithBash(command, { tree }));
  });

  it.each([
    "patch --bogus",
    "patch -k",
    "patch --re",
    "patch --dry-run=1",
    "patch --strip",
    "patch -p",
    "patch -p x",
    "patch -p -1",
    "patch -F 1x",
    "patch -d nowhere",
    "patch -d nums.txt",
    "patch a b c",
  ])("rejects bad command lines: %s", async (command) => {
    agreeWithBash(await compareWithBash(`${command} </dev/null`, { tree: TREE }));
  });
});

describe.skipIf(!REAL_BASH)("patch matches GNU patch on generated edits", () => {
  // The diff comes from the host's GNU diff; the target drifts from its
  // original by random insertions, deletions, and changes, so offsets, fuzz,
  // reversal, and rejects all occur.
  it("applies drifted patches as GNU does", async () => {
    const random = seeded(11);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const lines = (count: number): string[] =>
      Array.from({ length: count }, () => pick(["a", "b", "c", "d", "e", "f"]));
    const mutate = (source: readonly string[], edits: number): string[] => {
      const out = [...source];
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * (out.length + 1));
        const kind = random();
        if (kind < 0.35) out.splice(at, 0, pick(["x", "y", "z"]));
        else if (kind < 0.7) out.splice(at, 1);
        else out.splice(at, 1, pick(["x", "y", "z"]));
      }
      return out;
    };
    const text = (source: readonly string[], newline: boolean): string =>
      source.length === 0 ? "" : `${source.join("\n")}${newline ? "\n" : ""}`;
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-patch-gen-"));
    try {
      for (let round = 0; round < 40; round++) {
        const original = lines(5 + Math.floor(random() * 40));
        const edited = mutate(original, 1 + Math.floor(random() * 6));
        writeFileSync(join(directory, "a"), text(original, random() < 0.9));
        writeFileSync(join(directory, "b"), text(edited, random() < 0.9));
        const diff = spawnSync("diff", ["-u", "--label", "a/f", "--label", "b/f", "a", "b"], {
          cwd: directory,
          env: { LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
        const drifted = random() < 0.2 ? edited : mutate(original, Math.floor(random() * 4));
        const tree = { f: text(drifted, random() < 0.9), "change.diff": diff.stdout };
        const flags = pick(["-p1", "-p1 -R", "-p1 -F1", "-p1 -N", "-p1 -t", "-p1 -f"]);
        agreeWithBash(await compareWithBash(`patch ${flags} < change.diff`, { tree }));
        agreeWithBash(
          await compareWithBash(
            `patch ${flags} < change.diff; cat -A f; ls; cat -A f.rej; echo end`,
            {
              tree,
            },
          ),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!REAL_BASH)("patch matches GNU patch on further forms", () => {
  const tree: ShellTree = {
    f: "x\na\nb\na\nb\nx\n",
    g: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
    h: "a\r\nb\r\n",
    "sp ace": "x\n",
  };
  it.each([
    ["an anchored end moved by fuzz", "patch", "--- f\n+++ f\n@@ -3,2 +3,2 @@\n a\n-b\n+B\n"],
    ["an anchored start", "patch", "--- f\n+++ f\n@@ -1,5 +1,5 @@\n x\n-a\n+A\n b\n a\n b\n"],
    [
      "a misordered hunk",
      "patch",
      "--- g\n+++ g\n@@ -6,1 +6,1 @@\n-f\n+F\n@@ -2,1 +2,1 @@\n-c\n+C\n",
    ],
    [
      "a hunk behind the last one",
      "patch",
      "--- g\n+++ g\n@@ -6,1 +6,1 @@\n-f\n+F\n@@ -9,1 +9,1 @@\n-f\n+X\n",
    ],
    [
      "overlapping context",
      "patch -F1",
      "--- g\n+++ g\n@@ -3,3 +3,3 @@\n c\n-d\n+D\n e\n@@ -5,3 +5,3 @@\n e\n-f\n+F\n g\n",
    ],
    ["padded missing context", "patch", "--- g\n+++ g\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n"],
    ["uneven missing context", "patch", "--- g\n+++ g\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n"],
    ["missing old lines", "patch", "--- g\n+++ g\n@@ -1,9 +1,4 @@\n a\n-b\n"],
    ["a NUL byte after a hunk", "patch", "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\0\n"],
    ["a blank context line", "patch", "--- g\n+++ g\n@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n"],
    ["an addition before context", "patch", "--- g\n+++ g\n@@ -1,2 +1,3 @@\n+top\n a\n b\n"],
    ["hunks out of order", "patch", "--- g\n+++ g\n@@ -2 +2 @@\n-b\n+B\n@@ -1 +1 @@\n-a\n+A\n"],
    ["-N quietly", "patch -s -N", "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-B\n+b\n"],
    ["-t quietly", "patch -s -t", "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-B\n+b\n"],
    [
      "-t for a missing file",
      "patch -s -t",
      "--- nowhere\n+++ nowhere\n@@ -1,2 +1,2 @@\n a\n-B\n+b\n",
    ],
    [
      "reversed rejects in one file",
      "patch -R -r all.rej",
      "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-q\n+Q\n@@ -5 +5 @@\n-e\n+E\n",
    ],
    ["a name ending at a blank", "patch", "--- sp ace\n+++ sp ace\n@@ -1 +1 @@\n-x\n+y\n"],
    ["a name ending at a tab", "patch", "--- sp ace\t\n+++ sp ace\t\n@@ -1 +1 @@\n-x\n+y\n"],
    ["an octal-quoted name", "patch", '--- "sp\\040ace"\n+++ "sp\\040ace"\n@@ -1 +1 @@\n-x\n+y\n'],
    [
      "two CRLF patches",
      "patch",
      "--- g\r\n+++ g\r\n@@ -1 +1 @@\r\n-a\r\n+A\r\n--- f\r\n+++ f\r\n@@ -1 +1 @@\r\n-x\r\n+X\r\n",
    ],
    ["a tab-indented patch", "patch", "\t--- g\n\t+++ g\n\t@@ -1 +1 @@\n\t-a\n\t+A\n"],
    [
      "several patches to one operand",
      "patch g",
      "--- q\n+++ q\n@@ -1 +1 @@\n-a\n+A\n--- r\n+++ r\n@@ -2 +2 @@\n-b\n+B\n",
    ],
    ["-i - and bundled options", "patch -F 1 -sp0 -i -", "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n"],
    ["abbreviated long options", "patch --forw --dry", "--- g\n+++ g\n@@ -1 +1 @@\n-A\n+a\n"],
    [
      "a git rename without hunks",
      "patch",
      "diff --git a/g b/h2\nsimilarity index 100%\nrename from g\nrename to h2\n",
    ],
    [
      "a git rename reversed after it was made",
      "patch -p1 -R",
      "diff --git a/g b/h2\nsimilarity index 90%\nrename from g\nrename to h2\n--- a/g\n+++ b/h2\n@@ -1 +1 @@\n-a\n+A\n",
    ],
    [
      "a patch to a queued rename",
      "patch -p1",
      "diff --git a/g b/h2\nsimilarity index 90%\nrename from g\nrename to h2\n--- a/g\n+++ b/h2\n@@ -1 +1 @@\n-a\n+A\ndiff --git a/h2 b/h2\n--- a/h2\n+++ b/h2\n@@ -2 +2 @@\n-b\n+B\n",
    ],
    [
      "a plain patch after a git one",
      "patch -p1",
      "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-a\n+A\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-A\n+Z\n",
    ],
    [
      "a git creation of an existing file",
      "patch -p1",
      "diff --git a/g b/g\nnew file mode 100644\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+x\n",
    ],
    ["an empty git creation", "patch -p1", "diff --git a/e b/e\nnew file mode 100755\n"],
    [
      "-E emptying a file",
      "patch -p1 -E",
      "--- a/f\n+++ b/f\n@@ -1,6 +0,0 @@\n-x\n-a\n-b\n-a\n-b\n-x\n",
    ],
    ["a heading kept in the reject", "patch", "--- g\n+++ g\n@@ -1 +1 @@ ctx\n-q\n+Q\n"],
    ["a header without its closing @@", "patch", "--- g\n+++ g\n@@ -1,2 +1,2\n a\n-b\n+B\n"],
    ["a header without +", "patch", "--- g\n+++ g\n@@ -1,2 1,2 @@\n a\n-b\n+B\n"],
    ["a header with a missing count", "patch", "--- g\n+++ g\n@@ -1, +1,2 @@\n a\n-b\n+B\n"],
    [
      "a line number too large",
      "patch",
      "--- g\n+++ g\n@@ -99999999999999999999,2 +1,2 @@\n a\n-b\n+B\n",
    ],
    ["a header with @@ attached", "patch", "--- g\n+++ g\n@@ -1,2 +1,2@@\n a\n-b\n+B\n"],
    ["a blank input line", "patch", "\n"],
    ["a quiet failed Prereq", "patch -s", "Prereq: zzz\n--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n"],
    ["an absolute name", "patch -p0", "--- /dev/null\n+++ /abs/x\n@@ -0,0 +1 @@\n+y\n"],
    [
      "a forced deletion that differs",
      "patch -p0 -f",
      "--- g\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n",
    ],
    [
      "deleting a missing file with -t",
      "patch -p0 -t",
      "--- nope\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
    ],
  ])("%s: %s", async (_, command, diff) => {
    const script = `${command} < d.diff; ls; cat -A f g h g.rej f.rej all.rej h2 e g.orig; echo end`;
    agreeWithBash(await compareWithBash(script, { tree: { ...tree, "d.diff": diff } }));
  });

  // Unified diffs of every context width against drifted targets, under each
  // answer mode, compared with the files and rejects GNU leaves.
  it.each([1, 2, 3])("applies generated diffs with seed %i", async (seed) => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    };
    const lines = (count: number): string[] =>
      Array.from({ length: count }, () => pick(["a", "b", "c", "d", "e", "f"]));
    const mutate = (source: readonly string[], edits: number): string[] => {
      const out = [...source];
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * (out.length + 1));
        const kind = random();
        if (kind < 0.35) out.splice(at, 0, pick(["x", "y", "z"]));
        else if (kind < 0.7) out.splice(at, 1);
        else out.splice(at, 1, pick(["x", "y", "z"]));
      }
      return out;
    };
    const text = (source: readonly string[], newline: boolean): string =>
      source.length === 0 ? "" : `${source.join("\n")}${newline ? "\n" : ""}`;
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-patch-widths-"));
    try {
      for (let round = 0; round < 30; round++) {
        const original = lines(5 + Math.floor(random() * 60));
        const edited = mutate(original, 1 + Math.floor(random() * 8));
        writeFileSync(join(directory, "a"), text(original, random() < 0.9));
        writeFileSync(join(directory, "b"), text(edited, random() < 0.9));
        const width = pick(["-U0", "-U1", "-U2", "-U3", "-U5"]);
        const diff = spawnSync("diff", [width, "--label", "a/f", "--label", "b/f", "a", "b"], {
          cwd: directory,
          env: { LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
        const drifted = random() < 0.2 ? edited : mutate(original, Math.floor(random() * 6));
        const files = { f: text(drifted, random() < 0.9), "change.diff": diff.stdout };
        const flags = pick(["-p1", "-p1 -R", "-p1 -F3", "-p1 -F0", "-p1 --dry-run", "-p1 -s"]);
        agreeWithBash(
          await compareWithBash(
            `patch ${flags} < change.diff; cat -A f; ls; cat -A f.rej f.orig; echo end`,
            { tree: files },
          ),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe("patch refusals", () => {
  const encoder = new TextEncoder();

  function shell(
    files: Readonly<Record<string, string>>,
    maxRetainedBytes?: number,
    fs = createFilesystem(new TestDatabase(), { now: () => 0 }),
  ) {
    fs.writeFiles(
      Object.entries(files).map(([path, text]) => ({
        path: `/repo/${path}`,
        bytes: encoder.encode(text),
      })),
    );
    const limits =
      maxRetainedBytes === undefined ? undefined : { ...DEFAULT_LIMITS, maxRetainedBytes };
    return createShell({ fs, cwd: "/repo", ...(limits === undefined ? {} : { limits }) });
  }

  it.each([
    ["-b", "-b"],
    ["-o out.txt", "-o"],
    ["--output=out.txt", "--output"],
    ["-u", "-u"],
    ["-c", "-c"],
    ["--verbose", "--verbose"],
    ["--posix", "--posix"],
    ["--merge", null],
  ])("refuses %s by name", async (flag, name) => {
    const run = await shell({ f: "x\n" }).run(`patch ${flag} </dev/null`);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      name === null
        ? "patch: unrecognized option '--merge'\npatch: Try 'patch --help' for more information.\n"
        : `patch: option '${name}' is not supported; supported: -pN, -R, --dry-run, -N, -s, -d DIR, -f, -t, -E, --no-backup-if-mismatch, -F N, -r FILE, -i FILE\n`,
    );
  });

  it.each([
    [
      "a context diff",
      "*** f\n--- f\n***************\n*** 1 ****\n! x\n--- 1 ----\n! y\n",
      "patch",
      "context diffs",
    ],
    ["a normal diff", "1c1\n< x\n---\n> y\n", "patch f", "normal diffs"],
    ["an ed script", "1c\ny\n.\n", "patch f", "ed scripts"],
  ])("refuses %s", async (_, diff, command, kind) => {
    const run = await shell({ f: "x\n", "change.diff": diff }).run(
      `${command} < change.diff; cat f`,
    );
    expect(run.stdout).toBe("x\n");
    expect(run.stderr).toBe(`patch: ${kind} are not supported; use a unified diff\n`);
  });

  it("refuses a patch to a symbolic link", async () => {
    const diff =
      "diff --git a/l b/l\nnew file mode 120000\nindex 0000000..1\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n";
    const run = await shell({ "change.diff": diff }).run("patch -p1 < change.diff; ls");
    expect(run.stdout).toBe("change.diff\n");
    expect(run.stderr).toBe("patch: patches to symbolic links are not supported\n");
  });

  it("stages queued git outputs in the filesystem, not in retained memory", async () => {
    const files: Record<string, string> = {};
    let diff = "";
    for (let index = 0; index < 20; index++) {
      const name = `f${index}.txt`;
      files[name] = `head\n${"x".repeat(4096)}\n`;
      diff += `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-head\n+HEAD\n`;
    }
    // Each file fits the budget; twenty held together would not.
    const run = await shell({ ...files, "change.diff": diff }, 24 * 1024).run(
      "patch -p1 < change.diff >/dev/null; ls; head -c 5 f0.txt f19.txt",
    );
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      `change.diff\n${Array.from({ length: 20 }, (_, index) => `f${index}.txt`)
        .sort()
        .join("\n")}\n==> f0.txt <==\nHEAD\n\n==> f19.txt <==\nHEAD\n`,
    );
  });

  it("removes staged outputs when the run fails", async () => {
    const diff =
      "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/g b/g\nindex 1..2 100644\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n";
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const files = { f: "x\n", g: `x\n${"z".repeat(300)}\n`, "change.diff": diff };
    const run = await shell(files, 400, fs).run("patch -p1 < change.diff");
    expect(run.stderr).toMatch(/^kompjutr: patch target .*retained-memory limit\n$/);
    expect(run.exitCode).toBe(2);
    expect(fs.readdir("/repo").map((entry) => entry.name)).toEqual(["change.diff", "f", "g"]);
    expect(new TextDecoder().decode(fs.readFile("/repo/f"))).toBe("x\n");
  });

  it("fails loudly when the diff exceeds the retained budget", async () => {
    const diff = `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+${"y".repeat(200)}\n`;
    const run = await shell({ f: "x\n", "change.diff": diff }, 128).run(
      "cat change.diff | patch -p1; cat f",
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/^kompjutr: patch input .*retained-memory limit\n$/);
  });

  it("keeps many large git outputs out of retained memory", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const files: Record<string, string> = {};
    let diff = "";
    const body = Array.from({ length: 2000 }, (_, line) => `line ${line}\n`).join("");
    for (let index = 0; index < 40; index++) {
      const name = `dir${index % 4}/f${index}.txt`;
      files[name] = body;
      diff += `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1000,3 +1000,3 @@\n line 998\n-line 999\n+LINE 999\n line 1000\n`;
    }
    files["change.diff"] = diff;
    const fileBytes = new TextEncoder().encode(body).length;
    // One file with its line index fits; forty held until the end would not.
    const run = await shell(files, 4 * fileBytes, fs).run("patch -p1 -s < change.diff");
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.peakRetainedBytes).toBeLessThan(4 * fileBytes);
    for (let index = 0; index < 40; index++) {
      const text = new TextDecoder().decode(fs.readFile(`/repo/dir${index % 4}/f${index}.txt`));
      expect(text.split("\n")[999]).toBe("LINE 999");
    }
    for (let dir = 0; dir < 4; dir++) {
      expect(fs.readdir(`/repo/dir${dir}`).filter((entry) => entry.name.startsWith("."))).toEqual(
        [],
      );
    }
  });

  it("stages nothing on a dry run", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const diff =
      "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/g b/g\nindex 1..2 100644\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+?\n";
    const run = await shell({ f: "x\n", g: "x\n", "change.diff": diff }, undefined, fs).run(
      "patch -p1 --dry-run < change.diff",
    );
    expect(run.stdout).toBe("checking file f\nchecking file g\n");
    expect(fs.readdir("/repo").map((entry) => entry.name)).toEqual(["change.diff", "f", "g"]);
  });

  it("finishes patching when stdout's reader stops early", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const diff = `${A_CHANGE}${B_CHANGE}`;
    const run = await shell({ ...TREE, "change.diff": diff }, undefined, fs).run(
      "patch -p1 < change.diff | head -1; cat src/b.txt",
    );
    expect(run.stdout).toBe("patching file src/a.txt\nalpha\nBETA\ngamma\n");
  });
});
